import type { RenderResult, CommandDetectionResult } from "./types.ts";
import { NO_RENDER } from "./types.ts";

/**
 * RTK semantic renderer for `terraform plan` / `tofu plan` output.
 *
 * Reformats the canonical `Plan: N to add, M to change, K to destroy.` line as
 * `Plan: +N ~M -K` and keeps the `# <addr> will be <verb>` resource lines. Returns a
 * no-op for "No changes." (already compact) or when no `Plan:` summary line is found.
 */
export function renderTerraformPlan(
  text: string,
  _detection: CommandDetectionResult
): RenderResult {
  if (/^No changes\./m.test(text)) return NO_RENDER(text);

  const planMatch = text.match(/Plan:\s+(\d+)\s+to add,\s+(\d+)\s+to change,\s+(\d+)\s+to destroy/);
  if (!planMatch) return NO_RENDER(text);

  const [, add, change, destroy] = planMatch;
  const summary = `Plan: +${add} ~${change} -${destroy}`;

  const resources: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s+#\s+(\S+)\s+will\s+be\s+\S+/);
    if (m) {
      resources.push(`  # ${m[1]} will be ${line.trim().replace(/^#\s+\S+\s+will\s+be\s+/, "")}`);
    }
  }

  const out = [summary, ...resources].join("\n");
  return { text: out, changed: true, renderer: "terraform-plan" };
}
