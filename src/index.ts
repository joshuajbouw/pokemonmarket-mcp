/**
 * Entry point for Runic Vault MCP Server
 * Stdio transport for Claude Desktop
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { getConfig } from "./config.js";
import { IdentityService } from "./unicity/identity.js";
import { initializeNostrService } from "./unicity/nostr.js";

async function main(): Promise<void> {
  // Load configuration
  const config = getConfig();

  // Initialize identity service (generates keys, mints nametag on first run)
  const identityService = new IdentityService(config);
  await identityService.initialize();

  // Initialize Nostr service (connects to relay, subscribes to payments)
  await initializeNostrService(config, identityService);

  // Create and start MCP server
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
