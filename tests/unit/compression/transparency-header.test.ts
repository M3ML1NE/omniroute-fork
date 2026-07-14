import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCompressionHeader,
  formatCompressionMeta,
  formatCompressionAnnotation,
} from "../../../open-sse/services/compression/stats.ts";
import type { CompressionStats } from "../../../open-sse/services/compression/types.ts";
import { OMNIROUTE_RESPONSE_HEADERS } from "../../../src/shared/constants/headers.ts";

const HEADER = OMNIROUTE_RESPONSE_HEADERS.compression;

function makeStats(overrides: Partial<CompressionStats> = {}): CompressionStats {
  return {
    originalTokens: 847,
    compressedTokens: 312,
    savingsPercent: 63.16,
    techniquesUsed: ["caveman"],
    mode: "standard",
    timestamp: 0,
    ...overrides,
  };
}

// Mirrors the NON-STREAM attachment expression in handleChatCore:
//   ...(compressionResponseMeta ? { [HEADER]: compressionResponseMeta } : {})
function buildNonStreamHeaders(meta: string | null): Headers {
  return new Headers({
    "Content-Type": "application/json",
    [OMNIROUTE_RESPONSE_HEADERS.cache]: "MISS",
    ...(meta ? { [HEADER]: meta } : {}),
  });
}

// Mirrors the STREAM attachment: responseHeaders[HEADER] is set BEFORE Response
// construction (before the first SSE chunk), never after the body starts.
function buildStreamResponse(meta: string | null): Response {
  const responseHeaders: Record<string, string> = {
    "Content-Type": "text/event-stream",
    [OMNIROUTE_RESPONSE_HEADERS.cache]: "MISS",
  };
  if (meta) {
    responseHeaders[HEADER] = meta;
  }
  return new Response("data: {}\n\n", { headers: responseHeaders });
}

describe("transparency header value (#5284)", () => {
  it("formatCompressionMeta encodes mode + savings%", () => {
    assert.equal(formatCompressionMeta(makeStats()), "standard; savings=63.16%");
  });

  it("buildCompressionHeader with no rules is just the meta prefix", () => {
    const value = buildCompressionHeader(makeStats({ rulesApplied: [] }));
    assert.equal(value, "standard; savings=63.16%");
  });

  it("buildCompressionHeader appends the rules annotation when present", () => {
    const value = buildCompressionHeader(
      makeStats({ rulesApplied: ["filler", "filler", "dedup"] })
    );
    assert.ok(value.startsWith("standard; savings=63.16%"), `prefix mutated: ${value}`);
    assert.ok(value.includes("tokens=847->312"), value);
    assert.ok(value.includes("fillerx2"), value);
    assert.ok(value.includes("dedupx1"), value);
  });

  it("is ASCII-only so it survives HTTP header construction (no latin-1 500)", () => {
    const value = buildCompressionHeader(
      makeStats({ rulesApplied: ["filler", "filler", "dedup"] })
    );
    for (const ch of value) {
      assert.ok(ch.codePointAt(0)! <= 0xff, `non-latin1 char ${JSON.stringify(ch)} in: ${value}`);
    }
    assert.doesNotThrow(() => new Headers({ [HEADER]: value }));
    const res = new Response(null, { headers: { [HEADER]: value } });
    assert.equal(res.headers.get(HEADER), value);
  });
});

describe("transparency header ON/OFF × stream/non-stream", () => {
  // ── ON ──────────────────────────────────────────────────────────────────
  it("NON-STREAM: header PRESENT when transparency is ON", () => {
    const meta = buildCompressionHeader(makeStats({ rulesApplied: ["filler"] }));
    const headers = buildNonStreamHeaders(meta);
    assert.equal(headers.get(HEADER), meta);
    assert.ok(meta.startsWith("standard; savings="));
  });

  it("STREAM: header PRESENT when transparency is ON (set before first chunk)", () => {
    const meta = buildCompressionHeader(makeStats({ rulesApplied: ["filler"] }));
    const res = buildStreamResponse(meta);
    assert.equal(res.headers.get(HEADER), meta);
  });

  // ── OFF ─────────────────────────────────────────────────────────────────
  it("NON-STREAM: header ABSENT when transparency is OFF (meta null)", () => {
    const headers = buildNonStreamHeaders(null);
    assert.equal(headers.get(HEADER), null);
    assert.equal(headers.has(HEADER), false);
  });

  it("STREAM: header ABSENT when transparency is OFF (meta null)", () => {
    const res = buildStreamResponse(null);
    assert.equal(res.headers.get(HEADER), null);
    assert.equal(res.headers.has(HEADER), false);
  });

  it("STREAM: ASCII-only header never throws at Response construction", () => {
    const meta = buildCompressionHeader(
      makeStats({ rulesApplied: ["filler", "dedup", "dedup"] })
    );
    assert.doesNotThrow(() => buildStreamResponse(meta));
    const res = buildStreamResponse(meta);
    assert.equal(res.headers.get(HEADER), meta);
  });
});

describe("formatCompressionAnnotation", () => {
  it("returns empty string when no rulesApplied", () => {
    assert.equal(formatCompressionAnnotation(makeStats({ rulesApplied: [] })), "");
    assert.equal(formatCompressionAnnotation(makeStats({ rulesApplied: undefined })), "");
  });

  it("orders rule counts descending by count", () => {
    const result = formatCompressionAnnotation(
      makeStats({ rulesApplied: ["dedup", "filler", "filler", "filler"] })
    );
    assert.ok(result.indexOf("fillerx3") < result.indexOf("dedupx1"), result);
  });

  it("is deterministic (same input → same output)", () => {
    const stats = makeStats({ rulesApplied: ["filler", "dedup", "filler"] });
    assert.equal(formatCompressionAnnotation(stats), formatCompressionAnnotation(stats));
  });
});
