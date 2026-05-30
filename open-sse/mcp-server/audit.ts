/**
 * MCP audit stub – audit.ts removed in stripdown/v1 T10.
 */

export interface AuditEntry {
  toolName: string;
  createdAt: string;
  success: boolean;
  durationMs: number;
}

export interface AuditStats {
  totalCalls: number;
  successRate: number;
  avgDurationMs: number;
  topTools: Array<{ name: string; count: number }>;
}

export interface AuditQueryResult {
  entries: AuditEntry[];
  total: number;
}

export async function logToolCall(
  _toolName: string,
  _args: unknown,
  _result: unknown,
  _durationMs: number,
  _success: boolean,
  _errorReason?: string
): Promise<void> {
  // no-op stub
}

export async function getAuditStats(): Promise<AuditStats> {
  return { totalCalls: 0, successRate: 0, avgDurationMs: 0, topTools: [] };
}

export async function queryAuditEntries(_opts: {
  limit?: number;
  offset?: number;
  tool?: string;
  success?: boolean;
  apiKeyId?: string;
}): Promise<AuditQueryResult> {
  return { entries: [], total: 0 };
}

export async function getRecentAuditEntries(_limit?: number): Promise<AuditEntry[]> {
  return [];
}
