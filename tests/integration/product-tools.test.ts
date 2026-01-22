/**
 * Integration tests for product tools
 *
 * Tests must be EXACT, not approximations.
 * These tests verify the MCP tool responses match expected formats.
 *
 * Section 6.6: Product Tools Integration Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import productsFixture from "../fixtures/shopify-products.json";
import variantsFixture from "../fixtures/shopify-variants.json";
import {
  getFixtureProducts,
  getOutOfStockProduct,
  getFixtureProductByHandle,
} from "../mocks/shopify.js";
import { OUT_OF_STOCK_MESSAGE } from "../../src/types.js";

// Mock the shopify client module
vi.mock("../../src/shopify/client.js", () => ({
  searchProducts: vi.fn(),
  getProductByHandle: vi.fn(),
  getVariantById: vi.fn(),
  fetchProductImage: vi.fn(),
  formatPrice: (amount: string, currencyCode: string): string => {
    const num = parseFloat(amount);
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
    }).format(num);
  },
  getAllVariants: (product: { variants: { edges: Array<{ node: unknown }> } }) => {
    return product.variants.edges.map((edge) => edge.node);
  },
}));

// Import the mocked functions
import {
  searchProducts,
  getProductByHandle,
  getVariantById,
  fetchProductImage,
} from "../../src/shopify/client.js";
import { registerProductTools } from "../../src/tools/products.js";

// Type for MCP tool content
type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type ToolContent = TextContent | ImageContent;
type ToolResult = { content: ToolContent[]; isError?: boolean };

// Type for tool handler
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Helper to capture registered tools from McpServer
 */
function createTestServer(): {
  server: McpServer;
  getToolHandler: (name: string) => ToolHandler | undefined;
} {
  const toolHandlers = new Map<string, ToolHandler>();

  const server = new McpServer({
    name: "test-server",
    version: "1.0.0",
  });

  // Override registerTool to capture handlers
  const originalRegisterTool = server.registerTool.bind(server);
  server.registerTool = (name: string, config: unknown, handler: ToolHandler) => {
    toolHandlers.set(name, handler);
    return originalRegisterTool(name, config, handler);
  };

  return {
    server,
    getToolHandler: (name: string) => toolHandlers.get(name),
  };
}

describe("Product Tools Integration", () => {
  let getToolHandler: (name: string) => ToolHandler | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    const testServer = createTestServer();
    getToolHandler = testServer.getToolHandler;
    registerProductTools(testServer.server);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("search_products tool", () => {
    it("returns exact content format for found products", async () => {
      const runeProducts = productsFixture.products.filter(
        (p) =>
          p.title.toLowerCase().includes("rune") ||
          p.description.toLowerCase().includes("rune")
      );

      vi.mocked(searchProducts).mockResolvedValueOnce(runeProducts as never);
      vi.mocked(fetchProductImage).mockResolvedValue({
        data: "base64ImageData",
        mimeType: "image/jpeg",
      });

      const handler = getToolHandler("search_products");
      expect(handler).toBeDefined();

      const result = await handler!({ query: "rune", limit: 5 });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // First content should be the header text
      // Note: Only 2 products match "rune": Elder Futhark Rune Set, Rune Casting Board
      // "Runic" does not contain "rune" as a substring
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        'Found 2 product(s) matching "rune":\n\n'
      );

      // Should have text content for each product
      const textContents = result.content.filter((c) => c.type === "text") as TextContent[];

      // Check first product format (Elder Futhark Rune Set)
      expect(textContents[1].text).toContain("**Elder Futhark Rune Set**");
      expect(textContents[1].text).toContain("Handle: elder-futhark-rune-set");
      expect(textContents[1].text).toContain("Price: $49.99");
      expect(textContents[1].text).toContain("Status: In Stock");

      // Should have image content for products with images
      const imageContents = result.content.filter((c) => c.type === "image") as ImageContent[];
      expect(imageContents.length).toBeGreaterThan(0);
      expect(imageContents[0].data).toBe("base64ImageData");
      expect(imageContents[0].mimeType).toBe("image/jpeg");
    });

    it('with no results → exact "no products found" message', async () => {
      vi.mocked(searchProducts).mockResolvedValueOnce([]);

      const handler = getToolHandler("search_products");
      expect(handler).toBeDefined();

      const result = await handler!({ query: "xyz-nonexistent-product-123", limit: 10 });

      // Should not be an error (empty results is not an error)
      expect(result.isError).toBeUndefined();

      // Should have exactly one text content with the exact message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        'No products found matching "xyz-nonexistent-product-123".'
      );
    });

    it("out of stock products include @grittenald message", async () => {
      const outOfStockProduct = getOutOfStockProduct();
      vi.mocked(searchProducts).mockResolvedValueOnce([outOfStockProduct] as never);
      vi.mocked(fetchProductImage).mockResolvedValue({
        data: "base64ImageData",
        mimeType: "image/jpeg",
      });

      const handler = getToolHandler("search_products");
      const result = await handler!({ query: "altar", limit: 5 });

      // Find the text content for the product
      const textContents = result.content.filter((c) => c.type === "text") as TextContent[];

      // Should contain the out of stock message
      const productText = textContents.find((t) => t.text.includes("Runic Altar Cloth"));
      expect(productText).toBeDefined();
      expect(productText!.text).toContain(OUT_OF_STOCK_MESSAGE);
      expect(productText!.text).toContain("@grittenald");
    });
  });

  describe("get_product tool", () => {
    it("returns text + image content for valid product", async () => {
      const product = getFixtureProductByHandle("elder-futhark-rune-set");
      vi.mocked(getProductByHandle).mockResolvedValueOnce(product as never);
      vi.mocked(fetchProductImage).mockResolvedValueOnce({
        data: "base64ImageData",
        mimeType: "image/jpeg",
      });

      const handler = getToolHandler("get_product");
      expect(handler).toBeDefined();

      const result = await handler!({ handle: "elder-futhark-rune-set" });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should have text content with product details
      const textContent = result.content.find((c) => c.type === "text") as TextContent;
      expect(textContent).toBeDefined();
      expect(textContent.text).toContain("# Elder Futhark Rune Set");
      expect(textContent.text).toContain("**Handle:** elder-futhark-rune-set");
      expect(textContent.text).toContain("**Price:** $49.99");
      expect(textContent.text).toContain("**Available:** Yes");
      expect(textContent.text).toContain("Complete set of 24 Elder Futhark runes carved in natural stone.");

      // Should have image content
      const imageContent = result.content.find((c) => c.type === "image") as ImageContent;
      expect(imageContent).toBeDefined();
      expect(imageContent.data).toBe("base64ImageData");
      expect(imageContent.mimeType).toBe("image/jpeg");
    });

    it("out of stock product → exact @grittenald message", async () => {
      const outOfStockProduct = getOutOfStockProduct();
      vi.mocked(getProductByHandle).mockResolvedValueOnce(outOfStockProduct as never);
      vi.mocked(fetchProductImage).mockResolvedValueOnce({
        data: "base64ImageData",
        mimeType: "image/jpeg",
      });

      const handler = getToolHandler("get_product");
      const result = await handler!({ handle: "runic-altar-cloth" });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should have text content with out of stock message
      const textContent = result.content.find((c) => c.type === "text") as TextContent;
      expect(textContent).toBeDefined();
      expect(textContent.text).toContain("# Runic Altar Cloth");
      expect(textContent.text).toContain("**Available:** No");
      expect(textContent.text).toContain(OUT_OF_STOCK_MESSAGE);
      expect(textContent.text).toContain("@grittenald");
    });

    it("invalid handle → exact not found message", async () => {
      vi.mocked(getProductByHandle).mockResolvedValueOnce(null);

      const handler = getToolHandler("get_product");
      const result = await handler!({ handle: "nonexistent-product-handle" });

      // Should not be an error (not found is not an error)
      expect(result.isError).toBeUndefined();

      // Should have exactly one text content with the exact message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        'Product not found with handle "nonexistent-product-handle".'
      );
    });
  });

  describe("check_inventory tool", () => {
    it("available → exact quantity number", async () => {
      const products = getFixtureProducts();
      const product = products[0]; // Elder Futhark Rune Set
      const variantData = variantsFixture.variants["gid://shopify/ProductVariant/44001234567890"];

      vi.mocked(getVariantById).mockResolvedValueOnce({
        id: variantData.id,
        title: variantData.title,
        sku: variantData.sku,
        price: variantData.price,
        availableForSale: variantData.availableForSale,
        quantityAvailable: variantData.quantityAvailable,
        image: variantData.image,
        product: product,
      } as never);
      vi.mocked(fetchProductImage).mockResolvedValueOnce({
        data: "base64ImageData",
        mimeType: "image/jpeg",
      });

      const handler = getToolHandler("check_inventory");
      expect(handler).toBeDefined();

      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567890",
      });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should have text content with inventory details
      const textContent = result.content.find((c) => c.type === "text") as TextContent;
      expect(textContent).toBeDefined();
      expect(textContent.text).toContain("## Inventory Status");
      expect(textContent.text).toContain("**Product:** Elder Futhark Rune Set");
      expect(textContent.text).toContain("**Variant:** Default Title");
      expect(textContent.text).toContain("**SKU:** EF-RUNE-001");
      expect(textContent.text).toContain("**Price:** $49.99");
      expect(textContent.text).toContain("**Available for Sale:** Yes");
      expect(textContent.text).toContain("**Quantity Available:** 15");
    });

    it("unavailable → exact out of stock message", async () => {
      const outOfStockProduct = getOutOfStockProduct();
      const variantData = variantsFixture.variants["gid://shopify/ProductVariant/44001234567894"];

      vi.mocked(getVariantById).mockResolvedValueOnce({
        id: variantData.id,
        title: variantData.title,
        sku: variantData.sku,
        price: variantData.price,
        availableForSale: variantData.availableForSale,
        quantityAvailable: variantData.quantityAvailable,
        image: variantData.image,
        product: outOfStockProduct,
      } as never);
      vi.mocked(fetchProductImage).mockResolvedValueOnce({
        data: "base64ImageData",
        mimeType: "image/jpeg",
      });

      const handler = getToolHandler("check_inventory");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567894",
      });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should have text content with out of stock details
      const textContent = result.content.find((c) => c.type === "text") as TextContent;
      expect(textContent).toBeDefined();
      expect(textContent.text).toContain("## Inventory Status");
      expect(textContent.text).toContain("**Product:** Runic Altar Cloth");
      expect(textContent.text).toContain("**Available for Sale:** No");
      expect(textContent.text).toContain("**Quantity Available:** 0");
      expect(textContent.text).toContain(OUT_OF_STOCK_MESSAGE);
      expect(textContent.text).toContain("@grittenald");
    });

    it("invalid variant ID → exact not found message", async () => {
      vi.mocked(getVariantById).mockResolvedValueOnce(null);

      const handler = getToolHandler("check_inventory");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/invalid-id",
      });

      // Should not be an error (not found is not an error)
      expect(result.isError).toBeUndefined();

      // Should have exactly one text content with the exact message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        'Variant not found with ID "gid://shopify/ProductVariant/invalid-id".'
      );
    });
  });
});
