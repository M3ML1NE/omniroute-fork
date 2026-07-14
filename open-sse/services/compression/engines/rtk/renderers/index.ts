import type { CommandDetectionResult } from "../commandDetector.ts";
import type { RtkConfig } from "../../../types.ts";
import { type RenderResult, NO_RENDER } from "./types.ts";
import { renderGitDiff } from "./gitDiff.ts";
import { renderTestGreen } from "./testGreen.ts";
import { renderTerraformPlan } from "./terraformPlan.ts";
import { renderStructuredTable } from "./structuredTable.ts";

const REGISTRY: Record<string, (text: string, d: CommandDetectionResult) => RenderResult> = {};

REGISTRY["git-diff"] = renderGitDiff;

REGISTRY["test-pytest"] = renderTestGreen;
REGISTRY["test-jest"] = renderTestGreen;
REGISTRY["test-vitest"] = renderTestGreen;
REGISTRY["build-eslint"] = renderTestGreen;

REGISTRY["terraform-plan"] = renderTerraformPlan;
REGISTRY["tofu-plan"] = renderTerraformPlan;

REGISTRY["aws"] = renderStructuredTable;
REGISTRY["json-output"] = renderStructuredTable;

export function applyRenderer(
  text: string,
  detection: CommandDetectionResult,
  config: RtkConfig
): RenderResult {
  const r = REGISTRY[detection.type];
  if (!r) return NO_RENDER(text);
  if (
    config.renderers &&
    config.renderers.length > 0 &&
    !config.renderers.includes(detection.type)
  ) {
    return NO_RENDER(text);
  }
  return r(text, detection);
}
export { type RenderResult } from "./types.ts";

export { REGISTRY };
