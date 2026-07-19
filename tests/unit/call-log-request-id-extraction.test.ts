import test from "node:test";
import assert from "node:assert/strict";
import { resolveCallLogRequestId } from "../../open-sse/handlers/chatCore.ts";

// F1: client-sent X-Request-ID takes priority over the upstream-echoed value
// (GigaChat auto-generates a UUIDv4 and may echo it back when the client sent
// none); if neither exists, the call log stores null (rendered as "—" in the UI).

test("resolveCallLogRequestId: prefers the client header over the upstream echo", () => {
  assert.equal(resolveCallLogRequestId("client-rid", "upstream-rid"), "client-rid");
});

test("resolveCallLogRequestId: falls back to the upstream echo when the client sent none", () => {
  assert.equal(resolveCallLogRequestId(null, "upstream-rid"), "upstream-rid");
  assert.equal(resolveCallLogRequestId(undefined, "upstream-rid"), "upstream-rid");
});

test("resolveCallLogRequestId: returns null when neither source has a value", () => {
  assert.equal(resolveCallLogRequestId(null, null), null);
  assert.equal(resolveCallLogRequestId(undefined, undefined), null);
});

test("resolveCallLogRequestId: empty string client header is treated as absent", () => {
  assert.equal(resolveCallLogRequestId("", "upstream-rid"), "upstream-rid");
});
