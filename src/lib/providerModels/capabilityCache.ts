import { getAllSyncedAvailableModels, type SyncedAvailableModel } from "@/lib/db/models";

// In-memory mirror of the live discovery cache (namespace `syncedAvailableModels`),
// so `getResolvedModelCapabilities` (synchronous, hot path) can read discovered
// per-model limits/capabilities WITHOUT a DB round-trip. The mirror is populated
// asynchronously from the discovery cache and swapped atomically.
//
// Fields intentionally match the `synced?.X` accesses in `modelCapabilities.ts`:
// only the ones the discovery cache actually knows are populated; everything else
// stays `undefined` (= unknown → fail-open, targets pass through). We NEVER coerce
// unknown to `false`, which would falsely reject targets.
export interface SyncedCapabilityEntry {
  limit_input?: number;
  limit_output?: number;
  reasoning?: boolean;
}

interface ProviderCapabilityIndex {
  // Exact discovered model id → entry (case preserved).
  byModelId: Map<string, SyncedCapabilityEntry>;
  // Lowercased discovered model id → entry (case-insensitive fallback).
  byLowerModelId: Map<string, SyncedCapabilityEntry>;
}

// providerId → its model index.
let capabilityCache = new Map<string, ProviderCapabilityIndex>();
let hasLoaded = false;
let refreshInFlight: Promise<void> | null = null;

function toEntry(model: SyncedAvailableModel): SyncedCapabilityEntry {
  const entry: SyncedCapabilityEntry = {};
  if (typeof model.inputTokenLimit === "number") entry.limit_input = model.inputTokenLimit;
  if (typeof model.outputTokenLimit === "number") entry.limit_output = model.outputTokenLimit;
  if (model.supportsThinking === true) entry.reasoning = true;
  return entry;
}

function buildIndex(models: SyncedAvailableModel[]): ProviderCapabilityIndex {
  const byModelId = new Map<string, SyncedCapabilityEntry>();
  const byLowerModelId = new Map<string, SyncedCapabilityEntry>();
  for (const model of models) {
    if (!model.id) continue;
    const entry = toEntry(model);
    byModelId.set(model.id, entry);
    byLowerModelId.set(model.id.toLowerCase(), entry);
  }
  return { byModelId, byLowerModelId };
}

/**
 * Reload the entire mirror from the discovery cache and swap it atomically.
 * Single-flight: concurrent callers share the same in-flight promise so a burst
 * of triggers never launches a thundering herd of DB scans.
 */
export function refreshCapabilityCache(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const byProvider = await getAllSyncedAvailableModels();
      const next = new Map<string, ProviderCapabilityIndex>();
      for (const [providerId, models] of Object.entries(byProvider)) {
        next.set(providerId, buildIndex(models));
      }
      capabilityCache = next;
      hasLoaded = true;
    } catch (err) {
      // Fail-open: leave the previous mirror in place. A failed refresh must not
      // break capability resolution — callers treat a miss as "unknown".
      console.log(
        "[capabilityCache] refresh failed:",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * Fire-and-forget refresh helper for write paths / startup. Never throws.
 */
export function scheduleCapabilityCacheRefresh(): void {
  void refreshCapabilityCache();
}

/**
 * Synchronous lookup used by `getResolvedModelCapabilities`. Returns `null` on a
 * miss (unknown → fail-open). If the mirror has never loaded, it schedules a
 * background refresh (single-flight) and returns `null` for this call.
 *
 * Lookup order: exact `providerId:modelId`, then case-insensitive within the
 * provider — discovered ids may differ in case from combo model strings
 * (e.g. discovered `GigaChat-2-Max` vs a requested `gigachat-2-max`). Combo
 * strings preserve case through `parseModel`, so exact match wins when casing
 * agrees and the lowercase index is only a safety net.
 */
export function getSyncedCapabilitySync(
  providerId: string,
  modelId: string
): SyncedCapabilityEntry | null {
  if (!hasLoaded) {
    scheduleCapabilityCacheRefresh();
    return null;
  }
  if (!providerId || !modelId) return null;
  const index = capabilityCache.get(providerId);
  if (!index) return null;
  return index.byModelId.get(modelId) ?? index.byLowerModelId.get(modelId.toLowerCase()) ?? null;
}

/**
 * Test-only reset so unit tests can force a clean, deterministic mirror.
 */
export function __resetCapabilityCacheForTests(): void {
  capabilityCache = new Map();
  hasLoaded = false;
  refreshInFlight = null;
}
