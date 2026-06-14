/**
 * MLProxy provider configuration.
 *
 * Extracted from provider-specific-data (JSON, unencrypted):
 *   {
 *     "baseHost": "https://ml-proxy.internal.company.com",
 *     "proxyId": "gateway-01",
 *     "login": "svc-omniroute",
 *     "refreshIntervalMinutes": 30,
 *     "caPath": "/etc/omniroute/certs/ca.pem",
 *     "tlsInsecure": false
 *   }
 *
 * The password lives in the encrypted refreshToken, never in this object.
 */

export interface MlproxyConfig {
  /** Base host URL for the ML Proxy (must be https). */
  baseHost: string;
  /** Proxy gateway identifier. */
  proxyId: string;
  /** Login / username for authentication. */
  login: string;
  /** How often (in minutes) to refresh cookies. Defaults to 15. */
  refreshIntervalMinutes: number;
  /** Optional path to a custom CA certificate bundle. */
  caPath?: string;
  /** Skip TLS verification (dangerous; opt-in only). */
  tlsInsecure?: boolean;
}

/**
 * Validate-and-return pattern: returns an MlproxyConfig when the input is
 * well-formed, or null on any validation failure. Never throws.
 *
 * Mirrors the `resolveMtlsConfig` pattern from mtlsAgent.ts.
 */
export function resolveMlproxyConfig(psd: unknown): MlproxyConfig | null {
  if (!psd || typeof psd !== "object") return null;

  const raw = psd as Record<string, unknown>;

  // --- baseHost: required, must be a parseable https: URL ---------------
  const baseHost =
    typeof raw["baseHost"] === "string" ? (raw["baseHost"] as string).trim() : "";
  if (!baseHost) return null;
  try {
    const parsed = new URL(baseHost);
    if (parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }

  // --- proxyId: required non-empty --------------------------------------
  const proxyId =
    typeof raw["proxyId"] === "string" ? (raw["proxyId"] as string).trim() : "";
  if (!proxyId) return null;

  // --- login: required non-empty ----------------------------------------
  const login =
    typeof raw["login"] === "string" ? (raw["login"] as string).trim() : "";
  if (!login) return null;

  // --- refreshIntervalMinutes: optional, defaults to 15 ------------------
  const rawInterval = raw["refreshIntervalMinutes"];
  const refreshIntervalMinutes =
    typeof rawInterval === "number" && Number.isFinite(rawInterval) && rawInterval > 0
      ? Math.round(rawInterval)
      : 15;

  // --- caPath: optional -------------------------------------------------
  const caPath =
    typeof raw["caPath"] === "string" ? (raw["caPath"] as string).trim() : undefined;

  // --- tlsInsecure: optional --------------------------------------------
  const tlsInsecure =
    typeof raw["tlsInsecure"] === "boolean" ? (raw["tlsInsecure"] as boolean) : undefined;

  return {
    baseHost,
    proxyId,
    login,
    refreshIntervalMinutes,
    ...(caPath ? { caPath } : {}),
    ...(tlsInsecure !== undefined ? { tlsInsecure } : {}),
  };
}

/**
 * Compute the ISO-8601 expiry string based on now + intervalMinutes * 60000.
 */
export function computeCookieExpiry(intervalMinutes: number): string {
  const ms = Math.max(0, intervalMinutes) * 60_000;
  return new Date(Date.now() + ms).toISOString();
}
