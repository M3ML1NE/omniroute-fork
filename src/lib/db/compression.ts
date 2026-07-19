import { backupDbFile } from "./backup";
import { getDefaultCompressionCombo } from "./compressionCombos";
import { getDbInstance } from "./core";
import { invalidateDbCache } from "./readCache";
import {
  DEFAULT_AGGRESSIVE_CONFIG,
  DEFAULT_CAVEMAN_CONFIG,
  DEFAULT_CAVEMAN_OUTPUT_MODE_CONFIG,
  DEFAULT_COMPRESSION_LANGUAGE_CONFIG,
  DEFAULT_COMPRESSION_CONFIG,
  DEFAULT_MCP_ACCESSIBILITY_CONFIG,
  DEFAULT_RELEVANCE_CONFIG,
  DEFAULT_RTK_CONFIG,
  DEFAULT_ULTRA_CONFIG,
  ENGINE_IDS,
  type AggressiveConfig,
  type CavemanConfig,
  type CavemanOutputModeConfig,
  type CompressionLanguageConfig,
  type CompressionPipelineStep,
  type CompressionConfig,
  type CompressionMode,
  type EngineToggle,
  type McpAccessibilityConfig,
  type OutputStyleSelectionEntry,
  type PreserveSystemPromptMode,
  type RelevanceConfig,
  type RtkConfig,
  type UltraConfig,
} from "@omniroute/open-sse/services/compression/types.ts";

const NAMESPACE = "compression";
const COMPRESSION_MODES = new Set<CompressionMode>([
  "off",
  "lite",
  "standard",
  "aggressive",
  "ultra",
  "rtk",
  "stacked",
]);

type JsonRecord = Record<string, unknown>;
// TTL cache for compression settings (5s)
let compressionSettingsCache: {
  value: CompressionConfig;
  expiresAt: number;
  dbRef: WeakRef<object>;
} | null = null;

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function parseJsonSafe(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function normalizeCavemanConfig(value: unknown): CavemanConfig {
  const record = toRecord(value);
  const intensity =
    record.intensity === "lite" || record.intensity === "full" || record.intensity === "ultra"
      ? record.intensity
      : DEFAULT_CAVEMAN_CONFIG.intensity;
  return {
    ...DEFAULT_CAVEMAN_CONFIG,
    ...record,
    compressRoles: Array.isArray(record.compressRoles)
      ? record.compressRoles.filter(
          (role): role is "user" | "assistant" | "system" =>
            role === "user" || role === "assistant" || role === "system"
        )
      : DEFAULT_CAVEMAN_CONFIG.compressRoles,
    skipRules: Array.isArray(record.skipRules)
      ? record.skipRules.filter((rule): rule is string => typeof rule === "string")
      : DEFAULT_CAVEMAN_CONFIG.skipRules,
    minMessageLength:
      typeof record.minMessageLength === "number" && Number.isFinite(record.minMessageLength)
        ? Math.max(0, Math.floor(record.minMessageLength))
        : DEFAULT_CAVEMAN_CONFIG.minMessageLength,
    preservePatterns: Array.isArray(record.preservePatterns)
      ? record.preservePatterns.filter((pattern): pattern is string => typeof pattern === "string")
      : DEFAULT_CAVEMAN_CONFIG.preservePatterns,
    intensity,
  };
}

function normalizeCavemanOutputModeConfig(value: unknown): CavemanOutputModeConfig {
  const record = toRecord(value);
  return {
    ...DEFAULT_CAVEMAN_OUTPUT_MODE_CONFIG,
    enabled:
      typeof record.enabled === "boolean"
        ? record.enabled
        : DEFAULT_CAVEMAN_OUTPUT_MODE_CONFIG.enabled,
    intensity:
      record.intensity === "lite" || record.intensity === "full" || record.intensity === "ultra"
        ? record.intensity
        : DEFAULT_CAVEMAN_OUTPUT_MODE_CONFIG.intensity,
    autoClarity:
      typeof record.autoClarity === "boolean"
        ? record.autoClarity
        : DEFAULT_CAVEMAN_OUTPUT_MODE_CONFIG.autoClarity,
  };
}

function normalizeRtkConfig(value: unknown): RtkConfig {
  const record = toRecord(value);
  return {
    ...DEFAULT_RTK_CONFIG,
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_RTK_CONFIG.enabled,
    intensity:
      record.intensity === "minimal" ||
      record.intensity === "standard" ||
      record.intensity === "aggressive"
        ? record.intensity
        : DEFAULT_RTK_CONFIG.intensity,
    applyToToolResults:
      typeof record.applyToToolResults === "boolean"
        ? record.applyToToolResults
        : DEFAULT_RTK_CONFIG.applyToToolResults,
    applyToCodeBlocks:
      typeof record.applyToCodeBlocks === "boolean"
        ? record.applyToCodeBlocks
        : DEFAULT_RTK_CONFIG.applyToCodeBlocks,
    applyToAssistantMessages:
      typeof record.applyToAssistantMessages === "boolean"
        ? record.applyToAssistantMessages
        : DEFAULT_RTK_CONFIG.applyToAssistantMessages,
    enabledFilters: Array.isArray(record.enabledFilters)
      ? record.enabledFilters.filter((filter): filter is string => typeof filter === "string")
      : DEFAULT_RTK_CONFIG.enabledFilters,
    disabledFilters: Array.isArray(record.disabledFilters)
      ? record.disabledFilters.filter((filter): filter is string => typeof filter === "string")
      : DEFAULT_RTK_CONFIG.disabledFilters,
    maxLinesPerResult: boundedInt(
      record.maxLinesPerResult,
      DEFAULT_RTK_CONFIG.maxLinesPerResult,
      0,
      100000
    ),
    maxCharsPerResult: boundedInt(
      record.maxCharsPerResult,
      DEFAULT_RTK_CONFIG.maxCharsPerResult,
      0,
      1000000
    ),
    deduplicateThreshold: boundedInt(
      record.deduplicateThreshold,
      DEFAULT_RTK_CONFIG.deduplicateThreshold,
      2,
      100
    ),
    customFiltersEnabled:
      typeof record.customFiltersEnabled === "boolean"
        ? record.customFiltersEnabled
        : DEFAULT_RTK_CONFIG.customFiltersEnabled,
    trustProjectFilters:
      typeof record.trustProjectFilters === "boolean"
        ? record.trustProjectFilters
        : DEFAULT_RTK_CONFIG.trustProjectFilters,
    rawOutputRetention:
      record.rawOutputRetention === "never" ||
      record.rawOutputRetention === "failures" ||
      record.rawOutputRetention === "always"
        ? record.rawOutputRetention
        : DEFAULT_RTK_CONFIG.rawOutputRetention,
    rawOutputMaxBytes: boundedInt(
      record.rawOutputMaxBytes,
      DEFAULT_RTK_CONFIG.rawOutputMaxBytes,
      1024,
      10_000_000
    ),
  };
}

function normalizeRelevanceConfig(value: unknown): RelevanceConfig {
  const record = toRecord(value);
  return {
    ...DEFAULT_RELEVANCE_CONFIG,
    enabled:
      typeof record.enabled === "boolean" ? record.enabled : DEFAULT_RELEVANCE_CONFIG.enabled,
    overlapThreshold: boundedNumber(
      record.overlapThreshold,
      DEFAULT_RELEVANCE_CONFIG.overlapThreshold,
      0,
      1
    ),
    budgetPercent: boundedNumber(
      record.budgetPercent,
      DEFAULT_RELEVANCE_CONFIG.budgetPercent,
      0.1,
      1
    ),
    boilerplateWeight: boundedNumber(
      record.boilerplateWeight,
      DEFAULT_RELEVANCE_CONFIG.boilerplateWeight,
      0,
      1
    ),
  };
}

function normalizeLanguageConfig(value: unknown): CompressionLanguageConfig {
  const record = toRecord(value);
  const defaultLanguage =
    typeof record.defaultLanguage === "string" && record.defaultLanguage.trim()
      ? record.defaultLanguage.trim()
      : DEFAULT_COMPRESSION_LANGUAGE_CONFIG.defaultLanguage;
  const enabledPacks = Array.isArray(record.enabledPacks)
    ? record.enabledPacks
        .filter((pack): pack is string => typeof pack === "string" && pack.trim().length > 0)
        .map((pack) => pack.trim())
    : DEFAULT_COMPRESSION_LANGUAGE_CONFIG.enabledPacks;
  return {
    ...DEFAULT_COMPRESSION_LANGUAGE_CONFIG,
    enabled:
      typeof record.enabled === "boolean"
        ? record.enabled
        : DEFAULT_COMPRESSION_LANGUAGE_CONFIG.enabled,
    defaultLanguage,
    autoDetect:
      typeof record.autoDetect === "boolean"
        ? record.autoDetect
        : DEFAULT_COMPRESSION_LANGUAGE_CONFIG.autoDetect,
    enabledPacks: [...new Set(enabledPacks.length > 0 ? enabledPacks : ["en"])],
  };
}

function normalizeStackedPipeline(value: unknown): CompressionPipelineStep[] {
  const source = Array.isArray(value) ? value : (DEFAULT_COMPRESSION_CONFIG.stackedPipeline ?? []);
  const pipeline: CompressionPipelineStep[] = [];
  for (const entry of source) {
    const record = toRecord(entry);
    const engine = record.engine;
    if (
      engine !== "lite" &&
      engine !== "caveman" &&
      engine !== "aggressive" &&
      engine !== "ultra" &&
      engine !== "rtk" &&
      engine !== "relevance"
    ) {
      continue;
    }
    pipeline.push({
      engine,
      ...(typeof record.intensity === "string"
        ? { intensity: record.intensity as CompressionPipelineStep["intensity"] }
        : {}),
      ...(record.config && typeof record.config === "object"
        ? { config: record.config as Record<string, unknown> }
        : {}),
    });
  }
  return pipeline.length > 0 ? pipeline : (DEFAULT_COMPRESSION_CONFIG.stackedPipeline ?? []);
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeAggressiveConfig(value: unknown): AggressiveConfig {
  const record = toRecord(value);
  const thresholds = toRecord(record.thresholds);
  const toolStrategies = toRecord(record.toolStrategies);

  return {
    ...DEFAULT_AGGRESSIVE_CONFIG,
    thresholds: {
      fullSummary: boundedInt(
        thresholds.fullSummary,
        DEFAULT_AGGRESSIVE_CONFIG.thresholds.fullSummary,
        1,
        100
      ),
      moderate: boundedInt(
        thresholds.moderate,
        DEFAULT_AGGRESSIVE_CONFIG.thresholds.moderate,
        1,
        100
      ),
      light: boundedInt(thresholds.light, DEFAULT_AGGRESSIVE_CONFIG.thresholds.light, 1, 100),
      verbatim: boundedInt(
        thresholds.verbatim,
        DEFAULT_AGGRESSIVE_CONFIG.thresholds.verbatim,
        1,
        100
      ),
    },
    toolStrategies: {
      fileContent:
        typeof toolStrategies.fileContent === "boolean"
          ? toolStrategies.fileContent
          : DEFAULT_AGGRESSIVE_CONFIG.toolStrategies.fileContent,
      grepSearch:
        typeof toolStrategies.grepSearch === "boolean"
          ? toolStrategies.grepSearch
          : DEFAULT_AGGRESSIVE_CONFIG.toolStrategies.grepSearch,
      shellOutput:
        typeof toolStrategies.shellOutput === "boolean"
          ? toolStrategies.shellOutput
          : DEFAULT_AGGRESSIVE_CONFIG.toolStrategies.shellOutput,
      json:
        typeof toolStrategies.json === "boolean"
          ? toolStrategies.json
          : DEFAULT_AGGRESSIVE_CONFIG.toolStrategies.json,
      errorMessage:
        typeof toolStrategies.errorMessage === "boolean"
          ? toolStrategies.errorMessage
          : DEFAULT_AGGRESSIVE_CONFIG.toolStrategies.errorMessage,
    },
    summarizerEnabled:
      typeof record.summarizerEnabled === "boolean"
        ? record.summarizerEnabled
        : DEFAULT_AGGRESSIVE_CONFIG.summarizerEnabled,
    maxTokensPerMessage: boundedInt(
      record.maxTokensPerMessage,
      DEFAULT_AGGRESSIVE_CONFIG.maxTokensPerMessage,
      256,
      32768
    ),
    minSavingsThreshold: boundedNumber(
      record.minSavingsThreshold,
      DEFAULT_AGGRESSIVE_CONFIG.minSavingsThreshold,
      0,
      1
    ),
  };
}

function normalizeUltraConfig(value: unknown): UltraConfig {
  const record = toRecord(value);
  const modelPath = typeof record.modelPath === "string" ? record.modelPath.trim() : "";

  return {
    ...DEFAULT_ULTRA_CONFIG,
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_ULTRA_CONFIG.enabled,
    compressionRate: boundedNumber(
      record.compressionRate,
      DEFAULT_ULTRA_CONFIG.compressionRate,
      0,
      1
    ),
    minScoreThreshold: boundedNumber(
      record.minScoreThreshold,
      DEFAULT_ULTRA_CONFIG.minScoreThreshold,
      0,
      1
    ),
    slmFallbackToAggressive:
      typeof record.slmFallbackToAggressive === "boolean"
        ? record.slmFallbackToAggressive
        : DEFAULT_ULTRA_CONFIG.slmFallbackToAggressive,
    ...(modelPath ? { modelPath } : {}),
    maxTokensPerMessage: boundedInt(
      record.maxTokensPerMessage,
      DEFAULT_ULTRA_CONFIG.maxTokensPerMessage,
      0,
      32768
    ),
  };
}

const PRESERVE_SYSTEM_PROMPT_MODES = new Set<PreserveSystemPromptMode>([
  "always",
  "whenNoCache",
  "never",
]);

function isPreserveSystemPromptMode(value: unknown): value is PreserveSystemPromptMode {
  return (
    typeof value === "string" && PRESERVE_SYSTEM_PROMPT_MODES.has(value as PreserveSystemPromptMode)
  );
}

// T05/C5 back-compat: derive the authoritative mode from the legacy boolean when no explicit
// mode was stored. `preserveSystemPrompt: false` kept "compress unless cached" → whenNoCache.
function derivePreserveSystemPromptMode(preserveSystemPrompt: boolean): PreserveSystemPromptMode {
  return preserveSystemPrompt === false ? "whenNoCache" : "always";
}

function normalizeOutputStyleSelection(value: unknown): OutputStyleSelectionEntry[] {
  if (!Array.isArray(value)) return [];
  const out: OutputStyleSelectionEntry[] = [];
  for (const entry of value) {
    const record = toRecord(entry);
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const level =
      record.level === "lite" || record.level === "full" || record.level === "ultra"
        ? record.level
        : null;
    if (id && level) out.push({ id, level });
  }
  return out;
}

// Single-mode → engine id mapping. Mirrors deriveDefaultPlan's SINGLE_MODE_OF: a legacy
// install whose only signal is `defaultMode` should turn on the engine that mode runs, so the
// derived engines map matches the old behavior. Keep conservative — these are the only modes
// that map 1:1 to a single engine.
const SINGLE_MODE_ENGINE: Partial<Record<CompressionMode, string>> = {
  lite: "lite",
  standard: "caveman",
  aggressive: "aggressive",
  ultra: "ultra",
  rtk: "rtk",
};

function normalizeEngineToggle(value: unknown): EngineToggle | null {
  const record = toRecord(value);
  if (typeof record.enabled !== "boolean") return null;
  return {
    enabled: record.enabled,
    ...(typeof record.level === "string" ? { level: record.level } : {}),
  };
}

// Sanitize an engines map for persistence: keep only known engine ids with a well-formed
// `{enabled, level?}` toggle. Mirrors the read-path validation so a malformed write can't poison
// the stored row.
function sanitizeEnginesForWrite(value: unknown): Record<string, EngineToggle> {
  const record = toRecord(value);
  const out: Record<string, EngineToggle> = {};
  for (const id of ENGINE_IDS) {
    const toggle = normalizeEngineToggle(record[id]);
    if (toggle) out[id] = toggle;
  }
  return out;
}

// Read the stored `engines` JSON row, keeping only well-formed `{enabled, level?}` entries for
// known engine ids. Returns null when no usable row exists so the caller falls back to deriving
// the map from the legacy fields (B-backfill).
function parseStoredEnginesMap(value: unknown): Record<string, EngineToggle> | null {
  if (!value || typeof value !== "object") return null;
  const out: Record<string, EngineToggle> = {};
  let any = false;
  for (const id of ENGINE_IDS) {
    const toggle = normalizeEngineToggle((value as JsonRecord)[id]);
    if (toggle) {
      out[id] = toggle;
      any = true;
    }
  }
  return any ? out : null;
}

// `aggressive` config doesn't carry a top-level `enabled` flag in its type, but legacy installs may
// have stored one. Read it defensively for the derived engines map.
function aggressiveEnabled(value: AggressiveConfig | undefined): boolean {
  return toRecord(value).enabled === true;
}

// Derive the per-engine toggle map from the legacy compression fields so existing installs keep
// their behavior before they ever write an `engines` row. Single-engine modes (caveman/rtk/ultra/
// aggressive) come from their dedicated config blocks; structural engines (lite/headroom/
// session-dedup/ccr/relevance) come from the default-combo pipeline. `defaultMode` is a last-resort
// signal that turns on its single-mode engine when nothing else already did.
async function deriveEnginesMap(config: CompressionConfig): Promise<Record<string, EngineToggle>> {
  let defaultComboEngines = new Set<string>();
  try {
    const combo = await getDefaultCompressionCombo();
    if (combo) {
      defaultComboEngines = new Set(combo.pipeline.map((step) => step.engine));
    }
  } catch {
    defaultComboEngines = new Set<string>();
  }

  const engines: Record<string, EngineToggle> = {};
  for (const id of ENGINE_IDS) {
    let enabled = false;
    let level: string | undefined;
    switch (id) {
      case "caveman":
        enabled = config.cavemanConfig?.enabled === true;
        if (typeof config.cavemanConfig?.intensity === "string") {
          level = config.cavemanConfig.intensity;
        }
        break;
      case "rtk":
        enabled = config.rtkConfig?.enabled === true;
        if (typeof config.rtkConfig?.intensity === "string") {
          level = config.rtkConfig.intensity;
        }
        break;
      case "ultra":
        enabled = config.ultra?.enabled === true;
        break;
      case "aggressive":
        enabled = aggressiveEnabled(config.aggressive);
        break;
      default:
        // Structural engines (lite/headroom/session-dedup/ccr/relevance): on when present in the
        // default-combo pipeline.
        enabled = defaultComboEngines.has(id);
        break;
    }
    engines[id] = { enabled, ...(level !== undefined ? { level } : {}) };
  }

  const fallbackEngine = SINGLE_MODE_ENGINE[config.defaultMode];
  if (fallbackEngine && engines[fallbackEngine] && !engines[fallbackEngine].enabled) {
    engines[fallbackEngine] = { ...engines[fallbackEngine], enabled: true };
  }

  return engines;
}

export async function getCompressionSettings(): Promise<CompressionConfig> {
  const db = getDbInstance();
  if (
    compressionSettingsCache &&
    Date.now() < compressionSettingsCache.expiresAt &&
    compressionSettingsCache.dbRef.deref() === db
  ) {
    return compressionSettingsCache.value;
  }
  compressionSettingsCache = null;

  const rows = await db
    .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
    .all(NAMESPACE);

  const config: CompressionConfig = {
    ...DEFAULT_COMPRESSION_CONFIG,
    cavemanConfig: { ...DEFAULT_CAVEMAN_CONFIG },
    cavemanOutputMode: { ...DEFAULT_CAVEMAN_OUTPUT_MODE_CONFIG },
    outputStyles: [],
    rtkConfig: { ...DEFAULT_RTK_CONFIG },
    languageConfig: { ...DEFAULT_COMPRESSION_LANGUAGE_CONFIG },
    stackedPipeline: normalizeStackedPipeline(undefined),
    aggressive: normalizeAggressiveConfig(undefined),
    ultra: normalizeUltraConfig(undefined),
    engines: {},
    activeComboId: null,
  };

  // Tracks whether a usable stored `engines` row was found. When absent we derive the engines map
  // from the legacy fields below so behavior is preserved.
  let storedEngines: Record<string, EngineToggle> | null = null;
  // Tracks whether an authoritative `preserveSystemPromptMode` row was persisted. When absent
  // (legacy install that only stored the boolean) the mode is derived from that boolean below.
  let sawPreserveSystemPromptModeRow = false;

  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    const parsed = parseJsonSafe(rawValue);
    if (parsed === undefined) continue;

    switch (key) {
      case "enabled":
        config.enabled = parsed === true;
        break;
      case "defaultMode":
        if (typeof parsed === "string" && COMPRESSION_MODES.has(parsed as CompressionMode)) {
          config.defaultMode = parsed as CompressionMode;
        }
        break;
      case "autoTriggerMode":
        if (typeof parsed === "string" && COMPRESSION_MODES.has(parsed as CompressionMode)) {
          config.autoTriggerMode = parsed as CompressionMode;
        }
        break;
      case "autoTriggerTokens":
        config.autoTriggerTokens =
          typeof parsed === "number" && Number.isFinite(parsed)
            ? Math.max(0, Math.floor(parsed))
            : 0;
        break;
      case "cacheMinutes":
        config.cacheMinutes =
          typeof parsed === "number" && Number.isFinite(parsed)
            ? Math.max(1, Math.floor(parsed))
            : DEFAULT_COMPRESSION_CONFIG.cacheMinutes;
        break;
      case "preserveSystemPrompt":
        config.preserveSystemPrompt = parsed !== false;
        break;
      case "preserveSystemPromptMode":
        if (isPreserveSystemPromptMode(parsed)) {
          config.preserveSystemPromptMode = parsed;
          sawPreserveSystemPromptModeRow = true;
        }
        break;
      case "mcpDescriptionCompressionEnabled":
        config.mcpDescriptionCompressionEnabled = parsed !== false;
        break;
      case "comboOverrides":
        if (parsed && typeof parsed === "object") {
          const overrides: Record<string, CompressionMode> = {};
          for (const [comboId, mode] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof mode === "string" && COMPRESSION_MODES.has(mode as CompressionMode)) {
              overrides[comboId] = mode as CompressionMode;
            }
          }
          config.comboOverrides = overrides;
        }
        break;
      case "compressionComboId":
        config.compressionComboId =
          typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
        break;
      case "stackedPipeline":
        config.stackedPipeline = normalizeStackedPipeline(parsed);
        break;
      case "cavemanConfig":
        config.cavemanConfig = normalizeCavemanConfig(parsed);
        break;
      case "cavemanOutputMode":
        config.cavemanOutputMode = normalizeCavemanOutputModeConfig(parsed);
        break;
      case "outputStyles":
        config.outputStyles = normalizeOutputStyleSelection(parsed);
        break;
      case "engines":
        storedEngines = parseStoredEnginesMap(parsed);
        break;
      case "activeComboId":
        config.activeComboId = typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
        break;
      case "rtkConfig":
        config.rtkConfig = normalizeRtkConfig(parsed);
        break;
      case "relevanceConfig":
        config.relevanceConfig = normalizeRelevanceConfig(parsed);
        break;
      case "targetTokens":
        if (typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0) {
          config.targetTokens = Math.floor(parsed);
        }
        break;
      case "targetRatio":
        if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 && parsed <= 1) {
          config.targetRatio = parsed;
        }
        break;
      case "languageConfig":
        config.languageConfig = normalizeLanguageConfig(parsed);
        break;
      case "aggressive":
      case "aggressiveConfig":
        config.aggressive = normalizeAggressiveConfig(parsed);
        break;
      case "ultra":
      case "ultraConfig":
        config.ultra = normalizeUltraConfig(parsed);
        break;
    }
  }

  // T05/C5 back-compat: when no `preserveSystemPromptMode` row was stored, derive the authoritative
  // mode from the legacy boolean instead of letting the DEFAULT ("always") shadow it.
  if (!sawPreserveSystemPromptModeRow) {
    config.preserveSystemPromptMode = derivePreserveSystemPromptMode(config.preserveSystemPrompt);
  }

  // Engines map: prefer the stored row; otherwise derive from the legacy fields (read-path
  // backfill). Always fill EVERY id in ENGINE_IDS so the shape matches DEFAULT_COMPRESSION_CONFIG.
  const derived = storedEngines ?? (await deriveEnginesMap(config));
  const engines: Record<string, EngineToggle> = {};
  for (const id of ENGINE_IDS) {
    engines[id] = derived[id] ?? { enabled: false };
  }
  config.engines = engines;
  // Runtime-only marker: dispatch trusts the engines map only when it was explicitly stored
  // (panel-saved). A backfilled map (no stored row) is display-only — dispatch stays on the
  // legacy defaultMode/default-combo path so existing installs keep their behaviour.
  config.enginesExplicit = storedEngines !== null;

  // Store in TTL cache (5s expiry)
  compressionSettingsCache = {
    value: config,
    expiresAt: Date.now() + 5000,
    dbRef: new WeakRef(db),
  };

  return config;
}

export async function updateCompressionSettings(
  updates: Partial<CompressionConfig>
): Promise<CompressionConfig> {
  const db = getDbInstance();
  const insert = db.prepare(
    "INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?) " +
      "ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value"
  );

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    // `enginesExplicit` is a runtime-only marker derived on read; never persist it.
    if (key === "enginesExplicit") continue;
    // Persist the engines map as ONE sanitized JSON row so the read path always gets
    // well-formed { enabled, level? } toggles for known engine ids.
    if (key === "engines") {
      await insert.run(NAMESPACE, key, JSON.stringify(sanitizeEnginesForWrite(value)));
      continue;
    }
    await insert.run(NAMESPACE, key, JSON.stringify(value));
  }

  backupDbFile("pre-write");
  compressionSettingsCache = null;
  invalidateDbCache();
  return getCompressionSettings();
}

export function getDefaultAggressiveConfig(): AggressiveConfig {
  return {
    ...DEFAULT_AGGRESSIVE_CONFIG,
    thresholds: { ...DEFAULT_AGGRESSIVE_CONFIG.thresholds },
    toolStrategies: { ...DEFAULT_AGGRESSIVE_CONFIG.toolStrategies },
  };
}

export function getDefaultUltraConfig(): UltraConfig {
  return { ...DEFAULT_ULTRA_CONFIG };
}

export function getDefaultRtkConfig(): RtkConfig {
  return { ...DEFAULT_RTK_CONFIG };
}

export function getDefaultRelevanceConfig(): RelevanceConfig {
  return { ...DEFAULT_RELEVANCE_CONFIG };
}

function normalizeMcpAccessibilityConfig(value: unknown): McpAccessibilityConfig {
  const record = toRecord(value);
  return {
    ...DEFAULT_MCP_ACCESSIBILITY_CONFIG,
    ...record,
    enabled: record.enabled !== false,
    maxTextChars:
      typeof record.maxTextChars === "number" && record.maxTextChars > 0
        ? Math.floor(record.maxTextChars)
        : DEFAULT_MCP_ACCESSIBILITY_CONFIG.maxTextChars,
    collapseThreshold:
      typeof record.collapseThreshold === "number" && record.collapseThreshold > 0
        ? Math.floor(record.collapseThreshold)
        : DEFAULT_MCP_ACCESSIBILITY_CONFIG.collapseThreshold,
    collapseKeepHead:
      typeof record.collapseKeepHead === "number" && record.collapseKeepHead >= 0
        ? Math.floor(record.collapseKeepHead)
        : DEFAULT_MCP_ACCESSIBILITY_CONFIG.collapseKeepHead,
    collapseKeepTail:
      typeof record.collapseKeepTail === "number" && record.collapseKeepTail >= 0
        ? Math.floor(record.collapseKeepTail)
        : DEFAULT_MCP_ACCESSIBILITY_CONFIG.collapseKeepTail,
    minLengthToProcess:
      typeof record.minLengthToProcess === "number" && record.minLengthToProcess > 0
        ? Math.floor(record.minLengthToProcess)
        : DEFAULT_MCP_ACCESSIBILITY_CONFIG.minLengthToProcess,
  };
}

export async function getMcpAccessibilityConfig(): Promise<McpAccessibilityConfig> {
  const db = getDbInstance();
  const row = (await db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, "mcpAccessibility")) as { value: string } | undefined;
  return normalizeMcpAccessibilityConfig(parseJsonSafe(row?.value ?? null));
}

export async function setMcpAccessibilityConfig(
  value: Partial<McpAccessibilityConfig>
): Promise<void> {
  const next = normalizeMcpAccessibilityConfig({ ...DEFAULT_MCP_ACCESSIBILITY_CONFIG, ...value });
  const db = getDbInstance();
  await db
    .prepare(
      "INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?) " +
        "ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value"
    )
    .run(NAMESPACE, "mcpAccessibility", JSON.stringify(next));
  compressionSettingsCache = null;
  invalidateDbCache();
}
