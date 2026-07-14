import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { renderGitDiff } from "../../../open-sse/services/compression/engines/rtk/renderers/gitDiff.ts";
import { renderTestGreen } from "../../../open-sse/services/compression/engines/rtk/renderers/testGreen.ts";
import { renderTerraformPlan } from "../../../open-sse/services/compression/engines/rtk/renderers/terraformPlan.ts";
import { renderStructuredTable } from "../../../open-sse/services/compression/engines/rtk/renderers/structuredTable.ts";
import { applyRenderer } from "../../../open-sse/services/compression/engines/rtk/renderers/index.ts";
import { processRtkText } from "../../../open-sse/services/compression/engines/rtk/index.ts";
import type { CommandDetectionResult } from "../../../open-sse/services/compression/engines/rtk/commandDetector.ts";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "rtk");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");

const det = (type: string): CommandDetectionResult => ({
  type,
  command: "",
  confidence: 1,
  category: "generic",
  matchedPatterns: [],
});

describe("RTK renderer: git-diff", () => {
  it("keeps file headers, hunks and +/- changes; drops context (fixture)", () => {
    const r = renderGitDiff(fixture("git-diff-sample.txt"), det("git-diff"));
    assert.equal(r.changed, true);
    assert.equal(r.renderer, "git-diff");
    assert.ok(r.text.includes("diff --git a/src/app.ts b/src/app.ts"));
    assert.ok(r.text.includes("@@ -1,3 +1,4 @@"));
    assert.ok(r.text.includes('+  return "rtk";'));
    assert.ok(!r.text.includes("index 1111111..2222222"));
    assert.ok(!r.text.includes("--- a/src/app.ts"));
    assert.ok(!r.text.includes("+++ b/src/app.ts"));
  });

  it("no hunks ⇒ no-op", () => {
    const r = renderGitDiff("just some text\nno diff here", det("git-diff"));
    assert.equal(r.changed, false);
  });
});

describe("RTK renderer: test-green (pytest)", () => {
  it("collapses an all-green pytest run to its summary (fixture)", () => {
    const r = renderTestGreen(fixture("pytest-sample.txt"), det("test-pytest"));
    assert.equal(r.changed, true);
    assert.ok(r.text.includes("142 passed"));
    assert.ok(!r.text.includes("...................."));
  });

  it("ANY failure ⇒ no-op (preserve diagnostics)", () => {
    const input = `tests/a.py ..F..
=== 1 failed, 4 passed in 1.0s ===
E   AssertionError: nope`;
    const r = renderTestGreen(input, det("test-pytest"));
    assert.equal(r.changed, false);
    assert.equal(r.text, input);
  });

  it("ANSI-colored FAIL with no numeric count ⇒ no-op", () => {
    const input = "\x1b[1m\x1b[31mFAIL\x1b[39m\x1b[22m src/auth.test.ts\nTests: 3 passed, 3 total";
    const r = renderTestGreen(input, det("test-jest"));
    assert.equal(r.changed, false);
  });
});

describe("RTK renderer: terraform-plan", () => {
  it("summarizes plan into +N ~M -K plus resources (fixture)", () => {
    const r = renderTerraformPlan(fixture("terraform-plan-sample.txt"), det("terraform-plan"));
    assert.equal(r.changed, true);
    assert.ok(r.text.includes("Plan: +0 ~1 -0"));
    assert.ok(r.text.includes("# aws_instance.app will be updated in-place"));
    assert.ok(!r.text.includes('resource "aws_instance" "app" {'));
    assert.ok(!r.text.includes("will be will be"));
  });

  it("no-changes ⇒ no-op", () => {
    const r = renderTerraformPlan(
      "No changes. Your infrastructure matches the configuration.",
      det("terraform-plan")
    );
    assert.equal(r.changed, false);
  });
});

describe("RTK renderer: structured-table", () => {
  it("homogeneous JSON array ⇒ minimal table", () => {
    const input = JSON.stringify([
      { name: "pod-a", status: "Running", restarts: 0 },
      { name: "pod-b", status: "Pending", restarts: 2 },
    ]);
    const r = renderStructuredTable(input, det("aws"));
    assert.equal(r.changed, true);
    assert.ok(r.text.includes("name"));
    assert.ok(r.text.includes("pod-a"));
    assert.ok(r.text.includes("Pending"));
    assert.ok(!r.text.includes('"status":'));
  });

  it("malformed JSON ⇒ no-op", () => {
    assert.equal(renderStructuredTable("{not json", det("aws")).changed, false);
  });

  it("single object (not array) ⇒ no-op", () => {
    assert.equal(renderStructuredTable('{"name":"x"}', det("json-output")).changed, false);
  });
});

describe("RTK renderers: ERROR-PRESERVATION (mandatory negative path)", () => {
  const ERROR_INPUTS: Array<[string, string]> = [
    ["test-pytest", "tests/a.py ..F..\nE   Error: boom\n=== 142 passed in 3.2s ==="],
    ["test-jest", "FAIL src/x.test.ts\nError: kaboom\nTests: 5 passed, 6 total"],
    ["test-vitest", "❯ src/y.test.ts\nAssertionError: expected 1 to equal 2\n1 passed"],
    ["build-eslint", "src/z.ts\n  1:1  error  Unexpected  no-undef\n✖ 1 problem"],
  ];

  for (const [type, input] of ERROR_INPUTS) {
    it(`test-green never strips Error/FAIL lines for ${type}`, () => {
      const r = renderTestGreen(input, det(type));
      assert.equal(r.changed, false, "renderer must no-op on any failure signal");
      assert.equal(r.text, input, "original text (with error lines) must be returned verbatim");
      for (const line of input.split("\n")) {
        assert.ok(r.text.includes(line), `error/context line must survive: "${line}"`);
      }
    });
  }

  it("git-diff renderer keeps a line whose content is 'Error' as a +/- change", () => {
    const input = `diff --git a/log.txt b/log.txt
index aaa..bbb 100644
--- a/log.txt
+++ b/log.txt
@@ -1,1 +1,1 @@
-old line
+Error: something failed`;
    const r = renderGitDiff(input, det("git-diff"));
    assert.equal(r.changed, true);
    assert.ok(r.text.includes("+Error: something failed"), "changed error line must be preserved");
  });

  it("terraform renderer keeps error output as no-op (no Plan: line)", () => {
    const input = "Error: Reference to undeclared resource\n\n  on main.tf line 5:";
    const r = renderTerraformPlan(input, det("terraform-plan"));
    assert.equal(r.changed, false);
    assert.equal(r.text, input);
  });
});

describe("RTK renderers: integration through processRtkText (opt-in)", () => {
  const GIT_DIFF = fixture("git-diff-sample.txt");

  it("enableRenderers default false ⇒ baseline unchanged", () => {
    const off = processRtkText(GIT_DIFF, { command: "git diff", config: { enabled: true } });
    const explicitOff = processRtkText(GIT_DIFF, {
      command: "git diff",
      config: { enabled: true, enableRenderers: false },
    });
    assert.equal(off.text, explicitOff.text);
  });

  it("enableRenderers true ⇒ git diff is rendered through processRtkText", () => {
    const on = processRtkText(GIT_DIFF, {
      command: "git diff",
      config: { enabled: true, enableRenderers: true },
    });
    assert.ok(on.techniquesUsed.includes("rtk-render:git-diff"));
    assert.ok(!on.text.includes("index 1111111"));
  });

  it("fail-open: benign input never throws", () => {
    const r = processRtkText("not really a diff", {
      command: "git diff",
      config: { enabled: true, enableRenderers: true },
    });
    assert.ok(typeof r.text === "string");
  });

  it("renderers whitelist restricts which command-types render", () => {
    const r = applyRenderer(GIT_DIFF, det("git-diff"), {
      enabled: true,
      enableRenderers: true,
      renderers: ["terraform-plan"],
    } as never);
    assert.equal(r.changed, false);
  });
});
