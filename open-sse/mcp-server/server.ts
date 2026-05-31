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

import {
  getAtlassianConfig,
  type AtlassianConfig,
} from "../services/atlassianConfig.ts";
import {
  jiraTools,
  type AnyJiraMcpTool,
} from "./tools/atlassian/jira.ts";
import {
  bitbucketTools,
  type AnyBitbucketMcpTool,
} from "./tools/atlassian/bitbucket.ts";
import {
  confluenceTools,
  type AnyConfluenceMcpTool,
} from "./tools/atlassian/confluence.ts";
import type { AtlassianService } from "../types/atlassianConfig.ts";

// ============ Configuration ============

const MCP_ENFORCE_SCOPES = process.env.OMNIROUTE_MCP_ENFORCE_SCOPES === "true";
const MCP_ALLOWED_SCOPES = new Set(
  (process.env.OMNIROUTE_MCP_SCOPES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// ============ Atlassian tool registration ============

type AnyAtlassianMcpTool =
  | AnyJiraMcpTool
  | AnyBitbucketMcpTool
  | AnyConfluenceMcpTool;

const ATLASSIAN_TOOLS: Record<AtlassianService, AnyAtlassianMcpTool[]> = {
  jira: jiraTools,
  bitbucket: bitbucketTools,
  confluence: confluenceTools,
};

/**
 * Register Atlassian tools for every service that is configured AND enabled
 * (per {@link AtlassianConfig.list}). Disabled, absent, or unloaded config all
 * yield zero tools for that service – the server still starts cleanly.
 * Returns the number of tools registered.
 */
export function registerAtlassianTools(
  server: McpServer,
  config: AtlassianConfig = getAtlassianConfig(),
): number {
  let count = 0;
  for (const service of config.list()) {
    for (const tool of ATLASSIAN_TOOLS[service]) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          // SDK registerTool expects the raw Zod shape, not the schema object.
          inputSchema: tool.inputSchema.shape,
        },
        async (args: unknown) => tool.handler(tool.inputSchema.parse(args)),
      );
      count++;
    }
  }
  return count;
}

// ============ Server Factory ============

/**
 * Create and configure the OmniRoute MCP Server, registering Atlassian tools
 * for every enabled service. Unloaded config registers no tools.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "omniroute",
    version: process.env.npm_package_version ?? "1.8.1",
  });

  registerAtlassianTools(server);

  return server;
}

// ============ Main Entry Point (stdio) ============

/**
 * Start MCP server on stdio transport.
 * Called when `omniroute --mcp` is used.
 */
export async function startMcpStdio(): Promise<void> {
  const config = getAtlassianConfig();
  try {
    await config.load();
    config.watch();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MCP] Atlassian config not loaded (starting with 0 tools): ${msg}`);
  }

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
