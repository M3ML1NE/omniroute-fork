/**
 * GigaChat v2 non-streaming response -> OpenAI Chat Completions conversion.
 *
 * v2 returns a top-level `messages[]` (not OpenAI `choices[]`), a top-level
 * `finish_reason`, and a v2-shaped `usage`. With reasoning mode there may be two
 * messages: a `role:"reasoning"` chain-of-thought followed by the `role:"assistant"`
 * answer. This rebuilds the OpenAI `{choices:[...]}` envelope, folding the
 * reasoning text into the fork's `reasoning_content` extension field and
 * restoring original (un-sanitized) tool names via `toolNameMap`.
 */

import { mapGigaChatV2FinishReason, mapGigaChatV2Usage } from "./gigachatShared.ts";

type JsonRecord = Record<string, unknown>;

function collectText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const item of content) {
    if (item && typeof item === "object" && typeof (item as JsonRecord).text === "string") {
      text += (item as JsonRecord).text;
    }
  }
  return text;
}

function collectFunctionCalls(content: unknown): JsonRecord[] {
  if (!Array.isArray(content)) return [];
  const calls: JsonRecord[] = [];
  for (const item of content) {
    const fc = item && typeof item === "object" ? (item as JsonRecord).function_call : undefined;
    if (fc && typeof fc === "object" && !Array.isArray(fc)) calls.push(fc as JsonRecord);
  }
  return calls;
}

function buildToolCalls(
  calls: JsonRecord[],
  toolNameMap: Map<string, string> | null
): JsonRecord[] {
  return calls.map((fc, i) => {
    const sanitized = typeof fc.name === "string" ? fc.name : "";
    const restored = toolNameMap?.get(sanitized) ?? sanitized;
    const args =
      typeof fc.arguments === "string" ? fc.arguments : JSON.stringify(fc.arguments ?? {});
    return {
      id: `call_${restored || "function"}_${i}`,
      type: "function",
      function: { name: restored, arguments: args },
    };
  });
}

/**
 * Convert a parsed GigaChat v2 non-stream payload into an OpenAI Chat
 * Completions object. Returns a fresh OpenAI-shaped object.
 */
export function convertGigaChatV2NonStreamResponse(
  payload: unknown,
  toolNameMap: Map<string, string> | null
): JsonRecord {
  const root = payload && typeof payload === "object" ? (payload as JsonRecord) : {};
  const messages = Array.isArray(root.messages) ? (root.messages as JsonRecord[]) : [];

  let reasoningText = "";
  let assistant: JsonRecord | null = null;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "reasoning") {
      reasoningText += collectText(msg.content);
    } else if (msg.role === "assistant" && !assistant) {
      assistant = msg;
    }
  }
  if (!assistant && messages.length > 0) assistant = messages[messages.length - 1];

  const message: JsonRecord = { role: "assistant" };
  const content = assistant ? collectText(assistant.content) : "";
  const functionCalls = assistant ? collectFunctionCalls(assistant.content) : [];

  if (functionCalls.length > 0) {
    message.content = content || null;
    message.tool_calls = buildToolCalls(functionCalls, toolNameMap);
  } else {
    message.content = content;
  }
  if (reasoningText) message.reasoning_content = reasoningText;
  const stateId = assistant?.tools_state_id;
  if (typeof stateId === "string") message.tools_state_id = stateId;

  const finishReason = mapGigaChatV2FinishReason(root.finish_reason) ?? "stop";
  const created =
    typeof root.created_at === "number" ? root.created_at : Math.floor(Date.now() / 1000);

  const result: JsonRecord = {
    id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
    object: "chat.completion",
    created,
    model: typeof root.model === "string" ? root.model : "",
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  const usage = mapGigaChatV2Usage(root.usage);
  if (usage) result.usage = usage;

  return result;
}
