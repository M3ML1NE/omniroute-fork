import { NextResponse } from "next/server";
import { isOpenAICompatibleProvider, isSelfHostedChatProvider } from "@/shared/constants/providers";
import { getRegistryEntry } from "@omniroute/open-sse/config/providerRegistry.ts";
import { getModelsByProviderId } from "@/shared/constants/models";
import { getStaticModelsForProvider, type LocalCatalogModel } from "@/lib/providers/staticModels";
import {
  getProviderConnectionById,
  buildModelHiddenChecker,
  resolveProxyForProvider,
} from "@/lib/localDb";
import {
  SAFE_OUTBOUND_FETCH_PRESETS,
  SafeOutboundFetchError,
  getSafeOutboundFetchErrorStatus,
  safeOutboundFetch,
} from "@/shared/network/safeOutboundFetch";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuard";
import { getMtlsDispatcher, resolveMtlsConfig } from "@omniroute/open-sse/services/mtlsAgent.ts";
import { getExecutor } from "@omniroute/open-sse/executors/index.ts";
import { MlproxyExecutor } from "@omniroute/open-sse/executors/mlproxy.ts";
import { proxyFetch } from "@omniroute/open-sse/utils/proxyFetch.ts";
import { getMlproxyDispatcher } from "@omniroute/open-sse/executors/mlproxyAgent.ts";
import { resolveMlproxyConfig } from "@omniroute/open-sse/executors/mlproxyConfig.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { getImageProvider } from "@omniroute/open-sse/config/imageRegistry.ts";
import { getVideoProvider } from "@omniroute/open-sse/config/videoRegistry.ts";
import { getEmbeddingProvider } from "@omniroute/open-sse/config/embeddingRegistry.ts";
import { getRerankProvider } from "@omniroute/open-sse/config/rerankRegistry.ts";
import {
  getSpeechProvider,
  getTranscriptionProvider,
} from "@omniroute/open-sse/config/audioRegistry.ts";
import {
  getCachedDiscoveredModels,
  isAutoFetchModelsEnabled,
  persistDiscoveredModels,
} from "@/lib/providerModels/modelDiscovery";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getProviderBaseUrl(providerSpecificData: unknown): string | null {
  const data = asRecord(providerSpecificData);
  const baseUrl = data.baseUrl;
  return typeof baseUrl === "string" && baseUrl.trim().length > 0 ? baseUrl : null;
}

function isLocalOpenAIStyleProvider(provider: string): boolean {
  return isSelfHostedChatProvider(provider);
}

const NAMED_OPENAI_STYLE_PROVIDERS = new Set(["modal", "reka", "empower", "nous-research", "poe"]);

function isNamedOpenAIStyleProvider(provider: string): boolean {
  return NAMED_OPENAI_STYLE_PROVIDERS.has(provider);
}

function mergeLocalCatalogModels<T extends LocalCatalogModel, U extends LocalCatalogModel>(
  registryCatalogModels: T[],
  specialtyCatalogModels: U[]
): Array<T | U> {
  if (registryCatalogModels.length === 0) return specialtyCatalogModels;

  const registryModelIds = new Set(registryCatalogModels.map((model) => model.id));
  return [
    ...registryCatalogModels,
    ...specialtyCatalogModels.filter((model) => !registryModelIds.has(model.id)),
  ];
}

function buildOptionalBearerHeaders(token: string | null | undefined): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function buildNamedOpenAiStyleHeaders(
  provider: string,
  token: string | null | undefined
): Record<string, string> {
  const headers = buildOptionalBearerHeaders(token);

  return headers;
}

function normalizeOpenAiLikeModelsResponse(
  data: unknown,
  fallbackOwner: string
): Array<{ id: string; name: string; owned_by: string }> {
  const payload = asRecord(data);
  const items = Array.isArray(data)
    ? data
    : Array.isArray(payload.data)
      ? (payload.data as unknown[])
      : Array.isArray(payload.models)
        ? (payload.models as unknown[])
        : [];

  return items
    .map((value) => {
      const item = asRecord(value);
      const id =
        toNonEmptyString(item.id) || toNonEmptyString(item.model) || toNonEmptyString(item.name);
      if (!id) return null;
      const name =
        toNonEmptyString(item.display_name) ||
        toNonEmptyString(item.displayName) ||
        toNonEmptyString(item.name) ||
        id;
      const ownedBy =
        toNonEmptyString(item.owned_by) || toNonEmptyString(item.provider) || fallbackOwner;
      return { id, name, owned_by: ownedBy };
    })
    .filter((value): value is { id: string; name: string; owned_by: string } => Boolean(value));
}

type ProviderModelsConfigEntry = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  authHeader?: string;
  authPrefix?: string;
  authQuery?: string;
  body?: unknown;
  parseResponse: (data: any) => any;
};

// Provider models endpoints configuration
const PROVIDER_MODELS_CONFIG: Record<string, ProviderModelsConfigEntry> = {};

/**
 * GET /api/providers/[id]/models - Get models list from provider
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const params = await context.params;
    const { id } = params;

    // Check if we should exclude hidden models (used by MCP tools to prevent hidden model leaks)
    const { searchParams } = new URL(request.url);
    const excludeHidden = searchParams.get("excludeHidden") === "true";
    const refresh = searchParams.get("refresh") === "true";

    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const provider =
      typeof connection.provider === "string" && connection.provider.trim().length > 0
        ? connection.provider
        : null;
    if (!provider) {
      return NextResponse.json({ error: "Invalid connection provider" }, { status: 400 });
    }

    // Resolve proxy for this provider (provider-level → global → direct)
    const proxy = await resolveProxyForProvider(provider);

    const isModelHidden = excludeHidden ? await buildModelHiddenChecker(provider) : null;

    const buildResponse = (payload: any, statusConfig?: ResponseInit) => {
      if (isModelHidden && payload.models && Array.isArray(payload.models)) {
        payload.models = payload.models.filter((m: any) => !isModelHidden(m.id));
      }
      return NextResponse.json(payload, statusConfig);
    };

    const connectionId = typeof connection.id === "string" ? connection.id : id;
    const apiKey = typeof connection.apiKey === "string" ? connection.apiKey : "";
    const accessToken = typeof connection.accessToken === "string" ? connection.accessToken : "";
    const autoFetchModels = isAutoFetchModelsEnabled(connection.providerSpecificData);
    const cachedDiscoveryModels = await getCachedDiscoveredModels(provider, connectionId);
    const registryCatalogModels = getModelsByProviderId(provider) || [];
    const specialtyCatalogModels = getStaticModelsForProvider(provider) || [];

    const toLocalCatalogModels = () => {
      const localCatalog = mergeLocalCatalogModels(registryCatalogModels, specialtyCatalogModels);
      return localCatalog.map((model) => ({
        id: model.id,
        name: model.name || model.id,
        ...((model as Record<string, unknown>).apiFormat
          ? { apiFormat: (model as Record<string, unknown>).apiFormat as string | undefined }
          : {}),
        ...((model as Record<string, unknown>).supportedEndpoints
          ? {
              supportedEndpoints: (model as Record<string, unknown>).supportedEndpoints as
                | string[]
                | undefined,
            }
          : {}),
        ...(registryCatalogModels.length > 0 ? { owned_by: provider } : {}),
      }));
    };

    const buildCachedDiscoveryResponse = (warning?: string) =>
      buildResponse({
        provider,
        connectionId,
        models: cachedDiscoveryModels,
        source: "cache",
        ...(warning ? { warning } : {}),
      });

    const buildLocalCatalogResponse = (warning?: string) => {
      const localModels = toLocalCatalogModels();
      if (localModels.length === 0) return null;
      return buildResponse({
        provider,
        connectionId,
        models: localModels,
        source: "local_catalog",
        ...(warning ? { warning } : {}),
      });
    };

    const buildDiscoveryFallbackResponse = ({
      cacheWarning = "API unavailable — using cached catalog",
      localWarning = "API unavailable — using local catalog",
    }: {
      cacheWarning?: string;
      localWarning?: string;
    } = {}) => {
      if (cachedDiscoveryModels.length > 0) {
        return buildCachedDiscoveryResponse(cacheWarning);
      }
      return buildLocalCatalogResponse(localWarning);
    };

    const buildDiscoveryErrorFallbackResponse = (
      error: unknown,
      warnings?: {
        cacheWarning?: string;
        localWarning?: string;
      }
    ) => {
      const status = getSafeOutboundFetchErrorStatus(error);
      if (status === 400 || status === 503 || status === 504) return null;
      return buildDiscoveryFallbackResponse(warnings);
    };

    const maybeReturnCachedDiscovery = () => {
      if (!refresh && cachedDiscoveryModels.length > 0) {
        return buildCachedDiscoveryResponse();
      }
      return null;
    };

    const maybeReturnAutoFetchDisabled = () => {
      if (refresh || autoFetchModels) return null;
      const fallback = buildDiscoveryFallbackResponse({
        cacheWarning: "Auto-fetch disabled — using cached catalog",
        localWarning: "Auto-fetch disabled — using local catalog",
      });
      if (fallback) return fallback;
      return buildResponse({
        provider,
        connectionId,
        models: [],
        source: "local_catalog",
        warning: "Auto-fetch disabled — no cached models available",
      });
    };

    const buildApiDiscoveryResponse = async (models: any[], warning?: string) => {
      const discoveredModels = await persistDiscoveredModels(provider, connectionId, models);
      if (discoveredModels.length > 0) {
        return buildResponse({
          provider,
          connectionId,
          models,
          source: "api",
          ...(warning ? { warning } : {}),
        });
      }

      const fallback = buildLocalCatalogResponse(
        "No remote models discovered — using local catalog"
      );
      if (fallback) return fallback;

      return buildResponse({
        provider,
        connectionId,
        models: [],
        source: "api",
      });
    };

    if (
      isOpenAICompatibleProvider(provider) ||
      isLocalOpenAIStyleProvider(provider) ||
      isNamedOpenAIStyleProvider(provider)
    ) {
      const cachedResponse = maybeReturnCachedDiscovery();
      if (cachedResponse) return cachedResponse;

      const autoFetchDisabledResponse = maybeReturnAutoFetchDisabled();
      if (autoFetchDisabledResponse) return autoFetchDisabledResponse;

      const registryEntry =
        isLocalOpenAIStyleProvider(provider) || isNamedOpenAIStyleProvider(provider)
          ? getRegistryEntry(provider)
          : null;
      const rawBaseUrl =
        getProviderBaseUrl(connection.providerSpecificData) ||
        (typeof registryEntry?.baseUrl === "string" ? registryEntry.baseUrl : null);
      const baseUrl = rawBaseUrl;
      if (!baseUrl) {
        const fallback = buildDiscoveryFallbackResponse({
          cacheWarning: "Base URL unavailable — using cached catalog",
          localWarning: "Base URL unavailable — using local catalog",
        });
        if (fallback) return fallback;
        return NextResponse.json(
          {
            error: isOpenAICompatibleProvider(provider)
              ? "No base URL configured for OpenAI compatible provider"
              : isLocalOpenAIStyleProvider(provider)
                ? "No base URL configured for local provider"
                : "No base URL configured for provider",
          },
          { status: 400 }
        );
      }

      let base = baseUrl.replace(/\/$/, "");
      if (base.endsWith("/chat/completions")) {
        base = base.slice(0, -17);
      } else if (base.endsWith("/completions")) {
        base = base.slice(0, -12);
      } else if (base.endsWith("/v1")) {
        base = base.slice(0, -3);
      }

      // T39: Try multiple endpoint formats
      const endpoints = [
        `${base}/v1/models`,
        `${base}/models`,
        `${baseUrl.replace(/\/$/, "")}/models`, // Original fallback
      ];

      // Remove duplicates
      const uniqueEndpoints = [...new Set(endpoints)];
      let models = null;
      let lastErrorStatus = null;
      const mtlsCfg = resolveMtlsConfig(asRecord(connection.providerSpecificData).mtls);
      const token = mtlsCfg ? null : apiKey || accessToken;

      for (const modelsUrl of uniqueEndpoints) {
        try {
          const response = await safeOutboundFetch(modelsUrl, {
            ...SAFE_OUTBOUND_FETCH_PRESETS.modelsProbe,
            guard: getProviderOutboundGuard(),
            proxyConfig: proxy,
            method: "GET",
            headers: isNamedOpenAIStyleProvider(provider)
              ? buildNamedOpenAiStyleHeaders(provider, token)
              : buildOptionalBearerHeaders(token),
            ...(mtlsCfg ? { dispatcher: getMtlsDispatcher(mtlsCfg) } : {}),
          } as RequestInit);

          if (response.ok) {
            const data = await response.json();
            models = isNamedOpenAIStyleProvider(provider)
              ? normalizeOpenAiLikeModelsResponse(data, provider)
              : data.data || data.models || [];
            break; // Success!
          }

          if (response.status === 401 || response.status === 403) {
            lastErrorStatus = response.status;
            throw new Error("auth_failed");
          }
        } catch (err: any) {
          if (err.message === "auth_failed") break; // Don't try other endpoints if auth failed
          const status = getSafeOutboundFetchErrorStatus(err);
          if (status) {
            throw err;
          }
        }
      }

      // If all endpoints failed (but not because of auth), fallback to local catalog
      if (!models) {
        const fallback = buildDiscoveryFallbackResponse({
          cacheWarning:
            lastErrorStatus === 401 || lastErrorStatus === 403
              ? `Auth failed (${lastErrorStatus}) — using cached catalog`
              : "API unavailable — using cached catalog",
          localWarning:
            lastErrorStatus === 401 || lastErrorStatus === 403
              ? `Auth failed (${lastErrorStatus}) — using local catalog`
              : "API unavailable — using local catalog",
        });
        if (fallback) return fallback;

        if (lastErrorStatus === 401 || lastErrorStatus === 403) {
          return NextResponse.json(
            { error: `Auth failed: ${lastErrorStatus}` },
            { status: lastErrorStatus }
          );
        }

        console.warn(`[models] All endpoints failed for ${provider}, using local catalog`);
        models = toLocalCatalogModels();
        return buildResponse({
          provider,
          connectionId,
          models,
          source: "local_catalog",
          warning: "API unavailable — using local catalog",
        });
      }
      return buildApiDiscoveryResponse(models);
    }

    if (isOpenAICompatibleProvider(provider)) {
      const cachedResponse = maybeReturnCachedDiscovery();
      if (cachedResponse) return cachedResponse;

      const autoFetchDisabledResponse = maybeReturnAutoFetchDisabled();
      if (autoFetchDisabledResponse) return autoFetchDisabledResponse;

      let baseUrl = getProviderBaseUrl(connection.providerSpecificData);
      if (!baseUrl) {
        const fallback = buildDiscoveryFallbackResponse({
          cacheWarning: "Base URL unavailable — using cached catalog",
          localWarning: "Base URL unavailable — using local catalog",
        });
        if (fallback) return fallback;
        return NextResponse.json(
          { error: "No base URL configured for OpenAI compatible provider" },
          { status: 400 }
        );
      }

      baseUrl = baseUrl.replace(/\/$/, "");

      // Use modelsPath from provider node if available, otherwise default to /models
      const psd = asRecord(connection.providerSpecificData);
      const modelsPath = toNonEmptyString(psd.modelsPath) || "/models";
      const url = `${baseUrl}${modelsPath}`;
      const mtlsCfg = resolveMtlsConfig(psd.mtls);
      const token = mtlsCfg ? null : accessToken || apiKey;
      let response: Response;
      try {
        response = await safeOutboundFetch(url, {
          ...SAFE_OUTBOUND_FETCH_PRESETS.modelsDiscovery,
          guard: getProviderOutboundGuard(),
          proxyConfig: proxy,
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            ...(!mtlsCfg && apiKey ? { "x-api-key": apiKey } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(mtlsCfg ? { dispatcher: getMtlsDispatcher(mtlsCfg) } : {}),
        } as RequestInit);
      } catch (error) {
        const fallback = buildDiscoveryErrorFallbackResponse(error);
        if (fallback) return fallback;
        throw error;
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.log("Error fetching models from provider", { provider, errorText });
        const fallback = buildDiscoveryFallbackResponse();
        if (fallback) return fallback;
        return NextResponse.json(
          { error: `Failed to fetch models: ${response.status}` },
          { status: response.status }
        );
      }

      const data = await response.json();
      const models = data.data || data.models || [];

      return buildApiDiscoveryResponse(models);
    }

    // ── MLProxy — cookie‑based auth with executor‑driven URL ─────────────
    if (provider === "mlproxy") {
      const cachedResponse = maybeReturnCachedDiscovery();
      if (cachedResponse) return cachedResponse;

      const autoFetchDisabledResponse = maybeReturnAutoFetchDisabled();
      if (autoFetchDisabledResponse) return autoFetchDisabledResponse;

      const executor = getExecutor("mlproxy") as MlproxyExecutor;
      const creds = {
        accessToken: accessToken || undefined,
        providerSpecificData: asRecord(connection.providerSpecificData),
        connectionId,
      };

      let modelsUrl: string;
      try {
        modelsUrl = executor.modelsUrl(creds);
      } catch (err) {
        const fallback = buildDiscoveryFallbackResponse({
          cacheWarning: "Invalid MLProxy config — using cached catalog",
          localWarning: "Invalid MLProxy config — using local catalog",
        });
        if (fallback) return fallback;
        return NextResponse.json(
          {
            error: sanitizeErrorMessage(
              err instanceof Error ? err.message : "Invalid MLProxy configuration"
            ),
          },
          { status: 400 }
        );
      }

      const headers = executor.buildHeaders(creds, false);
      const cfg = resolveMlproxyConfig(connection.providerSpecificData);
      const dispatcher = getMlproxyDispatcher({
        caPath: cfg?.caPath,
        tlsInsecure: cfg?.tlsInsecure,
      });

      let response: Response;
      try {
        response = await proxyFetch(modelsUrl, {
          method: "GET",
          headers,
          dispatcher,
        } as RequestInit & { dispatcher?: unknown });
      } catch (error) {
        const fallback = buildDiscoveryErrorFallbackResponse(error);
        if (fallback) return fallback;
        return NextResponse.json(
          {
            error: sanitizeErrorMessage(
              error instanceof Error ? error.message : "Failed to fetch MLProxy models"
            ),
          },
          { status: 500 }
        );
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.log("Error fetching MLProxy models from provider", {
          provider,
          status: response.status,
          errorText: errorText.slice(0, 200),
        });
        const fallback = buildDiscoveryFallbackResponse({
          cacheWarning: `MLProxy API error (${response.status}) — using cached catalog`,
          localWarning: `MLProxy API error (${response.status}) — using local catalog`,
        });
        if (fallback) return fallback;
        return NextResponse.json(
          { error: `Failed to fetch MLProxy models: ${response.status}` },
          { status: response.status >= 500 ? 502 : response.status }
        );
      }

      const data = await response.json();
      const models = data.data || data.models || [];
      return buildApiDiscoveryResponse(models);
    }

    const config =
      provider in PROVIDER_MODELS_CONFIG
        ? PROVIDER_MODELS_CONFIG[provider as keyof typeof PROVIDER_MODELS_CONFIG]
        : undefined;

    const localCatalog = mergeLocalCatalogModels(registryCatalogModels, specialtyCatalogModels);
    if (!config && localCatalog.length > 0) {
      return buildResponse({
        provider,
        connectionId,
        models: localCatalog.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          ...((m as Record<string, unknown>).apiFormat
            ? { apiFormat: (m as Record<string, unknown>).apiFormat as string | undefined }
            : {}),
          ...((m as Record<string, unknown>).supportedEndpoints
            ? {
                supportedEndpoints: (m as Record<string, unknown>).supportedEndpoints as
                  | string[]
                  | undefined,
              }
            : {}),
          ...(registryCatalogModels.length > 0 ? { owned_by: provider } : {}),
        })),
        source: "local_catalog",
        warning: "API unavailable — using local catalog",
      });
    }
    if (!config) {
      return NextResponse.json(
        { error: `Provider ${provider} does not support models listing` },
        { status: 400 }
      );
    }

    const cachedResponse = maybeReturnCachedDiscovery();
    if (cachedResponse) return cachedResponse;

    const autoFetchDisabledResponse = maybeReturnAutoFetchDisabled();
    if (autoFetchDisabledResponse) return autoFetchDisabledResponse;

    // Get auth token
    const token = accessToken || apiKey;
    if (!token) {
      const fallback = buildDiscoveryFallbackResponse({
        cacheWarning: "No token configured — using cached catalog",
        localWarning: "No token configured — using local catalog",
      });
      if (fallback) return fallback;
      return NextResponse.json(
        {
          error:
            "No API key configured for this provider. Please add an API key in the provider settings.",
        },
        { status: 400 }
      );
    }

    // Build request URL
    let url = config.url;
    if (config.authQuery) {
      url += `${url.includes("?") ? "&" : "?"}${config.authQuery}=${token}`;
    }

    // Build headers
    const headers = { ...config.headers };
    if (config.authHeader && !config.authQuery) {
      headers[config.authHeader] = (config.authPrefix || "") + token;
    }

    // Make request (with pagination for providers that use nextPageToken, e.g. Gemini)
    const fetchOptions: any = {
      method: config.method,
      headers,
    };

    if (config.body && config.method === "POST") {
      fetchOptions.body = JSON.stringify(config.body);
    }

    let allModels: any[] = [];
    let pageUrl = url;
    let pageCount = 0;
    const MAX_PAGES = 20; // Safety limit
    const seenTokens = new Set<string>();

    while (pageUrl && pageCount < MAX_PAGES) {
      pageCount++;
      let response: Response;
      try {
        response = await safeOutboundFetch(pageUrl, {
          ...SAFE_OUTBOUND_FETCH_PRESETS.modelsPagination,
          guard: getProviderOutboundGuard(),
          proxyConfig: proxy,
          // Ollama Cloud /v1/models returns 301 redirects (#1381)
          ...(provider === "ollama-cloud" ? { allowRedirect: true } : {}),
          ...fetchOptions,
        });
      } catch (error) {
        const fallback = buildDiscoveryErrorFallbackResponse(error);
        if (fallback) return fallback;
        throw error;
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.log("Error fetching models from provider", { provider, errorText });
        const fallback = buildDiscoveryFallbackResponse();
        if (fallback) return fallback;
        return NextResponse.json(
          { error: `Failed to fetch models: ${response.status}` },
          { status: response.status }
        );
      }

      const data = await response.json();
      const pageModels = config.parseResponse(data);
      allModels = allModels.concat(pageModels);

      const nextPageToken = data.nextPageToken;
      if (!nextPageToken) break;
      if (seenTokens.has(nextPageToken)) {
        console.warn(`[models] ${provider}: duplicate nextPageToken detected, stopping pagination`);
        break;
      }
      seenTokens.add(nextPageToken);
      pageUrl = `${config.url}${config.url.includes("?") ? "&" : "?"}pageToken=${encodeURIComponent(nextPageToken)}`;
      if (config.authQuery) {
        pageUrl += `&${config.authQuery}=${token}`;
      }
    }

    if (pageCount > 1) {
      console.log(
        `[models] ${provider}: fetched ${allModels.length} models across ${pageCount} pages`
      );
    }

    return buildApiDiscoveryResponse(allModels);
  } catch (error) {
    if (error instanceof SafeOutboundFetchError && error.code === "URL_GUARD_BLOCKED") {
      return NextResponse.json({ error: sanitizeErrorMessage(error.message) }, { status: 400 });
    }

    const status = getSafeOutboundFetchErrorStatus(error);
    if (status) {
      const message = error instanceof Error ? error.message : "Failed to fetch models";
      return NextResponse.json({ error: message }, { status });
    }
    console.log("Error fetching provider models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}
