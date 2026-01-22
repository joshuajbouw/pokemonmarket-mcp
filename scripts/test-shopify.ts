/**
 * Quick test script to verify Shopify API connection
 * Run with: npx tsx scripts/test-shopify.ts
 */

import "dotenv/config";
import { searchProducts, getAllProducts, getProductByHandle } from "../src/shopify/index.js";

async function main() {
  console.log("Testing Shopify API connection...\n");

  try {
    // Test 1: Get all products
    console.log("1. Fetching all products (limit 5)...");
    const allProducts = await getAllProducts(5);
    console.log(`   Found ${allProducts.length} products:`);
    for (const product of allProducts) {
      const price = product.priceRange.minVariantPrice;
      console.log(`   - ${product.title} (${product.handle}) - ${price.amount} ${price.currencyCode}`);
    }
    console.log();

    // Test 2: Search products
    console.log("2. Searching for products...");
    const searchResults = await searchProducts("*", 3);
    console.log(`   Search returned ${searchResults.length} products`);
    console.log();

    // Test 3: Get product by handle (if we have any products)
    if (allProducts.length > 0) {
      const handle = allProducts[0].handle;
      console.log(`3. Getting product by handle: "${handle}"...`);
      const product = await getProductByHandle(handle);
      if (product) {
        console.log(`   Title: ${product.title}`);
        console.log(`   Available: ${product.availableForSale}`);
        console.log(`   Variants: ${product.variants.edges.length}`);
        if (product.featuredImage) {
          console.log(`   Image: ${product.featuredImage.url.substring(0, 50)}...`);
        }
      } else {
        console.log("   Product not found");
      }
    }

    console.log("\n✓ Shopify API connection verified successfully!");
  } catch (error) {
    console.error("\n✗ Shopify API connection failed:");
    console.error(error);
    process.exit(1);
  }
}

main();
