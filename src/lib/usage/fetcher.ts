/**
 * Usage Fetcher - Get usage data from provider APIs
 *
 * The GigaChat fork only registers `gigachat` + `openai-compatible`, neither of
 * which exposes a provider-specific usage endpoint here, so this dispatcher
 * returns the not-implemented message for every connection. The per-provider
 * fetchers for the removed providers were deleted with their providers.
 */

export async function getUsageForProvider(connection) {
  const { provider } = connection;
  return { message: `Usage API not implemented for ${provider}` };
}
