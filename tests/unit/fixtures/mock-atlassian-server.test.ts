import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMockAtlassian, MockAtlassianServer } from "../../../tests/fixtures/mock-atlassian-server.js";

describe("mock Atlassian server", () => {
  let mock: MockAtlassianServer;

  before(async () => {
    mock = await startMockAtlassian();
  });

  after(async () => {
    await mock.close();
  });

  it("Jira GET issue returns issue object", async () => {
    const r = await fetch(`${mock.url}/rest/api/2/issue/PROJ-1`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { key: string; fields: { summary: string } };
    assert.equal(body.key, "PROJ-1");
    assert.ok(body.fields.summary.includes("PROJ-1"));
  });

  it("Jira POST search returns issues array", async () => {
    const r = await fetch(`${mock.url}/rest/api/2/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jql: "project = PROJ" }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { issues: unknown[] };
    assert.ok(Array.isArray(body.issues));
    assert.ok(body.issues.length > 0);
  });

  it("Jira POST create issue returns 201 with key", async () => {
    const r = await fetch(`${mock.url}/rest/api/2/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { summary: "New issue", issuetype: { name: "Task" } } }),
    });
    assert.equal(r.status, 201);
    const body = (await r.json()) as { id: string; key: string };
    assert.ok(body.id);
    assert.ok(body.key);
  });

  it("Jira POST comment returns 201 with body", async () => {
    const r = await fetch(`${mock.url}/rest/api/2/issue/PROJ-1/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Test comment" }),
    });
    assert.equal(r.status, 201);
    const body = (await r.json()) as { id: string; body: string };
    assert.ok(body.id);
    assert.equal(body.body, "Test comment");
  });

  it("Bitbucket list PRs returns paged values", async () => {
    const r = await fetch(
      `${mock.url}/rest/api/1.0/projects/DEV/repos/myrepo/pull-requests`,
    );
    assert.equal(r.status, 200);
    const body = (await r.json()) as { values: unknown[]; size: number };
    assert.equal(body.size, 1);
    assert.ok(Array.isArray(body.values));
  });

  it("Bitbucket GET single PR returns detail", async () => {
    const r = await fetch(
      `${mock.url}/rest/api/1.0/projects/DEV/repos/myrepo/pull-requests/42`,
    );
    assert.equal(r.status, 200);
    const body = (await r.json()) as { id: number; state: string };
    assert.equal(body.id, 42);
    assert.equal(body.state, "OPEN");
  });

  it("Bitbucket POST create PR returns 201", async () => {
    const r = await fetch(
      `${mock.url}/rest/api/1.0/projects/DEV/repos/myrepo/pull-requests`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "My new PR" }),
      },
    );
    assert.equal(r.status, 201);
    const body = (await r.json()) as { id: number; title: string };
    assert.ok(body.id);
    assert.equal(body.title, "My new PR");
  });

  it("Bitbucket POST PR comment returns 201", async () => {
    const r = await fetch(
      `${mock.url}/rest/api/1.0/projects/DEV/repos/myrepo/pull-requests/42/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "LGTM" }),
      },
    );
    assert.equal(r.status, 201);
    const body = (await r.json()) as { id: number; text: string };
    assert.ok(body.id);
    assert.equal(body.text, "LGTM");
  });

  it("Confluence GET page returns content", async () => {
    const r = await fetch(`${mock.url}/rest/api/content/12345`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { id: string; version: { number: number } };
    assert.equal(body.id, "12345");
    assert.equal(body.version.number, 1);
  });

  it("Confluence GET search returns results", async () => {
    const r = await fetch(`${mock.url}/rest/api/content/search?cql=type=page`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { results: unknown[]; size: number };
    assert.ok(Array.isArray(body.results));
    assert.ok(body.size > 0);
  });

  it("Confluence POST create page returns 200 with id", async () => {
    const r = await fetch(`${mock.url}/rest/api/content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "page", title: "New Page", space: { key: "TEST" } }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { id: string; title: string; space: { key: string } };
    assert.ok(body.id);
    assert.equal(body.title, "New Page");
    assert.equal(body.space.key, "TEST");
  });

  it("Confluence PUT update page returns 200", async () => {
    const r = await fetch(`${mock.url}/rest/api/content/12345`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated Page", version: { number: 2 } }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { id: string; title: string; version: { number: number } };
    assert.equal(body.id, "12345");
    assert.equal(body.title, "Updated Page");
    assert.equal(body.version.number, 2);
  });

  it("auth required mode returns 401 without credentials", async () => {
    const authMock = await startMockAtlassian({ auth: { username: "svc", password: "secret" } });
    try {
      const r = await fetch(`${authMock.url}/rest/api/2/issue/PROJ-1`);
      assert.equal(r.status, 401);

      const ok = await fetch(`${authMock.url}/rest/api/2/issue/PROJ-1`, {
        headers: {
          Authorization: `Basic ${Buffer.from("svc:secret").toString("base64")}`,
        },
      });
      assert.equal(ok.status, 200);
    } finally {
      await authMock.close();
    }
  });

  it("captures lastRequest method path body authHeader", async () => {
    await fetch(`${mock.url}/rest/api/2/issue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic dGVzdA==",
      },
      body: JSON.stringify({ fields: { summary: "capture test" } }),
    });
    assert.equal(mock.lastRequest?.method, "POST");
    assert.equal(mock.lastRequest?.path, "/rest/api/2/issue");
    assert.equal(mock.lastRequest?.authHeader, "Basic dGVzdA==");
    const b = mock.lastRequest?.body as { fields?: { summary?: string } };
    assert.equal(b?.fields?.summary, "capture test");
  });

  it("history accumulates all requests", async () => {
    const before = mock.history.length;
    await fetch(`${mock.url}/rest/api/2/issue/X-1`);
    await fetch(`${mock.url}/rest/api/2/issue/X-2`);
    assert.ok(mock.history.length >= before + 2);
  });

  it("unknown path returns 404", async () => {
    const r = await fetch(`${mock.url}/unknown/path`);
    assert.equal(r.status, 404);
  });
});
