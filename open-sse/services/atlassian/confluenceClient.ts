import https from "node:https";
import type { AtlassianServiceConfig } from "../../types/atlassianConfig.js";
import type {
  ConfluencePage,
  ConfluenceSearchResult,
  ConfluenceCreatePageInput,
  ConfluenceUpdatePageInput,
} from "../../types/atlassian/confluence.js";
import { getAgent } from "../mtlsAgent.js";

export class ConfluenceClient {
  private readonly agent: https.Agent | undefined;
  private readonly basicAuth: string;
  private readonly timeout: number;

  constructor(private readonly config: AtlassianServiceConfig) {
    this.basicAuth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
    this.agent = config.mtls ? getAgent(config.mtls) : undefined;
    this.timeout = config.timeout_ms ?? 30000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.config.base_url).toString();
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), this.timeout);

    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: this.basicAuth,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: controller.signal,
      };

      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const r = await fetch(url, init);

      if (!r.ok) {
        const errBody = await r.text();
        let parsed: { message?: string } = {};
        try {
          parsed = JSON.parse(errBody) as { message?: string };
        } catch {
          parsed = { message: errBody };
        }
        const msg = parsed.message ?? r.statusText;
        throw new Error(`Confluence ${method} ${path} failed (${r.status}): ${msg}`);
      }

      return (await r.json()) as T;
    } finally {
      clearTimeout(tid);
    }
  }

  async getPage(pageId: string, opts?: { expand?: string[] }): Promise<ConfluencePage> {
    const expand =
      opts?.expand?.length ? opts.expand.join(",") : "body.storage,version,space";
    return this.request<ConfluencePage>(
      "GET",
      `/rest/api/content/${encodeURIComponent(pageId)}?expand=${encodeURIComponent(expand)}`,
    );
  }

  async search(cql: string, opts?: { limit?: number }): Promise<ConfluenceSearchResult> {
    const params = new URLSearchParams();
    params.set("cql", cql);
    if (opts?.limit !== undefined) {
      params.set("limit", String(opts.limit));
    }
    return this.request<ConfluenceSearchResult>(
      "GET",
      `/rest/api/content/search?${params.toString()}`,
    );
  }

  async createPage(input: ConfluenceCreatePageInput): Promise<ConfluencePage> {
    const body: Record<string, unknown> = {
      type: "page",
      title: input.title,
      space: { key: input.space_key },
      body: {
        storage: {
          value: input.body,
          representation: "storage",
        },
      },
    };

    if (input.parent_id) {
      body["ancestors"] = [{ id: input.parent_id }];
    }

    return this.request<ConfluencePage>("POST", "/rest/api/content", body);
  }

  async updatePage(pageId: string, input: ConfluenceUpdatePageInput): Promise<ConfluencePage> {
    let versionNumber = input.version_number;

    if (versionNumber === undefined) {
      // Auto-fetch current version and increment
      const current = await this.getPage(pageId, { expand: ["version"] });
      const currentVersion = current.version?.number ?? 1;
      versionNumber = currentVersion + 1;
    }

    return this.request<ConfluencePage>(
      "PUT",
      `/rest/api/content/${encodeURIComponent(pageId)}`,
      {
        type: "page",
        title: input.title,
        version: { number: versionNumber },
        body: {
          storage: {
            value: input.body,
            representation: "storage",
          },
        },
      },
    );
  }
}
