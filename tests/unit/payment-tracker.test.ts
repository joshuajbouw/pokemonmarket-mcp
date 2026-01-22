/**
 * Unit tests for payment tracker
 *
 * Tests must be EXACT, not approximations.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  trackOrder,
  getOrderByCartId,
  getOrderStatus,
  updateOrderStatus,
  markAwaitingPayment,
  markPaid,
  markCancelled,
  markPaymentTimeout,
  clearAllOrders,
} from "../../src/unicity/payment-tracker.js";

describe("Payment Tracker", () => {
  beforeEach(() => {
    clearAllOrders();
  });

  describe("trackOrder", () => {
    it("trackOrder(cartId) → exact order object", () => {
      const cartId = "test-cart-123";
      const totalAmountCents = 14999;
      const currency = "USD";

      const order = trackOrder(cartId, totalAmountCents, currency);

      expect(order).toHaveProperty("id");
      expect(typeof order.id).toBe("string");
      expect(order.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(order.cartId).toBe("test-cart-123");
      expect(order.status).toBe("pending");
      expect(order.totalAmountCents).toBe(14999);
      expect(order.currency).toBe("USD");
      expect(order.createdAt).toBeInstanceOf(Date);
      expect(order.updatedAt).toBeInstanceOf(Date);
      expect(order.paidAt).toBeUndefined();
      expect(order.paymentEventId).toBeUndefined();
      expect(order.unicityId).toBeUndefined();
    });

    it("creates unique order IDs", () => {
      const order1 = trackOrder("cart-1", 1000, "USD");
      const order2 = trackOrder("cart-2", 2000, "USD");
      const order3 = trackOrder("cart-3", 3000, "USD");

      expect(order1.id).not.toBe(order2.id);
      expect(order2.id).not.toBe(order3.id);
      expect(order1.id).not.toBe(order3.id);
    });
  });

  describe("markPaid", () => {
    it('markPaid(cartId) → status is exactly "paid"', () => {
      const cartId = "test-cart-456";
      trackOrder(cartId, 24997, "USD");

      const order = markPaid(cartId);

      expect(order).not.toBeNull();
      expect(order!.status).toBe("paid");
      expect(order!.paidAt).toBeInstanceOf(Date);
      expect(order!.updatedAt).toBeInstanceOf(Date);
      expect(order!.updatedAt.getTime()).toBeGreaterThanOrEqual(
        order!.createdAt.getTime()
      );
    });

    it("markPaid for unknown cartId → null", () => {
      const result = markPaid("unknown-cart-id");
      expect(result).toBeNull();
    });
  });

  describe("getOrderStatus", () => {
    it("getOrderStatus(cartId) → exact status string", () => {
      const cartId = "status-test-cart";
      trackOrder(cartId, 5000, "AED");

      expect(getOrderStatus(cartId)).toBe("pending");

      markAwaitingPayment(cartId, "event-123", "@customer");
      expect(getOrderStatus(cartId)).toBe("awaiting_payment");

      markPaid(cartId);
      expect(getOrderStatus(cartId)).toBe("paid");
    });

    it("unknown cartId → exact null (not undefined)", () => {
      const result = getOrderStatus("nonexistent-cart");
      expect(result).toBeNull();
    });
  });

  describe("markAwaitingPayment", () => {
    it("sets awaiting_payment status and records payment details", () => {
      const cartId = "awaiting-test-cart";
      trackOrder(cartId, 7999, "USD");

      const order = markAwaitingPayment(
        cartId,
        "nostr-event-abc123",
        "@test-customer"
      );

      expect(order).not.toBeNull();
      expect(order!.status).toBe("awaiting_payment");
      expect(order!.paymentEventId).toBe("nostr-event-abc123");
      expect(order!.unicityId).toBe("@test-customer");
    });
  });

  describe("markCancelled", () => {
    it('sets status to exactly "cancelled"', () => {
      const cartId = "cancel-test-cart";
      trackOrder(cartId, 3499, "USD");

      const order = markCancelled(cartId);

      expect(order).not.toBeNull();
      expect(order!.status).toBe("cancelled");
    });
  });

  describe("markPaymentTimeout", () => {
    it('sets status to exactly "payment_timeout"', () => {
      const cartId = "timeout-test-cart";
      trackOrder(cartId, 9999, "USD");
      markAwaitingPayment(cartId, "event-timeout", "@customer");

      const order = markPaymentTimeout(cartId);

      expect(order).not.toBeNull();
      expect(order!.status).toBe("payment_timeout");
    });
  });

  describe("getOrderByCartId", () => {
    it("returns full order object", () => {
      const cartId = "full-order-test";
      const tracked = trackOrder(cartId, 14999, "USD");
      markAwaitingPayment(cartId, "event-full", "@customer");

      const order = getOrderByCartId(cartId);

      expect(order).not.toBeNull();
      expect(order!.id).toBe(tracked.id);
      expect(order!.cartId).toBe(cartId);
      expect(order!.totalAmountCents).toBe(14999);
      expect(order!.currency).toBe("USD");
      expect(order!.status).toBe("awaiting_payment");
      expect(order!.paymentEventId).toBe("event-full");
      expect(order!.unicityId).toBe("@customer");
    });

    it("returns null for unknown cartId", () => {
      const result = getOrderByCartId("does-not-exist");
      expect(result).toBeNull();
    });
  });

  describe("updateOrderStatus", () => {
    it("updates status correctly for all valid statuses", () => {
      const cartId = "update-status-test";
      trackOrder(cartId, 5000, "USD");

      // Test all status transitions
      updateOrderStatus(cartId, "awaiting_payment");
      expect(getOrderStatus(cartId)).toBe("awaiting_payment");

      updateOrderStatus(cartId, "paid");
      expect(getOrderStatus(cartId)).toBe("paid");

      updateOrderStatus(cartId, "cancelled");
      expect(getOrderStatus(cartId)).toBe("cancelled");

      updateOrderStatus(cartId, "payment_timeout");
      expect(getOrderStatus(cartId)).toBe("payment_timeout");

      updateOrderStatus(cartId, "pending");
      expect(getOrderStatus(cartId)).toBe("pending");
    });

    it("returns null for unknown cartId", () => {
      const result = updateOrderStatus("unknown", "paid");
      expect(result).toBeNull();
    });
  });
});
