/**
 * OmniRoute MCP Server barrel export.
 * Stripped in T10: audit.ts, runtimeHeartbeat.ts, schemas/tools.ts, schemas/a2a.ts, schemas/audit.ts removed.
 */
export { createMcpServer, startMcpStdio } from "./server.ts";
export {
  handleMcpSSE,
  handleMcpStreamableHTTP,
  getMcpHttpStatus,
  shutdownMcpHttp,
  isMcpHttpActive,
} from "./httpTransport.ts";
