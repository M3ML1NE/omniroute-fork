/**
 * OpenAI-compatible HTTP endpoints KEEP list.
 * All other /v1/* endpoints removed (return 404).
 */
export const KEEP_ENDPOINTS = [
  "GET /v1/models",
  "POST /v1/chat/completions",
  "POST /v1/embeddings",
  "POST /v1/completions",
  "POST /v1/audio/speech",
  "POST /v1/audio/transcriptions",
  "POST /v1/images/generations",
  "POST /v1/images/edits",
  "POST /v1/moderations",
] as const;

/**
 * Endpoints DELETE list - return 404 after removal.
 * Includes Anthropic Messages API and other non-OpenAI-compatible endpoints.
 */
export const DELETE_ENDPOINTS = [
  "POST /v1/messages",
  "POST /v1/files",
  "GET /v1/files",
  "GET /v1/files/[id]",
  "GET /v1/files/[id]/content",
  "DELETE /v1/files/[id]",
  "POST /v1/batches",
  "GET /v1/batches",
  "GET /v1/batches/[id]",
  "POST /v1/batches/[id]/cancel",
  "POST /v1/batches/delete-completed",
  "POST /v1/responses",
  "GET /v1/responses",
  "GET /v1/responses/[...path]",
  "POST /v1/music/generations",
  "POST /v1/videos/generations",
  "POST /v1/rerank",
  "POST /v1/search",
  "GET /v1/search/analytics",
  "POST /v1/web/fetch",
  "GET /v1/ws",
  "POST /v1/api/chat",
  "POST /v1/chatgpt-web/image/[id]",
  "POST /v1/relay/chat/completions",
  "POST /v1/providers/[provider]/chat/completions",
  "POST /v1/providers/[provider]/embeddings",
  "POST /v1/providers/[provider]/images/generations",
  "GET /v1/providers/[provider]/models",
  "GET /v1/providers/[provider]/limits",
  "POST /v1/combos",
  "POST /v1/agents/health",
  "POST /v1/agents/credentials",
  "POST /v1/agents/tasks",
  "GET /v1/agents/tasks/[id]",
  "POST /v1/management/proxies",
  "GET /v1/management/proxies",
  "POST /v1/management/proxies/assignments",
  "POST /v1/management/proxies/bulk-assign",
  "GET /v1/management/proxies/health",
  "POST /v1/registered-keys",
  "GET /v1/registered-keys",
  "GET /v1/registered-keys/[id]",
  "DELETE /v1/registered-keys/[id]",
  "POST /v1/registered-keys/[id]/revoke",
  "GET /v1/quotas/check",
  "GET /v1/me/status",
  "GET /v1/accounts/[id]/limits",
  "POST /v1/issues/report",
] as const;

export type KeepEndpoint = (typeof KEEP_ENDPOINTS)[number];
export type DeleteEndpoint = (typeof DELETE_ENDPOINTS)[number];

/**
 * Returns disposition given HTTP method and path combination.
 */
export function getEndpointStatus(
  method: string,
  path: string
): "KEEP" | "DELETE" | "UNKNOWN" {
  const key = `${method.toUpperCase()} ${path}`;

  if ((KEEP_ENDPOINTS as readonly string[]).includes(key)) {
    return "KEEP";
  }

  if ((DELETE_ENDPOINTS as readonly string[]).includes(key)) {
    return "DELETE";
  }

  return "UNKNOWN";
}
