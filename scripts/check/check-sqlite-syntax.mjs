#!/usr/bin/env node
/**
 * CI guard: fail if SQLite-only syntax leaks into Postgres-converted critical DB modules.
 *
 * The OmniRoute data layer was migrated from better-sqlite3 (sync) to node-postgres
 * (async). The modules listed in CRITICAL_MODULES are on the request/boot critical
 * path and MUST be free of SQLite-specific dialect. This guard greps each module for
 * known SQLite-only constructs and exits non-zero on any match so CI blocks regressions.
 *
 * Line (`//`) and block comments are stripped before matching so that explanatory
 * comments referencing the old syntax do not trigger false positives. SQL lives in
 * string literals, which are preserved.
 *
 * Usage:  node scripts/check/check-sqlite-syntax.mjs
 * Self-test (planted-syntax detection): node scripts/check/check-sqlite-syntax.mjs --self-test
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

/**
 * Critical-path DB modules converted to Postgres/async (T7-T15).
 * Keep in sync with .omo/notepads/omniroute-postgres-migration/module-classification.md.
 */
const CRITICAL_MODULES = [
  "src/lib/db/core.ts",
  "src/lib/db/postgres.ts",
  "src/lib/db/providers.ts",
  "src/lib/db/apiKeys.ts",
  "src/lib/db/registeredKeys.ts",
  "src/lib/db/settings.ts",
  "src/lib/db/databaseSettings.ts",
  "src/lib/usage/callLogs.ts",
  "src/lib/usage/aggregateHistory.ts",
  "src/lib/db/combos.ts",
  "src/lib/db/modelComboMappings.ts",
  "src/lib/db/domainState.ts",
  "src/lib/semanticCache.ts",
  "src/lib/db/quotaSnapshots.ts",
  "src/lib/db/prompts.ts",
  "src/lib/db/featureFlags.ts",
  "src/lib/db/creditBalance.ts",
  "src/lib/db/models.ts",
  "src/lib/db/serviceModels.ts",
  "src/lib/db/stats.ts",
  "src/lib/db/sessionAccountAffinity.ts",
  "src/lib/db/tokenLimits.ts",
  "src/lib/compliance/index.ts",
  "src/lib/compliance/noLog.ts",
  "src/lib/db/providerLimits.ts",
  "src/lib/usage/providerLimits.ts",
  "src/lib/spend/batchWriter.ts",
  "open-sse/services/geminiThoughtSignatureStore.ts",
  "open-sse/services/tokenLimitCounter.ts",
];

/**
 * SQLite-only dialect patterns. Each is invalid or semantically wrong on Postgres.
 * `label` is shown in the failure report; `re` is matched per stripped line.
 */
const SQLITE_PATTERNS = [
  { label: "PRAGMA statement", re: /\bPRAGMA\s+\w/i },
  { label: "datetime('now') / datetime(\"now\")", re: /\bdatetime\s*\(\s*['"]now['"]/i },
  { label: "strftime()", re: /\bstrftime\s*\(/i },
  { label: "unixepoch()", re: /\bunixepoch\b/i },
  { label: "INSERT OR REPLACE/IGNORE/ABORT/FAIL/ROLLBACK", re: /\bINSERT\s+OR\s+(REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\b/i },
  { label: "AUTOINCREMENT", re: /\bAUTOINCREMENT\b/i },
  { label: "sqlite_master", re: /\bsqlite_master\b/i },
  { label: "ROWID", re: /\bROWID\b/i },
  { label: "json_extract() (use ->/->> on ::jsonb)", re: /\bjson_extract\s*\(/i },
  { label: "better-sqlite3 db.transaction()", re: /\.transaction\s*\(\s*(\(|function|async)/ },
];

/**
 * Remove `//` line comments and `/* *\/` block comments so explanatory comments
 * that mention legacy syntax do not trigger false positives. This is a lightweight
 * stripper: it does not parse strings, but the SQLite patterns we match live in SQL
 * string literals which never appear inside comments, so the trade-off is safe here.
 */
function stripComments(source) {
  // Strip block comments (non-greedy, across newlines) -> replace with same number of newlines to keep line numbers stable.
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  // Strip line comments.
  return withoutBlocks
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function scanFile(absPath) {
  const source = readFileSync(absPath, "utf8");
  const stripped = stripComments(source);
  const lines = stripped.split("\n");
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { label, re } of SQLITE_PATTERNS) {
      if (re.test(line)) {
        violations.push({ line: i + 1, label, text: line.trim() });
      }
    }
  }
  return violations;
}

function runGuard(modules) {
  const report = [];
  let missing = 0;
  for (const rel of modules) {
    const abs = resolve(repoRoot, rel);
    if (!existsSync(abs)) {
      missing += 1;
      console.warn(`  ! skipped (not found): ${rel}`);
      continue;
    }
    const violations = scanFile(abs);
    if (violations.length > 0) {
      report.push({ rel, violations });
    }
  }
  return { report, missing };
}

function printReport(report) {
  for (const { rel, violations } of report) {
    console.error(`\n  ✗ ${rel}`);
    for (const v of violations) {
      console.error(`      L${v.line}  [${v.label}]  ${v.text}`);
    }
  }
}

// --- Self-test mode: prove the guard actually detects SQLite syntax. ---
if (process.argv.includes("--self-test")) {
  const samples = [
    "PRAGMA table_info(api_keys);",
    "INSERT OR REPLACE INTO key_value (namespace, key) VALUES ($1, $2)",
    "SELECT strftime('%s', created_at) FROM call_logs",
    "id INTEGER PRIMARY KEY AUTOINCREMENT",
    "SELECT name FROM sqlite_master WHERE type='table'",
    "WHERE json_extract(provider_specific_data, '$.workspaceId') = ?",
    "const tx = db.transaction(() => {});",
  ];
  let allDetected = true;
  for (const s of samples) {
    const hit = SQLITE_PATTERNS.some((p) => p.re.test(s));
    console.log(`  ${hit ? "✓ detected" : "✗ MISSED  "}  ${s}`);
    if (!hit) allDetected = false;
  }
  // Ensure a clean Postgres line does NOT trip the guard.
  const cleanLine = "INSERT INTO key_value (namespace, key, value) VALUES ($1, $2, $3) ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value";
  const falsePositive = SQLITE_PATTERNS.some((p) => p.re.test(cleanLine));
  console.log(`  ${falsePositive ? "✗ FALSE POSITIVE" : "✓ clean line ok"}  ${cleanLine.slice(0, 60)}...`);
  if (!allDetected || falsePositive) {
    console.error("\nSelf-test FAILED.");
    process.exit(1);
  }
  console.log("\nSelf-test passed: all SQLite samples detected, clean line untouched.");
  process.exit(0);
}

const { report, missing } = runGuard(CRITICAL_MODULES);

if (report.length > 0) {
  console.error("SQLite syntax guard: FAIL");
  console.error("Found SQLite-only dialect in Postgres-converted critical modules:");
  printReport(report);
  console.error(
    `\n${report.length} file(s) with violations. These modules run on Postgres (node-postgres) —`
  );
  console.error(
    "replace SQLite-only syntax with the Postgres equivalent (ON CONFLICT, to_char/date_trunc,"
  );
  console.error("information_schema, NOW(), withTransaction, etc.).");
  process.exit(1);
}

console.log(`SQLite syntax guard: PASS (${CRITICAL_MODULES.length - missing} critical modules clean)`);
process.exit(0);
