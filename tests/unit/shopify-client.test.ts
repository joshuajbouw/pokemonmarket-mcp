/**
 * Unit tests for Shopify client
 *
 * Tests must be EXACT, not approximations.
 * Uses mocked fetch to return fixture data.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getFixtureProducts,
  getFixtureProductByHandle,
  getOutOfStockProduct,
  getMultiVariantProduct,
} from "../mocks/shopify.js";
import productsFixture from "../fixtures/shopify-products.json";
import variantsFixture from "../fixtures/shopify-variants.json";

// Mock fetch globally for these tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocking
import {
  searchProducts,
  getAllProducts,
  getProductByHandle,
  getVariantById,
  fetchProductImage,
  getFirstVariant,
  getAllVariants,
  formatPrice,
} from "../../src/shopify/client.js";

describe("Shopify Client", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("searchProducts", () => {
    it('searchProducts("rune", 5) → returns matching products from fixture', async () => {
      // Mock the API response - fixture has 4 products matching "rune"
      const runeProducts = productsFixture.products.filter(
        (p) =>
          p.title.toLowerCase().includes("rune") ||
          p.description.toLowerCase().includes("rune")
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            products: {
              edges: runeProducts.slice(0, 5).map((p) => ({ node: p })),
            },
          },
        }),
      });

      const results = await searchProducts("rune", 5);

      // 2 products in fixture match "rune": Elder Futhark Rune Set, Rune Casting Board
      // Note: "runic" does NOT contain "rune" (different letters: i vs e)
      expect(results).toHaveLength(2);
      expect(results[0].title).toBe("Elder Futhark Rune Set");
      expect(results[0].handle).toBe("elder-futhark-rune-set");
      expect(results[0].priceRange.minVariantPrice.amount).toBe("49.99");
    });

    it('searchProducts("nonexistent", 10) → empty array, not null', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            products: {
              edges: [],
            },
          },
        }),
      });

      const results = await searchProducts("nonexistent", 10);

      expect(results).toEqual([]);
      expect(Array.isArray(results)).toBe(true);
      expect(results).not.toBeNull();
    });
  });

  describe("getProductByHandle", () => {
    it('getProductByHandle("valid-handle") → exact product object', async () => {
      const fixtureProduct = getFixtureProductByHandle("elder-futhark-rune-set");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            productByHandle: fixtureProduct,
          },
        }),
      });

      const result = await getProductByHandle("elder-futhark-rune-set");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("gid://shopify/Product/8001234567890");
      expect(result!.title).toBe("Elder Futhark Rune Set");
      expect(result!.handle).toBe("elder-futhark-rune-set");
      expect(result!.description).toBe(
        "Complete set of 24 Elder Futhark runes carved in natural stone."
      );
      expect(result!.priceRange.minVariantPrice.amount).toBe("49.99");
      expect(result!.priceRange.minVariantPrice.currencyCode).toBe("USD");
      expect(result!.availableForSale).toBe(true);
      expect(result!.variants.edges).toHaveLength(1);
    });

    it('getProductByHandle("invalid") → null, not error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            productByHandle: null,
          },
        }),
      });

      const result = await getProductByHandle("invalid-handle");

      expect(result).toBeNull();
    });
  });

  describe("getVariantById", () => {
    it('getVariantById("gid://...") → exact variant with parent product', async () => {
      const variantId = "gid://shopify/ProductVariant/44001234567890";
      const variantData = variantsFixture.variants[variantId as keyof typeof variantsFixture.variants];
      const parentProduct = getFixtureProductByHandle("elder-futhark-rune-set");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            node: {
              ...variantData,
              product: parentProduct,
            },
          },
        }),
      });

      const result = await getVariantById(variantId);

      expect(result).not.toBeNull();
      expect(result!.id).toBe("gid://shopify/ProductVariant/44001234567890");
      expect(result!.title).toBe("Default Title");
      expect(result!.price.amount).toBe("49.99");
      expect(result!.price.currencyCode).toBe("USD");
      expect(result!.availableForSale).toBe(true);
      expect(result!.quantityAvailable).toBe(15);
      expect(result!.product).toBeDefined();
      expect(result!.product.title).toBe("Elder Futhark Rune Set");
    });

    it("getVariantById with invalid ID → null", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            node: null,
          },
        }),
      });

      const result = await getVariantById("gid://shopify/ProductVariant/invalid");

      expect(result).toBeNull();
    });
  });

  describe("API error handling", () => {
    it("API error → exact error message format", async () => {
      // 401 is not in retryableStatuses, so it should fail immediately
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      await expect(searchProducts("test", 10)).rejects.toThrow(
        "Shopify API request failed: 401 Unauthorized"
      );
    });

    it("GraphQL error → exact error message", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { products: { edges: [] } },
          errors: [{ message: "Invalid query" }],
        }),
      });

      await expect(searchProducts("test", 10)).rejects.toThrow(
        "Shopify GraphQL error: Invalid query"
      );
    });
  });

  describe("fetchProductImage", () => {
    it("returns base64 encoded image data", async () => {
      // Create an ArrayBuffer with PNG header bytes
      const arrayBuffer = new ArrayBuffer(8);
      const view = new Uint8Array(arrayBuffer);
      view.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const expectedBase64 = Buffer.from(arrayBuffer).toString("base64");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: () => "image/png",
        },
        arrayBuffer: async () => arrayBuffer,
      });

      const result = await fetchProductImage(
        "https://cdn.shopify.com/test.png",
        400
      );

      expect(result).not.toBeNull();
      expect(result!.mimeType).toBe("image/png");
      expect(typeof result!.data).toBe("string");
      expect(result!.data).toBe(expectedBase64);
    });

    it("returns null on fetch failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const result = await fetchProductImage(
        "https://cdn.shopify.com/nonexistent.png"
      );

      expect(result).toBeNull();
    });
  });

  describe("helper functions", () => {
    it("getFirstVariant returns first variant", () => {
      const product = getFixtureProducts()[0];
      const variant = getFirstVariant(product);

      expect(variant).not.toBeNull();
      expect(variant!.id).toBe("gid://shopify/ProductVariant/44001234567890");
    });

    it("getFirstVariant returns null for product with no variants", () => {
      const product = {
        ...getFixtureProducts()[0],
        variants: { edges: [] },
      };
      const variant = getFirstVariant(product);

      expect(variant).toBeNull();
    });

    it("getAllVariants returns all variants", () => {
      const product = getMultiVariantProduct();
      const variants = getAllVariants(product);

      expect(variants).toHaveLength(2);
      expect(variants[0].title).toBe("Standard");
      expect(variants[1].title).toBe("Deluxe");
    });

    it("formatPrice formats correctly", () => {
      expect(formatPrice("49.99", "USD")).toBe("$49.99");
      expect(formatPrice("149.99", "USD")).toBe("$149.99");
      expect(formatPrice("1000.00", "USD")).toBe("$1,000.00");
    });
  });
});
