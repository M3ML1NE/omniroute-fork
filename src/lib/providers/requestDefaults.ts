type JsonRecord = Record<string, unknown>;

import { normalizeExcludedModelPatterns } from "@/domain/connectionModelRules";
import { normalizeRoutingTags } from "@/domain/tagRouter";

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

const BEDROCK_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/i;

function normalizeAwsRegion(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized || !BEDROCK_REGION_PATTERN.test(normalized)) return undefined;
  return normalized;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeRequestDefaults(
  provider: string | null | undefined,
  value: unknown
): JsonRecord | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;

  const normalized: JsonRecord = { ...record };

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeProviderSpecificData(
  provider: string | null | undefined,
  value: unknown
): JsonRecord | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;

  const normalized: JsonRecord = { ...record };

  if ("requestDefaults" in normalized) {
    const requestDefaults = normalizeRequestDefaults(provider, normalized.requestDefaults);
    if (requestDefaults) {
      normalized.requestDefaults = requestDefaults;
    } else {
      delete normalized.requestDefaults;
    }
  }

  if ("openaiStoreEnabled" in normalized && typeof normalized.openaiStoreEnabled !== "boolean") {
    delete normalized.openaiStoreEnabled;
  }

  if ("blockExtraUsage" in normalized && typeof normalized.blockExtraUsage !== "boolean") {
    delete normalized.blockExtraUsage;
  }

  if ("autoFetchModels" in normalized && typeof normalized.autoFetchModels !== "boolean") {
    delete normalized.autoFetchModels;
  }

  if (provider === "bedrock" && "region" in normalized) {
    const region = normalizeAwsRegion(normalized.region);
    if (region) {
      normalized.region = region;
    } else {
      delete normalized.region;
    }
  }

  if ("tag" in normalized) {
    if (typeof normalized.tag === "string") {
      const trimmedTag = normalized.tag.trim();
      if (trimmedTag) {
        normalized.tag = trimmedTag;
      } else {
        delete normalized.tag;
      }
    } else {
      delete normalized.tag;
    }
  }

  if ("tags" in normalized) {
    const tags = normalizeRoutingTags(normalized.tags);
    if (tags.length > 0) {
      normalized.tags = tags;
    } else {
      delete normalized.tags;
    }
  }

  if ("excludedModels" in normalized || "excluded_models" in normalized) {
    const excludedModels = normalizeExcludedModelPatterns(
      normalized.excludedModels ?? normalized.excluded_models
    );
    if (excludedModels.length > 0) {
      normalized.excludedModels = excludedModels;
    } else {
      delete normalized.excludedModels;
    }
    delete normalized.excluded_models;
  }

  if ("mtls" in normalized) {
    const mtls = normalizeMtlsPaths(normalized.mtls);
    if (mtls) {
      normalized.mtls = mtls;
    } else {
      delete normalized.mtls;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeMtlsPaths(value: unknown): JsonRecord | undefined {
  const record = asRecord(value);
  const cert = typeof record.cert_path === "string" ? record.cert_path.trim() : "";
  const key = typeof record.key_path === "string" ? record.key_path.trim() : "";
  const ca = typeof record.ca_path === "string" ? record.ca_path.trim() : "";
  if (!cert || !key || !ca) return undefined;
  return { cert_path: cert, key_path: key, ca_path: ca };
}

export function sanitizeProviderSpecificDataForResponse(value: unknown): JsonRecord | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;

  const sanitized: JsonRecord = { ...record };
  delete sanitized.consoleApiKey;
  delete sanitized.secretAccessKey;
  delete sanitized.awsSecretAccessKey;
  delete sanitized.sessionToken;
  delete sanitized.awsSessionToken;
  return sanitized;
}

export function isOpenAIResponsesStoreEnabled(providerSpecificData: unknown): boolean {
  return asRecord(providerSpecificData).openaiStoreEnabled === true;
}

export function buildOpenAIStoreSessionId(sessionId: unknown): string | undefined {
  if (!hasNonEmptyString(sessionId)) return undefined;

  const normalized = String(sessionId)
    .trim()
    .replace(/^ext:/i, "")
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);

  if (!normalized) return undefined;
  return `omniroute-session-${normalized}`;
}

export function ensureOpenAIStoreSessionFallback(
  body: Record<string, unknown>,
  sessionId: unknown
): Record<string, unknown> {
  const explicitSessionId = body.session_id;
  const explicitConversationId = body.conversation_id;
  const promptCacheKey = body.prompt_cache_key ?? body.promptCacheKey;

  if (
    hasNonEmptyString(explicitSessionId) ||
    hasNonEmptyString(explicitConversationId) ||
    hasNonEmptyString(promptCacheKey)
  ) {
    return body;
  }

  const fallbackSessionId = buildOpenAIStoreSessionId(sessionId);
  if (!fallbackSessionId) return body;

  return {
    ...body,
    session_id: fallbackSessionId,
  };
}

export function getProviderRequestDefaults(
  provider: string | null | undefined,
  providerSpecificData: unknown
): JsonRecord {
  return normalizeRequestDefaults(provider, asRecord(providerSpecificData).requestDefaults) || {};
}
