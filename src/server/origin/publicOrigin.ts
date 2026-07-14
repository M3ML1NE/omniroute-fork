/**
 * Centralized public-origin validation for browser mutation requests.
 *
 * Ported from upstream OmniRoute #5278 and pruned for the GigaChat decloud
 * fork: the upstream trust-proxy / peer-stamp machinery
 * (OMNIROUTE_TRUST_PROXY, PEER_IP_HEADER, classifyHostLocality,
 * resolveStampedPeer) has no supporting infrastructure in this fork, so it is
 * intentionally omitted. What remains is the core browser-mutation origin
 * guard: reject cross-origin mutations while allowing same-origin dashboard
 * requests and loopback-equivalent dev origins.
 *
 * The allowed origin set is derived from:
 *   1. Configured public base-URL env vars (highest priority).
 *   2. The request's own URL origin (same-origin dashboard behind a proxy).
 *   3. A fixed loopback allow-list (localhost:3000 dev server, 127.0.0.1)
 *      so local dashboard development is never rejected.
 *
 * @module server/origin/publicOrigin
 */

export type PublicOriginSource = "configured" | "request-url" | "loopback";

export interface PublicOriginCandidate {
  origin: string;
  source: PublicOriginSource;
}

export interface BrowserMutationOriginVerdict {
  ok: boolean;
  reason?: "cross-site-fetch-metadata" | "invalid-origin";
}

const PUBLIC_BASE_URL_ENV = [
  "OMNIROUTE_PUBLIC_BASE_URL",
  "NEXT_PUBLIC_BASE_URL",
  "NEXT_PUBLIC_APP_URL",
] as const;

// Loopback-equivalent dev origins that must always be accepted so local
// dashboard development (Next.js dev server on :3000, direct 127.0.0.1 access)
// is never rejected by the mutation-origin guard. Kept explicit per the plan's
// QA-failure escape hatch (localhost:3000 AND 127.0.0.1 both allowed).
const LOOPBACK_DEV_ORIGINS: ReadonlyArray<string> = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:20128",
  "http://127.0.0.1:20128",
  "http://localhost",
  "http://127.0.0.1",
];

export function firstHeaderValue(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

export function normalizeOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Unsupported origin protocol");
  }
  return parsed.origin.toLowerCase();
}

function uniqueCandidates(candidates: PublicOriginCandidate[]): PublicOriginCandidate[] {
  const seen = new Set<string>();
  const result: PublicOriginCandidate[] = [];
  for (const candidate of candidates) {
    let normalized: string;
    try {
      normalized = normalizeOrigin(candidate.origin);
    } catch {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ ...candidate, origin: normalized });
  }
  return result;
}

function configuredPublicOrigins(): PublicOriginCandidate[] {
  const candidates: PublicOriginCandidate[] = [];
  for (const name of PUBLIC_BASE_URL_ENV) {
    const value = process.env[name]?.trim();
    if (!value) continue;
    try {
      candidates.push({ origin: normalizeOrigin(value), source: "configured" });
    } catch {
      continue;
    }
  }
  return candidates;
}

function requestUrlOrigin(request: Request): string | null {
  try {
    return normalizeOrigin(new URL(request.url).origin);
  } catch {
    return null;
  }
}

function loopbackDevOrigins(): PublicOriginCandidate[] {
  return LOOPBACK_DEV_ORIGINS.map((origin) => ({ origin, source: "loopback" as const }));
}

export function getPublicOriginCandidates(request: Request): PublicOriginCandidate[] {
  const candidates: PublicOriginCandidate[] = [];

  const requestOrigin = requestUrlOrigin(request);
  if (requestOrigin) candidates.push({ origin: requestOrigin, source: "request-url" });

  candidates.push(...configuredPublicOrigins());
  candidates.push(...loopbackDevOrigins());

  return uniqueCandidates(candidates);
}

export function resolvePublicOrigin(request: Request): PublicOriginCandidate {
  const configured = uniqueCandidates(configuredPublicOrigins());
  if (configured.length > 0) return configured[0];

  const requestOrigin = requestUrlOrigin(request);
  if (requestOrigin) return { origin: requestOrigin, source: "request-url" };

  return { origin: "http://localhost:20128", source: "loopback" };
}

export function validateBrowserMutationOrigin(request: Request): BrowserMutationOriginVerdict {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
    return { ok: false, reason: "cross-site-fetch-metadata" };
  }

  const origin = request.headers.get("origin");
  if (!origin) return { ok: true };

  let normalizedOrigin: string;
  try {
    normalizedOrigin = normalizeOrigin(origin);
  } catch {
    return { ok: false, reason: "invalid-origin" };
  }

  const allowed = new Set(getPublicOriginCandidates(request).map((candidate) => candidate.origin));
  return allowed.has(normalizedOrigin) ? { ok: true } : { ok: false, reason: "invalid-origin" };
}
