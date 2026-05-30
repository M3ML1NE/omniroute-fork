import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type KeyStoreEntry,
  type KeyStoreFile,
  isKeyStoreFile,
} from "../types/keyStore.js";

/**
 * Redact sensitive fields entry safe logging.
 * api_key: ***<last4>
 * mtls cert/key/ca paths: [redacted]
 */
function redactEntry(entry: KeyStoreEntry): Record<string, unknown> {
  return {
    id: entry.id,
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    authUrl: entry.authUrl,
    api_key:
      entry.api_key.length >= 4
        ? `***${entry.api_key.slice(-4)}`
        : "***",
    mtls: entry.mtls
      ? {
          cert_path: "[redacted]",
          key_path: "[redacted]",
          ca_path: "[redacted]",
        }
      : undefined,
  };
}

export class KeyStore {
  private entries: Map<string, KeyStoreEntry> = new Map();
  private watcher?: fs.FSWatcher;
  private debounceTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly filePath: string) {}

  /**
   * Load (or reload) entries JSON file.
   * Atomic replace internal map success.
   * Throws invalid JSON / shape; caller decides whether retain old state.
   */
  async load(): Promise<void> {
    const raw = await fs.promises.readFile(this.filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (!isKeyStoreFile(parsed)) {
      throw new Error(
        `Invalid key store file format: ${this.filePath}`,
      );
    }

    const file: KeyStoreFile = parsed;
    const newEntries = new Map<string, KeyStoreEntry>();
    for (const entry of file.keys) {
      newEntries.set(entry.id, entry);
    }

    // Atomic replace
    this.entries = newEntries;
  }

  /**
   * Lookup entry id (e.g. provider_connections.keystore_entry_id).
   */
  get(id: string): KeyStoreEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Snapshot all entries currently loaded.
   */
  list(): KeyStoreEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Start watching file changes.
   * Debounce 200ms collapse double-trigger editor atomic saves.
   * Invalid JSON during reload: log error, keep old state (don't crash).
   */
  watch(): void {
    if (this.watcher) return;

    this.watcher = fs.watch(this.filePath, () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        void this.reload();
      }, 200);
    });

    this.watcher.on("error", (err: Error) => {
      console.error(`[keyStore] watcher error: ${err.message}`);
    });
  }

  /**
   * Stop watching and clear pending debounce timer.
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
  }

  private async reload(): Promise<void> {
    try {
      await this.load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[keyStore] reload failed (keeping old state): ${msg}`,
      );
    }
  }

  /**
   * Internal helper: redacted view all entries safe logging.
   */
  describeRedacted(): Record<string, unknown>[] {
    return this.list().map(redactEntry);
  }
}

let _instance: KeyStore | undefined;

/**
 * Resolve default key store path.
 * OMNIROUTE_KEYSTORE_PATH env override, else ~/.omniroute/keys.json.
 */
export function getDefaultKeyStorePath(): string {
  return (
    process.env["OMNIROUTE_KEYSTORE_PATH"] ??
    path.join(os.homedir(), ".omniroute", "keys.json")
  );
}

/**
 * Process-wide singleton accessor.
 * Lazy-instantiates default path. Call .load() before use.
 */
export function getKeyStore(): KeyStore {
  if (!_instance) {
    _instance = new KeyStore(getDefaultKeyStorePath());
  }
  return _instance;
}

/**
 * Test helper: reset singleton (stops watcher) clean per-test state.
 */
export function _resetKeyStoreSingleton(): void {
  _instance?.stop();
  _instance = undefined;
}
