import { NextResponse } from "next/server";
import { isOpenAICompatibleProvider } from "@/shared/constants/providers";
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
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import {
  getCachedDiscoveredModels,
  persistDiscoveredModels,
} from "@/lib/providerModels/modelDiscovery";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function getProviderBaseUrl(providerSpecificData: unknown): string | null {
  const data = asRecord(providerSpecificData);
  const baseUrl = data.baseUrl;
  return typeof baseUrl === "string" && baseUrl.trim().length > 0 ? baseUrl : null;
}

function buildOptionalBearerHeaders(token: string | null | undefined): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * GET /api/providers/[id]/models - Get models list from provider
 *
 * Sole-source, single-endpoint, always-live discovery: every compatible
 * connection is probed at exactly `${baseUrl}/v1/models`. There is no static
 * catalog, no multi-endpoint probe, no `modelsPath` override, and no
 * auto-fetch toggle. A fresh connection-scoped cache is the only non-live
 * path; on live-fetch failure the last-known cache is returned as
 * `cache-stale`, or an empty `none` response when no cache exists.
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
    const cachedDiscoveryModels = await getCachedDiscoveredModels(provider, connectionId);

    const buildCachedDiscoveryResponse = (source: "cache" | "cache-stale", warning?: string) =>
      buildResponse({
        provider,
        connectionId,
        models: cachedDiscoveryModels,
        source,
        ...(warning ? { warning } : {}),
      });

    // The only non-live-fetch path: a fresh cache satisfies a non-refresh request.
    const maybeReturnCachedDiscovery = () => {
      if (!refresh && cachedDiscoveryModels.length > 0) {
        return buildCachedDiscoveryResponse("cache");
      }
      return null;
    };

    if (isOpenAICompatibleProvider(provider)) {
      const cachedResponse = maybeReturnCachedDiscovery();
      if (cachedResponse) return cachedResponse;

      const baseUrl = getProviderBaseUrl(connection.providerSpecificData);
      if (!baseUrl) {
        if (cachedDiscoveryModels.length > 0) {
          return buildCachedDiscoveryResponse(
            "cache-stale",
            "Live discovery failed — showing last-known models"
          );
        }
        return buildResponse({
          provider,
          connectionId,
          models: [],
          source: "none",
          warning: "No base URL configured for OpenAI compatible provider",
        });
      }

      // GigaChat v2 lists models at `${normalizedBase}/models` (relative to the
      // /v2 base); everything else is discovered at `${base}/v1/models`.
      const isGigaChatV2 = asRecord(connection.providerSpecificData).apiVersion === "v2";
      let base = baseUrl.replace(/\/$/, "");
      let modelsUrl: string;
      if (isGigaChatV2) {
        base = base.replace(/\/chat\/completions$/, "");
        modelsUrl = `${base}/models`;
      } else {
        if (base.endsWith("/chat/completions")) {
          base = base.slice(0, -17);
        } else if (base.endsWith("/completions")) {
          base = base.slice(0, -12);
        } else if (base.endsWith("/v1")) {
          base = base.slice(0, -3);
        }
        modelsUrl = `${base}/v1/models`;
      }

      const mtlsCfg = resolveMtlsConfig(asRecord(connection.providerSpecificData).mtls);
      const token = mtlsCfg ? null : apiKey || accessToken;

      let models: any[] | null = null;
      try {
        const response = await safeOutboundFetch(modelsUrl, {
          ...SAFE_OUTBOUND_FETCH_PRESETS.modelsProbe,
          guard: await getProviderOutboundGuard(),
          proxyConfig: proxy,
          method: "GET",
          headers: buildOptionalBearerHeaders(token),
          ...(mtlsCfg ? { dispatcher: getMtlsDispatcher(mtlsCfg) } : {}),
        } as RequestInit);

        if (response.status === 401 || response.status === 403) {
          // Auth failures always surface the matching HTTP status, regardless of cache.
          return NextResponse.json(
            { error: `Auth failed: ${response.status}` },
            { status: response.status }
          );
        }

        if (response.ok) {
          const data = await response.json();
          models = data.data || data.models || [];
        }
      } catch (err) {
        const status = getSafeOutboundFetchErrorStatus(err);
        if (status === 401 || status === 403) {
          return NextResponse.json({ error: `Auth failed: ${status}` }, { status });
        }
        if (err instanceof SafeOutboundFetchError && err.code === "URL_GUARD_BLOCKED") {
          throw err;
        }
        // Network error / non-2xx handled below via the cache-stale/none contract.
      }

      // Empty body (non-array or zero-length) is treated as a failed discovery.
      if (!models || models.length === 0) {
        if (cachedDiscoveryModels.length > 0) {
          return buildCachedDiscoveryResponse(
            "cache-stale",
            "Live discovery failed — showing last-known models"
          );
        }
        return buildResponse({
          provider,
          connectionId,
          models: [],
          source: "none",
          warning: "Live discovery failed — no models returned by provider",
        });
      }

      await persistDiscoveredModels(provider, connectionId, models);
      return buildResponse({
        provider,
        connectionId,
        models,
        source: "api",
      });
    }

    return NextResponse.json(
      { error: `Provider ${provider} does not support models listing` },
      { status: 400 }
    );
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
