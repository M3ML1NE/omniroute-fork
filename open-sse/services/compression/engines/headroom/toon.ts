/**
 * toon.ts — TOON candidate-encoder slot for the headroom engine (fail-open stub).
 *
 * TOON was a second encoder considered alongside GCF in the SmartCrusher best-of-N
 * gate. In this fork the optional `@toon-format/toon` dependency is NOT installed
 * (zero supply-chain surface), so TOON is permanently unavailable: encodeToonBlock
 * returns null and TOON is never chosen as a winner, leaving GCF as the sole encoder.
 *
 * The public shape (fence markers, encode/wrap/decode) is preserved so smartcrusher,
 * tabular, encoderComparison and index keep compiling and their FAIL-OPEN contract
 * holds: any missing TOON path yields null/[] and can never break headroom compaction.
 * Pure: no Date.now / Math.random.
 */

export const TOON_FENCE_OPEN = "```toon";
export const TOON_FENCE_CLOSE = "```";

/** TOON encoder unavailable in this fork — always fail open so GCF wins. */
export function encodeToonBlock(_arr: Record<string, unknown>[]): string | null {
  return null;
}

export function wrapToon(blockContent: string): string {
  return `${TOON_FENCE_OPEN}\n${blockContent}\n${TOON_FENCE_CLOSE}`;
}

/** TOON decoder unavailable in this fork — always fail open (no TOON block is ever emitted). */
export function decodeToon(_text: string): Record<string, unknown>[] {
  return [];
}
