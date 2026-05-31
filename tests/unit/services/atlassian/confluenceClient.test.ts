import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ConfluenceClient } from "../../../../open-sse/services/atlassian/confluenceClient.js";
import {
  startMockAtlassian,
  type MockAtlassianServer,
} from "../../../fixtures/mock-atlassian-server.js";
import type { AtlassianServiceConfig } from "../../../../open-sse/types/atlassianConfig.js";

describe("ConfluenceClient", () => {
  let mock: MockAtlassianServer;
  let client: ConfluenceClient;

  before(async () => {
    mock = await startMockAtlassian();
    const cfg: AtlassianServiceConfig = {
      enabled: true,
      base_url: mock.url,
      username: "svc",
      password: "secret",
    };
    client = new ConfluenceClient(cfg);
  });

  after(async () => {
    await mock.close();
  });

  it("getPage returns page with version", async () => {
    const page = await client.getPage("12345");
    assert.equal(page.id, "12345");
    assert.equal(page.version?.number, 1);
  });

  it("getPage adds default expand=body.storage,version,space", async () => {
    await client.getPage("99999");
    assert.ok(mock.lastRequest?.path.includes("expand="));
    assert.ok(mock.lastRequest?.path.includes("body.storage"));
    assert.ok(mock.lastRequest?.path.includes("version"));
    assert.ok(mock.lastRequest?.path.includes("space"));
  });

  it("search passes cql query string and limit", async () => {
    const res = await client.search('space = "DEV"', { limit: 10 });
    assert.ok(Array.isArray(res.results));
    assert.ok(mock.lastRequest?.path.includes("cql="));
    assert.ok(mock.lastRequest?.path.includes("limit=10"));
  });

  it("createPage sends correct shape with storage representation", async () => {
    const page = await client.createPage({
      space_key: "DEV",
      title: "Test page",
      body: "<p>Hello</p>",
    });
    assert.ok(page.id);
    const body = mock.lastRequest?.body as {
      space: { key: string };
      body: { storage: { representation: string } };
    };
    assert.equal(body.space.key, "DEV");
    assert.equal(body.body.storage.representation, "storage");
  });

  it("createPage with parent_id includes ancestors", async () => {
    await client.createPage({
      space_key: "DEV",
      title: "Child",
      body: "<p>x</p>",
      parent_id: "1000",
    });
    const body = mock.lastRequest?.body as { ancestors: Array<{ id: string }> };
    assert.ok(Array.isArray(body.ancestors));
    assert.equal(body.ancestors[0].id, "1000");
  });

  it("updatePage auto-increments version when version_number not provided", async () => {
    const updated = await client.updatePage("12345", {
      title: "Updated",
      body: "<p>new</p>",
    });
    assert.ok(updated.id);
    // Mock GET returns version 1, so PUT should send version 2
    const body = mock.lastRequest?.body as { version: { number: number } };
    assert.equal(body.version.number, 2);
  });

  it("updatePage with explicit version_number does NOT fetch first", async () => {
    mock.history.length = 0; // reset history
    await client.updatePage("12345", {
      title: "T",
      body: "<p>x</p>",
      version_number: 10,
    });
    // Only 1 request (PUT), no prior GET
    assert.equal(mock.history.length, 1);
    assert.equal(mock.history[0].method, "PUT");
    const body = mock.history[0].body as { version: { number: number } };
    assert.equal(body.version.number, 10);
  });

  it("Basic auth header is sent on requests", async () => {
    await client.getPage("12345");
    assert.ok(mock.lastRequest?.authHeader?.startsWith("Basic "));
  });
});
