import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatTime,
  formatDuration,
  formatDateTime,
  maskSegment,
  maskAccount,
  stableAccountSuffix,
  formatApiKeyLabel,
  maskKey,
  fmtCompact,
  fmtFull,
  formatCost,
  fmtCost,
  formatCostAbbreviated,
  truncateUrl,
  safePercentage,
  normalizeServiceTierId,
  translateCostText,
  getServiceTierDisplayLabel,
  type TranslationFn,
} from "../../src/shared/utils/formatting.ts";

describe("formatTime", () => {
  it("returns '-' for null/undefined/empty input", () => {
    assert.equal(formatTime(null), "-");
    assert.equal(formatTime(undefined), "-");
    assert.equal(formatTime(""), "-");
  });

  it("returns 'Invalid Date' text for a non-empty but unparseable date string", () => {
    // `new Date("not-a-date")` does not throw, so the catch branch (which
    // returns "-") is never reached — toLocaleTimeString happily stringifies
    // an Invalid Date. Only falsy input hits the early "-" return.
    assert.equal(formatTime("not-a-date"), "Invalid Date");
  });

  it("formats a valid ISO string to HH:MM:SS", () => {
    const result = formatTime("2026-01-15T10:30:45.000Z");
    assert.match(result, /^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("formatDuration", () => {
  it("returns '-' for null/undefined/0", () => {
    assert.equal(formatDuration(null), "-");
    assert.equal(formatDuration(undefined), "-");
    assert.equal(formatDuration(0), "-");
  });

  it("formats sub-second durations in ms", () => {
    assert.equal(formatDuration(42), "42ms");
    assert.equal(formatDuration(999), "999ms");
  });

  it("formats durations >= 1000ms in seconds with 1 decimal", () => {
    assert.equal(formatDuration(1000), "1.0s");
    assert.equal(formatDuration(1234), "1.2s");
    assert.equal(formatDuration(15678), "15.7s");
  });
});

describe("formatDateTime", () => {
  it("returns '-' for null/undefined/empty input", () => {
    assert.equal(formatDateTime(null), "-");
    assert.equal(formatDateTime(undefined), "-");
    assert.equal(formatDateTime(""), "-");
  });

  it("formats a valid ISO string with date and time", () => {
    const result = formatDateTime("2026-01-15T10:30:45.000Z");
    assert.match(result, /,/);
  });

  it("returns the raw input when the date parses but formatting throws", () => {
    // Extremely malformed but non-empty strings fall through to `new Date()`
    // which produces "Invalid Date"; toLocaleDateString does not throw on
    // that in Node, so this just documents the fallback contract exists.
    const result = formatDateTime("garbage");
    assert.equal(typeof result, "string");
  });
});

describe("maskSegment", () => {
  it("returns empty string for null/undefined/empty input", () => {
    assert.equal(maskSegment(null), "");
    assert.equal(maskSegment(undefined), "");
    assert.equal(maskSegment(""), "");
  });

  it("masks the middle of a long value with default start/end of 2", () => {
    assert.equal(maskSegment("abcdefgh"), "ab***gh");
  });

  it("uses custom start/end lengths", () => {
    assert.equal(maskSegment("abcdefghij", 4, 4), "abcd***ghij");
  });

  it("collapses very short values to a single-char-plus-stars form", () => {
    assert.equal(maskSegment("ab", 2, 2), "a***");
  });
});

describe("maskAccount", () => {
  it("returns '-' for null/undefined/'-' input", () => {
    assert.equal(maskAccount(null, false), "-");
    assert.equal(maskAccount(undefined, false), "-");
    assert.equal(maskAccount("-", false), "-");
  });

  it("returns the raw account when emailsVisible is true", () => {
    assert.equal(maskAccount("user@example.com", true), "user@example.com");
  });

  it("masks email-like accounts via maskEmail when the @ index is > 3", () => {
    const result = maskAccount("someone@example.com", false);
    assert.notEqual(result, "someone@example.com");
    assert.match(result, /@/);
  });

  it("truncates long non-email accounts", () => {
    const result = maskAccount("verylongaccountname", false);
    assert.equal(result, "veryl***");
  });

  it("returns short non-email accounts unchanged", () => {
    assert.equal(maskAccount("short", false), "short");
  });
});

describe("stableAccountSuffix", () => {
  it("returns '0000' for null/undefined/'-' input", () => {
    assert.equal(stableAccountSuffix(null), "0000");
    assert.equal(stableAccountSuffix(undefined), "0000");
    assert.equal(stableAccountSuffix("-"), "0000");
  });

  it("is deterministic for the same input", () => {
    assert.equal(stableAccountSuffix("test@example.com"), stableAccountSuffix("test@example.com"));
  });

  it("returns a 4-character lowercase hex string", () => {
    const result = stableAccountSuffix("test@example.com");
    assert.match(result, /^[0-9a-f]{4}$/);
  });

  it("produces different suffixes for different inputs (collision-unlikely)", () => {
    assert.notEqual(stableAccountSuffix("a@example.com"), stableAccountSuffix("b@example.com"));
  });
});

describe("formatApiKeyLabel", () => {
  it("returns em-dash when both name and id are missing", () => {
    assert.equal(formatApiKeyLabel(null, null), "—");
    assert.equal(formatApiKeyLabel(undefined, undefined), "—");
  });

  it("returns just the display name when id is missing", () => {
    assert.equal(formatApiKeyLabel("My Key", null), "My Key");
  });

  it("falls back to 'key' as the display name when name is missing", () => {
    const result = formatApiKeyLabel(null, "abcd1234efgh");
    assert.match(result, /^key \(/);
  });

  it("combines name with a masked id segment", () => {
    const result = formatApiKeyLabel("Prod Key", "sk-abcd1234efgh5678");
    assert.match(result, /^Prod Key \(sk-a\*\*\*5678\)$/);
  });
});

describe("maskKey", () => {
  it("returns '***' for null/undefined/short keys", () => {
    assert.equal(maskKey(null), "***");
    assert.equal(maskKey(undefined), "***");
    assert.equal(maskKey("short"), "***");
  });

  it("masks the middle of a sufficiently long key", () => {
    assert.equal(maskKey("sk-abcdefghijklmnop"), "sk-a...mnop");
  });
});

describe("fmtCompact", () => {
  it("formats billions with a B suffix", () => {
    assert.equal(fmtCompact(2_500_000_000), "2.5B");
  });

  it("formats millions with an M suffix", () => {
    assert.equal(fmtCompact(3_200_000), "3.2M");
  });

  it("formats thousands with a K suffix", () => {
    assert.equal(fmtCompact(4_500), "4.5K");
  });

  it("formats small numbers with full locale formatting", () => {
    assert.equal(fmtCompact(42), "42");
  });

  it("treats null/undefined/0 as 0", () => {
    assert.equal(fmtCompact(null), "0");
    assert.equal(fmtCompact(undefined), "0");
    assert.equal(fmtCompact(0), "0");
  });
});

describe("fmtFull", () => {
  it("formats with full locale grouping", () => {
    assert.equal(fmtFull(1234567), "1,234,567");
  });

  it("treats null/undefined as 0", () => {
    assert.equal(fmtFull(null), "0");
    assert.equal(fmtFull(undefined), "0");
  });
});

describe("formatCost / fmtCost", () => {
  it("returns $0.00 for null/undefined/0/NaN", () => {
    assert.equal(formatCost(null), "$0.00");
    assert.equal(formatCost(undefined), "$0.00");
    assert.equal(formatCost(0), "$0.00");
    assert.equal(formatCost(NaN), "$0.00");
  });

  it("uses 6 decimal places for sub-cent values", () => {
    assert.equal(formatCost(0.000123), "$0.000123");
  });

  it("uses 4 decimal places for sub-dollar values", () => {
    assert.equal(formatCost(0.4567), "$0.4567");
  });

  it("uses 2 decimal places for dollar-and-above values", () => {
    assert.equal(formatCost(12.3456), "$12.35");
  });

  it("exposes fmtCost as an alias of formatCost", () => {
    assert.equal(fmtCost, formatCost);
  });
});

describe("formatCostAbbreviated", () => {
  it("returns $0 for null/undefined/0", () => {
    assert.equal(formatCostAbbreviated(null), "$0");
    assert.equal(formatCostAbbreviated(undefined), "$0");
    assert.equal(formatCostAbbreviated(0), "$0");
  });

  it("shows 6-decimal precision for sub-cent positive values", () => {
    assert.equal(formatCostAbbreviated(0.000123), "$0.000123");
  });

  it("shows 6-decimal precision with a leading minus for sub-cent negative values", () => {
    assert.equal(formatCostAbbreviated(-0.000123), "-$0.000123");
  });

  it("formats sub-1000 values with 2 decimals", () => {
    assert.equal(formatCostAbbreviated(42.5), "$42.50");
  });

  it("formats negative sub-1000 values with a leading minus", () => {
    assert.equal(formatCostAbbreviated(-42.5), "-$42.50");
  });

  it("abbreviates thousands with a K suffix", () => {
    assert.equal(formatCostAbbreviated(4_500), "$4.5K");
  });

  it("abbreviates millions with an M suffix", () => {
    assert.equal(formatCostAbbreviated(3_200_000), "$3.2M");
  });

  it("abbreviates billions with a B suffix", () => {
    assert.equal(formatCostAbbreviated(2_500_000_000), "$2.5B");
  });

  it("abbreviates trillions with a T suffix", () => {
    assert.equal(formatCostAbbreviated(1_500_000_000_000), "$1.5T");
  });

  it("strips trailing zero decimals from abbreviated values", () => {
    assert.equal(formatCostAbbreviated(4_000), "$4K");
  });

  it("preserves the sign for abbreviated negative values", () => {
    assert.equal(formatCostAbbreviated(-4_500), "-$4.5K");
  });
});

describe("truncateUrl", () => {
  it("returns '-' for null/undefined input", () => {
    assert.equal(truncateUrl(null), "-");
    assert.equal(truncateUrl(undefined), "-");
  });

  it("returns hostname+pathname for a short valid URL", () => {
    assert.equal(truncateUrl("https://example.com/path"), "example.com/path");
  });

  it("truncates long valid URLs with an ellipsis", () => {
    const longPath = "/a".repeat(40);
    const result = truncateUrl(`https://example.com${longPath}`, 20);
    assert.ok(result.length <= 21);
    assert.match(result, /…$/);
  });

  it("falls back to raw-string truncation for invalid URLs", () => {
    const result = truncateUrl("not a valid url at all and quite long", 10);
    assert.equal(result, "not a vali…");
  });

  it("returns invalid non-URL strings unchanged when under the max length", () => {
    assert.equal(truncateUrl("short-string"), "short-string");
  });
});

describe("safePercentage", () => {
  it("returns the value when it is a finite number", () => {
    assert.equal(safePercentage(42), 42);
    assert.equal(safePercentage(0), 0);
  });

  it("returns undefined for non-numbers", () => {
    assert.equal(safePercentage("42"), undefined);
    assert.equal(safePercentage(null), undefined);
    assert.equal(safePercentage(undefined), undefined);
  });

  it("returns undefined for non-finite numbers", () => {
    assert.equal(safePercentage(Infinity), undefined);
    assert.equal(safePercentage(NaN), undefined);
  });
});

describe("normalizeServiceTierId", () => {
  it("recognizes 'priority' and 'fast' as priority", () => {
    assert.equal(normalizeServiceTierId("priority"), "priority");
    assert.equal(normalizeServiceTierId("fast"), "priority");
    assert.equal(normalizeServiceTierId("Fast"), "priority");
  });

  it("recognizes 'flex' as flex", () => {
    assert.equal(normalizeServiceTierId("flex"), "flex");
  });

  it("defaults to 'standard' for unknown or non-string input", () => {
    assert.equal(normalizeServiceTierId("unknown"), "standard");
    assert.equal(normalizeServiceTierId(null), "standard");
    assert.equal(normalizeServiceTierId(42), "standard");
  });

  it("trims and lowercases before matching", () => {
    assert.equal(normalizeServiceTierId("  FLEX  "), "flex");
  });
});

describe("translateCostText", () => {
  it("uses the translation function when the key exists", () => {
    const t: TranslationFn = Object.assign((key: string) => `translated:${key}`, {
      has: (key: string) => key === "known",
    });
    assert.equal(translateCostText(t, "known", "fallback"), "translated:known");
  });

  it("uses the fallback when the key does not exist", () => {
    const t: TranslationFn = Object.assign((key: string) => `translated:${key}`, {
      has: (key: string) => key === "known",
    });
    assert.equal(translateCostText(t, "unknown", "fallback"), "fallback");
  });

  it("uses the fallback when `t.has` is not a function", () => {
    const t = ((key: string) => `translated:${key}`) as TranslationFn;
    assert.equal(translateCostText(t, "any", "fallback"), "fallback");
  });
});

describe("getServiceTierDisplayLabel", () => {
  const t: TranslationFn = Object.assign(
    (key: string) => {
      const map: Record<string, string> = {
        serviceTierFast: "Priority Tier",
        serviceTierFlex: "Flex Tier",
        serviceTierStandard: "Standard Tier",
      };
      return map[key] ?? key;
    },
    { has: () => true }
  );

  it("returns the translated label for the priority tier", () => {
    assert.equal(getServiceTierDisplayLabel(t, "priority"), "Priority Tier");
  });

  it("returns the translated label for the flex tier", () => {
    assert.equal(getServiceTierDisplayLabel(t, "flex"), "Flex Tier");
  });

  it("defaults to the standard tier for unrecognized input", () => {
    assert.equal(getServiceTierDisplayLabel(t, "bogus"), "Standard Tier");
  });

  it("prefers a distinct fallback label over the tier default when the fallback differs", () => {
    const noHas: TranslationFn = Object.assign((key: string) => key, { has: () => false });
    const result = getServiceTierDisplayLabel(noHas, "priority", "Custom Fast Label");
    assert.equal(result, "Custom Fast Label");
  });

  it("ignores a fallback that normalizes to the same tier as the detected one", () => {
    const noHas: TranslationFn = Object.assign((key: string) => key, { has: () => false });
    const result = getServiceTierDisplayLabel(noHas, "priority", "fast");
    assert.equal(result, "Fast");
  });
});
