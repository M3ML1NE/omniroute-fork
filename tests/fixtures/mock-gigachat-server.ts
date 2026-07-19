import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TLS_DIR = path.join(__dirname, "mock-tls");

// "whole": full arguments in one delta.function_call chunk.
// "split": arguments string fragmented across chunks (exercises the stream accumulator).
export type MockGigachatStreamArgsMode = "whole" | "split";

// Wire mode: "gigachat" emits true GigaChat v1 shapes (function_call, functions_state_id).
// "openai" is retained for type backward-compat but is no longer used by the server.
export type MockGigachatWire = "openai" | "gigachat";

export interface MockGigachatOptions {
  tls?: boolean;
  port?: number;
  wire?: MockGigachatWire;
  streamArgsMode?: MockGigachatStreamArgsMode;
  precachedPromptTokens?: number;
  reasoningContent?: string;
  streamFinishReason?: string;
  nonStreamFinishReason?: string;
}

export interface MockGigachatCapturedRequest {
  body: unknown;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  method: string;
}

export interface MockGigachatServer {
  url: string;
  close: () => Promise<void>;
  lastRequest: MockGigachatCapturedRequest | null;
  wire: MockGigachatWire;
  streamArgsMode: MockGigachatStreamArgsMode;
  precachedPromptTokens: number;
  reasoningContent: string;
  streamFinishReason: string;
  nonStreamFinishReason: string;
}

const MOCK_STATE_ID = "0e2a1b3c-4d5e-6f70-8a9b-mockstate0001";

function writeSseHeaders(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

function respondPlainTextStream(
  res: http.ServerResponse,
  reasoningContent?: string,
  precachedPromptTokens?: number,
  finishReason = "stop",
): void {
  writeSseHeaders(res);
  const chunks = ["Hello", " from", " mock", " GigaChat"];
  let i = 0;
  const interval = setInterval(() => {
    if (i < chunks.length) {
      const delta: Record<string, unknown> =
        i === 0
          ? { role: "assistant", content: chunks[i], ...(reasoningContent && { reasoning_content: reasoningContent }) }
          : { content: chunks[i] };
      res.write(
        `data: ${JSON.stringify({
          id: "mock-stream-1",
          object: "chat.completion.chunk",
          model: "GigaChat",
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`,
      );
      i++;
    } else {
      // Real GigaChat v1 puts usage on the penultimate SSE event, one event
      // before the finish_reason-bearing final chunk.
      if (typeof precachedPromptTokens === "number") {
        res.write(
          `data: ${JSON.stringify({
            id: "mock-stream-1",
            object: "chat.completion.chunk",
            model: "GigaChat",
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
              precached_prompt_tokens: precachedPromptTokens,
            },
          })}\n\n`,
        );
      }
      res.write(
        `data: ${JSON.stringify({
          id: "mock-stream-1",
          object: "chat.completion.chunk",
          model: "GigaChat",
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      clearInterval(interval);
    }
  }, 10);
}

// True GigaChat v1 non-stream shape: message.function_call with an OBJECT-valued
// arguments field (NOT a JSON string), functions_state_id, and finish_reason "function_call".
function respondGigachatNonStream(
  res: http.ServerResponse,
  functions?: unknown[],
  precachedPromptTokens = 4,
  reasoningContent = "mock reasoning: deciding what to do",
  finishReason?: string,
): void {
  let message: Record<string, unknown> = {
    role: "assistant",
    content: "mock-reply",
    reasoning_content: reasoningContent,
  };
  if (functions && functions.length > 0) {
    const fn = functions[0] as Record<string, unknown>;
    message = {
      role: "assistant",
      content: "",
      reasoning_content: reasoningContent,
      function_call: { name: fn["name"], arguments: { city: "Moscow" } },
      functions_state_id: MOCK_STATE_ID,
    };
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: "mock-chat-1",
      object: "chat.completion",
      model: "GigaChat",
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason ?? (functions?.length ? "function_call" : "stop"),
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        precached_prompt_tokens: precachedPromptTokens,
      },
    }),
  );
}

// GigaChat streaming function call: delta.function_call chunks terminated by [DONE].
// "whole" emits the full arguments object in one chunk; "split" fragments the arguments
// string across chunks so the production stream accumulator is exercised on both paths.
function respondGigachatFunctionStream(
  res: http.ServerResponse,
  functions: unknown[],
  argsMode: MockGigachatStreamArgsMode,
  reasoningContent?: string,
): void {
  writeSseHeaders(res);
  const fn = functions[0] as Record<string, unknown>;
  const fnName = fn["name"];
  const argsChunks =
    argsMode === "split" ? [`{"ci`, `ty":"Mos`, `cow"}`] : [`{"city":"Moscow"}`];

  const emit = (delta: Record<string, unknown>, finishReason: string | null): void => {
    res.write(
      `data: ${JSON.stringify({
        id: "mock-stream-1",
        object: "chat.completion.chunk",
        model: "GigaChat",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  };

  const steps: Array<() => void> = [];
  steps.push(() => {
    const firstDelta: Record<string, unknown> = { role: "assistant", function_call: { name: fnName } };
    if (reasoningContent) {
      firstDelta.reasoning_content = reasoningContent;
    }
    emit(firstDelta, null);
  });
  for (const part of argsChunks) {
    steps.push(() => emit({ function_call: { arguments: part } }, null));
  }
  steps.push(() => {
    emit({ functions_state_id: MOCK_STATE_ID }, "function_call");
    res.write("data: [DONE]\n\n");
    res.end();
  });

  let i = 0;
  const interval = setInterval(() => {
    steps[i]();
    i++;
    if (i >= steps.length) clearInterval(interval);
  }, 10);
}

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  serverRef: MockGigachatServer,
): void {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      // non-JSON body ok
    }
    serverRef.lastRequest = {
      body: parsed,
      path: req.url ?? "/",
      headers: req.headers,
      method: req.method ?? "GET",
    };

    const url = req.url ?? "/";

    // Models endpoint
    if (url === "/api/v1/models" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "GigaChat", object: "model", owned_by: "sber" }],
        }),
      );
      return;
    }

    // Embeddings endpoint
    if (url === "/api/v1/embeddings" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
          model: "GigaChat",
          usage: { prompt_tokens: 5, total_tokens: 5 },
        }),
      );
      return;
    }

    // Chat completions endpoint
    if (url === "/api/v1/chat/completions" && req.method === "POST") {
      const reqBody = parsed as Record<string, unknown>;
      const isStream = reqBody["stream"] === true;
      const functions = reqBody["functions"] as unknown[] | undefined;
      const hasFunctions = Array.isArray(functions) && functions.length > 0;

      if (isStream) {
        if (serverRef.wire === "gigachat" && hasFunctions) {
          respondGigachatFunctionStream(res, functions, serverRef.streamArgsMode, serverRef.reasoningContent);
        } else {
          respondPlainTextStream(
            res,
            serverRef.wire === "gigachat" ? serverRef.reasoningContent : undefined,
            serverRef.wire === "gigachat" ? serverRef.precachedPromptTokens : undefined,
            serverRef.streamFinishReason,
          );
        }
        return;
      }

      respondGigachatNonStream(
        res,
        hasFunctions ? functions : undefined,
        serverRef.precachedPromptTokens,
        serverRef.reasoningContent,
        serverRef.nonStreamFinishReason || undefined,
      );
      return;
    }

    // 404 fallback
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found", type: "not_found" } }));
  });
}

export async function startMockGigachat(
  opts: MockGigachatOptions = {},
): Promise<MockGigachatServer> {
  const serverRef: MockGigachatServer = {
    url: "",
    close: async () => {},
    lastRequest: null,
    wire: opts.wire ?? "gigachat",
    streamArgsMode: opts.streamArgsMode ?? "whole",
    precachedPromptTokens: opts.precachedPromptTokens ?? 4,
    reasoningContent: opts.reasoningContent ?? "mock reasoning: deciding what to do",
    streamFinishReason: opts.streamFinishReason ?? "stop",
    nonStreamFinishReason: opts.nonStreamFinishReason ?? "",
  };

  const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) =>
    handleRequest(req, res, serverRef);

  let server: http.Server | https.Server;

  if (opts.tls) {
    server = https.createServer(
      {
        cert: fs.readFileSync(path.join(TLS_DIR, "server.crt")),
        key: fs.readFileSync(path.join(TLS_DIR, "server.key")),
        ca: fs.readFileSync(path.join(TLS_DIR, "ca.crt")),
        requestCert: true,
        rejectUnauthorized: true,
      },
      requestHandler,
    );
  } else {
    server = http.createServer(requestHandler);
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));

  const addr = server.address() as { port: number };
  const proto = opts.tls ? "https" : "http";
  serverRef.url = `${proto}://127.0.0.1:${addr.port}`;

  serverRef.close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );

  return serverRef;
}
