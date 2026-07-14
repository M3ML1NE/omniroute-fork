export const OMNIROUTE_RESPONSE_HEADERS = {
  cache: "X-OmniRoute-Cache",
  compression: "X-OmniRoute-Compression",
  cacheHit: "X-OmniRoute-Cache-Hit",
  latencyMs: "X-OmniRoute-Latency-Ms",
  model: "X-OmniRoute-Model",
  progress: "X-OmniRoute-Progress",
  provider: "X-OmniRoute-Provider",
  responseCost: "X-OmniRoute-Response-Cost",
  tokensIn: "X-OmniRoute-Tokens-In",
  tokensOut: "X-OmniRoute-Tokens-Out",
} as const;
