/**
 * Entry point for Runic Vault MCP Server
 * Supports stdio transport (Claude Desktop) and HTTP/SSE transport (remote deployment)
 */

import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

  // Create MCP server
  const server = createServer();

  if (config.transport === "http") {
    await startHttpTransport(server, config.httpPort);
  } else {
    await startStdioTransport(server);
  }
}

async function startStdioTransport(server: ReturnType<typeof createServer>): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startHttpTransport(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  // Create a single stateless transport instance
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode
  });

  // Connect the MCP server to the transport
  await server.connect(transport);

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // CORS headers for browser clients
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check endpoint
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // MCP endpoint - handles both GET (SSE stream) and POST (messages)
    if (url.pathname === "/mcp") {
      await transport.handleRequest(req, res);
      return;
    }

    // 404 for unknown routes
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(port, () => {
    console.error(`MCP server listening on http://0.0.0.0:${port}`);
    console.error(`  MCP endpoint: /mcp (GET for SSE, POST for messages)`);
    console.error(`  Health check: GET /health`);
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    transport.close();
    httpServer.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
