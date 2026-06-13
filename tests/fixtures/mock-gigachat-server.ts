import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TLS_DIR = path.join(__dirname, "mock-tls");

export interface MockGigachatOptions {
  tls?: boolean;
  port?: number;
}

export interface MockGigachatServer {
  url: string;
  close: () => Promise<void>;
  /** Captured last request body/path for assertion */
  lastRequest: { body: unknown; path: string } | null;
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
    serverRef.lastRequest = { body: parsed, path: req.url ?? "/" };

    const url = req.url ?? "/";

    // OAuth token endpoint
    if (url === "/oauth/token" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: `mock-token-${Date.now()}`,
          expires_at: Math.floor(Date.now() / 1000) + 1800,
          token_type: "Bearer",
        }),
      );
      return;
    }

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

      if (isStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const chunks = ["Hello", " from", " mock", " GigaChat"];
        let i = 0;
        const interval = setInterval(() => {
          if (i < chunks.length) {
            const delta: Record<string, unknown> =
              i === 0 ? { role: "assistant", content: chunks[i] } : { content: chunks[i] };
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
            res.write(
              `data: ${JSON.stringify({
                id: "mock-stream-1",
                object: "chat.completion.chunk",
                model: "GigaChat",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
            clearInterval(interval);
          }
        }, 10);
        return;
      }

      // Non-streaming — handle functions (GigaChat uses functions[] not tools[])
      let message: Record<string, unknown> = {
        role: "assistant",
        content: "mock-reply",
        // GigaChat-style reasoning field echoed so reasoning conversion is testable.
        reasoning_content: "mock reasoning: deciding what to do",
      };
      if (functions && functions.length > 0) {
        const fn = functions[0] as Record<string, unknown>;
        message = {
          role: "assistant",
          content: null,
          reasoning_content: "mock reasoning: the user asked, calling the tool",
          tool_calls: [
            {
              id: "call_mock_1",
              type: "function",
              function: { name: fn["name"], arguments: '{"city":"Moscow"}' },
            },
          ],
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
              finish_reason: functions?.length ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
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
