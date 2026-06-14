import { DefaultExecutor } from "./default.ts";
import { MlproxyExecutor } from "./mlproxy.ts";

const defaultCache = new Map<string, DefaultExecutor>();
const specializedCache = new Map<string, DefaultExecutor>();

export function getExecutor(provider: string): DefaultExecutor {
  if (provider === "mlproxy") {
    if (!specializedCache.has("mlproxy")) {
      specializedCache.set("mlproxy", new MlproxyExecutor());
    }
    return specializedCache.get("mlproxy")!;
  }
  if (!defaultCache.has(provider)) {
    defaultCache.set(provider, new DefaultExecutor(provider));
  }
  return defaultCache.get(provider)!;
}

export function hasSpecializedExecutor(_provider: string): boolean {
  return false;
}

export { BaseExecutor } from "./base.ts";
export { DefaultExecutor } from "./default.ts";
