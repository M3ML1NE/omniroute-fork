/**
 * Embedding Provider Registry
 *
 * Defines providers that support the /v1/embeddings endpoint.
 * All providers use the OpenAI-compatible format.
 *
 * API keys are stored in the same provider credentials system,
 * keyed by provider ID (e.g. "nebius", "openai").
 */

export interface EmbeddingProvider {
  id: string;
  baseUrl: string;
  authType: string;
  authHeader: string;
  models: { id: string; name: string; dimensions?: number }[];
}

export interface EmbeddingProviderNodeRow {
  id?: string;
  prefix: string;
  name: string;
  baseUrl: string;
  apiType?: string;
}

/**
 * Build a dynamic EmbeddingProvider from a local provider_node.
 * Only used for local providers (localhost) — caller must filter by hostname.
 */
export function buildDynamicEmbeddingProvider(node: EmbeddingProviderNodeRow): EmbeddingProvider {
  if (!node.prefix || !node.baseUrl) {
    throw new Error(`Invalid provider_node: missing prefix or baseUrl`);
  }
  if (node.prefix.includes("/") || node.prefix.includes(" ")) {
    throw new Error(`Invalid provider_node prefix "${node.prefix}": must not contain / or spaces`);
  }
  const baseUrl = node.baseUrl.replace(/\/+$/, "");
  return {
    id: node.prefix,
    baseUrl: `${baseUrl}/embeddings`,
    authType: "none",
    authHeader: "none",
    models: [],
  };
}

let _EMBEDDING_PROVIDERS: Record<string, EmbeddingProvider> | null = null;

function getOrCreateEmbeddingProviders(): Record<string, EmbeddingProvider> {
  if (!_EMBEDDING_PROVIDERS) {
    _EMBEDDING_PROVIDERS = {};
  }
  return _EMBEDDING_PROVIDERS;
}

export const EMBEDDING_PROVIDERS: Record<string, EmbeddingProvider> = new Proxy({} as Record<string, EmbeddingProvider>, {
  get(target, key: string) {
    if (key in target) {
      return target[key];
    }
    return getOrCreateEmbeddingProviders()[key];
  },
  set(target, key: string, value) {
    target[key] = value;
    getOrCreateEmbeddingProviders()[key] = value;
    return true;
  },
  deleteProperty(target, key: string) {
    delete target[key];
    delete getOrCreateEmbeddingProviders()[key];
    return true;
  },
  ownKeys(target) {
    const targetKeys = Reflect.ownKeys(target);
    const registryKeys = Reflect.ownKeys(getOrCreateEmbeddingProviders());
    return Array.from(new Set([...targetKeys, ...registryKeys]));
  },
  has(target, key) {
    return key in target || key in getOrCreateEmbeddingProviders();
  },
  getOwnPropertyDescriptor(target, key) {
    if (key in target) {
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
    if (key in getOrCreateEmbeddingProviders()) {
      return { configurable: true, enumerable: true, value: getOrCreateEmbeddingProviders()[key as string] };
    }
    return undefined;
  },
});

export function getEmbeddingProviders(): Record<string, EmbeddingProvider> {
  return EMBEDDING_PROVIDERS;
}

const EMBEDDING_PROVIDER_ALIASES: Record<string, string> = {
  jina: "jina-ai",
  voyage: "voyage-ai",
};

function resolveEmbeddingProviderId(providerId: string): string {
  return EMBEDDING_PROVIDER_ALIASES[providerId] || providerId;
}

function normalizeProviderScopedModelId(providerId: string, modelId: string): string {
  const resolvedProvider = resolveEmbeddingProviderId(providerId);
  const provider = EMBEDDING_PROVIDERS[resolvedProvider];
  if (provider?.models.some((model) => model.id === modelId)) return modelId;

  const providerScopedModelId = `${resolvedProvider}/${modelId}`;
  if (provider?.models.some((model) => model.id === providerScopedModelId)) {
    return providerScopedModelId;
  }

  return modelId.startsWith(`${providerId}/`) ? modelId.slice(providerId.length + 1) : modelId;
}

function toProviderScopedModelId(providerId: string, modelId: string): string {
  return modelId.startsWith(`${providerId}/`) ? modelId : `${providerId}/${modelId}`;
}

/**
 * Get embedding provider config by ID
 */
export function getEmbeddingProvider(providerId: string): EmbeddingProvider | null {
  return EMBEDDING_PROVIDERS[resolveEmbeddingProviderId(providerId)] || null;
}

/**
 * Parse embedding model string (format: "provider/model" or just "model")
 * Returns { provider, model }
 */
export function parseEmbeddingModel(
  modelStr: string | null,
  dynamicProviders?: EmbeddingProvider[]
): { provider: string | null; model: string | null } {
  if (!modelStr) return { provider: null, model: null };

  // Check for "provider/model" format
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx > 0) {
    const rawProvider = modelStr.slice(0, slashIdx);
    const resolvedProvider = resolveEmbeddingProviderId(rawProvider);

    if (EMBEDDING_PROVIDERS[resolvedProvider]) {
      return {
        provider: resolvedProvider,
        model: normalizeProviderScopedModelId(resolvedProvider, modelStr.slice(slashIdx + 1)),
      };
    }

    // Phase 1: Try each hardcoded provider prefix
    for (const [providerId] of Object.entries(EMBEDDING_PROVIDERS)) {
      if (modelStr.startsWith(providerId + "/")) {
        return {
          provider: providerId,
          model: normalizeProviderScopedModelId(providerId, modelStr.slice(providerId.length + 1)),
        };
      }
    }
    // Phase 2: Try dynamic provider_nodes prefix
    if (dynamicProviders) {
      for (const dp of dynamicProviders) {
        if (modelStr.startsWith(dp.id + "/")) {
          return { provider: dp.id, model: modelStr.slice(dp.id.length + 1) };
        }
      }
    }
    // Phase 3: Fallback — first segment is provider
    const provider = modelStr.slice(0, slashIdx);
    const model = modelStr.slice(slashIdx + 1);
    return { provider, model };
  }

  // No provider prefix — search hardcoded providers for the model
  for (const [providerId, config] of Object.entries(EMBEDDING_PROVIDERS)) {
    if (config.models.some((m) => m.id === modelStr)) {
      return { provider: providerId, model: modelStr };
    }
  }

  return { provider: null, model: modelStr };
}

/**
 * Get all embedding models as a flat list
 */
export function getAllEmbeddingModels() {
  const models: Array<{
    id: string;
    name: string;
    provider: string;
    dimensions: number | undefined;
  }> = [];
  for (const [providerId, config] of Object.entries(EMBEDDING_PROVIDERS)) {
    for (const model of config.models) {
      models.push({
        id: toProviderScopedModelId(providerId, model.id),
        name: model.name,
        provider: providerId,
        dimensions: model.dimensions,
      });
    }
  }
  return models;
}
