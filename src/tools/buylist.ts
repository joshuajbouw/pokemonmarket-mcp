/**
 * Buy list tools for MCP server
 * - get_buyback_offer: Check if Runic Vault is buying a card
 * - submit_to_buylist: Submit a sell request for shop approval
 * - check_buylist_status: Check status of a buy list submission
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getProductByHandle,
  getVariantById,
  formatPrice,
  getFirstVariant,
} from "../shopify/index.js";
import {
  createBuylistRequest,
  getBuylistRequest,
} from "../store/index.js";
import {
  BUYBACK_PERCENTAGE,
  BUYBACK_INVENTORY_THRESHOLD,
  dollarsToCents,
  centsToDisplayString,
  sanitizeForDisplay,
} from "../types.js";

/**
 * Calculate buyback offer price (70% of retail)
 * @param retailPriceCents - Retail price in minor units
 * @returns Offer price in minor units (rounded down to nearest cent)
 */
function calculateOfferPrice(retailPriceCents: number): number {
  return Math.floor(retailPriceCents * BUYBACK_PERCENTAGE);
}

/**
 * Register buy list tools with the MCP server
 */
export function registerBuylistTools(server: McpServer): void {
  // get_buyback_offer tool
  server.registerTool(
    "get_buyback_offer",
    {
      description:
        "Check if Runic Vault is currently buying a card. Returns a buyback offer at 70% of retail price if inventory is low (< 20 units).",
      inputSchema: {
        productHandle: z
          .string()
          .optional()
          .describe("Product handle/slug (e.g., 'ancient-rune-sword'). Provide either productHandle or variantId."),
        variantId: z
          .string()
          .optional()
          .describe("Full variant ID in GID format (e.g., 'gid://shopify/ProductVariant/123'). Provide either productHandle or variantId."),
      },
    },
    async ({ productHandle, variantId }) => {
      try {
        // Validate that at least one identifier is provided
        if (!productHandle && !variantId) {
          return {
            content: [
              {
                type: "text",
                text: "Please provide either a productHandle or variantId to check for buyback offers.",
              },
            ],
            isError: true,
          };
        }

        let variant: Awaited<ReturnType<typeof getVariantById>>;
        let productTitle: string;
        let variantTitle: string;

        if (variantId) {
          // Get variant directly by ID
          variant = await getVariantById(variantId);
          if (!variant) {
            return {
              content: [
                {
                  type: "text",
                  text: `Variant not found with ID "${sanitizeForDisplay(variantId)}".`,
                },
              ],
              isError: true,
            };
          }
          productTitle = variant.product.title;
          variantTitle = variant.title;
        } else {
          // Get product by handle, then use first variant
          const product = await getProductByHandle(productHandle!);
          if (!product) {
            return {
              content: [
                {
                  type: "text",
                  text: `Product not found with handle "${sanitizeForDisplay(productHandle!)}".`,
                },
              ],
              isError: true,
            };
          }

          const firstVariant = getFirstVariant(product);
          if (!firstVariant) {
            return {
              content: [
                {
                  type: "text",
                  text: `Product "${product.title}" has no variants available.`,
                },
              ],
              isError: true,
            };
          }

          // Get full variant details with inventory
          variant = await getVariantById(firstVariant.id);
          if (!variant) {
            return {
              content: [
                {
                  type: "text",
                  text: `Unable to retrieve variant details for "${product.title}".`,
                },
              ],
              isError: true,
            };
          }
          productTitle = product.title;
          variantTitle = firstVariant.title;
        }

        // Check inventory level
        const quantityAvailable = variant.quantityAvailable;

        // If inventory is not tracked, we can't determine buyback eligibility
        if (quantityAvailable === null) {
          return {
            content: [
              {
                type: "text",
                text: `Inventory is not tracked for **${productTitle}** (${variantTitle}). Unable to determine buyback eligibility.`,
              },
            ],
          };
        }

        // Check if inventory is below threshold
        if (quantityAvailable >= BUYBACK_INVENTORY_THRESHOLD) {
          return {
            content: [
              {
                type: "text",
                text: `Runic Vault is not currently purchasing **${productTitle}** (${variantTitle}). Current inventory: ${quantityAvailable} units.`,
              },
            ],
          };
        }

        // Calculate offer price
        const retailPriceCents = dollarsToCents(variant.price.amount);
        const offerPriceCents = calculateOfferPrice(retailPriceCents);
        const currency = variant.price.currencyCode;

        const retailDisplay = centsToDisplayString(retailPriceCents);
        const offerDisplay = centsToDisplayString(offerPriceCents);

        return {
          content: [
            {
              type: "text",
              text: `## Buyback Offer\n\n**${productTitle}** (${variantTitle})\n\nRunic Vault will purchase this card at **${offerDisplay} ${currency}** (70% of retail ${retailDisplay} ${currency}).\n\nCurrent inventory: ${quantityAvailable} units\nVariant ID: \`${variant.id}\`\n\nTo sell this card, use the \`submit_to_buylist\` tool with your Unicity ID.`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [{ type: "text", text: `Error checking buyback offer: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // submit_to_buylist tool
  server.registerTool(
    "submit_to_buylist",
    {
      description:
        "Submit a sell request to Runic Vault's buy list for approval. The shop will review and approve/reject the request.",
      inputSchema: {
        variantId: z
          .string()
          .describe("Full variant ID in GID format (e.g., 'gid://shopify/ProductVariant/123')"),
        sellerUnicityId: z
          .string()
          .describe("Your Unicity ID (nametag) for payment"),
        quantity: z
          .number()
          .optional()
          .default(1)
          .describe("Quantity of cards to sell (default: 1)"),
      },
    },
    async ({ variantId, sellerUnicityId, quantity }) => {
      try {
        // Validate quantity
        if (quantity < 1) {
          return {
            content: [
              {
                type: "text",
                text: "Quantity must be at least 1.",
              },
            ],
            isError: true,
          };
        }

        // Get variant details
        const variant = await getVariantById(variantId);
        if (!variant) {
          return {
            content: [
              {
                type: "text",
                text: `Variant not found with ID "${sanitizeForDisplay(variantId)}".`,
              },
            ],
            isError: true,
          };
        }

        // Re-validate that the offer is still valid (inventory check)
        const quantityAvailable = variant.quantityAvailable;

        if (quantityAvailable === null) {
          return {
            content: [
              {
                type: "text",
                text: `Inventory is not tracked for **${variant.product.title}** (${variant.title}). Unable to accept buyback submissions.`,
              },
            ],
            isError: true,
          };
        }

        if (quantityAvailable >= BUYBACK_INVENTORY_THRESHOLD) {
          return {
            content: [
              {
                type: "text",
                text: `Runic Vault is not currently purchasing **${variant.product.title}** (${variant.title}). Current inventory (${quantityAvailable} units) is at or above our threshold.`,
              },
            ],
            isError: true,
          };
        }

        // Calculate offer price
        const retailPriceCents = dollarsToCents(variant.price.amount);
        const offerPriceCents = calculateOfferPrice(retailPriceCents);
        const totalOfferCents = offerPriceCents * quantity;
        const currency = variant.price.currencyCode;

        // Create the buy list request
        const request = createBuylistRequest({
          variantId: variant.id,
          productHandle: variant.product.handle,
          productTitle: variant.product.title,
          variantTitle: variant.title,
          quantity,
          offerPriceCents: totalOfferCents,
          retailPriceCents: retailPriceCents * quantity,
          currency,
          sellerUnicityId,
        });

        const totalOfferDisplay = centsToDisplayString(totalOfferCents);

        return {
          content: [
            {
              type: "text",
              text: `## Buy List Submission\n\nSubmitted to Runic Vault's buy list. Request #${request.id} pending approval.\n\n**Product:** ${variant.product.title} (${variant.title})\n**Quantity:** ${quantity}\n**Total Offer:** ${totalOfferDisplay} ${currency}\n**Seller:** ${sellerUnicityId}\n**Status:** Pending approval\n\nUse the \`check_buylist_status\` tool with request ID \`${request.id}\` to check the status of your submission.`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [{ type: "text", text: `Error submitting to buy list: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // check_buylist_status tool
  server.registerTool(
    "check_buylist_status",
    {
      description:
        "Check the status of a buy list submission.",
      inputSchema: {
        requestId: z
          .string()
          .describe("The request ID returned from submit_to_buylist"),
      },
    },
    async ({ requestId }) => {
      try {
        const request = getBuylistRequest(requestId);

        if (!request) {
          return {
            content: [
              {
                type: "text",
                text: `Buy list request not found with ID "${sanitizeForDisplay(requestId)}".`,
              },
            ],
            isError: true,
          };
        }

        const totalOfferDisplay = centsToDisplayString(request.offerPriceCents);

        let statusMessage: string;
        switch (request.status) {
          case "pending":
            statusMessage = "Pending approval from Runic Vault";
            break;
          case "approved":
            statusMessage = "Approved - awaiting shipping details";
            break;
          case "rejected":
            statusMessage = "Runic Vault declined this purchase";
            break;
        }

        return {
          content: [
            {
              type: "text",
              text: `## Buy List Request Status\n\n**Request ID:** ${request.id}\n**Status:** ${statusMessage}\n\n**Product:** ${request.productTitle} (${request.variantTitle})\n**Quantity:** ${request.quantity}\n**Offer:** ${totalOfferDisplay} ${request.currency}\n**Seller:** ${request.sellerUnicityId}\n**Submitted:** ${request.createdAt.toISOString()}`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [{ type: "text", text: `Error checking buy list status: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
