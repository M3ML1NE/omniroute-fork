import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DefaultExecutor } from "../../../open-sse/executors/default.ts";

const NODE_ID = "gigachat-compatible-abc123";
const MTLS = {
  cert_path: "/tmp/secrets/crt.cert",
  key_path: "/tmp/secrets/crt.key",
  ca_path: "/tmp/secrets/ca.pem",
};

describe("gigachat-compatible executor", () => {
  it("buildUrl normalizes baseUrl to /chat/completions", () => {
    const exec = new DefaultExecutor(NODE_ID);
    const url = exec.buildUrl("GigaChat-2-Max", false, 0, {
      providerSpecificData: { baseUrl: "https://gigachat.devices.sberbank.ru/api/v1", mtls: MTLS },
    });
    assert.equal(url, "https://gigachat.devices.sberbank.ru/api/v1/chat/completions");
  });

  it("buildUrl falls back to the Sber default when no baseUrl is set", () => {
    const exec = new DefaultExecutor(NODE_ID);
    const url = exec.buildUrl("GigaChat-2-Max", false, 0, { providerSpecificData: { mtls: MTLS } });
    assert.equal(url, "https://gigachat.devices.sberbank.ru/api/v1/chat/completions");
  });

  it("buildHeaders omits Authorization for mTLS connections", () => {
    const exec = new DefaultExecutor(NODE_ID);
    const headers = exec.buildHeaders({ providerSpecificData: { mtls: MTLS } }, false);
    assert.equal(headers["Authorization"], undefined);
  });

  it("transformRequest maps OpenAI tools[] to GigaChat functions[] and strips stream_options", () => {
    const exec = new DefaultExecutor(NODE_ID);
    const body = exec.transformRequest(
      "GigaChat-2-Max",
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { type: "function", function: { name: "get-weather", description: "d", parameters: {} } },
        ],
        tool_choice: "auto",
        stream_options: { include_usage: true },
      },
      true,
      { providerSpecificData: { mtls: MTLS } }
    ) as Record<string, unknown>;

    assert.ok(Array.isArray(body.functions), "functions[] present");
    assert.equal((body.functions as { name: string }[])[0].name, "get_weather", "hyphen sanitized");
    assert.equal(body.tools, undefined, "tools removed");
    assert.equal(body.tool_choice, undefined, "tool_choice removed");
    assert.equal(body.stream_options, undefined, "stream_options stripped in cert mode");
  });

  it("transformRequest normalizes nested object params so GigaChat accepts them (#422)", () => {
    const exec = new DefaultExecutor(NODE_ID);
    const body = exec.transformRequest(
      "GigaChat-2-Max",
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "edit",
              description: "d",
              parameters: {
                type: "object",
                properties: { inline: { type: "object" } },
                required: ["inline"],
              },
            },
          },
        ],
      },
      false,
      { providerSpecificData: { mtls: MTLS } }
    ) as Record<string, unknown>;

    const fn = (body.functions as { parameters: Record<string, unknown> }[])[0];
    const inline = (fn.parameters.properties as Record<string, Record<string, unknown>>).inline;
    assert.deepEqual(
      inline.properties,
      {},
      "nested object must gain properties:{} to satisfy GigaChat"
    );
  });
});
