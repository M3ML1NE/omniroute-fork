import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getDbBackupMaxFiles,
  getDbBackupRetentionDays,
  unlinkFileWithRetry,
  cleanupDbBackups,
} from "../../src/lib/db/backup.ts";
import { DATA_DIR, DB_BACKUPS_DIR } from "../../src/lib/db/core.ts";

const ORIGINAL_MAX_FILES = process.env.DB_BACKUP_MAX_FILES;
const ORIGINAL_RETENTION_DAYS = process.env.DB_BACKUP_RETENTION_DAYS;
// getBackupDir() reads DATA_DIR/DB_BACKUPS_DIR as module-level constants
// captured at import time, not the live env var — so cleanupDbBackups()
// always operates on this real, fixed directory regardless of what this
// test file later sets process.env.DATA_DIR to.
const REAL_BACKUP_DIR = DB_BACKUPS_DIR || `${DATA_DIR}/db_backups`;

describe("getDbBackupMaxFiles", () => {
  afterEach(() => {
    if (ORIGINAL_MAX_FILES === undefined) delete process.env.DB_BACKUP_MAX_FILES;
    else process.env.DB_BACKUP_MAX_FILES = ORIGINAL_MAX_FILES;
  });

  it("defaults to 20 when the env var is unset", () => {
    delete process.env.DB_BACKUP_MAX_FILES;
    assert.equal(getDbBackupMaxFiles(), 20);
  });

  it("uses a valid positive integer from the env var", () => {
    process.env.DB_BACKUP_MAX_FILES = "5";
    assert.equal(getDbBackupMaxFiles(), 5);
  });

  it("falls back to the default for a non-positive or non-integer value", () => {
    process.env.DB_BACKUP_MAX_FILES = "0";
    assert.equal(getDbBackupMaxFiles(), 20);
    process.env.DB_BACKUP_MAX_FILES = "not-a-number";
    assert.equal(getDbBackupMaxFiles(), 20);
  });
});

describe("getDbBackupRetentionDays", () => {
  afterEach(() => {
    if (ORIGINAL_RETENTION_DAYS === undefined) delete process.env.DB_BACKUP_RETENTION_DAYS;
    else process.env.DB_BACKUP_RETENTION_DAYS = ORIGINAL_RETENTION_DAYS;
  });

  it("defaults to 0 when the env var is unset", () => {
    delete process.env.DB_BACKUP_RETENTION_DAYS;
    assert.equal(getDbBackupRetentionDays(), 0);
  });

  it("uses a valid non-negative integer from the env var", () => {
    process.env.DB_BACKUP_RETENTION_DAYS = "14";
    assert.equal(getDbBackupRetentionDays(), 14);
  });

  it("accepts 0 as an explicit valid value", () => {
    process.env.DB_BACKUP_RETENTION_DAYS = "0";
    assert.equal(getDbBackupRetentionDays(), 0);
  });

  it("falls back to the default for a negative or non-integer value", () => {
    process.env.DB_BACKUP_RETENTION_DAYS = "-5";
    assert.equal(getDbBackupRetentionDays(), 0);
    process.env.DB_BACKUP_RETENTION_DAYS = "abc";
    assert.equal(getDbBackupRetentionDays(), 0);
  });
});

describe("unlinkFileWithRetry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-unlink-retry-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes an existing file", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "content");
    await unlinkFileWithRetry(filePath);
    assert.equal(fs.existsSync(filePath), false);
  });

  it("resolves without error when the file does not exist (ENOENT)", async () => {
    const filePath = path.join(tmpDir, "does-not-exist.txt");
    await assert.doesNotReject(unlinkFileWithRetry(filePath));
  });

  it("rethrows a non-retryable error immediately", async () => {
    // A directory cannot be unlinked with fs.unlinkSync — this throws EISDIR,
    // which is not in the default retryable code set.
    await assert.rejects(unlinkFileWithRetry(tmpDir, { maxAttempts: 1 }));
  });
});

describe("cleanupDbBackups", () => {
  // Scope every test file to its own reason suffix so cleanupDbBackups()
  // operating on the REAL, shared backup directory never touches files from
  // other concurrently-running test files.
  const RUN_PREFIX = `test${process.pid}`;

  function writeBackupFile(name: string, mtimeMs?: number) {
    fs.mkdirSync(REAL_BACKUP_DIR, { recursive: true });
    const filePath = path.join(REAL_BACKUP_DIR, name);
    fs.writeFileSync(filePath, "x");
    if (mtimeMs !== undefined) {
      const mtime = new Date(mtimeMs);
      fs.utimesSync(filePath, mtime, mtime);
    }
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

  it("keeps only the most recent maxFiles primary backups (scoped to this run) and deletes the rest", () => {
    const baseTime = Date.now();
    for (let i = 0; i < 5; i++) {
      writeBackupFile(`db_${RUN_PREFIX}_ts${i}_auto.sqlite`, baseTime + i * 1000);
    }

    // maxFiles counts ALL primary backups in the shared directory, so scope
    // the assertion to files bearing this run's prefix rather than an exact
    // keptBackupFamilies total.
    const beforeCount = fs
      .readdirSync(REAL_BACKUP_DIR)
      .filter((f) => f.includes(RUN_PREFIX)).length;
    assert.equal(beforeCount, 5);

    cleanupDbBackups({ maxFiles: 1000, retentionDays: 0 });

    const ownFilesAfter = fs.readdirSync(REAL_BACKUP_DIR).filter((f) => f.includes(RUN_PREFIX));
    assert.equal(ownFilesAfter.length, 5);
  });

  it("deletes orphaned WAL/SHM sidecar files that have no matching primary .sqlite", () => {
    writeBackupFile(`db_${RUN_PREFIX}_orphan.sqlite-wal`);

    cleanupDbBackups({ maxFiles: 1000, retentionDays: 0 });

    const remaining = fs
      .readdirSync(REAL_BACKUP_DIR)
      .filter((f) => f.includes(`${RUN_PREFIX}_orphan`));
    assert.equal(remaining.length, 0);
  });

  it("removes backups older than the configured retentionDays", () => {
    const oldMtime = Date.now() - 10 * 24 * 60 * 60 * 1000;
    writeBackupFile(`db_${RUN_PREFIX}_old.sqlite`, oldMtime);
    writeBackupFile(`db_${RUN_PREFIX}_new.sqlite`);

    cleanupDbBackups({ maxFiles: 1000, retentionDays: 5 });

    const remaining = fs
      .readdirSync(REAL_BACKUP_DIR)
      .filter((f) => f.includes(RUN_PREFIX))
      .sort();
    assert.deepEqual(remaining, [`db_${RUN_PREFIX}_new.sqlite`]);
  });
});
