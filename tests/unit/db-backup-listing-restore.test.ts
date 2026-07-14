import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backupDbFile, listDbBackups, restoreDbBackup } from "../../src/lib/db/backup.ts";
import { DATA_DIR, DB_BACKUPS_DIR, SQLITE_FILE } from "../../src/lib/db/core.ts";

// Same real-directory pattern as db-backup-pure.test.ts: getBackupDir() reads
// DATA_DIR/DB_BACKUPS_DIR captured at module-import time, not a live env var,
// so these tests operate on the actual resolved backup dir and scope every
// file they write with a run-unique prefix to avoid cross-test interference.
const REAL_BACKUP_DIR = DB_BACKUPS_DIR || `${DATA_DIR}/db_backups`;
const RUN_PREFIX = `dbbackuprestore${process.pid}`;

function writeBackupFile(name: string) {
  fs.mkdirSync(REAL_BACKUP_DIR, { recursive: true });
  const filePath = path.join(REAL_BACKUP_DIR, name);
  fs.writeFileSync(filePath, "not a real sqlite file, just needs to exist for stat()");
  return filePath;
}

function cleanupOwnFiles() {
  if (!fs.existsSync(REAL_BACKUP_DIR)) return;
  for (const name of fs.readdirSync(REAL_BACKUP_DIR)) {
    if (name.includes(RUN_PREFIX)) {
      fs.rmSync(path.join(REAL_BACKUP_DIR, name), { force: true });
    }
  }
}

beforeEach(() => {
  cleanupOwnFiles();
});

afterEach(() => {
  cleanupOwnFiles();
});

describe("backupDbFile", () => {
  it("returns null because this is the Postgres-backed fork (SQLITE_FILE is always null)", () => {
    // SQLITE_FILE is a compatibility constant that's always null in this
    // Postgres-only fork (see src/lib/db/core.ts) — backupDbFile's first
    // guard clause (`!SQLITE_FILE`) makes every call a documented no-op.
    assert.equal(SQLITE_FILE, null);
    const result = backupDbFile("manual");
    assert.equal(result, null);
  });

  it("returns null regardless of the reason argument", () => {
    assert.equal(backupDbFile("auto"), null);
    assert.equal(backupDbFile("pre-restore"), null);
    assert.equal(backupDbFile(), null);
  });
});

describe("listDbBackups", () => {
  it("returns an empty array when the backup directory has no matching files", async () => {
    const backups = await listDbBackups();
    const ownEntries = backups.filter((b: any) => b.filename.includes(RUN_PREFIX));
    assert.deepEqual(ownEntries, []);
  });

  it("lists backup files newest-first, parsing the reason from the filename", async () => {
    writeBackupFile(`db_${RUN_PREFIX}-2020-01-01T00-00-00-000Z_auto.sqlite`);
    writeBackupFile(`db_${RUN_PREFIX}-2020-01-02T00-00-00-000Z_manual.sqlite`);

    const backups = await listDbBackups();
    const ownEntries = backups
      .filter((b: any) => b.filename.includes(RUN_PREFIX))
      .sort((a: any, b: any) => (a.filename < b.filename ? 1 : -1));

    assert.equal(ownEntries.length, 2);
    assert.equal(ownEntries[0].reason, "manual");
    assert.equal(ownEntries[1].reason, "auto");
    for (const entry of ownEntries) {
      assert.equal(typeof entry.size, "number");
      assert.ok(entry.size > 0);
      assert.equal(entry.connectionCount, 0);
      assert.ok(entry.createdAt);
    }
  });

  it("labels the reason as 'unknown' when the filename doesn't match the expected pattern segment", async () => {
    writeBackupFile(`db_${RUN_PREFIX}nofieldshere.sqlite`);

    const backups = await listDbBackups();
    const entry = backups.find((b: any) => b.filename.includes(RUN_PREFIX));
    assert.ok(entry);
    assert.equal((entry as any).reason, "unknown");
  });
});

describe("restoreDbBackup", () => {
  it("rejects a backupId that doesn't start with 'db_'", async () => {
    await assert.rejects(restoreDbBackup("not-a-backup.sqlite"), /Invalid backup ID/);
  });

  it("rejects a backupId that doesn't end with '.sqlite'", async () => {
    await assert.rejects(restoreDbBackup("db_something.txt"), /Invalid backup ID/);
  });

  it("rejects a backupId containing a path separator (path traversal attempt)", async () => {
    await assert.rejects(restoreDbBackup("db_../../etc/passwd.sqlite"), /Invalid backup ID/);
  });

  it("rejects a well-formed but non-existent backupId", async () => {
    await assert.rejects(
      restoreDbBackup(`db_${RUN_PREFIX}-does-not-exist.sqlite`),
      /Backup not found/
    );
  });

  it("rejects a backup file that fails the (stubbed) integrity check as corrupt", async () => {
    // tryOpenSync in backup.ts is a permanent stub (`(_p, _o) => null`) in
    // this fork, so any restore attempt against a real file always hits the
    // "could not open" branch of the corruption guard — this is the only
    // integrity-check branch reachable without a real SQLite backend.
    writeBackupFile(`db_${RUN_PREFIX}-corrupt.sqlite`);
    await assert.rejects(
      restoreDbBackup(`db_${RUN_PREFIX}-corrupt.sqlite`),
      /Backup file is corrupt/
    );
  });
});
