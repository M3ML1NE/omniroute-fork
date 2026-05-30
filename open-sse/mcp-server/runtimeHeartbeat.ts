/**
 * MCP runtime heartbeat stub – runtimeHeartbeat.ts removed in stripdown/v1 T10.
 */

export interface McpHeartbeat {
  pid: number;
  version: string;
  startedAt: string;
  lastHeartbeatAt: string;
  scopesEnforced: boolean;
  allowedScopes: string[];
  toolCount: number;
}

export function resolveMcpHeartbeatPath(): string {
  return "";
}

export async function readMcpHeartbeat(): Promise<McpHeartbeat | null> {
  return null;
}

export function isMcpHeartbeatOnline(
  _heartbeat: McpHeartbeat | null,
  _opts?: { requireLivePid?: boolean }
): boolean {
  return false;
}

export function isProcessAlive(_pid: number): boolean {
  return false;
}

export function startMcpHeartbeat(_opts: {
  version: string;
  scopesEnforced: boolean;
  allowedScopes: string[];
  toolCount: number;
}): () => void {
  return () => {};
}
