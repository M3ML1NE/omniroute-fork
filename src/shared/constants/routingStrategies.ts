export const ROUTING_STRATEGY_VALUES = [
  "priority",
  "weighted",
  "round-robin",
  "p2c",
  "least-used",
] as const;

export type RoutingStrategyValue = (typeof ROUTING_STRATEGY_VALUES)[number];

export const ACCOUNT_FALLBACK_STRATEGY_VALUES = [
  "priority",
  "weighted",
  "round-robin",
  "p2c",
  "least-used",
] as const;

export type AccountFallbackStrategyValue = (typeof ACCOUNT_FALLBACK_STRATEGY_VALUES)[number];

const REMOVED_STRATEGY_ALIASES: Record<string, RoutingStrategyValue> = {
  // Legacy alias kept: historical "usage" strategy is the current "least-used".
  usage: "least-used",
};

/**
 * Normalize a stored/legacy strategy value to one of the 5 supported strategies.
 *
 * Any removed strategy name (context-relay, fill-first, random, cost-optimized,
 * reset-aware, reset-window, strict-random, auto, lkgp, context-optimized, …)
 * degrades silently to "priority" so legacy DB combos keep working instead of
 * breaking. The single legacy alias "usage" maps to "least-used".
 */
export function normalizeRoutingStrategy(value: unknown): RoutingStrategyValue {
  if (typeof value !== "string") return "priority";
  const normalized = value.trim().toLowerCase();
  if (normalized in REMOVED_STRATEGY_ALIASES) return REMOVED_STRATEGY_ALIASES[normalized];
  return (ROUTING_STRATEGY_VALUES as readonly string[]).includes(normalized)
    ? (normalized as RoutingStrategyValue)
    : "priority";
}

type RoutingStrategyOption = {
  value: RoutingStrategyValue;
  labelKey: string;
  combosDescKey: string;
  settingsDescKey: string;
  icon: string;
};

export const ROUTING_STRATEGIES: RoutingStrategyOption[] = [
  {
    value: "priority",
    labelKey: "priority",
    combosDescKey: "priorityDesc",
    settingsDescKey: "priorityDesc",
    icon: "sort",
  },
  {
    value: "weighted",
    labelKey: "weighted",
    combosDescKey: "weightedDesc",
    settingsDescKey: "weightedDesc",
    icon: "percent",
  },
  {
    value: "round-robin",
    labelKey: "roundRobin",
    combosDescKey: "roundRobinDesc",
    settingsDescKey: "roundRobinDesc",
    icon: "autorenew",
  },
  {
    value: "p2c",
    labelKey: "p2c",
    combosDescKey: "p2cDesc",
    settingsDescKey: "p2cDesc",
    icon: "balance",
  },
  {
    value: "least-used",
    labelKey: "leastUsed",
    combosDescKey: "leastUsedDesc",
    settingsDescKey: "leastUsedDesc",
    icon: "low_priority",
  },
];

export const SETTINGS_FALLBACK_STRATEGY_VALUES = ACCOUNT_FALLBACK_STRATEGY_VALUES;
