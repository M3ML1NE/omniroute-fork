import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gigachat-dashboard-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const pgModule = await import("../../src/lib/db/postgres.ts");
const nodesRoute = await import("../../src/app/api/provider-nodes/route.ts");
const providersRoute = await import("../../src/app/api/providers/route.ts");

const RUN_PREFIX = `gigachat-dash-${process.pid}`;

function serialTest(name: string, fn: () => Promise<void>) {
  test(name, { concurrency: false }, fn);
}

async function resetStorage() {
  const schema = pgModule.getSchema();
  await pgModule.query(`DELETE FROM ${schema}.provider_connections WHERE name LIKE $1`, [
    `${RUN_PREFIX}-%`,
  ]);
  await pgModule.query(`DELETE FROM ${schema}.provider_nodes WHERE name LIKE $1`, [
    `${RUN_PREFIX}-%`,
  ]);
  core.resetDbInstance();
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function uniqueName(suffix: string): string {
  return `${RUN_PREFIX}-${suffix}-${Math.random().toString(16).slice(2, 8)}`;
}

function makeCreateNodeRequest(body: unknown): Request {
  return new Request("http://localhost/api/provider-nodes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeCreateConnectionRequest(body: unknown): Request {
  return new Request("http://localhost/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

serialTest(
  "POST /api/provider-nodes creates a gigachat-compatible node with per-node mTLS fields, no OAuth",
  async () => {
    const name = uniqueName("node-a");
    const res = await nodesRoute.POST(
      makeCreateNodeRequest({
        name,
        prefix: uniqueName("prefix-a"),
        type: "gigachat-compatible",
        baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
        mtls: {
          cert_path: "/tmp/secrets/a/client.crt",
          key_path: "/tmp/secrets/a/client.key",
          ca_path: "/tmp/secrets/a/ca.pem",
        },
      })
    );
    assert.equal(res.status, 201);
    const data = (await res.json()) as { node: Record<string, unknown> };
    assert.ok(data.node.id, "node must have an id");
    assert.match(String(data.node.id), /^gigachat-compatible-/);
    assert.equal(data.node.type, "gigachat-compatible");
    assert.deepEqual(data.node.mtls, {
      cert_path: "/tmp/secrets/a/client.crt",
      key_path: "/tmp/secrets/a/client.key",
      ca_path: "/tmp/secrets/a/ca.pem",
    });

    // No OAuth-shaped fields anywhere in the payload/response.
    const serialized = JSON.stringify(data.node).toLowerCase();
    assert.ok(!serialized.includes("oauth"), "response must not contain OAuth fields");
    assert.ok(!serialized.includes("access_token"), "response must not contain access_token");
    assert.ok(!serialized.includes("refresh_token"), "response must not contain refresh_token");
  }
);

serialTest("gigachat-compatible node creation rejects missing mTLS certificate paths", async () => {
  const res = await nodesRoute.POST(
    makeCreateNodeRequest({
      name: uniqueName("node-missing-mtls"),
      prefix: uniqueName("prefix-missing"),
      type: "gigachat-compatible",
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
    })
  );
  assert.equal(res.status, 400);
});

serialTest(
  "two named gigachat-compatible connections persist with distinct mTLS references and no OAuth fields",
  async () => {
    const nodeAName = uniqueName("node-a");
    const nodeBName = uniqueName("node-b");

    const nodeARes = await nodesRoute.POST(
      makeCreateNodeRequest({
        name: nodeAName,
        prefix: uniqueName("prefix-a"),
        type: "gigachat-compatible",
        baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
        mtls: {
          cert_path: "/tmp/secrets/a/client.crt",
          key_path: "/tmp/secrets/a/client.key",
          ca_path: "/tmp/secrets/a/ca.pem",
        },
      })
    );
    const nodeBRes = await nodesRoute.POST(
      makeCreateNodeRequest({
        name: nodeBName,
        prefix: uniqueName("prefix-b"),
        type: "gigachat-compatible",
        baseUrl: "https://gigachat-b.example.internal/api/v1",
        mtls: {
          cert_path: "/tmp/secrets/b/client.crt",
          key_path: "/tmp/secrets/b/client.key",
          ca_path: "/tmp/secrets/b/ca.pem",
        },
      })
    );
    assert.equal(nodeARes.status, 201);
    assert.equal(nodeBRes.status, 201);
    const nodeA = ((await nodeARes.json()) as { node: Record<string, unknown> }).node;
    const nodeB = ((await nodeBRes.json()) as { node: Record<string, unknown> }).node;
    assert.notEqual(nodeA.id, nodeB.id, "each node must get a distinct id");

    // Create a provider connection under each node (mirrors dashboard flow:
    // create node -> create connection scoped to that node's provider id).
    const connARes = await providersRoute.POST(
      makeCreateConnectionRequest({
        provider: nodeA.id,
        name: uniqueName("conn-a"),
        priority: 1,
      })
    );
    const connBRes = await providersRoute.POST(
      makeCreateConnectionRequest({
        provider: nodeB.id,
        name: uniqueName("conn-b"),
        priority: 1,
      })
    );
    assert.equal(connARes.status, 201, await connARes.clone().text());
    assert.equal(connBRes.status, 201, await connBRes.clone().text());

    const connA = ((await connARes.json()) as { connection: Record<string, unknown> }).connection;
    const connB = ((await connBRes.json()) as { connection: Record<string, unknown> }).connection;

    assert.notEqual(connA.id, connB.id, "each connection must get a distinct row");
    assert.equal(connA.provider, nodeA.id);
    assert.equal(connB.provider, nodeB.id);

    const psdA = connA.providerSpecificData as Record<string, unknown>;
    const psdB = connB.providerSpecificData as Record<string, unknown>;
    assert.deepEqual(psdA.mtls, {
      cert_path: "/tmp/secrets/a/client.crt",
      key_path: "/tmp/secrets/a/client.key",
      ca_path: "/tmp/secrets/a/ca.pem",
    });
    assert.deepEqual(psdB.mtls, {
      cert_path: "/tmp/secrets/b/client.crt",
      key_path: "/tmp/secrets/b/client.key",
      ca_path: "/tmp/secrets/b/ca.pem",
    });
    assert.notDeepEqual(psdA.mtls, psdB.mtls, "mTLS references must be distinct per connection");

    // No OAuth fields anywhere in either connection response.
    for (const conn of [connA, connB]) {
      const serialized = JSON.stringify(conn).toLowerCase();
      assert.ok(!serialized.includes("oauth"), "connection response must not contain OAuth fields");
      assert.equal(conn.accessToken, undefined, "accessToken must not be exposed");
      assert.equal(conn.refreshToken, undefined, "refreshToken must not be exposed");
      assert.equal(conn.idToken, undefined, "idToken must not be exposed");
    }
  }
);
