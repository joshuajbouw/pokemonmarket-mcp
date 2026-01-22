/**
 * Cart tools for MCP server
 * - create_cart: Create a new shopping cart
 * - add_to_cart: Add a variant to a cart
 * - get_cart: View cart contents
 * - remove_from_cart: Remove an item from a cart
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createCart,
  getCart,
  addToCart,
  removeFromCart,
} from "../store/index.js";
import {
  getVariantById,
  formatPrice,
} from "../shopify/index.js";
import { OUT_OF_STOCK_MESSAGE, centsToDisplayString, sanitizeForDisplay } from "../types.js";
import type { Cart } from "../types.js";

/**
 * Format a cart for text display
 */
function formatCartSummary(cart: Cart): string {
  if (cart.lines.length === 0) {
    return `Cart ${cart.id} is empty.`;
  }

  let text = `## Cart: ${cart.id}\n\n`;
  text += `**Items (${cart.lines.length}):**\n\n`;

  for (const line of cart.lines) {
    const lineTotal = centsToDisplayString(line.lineTotalCents);
    const unitPrice = centsToDisplayString(line.unitPriceCents);
    text += `- **${line.productTitle}** (${line.variantTitle})\n`;
    text += `  Quantity: ${line.quantity} × ${unitPrice} ${line.currency} = ${lineTotal} ${line.currency}\n`;
    text += `  Line ID: \`${line.id}\`\n`;
    text += `  Variant ID: \`${line.variantId}\`\n\n`;
  }

  const subtotal = centsToDisplayString(cart.subtotalCents);
  text += `---\n\n**Subtotal:** ${subtotal} ${cart.currency}\n`;

  return text;
}

/**
 * Register cart tools with the MCP server
 */
export function registerCartTools(server: McpServer): void {
  // create_cart tool
  server.registerTool(
    "create_cart",
    {
      description:
        "Create a new shopping cart. Returns a cart ID to use for adding items.",
    },
    async () => {
      try {
        const cart = createCart();

        return {
          content: [
            {
              type: "text",
              text: `Cart created successfully.\n\n**Cart ID:** \`${cart.id}\`\n\nUse this cart ID to add items with the add_to_cart tool.`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [{ type: "text", text: `Error creating cart: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // add_to_cart tool
  server.registerTool(
    "add_to_cart",
    {
      description:
        "Add a product variant to a shopping cart. Validates that the variant exists and is in stock.",
      inputSchema: {
        cartId: z.string().describe("The cart ID returned from create_cart"),
        variantId: z
          .string()
          .describe(
            "Full variant ID in GID format (e.g., 'gid://shopify/ProductVariant/123')"
          ),
        quantity: z
          .number()
          .optional()
          .default(1)
          .describe("Quantity to add (default: 1)"),
      },
    },
    async ({ cartId, variantId, quantity }) => {
      try {
        // First, check if cart exists
        const existingCart = getCart(cartId);
        if (!existingCart) {
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

        // Validate variant exists and fetch product info
        const variant = await getVariantById(variantId);
        if (!variant) {
          // Check if the variantId looks like a GID format
          const isGidFormat = variantId.startsWith("gid://shopify/ProductVariant/");
          const safeVariantId = sanitizeForDisplay(variantId);
          let errorMessage = `Variant not found with ID "${safeVariantId}".`;
          if (!isGidFormat) {
            errorMessage += `\n\nHint: Variant IDs should be in GID format, e.g., "gid://shopify/ProductVariant/123456789". Use get_product to see available variant IDs.`;
          }
          return {
            content: [
              {
                type: "text",
                text: errorMessage,
              },
            ],
            isError: true,
          };
        }

        // Check if variant is available for sale
        if (!variant.availableForSale) {
          return {
            content: [
              {
                type: "text",
                text: `**${variant.product.title}** (${variant.title}) is not available.\n\n${OUT_OF_STOCK_MESSAGE}`,
              },
            ],
            isError: true,
          };
        }

        // Check if requested quantity exceeds available inventory
        if (variant.quantityAvailable !== null) {
          // Get existing quantity in cart for this variant
          const existingLine = existingCart.lines.find(
            (line) => line.variantId === variantId
          );
          const existingQuantity = existingLine?.quantity ?? 0;
          const totalRequestedQuantity = existingQuantity + quantity;

          if (totalRequestedQuantity > variant.quantityAvailable) {
            const availableToAdd = variant.quantityAvailable - existingQuantity;
            let errorMessage = `Cannot add ${quantity} of **${variant.product.title}** (${variant.title}). `;
            if (availableToAdd <= 0) {
              errorMessage += `You already have the maximum available quantity (${variant.quantityAvailable}) in your cart.`;
            } else {
              errorMessage += `Only ${availableToAdd} more can be added (${variant.quantityAvailable} available, ${existingQuantity} already in cart).`;
            }
            return {
              content: [
                {
                  type: "text",
                  text: errorMessage,
                },
              ],
              isError: true,
            };
          }
        }

        // Add to cart
        const result = addToCart(cartId, variant.product, variant, quantity);
        if (!result.success) {
          let errorMessage = "Failed to add item to cart.";
          if (result.error === "cart_locked") {
            errorMessage = `Cart "${sanitizeForDisplay(cartId)}" is locked for checkout and cannot be modified. Complete or cancel the checkout first.`;
          } else if (result.error === "currency_mismatch") {
            errorMessage = result.message;
          }
          return {
            content: [
              {
                type: "text",
                text: errorMessage,
              },
            ],
            isError: true,
          };
        }
        const updatedCart = result.cart;

        const price = formatPrice(
          variant.price.amount,
          variant.price.currencyCode
        );

        return {
          content: [
            {
              type: "text",
              text: `Added to cart:\n\n**${variant.product.title}** (${variant.title})\nQuantity: ${quantity}\nPrice: ${price}\n\n${formatCartSummary(updatedCart)}`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [{ type: "text", text: `Error adding to cart: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // get_cart tool
  server.registerTool(
    "get_cart",
    {
      description: "View the contents of a shopping cart.",
      inputSchema: {
        cartId: z.string().describe("The cart ID to view"),
      },
    },
    async ({ cartId }) => {
      try {
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

        return {
          content: [
            {
              type: "text",
              text: formatCartSummary(cart),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [{ type: "text", text: `Error getting cart: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // remove_from_cart tool
  server.registerTool(
    "remove_from_cart",
    {
      description: "Remove an item from a shopping cart by its line ID.",
      inputSchema: {
        cartId: z.string().describe("The cart ID"),
        lineId: z.string().describe("The line item ID to remove"),
      },
    },
    async ({ cartId, lineId }) => {
      try {
        const existingCart = getCart(cartId);
        if (!existingCart) {
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

        // Check if cart is locked
        if (existingCart.lockedForCheckout) {
          return {
            content: [
              {
                type: "text",
                text: `Cart "${sanitizeForDisplay(cartId)}" is locked for checkout and cannot be modified. Complete or cancel the checkout first.`,
              },
            ],
            isError: true,
          };
        }

        const result = removeFromCart(cartId, lineId);
        if (!result.success) {
          let errorMessage = "Failed to remove item from cart.";
          if (result.error === "line_not_found") {
            errorMessage = `Line item not found with ID "${sanitizeForDisplay(lineId)}" in cart "${sanitizeForDisplay(cartId)}".`;
          } else if (result.error === "cart_locked") {
            errorMessage = `Cart "${sanitizeForDisplay(cartId)}" is locked for checkout and cannot be modified.`;
          }
          return {
            content: [
              {
                type: "text",
                text: errorMessage,
              },
            ],
            isError: true,
          };
        }
        const updatedCart = result.cart;

        return {
          content: [
            {
              type: "text",
              text: `Item removed from cart.\n\n${formatCartSummary(updatedCart)}`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [
            { type: "text", text: `Error removing from cart: ${message}` },
          ],
          isError: true,
        };
      }
    }
  );
}
