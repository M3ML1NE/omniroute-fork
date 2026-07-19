// Ported from OmniRoute upstream v3.8.48, adapted for GigaChat fork
//
// Adaptation: upstream shipped an 11-entry catalog. The GigaChat fork registers only
// the 9 engines in `engines/index.ts` (lite, caveman, aggressive, ultra, rtk, relevance,
// session-dedup, ccr, headroom), so the unported `llmlingua` (SLM/ONNX) and `omniglyph`
// (context-as-image) entries are dropped. The EngineMeta contract and ENGINE_IDS ordering
// (by stackPriority) are preserved.

export interface EngineMeta {
  id: string;
  label: string;
  stackPriority: number;
  levels?: string[]; // intensity options; undefined = no level selector
  isSingleMode: boolean; // can be the effective mode when it is the only engine on
  description: string;
}

export const ENGINE_CATALOG: Record<string, EngineMeta> = {
  "session-dedup": {
    id: "session-dedup",
    label: "Session Dedup",
    stackPriority: 3,
    isSingleMode: false,
    description: "Cross-turn block deduplication.",
  },
  ccr: {
    id: "ccr",
    label: "CCR (Retrieval)",
    stackPriority: 4,
    isSingleMode: false,
    description: "Content-addressed retrieval markers.",
  },
  lite: {
    id: "lite",
    label: "Lite",
    stackPriority: 5,
    isSingleMode: true,
    description: "Whitespace/format cleanup.",
  },
  rtk: {
    id: "rtk",
    label: "RTK",
    stackPriority: 10,
    levels: ["minimal", "standard", "aggressive"],
    isSingleMode: true,
    description: "Command-output filtering.",
  },
  headroom: {
    id: "headroom",
    label: "Headroom",
    stackPriority: 15,
    isSingleMode: false,
    description: "Tabular JSON compaction.",
  },
  relevance: {
    id: "relevance",
    label: "Relevance",
    stackPriority: 18,
    isSingleMode: true,
    description: "Extractive sentence scoring against the last user query.",
  },
  caveman: {
    id: "caveman",
    label: "Caveman",
    stackPriority: 20,
    levels: ["lite", "full", "ultra"],
    isSingleMode: true,
    description: "Rule-based prose compression.",
  },
  aggressive: {
    id: "aggressive",
    label: "Aggressive",
    stackPriority: 30,
    isSingleMode: true,
    description: "Summarize + age old turns.",
  },
  ultra: {
    id: "ultra",
    label: "Ultra",
    stackPriority: 40,
    isSingleMode: true,
    description: "Heuristic token pruning.",
  },
};

export const ENGINE_IDS: string[] = Object.values(ENGINE_CATALOG)
  .sort((a, b) => a.stackPriority - b.stackPriority)
  .map((e) => e.id);

export function engineMeta(id: string): EngineMeta {
  return ENGINE_CATALOG[id];
}
