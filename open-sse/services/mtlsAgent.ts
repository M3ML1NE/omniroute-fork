import https from "node:https";
import fs from "node:fs";
import crypto from "node:crypto";
import type { MtlsConfig } from "../types/keyStore.js";

function fingerprint(cfg: MtlsConfig): string {
  return crypto
    .createHash("sha256")
    .update(`${cfg.cert_path}|${cfg.key_path}|${cfg.ca_path}`)
    .digest("hex")
    .slice(0, 16);
}

class LRUAgentPool {
  private readonly map = new Map<string, https.Agent>();
  private readonly order: string[] = [];

  constructor(private readonly max: number) {}

  get(key: string): https.Agent | undefined {
    const agent = this.map.get(key);
    if (agent) {
      const idx = this.order.indexOf(key);
      if (idx !== -1) this.order.splice(idx, 1);
      this.order.push(key);
    }
    return agent;
  }

  set(key: string, agent: https.Agent): void {
    if (this.map.has(key)) {
      const idx = this.order.indexOf(key);
      if (idx !== -1) this.order.splice(idx, 1);
    } else if (this.map.size >= this.max) {
      const lruKey = this.order.shift();
      if (lruKey !== undefined) {
        const lruAgent = this.map.get(lruKey);
        if (lruAgent) lruAgent.destroy();
        this.map.delete(lruKey);
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

export function getAgent(cfg: MtlsConfig): https.Agent {
  const key = fingerprint(cfg);
  const cached = pool.get(key);
  if (cached) return cached;

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
    throw new Error(`mTLS: cannot read CA file: ${cfg.ca_path}`);
  }

  const agent = new https.Agent({
    cert,
    key: keyPem,
    ca,
    rejectUnauthorized: true,
    keepAlive: true,
  });

  pool.set(key, agent);
  return agent;
}

export function clearPool(): void {
  pool.clear();
}

export function _getPoolSize(): number {
  return pool.size;
}
