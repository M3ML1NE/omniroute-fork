/**
 * E2E smoke: Atlassian MCP integration through the full pipeline.
 *
 * Wires a mock Atlassian HTTP server (T4 fixture) + the real MCP server
 * (createMcpServer, T13) + an in-memory MCP client (T14 SSE-equivalent transport).
 * Exercises tools/list and a representative call across all three services
 * (Jira / Bitbucket / Confluence), plus auth-failure and input-validation paths.
 *
 * Note: MCP SDK 1.29.0 converts BOTH handler-thrown errors AND Zod input
 * validation failures into a resolved CallToolResult with `isError: true`
 * (mcp.js CallToolRequest handler catch -> createToolError). It does not reject
 * the promise. Tests 7 and 8 therefore assert on `isError`, not on a throw.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _resetAtlassianConfigSingleton,
  getAtlassianConfig,
} from "../../open-sse/services/atlassianConfig.js";
import { createMcpServer } from "../../open-sse/mcp-server/index.js";
import {
  startMockAtlassian,
  type MockAtlassianServer,
} from "../fixtures/mock-atlassian-server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const TMP = join(tmpdir(), `atlassian-e2e-${Date.now()}`);
const FILE = join(TMP, "atlassian.json");

interface CallToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function configJson(jiraUser: string, jiraPass: string): string {
  return JSON.stringify({
    version: 1,
    jira: { enabled: true, base_url: MOCK_URL, username: jiraUser, password: jiraPass },
    bitbucket: { enabled: true, base_url: MOCK_URL, username: "svc", password: "secret" },
    confluence: { enabled: true, base_url: MOCK_URL, username: "svc", password: "secret" },
  });
}

let MOCK_URL = "";

describe("Atlassian MCP smoke (e2e)", () => {
  let mock: MockAtlassianServer;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;

  before(async () => {
    mkdirSync(TMP, { recursive: true });
    mock = await startMockAtlassian({ auth: { username: "svc", password: "secret" } });
    MOCK_URL = mock.url;

    process.env["OMNIROUTE_ATLASSIAN_CONFIG_PATH"] = FILE;
    writeFileSync(FILE, configJson("svc", "secret"));
    _resetAtlassianConfigSingleton();
    await getAtlassianConfig().load();

    server = createMcpServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "atlassian-e2e-client", version: "1.0" }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  after(async () => {
    await client.close();
    await server.close();
    await mock.close();
    _resetAtlassianConfigSingleton();
    delete process.env["OMNIROUTE_ATLASSIAN_CONFIG_PATH"];
    rmSync(TMP, { recursive: true, force: true });
  });

  it("1: tools/list returns 12 Atlassian tools", async () => {
    const result = await client.listTools();
    assert.equal(result.tools.length, 12, `Expected 12 tools, got ${result.tools.length}`);
  });

  it("2: jira_get_issue returns parsed issue from mock", async () => {
    const result = await client.callTool({
      name: "jira_get_issue",
      arguments: { key: "PROJ-1" },
    });
    const r = result as unknown as CallToolResult;
    assert.equal(r.isError, undefined);
    const issue = JSON.parse(r.content[0].text);
    assert.equal(issue.key, "PROJ-1");
  });

  it("3: jira_search posts JQL to mock /rest/api/2/search", async () => {
    const result = await client.callTool({
      name: "jira_search",
      arguments: { jql: "project = PROJ" },
    });
    const r = result as unknown as CallToolResult;
    assert.equal(r.isError, undefined);
    const body = JSON.parse(r.content[0].text);
    assert.ok(Array.isArray(body.issues));
    assert.equal(mock.lastRequest?.method, "POST");
    assert.equal(mock.lastRequest?.path, "/rest/api/2/search");
  });

  it("4: jira_create_issue posts fields to mock and returns created key", async () => {
    const result = await client.callTool({
      name: "jira_create_issue",
      arguments: { project_key: "PROJ", issue_type: "Task", summary: "E2E test issue" },
    });
    const r = result as unknown as CallToolResult;
    assert.equal(r.isError, undefined);
    const issue = JSON.parse(r.content[0].text);
    assert.ok(issue.key);
    const reqBody = mock.lastRequest?.body as { fields: { project: { key: string } } };
    assert.equal(reqBody.fields.project.key, "PROJ");
  });

  it("5: bitbucket_list_prs returns PR values from mock", async () => {
    const result = await client.callTool({
      name: "bitbucket_list_prs",
      arguments: { project: "DEV", repo: "repo", state: "OPEN" },
    });
    const r = result as unknown as CallToolResult;
    assert.equal(r.isError, undefined);
    const list = JSON.parse(r.content[0].text);
    assert.ok(Array.isArray(list.values));
  });

  it("6: confluence_get_page returns page from mock", async () => {
    const result = await client.callTool({
      name: "confluence_get_page",
      arguments: { page_id: "12345" },
    });
    const r = result as unknown as CallToolResult;
    assert.equal(r.isError, undefined);
    const page = JSON.parse(r.content[0].text);
    assert.equal(page.id, "12345");
  });

  it("7: wrong credentials surface a 401 error envelope through MCP", async () => {
    // Reload config with wrong Jira credentials (manual reload; no watcher in tests).
    writeFileSync(FILE, configJson("wrong", "wrong"));
    await getAtlassianConfig().load();

    const result = await client.callTool({
      name: "jira_get_issue",
      arguments: { key: "PROJ-1" },
    });
    const r = result as unknown as CallToolResult;
    assert.equal(r.isError, true, "wrong credentials should yield isError result");
    const msg = r.content[0].text;
    assert.ok(
      msg.includes("401") || msg.includes("Unauthorized") || msg.includes("failed"),
      `error text should signal auth failure, got: ${msg}`,
    );

    // Restore valid credentials for any subsequent assertions.
    writeFileSync(FILE, configJson("svc", "secret"));
    await getAtlassianConfig().load();
  });

  it("8: invalid input rejected by Zod before client call (missing required field)", async () => {
    // jira_get_issue requires `key`; omit it.
    const result = await client.callTool({
      name: "jira_get_issue",
      arguments: {},
    });
    const r = result as unknown as CallToolResult;
    assert.equal(r.isError, true, "missing required field should yield isError result");
    const msg = r.content[0].text;
    assert.ok(
      msg.includes("validation") || msg.includes("Invalid arguments") || msg.includes("key"),
      `error text should signal validation failure, got: ${msg}`,
    );
  });
});
