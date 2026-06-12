/**
 * Provider Registry — single source of truth for provider configuration.
 *
 * Trimmed to the GigaChat + openai-compatible (custom prefix) whitelist for the
 * fork (T8). The dynamic `openai-compatible-*` providers are registered at
 * runtime through `OPENAI_COMPATIBLE_PREFIX` — only the static `gigachat`
 * entry lives in this file. Any other historical provider entries (anthropic,
 * gemini, deepseek, openrouter, qwen, claude, …) have been removed.
 */

import type { ProviderRequestDefaults } from "../services/providerRequestDefaults.ts";

// ─── Types ─────────────────────────────────────────────────────────────

export interface RegistryModel {
  id: string;
  name: string;
  toolCalling?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  supportsXHighEffort?: boolean;
  maxOutputTokens?: number;
  targetFormat?: string;
  strip?: readonly string[];
  unsupportedParams?: readonly string[];
  /** Maximum context window in tokens */
  contextLength?: number;
}

export interface RegistryOAuth {
  clientIdEnv?: string;
  clientIdDefault?: string;
  clientSecretEnv?: string;
  clientSecretDefault?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  authUrl?: string;
  initiateUrl?: string;
  pollUrlBase?: string;
}

export interface RegistryEntry {
  id: string;
  alias?: string;
  format: string;
  executor: string;
  baseUrl?: string;
  baseUrls?: string[];
  /** Override base URL only for API key validation */
  testKeyBaseUrl?: string;
  responsesBaseUrl?: string;
  urlSuffix?: string;
  urlBuilder?: (base: string, model: string, stream: boolean) => string;
  authType: string;
  authHeader: string;
  authPrefix?: string;
  headers?: Record<string, string>;
  extraHeaders?: Record<string, string>;
  requestDefaults?: ProviderRequestDefaults;
  oauth?: RegistryOAuth;
  models: RegistryModel[];
  modelsUrl?: string;
  /** Prefix to prepend to model IDs before upstream API calls */
  modelIdPrefix?: string;
  chatPath?: string;
  clientVersion?: string;
  timeoutMs?: number;
  passthroughModels?: boolean;
  /** Default context window for all models in provider */
  defaultContextLength?: number;
}

interface LegacyProvider {
  format: string;
  baseUrl?: string;
  baseUrls?: string[];
  responsesBaseUrl?: string;
  headers?: Record<string, string>;
  requestDefaults?: ProviderRequestDefaults;
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  authUrl?: string;
  chatPath?: string;
  clientVersion?: string;
  timeoutMs?: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────

// ─── Registry ──────────────────────────────────────────────────────────

export const REGISTRY: Record<string, RegistryEntry> = {};

// ─── Generator Functions ───────────────────────────────────────────────

/** Generate legacy PROVIDERS object shape for constants.js backward compatibility. */
export function generateLegacyProviders(): Record<string, LegacyProvider> {
  const providers: Record<string, LegacyProvider> = {};
  for (const [id, entry] of Object.entries(REGISTRY)) {
    const p: LegacyProvider = { format: entry.format };
    if (entry.baseUrls) p.baseUrls = entry.baseUrls;
    else if (entry.baseUrl) p.baseUrl = entry.baseUrl;
    if (entry.responsesBaseUrl) p.responsesBaseUrl = entry.responsesBaseUrl;
    if (entry.requestDefaults) p.requestDefaults = entry.requestDefaults;
    if (typeof entry.timeoutMs === "number") p.timeoutMs = entry.timeoutMs;
    const mergedHeaders = {
      ...(entry.headers ?? {}),
      ...(entry.extraHeaders ?? {}),
    };
    if (Object.keys(mergedHeaders).length > 0) p.headers = mergedHeaders;
    if (entry.oauth) {
      if (entry.oauth.clientIdEnv) {
        p.clientId =
          process.env[entry.oauth.clientIdEnv] ?? entry.oauth.clientIdDefault;
      }
      if (entry.oauth.clientSecretEnv) {
        p.clientSecret =
          process.env[entry.oauth.clientSecretEnv] ??
          entry.oauth.clientSecretDefault;
      }
      if (entry.oauth.tokenUrl) p.tokenUrl = entry.oauth.tokenUrl;
      if (entry.oauth.refreshUrl) p.refreshUrl = entry.oauth.refreshUrl;
      if (entry.oauth.authUrl) p.authUrl = entry.oauth.authUrl;
    }
    if (entry.chatPath) p.chatPath = entry.chatPath;
    if (entry.clientVersion) p.clientVersion = entry.clientVersion;
    providers[id] = p;
  }
  return providers;
}

/** Generate PROVIDER_MODELS map (alias → model list). */
export function generateModels(): Record<string, RegistryModel[]> {
  const models: Record<string, RegistryModel[]> = {};
  for (const entry of Object.values(REGISTRY)) {
    if (entry.models && entry.models.length > 0) {
      const key = entry.alias ?? entry.id;
      if (!models[key]) models[key] = entry.models;
    }
  }
  return models;
}

/** Generate PROVIDER_ID_TO_ALIAS map. */
export function generateAliasMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of Object.values(REGISTRY)) {
    map[entry.id] = entry.alias ?? entry.id;
  }
  return map;
}

// ─── Local Provider Detection ──────────────────────────────────────────

const LOCAL_HOSTNAMES = new Set<string>([
  "localhost",
  "127.0.0.1",
  ...(typeof process !== "undefined" && process.env.LOCAL_HOSTNAMES
    ? process.env.LOCAL_HOSTNAMES.split(",")
        .map((h) => h.trim())
        .filter(Boolean)
    : []),
]);

/**
 * Detect whether a base URL points at a local inference backend.
 * Operators may extend `LOCAL_HOSTNAMES` via env (comma-separated).
 */
export function isLocalProvider(baseUrl?: string | null): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    const hostname = url.hostname;
    return (
      LOCAL_HOSTNAMES.has(hostname) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}

/** Set of provider IDs with passthroughModels enabled. */
const _passthroughProviderIds: Set<string> | null = (() => {
  try {
    const ids = new Set<string>();
    for (const entry of Object.values(REGISTRY)) {
      if (entry.passthroughModels) ids.add(entry.id);
    }
    return ids;
  } catch {
    return null;
  }
})();

export function getPassthroughProviders(): Set<string> {
  return _passthroughProviderIds ?? new Set<string>();
}

// ─── Registry Lookup Helpers ───────────────────────────────────────────

const _byAlias = new Map<string, RegistryEntry>();
for (const entry of Object.values(REGISTRY)) {
  if (entry.alias && entry.alias !== entry.id) {
    _byAlias.set(entry.alias, entry);
  }
}

/** Get registry entry by provider id or alias. */
export function getRegistryEntry(provider: string): RegistryEntry | null {
  return REGISTRY[provider] ?? _byAlias.get(provider) ?? null;
}

/** Get all registered provider IDs. */
export function getRegisteredProviders(): string[] {
  return Object.keys(REGISTRY);
}

// Precomputed model → unsupportedParams map for O(1) lookup.
const _unsupportedParamsMap = new Map<string, readonly string[]>();
for (const entry of Object.values(REGISTRY)) {
  for (const model of entry.models) {
    if (model.unsupportedParams && !_unsupportedParamsMap.has(model.id)) {
      _unsupportedParamsMap.set(model.id, model.unsupportedParams);
    }
  }
}

/**
 * Get unsupported parameters for a specific model.
 * Returns an empty array when no restrictions are defined.
 */
export function getUnsupportedParams(
  provider: string,
  modelId: string,
): readonly string[] {
  const entry = getRegistryEntry(provider);
  const modelEntry = entry?.models.find((m) => m.id === modelId);
  if (modelEntry?.unsupportedParams) return modelEntry.unsupportedParams;

  const cached = _unsupportedParamsMap.get(modelId);
  if (cached) return cached;

  if (modelId.includes("/")) {
    const bareId = modelId.split("/").pop() ?? "";
    const bare = _unsupportedParamsMap.get(bareId);
    if (bare) return bare;
  }
  return [];
}

/**
 * Get provider category: "oauth" or "apikey" so the resilience layer can
 * apply different cooldown/backoff profiles.
 */
export function getProviderCategory(provider: string): "oauth" | "apikey" {
  const entry = getRegistryEntry(provider);
  if (!entry) return "apikey";
  return entry.authType === "apikey" ? "apikey" : "oauth";
}

/**
 * Derive latest opus/sonnet/haiku model IDs from the `claude` registry entry.
 * The fork no longer ships a Claude provider, so this returns empty strings —
 * kept for compatibility with callers wired through the legacy registry API.
 */
export function getClaudeCodeDefaultModels(): {
  opus: string;
  sonnet: string;
  haiku: string;
} {
  const models = REGISTRY.claude?.models ?? [];
  const find = (pattern: RegExp) =>
    models.find((m) => pattern.test(m.id))?.id ?? "";
  return {
    opus: find(/opus/i),
    sonnet: find(/sonnet/i),
    haiku: find(/haiku/i),
  };
}
