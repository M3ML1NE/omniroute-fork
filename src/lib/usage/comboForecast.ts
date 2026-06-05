// Quota subsystem removed (Wave 1 cleanup) — stub returns empty response
import type {
  ComboForecastHorizon,
  ComboForecastResponse,
  UtilizationTimeRange,
} from "@/shared/types/utilization";

export async function buildComboForecastResponse(_opts: {
  range: UtilizationTimeRange;
  horizon: ComboForecastHorizon;
  comboId?: string;
  now?: number;
  combos?: unknown[];
}): Promise<ComboForecastResponse> {
  return {
    timeRange: _opts.range,
    horizon: _opts.horizon,
    combos: [],
    dataQuality: { quotaCoverage: { total: 0, withConnection: 0, withProvider: 0 } },
    quotaRisk: { level: "unknown", projectedWorstRemainingPct: null, timeToExhaustDays: null },
  };
}
