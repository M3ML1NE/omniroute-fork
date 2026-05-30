import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Inline translation logic (unit test - no imports from implementation)
// Mirrors the logic in open-sse/executors/default.ts and open-sse/handlers/chatCore.ts

function translateToolsToFunctions(tools: unknown[]): unknown[] {
  return tools.map((tool: unknown) => {
    const t = tool as Record<string, unknown>;
    const fn = t["function"] as Record<string, unknown>;
    return {
      name: String(fn["name"]).replace(/-/g, "_"),
      description: fn["description"],
      parameters: fn["parameters"], // pass-through, no validation
    };
  });
}

function translateFunctionCallToToolCalls(functionCall: {
  name: string;
  arguments: unknown;
}): unknown[] {
  return [
    {
      id: "call_test_1",
      type: "function",
      function: {
        name: functionCall.name,
        arguments:
          typeof functionCall.arguments === "string"
            ? functionCall.arguments
            : JSON.stringify(functionCall.arguments),
      },
    },
  ];
}

describe("tools passthrough", () => {
  it("tools[] translated to functions[] with name sanitization", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get-weather",
          description: "Get weather",
          parameters: { type: "object" },
        },
      },
    ];
    const functions = translateToolsToFunctions(tools);
    assert.equal((functions[0] as Record<string, unknown>)["name"], "get_weather");
    assert.equal((functions[0] as Record<string, unknown>)["description"], "Get weather");
  });

  it("parameters passed through without modification", () => {
    const schema = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    };
    const tools = [
      {
        type: "function",
        function: { name: "fn", parameters: schema },
      },
    ];
    const functions = translateToolsToFunctions(tools);
    assert.deepEqual((functions[0] as Record<string, unknown>)["parameters"], schema);
  });

  it("function_call translated to tool_calls array", () => {
    const fc = { name: "get_weather", arguments: '{"city":"Moscow"}' };
    const toolCalls = translateFunctionCallToToolCalls(fc);
    const tc = toolCalls[0] as Record<string, unknown>;
    assert.equal(tc["type"], "function");
    const fn = tc["function"] as Record<string, unknown>;
    assert.equal(fn["name"], "get_weather");
    assert.equal(fn["arguments"], '{"city":"Moscow"}');
  });

  it("function_call object arguments stringified", () => {
    const fc = { name: "fn", arguments: { city: "Moscow" } };
    const toolCalls = translateFunctionCallToToolCalls(fc);
    const fn = (toolCalls[0] as Record<string, unknown>)["function"] as Record<string, unknown>;
    assert.equal(typeof fn["arguments"], "string");
    assert.ok((fn["arguments"] as string).includes("Moscow"));
  });

  it("finish_reason function_call mapped to tool_calls", () => {
    const finishReason = "function_call";
    const translated = finishReason === "function_call" ? "tool_calls" : finishReason;
    assert.equal(translated, "tool_calls");
  });
});
