export type AtlassianErrorType =
  | "atlassian.unauthorized"
  | "atlassian.forbidden"
  | "atlassian.not_found"
  | "atlassian.validation_error"
  | "atlassian.rate_limited"
  | "atlassian.server_error"
  | "atlassian.connection_error"
  | "atlassian.unknown_error";

export interface AtlassianMcpError {
  type: AtlassianErrorType;
  message: string;
  status?: number;
  service?: "jira" | "bitbucket" | "confluence";
}

/**
 * Parse HTTP status code embedded in client error messages.
 * Pattern: "Jira GET /path failed (401): message"
 */
function extractStatus(msg: string): number | undefined {
  const m = msg.match(/\((\d{3})\)/);
  return m ? Number(m[1]) : undefined;
}

function detectService(msg: string): "jira" | "bitbucket" | "confluence" | undefined {
  if (msg.startsWith("Jira ")) return "jira";
  if (msg.startsWith("Bitbucket ")) return "bitbucket";
  if (msg.startsWith("Confluence ")) return "confluence";
  return undefined;
}

function statusToType(status: number): AtlassianErrorType {
  if (status === 401) return "atlassian.unauthorized";
  if (status === 403) return "atlassian.forbidden";
  if (status === 404) return "atlassian.not_found";
  if (status === 400 || status === 422) return "atlassian.validation_error";
  if (status === 429) return "atlassian.rate_limited";
  if (status >= 500) return "atlassian.server_error";
  return "atlassian.unknown_error";
}

/**
 * Map any error from Atlassian clients to a structured MCP-compatible error.
 * Handles Error instances, AbortError (timeout), and network errors (ENOTFOUND, ECONNREFUSED).
 */
export function mapAtlassianError(err: unknown): AtlassianMcpError {
  if (err instanceof Error) {
    const msg = err.message;

    // AbortController timeout
    if (err.name === "AbortError" || msg.includes("aborted")) {
      return { type: "atlassian.connection_error", message: "Request timed out" };
    }

    // Node fetch network errors
    if (msg.includes("ENOTFOUND") || msg.includes("ECONNREFUSED") || msg.includes("EAI_AGAIN")) {
      return { type: "atlassian.connection_error", message: msg };
    }

    // TLS errors
    if (msg.includes("CERT") || msg.includes("TLS") || msg.includes("ssl")) {
      return { type: "atlassian.connection_error", message: `TLS error: ${msg}` };
    }

    const status = extractStatus(msg);
    const service = detectService(msg);

    if (status !== undefined) {
      return {
        type: statusToType(status),
        message: msg,
        status,
        ...(service ? { service } : {}),
      };
    }

    return {
      type: "atlassian.unknown_error",
      message: msg,
      ...(service ? { service } : {}),
    };
  }

  return {
    type: "atlassian.unknown_error",
    message: typeof err === "string" ? err : JSON.stringify(err),
  };
}

/**
 * Format an AtlassianMcpError as a JSON string for MCP tool response content.
 */
export function formatAtlassianError(err: AtlassianMcpError): string {
  return JSON.stringify(
    {
      error: {
        type: err.type,
        message: err.message,
        ...(err.status !== undefined ? { status: err.status } : {}),
        ...(err.service ? { service: err.service } : {}),
      },
    },
    null,
    2,
  );
}
