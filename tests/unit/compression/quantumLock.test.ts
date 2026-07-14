import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  QUANTUM_PATTERNS,
  TAIL_DELIM,
  placeholderFor,
} from "../../../open-sse/services/compression/quantumLock/quantumPatterns.ts";
import { detectVolatileSpans } from "../../../open-sse/services/compression/quantumLock/quantumLock.ts";
import { applyQuantumLock } from "../../../open-sse/services/compression/quantumLock/quantumLockStep.ts";
import {
  resolveQuantumLock,
  withQuantumLock,
} from "../../../open-sse/services/compression/quantumLock/strategyWrap.ts";
import { applyCompression } from "../../../open-sse/services/compression/strategySelector.ts";

const ALL = { enabled: true } as const;
const ON = { enabled: true } as const;
const spanText = (text: string, s: { start: number; end: number }) => text.slice(s.start, s.end);
const sys = (content: string) => ({
  messages: [
    { role: "system", content },
    { role: "user", content: "hello" },
  ],
});
const prefixOf = (s: string) => s.split(TAIL_DELIM)[0];
const sysText = (body: Record<string, unknown>) =>
  (body.messages as Array<{ content: string }>)[0].content;

describe("QuantumLock: patterns", () => {
  it("placeholderFor is positional and value-independent", () => {
    assert.equal(placeholderFor(0), "⟦Q0⟧");
    assert.equal(placeholderFor(7), "⟦Q7⟧");
    assert.equal(TAIL_DELIM, "⟦QUANTUMLOCK⟧");
  });

  it("order is fixed (jwt before long_hex, api_key before uuid, unix_ts last); all global", () => {
    const order = QUANTUM_PATTERNS.map((p) => p.category);
    assert.ok(order.indexOf("jwt") < order.indexOf("long_hex"));
    assert.ok(order.indexOf("api_key_shape") < order.indexOf("uuid"));
    assert.equal(order.lastIndexOf("unix_ts"), order.length - 1);
    for (const { pattern } of QUANTUM_PATTERNS) assert.ok(pattern.flags.includes("g"));
  });

  it("patterns are ReDoS-bounded on adversarial input (< 500ms)", () => {
    const evil = "a".repeat(50_000) + "!".repeat(50_000);
    const start = Date.now();
    for (const { pattern } of QUANTUM_PATTERNS) {
      pattern.lastIndex = 0;
      pattern.test(evil);
    }
    assert.ok(Date.now() - start < 500);
  });
});

describe("QuantumLock: span detection", () => {
  it("detects a uuid, inner hex is NOT re-claimed by long_hex", () => {
    const t = "session 550e8400-e29b-41d4-a716-446655440000 ready";
    const spans = detectVolatileSpans(t, ALL);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].category, "uuid");
    assert.equal(spanText(t, spans[0]), "550e8400-e29b-41d4-a716-446655440000");
  });

  it("detects unix_ts, api_key_shape and request_id", () => {
    const cats = detectVolatileSpans(
      "ts 1718900000000 key sk-ABCDEFGHIJKLMNOP01 rid req-abc123def456",
      ALL
    ).map((s) => s.category);
    assert.ok(cats.includes("unix_ts"));
    assert.ok(cats.includes("api_key_shape"));
    assert.ok(cats.includes("request_id"));
  });

  it("category filter restricts detection", () => {
    const spans = detectVolatileSpans("550e8400-e29b-41d4-a716-446655440000 and 1718900000", {
      enabled: true,
      categories: ["unix_ts"],
    });
    assert.equal(spans.length, 1);
    assert.equal(spans[0].category, "unix_ts");
  });

  it("no false-positive on prose / dates / short numbers", () => {
    assert.equal(
      detectVolatileSpans("The meeting is on 2026-06-28 at 10am, room 42.", ALL).length,
      0
    );
  });

  it("spans are ascending and non-overlapping; empty is a no-op", () => {
    const t = "a 550e8400-e29b-41d4-a716-446655440000 b req-abcdef123456 c 1718900000";
    const spans = detectVolatileSpans(t, ALL);
    for (let i = 1; i < spans.length; i++) assert.ok(spans[i].start >= spans[i - 1].end);
    assert.deepEqual(detectVolatileSpans("", ALL), []);
  });
});

describe("QuantumLock: applyQuantumLock step", () => {
  it("DETERMINISM: same template, different values ⇒ byte-identical prefix", () => {
    const tmpl = (u: string, ts: string) => `Agent. Session ${u} started ${ts}. Obey rules.`;
    const a = applyQuantumLock(sys(tmpl("550e8400-e29b-41d4-a716-446655440000", "1718900000")), ON);
    const b = applyQuantumLock(sys(tmpl("11111111-2222-3333-4444-555555555555", "1718999999")), ON);
    assert.equal(prefixOf(sysText(a.body)), prefixOf(sysText(b.body)));
    assert.notEqual(sysText(a.body), sysText(b.body));
  });

  it("LOSSLESS: every original value appears in the tail; stats set", () => {
    const u = "550e8400-e29b-41d4-a716-446655440000";
    const out = applyQuantumLock(sys(`id ${u} done`), ON);
    assert.ok(sysText(out.body).includes(`⟦Q0⟧=${u}`));
    assert.equal(out.stats.fragments, 1);
    assert.deepEqual(out.stats.categories, { uuid: 1 });
  });

  it("IDEMPOTENT: second pass is a no-op (TAIL_DELIM guard)", () => {
    const once = applyQuantumLock(sys("id 550e8400-e29b-41d4-a716-446655440000"), ON);
    const twice = applyQuantumLock(once.body, ON);
    assert.equal(sysText(twice.body), sysText(once.body));
    assert.equal(twice.stats.fragments, 0);
  });

  it("only the system message is touched; input is not mutated", () => {
    const input = sys("id 550e8400-e29b-41d4-a716-446655440000");
    const before = JSON.stringify(input);
    const out = applyQuantumLock(input, ON);
    assert.equal((out.body.messages as Array<{ content: string }>)[1].content, "hello");
    assert.equal(JSON.stringify(input), before);
  });

  it("no-op paths: no system / empty / no spans / array content", () => {
    assert.equal(
      applyQuantumLock(
        { messages: [{ role: "user", content: "550e8400-e29b-41d4-a716-446655440000" }] },
        ON
      ).stats.fragments,
      0
    );
    assert.equal(applyQuantumLock(sys(""), ON).stats.fragments, 0);
    assert.equal(applyQuantumLock(sys("plain prose only"), ON).stats.fragments, 0);
    assert.equal(
      applyQuantumLock(
        {
          messages: [
            {
              role: "system",
              content: [{ type: "text", text: "550e8400-e29b-41d4-a716-446655440000" }],
            },
          ],
        },
        ON
      ).stats.fragments,
      0
    );
  });
});

describe("QuantumLock: strategyWrap gate", () => {
  const CACHING = { isCachingProvider: true };
  const NOT_CACHING = { isCachingProvider: false };
  const runEcho = (b: Record<string, unknown>) => ({ body: b, compressed: false, stats: null });

  it("resolveQuantumLock returns config only when enabled", () => {
    assert.equal(
      resolveQuantumLock({ config: { quantumLock: { enabled: false } } as never }),
      undefined
    );
    assert.ok(resolveQuantumLock({ config: { quantumLock: { enabled: true } } as never }));
    assert.equal(resolveQuantumLock(undefined), undefined);
  });

  it("disabled ⇒ passthrough; non-caching ⇒ no-op", () => {
    const body = sys("id 550e8400-e29b-41d4-a716-446655440000");
    assert.equal(sysText(withQuantumLock(body, undefined, CACHING, runEcho).body), sysText(body));
    assert.equal(
      sysText(withQuantumLock(body, { enabled: true }, NOT_CACHING, runEcho).body),
      sysText(body)
    );
  });

  it("enabled + caching ⇒ stabilizes + attaches stats", () => {
    const body = sys("id 550e8400-e29b-41d4-a716-446655440000");
    const r = withQuantumLock(body, { enabled: true }, CACHING, runEcho);
    assert.ok(sysText(r.body).includes(TAIL_DELIM));
    assert.equal(r.stats?.quantumLock?.fragments, 1);
  });
});

describe("QuantumLock: integration through applyCompression", () => {
  const QL_ON = { quantumLock: { enabled: true } };
  const ANTHROPIC = { cachingContext: { provider: "anthropic" } };

  it("caching provider + quantumLock ⇒ system UUID stabilized + stats", () => {
    const r = applyCompression(
      sys("Agent. Session 550e8400-e29b-41d4-a716-446655440000 active."),
      "lite",
      {
        config: QL_ON as never,
        ...ANTHROPIC,
      }
    );
    assert.ok(sysText(r.body).includes(TAIL_DELIM));
    assert.equal(r.stats?.quantumLock?.fragments, 1);
  });

  it("disabled quantumLock ⇒ byte-identical baseline (no tail)", () => {
    const base = applyCompression(
      sys("Agent. Session 550e8400-e29b-41d4-a716-446655440000 active."),
      "lite",
      {
        ...ANTHROPIC,
      }
    );
    assert.equal(sysText(base.body).includes(TAIL_DELIM), false);
  });

  it("non-caching provider ⇒ no-op (no tail)", () => {
    const r = applyCompression(
      sys("Agent. Session 550e8400-e29b-41d4-a716-446655440000 active."),
      "lite",
      {
        config: QL_ON as never,
        cachingContext: { provider: "ollama" },
      }
    );
    assert.equal(sysText(r.body).includes(TAIL_DELIM), false);
  });

  it("user/assistant messages are untouched", () => {
    const r = applyCompression(
      sys("Agent. Session 550e8400-e29b-41d4-a716-446655440000 active."),
      "lite",
      {
        config: QL_ON as never,
        ...ANTHROPIC,
      }
    );
    assert.equal((r.body.messages as Array<{ content: string }>)[1].content, "hello");
  });
});
