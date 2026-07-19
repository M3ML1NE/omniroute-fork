// @ts-nocheck
import "./setupPolyfill.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { randomFloat } from "../../src/shared/utils/secureRandom";
import tlsClient from "./tlsClient.ts";

function isTlsFingerprintEnabled() {
  return process.env.ENABLE_TLS_FINGERPRINT === "true";
}

/** Per-request tracking of whether TLS fingerprint was used */
type TlsFingerprintStore = { used: boolean };
const tlsFingerprintContext = new AsyncLocalStorage<TlsFingerprintStore>();

type FetchWithDispatcherOptions = RequestInit & { dispatcher?: unknown };
type FetchWithDispatcher = (
  input: RequestInfo | URL,
  init?: FetchWithDispatcherOptions
) => Promise<Response>;

/** Injectable dependencies for testability. */
export type ProxyFetchDeps = {
  undiciFetch?: FetchWithDispatcher;
  nativeFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

type PatchState = {
  originalFetch: typeof globalThis.fetch;
  proxyContext: AsyncLocalStorage<unknown>;
  isPatched: boolean;
};

// Detect a true edge/serverless runtime (Cloudflare Workers, Vercel Edge),
// where the global fetch must NOT be monkeypatched. The old heuristic keyed off
// `typeof caches === "object"`, but Node 22+ and the Next.js production Node
// server now define globalThis.caches too — which made isCloud=true on a plain
// Node/VPS deployment, so the fetch patch was skipped and `dispatcher` (mTLS
// client cert, undici proxy) was silently dropped by native fetch -> 401. A
// real edge runtime has no `process.versions.node`; a Node server always does.
const hasNodeRuntime =
  typeof process !== "undefined" && Boolean(process.versions?.node);
const isCloud = !hasNodeRuntime && typeof caches !== "undefined" && typeof caches === "object";
const PATCH_STATE_KEY = Symbol.for("omniroute.proxyFetch.state");

function getPatchState(): PatchState {
  const scopedGlobal = globalThis as typeof globalThis & {
    [PATCH_STATE_KEY]?: PatchState;
  };

  if (!scopedGlobal[PATCH_STATE_KEY]) {
    scopedGlobal[PATCH_STATE_KEY] = {
      originalFetch: globalThis.fetch,
      proxyContext: new AsyncLocalStorage(),
      isPatched: false,
    };
  }
  return scopedGlobal[PATCH_STATE_KEY];
}

const patchState = getPatchState();
const originalFetch = patchState.originalFetch;
const originalFetchWithDispatcher = originalFetch as FetchWithDispatcher;
const proxyContext = patchState.proxyContext;

function noProxyMatch(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (!noProxy) return false;

  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return false;
  }

  const hostname = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  const patterns = noProxy
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;

    const [patternHost, patternPort] = pattern.split(":");
    if (patternPort && patternPort !== port) return false;
    if (!patternHost) return false;

    if (patternHost.includes("*")) {
      const parts = patternHost.split("*");
      let pos = 0;
      let ok = hostname.startsWith(parts[0]);
      if (ok) {
        pos = parts[0].length;
        for (let i = 1; i < parts.length && ok; i++) {
          const seg = parts[i];
          if (i === parts.length - 1) {
            ok = seg === "" || (hostname.endsWith(seg) && hostname.length - seg.length >= pos);
          } else {
            const idx = seg ? hostname.indexOf(seg, pos) : pos;
            if (idx === -1) {
              ok = false;
            } else {
              pos = idx + seg.length;
            }
          }
        }
      }
      if (ok) return true;
    }

    if (patternHost.startsWith(".")) {
      return hostname.endsWith(patternHost) || hostname === patternHost.slice(1);
    }
    return hostname === patternHost || hostname.endsWith(`.${patternHost}`);
  });
}

function isLocalAddress(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  if (hostname.startsWith("192.168.")) return true;
  if (hostname.startsWith("10.")) return true;
  if (hostname.match(/^172\.(1[6-9]|2\d|3[0-1])\./)) return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".lan")) return true;
  return false;
}

function resolveEnvProxyUrl(targetUrl) {
  if (noProxyMatch(targetUrl)) return null;

  let protocol;
  try {
    protocol = new URL(targetUrl).protocol;
  } catch {
    return null;
  }

  const proxyUrl =
    protocol === "https:"
      ? process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.ALL_PROXY ||
        process.env.all_proxy
      : process.env.HTTP_PROXY ||
        process.env.http_proxy ||
        process.env.ALL_PROXY ||
        process.env.all_proxy;

  return proxyUrl || null;
}

export function resolveProxyForRequest(targetUrl) {
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    target = null;
  }

  if (target && isLocalAddress(target.hostname.toLowerCase())) {
    return { source: "direct", proxyUrl: null };
  }

  const envProxyUrl = resolveEnvProxyUrl(targetUrl);
  if (envProxyUrl) {
    return { source: "env", proxyUrl: envProxyUrl };
  }

  return { source: "direct", proxyUrl: null };
}

function getTargetUrl(input) {
  if (typeof input === "string") return input;
  if (input && typeof input.url === "string") return input.url;
  return String(input);
}

/**
 * No-op proxy context: the proxy/1proxy subsystem was removed in the GigaChat
 * fork. The signature is preserved because many call sites wrap upstream fetches
 * in it; it now simply runs the callback (outbound proxying, if any, is resolved
 * from HTTPS_PROXY/HTTP_PROXY env vars inside patchedFetch).
 */
export async function runWithProxyContext(_proxyConfig, fn) {
  if (typeof fn !== "function") {
    throw new TypeError("runWithProxyContext requires a callback function");
  }
  return fn();
}

/** Kept for backward-compat with callers from the removed proxy subsystem. */
export function clearDispatcherCache(): void {
  /* no-op: dispatcher caching removed with the proxy subsystem */
}

async function patchedFetch(
  input: RequestInfo | URL,
  options: FetchWithDispatcherOptions = {},
  deps: ProxyFetchDeps = {}
) {
  if (options?.dispatcher) {
    const _undiciDispatcher =
      deps.undiciFetch ?? (undiciFetch as unknown as (...args: unknown[]) => Promise<Response>);
    return _undiciDispatcher(input, options);
  }

  const targetUrl = getTargetUrl(input);
  const { proxyUrl } = resolveProxyForRequest(targetUrl);

  if (proxyUrl) {
    // Env-configured outbound proxy: route through an undici ProxyAgent.
    try {
      const _undiciProxy =
        deps.undiciFetch ?? (undiciFetch as unknown as (...args: unknown[]) => Promise<Response>);
      return await _undiciProxy(input, {
        ...options,
        dispatcher: new ProxyAgent(proxyUrl),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ProxyFetch] Env proxy failed, falling back to direct: ${message}`);
    }
  }

  // TLS fingerprint spoofing for direct connections.
  if (isTlsFingerprintEnabled() && tlsClient.available) {
    try {
      const store = tlsFingerprintContext.getStore();
      if (store) store.used = true;
      return await tlsClient.fetch(targetUrl, {
        ...options,
        headers: options.headers,
        signal: options.signal ?? undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ProxyFetch] TLS fingerprint failed, falling back to native fetch: ${message}`);
      const store = tlsFingerprintContext.getStore();
      if (store) store.used = false;
    }
  }

  // Direct connection — use undici for timeout control, fall back to native fetch.
  const _bodyUnknown = options.body as unknown;
  const bodyIsStream =
    _bodyUnknown !== null &&
    _bodyUnknown !== undefined &&
    typeof _bodyUnknown === "object" &&
    (typeof (_bodyUnknown as Record<string, unknown>).getReader === "function" ||
      typeof (_bodyUnknown as Record<string, unknown>).stream === "function");
  const maxAttempts = bodyIsStream ? 1 : 2;
  const _undiciDirect =
    deps.undiciFetch ?? (undiciFetch as unknown as (...args: unknown[]) => Promise<Response>);
  const _nativeFallback =
    (deps.nativeFetch as FetchWithDispatcher | undefined) ?? originalFetchWithDispatcher;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await _undiciDirect(input, options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errCode = (err as { code?: string })?.code;
      if (
        msg.includes("fetch failed") ||
        errCode === "ECONNREFUSED" ||
        msg.includes("ECONNREFUSED") ||
        (typeof errCode === "string" && errCode.startsWith("UND_ERR")) ||
        msg.includes("UND_ERR")
      ) {
        if (attempt === 0 && maxAttempts > 1) {
          lastError = err;
          await new Promise((r) => setTimeout(r, 25 + randomFloat() * 50));
          continue;
        }
        console.warn(`[ProxyFetch] Undici failed, falling back to native fetch: ${msg}`);
        return _nativeFallback(input, options);
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Named export for proxyFetch — identical to the patched globalThis.fetch but
 * accepts an optional ProxyFetchDeps for unit test dependency injection.
 */
export async function proxyFetch(
  input: RequestInfo | URL,
  options: RequestInit = {},
  deps: ProxyFetchDeps = {}
): Promise<Response> {
  return patchedFetch(input, options as FetchWithDispatcherOptions, deps);
}

if (!isCloud && !patchState.isPatched) {
  globalThis.fetch = patchedFetch;
  patchState.isPatched = true;
}

/**
 * Run a function with TLS fingerprint tracking context.
 * After fn completes, returns { result, tlsFingerprintUsed }.
 */
export async function runWithTlsTracking(fn) {
  const store = { used: false };
  const result = await tlsFingerprintContext.run(store, fn);
  return { result, tlsFingerprintUsed: store.used };
}

/** Check if TLS fingerprint is enabled and available */
export function isTlsFingerprintActive() {
  return isTlsFingerprintEnabled() && tlsClient.available;
}

export default isCloud ? originalFetch : patchedFetch;
