/**
 * Jira MCP tool definitions (4 tools).
 * Tools are plain objects: { name, description, inputSchema, handler }.
 * MCP server registration happens in T13.
 */

import { z } from "zod";
import { JiraClient } from "../../../services/atlassian/jiraClient.js";
import { getAtlassianConfig } from "../../../services/atlassianConfig.js";

// ============ Lazy client resolver ============

/**
 * Resolve a JiraClient at tool-call time (not registration time).
 * Throws a clear error if Jira is not configured or disabled.
 */
function getJiraClient(): JiraClient {
  const cfg = getAtlassianConfig().get("jira");
  if (!cfg) {
    throw new Error(
      "Jira service not configured. Set ~/.omniroute/atlassian.json 'jira' section.",
    );
  }
  if (!cfg.enabled) {
    throw new Error(
      "Jira service is disabled in config (set 'enabled: true' to use Jira tools).",
    );
  }
  return new JiraClient(cfg);
}

// ============ Zod input schemas ============

const GetIssueSchema = z.object({
  key: z.string().min(1).describe("Jira issue key (e.g. PROJ-123)"),
});

const SearchSchema = z.object({
  jql: z
    .string()
    .min(1)
    .describe("JQL query string (e.g. 'project = PROJ AND status = Open')"),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum results to return (default 50)"),
  fields: z
    .array(z.string())
    .optional()
    .describe("Specific fields to return (e.g. ['summary','status'])"),
});

const CreateIssueSchema = z.object({
  project_key: z.string().min(1).describe("Project key (e.g. 'PROJ')"),
  issue_type: z
    .string()
    .min(1)
    .describe("Issue type name (e.g. 'Task', 'Bug', 'Story')"),
  summary: z.string().min(1).describe("Issue summary/title"),
  description: z
    .string()
    .optional()
    .describe("Issue description (plain text or wiki markup)"),
});

const AddCommentSchema = z.object({
  issue_key: z.string().min(1).describe("Jira issue key (e.g. PROJ-123)"),
  body: z.string().min(1).describe("Comment text body"),
});

// ============ Tool result type ============

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[] };

// ============ Tool definitions ============

export interface JiraMcpTool<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (args: z.infer<S>) => Promise<ToolResult>;
}

// Use a union type so the array can hold tools with different schemas
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJiraMcpTool = JiraMcpTool<any>;

export const jiraTools: AnyJiraMcpTool[] = [
  {
    name: "jira_get_issue",
    description:
      "Get a Jira issue by key (e.g. PROJ-123). Returns issue details including summary, description, status, and type.",
    inputSchema: GetIssueSchema,
    async handler(args: z.infer<typeof GetIssueSchema>): Promise<ToolResult> {
      const client = getJiraClient();
      const issue = await client.getIssue(args.key);
      return {
        content: [{ type: "text", text: JSON.stringify(issue, null, 2) }],
      };
    },
  },

  {
    name: "jira_search",
    description:
      "Search Jira issues using JQL (Jira Query Language). Returns matching issues.",
    inputSchema: SearchSchema,
    async handler(args: z.infer<typeof SearchSchema>): Promise<ToolResult> {
      const client = getJiraClient();
      const result = await client.search(args.jql, {
        maxResults: args.max_results,
        fields: args.fields,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  },

  {
    name: "jira_create_issue",
    description:
      "Create a new Jira issue in the specified project with a given summary, type, and optional description.",
    inputSchema: CreateIssueSchema,
    async handler(
      args: z.infer<typeof CreateIssueSchema>,
    ): Promise<ToolResult> {
      const client = getJiraClient();
      const issue = await client.createIssue({
        project_key: args.project_key,
        issue_type: args.issue_type,
        summary: args.summary,
        description: args.description,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(issue, null, 2) }],
      };
    },
  },

  {
    name: "jira_add_comment",
    description: "Add a comment to an existing Jira issue.",
    inputSchema: AddCommentSchema,
    async handler(
      args: z.infer<typeof AddCommentSchema>,
    ): Promise<ToolResult> {
      const client = getJiraClient();
      const comment = await client.addComment(args.issue_key, args.body);
      return {
        content: [{ type: "text", text: JSON.stringify(comment, null, 2) }],
      };
    },
  },
];
