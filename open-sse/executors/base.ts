import { HTTP_STATUS, FETCH_TIMEOUT_MS } from "../config/constants.ts";
import { supportsXHighEffort } from "../config/providerModels.ts";
import { resolveKeyForRequest } from "../services/apiKeyRotator.ts";
import type { KeyHealth } from "../services/apiKeyRotator.ts";
import { getOpenAICompatibleType } from "../services/provider.ts";
import {
  runWithOnPersist,
  getRefreshLeadMs,
  isUnrecoverableRefreshError,
} from "../services/tokenRefresh.ts";
import type { ProviderRequestDefaults } from "../services/providerRequestDefaults.ts";
import { sanitizeResponsesInputItems } from "../services/responsesInputSanitizer.ts";
import { getMtlsDispatcher, resolveMtlsConfig } from "../services/mtlsAgent.ts";
import { proxyFetch } from "../utils/proxyFetch.ts";

/**
 * Sanitizes a custom API path to prevent path traversal attacks.
 * Valid paths must start with '/', contain no '..' segments,
 * no null bytes, and be reasonable in length.
 */
function sanitizePath(path: string): boolean {
  if (typeof path !== "string") return false;
  if (!path.startsWith("/")) return false;
  if (path.includes("\0")) return false; // null byte
  if (path.includes("..")) return false; // path traversal
  if (path.length > 512) return false; // sanity limit
  return true;
}

type JsonRecord = Record<string, unknown>;

export type ProviderConfig = {
  id?: string;
  baseUrl?: string;
  baseUrls?: string[];
  responsesBaseUrl?: string;
  chatPath?: string;
  clientVersion?: string;
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  authUrl?: string;
  headers?: Record<string, string>;
  requestDefaults?: ProviderRequestDefaults;
  timeoutMs?: number;
  format?: string;
};

export type ProviderCredentials = {
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  projectId?: string | null;
  expiresAt?: string;
  expiresIn?: number;
  connectionId?: string; // T07: used for API key rotation index
  maxConcurrent?: number | null;
  providerSpecificData?: JsonRecord;
  requestEndpointPath?: string;
};

export type ExecutorLog = {
  debug?: (tag: string, message: string) => void;
  info?: (tag: string, message: string) => void;
  warn?: (tag: string, message: string) => void;
  error?: (tag: string, message: string) => void;
};

export type ExecuteInput = {
  model: string;
  body: unknown;
  stream: boolean;
  credentials: ProviderCredentials;
  signal?: AbortSignal | null;
  log?: ExecutorLog | null;
  extendedContext?: boolean;
  /** Merged after auth + CLI fingerprint headers (values override same-named defaults). */
  upstreamExtraHeaders?: Record<string, string> | null;
  /** Original client request headers (read-only). Executors may forward select headers upstream. */
  clientHeaders?: Record<string, string> | null;
  /** Callback to persist tokens that are proactively refreshed during execution.
   * Accepts a partial credentials patch (e.g. `{ accessToken, refreshToken }` or
   * `{ testStatus: "expired", isActive: false }`); the caller merges into the
   * stored connection row. */
  onCredentialsRefreshed?: (
    newCredentials: Partial<ProviderCredentials> & Record<string, unknown>
  ) => Promise<void> | void;
  /** When true, skip the intra-URL 429 retry in execute() so the caller handles fallback. */
  skipUpstreamRetry?: boolean;
};

export type CountTokensInput = {
  body: Record<string, unknown>;
  credentials: ProviderCredentials;
  log?: ExecutorLog | null;
  model: string;
  signal?: AbortSignal | null;
};

/** Apply model-level extra upstream headers (e.g. Authentication, X-Custom-Auth). */
export function mergeUpstreamExtraHeaders(
  headers: Record<string, string>,
  extra?: Record<string, string> | null
): void {
  if (!extra) return;
  for (const [k, v] of Object.entries(extra)) {
    if (typeof k === "string" && k.length > 0 && typeof v === "string") {
      if (k.toLowerCase() === "user-agent") {
        setUserAgentHeader(headers, v);
        continue;
      }
      headers[k] = v;
    }
  }
}

export function getCustomUserAgent(providerSpecificData?: JsonRecord | null): string | null {
  const customUserAgent =
    typeof providerSpecificData?.customUserAgent === "string"
      ? providerSpecificData.customUserAgent.trim()
      : "";
  return customUserAgent || null;
}

export function setUserAgentHeader(headers: Record<string, string>, userAgent: string): void {
  headers["User-Agent"] = userAgent;
  if ("user-agent" in headers) {
    headers["user-agent"] = userAgent;
  }
}

export function applyConfiguredUserAgent(
  headers: Record<string, string>,
  providerSpecificData?: JsonRecord | null
): void {
  const customUserAgent = getCustomUserAgent(providerSpecificData);
  if (customUserAgent) {
    setUserAgentHeader(headers, customUserAgent);
  }
}

export function mergeAbortSignals(primary: AbortSignal, secondary: AbortSignal): AbortSignal {
  const controller = new AbortController();

  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason);
    }
  };

  if (primary.aborted) {
    abortFrom(primary);
    return controller.signal;
  }
  if (secondary.aborted) {
    abortFrom(secondary);
    return controller.signal;
  }

  primary.addEventListener("abort", () => abortFrom(primary), { once: true });
  secondary.addEventListener("abort", () => abortFrom(secondary), { once: true });
  return controller.signal;
}

/**
 * Sanitize reasoning_effort for providers that don't accept all values.
 *
 * Some translators may emit reasoning_effort=max/xhigh. Combined with
 * runtime alias remapping, this routes xhigh to OpenAI-shape providers
 * that don't accept the value:
 *
 *   xiaomi-mimo : low|medium|high only — 400 literal_error on xhigh
 *   mistral     : devstral models reject reasoning_effort entirely
 *   github      : claude/haiku/oswe models reject reasoning_effort entirely
 *
 * Each rejection burns a combo fallback attempt before reaching a working
 * provider. Apply provider-aware sanitation here (after transformRequest, so
 * reintroductions by per-provider transforms are also caught) before fetch.
 * xhigh support is registry-gated: models that genuinely support xhigh pass
 * through unchanged. For OpenAI-shape providers, normalize max to xhigh when
 * that top tier is allowed; otherwise downgrade to high.
 */
const MISTRAL_NO_REASONING_EFFORT_PATTERN = /devstral/i;
const GITHUB_NO_REASONING_EFFORT_PATTERN = /(claude|haiku|oswe)/i;

export function sanitizeReasoningEffortForProvider(
  body: unknown,
  provider: string,
  model: string | undefined,
  log?: { info?: (tag: string, msg: string) => void } | null
): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  const reasoning =
    b.reasoning && typeof b.reasoning === "object" && !Array.isArray(b.reasoning)
      ? (b.reasoning as Record<string, unknown>)
      : null;
  const hasTopLevelReasoningEffort = Object.prototype.hasOwnProperty.call(b, "reasoning_effort");
  const effort = b.reasoning_effort ?? reasoning?.effort;
  if (effort === undefined) return body;
  const effortStr = typeof effort === "string" ? effort.toLowerCase() : "";
  const modelStr = model || "";

  const supportsXHigh = supportsXHighEffort(provider, modelStr);
  const shouldDowngradeXHigh = effortStr === "xhigh" && !supportsXHigh;
  const shouldDowngradeMax = effortStr === "max" && !supportsXHigh;

  if (shouldDowngradeXHigh || shouldDowngradeMax) {
    log?.info?.(
      "REASONING_SANITIZE",
      `${provider}/${modelStr}: downgraded reasoning_effort ${effortStr} → high`
    );
    const next: Record<string, unknown> = { ...b };
    if (hasTopLevelReasoningEffort) {
      next.reasoning_effort = "high";
    }
    if (reasoning) {
      next.reasoning = { ...reasoning, effort: "high" };
    }
    return next;
  }

  const rejecting =
    (provider === "mistral" && MISTRAL_NO_REASONING_EFFORT_PATTERN.test(modelStr)) ||
    (provider === "github" && GITHUB_NO_REASONING_EFFORT_PATTERN.test(modelStr));
  if (rejecting) {
    log?.info?.(
      "REASONING_SANITIZE",
      `${provider}/${modelStr}: removed unsupported reasoning_effort`
    );
    const next: Record<string, unknown> = { ...b };
    delete next.reasoning_effort;
    if (reasoning) {
      const r = { ...reasoning };
      delete r.effort;
      if (Object.keys(r).length === 0) delete next.reasoning;
      else next.reasoning = r;
    }
    return next;
  }

  return body;
}

/**
 * BaseExecutor - Base class for provider executors.
 * Implements the Strategy pattern: subclasses override specific methods
 * (buildUrl, buildHeaders, transformRequest, etc.) for each provider.
 */
export class BaseExecutor {
  provider: string;
  config: ProviderConfig;

  constructor(provider: string, config: ProviderConfig) {
    this.provider = provider;
    this.config = config;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  getTimeoutMs() {
    const configured = this.config?.timeoutMs;
    if (typeof configured !== "number" || !Number.isFinite(configured)) {
      return FETCH_TIMEOUT_MS;
    }
    return Math.max(1, Math.floor(configured));
  }

  getCountTokensTimeoutMs() {
    return this.getTimeoutMs();
  }

  buildUrl(
    model: string,
    stream: boolean,
    urlIndex = 0,
    credentials: ProviderCredentials | null = null
  ) {
    void model;
    void stream;
    if (
      this.provider?.startsWith?.("openai-compatible-") ||
      this.provider?.startsWith?.("gigachat-compatible-")
    ) {
      const psd = credentials?.providerSpecificData;
      const baseUrl = typeof psd?.baseUrl === "string" ? psd.baseUrl : "https://api.openai.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      // Sanitize custom path: must start with '/', no path traversal, no null bytes
      const rawPath = typeof psd?.chatPath === "string" && psd.chatPath ? psd.chatPath : null;
      const customPath = rawPath && sanitizePath(rawPath) ? rawPath : null;
      if (customPath) return `${normalized}${customPath}`;
      const path =
        getOpenAICompatibleType(this.provider, psd) === "responses"
          ? "/responses"
          : "/chat/completions";
      return `${normalized}${path}`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl || "";
  }

  buildHeaders(
    credentials: ProviderCredentials,
    stream = true,
    clientHeaders?: Record<string, string> | null,
    model?: string,
    health?: Record<string, KeyHealth>
  ): Record<string, string> {
    void clientHeaders;
    void model;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.headers,
    };

    // Allow per-provider User-Agent override via environment variable.
    // Example: CLAUDE_USER_AGENT="my-agent/2.0" overrides the default for the Claude provider.
    const providerId = this.config?.id || this.provider;
    if (providerId) {
      const envKey = `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_USER_AGENT`;
      const envUA = process.env[envKey]?.trim();
      if (envUA) {
        setUserAgentHeader(headers, envUA);
      }
    }

    if (credentials.accessToken) {
      headers["Authorization"] = `Bearer ${credentials.accessToken}`;
    } else if (credentials.apiKey) {
      const extraKeys =
        (credentials.providerSpecificData?.extraApiKeys as string[] | undefined) ?? [];
      const selectedKeyId = (
        credentials.providerSpecificData as Record<string, unknown> | undefined
      )?.selectedKeyId as string | undefined;
      let effectiveKey = credentials.apiKey;
      if (extraKeys.length > 0 && credentials.connectionId) {
        const resolved = resolveKeyForRequest(
          credentials.connectionId,
          credentials.apiKey,
          extraKeys,
          selectedKeyId ?? null
        );
        effectiveKey = resolved?.key ?? credentials.apiKey;
        if (resolved && credentials.providerSpecificData) {
          (credentials.providerSpecificData as Record<string, unknown>).selectedKeyId =
            resolved.keyId;
        }
      }
      headers["Authorization"] = `Bearer ${effectiveKey}`;
    }

    headers["Accept"] = stream ? "text/event-stream" : "application/json";

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(
    model: string,
    body: unknown,
    stream: boolean,
    credentials: ProviderCredentials
  ): unknown {
    void model;
    void stream;
    void credentials;

    // Fix #1674: Remove empty string values from optional parameters
    // like tool descriptions to avoid upstream validation failures.
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const cloned = { ...body } as Record<string, unknown>;

      if (Array.isArray(cloned.input)) {
        cloned.input = sanitizeResponsesInputItems(cloned.input, false);
      }

      if (Array.isArray(cloned.tools)) {
        cloned.tools = cloned.tools.map((tool: unknown) => {
          if (tool && typeof tool === "object" && !Array.isArray(tool)) {
            const toolRecord = tool as JsonRecord;
            const toolFunction = toolRecord.function;
            if (toolFunction && typeof toolFunction === "object" && !Array.isArray(toolFunction)) {
              const func = { ...(toolFunction as JsonRecord) };
              if (func.description === "") delete func.description;
              if (typeof func.name !== "string" || func.name.trim() === "") {
                func.name = "unnamed_tool";
              }
              return { ...toolRecord, function: func };
            }
          }
          return tool;
        });
      }

      // Fix #1884: Cursor sends prompt_cache_retention which breaks strict upstream endpoints
      delete cloned.prompt_cache_retention;

      // Also clean up top level optional fields that commonly cause issues when empty
      const optionalKeys = ["user", "stop", "seed", "response_format"];
      for (const key of optionalKeys) {
        if (cloned[key] === "") delete cloned[key];
      }

      return cloned;
    }

    return body;
  }

  shouldRetry(status: number, urlIndex: number) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Intra-URL retry config: retry same URL before falling back to next node
  static readonly RETRY_CONFIG = { maxAttempts: 2, delayMs: 2000 };
  // Timeout for receiving the initial upstream response headers. Once the response
  // starts streaming, STREAM_IDLE_TIMEOUT_MS / Undici bodyTimeout handle stalls.
  static FETCH_START_TIMEOUT_MS = FETCH_TIMEOUT_MS;

  // Override in subclass for provider-specific refresh
  async refreshCredentials(
    credentials: ProviderCredentials,
    log: ExecutorLog | null
  ): Promise<Partial<ProviderCredentials> | null> {
    void credentials;
    void log;
    return null;
  }

  needsRefresh(credentials?: ProviderCredentials | null) {
    if (!credentials?.expiresAt) return false;
    const expiresAtMs = new Date(credentials.expiresAt).getTime();
    // Use the provider-specific lead time (REFRESH_LEAD_MS) so rotating-token
    // providers like Codex refresh proactively far ahead of expiry. Keeping the
    // refresh_token "warm" prevents Auth0 from marking it as stale and revoking
    // the token family on first use after long idle.
    const lead = getRefreshLeadMs(this.provider);
    return expiresAtMs - Date.now() < lead;
  }

  parseError(response: Response, bodyText: string) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  buildCountTokensUrl(model: string, credentials: ProviderCredentials | null = null) {
    void model;
    void credentials;
    const baseUrl = this.buildUrl(model, false, 0, credentials);
    if (typeof baseUrl !== "string" || baseUrl.length === 0) return null;
    if (this.config?.format !== "claude" || !baseUrl.includes("/messages")) return null;

    const [path, query = ""] = baseUrl.split("?");
    const normalizedPath = path.endsWith("/messages")
      ? `${path}/count_tokens`
      : `${path}/count_tokens`;
    return query ? `${normalizedPath}?${query}` : normalizedPath;
  }

  async countTokens({ model, body, credentials, signal, log }: CountTokensInput) {
    const url = this.buildCountTokensUrl(model, credentials);
    if (!url) return null;

    const headers = this.buildHeaders(credentials, false);
    const requestBody =
      body && typeof body === "object"
        ? {
            ...body,
            model,
          }
        : { model };

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let activeSignal = signal || null;
    let controller: AbortController | null = null;
    const timeoutMs = this.getCountTokensTimeoutMs();

    if (timeoutMs > 0) {
      controller = new AbortController();
      timeoutId = setTimeout(() => controller?.abort(), timeoutMs);
      activeSignal = signal ? mergeAbortSignals(signal, controller.signal) : controller.signal;
    }

    try {
      const ctMtlsCfg = resolveMtlsConfig(credentials?.providerSpecificData?.mtls);
      const ctFetchOptions: RequestInit & { dispatcher?: unknown } = {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: activeSignal || undefined,
      };
      if (ctMtlsCfg) ctFetchOptions.dispatcher = getMtlsDispatcher(ctMtlsCfg);
      // Bypass ambient fetch to ensure 'dispatcher' option survives Next.js wrapping
      const response = await proxyFetch(url, ctFetchOptions);

      const text = await response.text();
      if (!response.ok) {
        const parsedError = this.parseError(response, text);
        throw new Error(parsedError.message);
      }

      const parsed = text ? JSON.parse(text) : {};
      const inputTokens = Number(parsed?.input_tokens);
      if (!Number.isFinite(inputTokens)) {
        throw new Error("Provider count_tokens response missing input_tokens");
      }

      return { input_tokens: inputTokens, provider: this.provider, source: "provider" };
    } catch (error) {
      log?.debug?.(
        "COUNT_TOKENS",
        `${this.provider}/${model} real count unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async execute(input: ExecuteInput) {
    const {
      model,
      body,
      stream,
      credentials,
      signal,
      log,
      extendedContext,
      upstreamExtraHeaders,
      clientHeaders,
      skipUpstreamRetry = false,
      onCredentialsRefreshed,
    } = input;
    const fallbackCount = this.getFallbackCount();
    let lastError: unknown = null;
    let lastStatus = 0;
    let activeCredentials = credentials;
    // Track per-URL intra-retry attempts to avoid infinite loops
    const retryAttemptsByUrl: Record<number, number> = {};

    if (this.needsRefresh(credentials)) {
      try {
        // Fix A: wire onCredentialsRefreshed through runWithOnPersist so it runs
        // INSIDE the per-connection mutex inside getAccessToken. Not every
        // executor routes through getAccessToken (e.g. github.ts), so use a flag
        // to detect whether the persist callback actually fired and fall back to
        // post-refresh mutation when it didn't.
        let proactivePersistRan = false;
        const proactiveOnPersist = onCredentialsRefreshed
          ? async (refreshResult: Record<string, unknown>) => {
              proactivePersistRan = true;
              activeCredentials = {
                ...credentials,
                ...(refreshResult as Partial<ProviderCredentials>),
              };
              await onCredentialsRefreshed(refreshResult as Partial<ProviderCredentials>);
            }
          : null;

        const refreshed = await runWithOnPersist(proactiveOnPersist, () =>
          this.refreshCredentials(credentials, log || null)
        );

        if (refreshed && !proactivePersistRan) {
          // ─────────────────────────────────────────────────────────────────────
          // ⚠️ SOURCE OF TRUTH — do not flip the proactive path back to
          //    "persist expired+inactive". Ask the operator first.
          //
          // History (do not repeat past regressions):
          //   - ad3d4b696 (#2718, 2026-05-25): per-connection mutex + onPersist
          //     wiring so multi-account Codex (rotating refresh tokens) stops
          //     hitting refresh_token_reused under concurrent load.
          //   - 0c94c397d (#2743, 2026-05-26): a multi-agent review added a
          //     `await onCredentialsRefreshed({ testStatus: "expired",
          //     isActive: false })` here. That BROKE multi-account Codex —
          //     transient sentinels (refresh_token_reused recoverable via
          //     rotation map; generic invalid_request blips) were treated as
          //     terminal, so the proactive path sequentially disabled
          //     working accounts in the DB before any upstream call confirmed
          //     the failure. Reverted intentionally.
          //
          // Contract for the PROACTIVE refresh path:
          //   - Classify the sentinel ONLY to avoid spreading it into
          //     activeCredentials (which would send a non-token upstream).
          //   - DO NOT persist `{ testStatus: "expired", isActive: false }`
          //     from here. That decision belongs to the REACTIVE path in
          //     open-sse/handlers/chatCore.ts:~3912, which runs AFTER the
          //     upstream confirmed the auth failure. By then the rotation
          //     map (tokenRefresh.ts:~1541) and the DB-staleness check have
          //     already had their chance to recover the request.
          //
          // If a future review/agent thinks the expired-flip is "missing"
          // here, STOP — flipping it here re-introduces the multi-account
          // Codex regression. Discuss with the operator before touching.
          // ─────────────────────────────────────────────────────────────────────
          if (isUnrecoverableRefreshError(refreshed)) {
            const refreshCode = (refreshed as Record<string, unknown>).code;
            log?.warn?.(
              "TOKEN",
              `${this.provider.toUpperCase()} | proactive refresh returned unrecoverable sentinel (code=${String(refreshCode ?? "unknown")}); keeping stale credentials, deferring to reactive path.`
            );
            // Intentionally NOT spreading the sentinel and NOT persisting
            // expired status. The next upstream call either succeeds (rotation
            // map / DB-staleness saved us) or fails — chatCore.ts then marks
            // the account expired with confidence.
          } else {
            activeCredentials = {
              ...credentials,
              ...refreshed,
            };
            if (onCredentialsRefreshed) {
              await onCredentialsRefreshed(refreshed);
            }
          }
        }
      } catch (error) {
        // tokenRefresh.ts:1352 documents that onPersist throws are re-thrown so
        // the caller is aware of the persistence failure. Honor that contract:
        // log at error level (not warn), with sanitized message — and let the
        // request continue with stale credentials so the user-visible error
        // surfaces upstream rather than being silently absorbed here.
        log?.error?.(
          "TOKEN",
          `Credential refresh failed for ${this.provider}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const mtlsCfg = resolveMtlsConfig(activeCredentials?.providerSpecificData?.mtls);
    const mtlsDispatcher = mtlsCfg ? getMtlsDispatcher(mtlsCfg) : undefined;

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, activeCredentials);
      const headers = this.buildHeaders(activeCredentials, stream, clientHeaders, model);
      applyConfiguredUserAgent(headers, activeCredentials?.providerSpecificData);

      const rawTransformedBody = await this.transformRequest(
        model,
        body,
        stream,
        activeCredentials
      );
      const transformedBody = sanitizeReasoningEffortForProvider(
        rawTransformedBody,
        this.provider,
        model,
        log
      );

      try {
        // Only enforce the timeout while waiting for the initial fetch() response.
        // Once headers arrive, active streams must not be cut off by total elapsed time;
        // post-start stalls are handled separately by STREAM_IDLE_TIMEOUT_MS / bodyTimeout.
        const fetchStartTimeoutMs = this.getTimeoutMs();
        const timeoutController = fetchStartTimeoutMs > 0 ? new AbortController() : null;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        if (timeoutController) {
          timeoutId = setTimeout(() => {
            const timeoutError = new Error(
              `Fetch timeout after ${fetchStartTimeoutMs}ms on ${url}`
            );
            timeoutError.name = "TimeoutError";
            timeoutController.abort(timeoutError);
          }, fetchStartTimeoutMs);
        }
        const timeoutSignal = timeoutController?.signal ?? null;
        const combinedSignal =
          signal && timeoutSignal
            ? mergeAbortSignals(signal, timeoutSignal)
            : signal || timeoutSignal;

        const finalHeaders = headers;
        const bodyString = JSON.stringify(transformedBody);

        mergeUpstreamExtraHeaders(finalHeaders, upstreamExtraHeaders);

        const fetchOptions: RequestInit = {
          method: "POST",
          headers: finalHeaders,
          body: bodyString,
        };
        if (combinedSignal) fetchOptions.signal = combinedSignal;
        if (mtlsDispatcher) {
          (fetchOptions as RequestInit & { dispatcher?: unknown }).dispatcher = mtlsDispatcher;
        }

        let response;
        try {
          // Bypass ambient fetch to ensure 'dispatcher' option survives Next.js wrapping
          response = await proxyFetch(url, fetchOptions);
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
        }

        // Intra-URL retry: if 429 and we haven't exhausted per-URL retries, wait and retry the same URL
        if (
          !skipUpstreamRetry &&
          response.status === HTTP_STATUS.RATE_LIMITED &&
          (retryAttemptsByUrl[urlIndex] ?? 0) < BaseExecutor.RETRY_CONFIG.maxAttempts
        ) {
          retryAttemptsByUrl[urlIndex] = (retryAttemptsByUrl[urlIndex] ?? 0) + 1;
          const attempt = retryAttemptsByUrl[urlIndex];
          log?.debug?.(
            "RETRY",
            `429 intra-retry ${attempt}/${BaseExecutor.RETRY_CONFIG.maxAttempts} on ${url} — waiting ${BaseExecutor.RETRY_CONFIG.delayMs}ms`
          );
          await new Promise((resolve) => setTimeout(resolve, BaseExecutor.RETRY_CONFIG.delayMs));
          urlIndex--; // re-run this urlIndex on the next loop iteration
          continue;
        }

        // T07: Handle 401 authentication errors — log and continue to fallback
        if (response.status === 401 && credentials.connectionId && credentials.apiKey) {
          log?.warn?.("AUTH", `401 on ${url} - API key may be invalid`);
        }

        if (!skipUpstreamRetry && this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }

        return { response, url, headers: finalHeaders, transformedBody };
      } catch (error) {
        // Distinguish timeout errors from other abort errors
        const err = error instanceof Error ? error : new Error(String(error));
        if (err.name === "TimeoutError") {
          log?.warn?.("TIMEOUT", `Fetch timeout after ${this.getTimeoutMs()}ms on ${url}`);
        }
        lastError = err;
        if (!skipUpstreamRetry && urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
