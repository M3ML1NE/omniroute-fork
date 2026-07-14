import type { RenderResult, CommandDetectionResult } from "./types.ts";
import { NO_RENDER } from "./types.ts";

/**
 * RTK semantic renderer for `git diff` / `git show` output.
 *
 * Keeps only file-header (`diff --git`), hunk-header (`@@ ... @@`), and change
 * (`+foo` / `-foo`, never `+++`/`---`) lines; drops context, index, and mode lines.
 * Returns a no-op when no hunk header is present (input is not a real diff).
 */
export function renderGitDiff(text: string, _detection: CommandDetectionResult): RenderResult {
  if (!text.includes("@@ ")) {
    return NO_RENDER(text);
  }

  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ") || line.startsWith("@@ ")) {
      kept.push(line);
    } else if (/^[+-](?![+-])/.test(line)) {
      kept.push(line);
    }
  }

  const out = kept.join("\n");
  if (out === text) return NO_RENDER(text);

  return { text: out, changed: true, renderer: "git-diff" };
}
