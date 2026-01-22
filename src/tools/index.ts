/**
 * Tool registration for MCP server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerProductTools } from "./products.js";
import { registerCartTools } from "./cart.js";
import { registerPaymentTools } from "./payment.js";
import { registerBuylistTools } from "./buylist.js";

/**
 * Expected number of tools registered by this server
 */
export const EXPECTED_TOOL_COUNT = 12;

/**
 * Names of all registered tools for validation
 */
export const REGISTERED_TOOL_NAMES = [
  // Product tools
  "search_products",
  "get_product",
  "check_inventory",
  // Cart tools
  "create_cart",
  "add_to_cart",
  "get_cart",
  "remove_from_cart",
  // Payment tools
  "checkout_with_unicity",
  "confirm_payment",
  // Buy list tools
  "get_buyback_offer",
  "submit_to_buylist",
  "check_buylist_status",
] as const;

/**
 * Register all tools with the MCP server
 * @throws Error if tool count doesn't match expected count
 */
export function registerAllTools(server: McpServer): void {
  // Validate tool count at compile time via REGISTERED_TOOL_NAMES length
  const toolCount = REGISTERED_TOOL_NAMES.length;
  if (toolCount !== EXPECTED_TOOL_COUNT) {
    throw new Error(
      `Tool count mismatch: expected ${EXPECTED_TOOL_COUNT} tools, but REGISTERED_TOOL_NAMES has ${toolCount}. ` +
      `Update EXPECTED_TOOL_COUNT or REGISTERED_TOOL_NAMES to match.`
    );
  }

  // Product tools (search_products, get_product, check_inventory)
  registerProductTools(server);

  // Cart tools (create_cart, add_to_cart, get_cart, remove_from_cart)
  registerCartTools(server);

  // Payment tools (checkout_with_unicity, confirm_payment)
  registerPaymentTools(server);

  // Buy list tools (get_buyback_offer, submit_to_buylist, check_buylist_status)
  registerBuylistTools(server);
}

/**
 * Validate that a tool name is one of the registered tools
 * @param name - Tool name to validate
 * @returns true if valid, false otherwise
 */
export function isValidToolName(name: string): name is typeof REGISTERED_TOOL_NAMES[number] {
  return (REGISTERED_TOOL_NAMES as readonly string[]).includes(name);
}

// Export individual registration functions for testing
export { registerProductTools } from "./products.js";
export { registerCartTools } from "./cart.js";
export { registerPaymentTools } from "./payment.js";
export { registerBuylistTools } from "./buylist.js";
