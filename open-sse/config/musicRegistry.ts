/**
 * Music Generation Provider Registry
 *
 * Defines providers that support the /v1/music/generations endpoint.
 * Currently supports local providers (ComfyUI with audio models).
 */

import { parseModelFromRegistry, getAllModelsFromRegistry } from "./registryUtils.ts";

interface MusicModel {
  id: string;
  name: string;
  isMarket?: boolean;
}

interface MusicProvider {
  id: string;
  baseUrl: string;
  statusUrl?: string;
  authType: string;
  authHeader: string;
  format: string;
  models: MusicModel[];
}

let _MUSIC_PROVIDERS: Record<string, MusicProvider> | null = null;

function getOrCreateMusicProviders(): Record<string, MusicProvider> {
  if (!_MUSIC_PROVIDERS) {
    _MUSIC_PROVIDERS = {};
  }
  return _MUSIC_PROVIDERS;
}

export const MUSIC_PROVIDERS: Record<string, MusicProvider> = new Proxy({} as Record<string, MusicProvider>, {
  get(target, key: string) {
    if (key in target) {
      return target[key];
    }
    return getOrCreateMusicProviders()[key];
  },
  set(target, key: string, value) {
    target[key] = value;
    getOrCreateMusicProviders()[key] = value;
    return true;
  },
  deleteProperty(target, key: string) {
    delete target[key];
    delete getOrCreateMusicProviders()[key];
    return true;
  },
  ownKeys(target) {
    const targetKeys = Reflect.ownKeys(target);
    const registryKeys = Reflect.ownKeys(getOrCreateMusicProviders());
    return Array.from(new Set([...targetKeys, ...registryKeys]));
  },
  has(target, key) {
    return key in target || key in getOrCreateMusicProviders();
  },
  getOwnPropertyDescriptor(target, key) {
    if (key in target) {
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
    if (key in getOrCreateMusicProviders()) {
      return { configurable: true, enumerable: true, value: getOrCreateMusicProviders()[key as string] };
    }
    return undefined;
  },
});

export function getMusicProviders(): Record<string, MusicProvider> {
  return MUSIC_PROVIDERS;
}

export function getMusicProvider(providerId: string): MusicProvider | null {
  return MUSIC_PROVIDERS[providerId] || null;
}

export function parseMusicModel(modelStr: string | null) {
  return parseModelFromRegistry(modelStr, MUSIC_PROVIDERS);
}

export function getAllMusicModels() {
  return getAllModelsFromRegistry(MUSIC_PROVIDERS);
}