/**
 * Minimal `.env` loader for standalone DB scripts (migrate-postgres.ts).
 *
 * The Next.js runtime loads `.env` via @next/env, but CLI scripts run under bare
 * `node --import tsx/esm`, which does NOT. Without this, `npm run db:migrate`
 * sees no DB_URL/DB_PASSWORD and fails with "relation … does not exist".
 *
 * Quoting: a value wrapped in matching single or double quotes is unquoted
 * literally — single quotes in particular keep escaping/special characters
 * ($ : @ ! # etc.) verbatim, which is the safe way to express a password. Shell
 * / CI env vars already in process.env take precedence (never overwritten).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnvFile(envPath?: string): void {
  const target =
    envPath ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  if (!existsSync(target)) return;

  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch {
    return;
  }

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;

    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}
