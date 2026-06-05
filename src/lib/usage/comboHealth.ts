// Quota subsystem removed (Wave 1 cleanup) — stub returns empty response
import type { ComboHealthResponse, UtilizationTimeRange } from "@/shared/types/utilization";

export async function buildComboHealthResponse(_opts: {
  range: UtilizationTimeRange;
  comboId?: string;
  now?: number;
  combos?: unknown[];
}): Promise<ComboHealthResponse> {
  return { timeRange: _opts.range, combos: [] };
}
