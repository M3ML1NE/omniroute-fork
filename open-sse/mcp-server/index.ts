/**
 * OmniRoute MCP Server barrel export.
 * Stripped in T10: audit.ts, runtimeHeartbeat.ts, schemas/tools.ts, schemas/a2a.ts, schemas/audit.ts removed.
 */
export { createMcpServer, startMcpStdio, registerAtlassianTools } from "./server.ts";
export { jiraTools } from "./tools/atlassian/jira.ts";
export { bitbucketTools } from "./tools/atlassian/bitbucket.ts";
export { confluenceTools } from "./tools/atlassian/confluence.ts";
export {
  handleMcpSSE,
  handleMcpStreamableHTTP,
  getMcpHttpStatus,
  shutdownMcpHttp,
  isMcpHttpActive,
} from "./httpTransport.ts";
