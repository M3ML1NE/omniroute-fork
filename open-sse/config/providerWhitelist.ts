/**
 * Provider Whitelist
 *
 * Exhaustive list of provider IDs allowed in this fork.
 * All other providers stripped from providerRegistry.ts (Task 8).
 * Source of truth for runtime validation.
 */

export const PROVIDER_WHITELIST = [
  "gigachat-compatible",
  "openai-compatible",
] as const;

export type AllowedProvider = (typeof PROVIDER_WHITELIST)[number];

/**
 * Returns true if given provider ID is in the whitelist.
 */
export function isAllowedProvider(id: string): id is AllowedProvider {
  return (PROVIDER_WHITELIST as readonly string[]).includes(id);
}
