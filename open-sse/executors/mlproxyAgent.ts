import { Agent } from "undici";
import fs from "node:fs";
import crypto from "node:crypto";

export interface MlproxyAgentConfig {
  caPath?: string;
  tlsInsecure?: boolean;
}

/** Canonicalize config to a deterministic cache key. */
function fingerprint(cfg: MlproxyAgentConfig): string {
  return crypto
    .createHash("sha256")
    .update(`${cfg.caPath ?? ""}|${String(cfg.tlsInsecure ?? false)}`)
    .digest("hex")
    .slice(0, 16);
}

class LRUAgentPool {
  private readonly map = new Map<string, Agent>();
  private readonly order: string[] = [];

  constructor(private readonly max: number) {}

  get(key: string): Agent | undefined {
    const agent = this.map.get(key);
    if (agent) {
      const idx = this.order.indexOf(key);
      if (idx !== -1) this.order.splice(idx, 1);
      this.order.push(key);
    }
    return agent;
  }

  set(key: string, agent: Agent): void {
    if (this.map.has(key)) {
      const idx = this.order.indexOf(key);
      if (idx !== -1) this.order.splice(idx, 1);
    } else if (this.map.size >= this.max) {
      const lruKey = this.order.shift();
      if (lruKey !== undefined) {
        const lruAgent = this.map.get(lruKey);
        if (lruAgent) void lruAgent.close();
        this.map.delete(lruKey);
      }
    }
    this.map.set(key, agent);
    this.order.push(key);
  }

  clear(): void {
    for (const agent of this.map.values()) {
      void agent.close();
    }
    this.map.clear();
    this.order.length = 0;
  }

  get size(): number {
    return this.map.size;
  }
}

function readCa(path: string): Buffer {
  try {
    return fs.readFileSync(path);
  } catch {
    throw new Error(
      `MLproxy: cannot read CA file at "${path}". Check that the path exists and is readable.`
    );
  }
}

const pool = new LRUAgentPool(64);

/**
 * Returns a cached undici Agent suitable as a `dispatcher` for proxyFetch /
 * undici fetch.  Config is fingerprinted so re-requests with the same
 * (caPath, tlsInsecure) pair reuse the same Agent.
 *
 * - `caPath` set     → loads CA cert and passes it as `connect.ca`.
 * - `tlsInsecure`    → sets `rejectUnauthorized: false`.
 * - Neither          → secure default (`rejectUnauthorized: true`).
 *
 * Throws when `caPath` is provided but the file is unreadable so misconfiguration
 * surfaces loudly instead of silently falling back to insecure defaults.
 */
export function getMlproxyDispatcher(cfg: MlproxyAgentConfig): Agent {
  const key = fingerprint(cfg);
  const cached = pool.get(key);
  if (cached) return cached;

  const connect: Record<string, unknown> = {};

  if (cfg.caPath) {
    connect.ca = readCa(cfg.caPath);
  }

  connect.rejectUnauthorized = cfg.tlsInsecure === true ? false : true;

  const agent = new Agent({
    connect,
    keepAliveTimeout: 60_000,
  });

  pool.set(key, agent);
  return agent;
}

/** Exposed for tests — clear the LRU pool. */
export function clearPool(): void {
  pool.clear();
}

/** Exposed for tests — check current pool size. */
export function _getPoolSize(): number {
  return pool.size;
}
