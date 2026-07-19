/**
 * Image Generation Provider Registry
 *
 * Defines providers that support the /v1/images/generations endpoint.
 * Each provider has its own request format and endpoint.
 */

interface ImageModelEntry {
  id: string;
  name: string;
  inputModalities?: string[];
  description?: string;
  isMarket?: boolean;
}

interface ImageProviderConfig {
  id: string;
  baseUrl: string;
  fallbackUrl?: string;
  proUrl?: string;
  statusUrl?: string;
  alias?: string;
  authType: string;
  authHeader: string;
  format: string;
  models: ImageModelEntry[];
  supportedSizes: string[];
}

interface ImageModelAliasEntry {
  provider: string;
  model: string;
  name: string;
  listInCatalog: boolean;
  inputModalities?: string[];
  description?: string;
}

const IMAGE_MODEL_ALIASES: Record<string, ImageModelAliasEntry> = {
  "gemini-3.1-flash-image-preview": {
    provider: "antigravity",
    model: "gemini-3.1-flash-image",
    name: "Gemini 3.1 Flash Image",
    listInCatalog: false,
  },
  "flux-kontext": {
    provider: "black-forest-labs",
    model: "flux-kontext-pro",
    name: "FLUX Kontext Pro",
    listInCatalog: true,
    inputModalities: ["text", "image"],
  },
  "flux-kontext-max": {
    provider: "black-forest-labs",
    model: "flux-kontext-max",
    name: "FLUX Kontext Max",
    listInCatalog: true,
    inputModalities: ["text", "image"],
  },
  "flux-2-max": {
    provider: "black-forest-labs",
    model: "flux-2-max",
    name: "FLUX.2 Max",
    listInCatalog: true,
    inputModalities: ["text", "image"],
  },
  "flux-2-pro": {
    provider: "black-forest-labs",
    model: "flux-2-pro",
    name: "FLUX.2 Pro",
    listInCatalog: true,
    inputModalities: ["text", "image"],
  },
  "flux-2-flex": {
    provider: "black-forest-labs",
    model: "flux-2-flex",
    name: "FLUX.2 Flex",
    listInCatalog: true,
    inputModalities: ["text", "image"],
  },
  "flux-2-dev": {
    provider: "together",
    model: "black-forest-labs/FLUX.2-dev",
    name: "FLUX.2 Dev",
    listInCatalog: true,
    inputModalities: ["text", "image"],
  },
  kontext: {
    provider: "black-forest-labs",
    model: "flux-kontext-pro",
    name: "FLUX Kontext Pro",
    listInCatalog: false,
    inputModalities: ["text", "image"],
  },
  "pollinations/kontext": {
    provider: "black-forest-labs",
    model: "flux-kontext-pro",
    name: "FLUX Kontext Pro",
    listInCatalog: false,
    inputModalities: ["text", "image"],
  },
};

function resolveImageModelAlias(modelStr) {
  const alias = IMAGE_MODEL_ALIASES[modelStr];
  return alias ? { provider: alias.provider, model: alias.model } : null;
}

function findImageModelConfig(providerId, modelId) {
  const provider = IMAGE_PROVIDERS[providerId];
  if (!provider) return null;
  return provider.models.find((model) => model.id === modelId) || null;
}

let _IMAGE_PROVIDERS: Record<string, ImageProviderConfig> | null = null;

function getOrCreateImageProviders(): Record<string, ImageProviderConfig> {
  if (!_IMAGE_PROVIDERS) {
    _IMAGE_PROVIDERS = {};
  }
  return _IMAGE_PROVIDERS;
}


export function getImageProviders(): Record<string, ImageProviderConfig> {
  return IMAGE_PROVIDERS;
}

export const IMAGE_PROVIDERS = new Proxy({} as Record<string, ImageProviderConfig>, {
  get(target, key: string) {
    if (key in target) {
      return target[key];
    }
    return getOrCreateImageProviders()[key];
  },
  set(target, key: string, value) {
    target[key] = value;
    getOrCreateImageProviders()[key] = value;
    return true;
  },
  deleteProperty(target, key: string) {
    delete target[key];
    delete getOrCreateImageProviders()[key];
    return true;
  },
  ownKeys(target) {
    const targetKeys = Reflect.ownKeys(target);
    const registryKeys = Reflect.ownKeys(getOrCreateImageProviders());
    return Array.from(new Set([...targetKeys, ...registryKeys]));
  },
  has(target, key) {
    return key in target || key in getOrCreateImageProviders();
  },
  getOwnPropertyDescriptor(target, key) {
    if (key in target) {
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
    if (key in getOrCreateImageProviders()) {
      return { configurable: true, enumerable: true, value: getOrCreateImageProviders()[key as string] };
    }
    return undefined;
  },
});

export function getImageProvider(providerId) {
  return IMAGE_PROVIDERS[providerId] || null;
}
/**
 * Parse image model string (format: "provider/model")
 * Returns { provider, model }
 */
export function parseImageModel(modelStr) {
  if (!modelStr) return { provider: null, model: null };

  const directAlias = resolveImageModelAlias(modelStr);
  if (directAlias) {
    return directAlias;
  }

  // Try each provider prefix
  for (const [providerId, config] of Object.entries(IMAGE_PROVIDERS)) {
    if (modelStr.startsWith(providerId + "/")) {
      const model = modelStr.slice(providerId.length + 1);
      const aliased =
        resolveImageModelAlias(`${providerId}/${model}`) || resolveImageModelAlias(model);
      return aliased || { provider: providerId, model };
    }
    // Check alias if available
    if (config.alias && modelStr.startsWith(config.alias + "/")) {
      const model = modelStr.slice(config.alias.length + 1);
      const aliased =
        resolveImageModelAlias(`${providerId}/${model}`) || resolveImageModelAlias(model);
      return aliased || { provider: providerId, model };
    }
  }

  // No provider prefix — try to find the model in every provider
  for (const [providerId, config] of Object.entries(IMAGE_PROVIDERS)) {
    if (config.models.some((m) => m.id === modelStr)) {
      return { provider: providerId, model: modelStr };
    }
  }

  return { provider: null, model: modelStr };
}

/**
 * Get all image models as a flat list
 */
export function getAllImageModels() {
  const models = [];
  for (const [providerId, config] of Object.entries(IMAGE_PROVIDERS)) {
    for (const model of config.models) {
      models.push({
        id: `${providerId}/${model.id}`,
        name: model.name,
        provider: providerId,
        supportedSizes: config.supportedSizes,
        inputModalities: model.inputModalities || ["text"],
        description: model.description || undefined,
      });
    }
  }
  for (const [alias, target] of Object.entries(IMAGE_MODEL_ALIASES)) {
    if (!target.listInCatalog) continue;
    const providerConfig = IMAGE_PROVIDERS[target.provider];
    const modelConfig = findImageModelConfig(target.provider, target.model);
    models.push({
      id: alias,
      name: target.name || modelConfig?.name || alias,
      provider: target.provider,
      supportedSizes: providerConfig?.supportedSizes || [],
      inputModalities: target.inputModalities || modelConfig?.inputModalities || ["text"],
      description: target.description || modelConfig?.description || undefined,
    });
  }
  return models;
}

export function getImageModelAliases() {
  return IMAGE_MODEL_ALIASES;
}

export function getImageModelEntry(modelStr) {
  if (!modelStr) return null;

  const alias = IMAGE_MODEL_ALIASES[modelStr];
  if (alias) {
    const modelConfig = findImageModelConfig(alias.provider, alias.model);
    return {
      provider: alias.provider,
      model: alias.model,
      inputModalities: alias.inputModalities || modelConfig?.inputModalities || ["text"],
      description: alias.description || modelConfig?.description || undefined,
    };
  }

  const { provider, model } = parseImageModel(modelStr);
  if (!provider || !model) return null;

  const modelConfig = findImageModelConfig(provider, model);
  if (!modelConfig) return null;

  return {
    provider,
    model,
    inputModalities: modelConfig.inputModalities || ["text"],
    description: modelConfig.description || undefined,
  };
}
