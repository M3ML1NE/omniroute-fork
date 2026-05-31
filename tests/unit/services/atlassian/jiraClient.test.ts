import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { JiraClient } from "../../../../open-sse/services/atlassian/jiraClient.js";
import {
  startMockAtlassian,
  type MockAtlassianServer,
} from "../../../fixtures/mock-atlassian-server.js";
import type { AtlassianServiceConfig } from "../../../../open-sse/types/atlassianConfig.js";

describe("JiraClient", () => {
  let mock: MockAtlassianServer;
  let client: JiraClient;

  before(async () => {
    mock = await startMockAtlassian();
    const config: AtlassianServiceConfig = {
      enabled: true,
      base_url: mock.url,
      username: "svc",
      password: "secret",
    };
    client = new JiraClient(config);
  });

  after(async () => {
    await mock.close();
  });

  it("getIssue returns parsed issue", async () => {
    const issue = await client.getIssue("PROJ-1");
    assert.equal(issue.key, "PROJ-1");
    assert.ok(issue.fields.summary);
  });

  it("getIssue fields adds query string", async () => {
    await client.getIssue("PROJ-2", { fields: ["summary", "status"] });
    assert.ok(mock.lastRequest?.path.includes("fields="));
  });

  it("search posts JQL returns results", async () => {
    const res = await client.search("project = PROJ", { maxResults: 25 });
    assert.ok(Array.isArray(res.issues));
    assert.equal(mock.lastRequest?.method, "POST");
    assert.equal(mock.lastRequest?.path, "/rest/api/2/search");
  });

  it("createIssue sends correct fields wrapper", async () => {
    const issue = await client.createIssue({
      project_key: "PROJ",
      issue_type: "Task",
      summary: "Test issue",
    });
    assert.ok(issue.key);
    const body = mock.lastRequest?.body as {
      fields: { project: { key: string } };
    };
    assert.equal(body.fields.project.key, "PROJ");
  });

  it("addComment posts body to correct path", async () => {
    const c = await client.addComment("PROJ-3", "Test comment");
    assert.ok(c.id);
    assert.equal(
      mock.lastRequest?.path,
      "/rest/api/2/issue/PROJ-3/comment",
    );
  });

  it("Basic auth header sent on all requests", async () => {
    await client.getIssue("PROJ-4");
    assert.ok(mock.lastRequest?.authHeader?.startsWith("Basic "));
  });

  it("4xx response throws Error with status", async () => {
    const authMock = await startMockAtlassian({
      auth: { username: "real", password: "real" },
    });
    try {
      const wrongClient = new JiraClient({
        enabled: true,
        base_url: authMock.url,
        username: "wrong",
        password: "wrong",
      });
      await assert.rejects(
        () => wrongClient.getIssue("PROJ-1"),
        /401/,
      );
    } finally {
      await authMock.close();
    }
  });
});
