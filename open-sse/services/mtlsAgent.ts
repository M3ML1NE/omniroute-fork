import { Agent } from "undici";
import fs from "node:fs";
import crypto from "node:crypto";

export interface MtlsConfig {
  cert_path: string;
  key_path: string;
  ca_path: string;
}

function fingerprint(cfg: MtlsConfig): string {
  return crypto
    .createHash("sha256")
    .update(`${cfg.cert_path}|${cfg.key_path}|${cfg.ca_path}`)
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

const pool = new LRUAgentPool(64);

function readPem(path: string, label: string): Buffer {
  try {
    return fs.readFileSync(path);
  } catch {
    throw new Error(`mTLS: cannot read ${label} file: ${path}`);
  }
}

// Returns a cached undici Agent usable as a fetch dispatcher (global fetch is
// monkeypatched in proxyFetch.ts to honor options.dispatcher). Cert material is
// read once and cached by path-fingerprint: the deployment FS is read-only so
// certs cannot change without a pod restart (rotation = restart). Throws a clear
// error on unreadable PEM (missing mount) so it surfaces instead of being swallowed.
export function getMtlsDispatcher(cfg: MtlsConfig): Agent {
  const key = fingerprint(cfg);
  const cached = pool.get(key);
  if (cached) return cached;

  const agent = new Agent({
    connect: {
      cert: readPem(cfg.cert_path, "cert"),
      key: readPem(cfg.key_path, "key"),
      ca: readPem(cfg.ca_path, "ca"),
      rejectUnauthorized: true,
    },
    keepAliveTimeout: 60_000,
  });

  pool.set(key, agent);
  return agent;
}

export function resolveMtlsConfig(value: unknown): MtlsConfig | null {
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  const cert = typeof m["cert_path"] === "string" ? (m["cert_path"] as string) : "";
  const key = typeof m["key_path"] === "string" ? (m["key_path"] as string) : "";
  const ca = typeof m["ca_path"] === "string" ? (m["ca_path"] as string) : "";
  if (!cert || !key || !ca) return null;
  return { cert_path: cert, key_path: key, ca_path: ca };
}

export function clearPool(): void {
  pool.clear();
}

export function _getPoolSize(): number {
  return pool.size;
}
