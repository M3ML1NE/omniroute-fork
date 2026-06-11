import { getEmbeddingProvider } from "@omniroute/open-sse/config/embeddingRegistry.ts";
import { getRerankProvider } from "@omniroute/open-sse/config/rerankRegistry.ts";
import { getImageProvider } from "@omniroute/open-sse/config/imageRegistry.ts";
import { getVideoProvider } from "@omniroute/open-sse/config/videoRegistry.ts";
import {
  getSpeechProvider,
  getTranscriptionProvider,
} from "@omniroute/open-sse/config/audioRegistry.ts";

export type LocalCatalogModel = {
  id: string;
  name?: string;
  apiFormat?: string;
  supportedEndpoints?: string[];
};

const STATIC_MODEL_PROVIDERS: Record<string, () => Array<{ id: string; name: string }>> = {
  deepgram: () => [
    { id: "nova-3", name: "Nova 3 (Transcription)" },
    { id: "nova-2", name: "Nova 2 (Transcription)" },
    { id: "whisper-large", name: "Whisper Large (Transcription)" },
    { id: "aura-asteria-en", name: "Aura Asteria EN (TTS)" },
    { id: "aura-luna-en", name: "Aura Luna EN (TTS)" },
    { id: "aura-stella-en", name: "Aura Stella EN (TTS)" },
  ],
  assemblyai: () => [
    { id: "universal-3-pro", name: "Universal 3 Pro (Transcription)" },
    { id: "universal-2", name: "Universal 2 (Transcription)" },
  ],
  nanobanana: () => [
    { id: "nanobanana-flash", name: "NanoBanana Flash (Gemini 2.5 Flash)" },
    { id: "nanobanana-pro", name: "NanoBanana Pro (Gemini 3 Pro)" },
  ],
};

export function getStaticModelsForProvider(provider: string): LocalCatalogModel[] | undefined {
  const staticModelsFn = STATIC_MODEL_PROVIDERS[provider];
  if (staticModelsFn) {
    return staticModelsFn();
  }

  const specialtyModels: LocalCatalogModel[] = [];
  const appendModels = (
    models: Array<{ id: string; name?: string }>,
    metadata?: Pick<LocalCatalogModel, "apiFormat" | "supportedEndpoints">
  ) => {
    for (const model of models) {
      if (specialtyModels.some((existing) => existing.id === model.id)) continue;
      specialtyModels.push({
        id: model.id,
        name: model.name || model.id,
        ...metadata,
      });
    }
  };

  const embeddingProvider = getEmbeddingProvider(provider);
  if (embeddingProvider) {
    appendModels(embeddingProvider.models, {
      apiFormat: "embeddings",
      supportedEndpoints: ["embeddings"],
    });
  }

  const rerankProvider = getRerankProvider(provider);
  if (rerankProvider) {
    appendModels(rerankProvider.models, {
      apiFormat: "rerank",
      supportedEndpoints: ["rerank"],
    });
  }

  const imageProvider = getImageProvider(provider);
  if (imageProvider) {
    appendModels(imageProvider.models);
  }

  const videoProvider = getVideoProvider(provider);
  if (videoProvider) {
    appendModels(videoProvider.models);
  }

  const speechProvider = getSpeechProvider(provider);
  if (speechProvider) {
    appendModels(speechProvider.models);
  }

  const transcriptionProvider = getTranscriptionProvider(provider);
  if (transcriptionProvider) {
    appendModels(transcriptionProvider.models);
  }

  return specialtyModels.length > 0 ? specialtyModels : undefined;
}

