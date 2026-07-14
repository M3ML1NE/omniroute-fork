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

describe("getTranscriptionProviders / getSpeechProviders", () => {
  it("returns a non-empty registry of transcription providers", () => {
    const providers = getTranscriptionProviders();
    assert.ok(Object.keys(providers).length > 0);
    assert.ok(providers.openai);
    assert.ok(Array.isArray(providers.openai.models));
  });

  it("returns a non-empty registry of speech providers", () => {
    const providers = getSpeechProviders();
    assert.ok(Object.keys(providers).length > 0);
  });
});

describe("getTranscriptionProvider / getSpeechProvider", () => {
  it("returns the provider config for a known transcription provider id", () => {
    const provider = getTranscriptionProvider("openai");
    assert.ok(provider);
    assert.equal(provider!.id, "openai");
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

  it("parses a provider-prefixed model string", () => {
    const result = parseTranscriptionModel("openai/whisper-1");
    assert.equal(result.provider, "openai");
    assert.equal(result.model, "whisper-1");
  });

  it("resolves a bare model id to its owning provider", () => {
    const result = parseTranscriptionModel("whisper-1");
    assert.equal(result.provider, "openai");
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
  it("parses a provider-prefixed speech model string", () => {
    const providers = getSpeechProviders();
    const [firstProviderId, firstProvider] = Object.entries(providers)[0];
    const firstModelId = firstProvider.models[0].id;
    const result = parseSpeechModel(`${firstProviderId}/${firstModelId}`);
    assert.equal(result.provider, firstProviderId);
  });

  it("returns null/null for a null model string", () => {
    assert.deepEqual(parseSpeechModel(null), { provider: null, model: null });
  });
});

describe("getAllAudioModels", () => {
  it("returns a flat list combining transcription and speech models", () => {
    const models = getAllAudioModels();
    assert.ok(models.length > 0);
    assert.ok(models.some((m) => m.subtype === "transcription"));
    assert.ok(models.some((m) => m.subtype === "speech"));
    for (const m of models) {
      assert.ok(m.id.includes("/"));
      assert.ok(typeof m.name === "string");
      assert.ok(typeof m.provider === "string");
    }
  });
});
