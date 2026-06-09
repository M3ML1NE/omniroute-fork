/**
 * Usage Fetcher - Get usage data from provider APIs.
 *
 * The GigaChat fork registers only `gigachat` + `openai-compatible`, neither of
 * which exposes a provider-specific usage/quota endpoint, so this dispatcher
 * returns the not-implemented message for every connection. The per-provider
 * usage fetchers (github/gemini-cli/claude/codex/cursor/kiro/qwen/qoder/glm/
 * minimax/crof/deepseek/opencode/…) were removed with their providers.
 */

export const USAGE_FETCHER_PROVIDERS = [] as const;

export type UsageFetcherProvider = (typeof USAGE_FETCHER_PROVIDERS)[number];

type UsageProviderConnection = {
  provider?: string;
  [key: string]: unknown;
};

export async function getUsageForProvider(
  connection: UsageProviderConnection,
  _options: { forceRefresh?: boolean } = {}
): Promise<{ message: string }> {
  return { message: `Usage API not implemented for ${connection.provider}` };
}
