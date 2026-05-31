import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type AtlassianService,
  type AtlassianServiceConfig,
  isAtlassianConfigFile,
} from "../types/atlassianConfig.ts";

/**
 * Redact sensitive fields a single service config safe logging.
 * password: ***<last4>
 * mtls cert/key/ca paths: [redacted]
 */
function redactService(svc: AtlassianServiceConfig): Record<string, unknown> {
  return {
    enabled: svc.enabled,
    base_url: svc.base_url,
    username: svc.username,
    password:
      svc.password.length > 4 ? `***${svc.password.slice(-4)}` : "***",
    mtls: svc.mtls
      ? {
          cert_path: "[redacted]",
          key_path: "[redacted]",
          ca_path: "[redacted]",
        }
      : undefined,
    timeout_ms: svc.timeout_ms,
  };
}

export class AtlassianConfig {
  private services: Map<AtlassianService, AtlassianServiceConfig> = new Map();
  private watcher?: fs.FSWatcher;
  private debounceTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly filePath: string) {}

  /**
   * Load (or reload) per-service config JSON file.
   * Atomic replace internal map success.
   * Throws invalid JSON / shape; caller decides whether retain old state.
   */
  async load(): Promise<void> {
    const raw = await fs.promises.readFile(this.filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (!isAtlassianConfigFile(parsed)) {
      throw new Error(
        `Invalid Atlassian config file format: ${this.filePath}`,
      );
    }

    const next = new Map<AtlassianService, AtlassianServiceConfig>();
    if (parsed.jira) next.set("jira", parsed.jira);
    if (parsed.bitbucket) next.set("bitbucket", parsed.bitbucket);
    if (parsed.confluence) next.set("confluence", parsed.confluence);

    // Atomic replace
    this.services = next;
  }

  /**
   * Lookup config a service. Returns undefined when service absent.
   */
  get(service: AtlassianService): AtlassianServiceConfig | undefined {
    return this.services.get(service);
  }

  /** Returns list of services that exist AND are enabled. */
  list(): AtlassianService[] {
    return [...this.services.entries()]
      .filter(([, cfg]) => cfg.enabled)
      .map(([k]) => k);
  }

  /** Returns all configured services regardless of enabled state. */
  listAll(): AtlassianService[] {
    return [...this.services.keys()];
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
      console.error(`[atlassianConfig] watcher error: ${err.message}`);
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
        `[atlassianConfig] reload failed (keeping old state): ${msg}`,
      );
    }
  }

  /**
   * Internal helper: redacted view all enabled+configured services safe logging.
   */
  describeRedacted(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [svc, cfg] of this.services.entries()) {
      out[svc] = redactService(cfg);
    }
    return out;
  }
}

let _instance: AtlassianConfig | undefined;

/**
 * Resolve default Atlassian config path.
 * OMNIROUTE_ATLASSIAN_CONFIG_PATH env override, else ~/.omniroute/atlassian.json.
 */
export function getDefaultConfigPath(): string {
  return (
    process.env["OMNIROUTE_ATLASSIAN_CONFIG_PATH"] ??
    path.join(os.homedir(), ".omniroute", "atlassian.json")
  );
}

/**
 * Process-wide singleton accessor.
 * Lazy-instantiates default path. Call .load() before use.
 */
export function getAtlassianConfig(): AtlassianConfig {
  if (!_instance) {
    _instance = new AtlassianConfig(getDefaultConfigPath());
  }
  return _instance;
}

/**
 * Test helper: reset singleton (stops watcher) clean per-test state.
 */
export function _resetAtlassianConfigSingleton(): void {
  _instance?.stop();
  _instance = undefined;
}

/** Exported only for redaction tests / logging utilities. */
export function _redactServiceForLog(
  svc: AtlassianServiceConfig,
): Record<string, unknown> {
  return redactService(svc);
}
