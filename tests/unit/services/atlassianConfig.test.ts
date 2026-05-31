import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AtlassianConfig,
  _resetAtlassianConfigSingleton,
  _redactServiceForLog,
} from "../../../open-sse/services/atlassianConfig.js";

const TMP = join(tmpdir(), `atl-test-${Date.now()}-${process.pid}`);
const FILE = join(TMP, "atlassian.json");

const VALID = {
  version: 1,
  jira: {
    enabled: true,
    base_url: "https://jira.local",
    username: "svc",
    password: "secret-12345",
  },
  bitbucket: {
    enabled: true,
    base_url: "https://bb.local",
    username: "svc",
    password: "pwd",
  },
  confluence: {
    enabled: false,
    base_url: "https://conf.local",
    username: "svc",
    password: "pwd",
  },
};

before(() => {
  mkdirSync(TMP, { recursive: true });
});
after(() => {
  rmSync(TMP, { recursive: true, force: true });
  _resetAtlassianConfigSingleton();
});

describe("AtlassianConfig", () => {
  it("loads valid file and get(service) returns config", async () => {
    writeFileSync(FILE, JSON.stringify(VALID));
    const c = new AtlassianConfig(FILE);
    await c.load();
    assert.equal(c.get("jira")?.base_url, "https://jira.local");
    assert.equal(c.get("bitbucket")?.username, "svc");
  });

  it("list() filters by enabled flag", async () => {
    writeFileSync(FILE, JSON.stringify(VALID));
    const c = new AtlassianConfig(FILE);
    await c.load();
    const enabled = c.list();
    assert.ok(enabled.includes("jira"));
    assert.ok(enabled.includes("bitbucket"));
    assert.ok(!enabled.includes("confluence"));
  });

  it("listAll() returns all configured services regardless of enabled", async () => {
    writeFileSync(FILE, JSON.stringify(VALID));
    const c = new AtlassianConfig(FILE);
    await c.load();
    assert.equal(c.listAll().length, 3);
  });

  it("get() returns undefined for absent service", async () => {
    const partial = { version: 1, jira: VALID.jira };
    writeFileSync(FILE, JSON.stringify(partial));
    const c = new AtlassianConfig(FILE);
    await c.load();
    assert.equal(c.get("bitbucket"), undefined);
  });

  it("invalid JSON throws and keeps old state", async () => {
    writeFileSync(FILE, JSON.stringify(VALID));
    const c = new AtlassianConfig(FILE);
    await c.load();
    assert.equal(c.list().length, 2);
    writeFileSync(FILE, "not json");
    await assert.rejects(() => c.load());
    assert.equal(c.list().length, 2); // old state preserved
  });

  it("hot-reload updates within 1 second", async () => {
    const hotFile = join(TMP, "hot.json");
    writeFileSync(hotFile, JSON.stringify({ version: 1, jira: VALID.jira }));
    const c = new AtlassianConfig(hotFile);
    await c.load();
    assert.equal(c.list().length, 1);
    c.watch();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    writeFileSync(hotFile, JSON.stringify(VALID));
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    c.stop();
    assert.equal(c.list().length, 2); // jira + bitbucket enabled (confluence disabled)
  });

  it("redacts password in log output", () => {
    const svc = VALID.jira;
    const red = _redactServiceForLog(svc);
    assert.equal(red["password"], "***2345");
    assert.equal(red["base_url"], "https://jira.local");
  });
});
