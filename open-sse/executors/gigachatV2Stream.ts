/**
 * GigaChat v2 SSE -> OpenAI Chat Completions SSE TransformStream.
 *
 * v2 streaming uses NAMED events (`response.message.delta` / `response.message.done`,
 * plus `response.tool.*`) and never emits `data: [DONE]`. The per-event `data:`
 * payloads are OpenAI-chunk-shaped but may carry v2-shaped usage
 * (`input_tokens`/`output_tokens`) and `finish_reason:"function_call"`; a done
 * event may also arrive in the alternate v2 shape (no `choices`, just
 * `finish_reason`+`usage`).
 *
 * This transform strips the `event:` lines, normalizes each forwarded `data:`
 * chunk to OpenAI shape, synthesizes a final chunk for the choices-less done
 * shape, drops `response.tool.*` events, and appends the `data: [DONE]`
 * terminator the downstream createSSEStream expects. Partial frames are buffered
 * across chunk boundaries.
 */

import { mapGigaChatV2FinishReason, mapGigaChatV2Usage } from "./gigachatShared.ts";

type JsonRecord = Record<string, unknown>;

const DROPPED_EVENTS = new Set(["response.tool.in_progress", "response.tool.completed"]);

/** Rewrite a chunk's `choices[].finish_reason` and top-level `usage` to OpenAI shape. */
function normalizeChunk(chunk: JsonRecord): void {
  if (Array.isArray(chunk.choices)) {
    for (const choice of chunk.choices as JsonRecord[]) {
      if (!choice || typeof choice !== "object") continue;
      const mapped = mapGigaChatV2FinishReason(choice.finish_reason);
      if (mapped !== undefined) choice.finish_reason = mapped;
    }
  }
  const usage = mapGigaChatV2Usage(chunk.usage);
  if (usage) chunk.usage = usage;
}

/** Emit an OpenAI `data:` chunk for a v2 event payload; null skips emission. */
function toOpenAIChunk(eventType: string, payload: unknown): JsonRecord | null {
  if (DROPPED_EVENTS.has(eventType)) return null;
  if (!payload || typeof payload !== "object") return null;
  const chunk = payload as JsonRecord;

  if (Array.isArray(chunk.choices)) {
    normalizeChunk(chunk);
    return chunk;
  }

  // Alternate v2 done shape: no choices, just finish_reason + usage.
  const finishReason = mapGigaChatV2FinishReason(chunk.finish_reason) ?? "stop";
  const synthesized: JsonRecord = {
    id: typeof chunk.id === "string" ? chunk.id : `chatcmpl-${Math.random().toString(36).slice(2)}`,
    object: "chat.completion.chunk",
    created:
      typeof chunk.created === "number"
        ? chunk.created
        : typeof chunk.created_at === "number"
          ? chunk.created_at
          : Math.floor(Date.now() / 1000),
    model: typeof chunk.model === "string" ? chunk.model : "",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
  const usage = mapGigaChatV2Usage(chunk.usage);
  if (usage) synthesized.usage = usage;
  return synthesized;
}

/** Parse one SSE frame (event:/data: block) into `{ event, data }`. */
function parseFrame(frame: string): { event: string; data: string } | null {
  let event = "";
  let data = "";
  for (const line of frame.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("event:")) {
      event = trimmed.slice(6).trim();
    } else if (trimmed.startsWith("data:")) {
      data += trimmed.slice(5).trim();
    }
  }
  if (!data) return null;
  return { event, data };
}

/**
 * Build a TransformStream that converts a GigaChat v2 SSE byte stream into an
 * OpenAI Chat Completions SSE byte stream terminated by `data: [DONE]`.
 */
export function createGigaChatV2StreamTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let doneEmitted = false;

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, chunk: JsonRecord) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };

  const flushFrames = (
    controller: TransformStreamDefaultController<Uint8Array>,
    final: boolean
  ) => {
    let sepIndex = buffer.indexOf("\n\n");
    while (sepIndex !== -1) {
      const frame = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const parsed = parseFrame(frame);
      if (parsed && parsed.data !== "[DONE]") {
        try {
          const chunk = toOpenAIChunk(parsed.event, JSON.parse(parsed.data));
          if (chunk) emit(controller, chunk);
        } catch {
          // Skip unparseable frames rather than corrupting the stream.
        }
      }
      sepIndex = buffer.indexOf("\n\n");
    }
    if (final && buffer.trim()) {
      const parsed = parseFrame(buffer);
      if (parsed && parsed.data !== "[DONE]") {
        try {
          const chunk = toOpenAIChunk(parsed.event, JSON.parse(parsed.data));
          if (chunk) emit(controller, chunk);
        } catch {
          // Skip trailing partial/unparseable frame.
        }
      }
      buffer = "";
    }
  };

  const emitDone = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (doneEmitted) return;
    doneEmitted = true;
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      flushFrames(controller, false);
    },
    flush(controller) {
      buffer += decoder.decode();
      flushFrames(controller, true);
      emitDone(controller);
    },
  });
}
