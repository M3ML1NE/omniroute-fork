import { BaseExecutor, setUserAgentHeader } from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { resolveKeyForRequest } from "../services/apiKeyRotator.ts";
import { getGigachatAccessToken } from "../services/gigachatAuth.ts";
import { getRegistryEntry } from "../config/providerRegistry.ts";
import { applyProviderRequestDefaults } from "../services/providerRequestDefaults.ts";
import { detectFormat, getTargetFormat } from "../services/provider.ts";

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

export class DefaultExecutor extends BaseExecutor {
  constructor(provider: string) {
    super(provider, PROVIDERS[provider] || PROVIDERS.openai);
  }

  buildUrl(
    model: string,
    stream: boolean,
    urlIndex = 0,
    credentials: any = null,
  ): string {
    void model;
    void stream;
    void urlIndex;

    if (this.provider?.startsWith?.("openai-compatible-")) {
      const psd = credentials?.providerSpecificData;
      const baseUrl = psd?.baseUrl || "https://api.openai.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      const customPath =
        typeof psd?.chatPath === "string" && psd.chatPath ? psd.chatPath : null;
      if (customPath) return `${normalized}${customPath}`;
      return `${normalized}/chat/completions`;
    }

    switch (this.provider) {
    case "gigachat": {
        // Per-key baseUrl cascade (T20): providerSpecificData > registry default
        const baseUrl =
          (credentials?.providerSpecificData as Record<string, unknown> | undefined)?.["baseUrl"] as string | undefined ??
          this.config.baseUrl;
        return normalizeGigachatChatUrl(baseUrl);
      }

      case "openai-compatible": {
        const psd = credentials?.providerSpecificData;
        const baseUrl = psd?.baseUrl || this.config.baseUrl || "https://api.openai.com/v1";
        const normalized = baseUrl.replace(/\/$/, "");
        const customPath =
          typeof psd?.chatPath === "string" && psd.chatPath ? psd.chatPath : null;
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
    clientHeaders: Record<string, string> | null = null,
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
    const selectedKeyId =
      (credentials.providerSpecificData as Record<string, unknown> | undefined)
        ?.selectedKeyId as string | undefined;
    let effectiveKey = credentials.apiKey;
    if (extraKeys.length > 0 && credentials.connectionId && credentials.apiKey) {
      const resolved = resolveKeyForRequest(
        credentials.connectionId,
        credentials.apiKey,
        extraKeys,
        selectedKeyId || null,
      );
      effectiveKey = resolved?.key || credentials.apiKey;
      if (resolved && credentials.providerSpecificData) {
        (credentials.providerSpecificData as Record<string, unknown>).selectedKeyId =
          resolved.keyId;
      }
    }

    switch (this.provider) {
      case "gigachat":
        headers["Authorization"] = `Bearer ${credentials.accessToken || effectiveKey}`;
        break;

      case "openai-compatible":
      default: {
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
        break;
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
          ([key]) => key.toLowerCase() === headerName.toLowerCase(),
        )?.[1];
        if (value) {
          headers[headerName] = value;
        }
      }
    }

    return headers;
  }

  transformRequest(
    model: string,
    body: unknown,
    stream: boolean,
    credentials: any,
  ): unknown {
    const cleanedBody = super.transformRequest(model, body, stream, credentials);
    let withDefaults = applyProviderRequestDefaults(
      cleanedBody,
      this.config.requestDefaults,
    );
    const targetFormat = getTargetFormat(this.provider, credentials?.providerSpecificData);
    const requestFormat =
      withDefaults && typeof withDefaults === "object" && !Array.isArray(withDefaults)
        ? detectFormat(withDefaults as Record<string, unknown>)
        : "openai";

    if (
      typeof withDefaults === "object" &&
      withDefaults !== null &&
      !Array.isArray(withDefaults)
    ) {
      if (stream && targetFormat === "openai" && requestFormat !== "openai-responses") {
        if (!credentials?.providerSpecificData?.disableStreamOptions) {
          withDefaults = {
            ...withDefaults,
            stream_options: {
              ...(((withDefaults as Record<string, unknown>).stream_options as object) || {}),
              include_usage: true,
            },
          };
        } else if (
          Object.prototype.hasOwnProperty.call(withDefaults, "stream_options")
        ) {
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

    return withDefaults;
  }

  /**
   * Refresh credentials via gigachat token exchange.
   */
  async refreshCredentials(credentials: any, log?: any): Promise<any | null> {
    if (this.provider === "gigachat") {
      if (!credentials.apiKey) return null;
      try {
        const authUrl =
          (credentials?.providerSpecificData as Record<string, unknown> | undefined)?.["authUrl"] as string | undefined;
        return await getGigachatAccessToken({
          credentials: credentials.apiKey,
          authUrl,
        });
      } catch (error: any) {
        log?.error?.("TOKEN", `gigachat refresh error: ${error.message}`);
        return null;
      }
    }
    return null;
  }

  needsRefresh(credentials: any): boolean {
    if (this.provider === "gigachat") {
      if (credentials.apiKey && !credentials.accessToken) return true;
      if (!credentials.expiresAt) return false;
    }
    return super.needsRefresh(credentials);
  }
}

export default DefaultExecutor;
