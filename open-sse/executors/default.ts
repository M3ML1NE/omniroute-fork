import { BaseExecutor, setUserAgentHeader } from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { resolveKeyForRequest } from "../services/apiKeyRotator.ts";
import { getRegistryEntry } from "../config/providerRegistry.ts";
import { applyProviderRequestDefaults } from "../services/providerRequestDefaults.ts";
import { detectFormat, getTargetFormat } from "../services/provider.ts";
import { normalizeGigaChatToolSchema } from "./gigachatSchema.ts";

const GIGACHAT_COMPATIBLE_PREFIX = "gigachat-compatible-";

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

export class DefaultExecutor extends BaseExecutor {
  constructor(provider: string) {
    super(provider, PROVIDERS[provider] || OPENAI_COMPATIBLE_FALLBACK_CONFIG);
  }

  buildUrl(model: string, stream: boolean, urlIndex = 0, credentials: any = null): string {
    void model;
    void stream;
    void urlIndex;

    if (this.provider?.startsWith?.(GIGACHAT_COMPATIBLE_PREFIX)) {
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
      }
      if (requestBody["tool_choice"] !== undefined) {
        delete requestBody["tool_choice"];
      }
      delete requestBody["stream_options"];
    }

    return withDefaults;
  }
}

export default DefaultExecutor;
