/**
 * Configuration for a single Atlassian service (Jira / Bitbucket / Confluence).
 * All credentials kept secret; must be redacted in logs.
 */
export interface AtlassianServiceConfig {
  /** Whether service is enabled. Tools for disabled services are not registered. */
  enabled: boolean;
  /** Base URL of Atlassian instance, e.g. https://jira.company.local */
  base_url: string;
  /** Service account username for Basic auth */
  username: string;
  /** Service account password (or PAT) for Basic auth */
  password: string;
  /** Optional mTLS configuration (paths to PEM files) */
  mtls?: {
    cert_path: string;
    key_path: string;
    ca_path: string;
  };
  /** HTTP client timeout in milliseconds (default 30000) */
  timeout_ms?: number;
}

/**
 * Root structure of ~/.omniroute/atlassian.json.
 * Each service is independently configurable.
 */
export interface AtlassianConfigFile {
  version: 1;
  jira?: AtlassianServiceConfig;
  bitbucket?: AtlassianServiceConfig;
  confluence?: AtlassianServiceConfig;
}

export type AtlassianService = "jira" | "bitbucket" | "confluence";

/**
 * Type guard for AtlassianConfigFile.
 * Returns false (does not throw) for invalid input.
 */
export function isAtlassianConfigFile(x: unknown): x is AtlassianConfigFile {
  if (typeof x !== "object" || x === null) return false;

  const obj = x as Record<string, unknown>;

  if (obj["version"] !== 1) return false;

  for (const key of ["jira", "bitbucket", "confluence"]) {
    const svc = obj[key];
    if (svc === undefined) continue;

    if (typeof svc !== "object" || svc === null) return false;

    const s = svc as Record<string, unknown>;

    if (typeof s["enabled"] !== "boolean") return false;
    if (typeof s["base_url"] !== "string") return false;
    if (typeof s["username"] !== "string") return false;
    if (typeof s["password"] !== "string") return false;

    if (s["timeout_ms"] !== undefined && typeof s["timeout_ms"] !== "number")
      return false;

    if (s["mtls"] !== undefined) {
      if (typeof s["mtls"] !== "object" || s["mtls"] === null) return false;

      const m = s["mtls"] as Record<string, unknown>;

      if (typeof m["cert_path"] !== "string") return false;
      if (typeof m["key_path"] !== "string") return false;
      if (typeof m["ca_path"] !== "string") return false;
    }
  }

  return true;
}
