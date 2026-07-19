import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getTranscriptionProviders,
  getSpeechProviders,
  getTranscriptionProvider,
  getSpeechProvider,
  buildDynamicAudioProvider,
  parseTranscriptionModel,
  parseSpeechModel,
  getAllAudioModels,
} from "../../open-sse/config/audioRegistry.ts";

// openai and every other hardcoded named provider were removed by the
// compatible-only-provider-docs-purge (Todo 5). These registries now only
// resolve dynamically-registered local provider_nodes (via
// buildDynamicAudioProvider) — a bare lookup by name always returns null.
describe("getTranscriptionProviders / getSpeechProviders", () => {
  it("returns an empty registry of transcription providers (named entries purged)", () => {
    const providers = getTranscriptionProviders();
    assert.deepEqual(providers, {});
  });

  it("returns an empty registry of speech providers (named entries purged)", () => {
    const providers = getSpeechProviders();
    assert.deepEqual(providers, {});
  });
});

describe("getTranscriptionProvider / getSpeechProvider", () => {
  it("returns null for a formerly-hardcoded transcription provider id", () => {
    assert.equal(getTranscriptionProvider("openai"), null);
  });

  it("returns null for an unknown transcription provider id", () => {
    assert.equal(getTranscriptionProvider("totally-unknown-provider"), null);
  });

  it("returns null for an unknown speech provider id", () => {
    assert.equal(getSpeechProvider("totally-unknown-provider"), null);
  });
});

describe("buildDynamicAudioProvider", () => {
  it("builds a dynamic provider from a provider_node row", () => {
    const provider = buildDynamicAudioProvider(
      { prefix: "local-tts", name: "Local TTS", baseUrl: "http://localhost:5000" },
      "/v1/audio/speech"
    );
    assert.equal(provider.id, "local-tts");
    assert.equal(provider.baseUrl, "http://localhost:5000/v1/audio/speech");
    assert.equal(provider.authType, "none");
    assert.deepEqual(provider.models, []);
  });

  it("strips trailing slashes from the base URL before appending the audio path", () => {
    const provider = buildDynamicAudioProvider(
      { prefix: "local", name: "Local", baseUrl: "http://localhost:5000///" },
      "/v1/audio/speech"
    );
    assert.equal(provider.baseUrl, "http://localhost:5000/v1/audio/speech");
  });

  it("throws when prefix is missing", () => {
    assert.throws(() =>
      buildDynamicAudioProvider(
        { prefix: "", name: "x", baseUrl: "http://localhost:5000" },
        "/v1/audio/speech"
      )
    );
  });

  it("throws when baseUrl is missing", () => {
    assert.throws(() =>
      buildDynamicAudioProvider(
        { prefix: "local", name: "x", baseUrl: "" },
        "/v1/audio/speech"
      )
    );
  });
});

describe("parseTranscriptionModel", () => {
  it("returns null/null for a null model string", () => {
    assert.deepEqual(parseTranscriptionModel(null), { provider: null, model: null });
  });

  it("falls back to first-segment-as-provider for a prefixed string with no registry match", () => {
    const result = parseTranscriptionModel("openai/whisper-1");
    assert.equal(result.provider, null);
    assert.equal(result.model, "openai/whisper-1");
  });

  it("returns a null provider for a bare model id with no registry match", () => {
    const result = parseTranscriptionModel("whisper-1");
    assert.equal(result.provider, null);
    assert.equal(result.model, "whisper-1");
  });

  it("falls through to a dynamic provider prefix when no static match exists", () => {
    const result = parseTranscriptionModel("local-stt/my-model", [
      { id: "local-stt", baseUrl: "http://localhost:5000", authType: "none", authHeader: "none", models: [] },
    ]);
    assert.equal(result.provider, "local-stt");
    assert.equal(result.model, "my-model");
  });

  it("returns a null provider with the original model string when nothing matches", () => {
    const result = parseTranscriptionModel("totally-unknown-model");
    assert.equal(result.provider, null);
    assert.equal(result.model, "totally-unknown-model");
  });
});

describe("parseSpeechModel", () => {
  it("resolves a dynamic provider prefix when no static registry match exists", () => {
    const result = parseSpeechModel("local-tts/my-voice", [
      { id: "local-tts", baseUrl: "http://localhost:5000", authType: "none", authHeader: "none", models: [] },
    ]);
    assert.equal(result.provider, "local-tts");
    assert.equal(result.model, "my-voice");
  });

  it("returns null/null for a null model string", () => {
    assert.deepEqual(parseSpeechModel(null), { provider: null, model: null });
  });
});

describe("getAllAudioModels", () => {
  it("returns an empty list (no hardcoded named-provider entries remain)", () => {
    const models = getAllAudioModels();
    assert.deepEqual(models, []);
  });
});
