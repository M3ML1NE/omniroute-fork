import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  _resetAtlassianConfigSingleton,
  getAtlassianConfig,
} from "../../../open-sse/services/atlassianConfig.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createMcpServer,
  registerAtlassianTools,
} from "../../../open-sse/mcp-server/server.ts";
import { jiraTools } from "../../../open-sse/mcp-server/tools/atlassian/jira.ts";
import { bitbucketTools } from "../../../open-sse/mcp-server/tools/atlassian/bitbucket.ts";
import { confluenceTools } from "../../../open-sse/mcp-server/tools/atlassian/confluence.ts";

const TMP = join(tmpdir(), `mcp-reg-test-${Date.now()}`);
const FILE = join(TMP, "atlassian.json");

const svc = (enabled: boolean) => ({
  enabled,
  base_url: "https://example.atlassian.net",
  username: "u",
  password: "p",
});

async function listToolNames(): Promise<string[]> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

describe("Atlassian tool registration", () => {
  before(() => {
    mkdirSync(TMP, { recursive: true });
    process.env.OMNIROUTE_ATLASSIAN_CONFIG_PATH = FILE;
  });

  after(() => {
    delete process.env.OMNIROUTE_ATLASSIAN_CONFIG_PATH;
    _resetAtlassianConfigSingleton();
    rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    _resetAtlassianConfigSingleton();
  });

  afterEach(() => {
    _resetAtlassianConfigSingleton();
  });

  it("exposes 12 tools across the three collections", () => {
    assert.equal(
      jiraTools.length + bitbucketTools.length + confluenceTools.length,
      12,
    );
  });

  it("every tool has a unique name", () => {
    const all = [...jiraTools, ...bitbucketTools, ...confluenceTools];
    const names = new Set(all.map((t) => t.name));
    assert.equal(names.size, all.length);
  });

  it("registers 0 tools when config is never loaded", () => {
    const count = registerAtlassianTools(new McpServer({ name: "t", version: "1" }));
    assert.equal(count, 0);
  });

  it("registers all 12 tools when all three services are enabled", async () => {
    writeFileSync(
      FILE,
      JSON.stringify({
        version: 1,
        jira: svc(true),
        bitbucket: svc(true),
        confluence: svc(true),
      }),
    );
    await getAtlassianConfig().load();
    const names = await listToolNames();
    assert.equal(names.length, 12);
    assert.ok(names.includes("jira_get_issue"));
    assert.ok(names.includes("bitbucket_list_prs"));
    assert.ok(names.includes("confluence_get_page"));
  });

  it("registers only the 4 jira tools when bitbucket is disabled and confluence absent", async () => {
    writeFileSync(
      FILE,
      JSON.stringify({
        version: 1,
        jira: svc(true),
        bitbucket: svc(false),
      }),
    );
    await getAtlassianConfig().load();
    const names = await listToolNames();
    assert.equal(names.length, jiraTools.length);
    assert.ok(names.every((n) => n.startsWith("jira_")));
  });
});
