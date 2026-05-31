import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { BitbucketClient } from "../../../../open-sse/services/atlassian/bitbucketClient.js";
import {
  startMockAtlassian,
  type MockAtlassianServer,
} from "../../../fixtures/mock-atlassian-server.js";
import type { AtlassianServiceConfig } from "../../../../open-sse/types/atlassianConfig.js";

describe("BitbucketClient", () => {
  let mock: MockAtlassianServer;
  let client: BitbucketClient;

  before(async () => {
    mock = await startMockAtlassian();
    const cfg: AtlassianServiceConfig = {
      enabled: true,
      base_url: mock.url,
      username: "svc",
      password: "secret",
    };
    client = new BitbucketClient(cfg);
  });

  after(async () => {
    await mock.close();
  });

  it("listPullRequests returns paged values", async () => {
    const list = await client.listPullRequests("DEV", "repo");
    assert.ok(Array.isArray(list.values));
    assert.equal(list.size, 1);
  });

  it("listPullRequests state filter adds query param", async () => {
    await client.listPullRequests("DEV", "repo", { state: "OPEN", limit: 10 });
    assert.ok(mock.lastRequest?.path.includes("state=OPEN"));
    assert.ok(mock.lastRequest?.path.includes("limit=10"));
  });

  it("getPullRequest returns detail", async () => {
    const pr = await client.getPullRequest("DEV", "repo", 100);
    assert.equal(pr.id, 100);
  });

  it("createPullRequest sends correct fromRef/toRef", async () => {
    const pr = await client.createPullRequest("DEV", "repo", {
      title: "Test PR",
      source_branch: "feature/x",
      target_branch: "main",
    });
    assert.ok(pr.id);
    const body = mock.lastRequest?.body as { fromRef: { id: string }; toRef: { id: string } };
    assert.equal(body.fromRef.id, "refs/heads/feature/x");
    assert.equal(body.toRef.id, "refs/heads/main");
  });

  it("createPullRequest accepts already-prefixed refs", async () => {
    await client.createPullRequest("DEV", "repo", {
      title: "PR",
      source_branch: "refs/heads/feature",
      target_branch: "refs/heads/main",
    });
    const body = mock.lastRequest?.body as { fromRef: { id: string } };
    assert.equal(body.fromRef.id, "refs/heads/feature");
  });

  it("addPullRequestComment posts text", async () => {
    const c = await client.addPullRequestComment("DEV", "repo", 100, "Comment text");
    assert.ok(c.id);
    assert.equal(
      mock.lastRequest?.path,
      "/rest/api/1.0/projects/DEV/repos/repo/pull-requests/100/comments",
    );
    const body = mock.lastRequest?.body as { text: string };
    assert.equal(body.text, "Comment text");
  });

  it("Basic auth header sent", async () => {
    await client.getPullRequest("DEV", "repo", 100);
    assert.ok(mock.lastRequest?.authHeader?.startsWith("Basic "));
  });
});
