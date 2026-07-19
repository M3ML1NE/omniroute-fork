/**
 * Audio Provider Registry
 *
 * Defines providers that support audio endpoints:
 * - /v1/audio/transcriptions (Whisper API)
 * - /v1/audio/speech (TTS API)
 */

interface AudioModel {
  id: string;
  name: string;
}

export interface AudioProvider {
  id: string;
  baseUrl: string;
  authType: string;
  authHeader: string;
  format?: string;
  supportedFormats?: string[];
  async?: boolean;
  models: AudioModel[];
}

let _AUDIO_TRANSCRIPTION_PROVIDERS: Record<string, AudioProvider> | null = null;

function getOrCreateTranscriptionProviders(): Record<string, AudioProvider> {
  if (!_AUDIO_TRANSCRIPTION_PROVIDERS) {
    _AUDIO_TRANSCRIPTION_PROVIDERS = {};
  }
  return _AUDIO_TRANSCRIPTION_PROVIDERS;
}

export const AUDIO_TRANSCRIPTION_PROVIDERS: Record<string, AudioProvider> = new Proxy({} as Record<string, AudioProvider>, {
  get(target, key: string) {
    if (key in target) {
      return target[key];
    }
    return getOrCreateTranscriptionProviders()[key];
  },
  set(target, key: string, value) {
    target[key] = value;
    getOrCreateTranscriptionProviders()[key] = value;
    return true;
  },
  deleteProperty(target, key: string) {
    delete target[key];
    delete getOrCreateTranscriptionProviders()[key];
    return true;
  },
  ownKeys(target) {
    const targetKeys = Reflect.ownKeys(target);
    const registryKeys = Reflect.ownKeys(getOrCreateTranscriptionProviders());
    return Array.from(new Set([...targetKeys, ...registryKeys]));
  },
  has(target, key) {
    return key in target || key in getOrCreateTranscriptionProviders();
  },
  getOwnPropertyDescriptor(target, key) {
    if (key in target) {
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
    if (key in getOrCreateTranscriptionProviders()) {
      return { configurable: true, enumerable: true, value: getOrCreateTranscriptionProviders()[key as string] };
    }
    return undefined;
  },
});

export function getTranscriptionProviders(): Record<string, AudioProvider> {
  return AUDIO_TRANSCRIPTION_PROVIDERS;
}

let _AUDIO_SPEECH_PROVIDERS: Record<string, AudioProvider> | null = null;

function getOrCreateSpeechProviders(): Record<string, AudioProvider> {
  if (!_AUDIO_SPEECH_PROVIDERS) {
    _AUDIO_SPEECH_PROVIDERS = {};
  }
  return _AUDIO_SPEECH_PROVIDERS;
}

export const AUDIO_SPEECH_PROVIDERS: Record<string, AudioProvider> = new Proxy({} as Record<string, AudioProvider>, {
  get(target, key: string) {
    if (key in target) {
      return target[key];
    }
    return getOrCreateSpeechProviders()[key];
  },
  set(target, key: string, value) {
    target[key] = value;
    getOrCreateSpeechProviders()[key] = value;
    return true;
  },
  deleteProperty(target, key: string) {
    delete target[key];
    delete getOrCreateSpeechProviders()[key];
    return true;
  },
  ownKeys(target) {
    const targetKeys = Reflect.ownKeys(target);
    const registryKeys = Reflect.ownKeys(getOrCreateSpeechProviders());
    return Array.from(new Set([...targetKeys, ...registryKeys]));
  },
  has(target, key) {
    return key in target || key in getOrCreateSpeechProviders();
  },
  getOwnPropertyDescriptor(target, key) {
    if (key in target) {
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
    if (key in getOrCreateSpeechProviders()) {
      return { configurable: true, enumerable: true, value: getOrCreateSpeechProviders()[key as string] };
    }
    return undefined;
  },
});

export function getSpeechProviders(): Record<string, AudioProvider> {
  return AUDIO_SPEECH_PROVIDERS;
}

export function getTranscriptionProvider(providerId: string): AudioProvider | null {
  return AUDIO_TRANSCRIPTION_PROVIDERS[providerId] || null;
}
export function getSpeechProvider(providerId: string): AudioProvider | null {
  return AUDIO_SPEECH_PROVIDERS[providerId] || null;
}
export interface ProviderNodeRow {
  prefix: string;
  name: string;
  baseUrl: string;
  apiType?: string;
}

/**
 * Build a dynamic AudioProvider from a provider_node DB entry.
 * Only used for local providers (localhost/127.0.0.1) — remote nodes are
 * excluded by the caller to prevent auth bypass and SSRF.
 */
export function buildDynamicAudioProvider(node: ProviderNodeRow, audioPath: string): AudioProvider {
  if (!node.prefix || !node.baseUrl) {
    throw new Error(`Invalid provider_node: missing prefix or baseUrl`);
  }
  const baseUrl = node.baseUrl.replace(/\/+$/, "");
  return {
    id: node.prefix,
    baseUrl: `${baseUrl}${audioPath}`,
    authType: "none",
    authHeader: "none",
    models: [],
  };
}

function parseAudioModel(
  modelStr: string | null,
  registry: Record<string, AudioProvider>,
  dynamicProviders?: AudioProvider[]
): { provider: string | null; model: string | null } {
  if (!modelStr) return { provider: null, model: null };

  // Phase 1: prefix match in hardcoded registry
  for (const [providerId] of Object.entries(registry)) {
    if (modelStr.startsWith(providerId + "/")) {
      return { provider: providerId, model: modelStr.slice(providerId.length + 1) };
    }
  }

  // Phase 2: bare model lookup in hardcoded registry
  for (const [providerId, config] of Object.entries(registry)) {
    if (config.models.some((m) => m.id === modelStr)) {
      return { provider: providerId, model: modelStr };
    }
  }

  // Phase 3: prefix match in dynamic providers (provider_nodes)
  if (dynamicProviders) {
    for (const dp of dynamicProviders) {
      if (modelStr.startsWith(dp.id + "/")) {
        return { provider: dp.id, model: modelStr.slice(dp.id.length + 1) };
      }
    }
  }

  return { provider: null, model: modelStr };
}

export function parseTranscriptionModel(
  modelStr: string | null,
  dynamicProviders?: AudioProvider[]
) {
  return parseAudioModel(modelStr, AUDIO_TRANSCRIPTION_PROVIDERS, dynamicProviders);
}

export function parseSpeechModel(modelStr: string | null, dynamicProviders?: AudioProvider[]) {
  return parseAudioModel(modelStr, AUDIO_SPEECH_PROVIDERS, dynamicProviders);
}

/**
 * Get all audio models as a flat list
 */
export function getAllAudioModels() {
  const models = [];

  for (const [providerId, config] of Object.entries(AUDIO_TRANSCRIPTION_PROVIDERS)) {
    for (const model of config.models) {
      models.push({
        id: model.id.startsWith(`${providerId}/`) ? model.id : `${providerId}/${model.id}`,
        name: model.name,
        provider: providerId,
        subtype: "transcription",
      });
    }
  }

  for (const [providerId, config] of Object.entries(AUDIO_SPEECH_PROVIDERS)) {
    for (const model of config.models) {
      models.push({
        id: model.id.startsWith(`${providerId}/`) ? model.id : `${providerId}/${model.id}`,
        name: model.name,
        provider: providerId,
        subtype: "speech",
      });
    }
  }

  return models;
}
