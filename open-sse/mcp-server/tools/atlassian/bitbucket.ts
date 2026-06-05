/**
 * Bitbucket MCP tool definitions (4 tools).
 * Tools are plain objects: { name, description, inputSchema, handler }.
 * MCP server registration happens in T13.
 */

import { z } from "zod";
import { BitbucketClient } from "../../../services/atlassian/bitbucketClient";
import { getAtlassianConfig } from "../../../services/atlassianConfig";

// ============ Lazy client resolver ============

/**
 * Resolve BitbucketClient at tool-call time (not registration time).
 * Throws a clear error if Bitbucket is not configured or disabled.
 */
function getBitbucketClient(): BitbucketClient {
  const cfg = getAtlassianConfig().get("bitbucket");
  if (!cfg) {
    throw new Error(
      "Bitbucket service not configured. Set ~/.omniroute/atlassian.json 'bitbucket' section.",
    );
  }
  if (!cfg.enabled) {
    throw new Error(
      "Bitbucket service is disabled in config (set 'enabled: true' to use Bitbucket tools).",
    );
  }
  return new BitbucketClient(cfg);
}

// ============ Zod input schemas ============

const ListPRsSchema = z.object({
  project: z.string().min(1).describe("Bitbucket project key (e.g. 'DEV')"),
  repo: z.string().min(1).describe("Repository slug (e.g. 'my-repo')"),
  state: z
    .enum(["OPEN", "MERGED", "DECLINED"])
    .optional()
    .describe("Filter PRs by state (default: all)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max results (default 25)"),
});

const GetPRSchema = z.object({
  project: z.string().min(1).describe("Bitbucket project key"),
  repo: z.string().min(1).describe("Repository slug"),
  pr_id: z.number().int().positive().describe("Pull request numeric ID"),
});

const CreatePRSchema = z.object({
  project: z.string().min(1).describe("Bitbucket project key"),
  repo: z.string().min(1).describe("Repository slug"),
  title: z.string().min(1).describe("PR title"),
  source_branch: z
    .string()
    .min(1)
    .describe("Source branch name (e.g. 'feature/x' or 'refs/heads/feature/x')"),
  target_branch: z
    .string()
    .min(1)
    .describe("Target branch name (e.g. 'main')"),
  description: z.string().optional().describe("PR description (Markdown supported)"),
});

const AddPRCommentSchema = z.object({
  project: z.string().min(1).describe("Bitbucket project key"),
  repo: z.string().min(1).describe("Repository slug"),
  pr_id: z.number().int().positive().describe("Pull request numeric ID"),
  text: z.string().min(1).describe("Comment text"),
});

// ============ Tool result type ============

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[] };

// ============ Tool definitions ============

export interface BitbucketMcpTool<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (args: z.infer<S>) => Promise<ToolResult>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBitbucketMcpTool = BitbucketMcpTool<any>;

export const bitbucketTools: AnyBitbucketMcpTool[] = [
  {
    name: "bitbucket_list_prs",
    description:
      "List pull requests in a Bitbucket repository, optionally filtered by state.",
    inputSchema: ListPRsSchema,
    async handler(args: z.infer<typeof ListPRsSchema>): Promise<ToolResult> {
      const client = getBitbucketClient();
      const list = await client.listPullRequests(args.project, args.repo, {
        state: args.state,
        limit: args.limit,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
      };
    },
  },

  {
    name: "bitbucket_get_pr",
    description: "Get details of a specific Bitbucket pull request by ID.",
    inputSchema: GetPRSchema,
    async handler(args: z.infer<typeof GetPRSchema>): Promise<ToolResult> {
      const client = getBitbucketClient();
      const pr = await client.getPullRequest(args.project, args.repo, args.pr_id);
      return {
        content: [{ type: "text", text: JSON.stringify(pr, null, 2) }],
      };
    },
  },

  {
    name: "bitbucket_create_pr",
    description: "Create a new pull request from source_branch to target_branch.",
    inputSchema: CreatePRSchema,
    async handler(args: z.infer<typeof CreatePRSchema>): Promise<ToolResult> {
      const client = getBitbucketClient();
      const pr = await client.createPullRequest(args.project, args.repo, {
        title: args.title,
        description: args.description,
        source_branch: args.source_branch,
        target_branch: args.target_branch,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(pr, null, 2) }],
      };
    },
  },

  {
    name: "bitbucket_add_pr_comment",
    description: "Add a comment to an existing pull request.",
    inputSchema: AddPRCommentSchema,
    async handler(args: z.infer<typeof AddPRCommentSchema>): Promise<ToolResult> {
      const client = getBitbucketClient();
      const comment = await client.addPullRequestComment(
        args.project,
        args.repo,
        args.pr_id,
        args.text,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(comment, null, 2) }],
      };
    },
  },
];
