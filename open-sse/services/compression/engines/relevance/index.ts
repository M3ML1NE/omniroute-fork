import { createCompressionStats } from "../../stats.ts";
import type { CompressionResult } from "../../types.ts";
import type { CompressionEngine } from "../types.ts";
import { RELEVANCE_SCHEMA, validateRelevanceConfig, resolveRelevanceConfig } from "./configSchema.ts";
import { scoreSentences } from "./scorer.ts";

// Input-length cap: skip relevance extraction on pathologically large text so a
// crafted input can never make the split/scoring loop the bottleneck (ReDoS-safe
// defense-in-depth alongside the bounded regexes below).
const MAX_INPUT_CHARS = 200_000;

// Sentence-level "never drop" guard. Anchored on real signals only
// (digits, URLs, error prefixes, code fences, stack `at`-frames, multi-segment
// paths, key=value) — never on the bare end-of-sentence period, which would
// force-preserve every sentence and make the engine a permanent no-op. Each
// alternative is a bounded, non-overlapping quantifier → ReDoS-safe.
const SENTENCE_PRESERVE_RE =
  /\d|https?:\/\/|(?:Error|Exception|TypeError|RangeError|SyntaxError|ReferenceError|Traceback):|```|^\s*at\s|\/[\w.-]+\/|\w+=\S/i;

// Split AFTER sentence-final punctuation + trailing whitespace, keeping the
// whitespace on the preceding sentence so a rejoin with "" preserves paragraph
// structure (e.g. `\n\n` between sentences survives). Single bounded lookbehind.
const SENTENCE_SPLIT_RE = /(?<=[.!?]\s)/;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && "text" in block) {
          return String((block as { text: unknown }).text);
        }
        return "";
      })
      .join(" ");
  }
  return "";
}

function splitSentences(text: string): string[] {
  return text.split(SENTENCE_SPLIT_RE).filter((s) => s.trim().length > 0);
}

function applyRelevanceToText(
  text: string,
  query: string,
  cfg: ReturnType<typeof resolveRelevanceConfig>
): { result: string; changed: boolean } {
  if (text.length > MAX_INPUT_CHARS) return { result: text, changed: false };

  const sentences = splitSentences(text);
  if (sentences.length <= 1) return { result: text, changed: false };

  const scores = scoreSentences(sentences, query, cfg);
  const totalChars = text.length;
  const budget = Math.floor(totalChars * cfg.budgetPercent);

  const indexed = sentences.map((s, i) => ({ s, i, score: scores[i] }));
  const sorted = [...indexed].sort((a, b) => b.score - a.score);

  const keepSet = new Set<number>();

  // Force-preserved sentences (errors / code / numbers / URLs) are kept
  // unconditionally and are "free" — they do NOT consume the budget, so they
  // cannot starve the highest-relevance content.
  for (const { s, i } of indexed) {
    if (SENTENCE_PRESERVE_RE.test(s)) keepSet.add(i);
  }

  // Greedily admit non-force sentences by score desc, gated by overlapThreshold,
  // until the budget fills.
  let kept = 0;
  for (const { s, i, score } of sorted) {
    if (keepSet.has(i)) continue;
    if (kept >= budget) break;
    if (score >= cfg.overlapThreshold) {
      keepSet.add(i);
      kept += s.length + 1;
    }
  }

  // Never drop everything: keep at least the single highest-scoring sentence.
  if (keepSet.size === 0 && sorted.length > 0) keepSet.add(sorted[0].i);

  if (keepSet.size === sentences.length) return { result: text, changed: false };

  const ordered = indexed.filter(({ i }) => keepSet.has(i)).sort((a, b) => a.i - b.i);
  const result = ordered.map(({ s }) => s).join("");
  return { result, changed: result !== text };
}

export const relevanceEngine: CompressionEngine = {
  id: "relevance",
  name: "Relevance",
  description: "Extractive sentence scoring against the last user query.",
  icon: "target",
  targets: ["messages"],
  stackable: true,
  stackPriority: 18,
  metadata: {
    id: "relevance",
    name: "Relevance",
    description: "Extractive sentence scoring against the last user query.",
    inputScope: "messages",
    targetLatencyMs: 2,
    supportsPreview: true,
    stable: true,
  },

  apply(body, options): CompressionResult {
    try {
      const messages = body.messages;
      if (!Array.isArray(messages)) return { body, compressed: false, stats: null };

      const cfg = resolveRelevanceConfig((options?.stepConfig as Record<string, unknown>) ?? {});

      let query = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as Record<string, unknown>;
        if (msg.role === "user") {
          query = extractText(msg.content).trim();
          break;
        }
      }

      if (!query) return { body, compressed: false, stats: null };

      let anyChanged = false;
      const newMessages = messages.map((msg) => {
        const m = msg as Record<string, unknown>;
        if (m.role !== "user") return msg;

        if (typeof m.content === "string") {
          const { result, changed } = applyRelevanceToText(m.content, query, cfg);
          if (!changed) return msg;
          anyChanged = true;
          return { ...m, content: result };
        }
        // Array/multimodal content: only safe when there is EXACTLY ONE text
        // block. Joining all text blocks and stamping the result into each would
        // duplicate and scramble per-block content.
        if (Array.isArray(m.content)) {
          const textBlocks = m.content.filter(
            (b) => b && typeof b === "object" && "text" in b
          );
          if (textBlocks.length !== 1) return msg;
          const { result, changed } = applyRelevanceToText(
            String((textBlocks[0] as { text: unknown }).text),
            query,
            cfg
          );
          if (!changed) return msg;
          anyChanged = true;
          const newContent = m.content.map((block) =>
            block === textBlocks[0] ? { ...(block as object), text: result } : block
          );
          return { ...m, content: newContent };
        }
        return msg;
      });

      if (!anyChanged) return { body, compressed: false, stats: null };

      const newBody = { ...body, messages: newMessages };
      const stats = createCompressionStats(body, newBody, "stacked", ["relevance-extract"]);
      return { body: newBody, compressed: true, stats };
    } catch {
      return { body, compressed: false, stats: null };
    }
  },

  compress(body, config) {
    return this.apply(body, { stepConfig: config });
  },

  getConfigSchema() {
    return RELEVANCE_SCHEMA;
  },

  validateConfig(config) {
    return validateRelevanceConfig(config);
  },
};
