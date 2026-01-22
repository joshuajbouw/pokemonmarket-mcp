/**
 * Mock Shopify client for testing
 *
 * Provides mock implementations of all Shopify client functions
 * with deterministic, exact responses based on fixtures.
 */

import { vi } from "vitest";
import type { ShopifyProduct, ShopifyVariant } from "../../src/shopify/types.js";
import productsFixture from "../fixtures/shopify-products.json";
import variantsFixture from "../fixtures/shopify-variants.json";

/**
 * Type for the products fixture
 */
interface ProductsFixture {
  products: ShopifyProduct[];
}

/**
 * Type for the variants fixture
 */
interface VariantsFixture {
  variants: Record<string, ShopifyVariant & { product: { id: string; title: string; handle: string } }>;
}

const products = (productsFixture as ProductsFixture).products;
const variants = (variantsFixture as VariantsFixture).variants;

/**
 * Mock searchProducts function
 * Returns products that match the query in title or description
 */
export const mockSearchProducts = vi.fn(
  async (query: string, limit: number = 10): Promise<ShopifyProduct[]> => {
    const lowerQuery = query.toLowerCase();
    const results = products.filter(
      (p) =>
        p.title.toLowerCase().includes(lowerQuery) ||
        p.description.toLowerCase().includes(lowerQuery)
    );
    return results.slice(0, limit);
  }
);

/**
 * Mock getAllProducts function
 * Returns all products up to the limit
 */
export const mockGetAllProducts = vi.fn(
  async (limit: number = 10): Promise<ShopifyProduct[]> => {
    return products.slice(0, limit);
  }
);

/**
 * Mock getProductByHandle function
 * Returns the product with matching handle, or null
 */
export const mockGetProductByHandle = vi.fn(
  async (handle: string): Promise<ShopifyProduct | null> => {
    return products.find((p) => p.handle === handle) ?? null;
  }
);

/**
 * Mock getVariantById function
 * Returns the variant with parent product, or null
 */
export const mockGetVariantById = vi.fn(
  async (
    variantId: string
  ): Promise<(ShopifyVariant & { product: ShopifyProduct }) | null> => {
    const variantData = variants[variantId as keyof typeof variants];
    if (!variantData) {
      return null;
    }

    // Find the full product
    const product = products.find((p) => p.id === variantData.product.id);
    if (!product) {
      return null;
    }

    return {
      id: variantData.id,
      title: variantData.title,
      price: variantData.price,
      availableForSale: variantData.availableForSale,
      quantityAvailable: variantData.quantityAvailable,
      product,
    };
  }
);

/**
 * Mock fetchProductImage function
 * Returns a fake base64 image
 */
export const mockFetchProductImage = vi.fn(
  async (
    _imageUrl: string,
    _width: number = 400
  ): Promise<{ data: string; mimeType: string } | null> => {
    // Return a minimal 1x1 transparent PNG as base64
    return {
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      mimeType: "image/png",
    };
  }
);

/**
 * Mock fetchProductImage to return null (simulates failure)
 */
export const mockFetchProductImageFailed = vi.fn(
  async (): Promise<null> => null
);

/**
 * Reset all mocks to their default implementations
 */
export function resetAllMocks(): void {
  mockSearchProducts.mockClear();
  mockGetAllProducts.mockClear();
  mockGetProductByHandle.mockClear();
  mockGetVariantById.mockClear();
  mockFetchProductImage.mockClear();
  mockFetchProductImageFailed.mockClear();
}

/**
 * Create a mock Shopify client with all functions
 */
export function createMockShopifyClient() {
  return {
    searchProducts: mockSearchProducts,
    getAllProducts: mockGetAllProducts,
    getProductByHandle: mockGetProductByHandle,
    getVariantById: mockGetVariantById,
    fetchProductImage: mockFetchProductImage,
    getFirstVariant: (product: ShopifyProduct): ShopifyVariant | null => {
      if (product.variants.edges.length === 0) {
        return null;
      }
      return product.variants.edges[0].node;
    },
    getAllVariants: (product: ShopifyProduct): ShopifyVariant[] => {
      return product.variants.edges.map((edge) => edge.node);
    },
    formatPrice: (amount: string, currencyCode: string): string => {
      const num = parseFloat(amount);
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currencyCode,
      }).format(num);
    },
  };
}

/**
 * Get all fixture products for testing
 */
export function getFixtureProducts(): ShopifyProduct[] {
  return products;
}

/**
 * Get a specific fixture product by handle
 */
export function getFixtureProductByHandle(handle: string): ShopifyProduct | undefined {
  return products.find((p) => p.handle === handle);
}

/**
 * Get the out-of-stock fixture product
 */
export function getOutOfStockProduct(): ShopifyProduct {
  const product = products.find((p) => !p.availableForSale);
  if (!product) {
    throw new Error("No out-of-stock product in fixtures");
  }
  return product;
}

/**
 * Get a product with multiple variants
 */
export function getMultiVariantProduct(): ShopifyProduct {
  const product = products.find((p) => p.variants.edges.length > 1);
  if (!product) {
    throw new Error("No multi-variant product in fixtures");
  }
  return product;
}
