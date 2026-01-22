/**
 * Payment tools for MCP server
 * - checkout_with_unicity: Initiate a Unicity payment for a cart
 * - confirm_payment: Wait for and confirm payment
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCart, lockCartForCheckout, unlockCart } from "../store/index.js";
import { getVariantById } from "../shopify/index.js";
import {
  getNostrService,
  trackOrder,
  markAwaitingPayment,
  markPaid,
  markPaymentTimeout,
  getOrderByCartId,
  deleteOrder,
} from "../unicity/index.js";
import { centsToDisplayString, OUT_OF_STOCK_MESSAGE, sanitizeForDisplay } from "../types.js";
import type { Order } from "../types.js";
import type { ConfirmedPayment } from "../unicity/types.js";

/**
 * Set of cart IDs currently being checked out
 * Prevents duplicate checkout requests from being processed simultaneously
 */
const checkoutLocks = new Set<string>();

/**
 * Check if a cart is currently being checked out
 */
export function isCheckoutInProgress(cartId: string): boolean {
  return checkoutLocks.has(cartId);
}

/**
 * Clear all checkout locks (useful for testing)
 */
export function clearCheckoutLocks(): void {
  checkoutLocks.clear();
}

/**
 * Format a payment confirmation response
 */
function formatPaymentConfirmation(
  order: Order,
  confirmedPayment: ConfirmedPayment
): string {
  return `## Payment Confirmed!\n\n**Order ID:** ${order.id}\n**Cart ID:** ${order.cartId}\n**Amount:** ${centsToDisplayString(order.totalAmountCents)} ${order.currency}\n**Transfer Event ID:** \`${confirmedPayment.transferEventId}\`\n\nThank you for your purchase!`;
}

/**
 * Register payment tools with the MCP server
 */
export function registerPaymentTools(server: McpServer): void {
  // checkout_with_unicity tool
  server.registerTool(
    "checkout_with_unicity",
    {
      description:
        "Initiate a Unicity payment for a shopping cart. Sends a payment request to the customer via Nostr. Returns payment details including the event ID needed for confirmation.",
      inputSchema: {
        cartId: z.string().describe("The cart ID to checkout"),
        unicityId: z
          .string()
          .describe(
            "Customer's Unicity ID (nametag, e.g., '@username' or 'username')"
          ),
      },
    },
    async ({ cartId, unicityId }) => {
      // Idempotency check: prevent duplicate checkout requests
      if (checkoutLocks.has(cartId)) {
        return {
          content: [
            {
              type: "text",
              text: `Checkout already in progress for cart "${sanitizeForDisplay(cartId)}". Please wait for it to complete.`,
            },
          ],
          isError: true,
        };
      }

      // Acquire the checkout lock
      checkoutLocks.add(cartId);

      try {
        // Get the cart
        const cart = getCart(cartId);
        if (!cart) {
          return {
            content: [
              {
                type: "text",
                text: `Cart not found with ID "${sanitizeForDisplay(cartId)}".`,
              },
            ],
            isError: true,
          };
        }

        // Check if cart is empty
        if (cart.lines.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Cart "${sanitizeForDisplay(cartId)}" is empty. Add items before checkout.`,
              },
            ],
            isError: true,
          };
        }

        // Re-validate inventory for all items before checkout
        const inventoryErrors: string[] = [];
        for (const line of cart.lines) {
          const variant = await getVariantById(line.variantId);
          if (!variant) {
            inventoryErrors.push(`**${line.productTitle}** (${line.variantTitle}): Product variant no longer exists`);
            continue;
          }
          if (!variant.availableForSale) {
            inventoryErrors.push(`**${line.productTitle}** (${line.variantTitle}): ${OUT_OF_STOCK_MESSAGE}`);
            continue;
          }
          if (variant.quantityAvailable !== null && line.quantity > variant.quantityAvailable) {
            inventoryErrors.push(
              `**${line.productTitle}** (${line.variantTitle}): Only ${variant.quantityAvailable} available, but ${line.quantity} in cart`
            );
          }
        }

        if (inventoryErrors.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `Cannot checkout. The following inventory issues were found:\n\n${inventoryErrors.join("\n\n")}\n\nPlease update your cart and try again.`,
              },
            ],
            isError: true,
          };
        }

        // Check for existing order on this cart
        const existingOrder = getOrderByCartId(cartId);
        if (existingOrder) {
          if (existingOrder.status === "paid") {
            return {
              content: [
                {
                  type: "text",
                  text: `Cart "${sanitizeForDisplay(cartId)}" has already been paid. Order ID: ${existingOrder.id}`,
                },
              ],
              isError: true,
            };
          }
          if (existingOrder.status === "awaiting_payment") {
            return {
              content: [
                {
                  type: "text",
                  text: `Cart "${sanitizeForDisplay(cartId)}" already has a pending payment request.\n\nEvent ID: \`${existingOrder.paymentEventId}\`\n\nUse confirm_payment to check the payment status.`,
                },
              ],
              isError: true,
            };
          }
        }

        // Get the Nostr service
        const nostrService = getNostrService();
        if (!nostrService.isConnected()) {
          return {
            content: [
              {
                type: "text",
                text: "Payment service is not connected. Please try again later.",
              },
            ],
            isError: true,
          };
        }

        // Calculate amount in tokens (1 token = 1 cent for simplicity)
        const amountTokens = BigInt(cart.subtotalCents);

        // Send payment request via Nostr FIRST (before creating order)
        // This prevents orphaned orders if the payment request fails
        let paymentRequest;
        try {
          paymentRequest = await nostrService.sendPaymentRequest(
            cartId,
            unicityId,
            amountTokens,
            `Payment for Runic Vault order - Cart ${cartId}`
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return {
            content: [
              {
                type: "text",
                text: `Failed to send payment request: ${message}`,
              },
            ],
            isError: true,
          };
        }

        // Create an order to track this payment (only after payment request succeeds)
        trackOrder(cartId, cart.subtotalCents, cart.currency);

        // Update order with payment details
        markAwaitingPayment(cartId, paymentRequest.eventId, unicityId);

        // Lock the cart to prevent modifications during checkout
        lockCartForCheckout(cartId);

        // Format response
        const displayAmount = centsToDisplayString(cart.subtotalCents);

        return {
          content: [
            {
              type: "text",
              text: `## Payment Request Sent\n\n**Amount:** ${displayAmount} ${cart.currency} (${amountTokens} tokens)\n**Recipient:** @${paymentRequest.recipientNametag}\n**Coin ID:** ${paymentRequest.coinId}\n**Event ID:** \`${paymentRequest.eventId}\`\n\nPlease send **${amountTokens} tokens** to **@${paymentRequest.recipientNametag}** using your Unicity wallet.\n\nOnce you have sent the payment, use the \`confirm_payment\` tool with cart ID \`${cartId}\` to confirm receipt.`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [
            { type: "text", text: `Error initiating checkout: ${message}` },
          ],
          isError: true,
        };
      } finally {
        // Always release the checkout lock
        checkoutLocks.delete(cartId);
      }
    }
  );

  // confirm_payment tool
  server.registerTool(
    "confirm_payment",
    {
      description:
        "Check or wait for a Unicity payment confirmation. By default, checks status immediately without waiting. Set waitSeconds > 0 to wait for payment (max 120 seconds).",
      inputSchema: {
        cartId: z.string().describe("The cart ID to confirm payment for"),
        waitSeconds: z
          .number()
          .optional()
          .default(0)
          .describe(
            "Seconds to wait for payment (0 = check immediately without waiting, max 120)"
          ),
      },
    },
    async ({ cartId, waitSeconds }) => {
      // Clamp waitSeconds to valid range
      const effectiveWaitSeconds = Math.min(Math.max(waitSeconds ?? 0, 0), 120);
      try {
        // Check if order exists
        const order = getOrderByCartId(cartId);
        if (!order) {
          return {
            content: [
              {
                type: "text",
                text: `No order found for cart "${sanitizeForDisplay(cartId)}". Use checkout_with_unicity first to initiate payment.`,
              },
            ],
            isError: true,
          };
        }

        // Check if already paid
        if (order.status === "paid") {
          return {
            content: [
              {
                type: "text",
                text: `Payment already confirmed for cart "${sanitizeForDisplay(cartId)}".\n\n**Order ID:** ${order.id}\n**Paid at:** ${order.paidAt?.toISOString() ?? "Unknown"}`,
              },
            ],
          };
        }

        // Check if awaiting payment
        if (order.status !== "awaiting_payment") {
          return {
            content: [
              {
                type: "text",
                text: `Order for cart "${sanitizeForDisplay(cartId)}" is not awaiting payment. Current status: ${order.status}`,
              },
            ],
            isError: true,
          };
        }

        // Get the Nostr service
        const nostrService = getNostrService();
        if (!nostrService.isConnected()) {
          return {
            content: [
              {
                type: "text",
                text: "Payment service is not connected. Please try again later.",
              },
            ],
            isError: true,
          };
        }

        // Check if payment was already confirmed (via subscription)
        const confirmedPayment = nostrService.getConfirmedPayment(cartId);
        if (confirmedPayment) {
          // Mark order as paid
          markPaid(cartId);

          return {
            content: [
              {
                type: "text",
                text: formatPaymentConfirmation(order, confirmedPayment),
              },
            ],
          };
        }

        // Non-blocking mode: just return current status
        if (effectiveWaitSeconds === 0) {
          const displayAmount = centsToDisplayString(order.totalAmountCents);
          return {
            content: [
              {
                type: "text",
                text: `## Payment Pending\n\n**Order ID:** ${order.id}\n**Cart ID:** ${cartId}\n**Amount:** ${displayAmount} ${order.currency}\n**Event ID:** \`${order.paymentEventId}\`\n**Status:** Awaiting payment\n\nNo payment has been received yet. Use \`confirm_payment\` with \`waitSeconds > 0\` to wait for payment, or check again later.`,
              },
            ],
          };
        }

        // Blocking mode: wait for payment
        const timeoutMs = effectiveWaitSeconds * 1000;

        // Get pending payment info
        const pendingPayment = nostrService.getPendingPaymentByCartId(cartId);

        // If no pending payment but order is awaiting, we need to re-register
        if (!pendingPayment && order.paymentEventId && order.unicityId) {
          // Re-resolve the customer pubkey
          const customerPubkey = await nostrService.resolveUnicityId(
            order.unicityId
          );
          if (!customerPubkey) {
            return {
              content: [
                {
                  type: "text",
                  text: `Could not resolve Unicity ID @${order.unicityId}. Please try checkout again.`,
                },
              ],
              isError: true,
            };
          }

          // Wait for payment with the stored event ID
          try {
            const confirmed = await nostrService.waitForPayment(
              cartId,
              order.paymentEventId,
              order.unicityId,
              customerPubkey,
              BigInt(order.totalAmountCents),
              timeoutMs
            );

            // Mark order as paid
            markPaid(cartId);

            return {
              content: [
                {
                  type: "text",
                  text: formatPaymentConfirmation(order, confirmed),
                },
              ],
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown error";
            // Mark order as timed out and unlock cart so user can retry
            markPaymentTimeout(cartId);
            unlockCart(cartId);
            return {
              content: [
                {
                  type: "text",
                  text: `## Payment Timeout\n\nNo payment received within ${effectiveWaitSeconds} seconds.\n\n**Event ID:** \`${order.paymentEventId}\`\n**Error:** ${message}\n\nThe cart has been unlocked. Please ensure you have sent the correct amount to the correct recipient and try checkout again.`,
                },
              ],
              isError: true,
            };
          }
        }

        // Wait for the pending payment
        if (pendingPayment) {
          try {
            const confirmed = await nostrService.waitForPayment(
              cartId,
              pendingPayment.eventId,
              pendingPayment.unicityId,
              pendingPayment.customerPubkey,
              pendingPayment.amountTokens,
              timeoutMs
            );

            // Mark order as paid
            markPaid(cartId);

            return {
              content: [
                {
                  type: "text",
                  text: formatPaymentConfirmation(order, confirmed),
                },
              ],
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown error";
            // Mark order as timed out and unlock cart so user can retry
            markPaymentTimeout(cartId);
            unlockCart(cartId);
            return {
              content: [
                {
                  type: "text",
                  text: `## Payment Timeout\n\nNo payment received within ${effectiveWaitSeconds} seconds.\n\n**Event ID:** \`${pendingPayment.eventId}\`\n**Error:** ${message}\n\nThe cart has been unlocked. Please ensure you have sent the correct amount to the correct recipient and try checkout again.`,
                },
              ],
              isError: true,
            };
          }
        }

        // No pending payment and couldn't re-register
        return {
          content: [
            {
              type: "text",
              text: `No pending payment found for cart "${sanitizeForDisplay(cartId)}". Please use checkout_with_unicity to initiate a new payment request.`,
            },
          ],
          isError: true,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [
            { type: "text", text: `Error confirming payment: ${message}` },
          ],
          isError: true,
        };
      }
    }
  );
}
