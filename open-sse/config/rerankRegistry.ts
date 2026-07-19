/**
 * Rerank Provider Registry
 *
 * Defines providers that support the /v1/rerank endpoint.
 * Follows the Cohere rerank API request/response format (industry standard).
 *
 * API keys are stored in the same provider credentials system,
 * keyed by provider ID (e.g. "cohere", "together").
 */

let _RERANK_PROVIDERS: Record<string, any> | null = null;

function getOrCreateRerankProviders(): Record<string, any> {
  if (!_RERANK_PROVIDERS) {
    _RERANK_PROVIDERS = {};
  }
  return _RERANK_PROVIDERS;
}

export const RERANK_PROVIDERS = new Proxy({} as Record<string, any>, {
  get(target, key: string) {
    if (key in target) {
      return target[key];
    }
    return getOrCreateRerankProviders()[key];
  },
  set(target, key: string, value) {
    target[key] = value;
    getOrCreateRerankProviders()[key] = value;
    return true;
  },
  deleteProperty(target, key: string) {
    delete target[key];
    delete getOrCreateRerankProviders()[key];
    return true;
  },
  ownKeys(target) {
    const targetKeys = Reflect.ownKeys(target);
    const registryKeys = Reflect.ownKeys(getOrCreateRerankProviders());
    return Array.from(new Set([...targetKeys, ...registryKeys]));
  },
  has(target, key) {
    return key in target || key in getOrCreateRerankProviders();
  },
  getOwnPropertyDescriptor(target, key) {
    if (key in target) {
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
    if (key in getOrCreateRerankProviders()) {
      return { configurable: true, enumerable: true, value: getOrCreateRerankProviders()[key as string] };
    }
    return undefined;
  },
});

export function getRerankProviders(): Record<string, any> {
  return RERANK_PROVIDERS;
}

const RERANK_PROVIDER_ALIASES = {
  jina: "jina-ai",
  voyage: "voyage-ai",
};

function resolveRerankProviderId(providerId) {
  return RERANK_PROVIDER_ALIASES[providerId] || providerId;
}

function normalizeProviderScopedModelId(providerId, modelId) {
  const resolvedProvider = resolveRerankProviderId(providerId);
  const provider = RERANK_PROVIDERS[resolvedProvider];
  if (provider?.models.some((model) => model.id === modelId)) return modelId;

  const providerScopedModelId = `${resolvedProvider}/${modelId}`;
  if (provider?.models.some((model) => model.id === providerScopedModelId)) {
    return providerScopedModelId;
  }

  return modelId.startsWith(`${providerId}/`) ? modelId.slice(providerId.length + 1) : modelId;
}

function toProviderScopedModelId(providerId, modelId) {
  return modelId.startsWith(`${providerId}/`) ? modelId : `${providerId}/${modelId}`;
}

/**
 * Get rerank provider config by ID
 */
export function getRerankProvider(providerId) {
  return RERANK_PROVIDERS[resolveRerankProviderId(providerId)] || null;
}

/**
 * Parse rerank model string (format: "provider/model" or just "model")
 * Returns { provider, model }
 */
export function parseRerankModel(modelStr) {
  if (!modelStr) return { provider: null, model: null };

  const slashIdx = modelStr.indexOf("/");
  if (slashIdx > 0) {
    const rawProvider = modelStr.slice(0, slashIdx);
    const resolvedProvider = resolveRerankProviderId(rawProvider);
    if (RERANK_PROVIDERS[resolvedProvider]) {
      return {
        provider: resolvedProvider,
        model: normalizeProviderScopedModelId(resolvedProvider, modelStr.slice(slashIdx + 1)),
      };
    }
  }

  // Try each provider prefix
  for (const [providerId, config] of Object.entries(RERANK_PROVIDERS)) {
    if (modelStr.startsWith(providerId + "/")) {
      return {
        provider: providerId,
        model: normalizeProviderScopedModelId(providerId, modelStr.slice(providerId.length + 1)),
      };
    }
  }

  // No provider prefix — search all providers for the model
  for (const [providerId, config] of Object.entries(RERANK_PROVIDERS)) {
    if (config.models.some((m) => m.id === modelStr)) {
      return { provider: providerId, model: modelStr };
    }
  }

  return { provider: null, model: modelStr };
}

/**
 * Get all rerank models as a flat list
 */
export function getAllRerankModels() {
  const models = [];
  for (const [providerId, config] of Object.entries(RERANK_PROVIDERS)) {
    for (const model of config.models) {
      models.push({
        id: toProviderScopedModelId(providerId, model.id),
        name: model.name,
        provider: providerId,
      });
    }
  }
  return models;
}
