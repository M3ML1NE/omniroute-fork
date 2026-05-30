/**
 * MCP tool schemas stub – tools.ts removed in stripdown/v1 T10.
 * Returns empty tool registry.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  scopes: ReadonlyArray<string>;
  phase: number;
  auditLevel: string;
  sourceEndpoints: ReadonlyArray<string>;
}

export type AuditLevel = "none" | "basic" | "full";

export const MCP_TOOLS: McpToolDefinition[] = [];
export const MCP_ESSENTIAL_TOOLS: McpToolDefinition[] = [];
export const MCP_ADVANCED_TOOLS: McpToolDefinition[] = [];
export const MCP_TOOL_MAP: Record<string, McpToolDefinition> = {};

// Input schemas (empty stubs – all tools removed)
import { z } from "zod";

export const getHealthInput = z.object({});
export const getHealthOutput = z.object({});
export const getHealthTool = null;

export const listCombosInput = z.object({ includeMetrics: z.boolean().optional() });
export const listCombosOutput = z.object({});
export const listCombosTool = null;

export const getComboMetricsInput = z.object({ comboId: z.string() });
export const getComboMetricsOutput = z.object({});
export const getComboMetricsTool = null;

export const switchComboInput = z.object({ comboId: z.string(), active: z.boolean() });
export const switchComboOutput = z.object({});
export const switchComboTool = null;

export const checkQuotaInput = z.object({ provider: z.string().optional(), connectionId: z.string().optional() });
export const checkQuotaOutput = z.object({});
export const checkQuotaTool = null;

export const routeRequestInput = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
  combo: z.string().optional(),
  budget: z.number().optional(),
  role: z.string().optional(),
  stream: z.boolean().optional(),
});
export const routeRequestOutput = z.object({});
export const routeRequestTool = null;

export const costReportInput = z.object({ period: z.string().optional() });
export const costReportOutput = z.object({});
export const costReportTool = null;

export const listModelsCatalogInput = z.object({ provider: z.string().optional(), capability: z.string().optional() });
export const listModelsCatalogOutput = z.object({});
export const listModelsCatalogTool = null;

export const simulateRouteInput = z.object({});
export const simulateRouteOutput = z.object({});
export const simulateRouteTool = null;

export const setBudgetGuardInput = z.object({});
export const setBudgetGuardOutput = z.object({});
export const setBudgetGuardTool = null;

export const setResilienceProfileInput = z.object({});
export const setResilienceProfileOutput = z.object({});
export const setResilienceProfileTool = null;

export const testComboInput = z.object({});
export const testComboOutput = z.object({});
export const testComboTool = null;

export const getProviderMetricsInput = z.object({});
export const getProviderMetricsOutput = z.object({});
export const getProviderMetricsTool = null;

export const bestComboForTaskInput = z.object({});
export const bestComboForTaskOutput = z.object({});
export const bestComboForTaskTool = null;

export const explainRouteInput = z.object({});
export const explainRouteOutput = z.object({});
export const explainRouteTool = null;

export const getSessionSnapshotInput = z.object({});
export const getSessionSnapshotOutput = z.object({});
export const getSessionSnapshotTool = null;

export const dbHealthCheckInput = z.object({});
export const dbHealthCheckOutput = z.object({});
export const dbHealthCheckTool = null;

export const cacheStatsInput = z.object({});
export const cacheStatsOutput = z.object({});
export const cacheStatsTool = null;

export const cacheFlushInput = z.object({ signature: z.string().optional(), model: z.string().optional() });
export const cacheFlushOutput = z.object({});
export const cacheFlushTool = null;

export const webSearchInput = z.object({
  query: z.string(),
  max_results: z.number().optional(),
  search_type: z.enum(["web", "news"]).optional(),
  provider: z.string().optional(),
});

export const setRoutingStrategyInput = z.object({});
export const oneproxyFetchInput = z.object({});
export const oneproxyRotateInput = z.object({});
export const oneproxyStatsInput = z.object({});
export const syncPricingInput = z.object({});
