import http from "node:http";

export interface MockAtlassianOptions {
  port?: number;
  auth?: { username: string; password: string };
}

export interface MockAtlassianRequest {
  method: string;
  path: string;
  body: unknown;
  authHeader?: string;
}

export interface MockAtlassianServer {
  url: string;
  close: () => Promise<void>;
  lastRequest: MockAtlassianRequest | null;
  history: MockAtlassianRequest[];
}

function checkBasicAuth(
  req: http.IncomingMessage,
  expected?: { username: string; password: string },
): boolean {
  if (!expected) return true;
  const auth = req.headers["authorization"];
  if (typeof auth !== "string" || !auth.startsWith("Basic ")) return false;
  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const colonIdx = decoded.indexOf(":");
  if (colonIdx === -1) return false;
  const u = decoded.slice(0, colonIdx);
  const p = decoded.slice(colonIdx + 1);
  return u === expected.username && p === expected.password;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startMockAtlassian(
  opts: MockAtlassianOptions = {},
): Promise<MockAtlassianServer> {
  const ref: MockAtlassianServer = {
    url: "",
    close: async () => {},
    lastRequest: null,
    history: [],
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed: unknown = {};
      try {
        if (body) parsed = JSON.parse(body);
      } catch {
        // non-JSON body
      }

      const captured: MockAtlassianRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        body: parsed,
        authHeader:
          typeof req.headers["authorization"] === "string"
            ? req.headers["authorization"]
            : undefined,
      };
      ref.lastRequest = captured;
      ref.history.push(captured);

      // Auth check
      if (!checkBasicAuth(req, opts.auth)) {
        return send(res, 401, { errorMessages: ["Unauthorized"] });
      }

      const rawUrl = req.url ?? "/";
      // Strip query string for routing
      const pathname = rawUrl.split("?")[0];
      const method = req.method ?? "GET";

      // ============ JIRA ============

      // GET /rest/api/2/issue/:key
      const jiraIssueGet = pathname.match(/^\/rest\/api\/2\/issue\/([^/]+)$/);
      if (jiraIssueGet && method === "GET") {
        const key = jiraIssueGet[1];
        return send(res, 200, {
          id: "10001",
          key,
          self: `${ref.url}/rest/api/2/issue/${key}`,
          fields: {
            summary: `Mock issue ${key}`,
            description: "Mock description",
            status: { name: "Open", id: "1" },
            issuetype: { name: "Task" },
          },
        });
      }

      // POST /rest/api/2/search
      if (pathname === "/rest/api/2/search" && method === "POST") {
        const b = parsed as { jql?: string; maxResults?: number };
        return send(res, 200, {
          startAt: 0,
          maxResults: b.maxResults ?? 50,
          total: 1,
          issues: [{ id: "10001", key: "MOCK-1", fields: { summary: "Mock issue search" } }],
        });
      }

      // POST /rest/api/2/issue (create)
      if (pathname === "/rest/api/2/issue" && method === "POST") {
        return send(res, 201, {
          id: "10002",
          key: "MOCK-2",
          self: `${ref.url}/rest/api/2/issue/MOCK-2`,
        });
      }

      // POST /rest/api/2/issue/:key/comment
      const jiraComment = pathname.match(/^\/rest\/api\/2\/issue\/([^/]+)\/comment$/);
      if (jiraComment && method === "POST") {
        const b = parsed as { body?: string };
        return send(res, 201, {
          id: "20001",
          body: b.body ?? "",
          author: { name: "mock-user" },
          created: new Date().toISOString(),
        });
      }

      // ============ BITBUCKET ============

      // GET /rest/api/1.0/projects/:p/repos/:r/pull-requests (list)
      const bbList = pathname.match(
        /^\/rest\/api\/1\.0\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests$/,
      );
      if (bbList && method === "GET") {
        return send(res, 200, {
          size: 1,
          start: 0,
          isLastPage: true,
          values: [
            {
              id: 100,
              title: "Mock PR",
              state: "OPEN",
              fromRef: { id: "refs/heads/feature" },
              toRef: { id: "refs/heads/main" },
            },
          ],
        });
      }

      // POST /rest/api/1.0/projects/:p/repos/:r/pull-requests (create)
      const bbCreate = pathname.match(
        /^\/rest\/api\/1\.0\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests$/,
      );
      if (bbCreate && method === "POST") {
        const b = parsed as { title?: string };
        return send(res, 201, {
          id: 101,
          title: b.title ?? "Mock created PR",
          state: "OPEN",
        });
      }

      // POST /rest/api/1.0/projects/:p/repos/:r/pull-requests/:id/comments
      const bbComment = pathname.match(
        /^\/rest\/api\/1\.0\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)\/comments$/,
      );
      if (bbComment && method === "POST") {
        const b = parsed as { text?: string };
        return send(res, 201, {
          id: 30001,
          text: b.text ?? "",
          author: { name: "mock-user" },
        });
      }

      // GET /rest/api/1.0/projects/:p/repos/:r/pull-requests/:id (single)
      const bbGet = pathname.match(
        /^\/rest\/api\/1\.0\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)$/,
      );
      if (bbGet && method === "GET") {
        return send(res, 200, {
          id: Number(bbGet[3]),
          title: "Mock detail",
          description: "Mock body",
          state: "OPEN",
          fromRef: { id: "refs/heads/feature" },
          toRef: { id: "refs/heads/main" },
          author: { user: { name: "mock-user" } },
        });
      }

      // ============ CONFLUENCE ============

      // GET /rest/api/content/search
      if (pathname === "/rest/api/content/search" && method === "GET") {
        return send(res, 200, {
          results: [{ id: "12345", title: "Mock search result", type: "page" }],
          size: 1,
          totalSize: 1,
          limit: 25,
        });
      }

      // GET /rest/api/content/:id
      const confGet = pathname.match(/^\/rest\/api\/content\/(\d+)$/);
      if (confGet && method === "GET") {
        return send(res, 200, {
          id: confGet[1],
          type: "page",
          title: "Mock Confluence page",
          space: { key: "MOCK" },
          version: { number: 1 },
          body: {
            storage: {
              value: "<p>Mock content</p>",
              representation: "storage",
            },
          },
        });
      }

      // POST /rest/api/content (create)
      if (pathname === "/rest/api/content" && method === "POST") {
        const b = parsed as { title?: string; space?: { key?: string } };
        return send(res, 200, {
          id: "67890",
          type: "page",
          title: b.title ?? "Untitled",
          space: { key: b.space?.key ?? "MOCK" },
          version: { number: 1 },
        });
      }

      // PUT /rest/api/content/:id
      const confPut = pathname.match(/^\/rest\/api\/content\/(\d+)$/);
      if (confPut && method === "PUT") {
        const b = parsed as { title?: string; version?: { number?: number } };
        return send(res, 200, {
          id: confPut[1],
          type: "page",
          title: b.title ?? "Updated",
          version: { number: b.version?.number ?? 2 },
        });
      }

      // Fallback 404
      send(res, 404, { errorMessages: [`Not found: ${method} ${pathname}`] });
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));

  const addr = server.address() as { port: number };
  ref.url = `http://127.0.0.1:${addr.port}`;

  ref.close = () =>
    new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

  return ref;
}
