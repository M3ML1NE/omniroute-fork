import https from "node:https";
import type { AtlassianServiceConfig } from "../../types/atlassianConfig.js";
import type {
  BitbucketPullRequest,
  BitbucketPullRequestList,
  BitbucketCreatePRInput,
  BitbucketComment,
  BitbucketPRState,
  BitbucketErrorResponse,
} from "../../types/atlassian/bitbucket.js";
import { getAgent } from "../mtlsAgent";

export class BitbucketClient {
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
        let parsed: BitbucketErrorResponse;
        try {
          parsed = JSON.parse(errBody) as BitbucketErrorResponse;
        } catch {
          parsed = { errors: [{ message: errBody }] };
        }
        const msgs = parsed.errors?.length ? parsed.errors.map((e) => e.message) : [r.statusText];
        throw new Error(`Bitbucket ${method} ${path} failed (${r.status}): ${msgs.join("; ")}`);
      }

      return (await r.json()) as T;
    } finally {
      clearTimeout(tid);
    }
  }

  async listPullRequests(
    project: string,
    repo: string,
    opts?: { state?: BitbucketPRState; limit?: number; start?: number },
  ): Promise<BitbucketPullRequestList> {
    const params = new URLSearchParams();
    if (opts?.state) params.set("state", opts.state);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.start !== undefined) params.set("start", String(opts.start));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.request<BitbucketPullRequestList>(
      "GET",
      `/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/pull-requests${qs}`,
    );
  }

  async getPullRequest(project: string, repo: string, prId: number): Promise<BitbucketPullRequest> {
    return this.request<BitbucketPullRequest>(
      "GET",
      `/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/pull-requests/${prId}`,
    );
  }

  async createPullRequest(
    project: string,
    repo: string,
    input: BitbucketCreatePRInput,
  ): Promise<BitbucketPullRequest> {
    const body: Record<string, unknown> = {
      title: input.title,
      description: input.description,
      fromRef: {
        id: input.source_branch.startsWith("refs/")
          ? input.source_branch
          : `refs/heads/${input.source_branch}`,
      },
      toRef: {
        id: input.target_branch.startsWith("refs/")
          ? input.target_branch
          : `refs/heads/${input.target_branch}`,
      },
    };
    if (input.reviewers?.length) {
      body["reviewers"] = input.reviewers.map((name) => ({ user: { name } }));
    }
    return this.request<BitbucketPullRequest>(
      "POST",
      `/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/pull-requests`,
      body,
    );
  }

  async addPullRequestComment(
    project: string,
    repo: string,
    prId: number,
    text: string,
  ): Promise<BitbucketComment> {
    return this.request<BitbucketComment>(
      "POST",
      `/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/pull-requests/${prId}/comments`,
      { text },
    );
  }
}
