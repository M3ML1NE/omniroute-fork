import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getEndpointStatus,
  KEEP_ENDPOINTS,
  DELETE_ENDPOINTS,
} from "../../../open-sse/config/endpointWhitelist.js";

describe("endpointWhitelist", () => {
  describe("getEndpointStatus", () => {
    it("KEEP: GET /v1/models", () => {
      assert.equal(getEndpointStatus("GET", "/v1/models"), "KEEP");
    });

    it("KEEP: POST /v1/chat/completions", () => {
      assert.equal(getEndpointStatus("POST", "/v1/chat/completions"), "KEEP");
    });

    it("KEEP: POST /v1/embeddings", () => {
      assert.equal(getEndpointStatus("POST", "/v1/embeddings"), "KEEP");
    });

    it("KEEP: POST /v1/completions", () => {
      assert.equal(getEndpointStatus("POST", "/v1/completions"), "KEEP");
    });

    it("KEEP: POST /v1/audio/speech", () => {
      assert.equal(getEndpointStatus("POST", "/v1/audio/speech"), "KEEP");
    });

    it("KEEP: POST /v1/images/generations", () => {
      assert.equal(
        getEndpointStatus("POST", "/v1/images/generations"),
        "KEEP"
      );
    });

    it("KEEP: POST /v1/moderations", () => {
      assert.equal(getEndpointStatus("POST", "/v1/moderations"), "KEEP");
    });

    it("DELETE: POST /v1/messages", () => {
      assert.equal(getEndpointStatus("POST", "/v1/messages"), "DELETE");
    });

    it("DELETE: POST /v1/files", () => {
      assert.equal(getEndpointStatus("POST", "/v1/files"), "DELETE");
    });

    it("DELETE: POST /v1/batches", () => {
      assert.equal(getEndpointStatus("POST", "/v1/batches"), "DELETE");
    });

    it("DELETE: POST /v1/responses", () => {
      assert.equal(getEndpointStatus("POST", "/v1/responses"), "DELETE");
    });

    it("UNKNOWN: POST /v1/foobar", () => {
      assert.equal(getEndpointStatus("POST", "/v1/foobar"), "UNKNOWN");
    });

    it("case insensitive method", () => {
      assert.equal(getEndpointStatus("post", "/v1/chat/completions"), "KEEP");
    });

    it("case insensitive method (post)", () => {
      assert.equal(getEndpointStatus("post", "/v1/chat/completions"), "KEEP");
    });
  });

  describe("constants", () => {
    it("KEEP_ENDPOINTS non-empty", () => {
      assert.ok(KEEP_ENDPOINTS.length >= 7);
    });

    it("DELETE_ENDPOINTS non-empty", () => {
      assert.ok(DELETE_ENDPOINTS.length >= 30);
    });

    it("no overlap between KEEP and DELETE", () => {
      const keepSet = new Set(KEEP_ENDPOINTS as readonly string[]);
      const deleteSet = new Set(DELETE_ENDPOINTS as readonly string[]);
      const overlap = [...keepSet].filter((ep) => deleteSet.has(ep));
      assert.equal(overlap.length, 0, `Overlap found: ${overlap.join(", ")}`);
    });
  });
});
