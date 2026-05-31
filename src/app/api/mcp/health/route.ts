/**
 * MCP health endpoint.
 * GET /api/mcp/health — returns transport status for the MCP server.
 */

import { NextResponse } from "next/server";
import { getMcpHttpStatus } from "../../../../../open-sse/mcp-server/httpTransport";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const status = getMcpHttpStatus();
  return NextResponse.json({
    status: "ok",
    transport: "sse",
    server: "omniroute",
    version: "1.0.0",
    mcpOnline: status.online,
    mcpTransport: status.transport,
    uptime: status.uptime,
  });
}
