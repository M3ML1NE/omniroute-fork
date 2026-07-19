// Ported from OmniRoute upstream v3.8.48, adapted for GigaChat fork.
//
// Covers the output-styles catalog, the back-compat shim (cavemanOutputMode → terse-prose), and
// the deterministic system-prompt injection performed by applyOutputStyles.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  OUTPUT_STYLE_IDS,
  outputStyleMeta,
} from "../../../open-sse/services/compression/outputStyles/catalog.ts";
import {
  applyOutputStyles,
  OUTPUT_STYLE_MARKER,
} from "../../../open-sse/services/compression/outputStyles/apply.ts";
import { resolveOutputStyleSelection } from "../../../open-sse/services/compression/outputStyles/backCompat.ts";

describe("output styles catalog", () => {
  it("declares the three built-in styles in catalog order", () => {
    assert.deepEqual(OUTPUT_STYLE_IDS, ["terse-prose", "less-code", "terse-cjk"]);
    assert.equal(outputStyleMeta("terse-cjk").locale, "zh");
  });
});

describe("resolveOutputStyleSelection (back-compat shim)", () => {
  it("prefers an explicit non-empty outputStyles selection", () => {
    const sel = resolveOutputStyleSelection({
      outputStyles: [{ id: "less-code", level: "full" }],
      cavemanOutputMode: { enabled: true, intensity: "lite" },
    });
    assert.deepEqual(sel, [{ id: "less-code", level: "full" }]);
  });

  it("maps an enabled cavemanOutputMode to terse-prose at its intensity", () => {
    const sel = resolveOutputStyleSelection({
      cavemanOutputMode: { enabled: true, intensity: "ultra" },
    });
    assert.deepEqual(sel, [{ id: "terse-prose", level: "ultra" }]);
  });

  it("returns empty when neither is set", () => {
    assert.deepEqual(resolveOutputStyleSelection({}), []);
  });
});

describe("applyOutputStyles", () => {
  it("injects a single marked system instruction and is idempotent", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const first = applyOutputStyles(body, [{ id: "less-code", level: "full" }]);
    assert.equal(first.applied, true);
    const system = (first.body.messages as Array<{ role: string; content: string }>)[0];
    assert.equal(system.role, "system");
    assert.ok(system.content.includes(OUTPUT_STYLE_MARKER));

    const second = applyOutputStyles(first.body, [{ id: "less-code", level: "full" }]);
    assert.equal(second.applied, false);
    assert.equal(second.skippedReason, "already_applied");
  });

  it("drops unknown ids and returns no_styles when selection resolves empty", () => {
    const result = applyOutputStyles({ messages: [{ role: "user", content: "hi" }] }, [
      { id: "nonexistent-style", level: "full" },
    ]);
    assert.equal(result.applied, false);
    assert.equal(result.skippedReason, "no_styles");
  });
});
