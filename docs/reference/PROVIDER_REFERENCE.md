---
title: "Provider Reference"
version: 3.8.7
lastUpdated: 2026-06-05
---

# Provider Reference

> **Auto-generated** from `src/shared/constants/providers.ts` — do not edit by hand.
> Regenerate with: `npm run gen:provider-reference`
> **Last generated:** 2026-06-05

Total providers: **1**. See category breakdown below.

## Categories

- **Free** — free tier with API key (configured via dashboard)
- **OAuth** — sign-in flow handled by OmniRoute, no API key needed
- **Web cookie** — wraps the provider's web app via cookie auth
- **API key** — paid provider configured via API key (free credits may apply)
- **Local** — runs on the user's machine (Ollama, LM Studio, vLLM, etc.)
- **Search** — web search providers
- **Audio** — audio-only providers (TTS/STT)
- **Upstream proxy** — providers that proxy to other providers
- **Cloud agent** — long-running coding agents (Codex Cloud, Devin, Jules)
- **System** — OmniRoute-internal providers (loopback, etc.)

Additional tags: `image`, `video`, `aggregator`, `enterprise`, `embed/rerank`, `self-hosted`.

Use the dashboard at `/dashboard/providers` to enable, configure, and test each provider.

---



## API Key Providers (paid / paid-with-free-credits) (1)

| ID | Alias | Name | Tags | Website | Notes |
|----|-------|------|------|---------|-------|
| `gigachat` | `gigachat` | GigaChat (Sber) | API key | [link](https://developers.sber.ru) | — |







## Sources of truth

- Catalog: [`src/shared/constants/providers.ts`](../../src/shared/constants/providers.ts)
- Registry (per-model details): [`open-sse/config/providerRegistry.ts`](../../open-sse/config/providerRegistry.ts)
- Executors: [`open-sse/executors/`](../../open-sse/executors/) (31 files)
- Translators: [`open-sse/translator/`](../../open-sse/translator/)

## See Also

- [FREE_TIERS.md](./FREE_TIERS.md) — curated free-tier guide
- [USER_GUIDE.md](../guides/USER_GUIDE.md) — provider setup walkthrough
- [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) — overall architecture
