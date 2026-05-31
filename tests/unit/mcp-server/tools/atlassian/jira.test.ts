import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { jiraTools } from "../../../../../open-sse/mcp-server/tools/atlassian/jira.js";
import {
  startMockAtlassian,
  type MockAtlassianServer,
} from "../../../../fixtures/mock-atlassian-server.js";
import {
  _resetAtlassianConfigSingleton,
  getAtlassianConfig,
} from "../../../../../open-sse/services/atlassianConfig.js";

const TMP = join(tmpdir(), `jira-tools-test-${Date.now()}`);
const FILE = join(TMP, "atlassian.json");

describe("jira MCP tools", () => {
  let mock: MockAtlassianServer;

  before(async () => {
    mkdirSync(TMP, { recursive: true });
    mock = await startMockAtlassian();
    process.env["OMNIROUTE_ATLASSIAN_CONFIG_PATH"] = FILE;
    writeFileSync(
      FILE,
      JSON.stringify({
        version: 1,
        jira: {
          enabled: true,
          base_url: mock.url,
          username: "svc",
          password: "secret",
        },
      }),
    );
    _resetAtlassianConfigSingleton();
    await getAtlassianConfig().load();
  });

  after(async () => {
    await mock.close();
    _resetAtlassianConfigSingleton();
    delete process.env["OMNIROUTE_ATLASSIAN_CONFIG_PATH"];
    rmSync(TMP, { recursive: true, force: true });
  });

  it("exports 4 tools", () => {
    assert.equal(jiraTools.length, 4);
    const names = jiraTools.map((t) => t.name);
    assert.ok(names.includes("jira_get_issue"));
    assert.ok(names.includes("jira_search"));
    assert.ok(names.includes("jira_create_issue"));
    assert.ok(names.includes("jira_add_comment"));
  });

  it("jira_get_issue handler returns JSON content", async () => {
    const tool = jiraTools.find((t) => t.name === "jira_get_issue")!;
    const result = await tool.handler({ key: "PROJ-1" });
    assert.equal(result.content[0].type, "text");
    const issue = JSON.parse(result.content[0].text);
    assert.equal(issue.key, "PROJ-1");
  });

  it("jira_search passes JQL via POST to /rest/api/2/search", async () => {
    const tool = jiraTools.find((t) => t.name === "jira_search")!;
    await tool.handler({ jql: "project = PROJ" });
    assert.equal(mock.lastRequest?.method, "POST");
    assert.equal(mock.lastRequest?.path, "/rest/api/2/search");
  });

  it("jira_create_issue posts correct project key", async () => {
    const tool = jiraTools.find((t) => t.name === "jira_create_issue")!;
    await tool.handler({
      project_key: "PROJ",
      issue_type: "Task",
      summary: "Test issue",
    });
    const body = mock.lastRequest?.body as {
      fields: { project: { key: string } };
    };
    assert.equal(body.fields.project.key, "PROJ");
  });

  it("jira_add_comment posts comment to correct endpoint", async () => {
    const tool = jiraTools.find((t) => t.name === "jira_add_comment")!;
    await tool.handler({ issue_key: "PROJ-1", body: "Comment text" });
    assert.equal(mock.lastRequest?.path, "/rest/api/2/issue/PROJ-1/comment");
    const body = mock.lastRequest?.body as { body: string };
    assert.equal(body.body, "Comment text");
  });

  it("Zod schema rejects missing required field", () => {
    const tool = jiraTools.find((t) => t.name === "jira_get_issue")!;
    const result = tool.inputSchema.safeParse({});
    assert.equal(result.success, false);
  });

  it("disabled service throws clear error", async () => {
    writeFileSync(
      FILE,
      JSON.stringify({
        version: 1,
        jira: {
          enabled: false,
          base_url: mock.url,
          username: "svc",
          password: "secret",
        },
      }),
    );
    _resetAtlassianConfigSingleton();
    await getAtlassianConfig().load();

    const tool = jiraTools.find((t) => t.name === "jira_get_issue")!;
    await assert.rejects(() => tool.handler({ key: "PROJ-1" }), /disabled/);

    // Restore enabled config for any subsequent tests
    writeFileSync(
      FILE,
      JSON.stringify({
        version: 1,
        jira: {
          enabled: true,
          base_url: mock.url,
          username: "svc",
          password: "secret",
        },
      }),
    );
    _resetAtlassianConfigSingleton();
    await getAtlassianConfig().load();
  });
});
