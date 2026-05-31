/**
 * Confluence MCP tool definitions (4 tools).
 * Tools are plain objects: { name, description, inputSchema, handler }.
 * MCP server registration happens in T13.
 */

import { z } from "zod";
import { ConfluenceClient } from "../../../services/atlassian/confluenceClient.js";
import { getAtlassianConfig } from "../../../services/atlassianConfig.js";

// ============ Lazy client resolver ============

/**
 * Resolve ConfluenceClient at tool-call time (not registration time).
 * Throws a clear error if Confluence is not configured or disabled.
 */
function getConfluenceClient(): ConfluenceClient {
  const cfg = getAtlassianConfig().get("confluence");
  if (!cfg) {
    throw new Error(
      "Confluence service not configured. Set ~/.omniroute/atlassian.json 'confluence' section.",
    );
  }
  if (!cfg.enabled) {
    throw new Error(
      "Confluence service is disabled in config (set 'enabled: true' to use Confluence tools).",
    );
  }
  return new ConfluenceClient(cfg);
}

// ============ Zod input schemas ============

const GetPageSchema = z.object({
  page_id: z.string().min(1).describe("Confluence page numeric ID"),
  expand: z
    .array(z.string())
    .optional()
    .describe("Fields to expand (e.g. ['body.storage','version','space'])"),
});

const SearchSchema = z.object({
  cql: z
    .string()
    .min(1)
    .describe(
      "Confluence Query Language (CQL) query (e.g. 'space = \"DEV\" AND type = \"page\"')",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max results (default 25)"),
});

const CreatePageSchema = z.object({
  space_key: z.string().min(1).describe("Confluence space key (e.g. 'DEV')"),
  title: z.string().min(1).describe("Page title"),
  body: z.string().describe("Page body in Confluence storage format (HTML)"),
  parent_id: z
    .string()
    .optional()
    .describe("Optional parent page ID for hierarchy"),
});

const UpdatePageSchema = z.object({
  page_id: z.string().min(1).describe("ID of the page to update"),
  title: z.string().min(1).describe("New page title"),
  body: z.string().describe("New body in Confluence storage format (HTML)"),
});

// ============ Tool result type ============

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[] };

// ============ Tool definitions ============

export interface ConfluenceMcpTool<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (args: z.infer<S>) => Promise<ToolResult>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyConfluenceMcpTool = ConfluenceMcpTool<any>;

export const confluenceTools: AnyConfluenceMcpTool[] = [
  {
    name: "confluence_get_page",
    description:
      "Get a Confluence page by ID. Returns title, body, version, and space.",
    inputSchema: GetPageSchema,
    async handler(args: z.infer<typeof GetPageSchema>): Promise<ToolResult> {
      const client = getConfluenceClient();
      const page = await client.getPage(args.page_id, { expand: args.expand });
      return {
        content: [{ type: "text", text: JSON.stringify(page, null, 2) }],
      };
    },
  },

  {
    name: "confluence_search",
    description:
      "Search Confluence content using CQL (Confluence Query Language).",
    inputSchema: SearchSchema,
    async handler(args: z.infer<typeof SearchSchema>): Promise<ToolResult> {
      const client = getConfluenceClient();
      const result = await client.search(args.cql, { limit: args.limit });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  },

  {
    name: "confluence_create_page",
    description: "Create a new Confluence page in the specified space.",
    inputSchema: CreatePageSchema,
    async handler(
      args: z.infer<typeof CreatePageSchema>,
    ): Promise<ToolResult> {
      const client = getConfluenceClient();
      const page = await client.createPage({
        space_key: args.space_key,
        title: args.title,
        body: args.body,
        parent_id: args.parent_id,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(page, null, 2) }],
      };
    },
  },

  {
    name: "confluence_update_page",
    description:
      "Update an existing Confluence page (version is auto-incremented).",
    inputSchema: UpdatePageSchema,
    async handler(
      args: z.infer<typeof UpdatePageSchema>,
    ): Promise<ToolResult> {
      const client = getConfluenceClient();
      const page = await client.updatePage(args.page_id, {
        title: args.title,
        body: args.body,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(page, null, 2) }],
      };
    },
  },
];
