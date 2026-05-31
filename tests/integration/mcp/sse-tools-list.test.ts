/**
 * Integration test: MCP server lists all 12 Atlassian tools via InMemoryTransport.
 * Verifies that createMcpServer() (used by SSE route) exposes the correct tool set.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _resetAtlassianConfigSingleton,
  getAtlassianConfig,
} from "../../../open-sse/services/atlassianConfig.js";
import { createMcpServer } from "../../../open-sse/mcp-server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const TMP = join(tmpdir(), `sse-wire-test-${Date.now()}`);
const FILE = join(TMP, "atlassian.json");

describe("MCP server Atlassian tools (in-memory SSE-equivalent)", () => {
  before(async () => {
    mkdirSync(TMP, { recursive: true });
    process.env["OMNIROUTE_ATLASSIAN_CONFIG_PATH"] = FILE;
    writeFileSync(
      FILE,
      JSON.stringify({
        version: 1,
        jira: { enabled: true, base_url: "https://x", username: "u", password: "p" },
        bitbucket: { enabled: true, base_url: "https://x", username: "u", password: "p" },
        confluence: { enabled: true, base_url: "https://x", username: "u", password: "p" },
      }),
    );
    _resetAtlassianConfigSingleton();
    await getAtlassianConfig().load();
  });

  after(() => {
    delete process.env["OMNIROUTE_ATLASSIAN_CONFIG_PATH"];
    _resetAtlassianConfigSingleton();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("lists all 12 Atlassian tools via initialize+tools/list", async () => {
    const server = createMcpServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "test-client", version: "1.0" },
      { capabilities: {} },
    );

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.listTools();
    assert.equal(result.tools.length, 12, `Expected 12 tools, got ${result.tools.length}`);

    const names = result.tools.map((t) => t.name).sort();
    const expected = [
      "bitbucket_add_pr_comment",
      "bitbucket_create_pr",
      "bitbucket_get_pr",
      "bitbucket_list_prs",
      "confluence_create_page",
      "confluence_get_page",
      "confluence_search",
      "confluence_update_page",
      "jira_add_comment",
      "jira_create_issue",
      "jira_get_issue",
      "jira_search",
    ];
    assert.deepEqual(names, expected);

    await client.close();
    await server.close();
  });
});
