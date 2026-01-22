/**
 * Payment tracker for Runic Vault MCP Server
 *
 * Tracks orders by cartId and manages order lifecycle.
 */

import { randomUUID } from "crypto";
import type { Order, OrderStatus } from "../types.js";

/**
 * In-memory storage for orders
 */
const orders: Map<string, Order> = new Map();

/**
 * Create and track a new order for a cart
 * @param cartId - The cart's unique identifier
 * @param totalAmountCents - Total amount in minor units
 * @param currency - Currency code (e.g., "AED")
 * @returns The newly created order
 */
export function trackOrder(
  cartId: string,
  totalAmountCents: number,
  currency: string
): Order {
  const now = new Date();

  const order: Order = {
    id: randomUUID(),
    cartId,
    status: "pending",
    totalAmountCents,
    currency,
    createdAt: now,
    updatedAt: now,
  };

  orders.set(cartId, order);
  return order;
}

/**
 * Get an order by cart ID
 * @param cartId - The cart's unique identifier
 * @returns The order if found, null otherwise
 */
export function getOrderByCartId(cartId: string): Order | null {
  return orders.get(cartId) ?? null;
}

/**
 * Get the status of an order by cart ID
 * @param cartId - The cart's unique identifier
 * @returns The order status if found, null otherwise
 */
export function getOrderStatus(cartId: string): OrderStatus | null {
  const order = orders.get(cartId);
  return order?.status ?? null;
}

/**
 * Update order status
 * @param cartId - The cart's unique identifier
 * @param status - The new status
 * @returns The updated order, or null if not found
 */
export function updateOrderStatus(
  cartId: string,
  status: OrderStatus
): Order | null {
  const order = orders.get(cartId);
  if (!order) {
    return null;
  }

  order.status = status;
  order.updatedAt = new Date();

  if (status === "paid") {
    order.paidAt = new Date();
  }

  return order;
}

/**
 * Mark an order as awaiting payment and record payment details
 * @param cartId - The cart's unique identifier
 * @param eventId - The Nostr event ID for the payment request
 * @param unicityId - The customer's Unicity ID (nametag)
 * @returns The updated order, or null if not found
 */
export function markAwaitingPayment(
  cartId: string,
  eventId: string,
  unicityId: string
): Order | null {
  const order = orders.get(cartId);
  if (!order) {
    return null;
  }

  order.status = "awaiting_payment";
  order.paymentEventId = eventId;
  order.unicityId = unicityId;
  order.updatedAt = new Date();

  return order;
}

/**
 * Mark an order as paid
 * @param cartId - The cart's unique identifier
 * @returns The updated order, or null if not found
 */
export function markPaid(cartId: string): Order | null {
  return updateOrderStatus(cartId, "paid");
}

/**
 * Mark an order as cancelled
 * @param cartId - The cart's unique identifier
 * @returns The updated order, or null if not found
 */
export function markCancelled(cartId: string): Order | null {
  return updateOrderStatus(cartId, "cancelled");
}

/**
 * Mark an order as payment timeout
 * @param cartId - The cart's unique identifier
 * @returns The updated order, or null if not found
 */
export function markPaymentTimeout(cartId: string): Order | null {
  return updateOrderStatus(cartId, "payment_timeout");
}

/**
 * Delete an order from the tracker
 * @param cartId - The cart's unique identifier
 * @returns true if order was deleted, false if not found
 */
export function deleteOrder(cartId: string): boolean {
  return orders.delete(cartId);
}

/**
 * Get all orders (useful for debugging/testing)
 * @returns Array of all orders
 */
export function getAllOrders(): Order[] {
  return Array.from(orders.values());
}

/**
 * Clear all orders from the store (useful for testing)
 */
export function clearAllOrders(): void {
  orders.clear();
}

/**
 * Default TTL for orders: 24 hours in milliseconds
 */
const DEFAULT_ORDER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Prune orders older than the specified TTL
 * Only prunes orders with terminal statuses (paid, cancelled, payment_timeout)
 * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 * @returns Number of orders pruned
 */
export function pruneOldOrders(maxAgeMs: number = DEFAULT_ORDER_TTL_MS): number {
  const now = Date.now();
  const terminalStatuses: OrderStatus[] = ["paid", "cancelled", "payment_timeout"];
  let prunedCount = 0;

  for (const [cartId, order] of orders) {
    // Only prune orders in terminal states
    if (!terminalStatuses.includes(order.status)) {
      continue;
    }

    if (now - order.updatedAt.getTime() > maxAgeMs) {
      orders.delete(cartId);
      prunedCount++;
    }
  }

  if (prunedCount > 0) {
    console.error(`Pruned ${prunedCount} old order(s)`);
  }

  return prunedCount;
}

/**
 * Get the number of orders currently in the store
 * @returns Number of orders
 */
export function getOrderCount(): number {
  return orders.size;
}
