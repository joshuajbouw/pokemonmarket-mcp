/**
 * In-memory cart store for Runic Vault MCP Server
 */

import { randomUUID } from "crypto";
import type { Cart, CartLine } from "../types.js";
import { dollarsToCents } from "../types.js";
import type { ShopifyProduct, ShopifyVariant } from "../shopify/types.js";

/**
 * In-memory storage for carts
 */
const carts: Map<string, Cart> = new Map();

/**
 * Create a new cart with a unique UUID
 * @returns The newly created cart
 */
export function createCart(): Cart {
  const id = randomUUID();
  const now = new Date();

  const cart: Cart = {
    id,
    lines: [],
    subtotalCents: 0,
    currency: "AED",
    createdAt: now,
    updatedAt: now,
  };

  carts.set(id, cart);
  return cart;
}

/**
 * Retrieve a cart by ID
 * @param cartId - The cart's unique identifier
 * @returns The cart if found, null otherwise
 */
export function getCart(cartId: string): Cart | null {
  return carts.get(cartId) ?? null;
}

/**
 * Result type for cart operations that can fail
 */
export type CartOperationResult =
  | { success: true; cart: Cart }
  | { success: false; error: "cart_not_found" | "cart_locked" | "currency_mismatch" | "line_not_found"; message: string };

/**
 * Lock a cart for checkout (prevents modifications)
 * @param cartId - The cart's unique identifier
 * @returns true if cart was locked, false if not found
 */
export function lockCartForCheckout(cartId: string): boolean {
  const cart = carts.get(cartId);
  if (!cart) {
    return false;
  }
  cart.lockedForCheckout = true;
  cart.updatedAt = new Date();
  return true;
}

/**
 * Unlock a cart (allows modifications again)
 * @param cartId - The cart's unique identifier
 * @returns true if cart was unlocked, false if not found
 */
export function unlockCart(cartId: string): boolean {
  const cart = carts.get(cartId);
  if (!cart) {
    return false;
  }
  cart.lockedForCheckout = false;
  cart.updatedAt = new Date();
  return true;
}

/**
 * Check if a cart is locked
 * @param cartId - The cart's unique identifier
 * @returns true if locked, false if not locked or not found
 */
export function isCartLocked(cartId: string): boolean {
  const cart = carts.get(cartId);
  return cart?.lockedForCheckout ?? false;
}

/**
 * Add a product variant to a cart
 * @param cartId - The cart's unique identifier
 * @param product - The Shopify product
 * @param variant - The Shopify variant to add
 * @param quantity - The quantity to add (default: 1)
 * @returns CartOperationResult with success/error status
 */
export function addToCart(
  cartId: string,
  product: ShopifyProduct,
  variant: ShopifyVariant,
  quantity: number = 1
): CartOperationResult {
  const cart = carts.get(cartId);
  if (!cart) {
    return { success: false, error: "cart_not_found", message: "Cart not found" };
  }

  // Check if cart is locked for checkout
  if (cart.lockedForCheckout) {
    return { success: false, error: "cart_locked", message: "Cart is locked for checkout and cannot be modified" };
  }

  // Check currency mismatch (if cart has items, new item must match)
  if (cart.lines.length > 0 && cart.currency !== variant.price.currencyCode) {
    return {
      success: false,
      error: "currency_mismatch",
      message: `Currency mismatch: cart uses ${cart.currency}, but variant uses ${variant.price.currencyCode}`,
    };
  }

  // Check if variant already exists in cart
  const existingLine = cart.lines.find(
    (line) => line.variantId === variant.id
  );

  if (existingLine) {
    // Increase quantity of existing line
    existingLine.quantity += quantity;
    existingLine.lineTotalCents = existingLine.unitPriceCents * existingLine.quantity;
  } else {
    // Add new line item
    const unitPriceCents = dollarsToCents(variant.price.amount);
    const newLine: CartLine = {
      id: randomUUID(),
      variantId: variant.id,
      variantTitle: variant.title,
      productTitle: product.title,
      productHandle: product.handle,
      quantity,
      unitPriceCents,
      lineTotalCents: unitPriceCents * quantity,
      currency: variant.price.currencyCode,
    };
    cart.lines.push(newLine);
  }

  recalculateCart(cart);
  cart.updatedAt = new Date();

  return { success: true, cart };
}

/**
 * Remove a line item from a cart
 * @param cartId - The cart's unique identifier
 * @param lineId - The line item's unique identifier
 * @returns CartOperationResult with success/error status
 */
export function removeFromCart(cartId: string, lineId: string): CartOperationResult {
  const cart = carts.get(cartId);
  if (!cart) {
    return { success: false, error: "cart_not_found", message: "Cart not found" };
  }

  // Check if cart is locked for checkout
  if (cart.lockedForCheckout) {
    return { success: false, error: "cart_locked", message: "Cart is locked for checkout and cannot be modified" };
  }

  const lineIndex = cart.lines.findIndex((line) => line.id === lineId);
  if (lineIndex === -1) {
    return { success: false, error: "line_not_found", message: "Line item not found in cart" };
  }

  cart.lines.splice(lineIndex, 1);
  recalculateCart(cart);
  cart.updatedAt = new Date();

  return { success: true, cart };
}

/**
 * Clear all items from a cart
 * @param cartId - The cart's unique identifier
 * @returns The cleared cart, or null if cart not found
 */
export function clearCart(cartId: string): Cart | null {
  const cart = carts.get(cartId);
  if (!cart) {
    return null;
  }

  cart.lines = [];
  cart.subtotalCents = 0;
  cart.updatedAt = new Date();

  return cart;
}

/**
 * Recalculate cart totals based on line items
 * @param cart - The cart to recalculate
 */
export function recalculateCart(cart: Cart): void {
  cart.subtotalCents = cart.lines.reduce((sum, line) => sum + line.lineTotalCents, 0);

  // Set currency from first line item, or keep default
  if (cart.lines.length > 0) {
    cart.currency = cart.lines[0].currency;
  }
}

/**
 * Delete a cart entirely from the store
 * @param cartId - The cart's unique identifier
 * @returns true if cart was deleted, false if not found
 */
export function deleteCart(cartId: string): boolean {
  return carts.delete(cartId);
}

/**
 * Get all carts (useful for debugging/testing)
 * @returns Array of all carts
 */
export function getAllCarts(): Cart[] {
  return Array.from(carts.values());
}

/**
 * Clear all carts from the store (useful for testing)
 */
export function clearAllCarts(): void {
  carts.clear();
}

/**
 * Default TTL for carts: 24 hours in milliseconds
 */
const DEFAULT_CART_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Prune carts older than the specified TTL
 * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 * @returns Number of carts pruned
 */
export function pruneOldCarts(maxAgeMs: number = DEFAULT_CART_TTL_MS): number {
  const now = Date.now();
  let prunedCount = 0;

  for (const [id, cart] of carts) {
    if (now - cart.updatedAt.getTime() > maxAgeMs) {
      carts.delete(id);
      prunedCount++;
    }
  }

  if (prunedCount > 0) {
    console.error(`Pruned ${prunedCount} old cart(s)`);
  }

  return prunedCount;
}

/**
 * Get the number of carts currently in the store
 * @returns Number of carts
 */
export function getCartCount(): number {
  return carts.size;
}
