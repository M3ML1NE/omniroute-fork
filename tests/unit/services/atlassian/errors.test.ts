import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapAtlassianError, formatAtlassianError } from "../../../../open-sse/services/atlassian/errors.js";

describe("mapAtlassianError", () => {
  it("401 unauthorized with service detection", () => {
    const err = new Error("Jira GET /rest/api/2/issue/X failed (401): Unauthorized");
    const m = mapAtlassianError(err);
    assert.equal(m.type, "atlassian.unauthorized");
    assert.equal(m.status, 401);
    assert.equal(m.service, "jira");
  });

  it("403 forbidden with bitbucket service", () => {
    const err = new Error("Bitbucket GET /pulls failed (403): Forbidden");
    const m = mapAtlassianError(err);
    assert.equal(m.type, "atlassian.forbidden");
    assert.equal(m.service, "bitbucket");
  });

  it("404 not_found with confluence service", () => {
    const err = new Error("Confluence GET /content/X failed (404): Not Found");
    const m = mapAtlassianError(err);
    assert.equal(m.type, "atlassian.not_found");
    assert.equal(m.service, "confluence");
  });

  it("400 validation_error", () => {
    const err = new Error("Jira POST /search failed (400): bad JQL");
    const m = mapAtlassianError(err);
    assert.equal(m.type, "atlassian.validation_error");
  });

  it("429 rate_limited", () => {
    const err = new Error("Jira GET failed (429): Too Many Requests");
    const m = mapAtlassianError(err);
    assert.equal(m.type, "atlassian.rate_limited");
  });

  it("502 server_error (5xx)", () => {
    const err = new Error("Jira GET failed (502): Bad Gateway");
    const m = mapAtlassianError(err);
    assert.equal(m.type, "atlassian.server_error");
  });

  it("AbortError → connection_error timeout", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    const m = mapAtlassianError(err);
    assert.equal(m.type, "atlassian.connection_error");
    assert.equal(m.message, "Request timed out");
  });

  it("ENOTFOUND → connection_error", () => {
    const err = new Error("getaddrinfo ENOTFOUND jira.bad.host");
    const m = mapAtlassianError(err);
    assert.equal(m.type, "atlassian.connection_error");
  });

  it("unknown error → unknown_error", () => {
    const m = mapAtlassianError(new Error("something weird"));
    assert.equal(m.type, "atlassian.unknown_error");
  });

  it("formatAtlassianError produces valid JSON envelope", () => {
    const m = mapAtlassianError(new Error("Jira GET failed (404): not found"));
    const json = formatAtlassianError(m);
    const parsed = JSON.parse(json);
    assert.equal(parsed.error.type, "atlassian.not_found");
    assert.equal(parsed.error.status, 404);
  });
});
