import { getModelsByProviderId } from "@/shared/constants/models";

type ManagedAvailableModel = {
  id?: string;
  name?: string;
  contextLength?: number;
};

export function getCompatibleFallbackModels(
  providerId: string,
  fallbackModels: ManagedAvailableModel[] = []
): ManagedAvailableModel[] | undefined {
  if (providerId === "openrouter") return fallbackModels;
  return undefined;
}

export function compatibleProviderSupportsModelImport(_providerId: string): boolean {
  return true;
}
