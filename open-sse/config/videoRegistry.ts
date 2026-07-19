/**
 * Video Generation Provider Registry
 *
 * Defines providers that support the /v1/videos/generations endpoint.
 * Supports local providers plus hosted task-based APIs such as Runway.
 */

import { parseModelFromRegistry, getAllModelsFromRegistry } from "./registryUtils.ts";

interface VideoModel {
  id: string;
  name: string;
  isMarket?: boolean;
}

interface VideoProvider {
  id: string;
  baseUrl: string;
  statusUrl?: string;
  authType: string;
  authHeader: string;
  format: string;
  models: VideoModel[];
}

let _VIDEO_PROVIDERS: Record<string, VideoProvider> | null = null;

function getOrCreateVideoProviders(): Record<string, VideoProvider> {
  if (!_VIDEO_PROVIDERS) {
    _VIDEO_PROVIDERS = {};
  }
  return _VIDEO_PROVIDERS;
}

export const VIDEO_PROVIDERS: Record<string, VideoProvider> = new Proxy({} as Record<string, VideoProvider>, {
  get(target, key: string) {
    if (key in target) {
      return target[key];
    }
    return getOrCreateVideoProviders()[key];
  },
  set(target, key: string, value) {
    target[key] = value;
    getOrCreateVideoProviders()[key] = value;
    return true;
  },
  deleteProperty(target, key: string) {
    delete target[key];
    delete getOrCreateVideoProviders()[key];
    return true;
  },
  ownKeys(target) {
    const targetKeys = Reflect.ownKeys(target);
    const registryKeys = Reflect.ownKeys(getOrCreateVideoProviders());
    return Array.from(new Set([...targetKeys, ...registryKeys]));
  },
  has(target, key) {
    return key in target || key in getOrCreateVideoProviders();
  },
  getOwnPropertyDescriptor(target, key) {
    if (key in target) {
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
    if (key in getOrCreateVideoProviders()) {
      return { configurable: true, enumerable: true, value: getOrCreateVideoProviders()[key as string] };
    }
    return undefined;
  },
});

export function getVideoProviders(): Record<string, VideoProvider> {
  return VIDEO_PROVIDERS;
}

export function getVideoProvider(providerId: string): VideoProvider | null {
  return VIDEO_PROVIDERS[providerId] || null;
}

export function parseVideoModel(modelStr: string | null) {
  return parseModelFromRegistry(modelStr, VIDEO_PROVIDERS);
}

export function getAllVideoModels() {
  return getAllModelsFromRegistry(VIDEO_PROVIDERS);
}