import https from "node:https";
import fs from "node:fs";
import crypto from "node:crypto";
import type { MtlsConfig } from "../types/keyStore.js";

/**
 * Compute short fingerprint from MtlsConfig paths (not contents).
 * LRU pool key; same paths reuse same Agent instance.
 */
function fingerprint(cfg: MtlsConfig): string {
  return crypto
    .createHash("sha256")
    .update(`${cfg.cert_path}|${cfg.key_path}|${cfg.ca_path}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Simple LRU pool for https.Agent.
 * Bounded max=64. Evicted agents .destroy() called to release sockets.
 * lru-cache dependency intentionally avoided (not in deps tree).
 */
class LRUAgentPool {
  private readonly map = new Map<string, https.Agent>();
  private readonly order: string[] = [];

  constructor(private readonly max: number) {}

  get(key: string): https.Agent | undefined {
    const agent = this.map.get(key);
    if (agent) {
      // bump most-recently-used
      const idx = this.order.indexOf(key);
      if (idx !== -1) {
        this.order.splice(idx, 1);
      }
      this.order.push(key);
    }
    return agent;
  }

  set(key: string, agent: https.Agent): void {
    if (this.map.has(key)) {
      const idx = this.order.indexOf(key);
      if (idx !== -1) {
        this.order.splice(idx, 1);
      }
    } else {
      if (this.map.size >= this.max) {
        // Evict least-recently-used
        const lruKey = this.order.shift();
        if (lruKey !== undefined) {
          const lruAgent = this.map.get(lruKey);
          if (lruAgent) {
            lruAgent.destroy();
          }
          this.map.delete(lruKey);
        }
      }
    }
    this.map.set(key, agent);
    this.order.push(key);
  }

  clear(): void {
    for (const agent of this.map.values()) {
      agent.destroy();
    }
    this.map.clear();
    this.order.length = 0;
  }

  get size(): number {
    return this.map.size;
  }
}

const pool = new LRUAgentPool(64);

/**
 * Get cached https.Agent given mTLS config, or create & cache one.
 * Reads cert/key/ca files synchronously on first use; throws Error mentioning
 * offending path (not file content) on read failure.
 * Sets rejectUnauthorized: true (Sber PKI requirement; do not disable peer cert verification).
 */
export function getAgent(cfg: MtlsConfig): https.Agent {
  const key = fingerprint(cfg);
  const cached = pool.get(key);
  if (cached) {
    return cached;
  }

  let cert: Buffer;
  let keyPem: Buffer;
  let ca: Buffer;

  try {
    cert = fs.readFileSync(cfg.cert_path);
  } catch {
    throw new Error(`mTLS: cannot read cert file: ${cfg.cert_path}`);
  }

  try {
    keyPem = fs.readFileSync(cfg.key_path);
  } catch {
    throw new Error(`mTLS: cannot read key file: ${cfg.key_path}`);
  }

  try {
    ca = fs.readFileSync(cfg.ca_path);
  } catch {
    throw new Error(`mTLS: cannot read ca file: ${cfg.ca_path}`);
  }

  const agent = new https.Agent({
    cert,
    key: keyPem,
    ca,
    rejectUnauthorized: true, // Sber PKI requirement; do not set false
    keepAlive: true,
  });

  pool.set(key, agent);
  return agent;
}

/**
 * Destroy all cached agents; clear pool.
 * Call on server shutdown.
 */
export function clearPool(): void {
  pool.clear();
}

/**
 * Exposed for testing only; returns current pool size.
 */
export function _getPoolSize(): number {
  return pool.size;
}
