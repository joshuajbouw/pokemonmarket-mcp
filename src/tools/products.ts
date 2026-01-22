/**
 * Product tools for MCP server
 * - search_products: Search products with images
 * - get_product: Get full product details with image
 * - check_inventory: Check variant stock status
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  searchProducts,
  getProductByHandle,
  getVariantById,
  fetchProductImage,
  formatPrice,
  getAllVariants,
  ShopifyProduct,
  ShopifyVariant,
} from "../shopify/index.js";
import { OUT_OF_STOCK_MESSAGE, sanitizeForDisplay } from "../types.js";

/**
 * Maximum number of images to include in a response to avoid excessive data transfer
 */
const MAX_IMAGES_IN_RESPONSE = 5;

/**
 * Format a product for text display
 */
function formatProductSummary(product: ShopifyProduct): string {
  const price = formatPrice(
    product.priceRange.minVariantPrice.amount,
    product.priceRange.minVariantPrice.currencyCode
  );
  const availability = product.availableForSale ? "In Stock" : "Out of Stock";

  let text = `**${product.title}**\n`;
  text += `Handle: ${product.handle}\n`;
  text += `Price: ${price}\n`;
  text += `Status: ${availability}\n`;

  if (product.vendor) {
    text += `Vendor: ${product.vendor}\n`;
  }

  if (product.productType) {
    text += `Type: ${product.productType}\n`;
  }

  return text;
}

/**
 * Format full product details
 */
function formatProductDetails(product: ShopifyProduct): string {
  const minPrice = formatPrice(
    product.priceRange.minVariantPrice.amount,
    product.priceRange.minVariantPrice.currencyCode
  );
  const maxPrice = formatPrice(
    product.priceRange.maxVariantPrice.amount,
    product.priceRange.maxVariantPrice.currencyCode
  );
  const priceDisplay =
    minPrice === maxPrice ? minPrice : `${minPrice} - ${maxPrice}`;

  let text = `# ${product.title}\n\n`;
  text += `**Handle:** ${product.handle}\n`;
  text += `**Price:** ${priceDisplay}\n`;
  text += `**Available:** ${product.availableForSale ? "Yes" : "No"}\n`;

  if (product.vendor) {
    text += `**Vendor:** ${product.vendor}\n`;
  }

  if (product.productType) {
    text += `**Type:** ${product.productType}\n`;
  }

  if (product.tags.length > 0) {
    text += `**Tags:** ${product.tags.join(", ")}\n`;
  }

  text += `\n## Description\n${product.description || "No description available."}\n`;

  // List variants
  const variants = getAllVariants(product);
  if (variants.length > 0) {
    text += `\n## Variants (${variants.length})\n`;
    for (const variant of variants) {
      const variantPrice = formatPrice(
        variant.price.amount,
        variant.price.currencyCode
      );
      const variantStatus = variant.availableForSale
        ? `In Stock (${variant.quantityAvailable ?? "N/A"})`
        : "Out of Stock";
      text += `- **${variant.title}**: ${variantPrice} - ${variantStatus}\n`;
      text += `  ID: \`${variant.id}\`\n`;
    }
  }

  // List options if product has multiple options
  if (product.options.length > 0) {
    text += `\n## Options\n`;
    for (const option of product.options) {
      text += `- **${option.name}:** ${option.values.join(", ")}\n`;
    }
  }

  return text;
}

/**
 * Format variant inventory details
 */
function formatVariantInventory(
  variant: ShopifyVariant & { product: ShopifyProduct }
): string {
  const price = formatPrice(variant.price.amount, variant.price.currencyCode);

  let text = `## Inventory Status\n\n`;
  text += `**Product:** ${variant.product.title}\n`;
  text += `**Variant:** ${variant.title}\n`;
  text += `**SKU:** ${variant.sku || "N/A"}\n`;
  text += `**Price:** ${price}\n`;
  text += `**Available for Sale:** ${variant.availableForSale ? "Yes" : "No"}\n`;

  if (variant.quantityAvailable !== null) {
    text += `**Quantity Available:** ${variant.quantityAvailable}\n`;
  } else {
    text += `**Quantity Available:** Not tracked\n`;
  }

  return text;
}

/**
 * Register product tools with the MCP server
 */
export function registerProductTools(server: McpServer): void {
  // search_products tool
  server.registerTool(
    "search_products",
    {
      description:
        "Search for products in the Runic Vault store. Returns matching products with images.",
      inputSchema: {
        query: z
          .string()
          .describe("Search query string (e.g., 'rune', 'sword')"),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe("Maximum number of results (default: 10)"),
      },
    },
    async ({ query, limit }) => {
      try {
        const products = await searchProducts(query, limit);

        if (products.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No products found matching "${sanitizeForDisplay(query)}".`,
              },
            ],
          };
        }

        // Build response with text and images
        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [];

        // Add summary header
        const imageNote = products.length > MAX_IMAGES_IN_RESPONSE
          ? ` (showing images for first ${MAX_IMAGES_IN_RESPONSE} products)`
          : "";
        content.push({
          type: "text",
          text: `Found ${products.length} product(s) matching "${query}"${imageNote}:\n\n`,
        });

        // Fetch images in parallel for products that have them (limited to MAX_IMAGES_IN_RESPONSE)
        const productsWithImages = products
          .slice(0, MAX_IMAGES_IN_RESPONSE)
          .filter((p) => p.featuredImage?.url);
        const imagePromises = productsWithImages.map((p) =>
          fetchProductImage(p.featuredImage!.url).catch(() => null)
        );
        const imageResults = await Promise.all(imagePromises);

        // Create a map from product handle to image data for quick lookup
        const imageMap = new Map<string, { data: string; mimeType: string }>();
        productsWithImages.forEach((product, index) => {
          const imageData = imageResults[index];
          if (imageData) {
            imageMap.set(product.handle, imageData);
          }
        });

        // Add each product with its image
        for (let i = 0; i < products.length; i++) {
          const product = products[i];
          // Add product text
          let productText = formatProductSummary(product);

          // Check availability and add out of stock message if needed
          if (!product.availableForSale) {
            productText += `\n${OUT_OF_STOCK_MESSAGE}\n`;
          }

          content.push({ type: "text", text: productText });

          // Add product image if we fetched it
          const imageData = imageMap.get(product.handle);
          if (imageData) {
            content.push({
              type: "image",
              data: imageData.data,
              mimeType: imageData.mimeType,
            });
          }

          // Add separator
          content.push({ type: "text", text: "\n---\n" });
        }

        return { content };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [{ type: "text", text: `Error searching products: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // get_product tool
  server.registerTool(
    "get_product",
    {
      description:
        "Get full details for a specific product by its handle (URL slug). Returns product info with image.",
      inputSchema: {
        handle: z
          .string()
          .describe("Product handle/slug (e.g., 'ancient-rune-sword')"),
      },
    },
    async ({ handle }) => {
      try {
        const product = await getProductByHandle(handle);

        if (!product) {
          return {
            content: [
              {
                type: "text",
                text: `Product not found with handle "${sanitizeForDisplay(handle)}".`,
              },
            ],
          };
        }

        // Build response with text and image
        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [];

        // Add product details text
        let productText = formatProductDetails(product);

        // Check availability and add out of stock message if needed
        if (!product.availableForSale) {
          productText += `\n---\n\n**⚠️ ${OUT_OF_STOCK_MESSAGE}**\n`;
        }

        content.push({ type: "text", text: productText });

        // Fetch and add product image if available
        if (product.featuredImage?.url) {
          const imageData = await fetchProductImage(product.featuredImage.url);
          if (imageData) {
            content.push({
              type: "image",
              data: imageData.data,
              mimeType: imageData.mimeType,
            });
          }
        }

        return { content };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [{ type: "text", text: `Error getting product: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // check_inventory tool
  server.registerTool(
    "check_inventory",
    {
      description:
        "Check the inventory/stock status for a specific product variant.",
      inputSchema: {
        variantId: z
          .string()
          .describe(
            "Full variant ID in GID format (e.g., 'gid://shopify/ProductVariant/123')"
          ),
      },
    },
    async ({ variantId }) => {
      try {
        const variant = await getVariantById(variantId);

        if (!variant) {
          return {
            content: [
              {
                type: "text",
                text: `Variant not found with ID "${sanitizeForDisplay(variantId)}".`,
              },
            ],
          };
        }

        // Build response
        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [];

        // Add inventory details
        let inventoryText = formatVariantInventory(variant);

        // Check availability and add out of stock message if needed
        if (!variant.availableForSale) {
          inventoryText += `\n---\n\n**⚠️ ${OUT_OF_STOCK_MESSAGE}**\n`;
        }

        content.push({ type: "text", text: inventoryText });

        // Add variant image if available
        if (variant.image?.url) {
          const imageData = await fetchProductImage(variant.image.url);
          if (imageData) {
            content.push({
              type: "image",
              data: imageData.data,
              mimeType: imageData.mimeType,
            });
          }
        } else if (variant.product.featuredImage?.url) {
          // Fall back to product's featured image
          const imageData = await fetchProductImage(
            variant.product.featuredImage.url
          );
          if (imageData) {
            content.push({
              type: "image",
              data: imageData.data,
              mimeType: imageData.mimeType,
            });
          }
        }

        return { content };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [
            { type: "text", text: `Error checking inventory: ${message}` },
          ],
          isError: true,
        };
      }
    }
  );
}
