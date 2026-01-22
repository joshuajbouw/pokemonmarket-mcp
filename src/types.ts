/**
 * Shared types for Runic Vault MCP Server
 */

/**
 * A line item in a cart
 */
export interface CartLine {
  /** Unique identifier for the line item */
  id: string;
  /** Shopify variant ID (full GID format) */
  variantId: string;
  /** Variant title (e.g., "Small / Blue") */
  variantTitle: string;
  /** Product title */
  productTitle: string;
  /** Product handle (URL slug) */
  productHandle: string;
  /** Quantity of this variant */
  quantity: number;
  /** Price per unit in minor units (e.g., 1999 = 19.99 AED) */
  unitPriceCents: number;
  /** Total price for this line in minor units (unitPriceCents * quantity) */
  lineTotalCents: number;
  /** Currency code (e.g., "AED") */
  currency: string;
}

/**
 * A shopping cart
 */
export interface Cart {
  /** Unique cart identifier (UUID) */
  id: string;
  /** Line items in the cart */
  lines: CartLine[];
  /** Subtotal of all line items in minor units (e.g., 5999 = 59.99 AED) */
  subtotalCents: number;
  /** Currency code (e.g., "AED") */
  currency: string;
  /** When the cart was created */
  createdAt: Date;
  /** When the cart was last updated */
  updatedAt: Date;
  /** Whether the cart is locked for checkout (prevents modifications) */
  lockedForCheckout?: boolean;
}

/**
 * Order status
 */
export type OrderStatus = "pending" | "awaiting_payment" | "paid" | "cancelled" | "payment_timeout";

/**
 * An order created from a cart during checkout
 */
export interface Order {
  /** Unique order identifier */
  id: string;
  /** Associated cart ID */
  cartId: string;
  /** Current order status */
  status: OrderStatus;
  /** Total amount in minor units (e.g., 5999 = 59.99 AED) */
  totalAmountCents: number;
  /** Currency/token type */
  currency: string;
  /** Nostr event ID for the payment request */
  paymentEventId?: string;
  /** Customer's Unicity ID (nametag) */
  unicityId?: string;
  /** When the order was created */
  createdAt: Date;
  /** When the order was last updated */
  updatedAt: Date;
  /** When payment was confirmed */
  paidAt?: Date;
}

/**
 * Out of stock message to display to users
 */
export const OUT_OF_STOCK_MESSAGE =
  "This item is currently out of stock. Please reach out to @grittenald in chat for availability updates or to place a backorder.";

/**
 * Convert a price amount string (e.g., "19.99") to minor units (e.g., 1999)
 * @param amount - Price amount as a string
 * @returns Amount in minor units as an integer
 */
export function dollarsToCents(amount: string): number {
  return Math.round(parseFloat(amount) * 100);
}

/**
 * Convert minor units to a formatted price string (e.g., 1999 -> "19.99")
 * @param cents - Amount in minor units
 * @returns Formatted price string
 */
export function centsToDisplayString(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Sanitize user input for safe display in error messages
 * Removes or escapes potentially dangerous characters to prevent injection
 * @param input - User-provided string
 * @returns Sanitized string safe for display
 */
export function sanitizeForDisplay(input: string): string {
  if (typeof input !== "string") {
    return String(input);
  }
  // Limit length to prevent log flooding
  const truncated = input.length > 100 ? input.slice(0, 100) + "..." : input;
  // Remove control characters and escape angle brackets
  return truncated
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Buy list request status
 */
export type BuylistRequestStatus = "pending" | "approved" | "rejected";

/**
 * A buy list request from a customer wanting to sell cards to Runic Vault
 */
export interface BuylistRequest {
  /** Unique identifier (UUID) */
  id: string;
  /** Shopify variant ID (full GID format) */
  variantId: string;
  /** Product handle (URL slug) */
  productHandle: string;
  /** Product title */
  productTitle: string;
  /** Variant title (e.g., "Default Title") */
  variantTitle: string;
  /** Quantity the customer wants to sell */
  quantity: number;
  /** Offer price in minor units (70% of retail, e.g., 1399 = 13.99 AED) */
  offerPriceCents: number;
  /** Retail price in minor units (e.g., 1999 = 19.99 AED) */
  retailPriceCents: number;
  /** Currency code (e.g., "AED") */
  currency: string;
  /** Customer's Unicity ID (nametag) */
  sellerUnicityId: string;
  /** Current request status */
  status: BuylistRequestStatus;
  /** When the request was created */
  createdAt: Date;
  /** When the request was last updated */
  updatedAt: Date;
}

/**
 * Buyback offer percentage (shop pays 70% of retail)
 */
export const BUYBACK_PERCENTAGE = 0.7;

/**
 * Minimum inventory threshold for buyback eligibility
 * Shop only buys cards when inventory is below this threshold
 */
export const BUYBACK_INVENTORY_THRESHOLD = 20;
