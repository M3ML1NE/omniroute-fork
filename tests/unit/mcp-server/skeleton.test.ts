import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("MCP server skeleton", () => {
  it("server module imports without error", async () => {
    const mod = await import("../../../open-sse/mcp-server/index.js");
    assert.ok(mod !== null);
    assert.ok(typeof mod.createMcpServer === "function", "createMcpServer should be exported");
    assert.ok(typeof mod.startMcpStdio === "function", "startMcpStdio should be exported");
  });

  it("createMcpServer returns an MCP server instance", async () => {
    const { createMcpServer } = await import("../../../open-sse/mcp-server/index.js");
    const server = createMcpServer();
    assert.ok(server !== null && server !== undefined, "server should be created");
  });
});
