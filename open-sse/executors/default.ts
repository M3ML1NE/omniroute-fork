import { BaseExecutor, setUserAgentHeader, type ExecuteInput } from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { resolveKeyForRequest } from "../services/apiKeyRotator.ts";
import { getRegistryEntry } from "../config/providerRegistry.ts";
import { applyProviderRequestDefaults } from "../services/providerRequestDefaults.ts";
import { detectFormat, getTargetFormat } from "../services/provider.ts";
import { normalizeGigaChatToolSchema } from "./gigachatSchema.ts";
import {
  GigaChat400Error,
  buildToolCallIdNameMap,
  mapGigaChatV1BlacklistFinishReason,
  sanitizeGigaChatName,
} from "./gigachatShared.ts";
import {
  convertGigaChatV2NonStreamResponse,
  convertGigaChatV2Request,
  createGigaChatV2StreamTransform,
} from "./gigachatV2.ts";

const GIGACHAT_COMPATIBLE_PREFIX = "gigachat-compatible-";

export { GigaChat400Error };

export function isGigaChatV2(credentials: unknown): boolean {
  const psd = (credentials as { providerSpecificData?: Record<string, unknown> } | null)
    ?.providerSpecificData;
  return psd?.apiVersion === "v2";
}

/**
 * Convert an OpenAI `tool_choice` into GigaChat's `function_call` field.
 * GigaChat has no "required" mode, so it is mapped to "auto" (the closest
 * always-may-call behaviour). Returns `undefined` when the value should be
 * dropped without emitting a `function_call` (unrecognized shapes).
 */
function mapGigaChatFunctionCall(toolChoice: unknown): unknown {
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto") return "auto";
    if (toolChoice === "none") return "none";
    // GigaChat has no "required" — the nearest behaviour is "auto".
    if (toolChoice === "required") return "auto"; // GigaChat has no "required"
    return undefined;
  }
  if (toolChoice && typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
    const choice = toolChoice as Record<string, unknown>;
    const fn = choice["function"];
    if (fn && typeof fn === "object" && !Array.isArray(fn)) {
      const name = (fn as Record<string, unknown>)["name"];
      if (typeof name === "string" && name) {
        return { name: sanitizeGigaChatName(name) };
      }
    }
  }
  return undefined;
}

function hasMtls(credentials: any): boolean {
  return Boolean(
    (credentials?.providerSpecificData as Record<string, unknown> | undefined)?.["mtls"]
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || "").trim().replace(/\/$/, "");
}

function normalizeGigachatChatUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl).replace(/\/chat\/completions$/, "");
  return `${normalized}/chat/completions`;
}

function normalizeOpenAIChatUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (
    normalized.endsWith("/chat/completions") ||
    normalized.endsWith("/responses") ||
    normalized.endsWith("/chat")
  ) {
    return normalized;
  }
  return normalized.endsWith("/v1") ? `${normalized}/chat/completions` : normalized;
}

const OPENAI_COMPATIBLE_FALLBACK_CONFIG = {
  format: "openai",
  baseUrl: "https://api.openai.com/v1",
};

/**
 * Reverse conversion for a GigaChat non-streaming response: rewrite each choice's
 * `message.function_call{name, arguments:<object>}` into OpenAI's
 * `tool_calls[{id, type:"function", function:{name, arguments:<json-string>}}]`
 * and normalize `finish_reason "function_call" -> "tool_calls"`. Names are
 * un-sanitized back to their original hyphenated form via `toolNameMap` when known.
 *
 * GigaChat's `message.functions_state_id` (an opaque conversation-state token used
 * to continue multi-turn function-calling flows) is passed through verbatim onto the
 * OpenAI-format message as a non-standard extension field. See T4.2: this is a
 * documented raw-JSON extension — strict OpenAI SDKs may strip it, and that is an
 * accepted degradation because GigaChat also works without it.
 *
 * Returns true when the payload was mutated.
 */
function convertGigaChatNonStreamResponse(
  payload: unknown,
  toolNameMap: Map<string, string> | null
): boolean {
  if (!payload || typeof payload !== "object") return false;
  const root = payload as Record<string, unknown>;

  let mutated = false;

  // T4.3: map GigaChat's `usage.precached_prompt_tokens` onto OpenAI's
  // `usage.prompt_tokens_details.cached_tokens` so cached-prompt hits surface
  // through the standard OpenAI usage shape.
  const usage = root["usage"];
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    const usageRecord = usage as Record<string, unknown>;
    const precached = usageRecord["precached_prompt_tokens"];
    if (typeof precached === "number") {
      const details =
        usageRecord["prompt_tokens_details"] &&
        typeof usageRecord["prompt_tokens_details"] === "object" &&
        !Array.isArray(usageRecord["prompt_tokens_details"])
          ? (usageRecord["prompt_tokens_details"] as Record<string, unknown>)
          : {};
      details["cached_tokens"] = precached;
      usageRecord["prompt_tokens_details"] = details;
      mutated = true;
    }
  }

  const choices = root["choices"];
  if (!Array.isArray(choices)) return mutated;

  for (let i = 0; i < choices.length; i++) {
    const choice = choices[i];
    if (!choice || typeof choice !== "object") continue;
    const choiceRecord = choice as Record<string, unknown>;
    const message = choiceRecord["message"];
    if (!message || typeof message !== "object") continue;
    const messageRecord = message as Record<string, unknown>;
    const hasStateId = typeof messageRecord["functions_state_id"] === "string";

    // Map GigaChat v1's `finish_reason: "blacklist"` (content-safety/censorship
    // signal) onto the OpenAI equivalent `content_filter`. Applies regardless of
    // whether this choice also carries a function_call.
    const mappedFinishReason = mapGigaChatV1BlacklistFinishReason(choiceRecord["finish_reason"]);
    if (mappedFinishReason && mappedFinishReason !== choiceRecord["finish_reason"]) {
      choiceRecord["finish_reason"] = mappedFinishReason;
      mutated = true;
    }

    const functionCall = messageRecord["function_call"];
    if (!functionCall || typeof functionCall !== "object" || Array.isArray(functionCall)) {
      if (hasStateId) mutated = true;
      continue;
    }

    const fc = functionCall as Record<string, unknown>;
    const sanitizedName = typeof fc["name"] === "string" ? fc["name"] : "";
    const restoredName = toolNameMap?.get(sanitizedName) ?? sanitizedName;
    const args = fc["arguments"];
    const argsString = typeof args === "string" ? args : JSON.stringify(args ?? {});

    messageRecord["tool_calls"] = [
      {
        id: `call_${restoredName || "function"}_${i}`,
        type: "function",
        function: { name: restoredName, arguments: argsString },
      },
    ];
    delete messageRecord["function_call"];
    if (messageRecord["content"] === "" || messageRecord["content"] == null) {
      messageRecord["content"] = null;
    }

    if (choiceRecord["finish_reason"] === "function_call") {
      choiceRecord["finish_reason"] = "tool_calls";
    }
    mutated = true;
  }
  return mutated;
}

export class DefaultExecutor extends BaseExecutor {
  constructor(provider: string) {
    super(provider, PROVIDERS[provider] || OPENAI_COMPATIBLE_FALLBACK_CONFIG);
  }

  async execute(input: ExecuteInput) {
    const isGigachat = this.provider?.startsWith?.(GIGACHAT_COMPATIBLE_PREFIX) === true;
    const v2 = isGigachat && isGigaChatV2(input.credentials);

    // Non-gigachat, or a v1 stream (converted downstream in stream.ts): unchanged.
    if (!isGigachat || (input.stream && !v2)) {
      return super.execute(input);
    }

    // v2 streaming: convert the upstream v2 SSE body to OpenAI SSE in-place.
    if (input.stream && v2) {
      try {
        const result = await super.execute(input);
        const { response } = result;
        if (!response.ok || response.status !== 200 || !response.body) return result;
        const transformed = response.body.pipeThrough(createGigaChatV2StreamTransform());
        return {
          ...result,
          response: new Response(transformed, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          }),
        };
      } catch (error) {
        return this.handleGigaChatExecuteError(error, input);
      }
    }

    try {
      const result = await super.execute(input);
      const { response, transformedBody } = result;
      if (!response.ok || response.status !== 200) return result;

      const mapCandidate =
        transformedBody && typeof transformedBody === "object"
          ? (transformedBody as Record<string, unknown>)["_toolNameMap"]
          : null;
      const toolNameMap =
        mapCandidate instanceof Map ? (mapCandidate as Map<string, string>) : null;

      const raw = await response.text();
      const responseInit: ResponseInit = {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      };
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { ...result, response: new Response(raw, responseInit) };
      }

      if (v2) {
        const converted = convertGigaChatV2NonStreamResponse(parsed, toolNameMap);
        return { ...result, response: new Response(JSON.stringify(converted), responseInit) };
      }

      const mutated = convertGigaChatNonStreamResponse(parsed, toolNameMap);
      const bodyString = mutated ? JSON.stringify(parsed) : raw;
      return { ...result, response: new Response(bodyString, responseInit) };
    } catch (error) {
      return this.handleGigaChatExecuteError(error, input);
    }
  }

  private handleGigaChatExecuteError(error: unknown, input: ExecuteInput) {
    if (error instanceof GigaChat400Error) {
      return {
        response: new Response(
          JSON.stringify({ error: { message: error.message, type: "invalid_request_error" } }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        ),
        url: this.buildUrl(input.model, input.stream, 0, input.credentials),
        headers: {},
        transformedBody: null,
      };
    }
    throw error;
  }

  buildUrl(model: string, stream: boolean, urlIndex = 0, credentials: any = null): string {
    void model;
    void stream;
    void urlIndex;

    if (this.provider === "gigachat" || this.provider?.startsWith?.(GIGACHAT_COMPATIBLE_PREFIX)) {
      const psd = credentials?.providerSpecificData;
      const baseUrl = psd?.baseUrl || "https://gigachat.devices.sberbank.ru/api/v1";
      return normalizeGigachatChatUrl(baseUrl);
    }

    if (this.provider?.startsWith?.("openai-compatible-")) {
      const psd = credentials?.providerSpecificData;
      const baseUrl = psd?.baseUrl || "https://api.openai.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      const customPath = typeof psd?.chatPath === "string" && psd.chatPath ? psd.chatPath : null;
      if (customPath) return `${normalized}${customPath}`;
      if (psd?.apiType === "responses") return `${normalized}/responses`;
      return `${normalized}/chat/completions`;
    }

    switch (this.provider) {
      case "openai-compatible": {
        const psd = credentials?.providerSpecificData;
        const baseUrl = psd?.baseUrl || this.config.baseUrl || "https://api.openai.com/v1";
        const normalized = baseUrl.replace(/\/$/, "");
        const customPath = typeof psd?.chatPath === "string" && psd.chatPath ? psd.chatPath : null;
        if (customPath) return `${normalized}${customPath}`;
        return `${normalized}/chat/completions`;
      }

      default: {
        const url = this.config.baseUrl;
        const entry = getRegistryEntry(this.provider);
        return entry?.urlSuffix ? `${url}${entry.urlSuffix}` : normalizeOpenAIChatUrl(url);
      }
    }
  }

  buildHeaders(
    credentials: any,
    stream = true,
    clientHeaders: Record<string, string> | null = null
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.headers,
    };

    // Allow per-provider User-Agent override via environment variable.
    const providerId = this.config?.id || this.provider;
    if (providerId) {
      const envKey = `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_USER_AGENT`;
      const envUA = process.env[envKey]?.trim();
      if (envUA) {
        headers["User-Agent"] = envUA;
        if ("user-agent" in headers) {
          headers["user-agent"] = envUA;
        }
      }
    }

    // T07: resolve extra keys via round-robin locally.
    const extraKeys =
      (credentials.providerSpecificData?.extraApiKeys as string[] | undefined) || [];
    const selectedKeyId = (credentials.providerSpecificData as Record<string, unknown> | undefined)
      ?.selectedKeyId as string | undefined;
    let effectiveKey = credentials.apiKey;
    if (extraKeys.length > 0 && credentials.connectionId && credentials.apiKey) {
      const resolved = resolveKeyForRequest(
        credentials.connectionId,
        credentials.apiKey,
        extraKeys,
        selectedKeyId || null
      );
      effectiveKey = resolved?.key || credentials.apiKey;
      if (resolved && credentials.providerSpecificData) {
        (credentials.providerSpecificData as Record<string, unknown>).selectedKeyId =
          resolved.keyId;
      }
    }

    // mTLS connections authenticate via the client certificate (attached as a
    // fetch dispatcher in BaseExecutor.execute); they must NOT send a Bearer token.
    if (!hasMtls(credentials)) {
      const entry = getRegistryEntry(this.provider);
      const authHeader = entry?.authHeader || "bearer";
      const token = effectiveKey || credentials.accessToken;
      if (token) {
        if (authHeader === "x-api-key") {
          headers["x-api-key"] = token;
        } else {
          headers["Authorization"] = `Bearer ${token}`;
        }
      }
    }

    headers["Accept"] = stream ? "text/event-stream" : "application/json";

    // Forward client request metadata headers (allowlist-based).
    if (clientHeaders) {
      const clientUA = clientHeaders["User-Agent"] || clientHeaders["user-agent"];
      if (clientUA) {
        setUserAgentHeader(headers, clientUA);
      }

      const opencodeHeaderKeys = [
        "x-opencode-session",
        "x-opencode-request",
        "x-opencode-project",
        "x-opencode-client",
      ];
      for (const headerName of opencodeHeaderKeys) {
        const value = Object.entries(clientHeaders).find(
          ([key]) => key.toLowerCase() === headerName.toLowerCase()
        )?.[1];
        if (value) {
          headers[headerName] = value;
        }
      }

      // T4.3: GigaChat X-Session-ID/X-Client-ID/X-Request-ID are client-passthrough
      // only — forward the incoming client header verbatim; never generate one
      // server-side.
      const isGigachat =
        this.provider === "gigachat" ||
        this.provider?.startsWith?.(GIGACHAT_COMPATIBLE_PREFIX) === true;
      if (isGigachat) {
        const passthroughHeaders = ["X-Session-ID", "X-Client-ID", "X-Request-ID"];
        for (const headerName of passthroughHeaders) {
          const value = Object.entries(clientHeaders).find(
            ([key]) => key.toLowerCase() === headerName.toLowerCase()
          )?.[1];
          if (value) {
            headers[headerName] = value;
          }
        }
      }
    }

    return headers;
  }

  transformRequest(model: string, body: unknown, stream: boolean, credentials: any): unknown {
    const cleanedBody = super.transformRequest(model, body, stream, credentials);
    let withDefaults = applyProviderRequestDefaults(cleanedBody, this.config.requestDefaults);
    const targetFormat = getTargetFormat(this.provider, credentials?.providerSpecificData);
    const requestFormat =
      withDefaults && typeof withDefaults === "object" && !Array.isArray(withDefaults)
        ? detectFormat(withDefaults as Record<string, unknown>)
        : "openai";

    if (typeof withDefaults === "object" && withDefaults !== null && !Array.isArray(withDefaults)) {
      if (stream && targetFormat === "openai" && requestFormat !== "openai-responses") {
        if (!credentials?.providerSpecificData?.disableStreamOptions) {
          withDefaults = {
            ...withDefaults,
            stream_options: {
              ...(((withDefaults as Record<string, unknown>).stream_options as object) || {}),
              include_usage: true,
            },
          };
        } else if (Object.prototype.hasOwnProperty.call(withDefaults, "stream_options")) {
          const withoutStreamOptions = { ...(withDefaults as Record<string, unknown>) };
          delete withoutStreamOptions.stream_options;
          withDefaults = withoutStreamOptions;
        }
      } else if (
        (targetFormat === "openai-responses" || requestFormat === "openai-responses") &&
        Object.prototype.hasOwnProperty.call(withDefaults, "stream_options")
      ) {
        const withoutStreamOptions = { ...(withDefaults as Record<string, unknown>) };
        delete withoutStreamOptions.stream_options;
        withDefaults = withoutStreamOptions;
      }

      // #1961: Map max_tokens -> max_completion_tokens for recent OpenAI models.
      if (targetFormat === "openai") {
        const isRecentOpenAI = /^(o1|o3|o4|gpt-5)/i.test(model);
        if (isRecentOpenAI && withDefaults && typeof withDefaults === "object") {
          const defaultsRecord = withDefaults as Record<string, unknown>;
          if ("max_tokens" in defaultsRecord) {
            defaultsRecord.max_completion_tokens = defaultsRecord.max_tokens;
            delete defaultsRecord.max_tokens;
          }
        }
      }
    }

    // Apply modelIdPrefix from RegistryEntry if present.
    if (typeof withDefaults === "object" && withDefaults !== null) {
      const entry = getRegistryEntry(this.provider);
      if (entry?.modelIdPrefix) {
        const b = withDefaults as Record<string, unknown>;
        if (typeof b.model === "string" && !b.model.startsWith(entry.modelIdPrefix)) {
          b.model = `${entry.modelIdPrefix}${b.model}`;
        }
      }
    }

    // GigaChat v2: distinct request contract — convert in a dedicated module and
    // return, bypassing the v1 tools/tool_choice/response_format conversions below.
    if (
      this.provider?.startsWith?.(GIGACHAT_COMPATIBLE_PREFIX) &&
      isGigaChatV2(credentials) &&
      typeof withDefaults === "object" &&
      withDefaults !== null &&
      !Array.isArray(withDefaults)
    ) {
      return convertGigaChatV2Request(withDefaults as Record<string, unknown>);
    }

    if (
      this.provider?.startsWith?.(GIGACHAT_COMPATIBLE_PREFIX) &&
      typeof withDefaults === "object" &&
      withDefaults !== null
    ) {
      const requestBody = withDefaults as Record<string, unknown>;
      if (Array.isArray(requestBody["tools"])) {
        const toolNameMap = new Map<string, string>();
        requestBody["functions"] = (requestBody["tools"] as Record<string, unknown>[]).map(
          (tool: Record<string, unknown>) => {
            const fn = tool["function"] as Record<string, unknown>;
            const originalName = String(fn["name"] || "");
            const safeName = originalName.replace(/-/g, "_");
            if (originalName !== safeName) {
              toolNameMap.set(safeName, originalName);
            }
            return {
              name: safeName,
              description: fn["description"],
              parameters: normalizeGigaChatToolSchema(fn["parameters"]),
            };
          }
        );
        delete requestBody["tools"];
        if (toolNameMap.size > 0) {
          requestBody["_toolNameMap"] = toolNameMap;
        }
      } else if (Array.isArray(requestBody["functions"])) {
        // Legacy clients send functions[] directly; pass them through but still
        // apply GigaChat schema normalization to each function's parameters.
        const toolNameMap = new Map<string, string>();
        requestBody["functions"] = (requestBody["functions"] as Record<string, unknown>[]).map(
          (fn: Record<string, unknown>) => {
            if (!fn || typeof fn !== "object") return fn;
            const originalName = String(fn["name"] || "");
            const safeName = sanitizeGigaChatName(originalName);
            if (originalName !== safeName) {
              toolNameMap.set(safeName, originalName);
            }
            return {
              ...fn,
              name: safeName,
              parameters: normalizeGigaChatToolSchema(fn["parameters"]),
            };
          }
        );
        if (toolNameMap.size > 0) {
          requestBody["_toolNameMap"] = toolNameMap;
        }
      }
      if (requestBody["tool_choice"] !== undefined) {
        const mapped = mapGigaChatFunctionCall(requestBody["tool_choice"]);
        if (mapped !== undefined) {
          requestBody["function_call"] = mapped;
        }
        delete requestBody["tool_choice"];
      }
      delete requestBody["stream_options"];

      if (Array.isArray(requestBody["messages"])) {
        const messages = requestBody["messages"] as unknown[];
        const toolCallIdToName = buildToolCallIdNameMap(messages);

        requestBody["messages"] = messages.map((msg: any) => {
          if (!msg || typeof msg !== "object") return msg;
          const newMsg = { ...msg };

          // 1. Convert OpenAI assistant tool_calls -> GigaChat function_call
          if (
            newMsg.role === "assistant" &&
            Array.isArray(newMsg.tool_calls) &&
            newMsg.tool_calls.length > 0
          ) {
            const firstCall = newMsg.tool_calls[0];
            if (firstCall && firstCall.function) {
              const fn = { ...firstCall.function };
              if (fn.name) fn.name = sanitizeGigaChatName(String(fn.name));

              // GigaChat expects 'arguments' to be a JSON object, not a string
              if (typeof fn.arguments === "string") {
                try {
                  fn.arguments = JSON.parse(fn.arguments);
                } catch {
                  fn.arguments = {};
                }
              }
              newMsg.function_call = fn;
            }
            delete newMsg.tool_calls;
          }

          // T4.2: forward a functions_state_id carried by a prior assistant turn
          // back to GigaChat so multi-turn function-calling state is preserved.
          if (newMsg.role === "assistant" && typeof msg.functions_state_id === "string") {
            newMsg.functions_state_id = msg.functions_state_id;
          }

          // 2. Convert OpenAI tool result -> GigaChat function result
          if (newMsg.role === "tool" || newMsg.role === "function") {
            newMsg.role = "function";

            // GigaChat requires a valid JSON object string for content.
            // If it's a raw string like "25" or "Sunny", GigaChat throws 422 INVALID_PARAMS.
            let contentStr =
              typeof newMsg.content === "string"
                ? newMsg.content.trim()
                : JSON.stringify(newMsg.content ?? {});
            let isObj = false;
            if (contentStr.startsWith("{") && contentStr.endsWith("}")) {
              try {
                const parsed = JSON.parse(contentStr);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  isObj = true;
                }
              } catch {
                isObj = false;
              }
            }
            if (!isObj) {
              contentStr = JSON.stringify({ result: contentStr });
            }
            newMsg.content = contentStr;

            // GigaChat requires 'name' on function results. Prefer an explicit
            // name, otherwise resolve it from the tool_call_id emitted by the
            // originating assistant message. An unresolvable id is a malformed
            // history — fail loudly with a 400 rather than sending a bad request.
            if (newMsg.name) {
              newMsg.name = sanitizeGigaChatName(String(newMsg.name));
            } else if (newMsg.tool_call_id) {
              const resolved = toolCallIdToName.get(String(newMsg.tool_call_id));
              if (!resolved) {
                throw new GigaChat400Error(
                  `Unresolvable tool_call_id "${String(newMsg.tool_call_id)}": no prior assistant message emitted a matching tool_call. Cannot map to a GigaChat function name.`
                );
              }
              newMsg.name = resolved;
            } else {
              throw new GigaChat400Error(
                "GigaChat function result message is missing both 'name' and 'tool_call_id'; cannot determine the function name."
              );
            }
            delete newMsg.tool_call_id;
          } else {
            // GigaChat strictly rejects the 'name' field on non-function roles
            delete newMsg.name;
          }

          return newMsg;
        });
      }
    }

    // Handle response_format for GigaChat: convert OpenAI json_schema to GigaChat format
    if (
      this.provider?.startsWith?.(GIGACHAT_COMPATIBLE_PREFIX) &&
      typeof withDefaults === "object" &&
      withDefaults !== null &&
      "response_format" in withDefaults
    ) {
      const rf = (withDefaults as Record<string, unknown>).response_format;
      if (rf && typeof rf === "object" && !Array.isArray(rf)) {
        const rfRecord = rf as Record<string, unknown>;
        // json_schema: {type, json_schema: {name, schema, strict}}
        //           -> {type, schema: normalized, strict}
        if (rfRecord.type === "json_schema" && "json_schema" in rfRecord) {
          const jsonSchema = rfRecord.json_schema as Record<string, unknown>;
          const schema = jsonSchema.schema;
          const strict = jsonSchema.strict;

          // Replace response_format with normalized GigaChat format
          (withDefaults as Record<string, unknown>).response_format = {
            type: "json_schema",
            schema: schema ? normalizeGigaChatToolSchema(schema) : {},
            ...(strict !== undefined ? { strict } : {}),
          };
        }
        // json_object: pass through exactly
      }
    }

    return withDefaults;
  }
}

export default DefaultExecutor;
