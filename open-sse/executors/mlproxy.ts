import {
  applyConfiguredUserAgent,
  mergeAbortSignals,
  mergeUpstreamExtraHeaders,
  sanitizeReasoningEffortForProvider,
} from "./base.ts";
import type { ExecuteInput, ExecutorLog, ProviderCredentials } from "./base.ts";
import { DefaultExecutor } from "./default.ts";
import { getMlproxyDispatcher } from "./mlproxyAgent.ts";
import {
  computeCookieExpiry,
  resolveMlproxyConfig,
  type MlproxyConfig,
} from "./mlproxyConfig.ts";
import { parseSetCookies, redactMlproxyAuthBody } from "./mlproxyCookies.ts";
import { HTTP_STATUS } from "../config/constants.ts";
import { runWithOnPersist } from "../services/tokenRefresh.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
import { proxyFetch } from "../utils/proxyFetch.ts";

/**
 * Refresh cookies slightly before the stored expiry so a request never reaches
 * upstream with a just-expired cookie. The cookie itself is opaque to us; we
 * only know the configured refresh interval, so a small lead is sufficient.
 */
const REFRESH_LEAD_MS = 60_000;

/**
 * Per-connection in-flight refresh mutex. Concurrent proactive + reactive
 * refreshes for the same connection share one login round-trip instead of
 * hammering the /auth endpoint (and risking duplicate sessions).
 *
 * Keyed by connectionId (falling back to id, then "default"). Cleared in the
 * `finally` of the shared promise so a later refresh starts fresh.
 */
const inflight = new Map<string, Promise<Partial<ProviderCredentials> | null>>();

function normalizeBaseHost(baseHost: string): string {
  return baseHost.replace(/\/$/, "");
}

function getMutexKey(credentials: ProviderCredentials): string {
  return credentials.connectionId ?? (credentials as { id?: string }).id ?? "default";
}

/**
 * MlproxyExecutor — cookie-based auth executor for the `mlproxy` provider.
 *
 * Auth model: a username/password login against `${baseHost}/auth` returns a
 * Set-Cookie that is then sent as a plain `Cookie` header on chat/model
 * requests. No Authorization/Bearer token is ever sent. The cookie is stored
 * encrypted in `accessToken`; the password lives encrypted in `refreshToken`;
 * the non-secret config (host, proxyId, login, TLS) lives in
 * `providerSpecificData` (JSON, unencrypted).
 */
export class MlproxyExecutor extends DefaultExecutor {
  constructor() {
    super("mlproxy");
  }

  private resolveConfig(credentials: ProviderCredentials | null): MlproxyConfig {
    const cfg = resolveMlproxyConfig(credentials?.providerSpecificData);
    if (!cfg) {
      throw new Error(
        "MLproxy: missing or invalid provider configuration (baseHost/proxyId/login required)"
      );
    }
    return cfg;
  }

  buildUrl(
    model: string,
    stream: boolean,
    urlIndex = 0,
    credentials: ProviderCredentials | null = null
  ): string {
    void model;
    void stream;
    void urlIndex;
    const cfg = this.resolveConfig(credentials);
    const host = normalizeBaseHost(cfg.baseHost);
    // Same path for streaming and non-streaming — upstream switches on the
    // request body `stream` flag, no URL suffix is required.
    return `${host}/path/proxy/${cfg.proxyId}/v1/chat/completions`;
  }

  /** URL for the upstream model catalog (`GET .../v1/models`). */
  modelsUrl(credentials: ProviderCredentials | null = null): string {
    const cfg = this.resolveConfig(credentials);
    const host = normalizeBaseHost(cfg.baseHost);
    return `${host}/path/proxy/${cfg.proxyId}/v1/models`;
  }

  buildHeaders(
    credentials: ProviderCredentials,
    stream = true,
    clientHeaders: Record<string, string> | null = null
  ): Record<string, string> {
    void clientHeaders;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
    };
    // Cookie-based auth: the stored cookie string goes out verbatim. Never set
    // Authorization for this provider.
    if (credentials.accessToken) {
      headers["Cookie"] = credentials.accessToken;
    }
    return headers;
  }

  /**
   * Refresh slightly before expiry (REFRESH_LEAD_MS lead) so a cookie that is
   * about to lapse is renewed before the next upstream call.
   */
  needsRefresh(credentials?: ProviderCredentials | null): boolean {
    if (!credentials?.expiresAt) return false;
    const expiresAtMs = new Date(credentials.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs)) return false;
    return expiresAtMs - Date.now() < REFRESH_LEAD_MS;
  }

  async refreshCredentials(
    credentials: ProviderCredentials,
    log: ExecutorLog | null
  ): Promise<Partial<ProviderCredentials> | null> {
    const key = getMutexKey(credentials);
    const existing = inflight.get(key);
    if (existing) {
      log?.debug?.("MLPROXY", `Reusing in-flight cookie refresh for ${key}`);
      return existing;
    }

    const refreshPromise = this.login(credentials, log).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, refreshPromise);
    return refreshPromise;
  }

  /** Perform the actual /auth login round-trip and parse the Set-Cookie. */
  private async login(
    credentials: ProviderCredentials,
    log: ExecutorLog | null
  ): Promise<Partial<ProviderCredentials> | null> {
    const cfg = this.resolveConfig(credentials);
    const host = normalizeBaseHost(cfg.baseHost);
    const url = `${host}/auth`;

    const authBody = { login: cfg.login, password: credentials.refreshToken };
    log?.debug?.(
      "MLPROXY",
      `Authenticating to ${url} with ${JSON.stringify(redactMlproxyAuthBody(authBody))}`
    );

    const dispatcher = getMlproxyDispatcher({ caPath: cfg.caPath, tlsInsecure: cfg.tlsInsecure });

    try {
      const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(authBody),
        dispatcher,
      };
      const res = await proxyFetch(url, fetchOptions);

      if (!res.ok) {
        throw new Error(`MLproxy auth failed with status ${res.status}`);
      }

      const cookie = parseSetCookies(res);
      if (!cookie) {
        throw new Error("MLproxy auth response did not contain a Set-Cookie");
      }

      return {
        accessToken: cookie,
        expiresAt: computeCookieExpiry(cfg.refreshIntervalMinutes),
      };
    } catch (error) {
      const message = sanitizeErrorMessage(error instanceof Error ? error : new Error(String(error)));
      log?.error?.("MLPROXY", `Cookie refresh failed: ${message}`);
      throw new Error(`MLproxy authentication failed: ${message}`);
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
      upstreamExtraHeaders,
      clientHeaders,
      skipUpstreamRetry = false,
      onCredentialsRefreshed,
    } = input;

    let activeCredentials = credentials;

    // ── Proactive refresh ──────────────────────────────────────────────────
    // Wrap in runWithOnPersist so a future refreshCredentials that reads the
    // active onPersist store still persists atomically; today refreshCredentials
    // returns the patch and we persist explicitly via onCredentialsRefreshed.
    if (this.needsRefresh(credentials)) {
      try {
        const refreshed = await runWithOnPersist(
          onCredentialsRefreshed
            ? async (result) => {
                await onCredentialsRefreshed(result as Partial<ProviderCredentials>);
              }
            : null,
          () => this.refreshCredentials(credentials, log || null)
        );
        if (refreshed) {
          activeCredentials = { ...credentials, ...refreshed };
          if (onCredentialsRefreshed) {
            await onCredentialsRefreshed(refreshed);
          }
        }
      } catch (error) {
        log?.error?.(
          "MLPROXY",
          `Credential refresh failed for ${this.provider}: ${sanitizeErrorMessage(error instanceof Error ? error : new Error(String(error)))}`
        );
      }
    }

    const cfg = this.resolveConfig(activeCredentials);
    const dispatcher = getMlproxyDispatcher({ caPath: cfg.caPath, tlsInsecure: cfg.tlsInsecure });

    const url = this.buildUrl(model, stream, 0, activeCredentials);
    const headers = this.buildHeaders(activeCredentials, stream, clientHeaders);
    applyConfiguredUserAgent(headers, activeCredentials?.providerSpecificData);
    mergeUpstreamExtraHeaders(headers, upstreamExtraHeaders);

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
    const bodyString = JSON.stringify(transformedBody);

    let retryAttempts = 0;
    for (;;) {
      const fetchStartTimeoutMs = this.getTimeoutMs();
      const timeoutController = fetchStartTimeoutMs > 0 ? new AbortController() : null;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      if (timeoutController) {
        timeoutId = setTimeout(() => {
          const timeoutError = new Error(`Fetch timeout after ${fetchStartTimeoutMs}ms on ${url}`);
          timeoutError.name = "TimeoutError";
          timeoutController.abort(timeoutError);
        }, fetchStartTimeoutMs);
      }
      const timeoutSignal = timeoutController?.signal ?? null;
      const combinedSignal =
        signal && timeoutSignal
          ? mergeAbortSignals(signal, timeoutSignal)
          : signal || timeoutSignal;

      const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        method: "POST",
        headers,
        body: bodyString,
        dispatcher,
      };
      if (combinedSignal) fetchOptions.signal = combinedSignal;

      let response: Response;
      try {
        // Bypass ambient fetch so the `dispatcher` option survives Next.js wrapping.
        response = await proxyFetch(url, fetchOptions);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      if (
        !skipUpstreamRetry &&
        response.status === HTTP_STATUS.RATE_LIMITED &&
        retryAttempts < MlproxyExecutor.RETRY_CONFIG.maxAttempts
      ) {
        retryAttempts++;
        log?.debug?.(
          "RETRY",
          `429 intra-retry ${retryAttempts}/${MlproxyExecutor.RETRY_CONFIG.maxAttempts} on ${url} — waiting ${MlproxyExecutor.RETRY_CONFIG.delayMs}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, MlproxyExecutor.RETRY_CONFIG.delayMs));
        continue;
      }

      return { response, url, headers, transformedBody };
    }
  }
}

export default MlproxyExecutor;
