/**
 * Centralized specifications for AI Models.
 * Contains maximum token caps and thinking budgets to prevent API errors
 * when clients request more than the model supports.
 */

export interface ModelSpec {
  maxOutputTokens: number;
  contextWindow?: number;
  defaultThinkingBudget?: number;
  thinkingBudgetCap?: number;
  thinkingOverhead?: number; // buffer de tokens para thinking
  adaptiveMaxTokens?: number; // tokens disponíveis para output quando thinking ativo
  aliases?: string[]; // IDs alternativos para este modelo
  supportsThinking?: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;
}

export const MODEL_SPECS: Record<string, ModelSpec> = {
  // Named-model entries removed (GigaChat fork — see compatible-only-provider-docs-purge plan).
  // Model capabilities/limits now come exclusively from each connection's live discovery
  // (synced-available-models cache), never from a static named-model table.
  __default__: {
    maxOutputTokens: 8192,
  },
};

export function getModelSpec(modelId: string): ModelSpec | undefined {
  if (MODEL_SPECS[modelId]) return MODEL_SPECS[modelId];

  // Buscas por alias
  for (const [canonical, spec] of Object.entries(MODEL_SPECS)) {
    if (spec.aliases?.includes(modelId)) return spec;
  }

  // Prefix matching
  for (const [key, spec] of Object.entries(MODEL_SPECS)) {
    if (key !== "__default__" && modelId.startsWith(key)) return spec;
  }

  return undefined;
}

export function capMaxOutputTokens(modelId: string, requested?: number): number {
  const spec = getModelSpec(modelId);
  const cap = spec?.maxOutputTokens ?? MODEL_SPECS.__default__.maxOutputTokens;
  return requested ? Math.min(requested, cap) : cap;
}

export function getDefaultThinkingBudget(modelId: string): number {
  return getModelSpec(modelId)?.defaultThinkingBudget ?? 0;
}

export function capThinkingBudget(modelId: string, budget: number): number {
  const cap = getModelSpec(modelId)?.thinkingBudgetCap ?? budget;
  return Math.min(budget, cap);
}

export function resolveModelAlias(modelId: string): string {
  for (const [canonical, spec] of Object.entries(MODEL_SPECS)) {
    if (spec.aliases?.includes(modelId)) return canonical;
  }
  return modelId;
}
