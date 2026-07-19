// Default pricing rates for AI models
// All rates are in dollars per million tokens ($/1M tokens)
// GigaChat fork — only GigaChat pricing retained

const GIGACHAT_PRICING = {
  GigaChat: {
    input: 0,
    output: 0,
    cached: 0,
    reasoning: 0,
    cache_creation: 0,
  },
  "GigaChat-Pro": {
    input: 0,
    output: 0,
    cached: 0,
    reasoning: 0,
    cache_creation: 0,
  },
  "GigaChat-Max": {
    input: 0,
    output: 0,
    cached: 0,
    reasoning: 0,
    cache_creation: 0,
  },
};

export const DEFAULT_PRICING = {
  // GigaChat (Sber)
  gigachat: GIGACHAT_PRICING,
  // Family keys: apply to every dynamic <type>-<uuid> connection; prices user-set via /api/pricing.
  "gigachat-compatible": GIGACHAT_PRICING,
  "openai-compatible": {},
};

type ProviderPricingTable = Record<string, Record<string, unknown>>;
type PricingRow = {
  input: number;
  output: number;
  cached?: number;
  reasoning?: number;
  cache_creation?: number;
};
type TokenUsage = Record<string, number | undefined>;

/**
 * Get pricing for a specific provider and model
 */
export function getPricingForModel(
  provider: string,
  model: string
): Record<string, unknown> | null {
  if (!provider || !model) return null;

  const providerPricing = (DEFAULT_PRICING as ProviderPricingTable)[provider];
  if (!providerPricing) return null;

  const modelPricing = providerPricing[model];
  if (!modelPricing || typeof modelPricing !== "object") return null;
  return modelPricing as Record<string, unknown>;
}

/**
 * Get all pricing data
 */
export function getDefaultPricing() {
  return DEFAULT_PRICING;
}

export { formatCost } from "../utils/formatting";

/**
 * Calculate cost from tokens and pricing
 */
export function calculateCostFromTokens(
  tokens: TokenUsage | null | undefined,
  pricing: PricingRow | null | undefined
): number {
  if (!tokens || !pricing) return 0;

  let cost = 0;

  // Input tokens (non-cached)
  const inputTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
  const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
  const nonCachedInput = Math.max(0, inputTokens - cachedTokens);

  cost += nonCachedInput * (pricing.input / 1000000);

  // Cached tokens
  if (cachedTokens > 0) {
    const cachedRate = pricing.cached || pricing.input;
    cost += cachedTokens * (cachedRate / 1000000);
  }

  // Output tokens
  const outputTokens = tokens.completion_tokens || tokens.output_tokens || 0;
  cost += outputTokens * (pricing.output / 1000000);

  // Reasoning tokens
  const reasoningTokens = tokens.reasoning_tokens || 0;
  if (reasoningTokens > 0) {
    const reasoningRate = pricing.reasoning || pricing.output;
    cost += reasoningTokens * (reasoningRate / 1000000);
  }

  // Cache creation tokens
  const cacheCreationTokens = tokens.cache_creation_input_tokens || 0;
  if (cacheCreationTokens > 0) {
    const cacheCreationRate = pricing.cache_creation || pricing.input;
    cost += cacheCreationTokens * (cacheCreationRate / 1000000);
  }

  return cost;
}
