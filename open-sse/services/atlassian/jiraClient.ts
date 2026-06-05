import https from "node:https";
import type { AtlassianServiceConfig } from "../../types/atlassianConfig.js";
import type {
  JiraIssue,
  JiraSearchResult,
  JiraCreateIssueInput,
  JiraComment,
  JiraErrorResponse,
} from "../../types/atlassian/jira.js";
import { getAgent } from "../mtlsAgent";

export class JiraClient {
  private readonly agent: https.Agent | undefined;
  private readonly basicAuth: string;
  private readonly timeout: number;

  constructor(private readonly config: AtlassianServiceConfig) {
    this.basicAuth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
    this.agent = config.mtls ? getAgent(config.mtls) : undefined;
    this.timeout = config.timeout_ms ?? 30000;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
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
        let parsed: JiraErrorResponse;
        try {
          parsed = JSON.parse(errBody) as JiraErrorResponse;
        } catch {
          parsed = { errorMessages: [errBody] };
        }
        const msgs = parsed.errorMessages?.length
          ? parsed.errorMessages
          : [r.statusText];
        throw new Error(
          `Jira ${method} ${path} failed (${r.status}): ${msgs.join("; ")}`,
        );
      }

      return (await r.json()) as T;
    } finally {
      clearTimeout(tid);
    }
  }

  async getIssue(
    key: string,
    opts?: { fields?: string[] },
  ): Promise<JiraIssue> {
    const qs =
      opts?.fields?.length
        ? `?fields=${encodeURIComponent(opts.fields.join(","))}`
        : "";
    return this.request<JiraIssue>(
      "GET",
      `/rest/api/2/issue/${encodeURIComponent(key)}${qs}`,
    );
  }

  async search(
    jql: string,
    opts?: { maxResults?: number; fields?: string[] },
  ): Promise<JiraSearchResult> {
    return this.request<JiraSearchResult>("POST", "/rest/api/2/search", {
      jql,
      maxResults: opts?.maxResults ?? 50,
      fields: opts?.fields,
    });
  }

  async createIssue(input: JiraCreateIssueInput): Promise<JiraIssue> {
    const fields: Record<string, unknown> = {
      project: { key: input.project_key },
      issuetype: { name: input.issue_type },
      summary: input.summary,
      ...(input.description ? { description: input.description } : {}),
      ...(input.fields ?? {}),
    };
    return this.request<JiraIssue>("POST", "/rest/api/2/issue", { fields });
  }

  async addComment(issueKey: string, body: string): Promise<JiraComment> {
    return this.request<JiraComment>(
      "POST",
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`,
      { body },
    );
  }
}
