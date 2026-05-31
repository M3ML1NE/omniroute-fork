import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { confluenceTools } from "../../../../../open-sse/mcp-server/tools/atlassian/confluence.js";
import {
  startMockAtlassian,
  type MockAtlassianServer,
} from "../../../../fixtures/mock-atlassian-server.js";
import {
  _resetAtlassianConfigSingleton,
  getAtlassianConfig,
} from "../../../../../open-sse/services/atlassianConfig.js";

const TMP = join(tmpdir(), `confluence-tools-test-${Date.now()}`);
const FILE = join(TMP, "atlassian.json");

describe("confluence MCP tools", () => {
  let mock: MockAtlassianServer;

  before(async () => {
    mkdirSync(TMP, { recursive: true });
    mock = await startMockAtlassian();
    process.env["OMNIROUTE_ATLASSIAN_CONFIG_PATH"] = FILE;
    writeFileSync(
      FILE,
      JSON.stringify({
        version: 1,
        confluence: {
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
    assert.equal(confluenceTools.length, 4);
    const names = confluenceTools.map((t) => t.name);
    assert.ok(names.includes("confluence_get_page"));
    assert.ok(names.includes("confluence_search"));
    assert.ok(names.includes("confluence_create_page"));
    assert.ok(names.includes("confluence_update_page"));
  });

  it("confluence_get_page handler returns page JSON", async () => {
    const tool = confluenceTools.find((t) => t.name === "confluence_get_page")!;
    const result = await tool.handler({ page_id: "12345" });
    assert.equal(result.content[0].type, "text");
    const page = JSON.parse(result.content[0].text);
    assert.equal(page.id, "12345");
    assert.equal(page.title, "Mock Confluence page");
    assert.equal(page.type, "page");
  });

  it("confluence_get_page passes expand param", async () => {
    const tool = confluenceTools.find((t) => t.name === "confluence_get_page")!;
    const result = await tool.handler({
      page_id: "12345",
      expand: ["body.storage", "version"],
    });
    assert.equal(result.content[0].type, "text");
    const page = JSON.parse(result.content[0].text);
    assert.ok(page.id);
    // verify GET request was made
    assert.equal(mock.lastRequest?.method, "GET");
    assert.ok(mock.lastRequest?.path.includes("/rest/api/content/12345"));
  });

  it("confluence_search returns results array", async () => {
    const tool = confluenceTools.find((t) => t.name === "confluence_search")!;
    const result = await tool.handler({ cql: 'space = "DEV" AND type = "page"' });
    assert.equal(result.content[0].type, "text");
    const data = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(data.results));
    assert.equal(data.results[0].id, "12345");
    assert.equal(data.results[0].title, "Mock search result");
  });

  it("confluence_search passes limit param", async () => {
    const tool = confluenceTools.find((t) => t.name === "confluence_search")!;
    const result = await tool.handler({ cql: 'type = "page"', limit: 10 });
    assert.equal(result.content[0].type, "text");
    assert.equal(mock.lastRequest?.method, "GET");
    assert.ok(mock.lastRequest?.path.includes("limit=10"));
  });

  it("confluence_create_page posts to correct endpoint returns page", async () => {
    const tool = confluenceTools.find((t) => t.name === "confluence_create_page")!;
    const result = await tool.handler({
      space_key: "DEV",
      title: "New Test Page",
      body: "<p>Hello world</p>",
    });
    assert.equal(mock.lastRequest?.method, "POST");
    assert.ok(mock.lastRequest?.path.endsWith("/rest/api/content"));
    const page = JSON.parse(result.content[0].text);
    assert.equal(page.id, "67890");
    assert.equal(page.type, "page");
  });

  it("confluence_create_page with parent_id sets ancestors", async () => {
    const tool = confluenceTools.find((t) => t.name === "confluence_create_page")!;
    const result = await tool.handler({
      space_key: "DEV",
      title: "Child Page",
      body: "<p>Child content</p>",
      parent_id: "11111",
    });
    assert.equal(mock.lastRequest?.method, "POST");
    const body = mock.lastRequest?.body as { ancestors?: { id: string }[] };
    assert.ok(Array.isArray(body?.ancestors));
    assert.equal(body.ancestors![0].id, "11111");
    const page = JSON.parse(result.content[0].text);
    assert.ok(page.id);
  });

  it("confluence_update_page puts to correct endpoint auto-increments version", async () => {
    const tool = confluenceTools.find((t) => t.name === "confluence_update_page")!;
    const result = await tool.handler({
      page_id: "12345",
      title: "Updated Title",
      body: "<p>Updated content</p>",
    });
    // updatePage first GETs current version, then PUTs
    assert.equal(mock.lastRequest?.method, "PUT");
    assert.ok(mock.lastRequest?.path.includes("/rest/api/content/12345"));
    const page = JSON.parse(result.content[0].text);
    assert.equal(page.id, "12345");
    assert.equal(page.title, "Updated Title");
    // version should be incremented (mock returns number: 2)
    assert.equal(page.version.number, 2);
  });

  it("Zod schema rejects missing required fields", () => {
    const tool = confluenceTools.find((t) => t.name === "confluence_get_page")!;
    const result = tool.inputSchema.safeParse({});
    assert.equal(result.success, false);
  });

  it("Zod schema rejects empty page_id", () => {
    const tool = confluenceTools.find((t) => t.name === "confluence_get_page")!;
    const result = tool.inputSchema.safeParse({ page_id: "" });
    assert.equal(result.success, false);
  });

  it("disabled service throws clear error", async () => {
    writeFileSync(
      FILE,
      JSON.stringify({
        version: 1,
        confluence: {
          enabled: false,
          base_url: mock.url,
          username: "svc",
          password: "secret",
        },
      }),
    );
    _resetAtlassianConfigSingleton();
    await getAtlassianConfig().load();

    const tool = confluenceTools.find((t) => t.name === "confluence_get_page")!;
    await assert.rejects(() => tool.handler({ page_id: "12345" }), /disabled/);

    // Restore enabled config for any subsequent tests
    writeFileSync(
      FILE,
      JSON.stringify({
        version: 1,
        confluence: {
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
