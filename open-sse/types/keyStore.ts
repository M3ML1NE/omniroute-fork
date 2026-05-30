/**
 * mTLS certificate material paths for provider connection.
 * All values are filesystem paths to PEM files or inline PEM content.
 */
export interface MtlsConfig {
  /** Path to client certificate PEM file (e.g. /etc/omniroute/certs/client.crt) */
  cert_path: string;
  /** Path to client private key PEM file */
  key_path: string;
  /** Path to CA chain PEM file (may contain intermediate CAs) */
  ca_path: string;
}

/**
 * Single entry in key store JSON file.
 * Maps logical provider ID to credentials and optional mTLS config.
 */
export interface KeyStoreEntry {
  /** Unique identifier referenced by provider_connections.keystore_entry_id */
  id: string;
  /** Outbound provider API key (sent as GigaChat/openai-compat Bearer token) */
  api_key: string;
  /** Provider type */
  provider: "gigachat" | "openai-compatible";
  /** Override default chat completions endpoint URL */
  baseUrl?: string;
  /** GigaChat only: override OAuth token exchange URL */
  authUrl?: string;
  /** Optional mTLS client certificate configuration */
  mtls?: MtlsConfig;
}

/**
 * Root structure of ~/.omniroute/keys.json
 */
export interface KeyStoreFile {
  version: 1;
  keys: KeyStoreEntry[];
}

/**
 * Type guard: validates unknown value conforms to KeyStoreFile shape.
 * Returns false (does NOT throw) on invalid input.
 */
export function isKeyStoreFile(x: unknown): x is KeyStoreFile {
  if (typeof x !== "object" || x === null) return false;

  const obj = x as Record<string, unknown>;

  if (obj["version"] !== 1) return false;
  if (!Array.isArray(obj["keys"])) return false;

  return obj["keys"].every((k) => {
    if (typeof k !== "object" || k === null) return false;

    const entry = k as Record<string, unknown>;

    if (typeof entry["id"] !== "string") return false;
    if (typeof entry["api_key"] !== "string") return false;
    if (entry["provider"] !== "gigachat" && entry["provider"] !== "openai-compatible")
      return false;

    if (entry["mtls"] !== undefined) {
      const m = entry["mtls"] as Record<string, unknown>;
      if (typeof m["cert_path"] !== "string") return false;
      if (typeof m["key_path"] !== "string") return false;
      if (typeof m["ca_path"] !== "string") return false;
    }

    return true;
  });
}
