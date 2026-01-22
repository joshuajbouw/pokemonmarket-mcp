/**
 * Integration tests for buylist tools
 *
 * Tests must be EXACT, not approximations.
 * These tests verify the MCP tool responses match expected formats.
 *
 * Section: Buylist Tools Integration Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { clearAllBuylistRequests, updateBuylistRequestStatus } from "../../src/store/buylist.js";
import {
  getFixtureProducts,
  getFixtureProductByHandle,
} from "../mocks/shopify.js";
import variantsFixture from "../fixtures/shopify-variants.json";

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
  getFirstVariant: (product: { variants: { edges: Array<{ node: unknown }> } }) => {
    if (product.variants.edges.length === 0) {
      return null;
    }
    return product.variants.edges[0].node;
  },
}));

// Import the mocked functions
import { getProductByHandle, getVariantById } from "../../src/shopify/client.js";
import { registerBuylistTools } from "../../src/tools/buylist.js";

// Type for MCP tool content
type TextContent = { type: "text"; text: string };
type ToolContent = TextContent;
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

describe("Buylist Tools Integration", () => {
  let getToolHandler: (name: string) => ToolHandler | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    clearAllBuylistRequests();
    const testServer = createTestServer();
    getToolHandler = testServer.getToolHandler;
    registerBuylistTools(testServer.server);
  });

  afterEach(() => {
    vi.resetAllMocks();
    clearAllBuylistRequests();
  });

  describe("get_buyback_offer tool", () => {
    it("low inventory (< 20) → returns exact 70% offer", async () => {
      // Elder Futhark Rune Set: $49.99, quantity 15 (< 20)
      // 70% of $49.99 = $34.993 -> floor to cents = 3499 cents = $34.99
      const products = getFixtureProducts();
      const product = products[0]; // Elder Futhark Rune Set
      const variantData = variantsFixture.variants["gid://shopify/ProductVariant/44001234567890"];

      vi.mocked(getVariantById).mockResolvedValueOnce({
        id: variantData.id,
        title: variantData.title,
        sku: variantData.sku,
        price: variantData.price,
        availableForSale: variantData.availableForSale,
        quantityAvailable: variantData.quantityAvailable, // 15
        image: variantData.image,
        product: product,
      } as never);

      const handler = getToolHandler("get_buyback_offer");
      expect(handler).toBeDefined();

      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567890",
      });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should have exactly one text content
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const text = (result.content[0] as TextContent).text;

      // Check exact format and price calculation
      expect(text).toContain("## Buyback Offer");
      expect(text).toContain("**Elder Futhark Rune Set** (Default Title)");
      expect(text).toContain("Runic Vault will purchase this card at **34.99 USD** (70% of retail 49.99 USD)");
      expect(text).toContain("Current inventory: 15 units");
      expect(text).toContain("Variant ID: `gid://shopify/ProductVariant/44001234567890`");
      expect(text).toContain("To sell this card, use the `submit_to_buylist` tool");
    });

    it("low inventory via product handle → returns exact 70% offer", async () => {
      // Viking Compass Pendant: $149.99, quantity 5 (< 20)
      // 70% of $149.99 = $104.993 -> floor to cents = 10499 cents = $104.99
      const product = getFixtureProductByHandle("viking-compass-pendant")!;
      const variant = product.variants.edges[0].node;
      const variantData = variantsFixture.variants["gid://shopify/ProductVariant/44001234567893"];

      vi.mocked(getProductByHandle).mockResolvedValueOnce(product as never);
      vi.mocked(getVariantById).mockResolvedValueOnce({
        id: variantData.id,
        title: variantData.title,
        sku: variantData.sku,
        price: variantData.price,
        availableForSale: variantData.availableForSale,
        quantityAvailable: variantData.quantityAvailable, // 5
        image: variantData.image,
        product: product,
      } as never);

      const handler = getToolHandler("get_buyback_offer");
      const result = await handler!({
        productHandle: "viking-compass-pendant",
      });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      const text = (result.content[0] as TextContent).text;

      // Check exact format and price calculation
      expect(text).toContain("## Buyback Offer");
      expect(text).toContain("**Viking Compass Pendant** (Default Title)");
      expect(text).toContain("Runic Vault will purchase this card at **104.99 USD** (70% of retail 149.99 USD)");
      expect(text).toContain("Current inventory: 5 units");
    });

    it("high inventory (>= 20) → returns exact 'not buying' message", async () => {
      // Mock a variant with high inventory (>= 20)
      const products = getFixtureProducts();
      const product = products[0]; // Elder Futhark Rune Set
      const variantData = variantsFixture.variants["gid://shopify/ProductVariant/44001234567890"];

      vi.mocked(getVariantById).mockResolvedValueOnce({
        id: variantData.id,
        title: variantData.title,
        sku: variantData.sku,
        price: variantData.price,
        availableForSale: variantData.availableForSale,
        quantityAvailable: 25, // Override to high inventory
        image: variantData.image,
        product: product,
      } as never);

      const handler = getToolHandler("get_buyback_offer");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567890",
      });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should have exact not buying message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        "Runic Vault is not currently purchasing **Elder Futhark Rune Set** (Default Title). Current inventory: 25 units."
      );
    });

    it("exactly 20 units → returns 'not buying' message (threshold boundary)", async () => {
      // Edge case: exactly at threshold (20)
      const products = getFixtureProducts();
      const product = products[0];
      const variantData = variantsFixture.variants["gid://shopify/ProductVariant/44001234567890"];

      vi.mocked(getVariantById).mockResolvedValueOnce({
        id: variantData.id,
        title: variantData.title,
        sku: variantData.sku,
        price: variantData.price,
        availableForSale: variantData.availableForSale,
        quantityAvailable: 20, // Exactly at threshold
        image: variantData.image,
        product: product,
      } as never);

      const handler = getToolHandler("get_buyback_offer");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567890",
      });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should return "not buying" at exactly 20
      expect((result.content[0] as TextContent).text).toBe(
        "Runic Vault is not currently purchasing **Elder Futhark Rune Set** (Default Title). Current inventory: 20 units."
      );
    });

    it("19 units → returns buyback offer (just below threshold)", async () => {
      // Edge case: just below threshold (19)
      const products = getFixtureProducts();
      const product = products[0];
      const variantData = variantsFixture.variants["gid://shopify/ProductVariant/44001234567890"];

      vi.mocked(getVariantById).mockResolvedValueOnce({
        id: variantData.id,
        title: variantData.title,
        sku: variantData.sku,
        price: variantData.price,
        availableForSale: variantData.availableForSale,
        quantityAvailable: 19, // Just below threshold
        image: variantData.image,
        product: product,
      } as never);

      const handler = getToolHandler("get_buyback_offer");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567890",
      });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      const text = (result.content[0] as TextContent).text;

      // Should return buyback offer at 19 units
      expect(text).toContain("## Buyback Offer");
      expect(text).toContain("Current inventory: 19 units");
    });

    it("invalid variant ID → exact error message", async () => {
      vi.mocked(getVariantById).mockResolvedValueOnce(null);

      const handler = getToolHandler("get_buyback_offer");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/nonexistent",
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        'Variant not found with ID "gid://shopify/ProductVariant/nonexistent".'
      );
    });

    it("invalid product handle → exact error message", async () => {
      vi.mocked(getProductByHandle).mockResolvedValueOnce(null);

      const handler = getToolHandler("get_buyback_offer");
      const result = await handler!({
        productHandle: "nonexistent-product",
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        'Product not found with handle "nonexistent-product".'
      );
    });

    it("no identifier provided → exact error message", async () => {
      const handler = getToolHandler("get_buyback_offer");
      const result = await handler!({});

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        "Please provide either a productHandle or variantId to check for buyback offers."
      );
    });
  });

  describe("submit_to_buylist tool", () => {
    it("creates pending request with exact values", async () => {
      // Runic Divination Kit Deluxe: $99.99, quantity 3 (< 20)
      // 70% of $99.99 = $69.993 -> floor to cents = 6999 cents = $69.99
      const product = getFixtureProductByHandle("runic-divination-kit")!;
      const variantData = variantsFixture.variants["gid://shopify/ProductVariant/44001234567892"];

      vi.mocked(getVariantById).mockResolvedValueOnce({
        id: variantData.id,
        title: variantData.title,
        sku: variantData.sku,
        price: variantData.price,
        availableForSale: variantData.availableForSale,
        quantityAvailable: variantData.quantityAvailable, // 3
        image: variantData.image,
        product: product,
      } as never);

      const handler = getToolHandler("submit_to_buylist");
      expect(handler).toBeDefined();

      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567892",
        sellerUnicityId: "@test-seller",
        quantity: 1,
      });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should have exactly one text content
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const text = (result.content[0] as TextContent).text;

      // Check exact format
      expect(text).toContain("## Buy List Submission");
      expect(text).toContain("Submitted to Runic Vault's buy list. Request #");
      expect(text).toContain("pending approval.");
      expect(text).toContain("**Product:** Runic Divination Kit (Deluxe)");
      expect(text).toContain("**Quantity:** 1");
      expect(text).toContain("**Total Offer:** 69.99 USD");
      expect(text).toContain("**Seller:** @test-seller");
      expect(text).toContain("**Status:** Pending approval");
      expect(text).toContain("Use the `check_buylist_status` tool");

      // Extract and verify UUID format
      const uuidMatch = text.match(/Request #([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      expect(uuidMatch).not.toBeNull();
    });

    it("creates pending request with quantity > 1 and correct total", async () => {
      // Elder Futhark Rune Set: $49.99, quantity 15 (< 20)
      // 70% of $49.99 = 3499 cents per unit
      // 3 units = 3499 * 3 = 10497 cents = $104.97
      const products = getFixtureProducts();
      const product = products[0];
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

      const handler = getToolHandler("submit_to_buylist");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567890",
        sellerUnicityId: "@bulk-seller",
        quantity: 3,
      });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      const text = (result.content[0] as TextContent).text;

      // Check exact values for quantity 3
      expect(text).toContain("**Product:** Elder Futhark Rune Set (Default Title)");
      expect(text).toContain("**Quantity:** 3");
      expect(text).toContain("**Total Offer:** 104.97 USD");
      expect(text).toContain("**Seller:** @bulk-seller");
    });

    it("high inventory (>= 20) → rejects submission with exact message", async () => {
      const products = getFixtureProducts();
      const product = products[0];
      const variantData = variantsFixture.variants["gid://shopify/ProductVariant/44001234567890"];

      vi.mocked(getVariantById).mockResolvedValueOnce({
        id: variantData.id,
        title: variantData.title,
        sku: variantData.sku,
        price: variantData.price,
        availableForSale: variantData.availableForSale,
        quantityAvailable: 25, // High inventory
        image: variantData.image,
        product: product,
      } as never);

      const handler = getToolHandler("submit_to_buylist");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567890",
        sellerUnicityId: "@test-seller",
        quantity: 1,
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        "Runic Vault is not currently purchasing **Elder Futhark Rune Set** (Default Title). Current inventory (25 units) is at or above our threshold."
      );
    });

    it("invalid variant ID → exact error message", async () => {
      vi.mocked(getVariantById).mockResolvedValueOnce(null);

      const handler = getToolHandler("submit_to_buylist");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/invalid",
        sellerUnicityId: "@test-seller",
        quantity: 1,
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        'Variant not found with ID "gid://shopify/ProductVariant/invalid".'
      );
    });

    it("quantity < 1 → exact error message", async () => {
      const handler = getToolHandler("submit_to_buylist");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567890",
        sellerUnicityId: "@test-seller",
        quantity: 0,
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        "Quantity must be at least 1."
      );
    });
  });

  describe("check_buylist_status tool", () => {
    it("pending status → exact status message", async () => {
      // First create a submission to get a valid request ID
      const products = getFixtureProducts();
      const product = products[0];
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

      const submitHandler = getToolHandler("submit_to_buylist");
      const submitResult = await submitHandler!({
        variantId: "gid://shopify/ProductVariant/44001234567890",
        sellerUnicityId: "@test-seller",
        quantity: 1,
      });

      // Extract request ID from submission response
      const submitText = (submitResult.content[0] as TextContent).text;
      const requestIdMatch = submitText.match(/Request #([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      const requestId = requestIdMatch![1];

      // Now check the status
      const handler = getToolHandler("check_buylist_status");
      expect(handler).toBeDefined();

      const result = await handler!({ requestId });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should have exactly one text content
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const text = (result.content[0] as TextContent).text;

      // Check exact format
      expect(text).toContain("## Buy List Request Status");
      expect(text).toContain(`**Request ID:** ${requestId}`);
      expect(text).toContain("**Status:** Pending approval from Runic Vault");
      expect(text).toContain("**Product:** Elder Futhark Rune Set (Default Title)");
      expect(text).toContain("**Quantity:** 1");
      expect(text).toContain("**Offer:** 34.99 USD");
      expect(text).toContain("**Seller:** @test-seller");
      expect(text).toContain("**Submitted:**");
    });

    it("approved status → exact status message", async () => {
      // Create a submission and then update its status
      const products = getFixtureProducts();
      const product = products[0];
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

      const submitHandler = getToolHandler("submit_to_buylist");
      const submitResult = await submitHandler!({
        variantId: "gid://shopify/ProductVariant/44001234567890",
        sellerUnicityId: "@test-seller",
        quantity: 1,
      });

      // Extract request ID
      const submitText = (submitResult.content[0] as TextContent).text;
      const requestIdMatch = submitText.match(/Request #([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      const requestId = requestIdMatch![1];

      // Update status to approved
      updateBuylistRequestStatus(requestId, "approved");

      // Check the status
      const handler = getToolHandler("check_buylist_status");
      const result = await handler!({ requestId });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      const text = (result.content[0] as TextContent).text;

      // Check exact approved status message
      expect(text).toContain("**Status:** Approved - awaiting shipping details");
    });

    it("rejected status → exact status message", async () => {
      // Create a submission and then update its status
      const products = getFixtureProducts();
      const product = products[0];
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

      const submitHandler = getToolHandler("submit_to_buylist");
      const submitResult = await submitHandler!({
        variantId: "gid://shopify/ProductVariant/44001234567890",
        sellerUnicityId: "@test-seller",
        quantity: 1,
      });

      // Extract request ID
      const submitText = (submitResult.content[0] as TextContent).text;
      const requestIdMatch = submitText.match(/Request #([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      const requestId = requestIdMatch![1];

      // Update status to rejected
      updateBuylistRequestStatus(requestId, "rejected");

      // Check the status
      const handler = getToolHandler("check_buylist_status");
      const result = await handler!({ requestId });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      const text = (result.content[0] as TextContent).text;

      // Check exact rejected status message
      expect(text).toContain("**Status:** Runic Vault declined this purchase");
    });

    it("invalid request ID → exact error message", async () => {
      const handler = getToolHandler("check_buylist_status");
      const result = await handler!({ requestId: "nonexistent-request-id" });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        'Buy list request not found with ID "nonexistent-request-id".'
      );
    });
  });

  describe("exact price calculations", () => {
    it("$49.99 retail → $34.99 offer (floor of 3499.3 cents)", async () => {
      // $49.99 * 0.7 = $34.993 → floor to 3499 cents = $34.99
      const products = getFixtureProducts();
      const product = products[0];
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

      const handler = getToolHandler("get_buyback_offer");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567890",
      });

      const text = (result.content[0] as TextContent).text;
      expect(text).toContain("**34.99 USD** (70% of retail 49.99 USD)");
    });

    it("$99.99 retail → $69.99 offer (floor of 6999.3 cents)", async () => {
      // $99.99 * 0.7 = $69.993 → floor to 6999 cents = $69.99
      const product = getFixtureProductByHandle("runic-divination-kit")!;
      const variantData = variantsFixture.variants["gid://shopify/ProductVariant/44001234567892"];

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

      const handler = getToolHandler("get_buyback_offer");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567892",
      });

      const text = (result.content[0] as TextContent).text;
      expect(text).toContain("**69.99 USD** (70% of retail 99.99 USD)");
    });

    it("$149.99 retail → $104.99 offer (floor of 10499.3 cents)", async () => {
      // $149.99 * 0.7 = $104.993 → floor to 10499 cents = $104.99
      const product = getFixtureProductByHandle("viking-compass-pendant")!;
      const variantData = variantsFixture.variants["gid://shopify/ProductVariant/44001234567893"];

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

      const handler = getToolHandler("get_buyback_offer");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567893",
      });

      const text = (result.content[0] as TextContent).text;
      expect(text).toContain("**104.99 USD** (70% of retail 149.99 USD)");
    });

    it("$79.99 retail → $55.99 offer (floor of 5599.3 cents)", async () => {
      // $79.99 * 0.7 = $55.993 → floor to 5599 cents = $55.99
      const product = getFixtureProductByHandle("runic-divination-kit")!;
      const variantData = variantsFixture.variants["gid://shopify/ProductVariant/44001234567891"];

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

      const handler = getToolHandler("get_buyback_offer");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567891",
      });

      const text = (result.content[0] as TextContent).text;
      expect(text).toContain("**55.99 USD** (70% of retail 79.99 USD)");
    });

    it("quantity 2 of $49.99 retail → $69.98 total offer", async () => {
      // $49.99 * 0.7 = 3499 cents per unit
      // 2 units = 3499 * 2 = 6998 cents = $69.98
      const products = getFixtureProducts();
      const product = products[0];
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

      const handler = getToolHandler("submit_to_buylist");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567890",
        sellerUnicityId: "@test-seller",
        quantity: 2,
      });

      const text = (result.content[0] as TextContent).text;
      expect(text).toContain("**Quantity:** 2");
      expect(text).toContain("**Total Offer:** 69.98 USD");
    });

    it("quantity 5 of $99.99 retail → $349.95 total offer", async () => {
      // $99.99 * 0.7 = 6999 cents per unit
      // 5 units = 6999 * 5 = 34995 cents = $349.95
      const product = getFixtureProductByHandle("runic-divination-kit")!;
      const variantData = variantsFixture.variants["gid://shopify/ProductVariant/44001234567892"];

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

      const handler = getToolHandler("submit_to_buylist");
      const result = await handler!({
        variantId: "gid://shopify/ProductVariant/44001234567892",
        sellerUnicityId: "@bulk-seller",
        quantity: 5,
      });

      const text = (result.content[0] as TextContent).text;
      expect(text).toContain("**Quantity:** 5");
      expect(text).toContain("**Total Offer:** 349.95 USD");
    });
  });
});
