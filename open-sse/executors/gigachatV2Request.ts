/**
 * OpenAI Chat Completions -> GigaChat v2 request conversion.
 *
 * v2 differs fundamentally from v1: message `content` is an array of content
 * items, top-level sampling params move under `model_options`, `tools` become a
 * single `{functions:{specifications:[...]}}` wrapper, `tool_choice` becomes
 * `tool_config`, and assistant/tool messages carry `function_call`/
 * `function_result` content items. The conversion mirrors v1's design: it runs
 * inside the executor after the generic OpenAI translation and stashes a
 * `_toolNameMap` reverse-map for the response side.
 */

import { normalizeGigaChatToolSchema } from "./gigachatSchema.ts";
import {
  GigaChat400Error,
  buildToolCallIdNameMap,
  sanitizeGigaChatName,
} from "./gigachatShared.ts";

type JsonRecord = Record<string, unknown>;

const MODEL_OPTION_KEYS = [
  "temperature",
  "top_p",
  "max_tokens",
  "repetition_penalty",
  "update_interval",
  "unnormalized_history",
  "top_logprobs",
] as const;

const UNSUPPORTED_TOP_LEVEL_KEYS = [
  "stream_options",
  "n",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "user",
  "reasoning_effort",
  "reasoning",
  "response_format",
] as const;

/** Convert an OpenAI message `content` (string or multi-part) into v2 items. */
function toContentItems(content: unknown): JsonRecord[] {
  if (typeof content === "string") return [{ text: content }];
  if (Array.isArray(content)) {
    const items: JsonRecord[] = [];
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as JsonRecord).text === "string") {
        items.push({ text: (part as JsonRecord).text });
      }
    }
    return items;
  }
  return [];
}

/** Move OpenAI top-level sampling params under `model_options`. */
function buildModelOptions(body: JsonRecord): JsonRecord {
  const options: JsonRecord = {};
  for (const key of MODEL_OPTION_KEYS) {
    if (key in body) {
      options[key] = body[key];
      delete body[key];
    }
  }
  if ("max_completion_tokens" in body) {
    if (!("max_tokens" in options)) options.max_tokens = body.max_completion_tokens;
    delete body.max_completion_tokens;
  }
  const reasoning = body.reasoning as JsonRecord | undefined;
  if (typeof body.reasoning_effort === "string" || (reasoning && "effort" in reasoning)) {
    options.reasoning = { effort: "medium" };
  }
  const rf = body.response_format;
  if (rf && typeof rf === "object" && !Array.isArray(rf)) {
    const rfRecord = rf as JsonRecord;
    if (rfRecord.type === "text") {
      options.response_format = { type: "text" };
    } else if (rfRecord.type === "json_schema") {
      const inner = (rfRecord.json_schema as JsonRecord | undefined) ?? rfRecord;
      options.response_format = {
        type: "json_schema",
        schema: normalizeGigaChatToolSchema(inner.schema),
        ...(inner.strict !== undefined ? { strict: inner.strict } : {}),
      };
    }
  }
  return options;
}

/** Convert OpenAI `tools[]` into a single v2 `tools:[{functions:{specifications}}]`. */
function convertTools(body: JsonRecord, toolNameMap: Map<string, string>): void {
  if (!Array.isArray(body.tools)) return;
  const specifications: JsonRecord[] = [];
  for (const tool of body.tools as JsonRecord[]) {
    const fn = tool && typeof tool === "object" ? (tool.function as JsonRecord) : undefined;
    if (!fn || typeof fn !== "object") continue;
    const originalName = String(fn.name || "");
    const safeName = sanitizeGigaChatName(originalName);
    if (originalName !== safeName) toolNameMap.set(safeName, originalName);
    specifications.push({
      name: safeName,
      description: fn.description,
      parameters: normalizeGigaChatToolSchema(fn.parameters),
    });
  }
  body.tools = [{ functions: { specifications } }];
}

/** Convert OpenAI `tool_choice` into v2 `tool_config`. */
function convertToolChoice(body: JsonRecord): void {
  if (!("tool_choice" in body)) return;
  const choice = body.tool_choice;
  let config: JsonRecord = { mode: "auto" };
  if (choice === "none") {
    config = { mode: "none" };
  } else if (choice === "auto" || choice === "required") {
    config = { mode: "auto" };
  } else if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    const fn = (choice as JsonRecord).function as JsonRecord | undefined;
    if (fn && typeof fn.name === "string" && fn.name) {
      config = { mode: "forced", function_name: sanitizeGigaChatName(fn.name) };
    }
  }
  body.tool_config = config;
  delete body.tool_choice;
}

/** Wrap a tool-result payload as a JSON-object string (v2 `function_result.result`). */
function toResultObjectString(content: unknown): string {
  const str = typeof content === "string" ? content.trim() : JSON.stringify(content ?? {});
  if (str.startsWith("{") && str.endsWith("}")) {
    try {
      const parsed = JSON.parse(str);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return str;
    } catch {
      // fall through to wrapping
    }
  }
  return JSON.stringify({ result: str });
}

/** Convert a single OpenAI message into its GigaChat v2 shape. */
function convertMessage(msg: JsonRecord, idMap: Map<string, string>): JsonRecord {
  const stateId = msg.tools_state_id ?? msg.functions_state_id;

  if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    const first = msg.tool_calls[0] as JsonRecord;
    const fn = first?.function as JsonRecord | undefined;
    const item: JsonRecord = {};
    if (fn) {
      const name = sanitizeGigaChatName(String(fn.name || ""));
      const args =
        typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      item.function_call = { name, arguments: args };
    }
    return {
      role: "assistant",
      content: [item],
      ...(typeof stateId === "string" ? { tools_state_id: stateId } : {}),
    };
  }

  if (msg.role === "tool" || msg.role === "function") {
    let name = typeof msg.name === "string" && msg.name ? sanitizeGigaChatName(msg.name) : null;
    if (!name && typeof msg.tool_call_id === "string") {
      const resolved = idMap.get(msg.tool_call_id);
      if (!resolved) {
        throw new GigaChat400Error(
          `Unresolvable tool_call_id "${msg.tool_call_id}": no prior assistant message emitted a matching tool_call. Cannot map to a GigaChat function name.`
        );
      }
      name = resolved;
    }
    if (!name) {
      throw new GigaChat400Error(
        "GigaChat function result message is missing both 'name' and 'tool_call_id'; cannot determine the function name."
      );
    }
    return {
      role: "tool",
      content: [{ function_result: { name, result: toResultObjectString(msg.content) } }],
    };
  }

  return {
    role: msg.role,
    content: toContentItems(msg.content),
    ...(typeof stateId === "string" ? { tools_state_id: stateId } : {}),
  };
}

/**
 * Convert an already-OpenAI-normalized request body into GigaChat v2 shape.
 * Mutates and returns `body`; stashes `_toolNameMap` when any tool name was
 * sanitized so the response converter can restore original names.
 */
export function convertGigaChatV2Request(body: JsonRecord): JsonRecord {
  const toolNameMap = new Map<string, string>();

  const idMap = Array.isArray(body.messages)
    ? buildToolCallIdNameMap(body.messages)
    : new Map<string, string>();

  convertTools(body, toolNameMap);
  convertToolChoice(body);

  const modelOptions = buildModelOptions(body);
  for (const key of UNSUPPORTED_TOP_LEVEL_KEYS) delete body[key];
  if (Object.keys(modelOptions).length > 0) body.model_options = modelOptions;

  if (Array.isArray(body.messages)) {
    body.messages = (body.messages as unknown[]).map((msg) =>
      msg && typeof msg === "object" ? convertMessage(msg as JsonRecord, idMap) : msg
    );
  }

  if (toolNameMap.size > 0) body._toolNameMap = toolNameMap;
  return body;
}
