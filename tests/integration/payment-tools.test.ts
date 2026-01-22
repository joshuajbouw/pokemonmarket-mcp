/**
 * Integration tests for payment tools
 *
 * Tests must be EXACT, not approximations.
 * These tests verify the MCP tool responses match expected formats.
 *
 * Section 6.8: Payment Tools Integration Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createCart,
  addToCart,
  clearAllCarts,
  unlockCart,
} from "../../src/store/cart.js";
import {
  trackOrder,
  markAwaitingPayment,
  markPaid,
  clearAllOrders,
  getOrderByCartId,
} from "../../src/unicity/payment-tracker.js";
import { getFixtureProducts } from "../mocks/shopify.js";
import {
  createMockNostrService,
  resetAllMocks as resetNostrMocks,
  addMockPendingPayment,
  addMockConfirmedPayment,
  getTestPubkeys,
} from "../mocks/nostr.js";
import { clearCheckoutLocks } from "../../src/tools/payment.js";
import type { PendingPayment, ConfirmedPayment } from "../../src/unicity/types.js";

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

// Mock the unicity nostr module
vi.mock("../../src/unicity/nostr.js", () => ({
  getNostrService: vi.fn(),
  initializeNostrService: vi.fn(),
  shutdownNostrService: vi.fn(),
  setNostrService: vi.fn(),
  resetNostrService: vi.fn(),
  NostrService: vi.fn(),
}));

// Import the mocked functions
import { getVariantById } from "../../src/shopify/client.js";
import { getNostrService } from "../../src/unicity/nostr.js";
import { registerPaymentTools } from "../../src/tools/payment.js";

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

describe("Payment Tools Integration", () => {
  let getToolHandler: (name: string) => ToolHandler | undefined;
  let mockNostrService: ReturnType<typeof createMockNostrService>;

  beforeEach(() => {
    clearAllCarts();
    clearAllOrders();
    clearCheckoutLocks();
    resetNostrMocks();

    // Create and configure mock Nostr service
    mockNostrService = createMockNostrService();

    // Ensure isConnected returns true by default
    mockNostrService.isConnected.mockReturnValue(true);

    vi.mocked(getNostrService).mockReturnValue(mockNostrService as never);

    // Setup test server
    const testServer = createTestServer();
    getToolHandler = testServer.getToolHandler;
    registerPaymentTools(testServer.server);
  });

  afterEach(() => {
    clearAllCarts();
    clearAllOrders();
    clearCheckoutLocks();
  });

  describe("checkout_with_unicity tool", () => {
    it("returns exact response format with eventId", async () => {
      // Setup cart with items
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[0]; // Elder Futhark Rune Set $49.99
      const variant = product.variants.edges[0].node;

      addToCart(cart.id, product, variant, 1);

      // Mock getVariantById to return available variant
      vi.mocked(getVariantById).mockResolvedValue({
        ...variant,
        product: product,
      } as never);

      const handler = getToolHandler("checkout_with_unicity");
      expect(handler).toBeDefined();

      const result = await handler!({
        cartId: cart.id,
        unicityId: "@test-customer",
      });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should have exactly one text content
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const text = (result.content[0] as TextContent).text;

      // Verify exact response format
      expect(text).toContain("## Payment Request Sent");
      expect(text).toContain("**Amount:** 49.99 USD (4999 tokens)");
      expect(text).toContain("**Recipient:** @runic-vault");
      expect(text).toContain("**Coin ID:** test-coin-id");
      expect(text).toMatch(/\*\*Event ID:\*\* `mock-event-\d{6}`/);
      expect(text).toContain("Please send **4999 tokens** to **@runic-vault**");
      expect(text).toContain("use the `confirm_payment` tool");
      expect(text).toContain(`cart ID \`${cart.id}\``);

      // Verify order was created with awaiting_payment status
      const order = getOrderByCartId(cart.id);
      expect(order).not.toBeNull();
      expect(order!.status).toBe("awaiting_payment");
      expect(order!.paymentEventId).toMatch(/^mock-event-\d{6}$/);
      expect(order!.unicityId).toBe("@test-customer");
    });

    it("empty cart → exact error message", async () => {
      const cart = createCart();

      const handler = getToolHandler("checkout_with_unicity");
      const result = await handler!({
        cartId: cart.id,
        unicityId: "@test-customer",
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        `Cart "${cart.id}" is empty. Add items before checkout.`
      );
    });

    it("invalid cart ID → exact error message", async () => {
      const handler = getToolHandler("checkout_with_unicity");
      const result = await handler!({
        cartId: "nonexistent-cart-id",
        unicityId: "@test-customer",
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        'Cart not found with ID "nonexistent-cart-id".'
      );
    });

    it("invalid Unicity ID → exact error message", async () => {
      // Setup cart with items
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[0];
      const variant = product.variants.edges[0].node;

      addToCart(cart.id, product, variant, 1);

      // Mock getVariantById to return available variant
      vi.mocked(getVariantById).mockResolvedValue({
        ...variant,
        product: product,
      } as never);

      // Mock resolveUnicityId to fail (returns null)
      mockNostrService.sendPaymentRequest.mockRejectedValueOnce(
        new Error("Could not resolve Unicity ID @nonexistent-user to a public key")
      );

      const handler = getToolHandler("checkout_with_unicity");
      const result = await handler!({
        cartId: cart.id,
        unicityId: "@nonexistent-user",
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        "Failed to send payment request: Could not resolve Unicity ID @nonexistent-user to a public key"
      );
    });

    it("Nostr service not connected → exact error message", async () => {
      // Setup cart with items
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[0];
      const variant = product.variants.edges[0].node;

      addToCart(cart.id, product, variant, 1);

      // Mock getVariantById to return available variant
      vi.mocked(getVariantById).mockResolvedValue({
        ...variant,
        product: product,
      } as never);

      // Mock isConnected to return false
      mockNostrService.isConnected.mockReturnValue(false);

      const handler = getToolHandler("checkout_with_unicity");
      const result = await handler!({
        cartId: cart.id,
        unicityId: "@test-customer",
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        "Payment service is not connected. Please try again later."
      );
    });

    it("already paid cart → exact error message", async () => {
      // Setup cart with items
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[0];
      const variant = product.variants.edges[0].node;

      addToCart(cart.id, product, variant, 1);

      // Mock getVariantById to return available variant
      vi.mocked(getVariantById).mockResolvedValue({
        ...variant,
        product: product,
      } as never);

      // Create order and mark as paid
      trackOrder(cart.id, 4999, "USD");
      markPaid(cart.id);

      const handler = getToolHandler("checkout_with_unicity");
      const result = await handler!({
        cartId: cart.id,
        unicityId: "@test-customer",
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const text = (result.content[0] as TextContent).text;
      expect(text).toContain(`Cart "${cart.id}" has already been paid.`);
      expect(text).toContain("Order ID:");
    });

    it("pending payment exists → exact error message with event ID", async () => {
      // Setup cart with items
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[0];
      const variant = product.variants.edges[0].node;

      addToCart(cart.id, product, variant, 1);

      // Mock getVariantById to return available variant
      vi.mocked(getVariantById).mockResolvedValue({
        ...variant,
        product: product,
      } as never);

      // Create order and mark as awaiting payment
      trackOrder(cart.id, 4999, "USD");
      markAwaitingPayment(cart.id, "existing-event-123", "@test-customer");

      const handler = getToolHandler("checkout_with_unicity");
      const result = await handler!({
        cartId: cart.id,
        unicityId: "@test-customer",
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message with event ID
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const text = (result.content[0] as TextContent).text;
      expect(text).toContain(`Cart "${cart.id}" already has a pending payment request.`);
      expect(text).toContain("Event ID: `existing-event-123`");
      expect(text).toContain("Use confirm_payment to check the payment status.");
    });

    it("checkout with multiple items → exact amount calculation", async () => {
      // Setup cart with multiple items
      const cart = createCart();
      const products = getFixtureProducts();
      const product1 = products[0]; // Elder Futhark Rune Set $49.99
      const product2 = products[2]; // Viking Compass Pendant $149.99
      const variant1 = product1.variants.edges[0].node;
      const variant2 = product2.variants.edges[0].node;

      addToCart(cart.id, product1, variant1, 2); // $99.98
      addToCart(cart.id, product2, variant2, 1); // $149.99
      // Total: $249.97 = 24997 cents

      // Mock getVariantById to return available variants
      vi.mocked(getVariantById)
        .mockResolvedValueOnce({ ...variant1, product: product1 } as never)
        .mockResolvedValueOnce({ ...variant2, product: product2 } as never);

      const handler = getToolHandler("checkout_with_unicity");
      const result = await handler!({
        cartId: cart.id,
        unicityId: "@test-customer",
      });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      const text = (result.content[0] as TextContent).text;

      // Verify exact amount
      expect(text).toContain("**Amount:** 249.97 USD (24997 tokens)");
      expect(text).toContain("Please send **24997 tokens** to **@runic-vault**");
    });
  });

  describe("confirm_payment tool", () => {
    it("success → exact confirmation message", async () => {
      // Setup cart with items
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[2]; // Viking Compass Pendant $149.99
      const variant = product.variants.edges[0].node;

      addToCart(cart.id, product, variant, 1);

      // Create order and mark as awaiting payment
      const order = trackOrder(cart.id, 14999, "USD");
      const eventId = "test-event-123";
      markAwaitingPayment(cart.id, eventId, "@test-customer");

      // Add confirmed payment to mock
      const confirmed: ConfirmedPayment = {
        cartId: cart.id,
        requestEventId: eventId,
        transferEventId: "transfer-test-event-123",
        confirmedAt: new Date(),
      };
      addMockConfirmedPayment(confirmed);

      const handler = getToolHandler("confirm_payment");
      expect(handler).toBeDefined();

      const result = await handler!({
        cartId: cart.id,
        waitSeconds: 0,
      });

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should have exactly one text content
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const text = (result.content[0] as TextContent).text;

      // Verify exact confirmation message format
      expect(text).toContain("## Payment Confirmed!");
      expect(text).toContain(`**Order ID:** ${order.id}`);
      expect(text).toContain(`**Cart ID:** ${cart.id}`);
      expect(text).toContain("**Amount:** 149.99 USD");
      expect(text).toContain("**Transfer Event ID:** `transfer-test-event-123`");
      expect(text).toContain("Thank you for your purchase!");
    });

    it("timeout → exact timeout error with eventId", async () => {
      // Setup cart with items
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[0]; // Elder Futhark Rune Set $49.99
      const variant = product.variants.edges[0].node;

      addToCart(cart.id, product, variant, 1);

      // Create order and mark as awaiting payment
      trackOrder(cart.id, 4999, "USD");
      const eventId = "timeout-event-456";
      markAwaitingPayment(cart.id, eventId, "@test-customer");

      // Add pending payment to mock
      const pending: PendingPayment = {
        cartId: cart.id,
        eventId: eventId,
        unicityId: "test-customer",
        customerPubkey: getTestPubkeys().customer,
        amountTokens: BigInt(4999),
        createdAt: new Date(),
      };
      addMockPendingPayment(pending);

      // Mock waitForPayment to timeout
      mockNostrService.waitForPayment.mockRejectedValueOnce(
        new Error(`Payment timeout after 5 seconds. Payment request eventId: ${eventId}`)
      );

      const handler = getToolHandler("confirm_payment");
      const result = await handler!({
        cartId: cart.id,
        waitSeconds: 5,
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exactly one text content
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const text = (result.content[0] as TextContent).text;

      // Verify exact timeout error format
      expect(text).toContain("## Payment Timeout");
      expect(text).toContain("No payment received within 5 seconds.");
      expect(text).toContain(`**Event ID:** \`${eventId}\``);
      expect(text).toContain(`**Error:** Payment timeout after 5 seconds. Payment request eventId: ${eventId}`);
      expect(text).toContain("The cart has been unlocked.");
    });

    it("no order found → exact error message", async () => {
      const cart = createCart();

      const handler = getToolHandler("confirm_payment");
      const result = await handler!({
        cartId: cart.id,
        waitSeconds: 0,
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        `No order found for cart "${cart.id}". Use checkout_with_unicity first to initiate payment.`
      );
    });

    it("already paid → returns existing confirmation", async () => {
      // Setup cart with items
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[0];
      const variant = product.variants.edges[0].node;

      addToCart(cart.id, product, variant, 1);

      // Create order and mark as paid
      const order = trackOrder(cart.id, 4999, "USD");
      markPaid(cart.id);

      const handler = getToolHandler("confirm_payment");
      const result = await handler!({
        cartId: cart.id,
        waitSeconds: 0,
      });

      // Should NOT be an error
      expect(result.isError).toBeUndefined();

      const text = (result.content[0] as TextContent).text;

      // Should indicate already confirmed
      expect(text).toContain(`Payment already confirmed for cart "${cart.id}".`);
      expect(text).toContain(`**Order ID:** ${order.id}`);
      expect(text).toContain("**Paid at:**");
    });

    it("no pending payment with waitSeconds=0 → returns pending status", async () => {
      // Setup cart with items
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[0];
      const variant = product.variants.edges[0].node;

      addToCart(cart.id, product, variant, 1);

      // Create order and mark as awaiting payment
      const order = trackOrder(cart.id, 4999, "USD");
      const eventId = "pending-event-789";
      markAwaitingPayment(cart.id, eventId, "@test-customer");

      // No confirmed payment in mock - payment still pending

      const handler = getToolHandler("confirm_payment");
      const result = await handler!({
        cartId: cart.id,
        waitSeconds: 0,
      });

      // Should NOT be an error (it's a status check, not a failure)
      expect(result.isError).toBeUndefined();

      const text = (result.content[0] as TextContent).text;

      // Should return pending status
      expect(text).toContain("## Payment Pending");
      expect(text).toContain(`**Order ID:** ${order.id}`);
      expect(text).toContain(`**Cart ID:** ${cart.id}`);
      expect(text).toContain("**Amount:** 49.99 USD");
      expect(text).toContain(`**Event ID:** \`${eventId}\``);
      expect(text).toContain("**Status:** Awaiting payment");
      expect(text).toContain("No payment has been received yet.");
    });

    it("Nostr service not connected → exact error message", async () => {
      // Setup cart with items
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[0];
      const variant = product.variants.edges[0].node;

      addToCart(cart.id, product, variant, 1);

      // Create order and mark as awaiting payment
      trackOrder(cart.id, 4999, "USD");
      markAwaitingPayment(cart.id, "test-event", "@test-customer");

      // Mock isConnected to return false
      mockNostrService.isConnected.mockReturnValue(false);

      const handler = getToolHandler("confirm_payment");
      const result = await handler!({
        cartId: cart.id,
        waitSeconds: 0,
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        "Payment service is not connected. Please try again later."
      );
    });

    it("invalid cart ID → exact error message", async () => {
      const handler = getToolHandler("confirm_payment");
      const result = await handler!({
        cartId: "nonexistent-cart-id",
        waitSeconds: 0,
      });

      // Should be an error
      expect(result.isError).toBe(true);

      // Should have exact error message
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as TextContent).text).toBe(
        'No order found for cart "nonexistent-cart-id". Use checkout_with_unicity first to initiate payment.'
      );
    });
  });

  describe("payment flow state transitions", () => {
    it("tracks complete payment flow correctly", async () => {
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[1]; // Runic Divination Kit
      const variant = product.variants.edges[0].node; // Standard $79.99

      // 1. Add to cart
      addToCart(cart.id, product, variant, 1);
      expect(cart.subtotalCents).toBe(7999);

      // 2. Mock getVariantById for checkout validation
      vi.mocked(getVariantById).mockResolvedValue({
        ...variant,
        product: product,
      } as never);

      // 3. Checkout
      const checkoutHandler = getToolHandler("checkout_with_unicity");
      const checkoutResult = await checkoutHandler!({
        cartId: cart.id,
        unicityId: "@test-customer",
      });

      expect(checkoutResult.isError).toBeUndefined();

      const checkoutText = (checkoutResult.content[0] as TextContent).text;
      expect(checkoutText).toContain("## Payment Request Sent");
      expect(checkoutText).toContain("**Amount:** 79.99 USD (7999 tokens)");

      // Extract event ID from response
      const eventIdMatch = checkoutText.match(/\*\*Event ID:\*\* `(mock-event-\d{6})`/);
      expect(eventIdMatch).not.toBeNull();
      const eventId = eventIdMatch![1];

      // 4. Verify order status is awaiting_payment
      const order = getOrderByCartId(cart.id);
      expect(order).not.toBeNull();
      expect(order!.status).toBe("awaiting_payment");
      expect(order!.paymentEventId).toBe(eventId);

      // 5. Add confirmed payment to mock
      const confirmed: ConfirmedPayment = {
        cartId: cart.id,
        requestEventId: eventId,
        transferEventId: `transfer-${eventId}`,
        confirmedAt: new Date(),
      };
      addMockConfirmedPayment(confirmed);

      // 6. Confirm payment
      const confirmHandler = getToolHandler("confirm_payment");
      const confirmResult = await confirmHandler!({
        cartId: cart.id,
        waitSeconds: 0,
      });

      expect(confirmResult.isError).toBeUndefined();

      const confirmText = (confirmResult.content[0] as TextContent).text;
      expect(confirmText).toContain("## Payment Confirmed!");
      expect(confirmText).toContain(`**Order ID:** ${order!.id}`);
      expect(confirmText).toContain("**Amount:** 79.99 USD");
      expect(confirmText).toContain(`**Transfer Event ID:** \`transfer-${eventId}\``);

      // 7. Verify order status is paid
      const paidOrder = getOrderByCartId(cart.id);
      expect(paidOrder).not.toBeNull();
      expect(paidOrder!.status).toBe("paid");
      expect(paidOrder!.paidAt).toBeInstanceOf(Date);
    });
  });

  describe("idempotency and edge cases", () => {
    it("duplicate checkout request → exact error message", async () => {
      // Setup cart with items
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[0];
      const variant = product.variants.edges[0].node;

      addToCart(cart.id, product, variant, 1);

      // Mock getVariantById to return available variant
      vi.mocked(getVariantById).mockResolvedValue({
        ...variant,
        product: product,
      } as never);

      // Make sendPaymentRequest slow to simulate in-progress checkout
      let resolvePayment: () => void;
      const slowPaymentPromise = new Promise<void>((resolve) => {
        resolvePayment = resolve;
      });

      mockNostrService.sendPaymentRequest.mockImplementationOnce(async () => {
        await slowPaymentPromise;
        return {
          eventId: "mock-event-slow",
          amountTokens: BigInt(4999),
          recipientNametag: "runic-vault",
          coinId: "test-coin-id",
          customerPubkey: getTestPubkeys().customer,
        };
      });

      const handler = getToolHandler("checkout_with_unicity");

      // Start first checkout (will be slow)
      const firstCheckout = handler!({
        cartId: cart.id,
        unicityId: "@test-customer",
      });

      // Immediately try second checkout
      const secondResult = await handler!({
        cartId: cart.id,
        unicityId: "@test-customer",
      });

      // Second should fail with duplicate error
      expect(secondResult.isError).toBe(true);
      expect((secondResult.content[0] as TextContent).text).toBe(
        `Checkout already in progress for cart "${cart.id}". Please wait for it to complete.`
      );

      // Complete the first checkout
      resolvePayment!();
      await firstCheckout;
    });

    it("waitSeconds is clamped to valid range", async () => {
      // Setup cart with items
      const cart = createCart();
      const products = getFixtureProducts();
      const product = products[0];
      const variant = product.variants.edges[0].node;

      addToCart(cart.id, product, variant, 1);

      // Create order and mark as awaiting payment
      trackOrder(cart.id, 4999, "USD");
      const eventId = "clamp-test-event";
      markAwaitingPayment(cart.id, eventId, "@test-customer");

      // Add pending payment
      const pending: PendingPayment = {
        cartId: cart.id,
        eventId: eventId,
        unicityId: "test-customer",
        customerPubkey: getTestPubkeys().customer,
        amountTokens: BigInt(4999),
        createdAt: new Date(),
      };
      addMockPendingPayment(pending);

      // Mock waitForPayment to timeout - verify it's called with clamped value (120000ms max)
      mockNostrService.waitForPayment.mockRejectedValueOnce(
        new Error(`Payment timeout after 120 seconds. Payment request eventId: ${eventId}`)
      );

      const handler = getToolHandler("confirm_payment");

      // Pass waitSeconds > 120, should be clamped
      const result = await handler!({
        cartId: cart.id,
        waitSeconds: 500, // Should be clamped to 120
      });

      // Should be a timeout error
      expect(result.isError).toBe(true);

      const text = (result.content[0] as TextContent).text;
      expect(text).toContain("No payment received within 120 seconds.");
    });
  });
});
