/**
 * Shared GigaChat conversion primitives used by both the v1 and v2 executor
 * paths. Extracted from default.ts so the v2 modules reuse the exact same name
 * sanitization, tool-call-id resolution, and error semantics as v1 — no drift.
 */

export class GigaChat400Error extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "GigaChat400Error";
  }
}

export function sanitizeGigaChatName(name: string): string {
  return name.replace(/-/g, "_");
}

/**
 * Build a map from `tool_call_id` -> (sanitized) function name by scanning the
 * assistant messages in conversation history. GigaChat tool-result messages must
 * carry the function `name`, but OpenAI tool-result messages only carry
 * `tool_call_id`; this recovers the name the assistant originally used.
 */
export function buildToolCallIdNameMap(messages: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const record = msg as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    const toolCalls = record.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      if (!call || typeof call !== "object") continue;
      const callRecord = call as Record<string, unknown>;
      const id = callRecord.id;
      const fn = callRecord.function;
      if (typeof id !== "string" || !fn || typeof fn !== "object") continue;
      const name = (fn as Record<string, unknown>).name;
      if (typeof name === "string" && name) {
        map.set(id, sanitizeGigaChatName(name));
      }
    }
  }
  return map;
}

/**
 * Map v2 usage (`input_tokens`/`output_tokens`/`input_tokens_details.cached_tokens`
 * and the stream-shaped `precached_prompt_tokens`) onto the OpenAI usage shape
 * (`prompt_tokens`/`completion_tokens`/`prompt_tokens_details.cached_tokens`).
 * Returns a fresh OpenAI-shaped usage object, or null when no usage is present.
 */
export function mapGigaChatV2Usage(usage: unknown): Record<string, unknown> | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;

  const prompt = typeof u.input_tokens === "number" ? u.input_tokens : u.prompt_tokens;
  const completion = typeof u.output_tokens === "number" ? u.output_tokens : u.completion_tokens;
  const total = typeof u.total_tokens === "number" ? u.total_tokens : undefined;

  const out: Record<string, unknown> = {};
  if (typeof prompt === "number") out.prompt_tokens = prompt;
  if (typeof completion === "number") out.completion_tokens = completion;
  if (typeof total === "number") out.total_tokens = total;

  const details =
    u.input_tokens_details && typeof u.input_tokens_details === "object"
      ? (u.input_tokens_details as Record<string, unknown>)
      : null;
  const cached =
    (details && typeof details.cached_tokens === "number" ? details.cached_tokens : undefined) ??
    (typeof u.precached_prompt_tokens === "number" ? u.precached_prompt_tokens : undefined);
  if (typeof cached === "number") {
    out.prompt_tokens_details = { cached_tokens: cached };
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Map a GigaChat v2 top-level `finish_reason` onto the OpenAI equivalent:
 * `function_call` -> `tool_calls`; content-safety reasons -> `content_filter`;
 * everything else (`stop`, `length`, ...) passes through unchanged.
 */
export function mapGigaChatV2FinishReason(reason: unknown): string | undefined {
  if (typeof reason !== "string") return undefined;
  if (reason === "function_call") return "tool_calls";
  if (reason === "blacklist" || reason === "response_blacklist" || reason.startsWith("request_")) {
    return "content_filter";
  }
  return reason;
}

/**
 * Map a GigaChat v1 `finish_reason` value onto the OpenAI equivalent. Per the
 * official v1 API, `finish_reason` is one of `stop|length|function_call|blacklist|error`.
 * `blacklist` is GigaChat's content-safety/censorship signal — the OpenAI
 * equivalent is `content_filter`. `function_call` is handled separately by the
 * tool-call conversion (mapped to `tool_calls`); `error` is left untouched
 * (GigaChat uses it for invalid function arguments, with no clean OpenAI
 * equivalent); everything else passes through unchanged.
 */
export function mapGigaChatV1BlacklistFinishReason(reason: unknown): string | undefined {
  if (typeof reason !== "string") return undefined;
  return reason === "blacklist" ? "content_filter" : reason;
}
