/**
 * Integration tests for cart tools
 *
 * Tests must be EXACT, not approximations.
 * These tests verify the MCP tool responses match expected formats.
 *
 * Section 6.7: Cart Tools Integration Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { clearAllCarts } from "../../src/store/cart.js";
import {
  getFixtureProducts,
  getOutOfStockProduct,
  getMultiVariantProduct,
} from "../mocks/shopify.js";
import { OUT_OF_STOCK_MESSAGE } from "../../src/types.js";
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
}));

// Import the mocked functions
import { getVariantById } from "../../src/shopify/client.js";
import { registerCartTools } from "../../src/tools/cart.js";

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

describe("Cart Tools Integration", () => {
  let getToolHandler: (name: string) => ToolHandler | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    clearAllCarts();
    const testServer = createTestServer();
    getToolHandler = testServer.getToolHandler;
    registerCartTools(testServer.server);
  });

  afterEach(() => {
    vi.resetAllMocks();
    clearAllCarts();
  });

  describe("create_cart tool", () => {
    it('returns exact format with UUID cart ID', async () => {
      const handler = getToolHandler("create_cart");
      expect(handler).toBeDefined();

      const result = await handler!({});

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should have exactly one text content
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const text = (result.content[0] as TextContent).text;

      // Should contain exact format with UUID
      expect(text).toMatch(/^Cart created successfully\.\n\n\*\*Cart ID:\*\* `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`\n\nUse this cart ID to add items with the add_to_cart tool\.$/);
    });
  });

  describe("add_to_cart tool", () => {
    it("success → exact cart state with formatted output", async () => {
      const products = getFixtureProducts();
      const product = products[0]; // Elder Futhark Rune Set $49.99
      const variant = product.variants.edges[0].node;

      // Mock getVariantById to return the variant with product
      vi.mocked(getVariantById).mockResolvedValueOnce({
        ...variant,
        product: product,
      } as never);

      // First create a cart
      const createHandler = getToolHandler("create_cart");
      const createResult = await createHandler!({});
      const cartIdMatch = (createResult.content[0] as TextContent).text.match(
        /`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`/
      );
      const cartId = cartIdMatch![1];

      // Add to cart
      const handler = getToolHandler("add_to_cart");
      expect(handler).toBeDefined();

      const result = await handler!({
        cartId,
        variantId: "gid://shopify/ProductVariant/44001234567890",
        quantity: 2,
      });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should have exactly one text content
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const text = (result.content[0] as TextContent).text;

      // Check exact format of the success response
      expect(text).toContain("Added to cart:");
      expect(text).toContain("**Elder Futhark Rune Set** (Default Title)");
      expect(text).toContain("Quantity: 2");
      expect(text).toContain("Price: $49.99");

      // Check cart summary section
      expect(text).toContain(`## Cart: ${cartId}`);
      expect(text).toContain("**Items (1):**");
      expect(text).toContain("- **Elder Futhark Rune Set** (Default Title)");
      expect(text).toContain("Quantity: 2 × 49.99 USD = 99.98 USD");
      expect(text).toContain("**Subtotal:** 99.98 USD");
    });

    it("invalid cart ID → exact error message", async () => {
      const products = getFixtureProducts();
      const product = products[0];
      const variant = product.variants.edges[0].node;

      vi.mocked(getVariantById).mockResolvedValueOnce({
        ...variant,
        product: product,
      } as never);

      const handler = getToolHandler("add_to_cart");
      const result = await handler!({
        cartId: "invalid-cart-id",
        variantId: "gid://shopify/ProductVariant/44001234567890",
        quantity: 1,
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        'Cart not found with ID "invalid-cart-id".'
      );
    });

    it("invalid variant ID → exact error message with hint", async () => {
      // Mock getVariantById to return null (not found)
      vi.mocked(getVariantById).mockResolvedValueOnce(null);

      // Create a cart first
      const createHandler = getToolHandler("create_cart");
      const createResult = await createHandler!({});
      const cartIdMatch = (createResult.content[0] as TextContent).text.match(
        /`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`/
      );
      const cartId = cartIdMatch![1];

      const handler = getToolHandler("add_to_cart");
      const result = await handler!({
        cartId,
        variantId: "invalid-variant-id",
        quantity: 1,
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message with hint for non-GID format
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        'Variant not found with ID "invalid-variant-id".\n\nHint: Variant IDs should be in GID format, e.g., "gid://shopify/ProductVariant/123456789". Use get_product to see available variant IDs.'
      );
    });

    it("invalid variant ID (GID format) → exact error message without hint", async () => {
      // Mock getVariantById to return null (not found)
      vi.mocked(getVariantById).mockResolvedValueOnce(null);

      // Create a cart first
      const createHandler = getToolHandler("create_cart");
      const createResult = await createHandler!({});
      const cartIdMatch = (createResult.content[0] as TextContent).text.match(
        /`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`/
      );
      const cartId = cartIdMatch![1];

      const handler = getToolHandler("add_to_cart");
      const result = await handler!({
        cartId,
        variantId: "gid://shopify/ProductVariant/nonexistent",
        quantity: 1,
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message without hint (GID format was used)
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        'Variant not found with ID "gid://shopify/ProductVariant/nonexistent".'
      );
    });

    it("out of stock variant → exact @grittenald message", async () => {
      const outOfStockProduct = getOutOfStockProduct();
      const variant = outOfStockProduct.variants.edges[0].node;

      // Mock getVariantById to return out of stock variant
      vi.mocked(getVariantById).mockResolvedValueOnce({
        ...variant,
        product: outOfStockProduct,
      } as never);

      // Create a cart first
      const createHandler = getToolHandler("create_cart");
      const createResult = await createHandler!({});
      const cartIdMatch = (createResult.content[0] as TextContent).text.match(
        /`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`/
      );
      const cartId = cartIdMatch![1];

      const handler = getToolHandler("add_to_cart");
      const result = await handler!({
        cartId,
        variantId: "gid://shopify/ProductVariant/44001234567894",
        quantity: 1,
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact out of stock message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        `**Runic Altar Cloth** (Default Title) is not available.\n\n${OUT_OF_STOCK_MESSAGE}`
      );
      expect((result.content[0] as TextContent).text).toContain("@grittenald");
    });

    it("exceeds available quantity → exact error message", async () => {
      const products = getFixtureProducts();
      const product = products[0]; // Elder Futhark Rune Set - quantityAvailable: 15
      const variant = product.variants.edges[0].node;

      // Mock getVariantById to return the variant
      vi.mocked(getVariantById).mockResolvedValue({
        ...variant,
        product: product,
      } as never);

      // Create a cart first
      const createHandler = getToolHandler("create_cart");
      const createResult = await createHandler!({});
      const cartIdMatch = (createResult.content[0] as TextContent).text.match(
        /`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`/
      );
      const cartId = cartIdMatch![1];

      const handler = getToolHandler("add_to_cart");

      // Try to add more than available (15)
      const result = await handler!({
        cartId,
        variantId: "gid://shopify/ProductVariant/44001234567890",
        quantity: 20,
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message about exceeding quantity
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        "Cannot add 20 of **Elder Futhark Rune Set** (Default Title). Only 15 more can be added (15 available, 0 already in cart)."
      );
    });
  });

  describe("get_cart tool", () => {
    it("empty cart → exact empty message", async () => {
      // Create a cart first
      const createHandler = getToolHandler("create_cart");
      const createResult = await createHandler!({});
      const cartIdMatch = (createResult.content[0] as TextContent).text.match(
        /`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`/
      );
      const cartId = cartIdMatch![1];

      const handler = getToolHandler("get_cart");
      expect(handler).toBeDefined();

      const result = await handler!({ cartId });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should have exactly one text content with exact message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        `Cart ${cartId} is empty.`
      );
    });

    it("cart with items → exact formatted output", async () => {
      const products = getFixtureProducts();
      const product1 = products[0]; // Elder Futhark Rune Set $49.99
      const product2 = products[2]; // Viking Compass Pendant $149.99
      const variant1 = product1.variants.edges[0].node;
      const variant2 = product2.variants.edges[0].node;

      // Create a cart first
      const createHandler = getToolHandler("create_cart");
      const createResult = await createHandler!({});
      const cartIdMatch = (createResult.content[0] as TextContent).text.match(
        /`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`/
      );
      const cartId = cartIdMatch![1];

      // Add first item
      vi.mocked(getVariantById).mockResolvedValueOnce({
        ...variant1,
        product: product1,
      } as never);
      const addHandler = getToolHandler("add_to_cart");
      await addHandler!({
        cartId,
        variantId: "gid://shopify/ProductVariant/44001234567890",
        quantity: 2,
      });

      // Add second item
      vi.mocked(getVariantById).mockResolvedValueOnce({
        ...variant2,
        product: product2,
      } as never);
      await addHandler!({
        cartId,
        variantId: "gid://shopify/ProductVariant/44001234567893",
        quantity: 1,
      });

      const handler = getToolHandler("get_cart");
      const result = await handler!({ cartId });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should have exactly one text content
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const text = (result.content[0] as TextContent).text;

      // Check exact format
      expect(text).toContain(`## Cart: ${cartId}`);
      expect(text).toContain("**Items (2):**");

      // First item: Elder Futhark Rune Set x2 = $99.98
      expect(text).toContain("- **Elder Futhark Rune Set** (Default Title)");
      expect(text).toContain("Quantity: 2 × 49.99 USD = 99.98 USD");

      // Second item: Viking Compass Pendant x1 = $149.99
      expect(text).toContain("- **Viking Compass Pendant** (Default Title)");
      expect(text).toContain("Quantity: 1 × 149.99 USD = 149.99 USD");

      // Total: $99.98 + $149.99 = $249.97
      expect(text).toContain("**Subtotal:** 249.97 USD");
    });

    it("invalid cart ID → exact error message", async () => {
      const handler = getToolHandler("get_cart");
      const result = await handler!({ cartId: "nonexistent-cart-id" });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        'Cart not found with ID "nonexistent-cart-id".'
      );
    });
  });

  describe("remove_from_cart tool", () => {
    it("removes item → exact updated cart", async () => {
      const products = getFixtureProducts();
      const product1 = products[0]; // Elder Futhark Rune Set $49.99
      const product2 = products[2]; // Viking Compass Pendant $149.99
      const variant1 = product1.variants.edges[0].node;
      const variant2 = product2.variants.edges[0].node;

      // Create a cart first
      const createHandler = getToolHandler("create_cart");
      const createResult = await createHandler!({});
      const cartIdMatch = (createResult.content[0] as TextContent).text.match(
        /`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`/
      );
      const cartId = cartIdMatch![1];

      // Add first item
      vi.mocked(getVariantById).mockResolvedValueOnce({
        ...variant1,
        product: product1,
      } as never);
      const addHandler = getToolHandler("add_to_cart");
      const add1Result = await addHandler!({
        cartId,
        variantId: "gid://shopify/ProductVariant/44001234567890",
        quantity: 1,
      });

      // Extract line ID from the add result
      const lineIdMatch = (add1Result.content[0] as TextContent).text.match(
        /Line ID: `([^`]+)`/
      );
      const lineId = lineIdMatch![1];

      // Add second item
      vi.mocked(getVariantById).mockResolvedValueOnce({
        ...variant2,
        product: product2,
      } as never);
      await addHandler!({
        cartId,
        variantId: "gid://shopify/ProductVariant/44001234567893",
        quantity: 1,
      });

      // Remove first item
      const handler = getToolHandler("remove_from_cart");
      expect(handler).toBeDefined();

      const result = await handler!({ cartId, lineId });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should have exactly one text content
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const text = (result.content[0] as TextContent).text;

      // Check exact format
      expect(text).toContain("Item removed from cart.");
      expect(text).toContain(`## Cart: ${cartId}`);
      expect(text).toContain("**Items (1):**");

      // Only Viking Compass Pendant should remain
      expect(text).toContain("- **Viking Compass Pendant** (Default Title)");
      expect(text).toContain("Quantity: 1 × 149.99 USD = 149.99 USD");
      expect(text).toContain("**Subtotal:** 149.99 USD");

      // Elder Futhark should NOT be in the output
      expect(text).not.toContain("Elder Futhark Rune Set");
    });

    it("removes last item → empty cart message", async () => {
      const products = getFixtureProducts();
      const product = products[0];
      const variant = product.variants.edges[0].node;

      // Create a cart first
      const createHandler = getToolHandler("create_cart");
      const createResult = await createHandler!({});
      const cartIdMatch = (createResult.content[0] as TextContent).text.match(
        /`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`/
      );
      const cartId = cartIdMatch![1];

      // Add one item
      vi.mocked(getVariantById).mockResolvedValueOnce({
        ...variant,
        product: product,
      } as never);
      const addHandler = getToolHandler("add_to_cart");
      const addResult = await addHandler!({
        cartId,
        variantId: "gid://shopify/ProductVariant/44001234567890",
        quantity: 1,
      });

      // Extract line ID
      const lineIdMatch = (addResult.content[0] as TextContent).text.match(
        /Line ID: `([^`]+)`/
      );
      const lineId = lineIdMatch![1];

      // Remove the item
      const handler = getToolHandler("remove_from_cart");
      const result = await handler!({ cartId, lineId });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should show item removed and empty cart
      const text = (result.content[0] as TextContent).text;
      expect(text).toContain("Item removed from cart.");
      expect(text).toContain(`Cart ${cartId} is empty.`);
    });

    it("invalid cart ID → exact error message", async () => {
      const handler = getToolHandler("remove_from_cart");
      const result = await handler!({
        cartId: "invalid-cart-id",
        lineId: "some-line-id",
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        'Cart not found with ID "invalid-cart-id".'
      );
    });

    it("invalid line ID → exact error message", async () => {
      // Create a cart first
      const createHandler = getToolHandler("create_cart");
      const createResult = await createHandler!({});
      const cartIdMatch = (createResult.content[0] as TextContent).text.match(
        /`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`/
      );
      const cartId = cartIdMatch![1];

      const handler = getToolHandler("remove_from_cart");
      const result = await handler!({
        cartId,
        lineId: "invalid-line-id",
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        `Line item not found with ID "invalid-line-id" in cart "${cartId}".`
      );
    });
  });

  describe("multiple variant handling", () => {
    it("adds multiple variants of same product → separate line items", async () => {
      const multiVariantProduct = getMultiVariantProduct(); // Runic Divination Kit
      const standardVariant = multiVariantProduct.variants.edges[0].node; // $79.99
      const deluxeVariant = multiVariantProduct.variants.edges[1].node; // $99.99

      // Create a cart first
      const createHandler = getToolHandler("create_cart");
      const createResult = await createHandler!({});
      const cartIdMatch = (createResult.content[0] as TextContent).text.match(
        /`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`/
      );
      const cartId = cartIdMatch![1];

      // Add standard variant
      vi.mocked(getVariantById).mockResolvedValueOnce({
        ...standardVariant,
        product: multiVariantProduct,
      } as never);
      const addHandler = getToolHandler("add_to_cart");
      await addHandler!({
        cartId,
        variantId: "gid://shopify/ProductVariant/44001234567891",
        quantity: 1,
      });

      // Add deluxe variant
      vi.mocked(getVariantById).mockResolvedValueOnce({
        ...deluxeVariant,
        product: multiVariantProduct,
      } as never);
      await addHandler!({
        cartId,
        variantId: "gid://shopify/ProductVariant/44001234567892",
        quantity: 2,
      });

      const handler = getToolHandler("get_cart");
      const result = await handler!({ cartId });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      const text = (result.content[0] as TextContent).text;

      // Should have two line items
      expect(text).toContain("**Items (2):**");

      // Standard variant: $79.99 x 1
      expect(text).toContain("- **Runic Divination Kit** (Standard)");
      expect(text).toContain("Quantity: 1 × 79.99 USD = 79.99 USD");

      // Deluxe variant: $99.99 x 2 = $199.98
      expect(text).toContain("- **Runic Divination Kit** (Deluxe)");
      expect(text).toContain("Quantity: 2 × 99.99 USD = 199.98 USD");

      // Total: $79.99 + $199.98 = $279.97
      expect(text).toContain("**Subtotal:** 279.97 USD");
    });

    it("adding same variant again increases quantity", async () => {
      const products = getFixtureProducts();
      const product = products[0]; // Elder Futhark Rune Set $49.99
      const variant = product.variants.edges[0].node;

      // Create a cart first
      const createHandler = getToolHandler("create_cart");
      const createResult = await createHandler!({});
      const cartIdMatch = (createResult.content[0] as TextContent).text.match(
        /`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`/
      );
      const cartId = cartIdMatch![1];

      // Add variant first time
      vi.mocked(getVariantById).mockResolvedValue({
        ...variant,
        product: product,
      } as never);
      const addHandler = getToolHandler("add_to_cart");
      await addHandler!({
        cartId,
        variantId: "gid://shopify/ProductVariant/44001234567890",
        quantity: 2,
      });

      // Add same variant again
      await addHandler!({
        cartId,
        variantId: "gid://shopify/ProductVariant/44001234567890",
        quantity: 3,
      });

      const handler = getToolHandler("get_cart");
      const result = await handler!({ cartId });

      const text = (result.content[0] as TextContent).text;

      // Should have one line item with combined quantity
      expect(text).toContain("**Items (1):**");
      expect(text).toContain("Quantity: 5 × 49.99 USD = 249.95 USD");
      expect(text).toContain("**Subtotal:** 249.95 USD");
    });
  });
});
