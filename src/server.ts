/**
 * MCP Server instance and tool registration
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tools/index.js";

/**
 * Create and configure the MCP server instance
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "runic-vault",
    version: "1.0.0",
  });

  // Register all MCP tools
  registerAllTools(server);

  return server;
}
