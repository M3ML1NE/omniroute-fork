/**
 * QuantumLock leaf module: category enum, span/config/stats types, constants, and the
 * fixed-order, ReDoS-bounded detection patterns. No imports — keeps every consumer one-way
 * (cycle-safe).
 */

export type QuantumCategory =
  | "uuid"
  | "unix_ts"
  | "long_hex"
  | "jwt"
  | "api_key_shape"
  | "request_id";

export interface VolatileSpan {
  start: number;
  end: number;
  category: QuantumCategory;
}

export interface QuantumLockConfig {
  enabled: boolean;
  /** Subset of categories to stabilize. Absent/empty ⇒ all categories. */
  categories?: QuantumCategory[];
}

export interface QuantumLockStats {
  fragments: number;
  categories: Partial<Record<QuantumCategory, number>>;
}

/** Idempotency sentinel + tail header. Its presence in system text ⇒ already stabilized. */
export const TAIL_DELIM = "⟦QUANTUMLOCK⟧";

/** Positional, value-independent placeholder. Depends ONLY on match index. */
export const placeholderFor = (i: number): string => `⟦Q${i}⟧`;

interface QuantumPattern {
  category: QuantumCategory;
  pattern: RegExp;
}

/**
 * Detection order is FIXED: most-specific / widest first so a token is never split.
 * Every variable-length run is bounded ({N,M}) — no unbounded quantifier (anti-ReDoS).
 */
export const QUANTUM_PATTERNS: QuantumPattern[] = [
  {
    category: "jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,512}(?![A-Za-z0-9_-])/g,
  },
  {
    category: "api_key_shape",
    pattern: /\b(?:sk|pk|rk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{16,200}\b/g,
  },
  {
    category: "api_key_shape",
    pattern: /\bBearer[ \t]{1,4}[A-Za-z0-9._-]{16,400}\b/g,
  },
  {
    category: "uuid",
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
  {
    category: "request_id",
    pattern: /\b(?:req|trace|span|corr|request)[-_][A-Za-z0-9]{6,128}\b/gi,
  },
  { category: "long_hex", pattern: /\b[0-9a-f]{16,128}\b/gi },
  { category: "unix_ts", pattern: /\b1[0-9]{9}(?:[0-9]{3})?\b/g },
];
