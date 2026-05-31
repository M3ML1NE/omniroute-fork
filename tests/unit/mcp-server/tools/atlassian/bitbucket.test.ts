import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bitbucketTools } from "../../../../../open-sse/mcp-server/tools/atlassian/bitbucket.js";
import {
  startMockAtlassian,
  type MockAtlassianServer,
} from "../../../../fixtures/mock-atlassian-server.js";
import {
  _resetAtlassianConfigSingleton,
  getAtlassianConfig,
} from "../../../../../open-sse/services/atlassianConfig.js";

const TMP = join(tmpdir(), `bitbucket-tools-test-${Date.now()}`);
const FILE = join(TMP, "atlassian.json");

describe("bitbucket MCP tools", () => {
  let mock: MockAtlassianServer;

  before(async () => {
    mkdirSync(TMP, { recursive: true });
    mock = await startMockAtlassian();
    process.env["OMNIROUTE_ATLASSIAN_CONFIG_PATH"] = FILE;
    writeFileSync(
      FILE,
      JSON.stringify({
        version: 1,
        bitbucket: {
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
    assert.equal(bitbucketTools.length, 4);
    const names = bitbucketTools.map((t) => t.name);
    assert.ok(names.includes("bitbucket_list_prs"));
    assert.ok(names.includes("bitbucket_get_pr"));
    assert.ok(names.includes("bitbucket_create_pr"));
    assert.ok(names.includes("bitbucket_add_pr_comment"));
  });

  it("bitbucket_list_prs handler returns JSON content with PR list", async () => {
    const tool = bitbucketTools.find((t) => t.name === "bitbucket_list_prs")!;
    const result = await tool.handler({ project: "DEV", repo: "my-repo" });
    assert.equal(result.content[0].type, "text");
    const list = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(list.values));
    assert.equal(list.values[0].id, 100);
  });

  it("bitbucket_get_pr handler returns single PR details", async () => {
    const tool = bitbucketTools.find((t) => t.name === "bitbucket_get_pr")!;
    const result = await tool.handler({ project: "DEV", repo: "my-repo", pr_id: 42 });
    assert.equal(result.content[0].type, "text");
    const pr = JSON.parse(result.content[0].text);
    assert.equal(pr.id, 42);
    assert.equal(pr.title, "Mock detail");
  });

  it("bitbucket_create_pr posts to correct endpoint and returns PR", async () => {
    const tool = bitbucketTools.find((t) => t.name === "bitbucket_create_pr")!;
    const result = await tool.handler({
      project: "DEV",
      repo: "my-repo",
      title: "My new PR",
      source_branch: "feature/x",
      target_branch: "main",
    });
    assert.equal(mock.lastRequest?.method, "POST");
    assert.ok(mock.lastRequest?.path.endsWith("/pull-requests"));
    const pr = JSON.parse(result.content[0].text);
    assert.equal(pr.state, "OPEN");
  });

  it("bitbucket_add_pr_comment posts comment to correct endpoint", async () => {
    const tool = bitbucketTools.find((t) => t.name === "bitbucket_add_pr_comment")!;
    const result = await tool.handler({
      project: "DEV",
      repo: "my-repo",
      pr_id: 100,
      text: "Looks good!",
    });
    assert.equal(mock.lastRequest?.method, "POST");
    assert.ok(mock.lastRequest?.path.includes("/pull-requests/100/comments"));
    const comment = JSON.parse(result.content[0].text);
    assert.equal(comment.id, 30001);
  });

  it("Zod schema rejects missing required fields", () => {
    const tool = bitbucketTools.find((t) => t.name === "bitbucket_list_prs")!;
    const result = tool.inputSchema.safeParse({});
    assert.equal(result.success, false);
  });

  it("disabled service throws clear error", async () => {
    writeFileSync(
      FILE,
      JSON.stringify({
        version: 1,
        bitbucket: {
          enabled: false,
          base_url: mock.url,
          username: "svc",
          password: "secret",
        },
      }),
    );
    _resetAtlassianConfigSingleton();
    await getAtlassianConfig().load();

    const tool = bitbucketTools.find((t) => t.name === "bitbucket_list_prs")!;
    await assert.rejects(() => tool.handler({ project: "DEV", repo: "my-repo" }), /disabled/);

    // Restore enabled config for any subsequent tests
    writeFileSync(
      FILE,
      JSON.stringify({
        version: 1,
        bitbucket: {
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
