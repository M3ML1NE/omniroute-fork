type JsonRecord = Record<string, unknown>;

export type GlmApiRegion = "international" | "china";
export type GlmTransport = "openai";

export const GLM_DEFAULT_BASE_URLS = Object.freeze({
  international: "https://api.z.ai/api/coding/paas/v4/chat/completions",
  china: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
});

export const GLM_SHARED_MODELS = Object.freeze([
  {
    id: "glm-5.1",
    name: "GLM 5.1",
    contextLength: 204800,
    maxOutputTokens: 131072,
    toolCalling: true,
    supportsReasoning: true,
  },
  {
    id: "glm-5",
    name: "GLM 5",
    contextLength: 200000,
    maxOutputTokens: 131072,
    toolCalling: true,
    supportsReasoning: true,
  },
  {
    id: "glm-5-turbo",
    name: "GLM 5 Turbo",
    contextLength: 200000,
    maxOutputTokens: 131072,
    toolCalling: true,
    supportsReasoning: true,
  },
  {
    id: "glm-4.7-flash",
    name: "GLM 4.7 Flash",
    contextLength: 200000,
    maxOutputTokens: 131072,
    toolCalling: true,
    supportsReasoning: true,
  },
  {
    id: "glm-4.7",
    name: "GLM 4.7",
    contextLength: 200000,
    maxOutputTokens: 131072,
    toolCalling: true,
    supportsReasoning: true,
  },
  {
    id: "glm-4.6v",
    name: "GLM 4.6V (Vision)",
    contextLength: 128000,
    maxOutputTokens: 32768,
    toolCalling: true,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "glm-4.6",
    name: "GLM 4.6",
    contextLength: 200000,
    maxOutputTokens: 32768,
    toolCalling: true,
    supportsReasoning: true,
  },
  {
    id: "glm-4.5v",
    name: "GLM 4.5V (Vision)",
    contextLength: 16000,
    maxOutputTokens: 32768,
    toolCalling: true,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "glm-4.5",
    name: "GLM 4.5",
    contextLength: 128000,
    maxOutputTokens: 32768,
    toolCalling: true,
    supportsReasoning: true,
  },
  {
    id: "glm-4.5-air",
    name: "GLM 4.5 Air",
    contextLength: 128000,
    maxOutputTokens: 32768,
    toolCalling: true,
    supportsReasoning: true,
  },
]);

export const GLM_MODELS_URLS = Object.freeze({
  international: "https://api.z.ai/api/coding/paas/v4/models",
  china: "https://open.bigmodel.cn/api/coding/paas/v4/models",
});

export const GLM_QUOTA_URLS = Object.freeze({
  international: "https://api.z.ai/api/monitor/usage/quota/limit",
  china: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
});

export const GLMT_TIMEOUT_MS = 900_000;

export const GLM_TIMEOUT_MS = 900_000;

export const GLM_REQUEST_DEFAULTS = Object.freeze({
  maxTokens: 16_384,
});

export const GLMT_REQUEST_DEFAULTS = Object.freeze({
  maxTokens: 65_536,
  temperature: 0.2,
  thinkingBudgetTokens: 24_576,
  thinkingType: "adaptive" as const,
});

export const GLM_COUNT_TOKENS_TIMEOUT_MS = 3_000;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function splitUrlQueryAndHash(url: string): { base: string; suffix: string } {
  const idx = url.search(/[?#]/);
  if (idx === -1) return { base: url, suffix: "" };
  return { base: url.substring(0, idx), suffix: url.substring(idx) };
}

export function getGlmApiRegion(providerSpecificData: unknown): GlmApiRegion {
  const data = asRecord(providerSpecificData);
  return data.apiRegion === "china" ? "china" : "international";
}

export function buildGlmModelsUrl(
  providerSpecificData: unknown,
  _transport: GlmTransport = "openai",
  fallbackBaseUrl?: string | null
): string {
  const data = asRecord(providerSpecificData);
  const customModelsUrl = asString(data.modelsUrl);
  if (customModelsUrl) return customModelsUrl;

  const configuredBaseUrl = asString(data.baseUrl);
  if (configuredBaseUrl) {
    return joinGlmBaseAndPath(configuredBaseUrl, "/models");
  }
  return GLM_MODELS_URLS[getGlmApiRegion(providerSpecificData)];
}

export function getGlmQuotaUrl(providerSpecificData: unknown): string {
  return GLM_QUOTA_URLS[getGlmApiRegion(providerSpecificData)];
}

function stripKnownGlmEndpointSuffix(baseUrl: string): { base: string; suffix: string } {
  const parts = splitUrlQueryAndHash(baseUrl);
  let base = parts.base;
  while (base.endsWith("/")) {
    base = base.slice(0, -1);
  }

  if (base.toLowerCase().endsWith("/chat/completions")) {
    base = base.substring(0, base.length - "/chat/completions".length);
  } else if (base.toLowerCase().endsWith("/models")) {
    base = base.substring(0, base.length - "/models".length);
  }
  return { base, suffix: parts.suffix };
}

function joinGlmBaseAndPath(baseUrl: string, path: string): string {
  const { base, suffix } = stripKnownGlmEndpointSuffix(baseUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const versionMatch = base.match(/\/v\d+$/i);
  if (
    versionMatch &&
    normalizedPath.toLowerCase().startsWith(`${versionMatch[0].toLowerCase()}/`)
  ) {
    return `${base}${normalizedPath.slice(versionMatch[0].length)}${suffix}`;
  }
  return `${base}${normalizedPath}${suffix}`;
}

function stripQueryAndTrailingSlash(baseUrl: string): string {
  let base = splitUrlQueryAndHash(baseUrl).base;
  while (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  return base;
}

export function isCodingGlmBaseUrl(baseUrl: string): boolean {
  const base = stripQueryAndTrailingSlash(baseUrl).toLowerCase();
  const idx = base.indexOf("/api/coding/paas/v");
  if (idx === -1) return false;
  const afterV = base.charCodeAt(idx + "/api/coding/paas/v".length);
  return afterV >= 48 && afterV <= 57; // first char after 'v' must be a digit
}

export function getGlmBaseUrl(
  providerSpecificData: unknown,
  fallbackBaseUrl?: string | null
): string {
  const data = asRecord(providerSpecificData);
  const configuredBaseUrl = asString(data.baseUrl);
  if (configuredBaseUrl) return configuredBaseUrl;
  const regionalBaseUrl =
    typeof fallbackBaseUrl === "string" &&
    fallbackBaseUrl.trim() &&
    isCodingGlmBaseUrl(fallbackBaseUrl)
      ? fallbackBaseUrl.trim()
      : GLM_DEFAULT_BASE_URLS[getGlmApiRegion(providerSpecificData)];
  if (regionalBaseUrl) return regionalBaseUrl;
  return typeof fallbackBaseUrl === "string" && fallbackBaseUrl.trim()
    ? fallbackBaseUrl.trim()
    : GLM_DEFAULT_BASE_URLS.international;
}

export function getGlmPrimaryTransport(
  _providerSpecificData: unknown,
  _fallbackBaseUrl?: string | null
): GlmTransport {
  return "openai";
}

export function getGlmTransport(providerSpecificData: unknown, fallbackBaseUrl?: string | null) {
  return getGlmPrimaryTransport(providerSpecificData, fallbackBaseUrl);
}

export function buildGlmChatUrl(
  providerSpecificData: unknown,
  _transport: GlmTransport = "openai",
  fallbackBaseUrl?: string | null
): string {
  return buildGlmOpenAIChatUrl(providerSpecificData, fallbackBaseUrl);
}

export function buildGlmOpenAIChatUrl(
  providerSpecificData: unknown,
  fallbackBaseUrl?: string | null
): string {
  const configuredBaseUrl = getGlmBaseUrl(providerSpecificData, fallbackBaseUrl);
  return joinGlmBaseAndPath(configuredBaseUrl, "/chat/completions");
}

export function buildGlmCodingHeaders(apiKey: string, stream = true): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}
