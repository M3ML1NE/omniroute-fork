/**
 * Hard-budget post-pass (#5288): compress to at most N tokens.
 *
 * Deterministic, independent of the relevance engine. Splits prose into
 * sentences/lines, ranks by average scoreToken ascending, drops the lowest-
 * saliency units until the body fits the target, then reconstructs original
 * order. Units matching UNIT_PRESERVE_RE (errors, numbers, URLs, code, paths,
 * key=value) are never dropped. Off by default: absent targetTokens/targetRatio
 * → no-op.
 */

import type { CompressionResult } from "./types.ts";
import { scoreToken } from "./ultraHeuristic.ts";
import { estimateCompressionTokens } from "./stats.ts";
import { createCompressionStats } from "./stats.ts";

interface HardBudgetOptions {
  targetTokens?: number;
  targetRatio?: number;
}

// Input-length cap: skip splitting/scoring on pathologically large messages so a
// crafted input can never make the unit loop the bottleneck.
const MAX_INPUT_CHARS = 1_000_000;

// Units matching these anchors are never dropped. Anchored to meaningful signals
// only — never matches a bare end-of-sentence period (which would make every
// prose line "preserve" → permanent no-op). Each alternative is a bounded,
// non-overlapping quantifier → ReDoS-safe.
const UNIT_PRESERVE_RE =
  /\d|https?:\/\/|(?:Error|Exception|TypeError|RangeError|SyntaxError|ReferenceError|Traceback):|```|^\s*at\s|\/[\w.-]+\/|[A-Za-z_]\w*=\S/i;

function scoreUnit(unit: string): number {
  const words = unit.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0.5;
  const total = words.reduce((sum, w) => sum + scoreToken(w), 0);
  return total / words.length;
}

function mustPreserve(unit: string): boolean {
  return UNIT_PRESERVE_RE.test(unit);
}

function splitUnits(text: string): string[] {
  return text.split(/\n/).flatMap((line) => {
    if (line.trim() === "") return [line];
    if (!UNIT_PRESERVE_RE.test(line) && line.length > 60) {
      const sentences = line.split(/(?<=[.!?])\s+/);
      return sentences.length > 1 ? sentences : [line];
    }
    return [line];
  });
}

interface TaggedUnit {
  i: number;
  u: string;
  tokens: number;
  score: number;
  preserve: boolean;
}

function tagUnits(units: string[]): TaggedUnit[] {
  return units.map((u, i) => ({
    i,
    u,
    tokens: estimateCompressionTokens(u),
    score: scoreUnit(u),
    preserve: mustPreserve(u),
  }));
}

function dropToTarget(tagged: TaggedUnit[], targetTokens: number): Set<number> {
  const dropped = new Set<number>();
  let tokCount = tagged.reduce((s, x) => s + x.tokens, 0);

  const candidates = tagged.filter((x) => !x.preserve).sort((a, b) => a.score - b.score);

  for (const candidate of candidates) {
    if (tokCount <= targetTokens) break;
    dropped.add(candidate.i);
    tokCount -= candidate.tokens;
  }

  return dropped;
}

function rebuildText(tagged: TaggedUnit[], dropped: Set<number>): string {
  return tagged
    .filter((x) => !dropped.has(x.i))
    .map((x) => x.u)
    .join("\n");
}

function compressText(text: string, targetTokens: number): string {
  if (text.length > MAX_INPUT_CHARS) return text;

  const currentTokens = estimateCompressionTokens(text);
  if (currentTokens <= targetTokens) return text;

  const units = splitUnits(text);
  if (units.length <= 1) return text;

  const tagged = tagUnits(units);
  const dropped = dropToTarget(tagged, targetTokens);
  if (dropped.size === 0) return text;

  return rebuildText(tagged, dropped);
}

function extractMessages(
  body: Record<string, unknown>
): Array<{ role: string; content: unknown }> {
  const msgs = body.messages;
  if (!Array.isArray(msgs)) return [];
  return msgs as Array<{ role: string; content: unknown }>;
}

export function applyHardBudget(
  body: Record<string, unknown>,
  opts: HardBudgetOptions
): CompressionResult {
  const { targetTokens, targetRatio } = opts;

  if (targetTokens == null && targetRatio == null) {
    return { body, compressed: false, stats: null };
  }

  const messages = extractMessages(body);
  if (messages.length === 0) return { body, compressed: false, stats: null };

  const totalText = messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join(" ");
  const totalTokens = estimateCompressionTokens(totalText);

  const effectiveTarget =
    targetTokens != null ? targetTokens : Math.floor(totalTokens * (targetRatio as number));

  if (totalTokens <= effectiveTarget) {
    return { body, compressed: false, stats: null };
  }

  // Distribute the aggregate budget proportionally per message so the SUM stays
  // ≤ target (passing the full target to each message would let an N-message
  // body come back N× over budget).
  const newMessages = messages.map((m) => {
    if (typeof m.content !== "string") return m;
    const msgTokens = estimateCompressionTokens(m.content);
    const perMsgTarget =
      totalTokens > 0 ? Math.floor(effectiveTarget * (msgTokens / totalTokens)) : effectiveTarget;
    const out = compressText(m.content, perMsgTarget);
    return out === m.content ? m : { ...m, content: out };
  });

  const changed = newMessages.some((m, i) => JSON.stringify(m) !== JSON.stringify(messages[i]));

  const usedMessages = changed ? newMessages : messages;
  const resultTokens = estimateCompressionTokens(
    usedMessages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join(" ")
  );
  const overBudget = resultTokens > effectiveTarget;

  if (!changed && !overBudget) {
    return { body, compressed: false, stats: null };
  }

  const newBody = changed ? { ...body, messages: newMessages } : body;
  const stats = createCompressionStats(body, newBody, "stacked", ["hard-budget"]);

  if (overBudget) {
    const warning = `hard-budget: could not reach target (${resultTokens} > ${effectiveTarget}; preserved content exceeds budget)`;
    stats.validationWarnings = [...(stats.validationWarnings ?? []), warning];
  }

  return { body: newBody, compressed: changed, stats };
}
