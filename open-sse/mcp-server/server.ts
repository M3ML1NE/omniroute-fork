/**
 * OmniRoute MCP Server skeleton.
 * Tools removed in stripdown/v1 (T10). Server infrastructure kept for T24/T29.
 *
 * Transports:
 *   1. stdio  – IDE integration (VS Code, Cursor, Claude Desktop)
 *   2. HTTP   – remote/programmatic access via httpTransport.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// ============ Configuration ============

const MCP_ENFORCE_SCOPES = process.env.OMNIROUTE_MCP_ENFORCE_SCOPES === "true";
const MCP_ALLOWED_SCOPES = new Set(
  (process.env.OMNIROUTE_MCP_SCOPES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// ============ Server Factory ============

/**
 * Create and configure the OmniRoute MCP Server (no tools registered).
 * Tool registration removed in stripdown/v1 T10.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "omniroute",
    version: process.env.npm_package_version ?? "1.8.1",
  });

  // No tools registered – skeleton only.
  // Re-add tool sets in T24/T29 as needed.

  return server;
}

// ============ Main Entry Point (stdio) ============

/**
 * Start MCP server on stdio transport.
 * Called when `omniroute --mcp` is used.
 */
export async function startMcpStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  const onExit = () => {
    // cleanup hook – extend in T24/T29
  };

  process.once("exit", onExit);
  process.once("SIGINT", onExit);
  process.once("SIGTERM", onExit);

  console.error("[MCP] OmniRoute MCP Server starting (stdio transport)...");
  try {
    await server.connect(transport);
    console.error("[MCP] OmniRoute MCP Server connected and ready.");
  } finally {
    onExit();
    process.off("exit", onExit);
    process.off("SIGINT", onExit);
    process.off("SIGTERM", onExit);
  }
}

// If file is run directly, start stdio server
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  startMcpStdio().catch((err) => {
    console.error("[MCP] Fatal error:", err);
    process.exit(1);
  });
}

// Re-export scope config for consumers (httpTransport, etc.)
export { MCP_ENFORCE_SCOPES, MCP_ALLOWED_SCOPES };
