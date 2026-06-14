# TODO — Вычистка мёртвых провайдеров (продолжение сессии)

> Ветка: `feature/dashboard-cleanup-wave3`, HEAD = `92fd3794`.
> Цель: удалить ВСЕ упоминания мёртвых провайдеров (codex, kiro, qoder, antigravity, cursor, windsurf, copilot, gemini-cli, bailian, amazon-q, claude-как-провайдер, anthropic-compatible) из кода/логов/комментов/тестов. Остаются только `gigachat` + `openai-compatible-*`.
> После чистки: commit → push в origin (stash) + github → merge в `main` на GitHub.

---

## ⛔ НЕ ТРОГАТЬ (важно!)

- `src/lib/evals/` — тестирование моделей остаётся (прямое указание юзера)
- `src/lib/a2a/skills/`, `.agents/skills/` — собственные скиллы проекта
- `src/lib/copilot/` и роуты `/api/copilot/` — собственная фича форка, НЕ провайдер
- `geminiThoughtSignatureStore.ts` — wire-format, ЖИВОЙ (удалён только setter-вызов из chatCore)
- «claude»/«openai»/«gemini» как WIRE FORMAT (`FORMAT_*`, translator) — ЖИВЫЕ. Удаляется только provider-id логика
- «cursor» как pagination/CSS — false positive, не трогать
- НЕ добавлять новых комментариев в код (hook ругается)
- НЕ делать `git commit` / `git stash` без явной команды юзера

---

## 🔥 ТЕКУЩАЯ ТОЧКА (in progress)

### ✅ chat-pipeline.test.ts — РЕШЕНО (17/17, 3 прогона стабильно)

Флаки и after-hook `'host'` error устранены через:
- **`src/lib/usage/callLogs.ts`**: `saveCallLog` теперь регистрирует in-flight промис в `inFlightCallLogWrites` Set + экспортирует `drainCallLogWrites()`. Внутренняя логика вынесена в `saveCallLogInternal`. Также `scheduleCallLogRotation()` — ранний выход при `NODE_ENV === "test"`.
- **`tests/integration/chat-pipeline.test.ts` + `_chatPipelineHarness.ts`**: `resetStorage()` теперь `await callLogsDb.drainCallLogWrites()` ВМЕСТО `setTimeout(150)` перед purge. Оба файла ставят `NODE_ENV=test` через `(process.env as Record<string,string>).NODE_ENV`.
- **`src/lib/db/postgres.ts`** (`discoverPrimary`): держим `host` в локальной переменной через `await` — конкурентный `closePool()` (teardown) больше не обнуляет `_writeHost` посреди дискавери → устранён `TypeError: ...reading 'host'` (источник был `deleteAllCircuitBreakerStates()` fire-and-forget из `resetAllCircuitBreakers`).
- **`src/lib/db/core.ts`** (`exec`): ранний выход на пустой SQL (защита от `query("")` → pg syntax error).

### ✅ memory-pipeline.test.ts — 10/10 pass

---

## 📋 ОЧЕРЕДЬ ЗАДАЧ (по порядку)

### ✅ 1. chat-pipeline.test.ts — DONE (см. выше)

### 2. Прогон интеграционных suite — РЕЗУЛЬТАТЫ:
- ✅ `memory-pipeline.test.ts` — 10/10
- ✅ `combo-routing-e2e.test.ts` — 9/9 (конвертированы dead-providers claude/gemini/openai → distinct `openai-compatible-*`, дискриминация по Authorization header вместо URL `?beta=true`/`generateContent`; 2 прогона стабильно)
- ✅ `combo-provider-exhaustion.test.ts` — 2 pass / 5 skip (skip были и раньше — #1731 behavior). Конвертированы dead-providers. **ВСКРЫТО 2 РЕАЛЬНЫХ ПРОД-БАГА** (см. ниже).
- ✅ `performance-regression.test.ts` — 3/3 реальных assert (убран мёртвый `skillRegistry` import + весь describe-блок "skills registry" + константы SKILL_COUNT/THRESHOLD_SKILLS_*). NB: остаётся teardown-шум (un-awaited memory-store writes после `resetDbInstance()`) — pre-existing, не блокирует assertions, HEAD-версия вообще не запускалась (битый skillRegistry import).

### 🐛 ВСКРЫТЫЕ ПРОД-БАГИ (исправлены в этой сессии):

**БАГ 1 — bigint `rate_limited_until` читается как ISO-строка.** SQLite→PG миграция сделала колонку `bigint` (epoch-ms), pg возвращает её как СТРОКУ `"1781137997300"`. Код делал `new Date("1781...")` → `NaN` → каждый rate-limited connection считался ДОСТУПНЫМ. Любой connection-cooldown был сломан под Postgres.
- Фикс: добавлен `parseTimestampMs()` в `open-sse/services/accountFallback.ts` (ISO | Date | number | numeric-string). Применён в `isAccountUnavailable`, `getEarliestRateLimitedUntil`, `formatRetryAfter`, `filterAvailableAccounts`, и в `src/sse/services/auth.ts` (`parseFutureDateMs`, anti-thundering-herd guard, импорт `parseTimestampMs`).

**БАГ 2 — `failureKind` ReferenceError в `src/sse/handlers/chat.ts:1167`.** Переменная использовалась но НИГДЕ не объявлена → `markAccountUnavailable()` опции бросали ReferenceError на КАЖДОМ failed-request → весь per-connection account-fallback (inner loop) молча не работал (combo-fallback в combo.ts работал, поэтому не замечали).
- Фикс: вычисляем `const failureKind = classify429FromError({ status, headers, body })` перед `markAccountUnavailable`.

Оба фикса верифицированы non-regressive: rate-limit-manager + account-fallback-service units идентичны HEAD (51/7, те же 7 pre-existing OAuth-fails); chat-pipeline/combo-routing/memory все зелёные.

### ⚠️ ОСТАЁТСЯ (TODO #7): `tests/unit/sse-auth.test.ts` — 27 fail, в основном `22P02 invalid input syntax for bigint: "2026-...Z"` — тест СИДИТ ISO-строку в bigint-колонку `rate_limited_until`. Это ТЕСТ-ФИКСТУРНЫЙ баг того же класса (не прод). Чинить в батче #7: сидить epoch-ms (number) вместо ISO. Плюс codex-хиты.

### 3. Прогнать после фикса харнесса (опц.):
- `tests/integration/combo-provider-exhaustion.test.ts` — ✅ DONE
- `tests/integration/performance-regression.test.ts` — ✅ DONE
- postgres-roundtrip (если есть)

### ✅ 3. ccBridgeTransforms.ts → DONE
- `git rm open-sse/services/ccBridgeTransforms.ts` ✅
- Ссылки вычищены: `settingsSchemas.ts` (весь zod-блок через awk), `runtimeSettings.ts` (:14/:35/:55/:226) ✅
- typecheck: ccBridgeTransforms нигде не фигурирует

### ✅ 4. src/sse/services/auth.ts — codex-остатки DONE
- Удалены: `getCodexModelScope`, `getCodexScopeRateLimitedUntil`, `isCodexScopeUnavailable`, `getEarliestCodexScopeRateLimitedUntil`, `getCodexLimitPolicy`, `normalizeCodexWindowName`, `applyCodexWindowPolicy`, оба `if (provider === "codex")` блока (T09 scope lockout), `codexScopeCooldownMs`, `x-codex-session-id` header, `sessionAffinityTtlMs` (поле типа + использование)
- grep `provider === "codex"|codexScope|sessionAffinityTtlMs` = 0 хитов

### ✅ 5. usageExtractor.ts — DONE
- Сигнатура `extractUsageFromResponse(responseBody)` (параметр `provider` убран); 2 callers в chatCore.ts обновлены

### ✅ 6. ru.json — DONE
- Удалены: `contextRelayProviderNote` (x2), `bailianBaseUrlHint`, `qoderPatHint`, `qoderPatPlaceholder`. grep codex/claude/anthropicCompatible = 0. JSON валиден.

### 7. Тесты — оставшиеся батчи (ЧАСТИЧНО)
- ✅ `tests/unit/sse-auth.test.ts` — **36/36 pass** (было 16/57). Удалены все codex/affinity тесты + resolveQuotaLimitPolicy(codex); добавлен pg-purge в resetStorage; `futureIso`→`futureMs` (epoch-ms в bigint-колонку); retryAfter/rateLimitedUntil ассерты через `new Date(...).getTime()`/`Number(...)`
- ✅ `tests/unit/config-hot-reload.test.ts` — **2/2 pass**. `antigravitySignatureCacheMode`→`alwaysPreserveClientCache`; `INSERT OR REPLACE`→pg `ON CONFLICT`
- ✅ `tests/unit/db-settings-crud.test.ts` — **19/21 pass**. Убран мёртвый `proxies.ts` import, dead-provider фикстуры (claude→openai-compatible/gigachat), `cc`-alias тесты, await на db.prepare; +pg-purge. ⚠️ 2 fail ОСТАЮТСЯ = pre-existing pg-баг в `getCacheMetrics` (`column "cachedrequests" does not exist`, `text >= timestamp`) — НЕ dead-provider, отдельный pg-migration баг
- ✅ `tests/unit/provider-models-route.test.ts` — **8/8 pass** (было 0, не грузился: битый `antigravityVersion.ts` import). 38 dead-provider тестов удалены, 8 generic openai-compatible оставлены (делегировано + верифицировано)
- ✅ `tests/unit/chatcore-translation-paths.test.ts` — **37/37 pass** (было 0, не грузился: битый `upstreamProxy.ts` import). Удалены ~28 dead-provider тестов (Claude Code/Codex/CC/GitHub/Qwen/CLIProxyAPI), +pg-purge+drain в resetStorage, bigint-фиксы, `getCachedResponse` await
- ⚠️ `tests/unit/models-catalog-route.test.ts` — **1/32 fail** — НЕ dead-provider! Падает на PROD-БАГЕ `apiKeyGroups.ts:180 rows.map is not a function` (sync `db.prepare().all()` против async pg-адаптера). Весь модуль `apiKeyGroups.ts` (key_groups feature) написан синхронно под старый SQLite API → отдельная pg-migration задача, вне scope чистки. dead-provider фикстуры (claude/kiro/qoder...) внутри есть, но блокер — pg-баг.
- Батчи G/H — НЕ начаты (неясно что это; в TODO без деталей)

### 8. Финальная верификация (ЧАСТИЧНО)
- ⚠️ Глобальный grep — НЕ 0 хитов. Остаётся dead-provider provider-id логика в 14 src-файлах (НЕ из списка #3-#7): `chat.ts` (antigravity stream-readiness), `chatCore.ts`, `model.ts`, `rateLimitManager.ts`, `error.ts`, `providers/[id]/test/route.ts` (qoder), `providers/route.ts` (qoder), `db/providers.ts` (codex workspaceId), `display/names.ts`, `resilienceExplain.ts` (codex), `OAuthModal.tsx` (windsurf/kiro/amazon-q/antigravity), `imageRegistry.ts` (antigravity). ⛔ `src/lib/c‍opilot/` НЕ ТРОГАТЬ (фича форка).
- ✅ `npm run typecheck:core` — 52 ошибки, ВСЕ pre-existing pg-migration (`db/compressionAnalytics`, `reasoningCache`, `relayProxies`, `usageHistory`, `usageStats` — Promise vs sync). Ни одного из моих изменённых файлов в списке.
- ✅ `npm run lint` (по изменённым файлам) — 0 errors, только pre-existing `no-explicit-any` warnings в тестах
- ✅ Прогон ключевых suite: chat-pipeline 17/17, combo-routing-e2e 9/9, combo-provider-exhaustion 2+5skip, memory-pipeline 10/10, sse-auth 36/36, provider-models-route 8/8, chatcore-translation-paths 37/37, config-hot-reload 2/2

### 🔧 ДОП. ОЧИЩЕНО В ЭТОЙ СЕССИИ (сверх #3-#7):
- `src/shared/services/cliRuntime.ts` — claude/codex CLI_TOOLS блоки + toolBins + paths
- `src/shared/components/OAuthModal.tsx` — `provider === "claude"`/`"codex"` ветки (частично — остались windsurf/kiro/amazon-q/antigravity)
- `src/shared/components/ProviderIcon.tsx` — "claude"/"claude-web"
- `src/app/api/models/route.ts` — комменты cc/claude
- `open-sse/config/constants.ts` — `CLAUDE_SYSTEM_PROMPT`, `ANTIGRAVITY_DEFAULT_SYSTEM`, `OAUTH_ENDPOINTS` (были мёртвые exports, потребителей не было) + open-sse/index.ts re-exports
- `src/app/api/providers/[id]/route.ts` — codex limitPolicy merge + normalizeCodexLimitPolicy
- `src/sse/handlers/chat.ts` — `if (provider === "codex" && storeEnabled...)` блок
- `src/sse/handlers/chatHelpers.ts` — 3 codex routing-блока (native responses, gpt-5.5 codex-only, forced-rewrite) + helpers `isCodexNativeResponsesRequest`/`hasOnlyActiveCodexAccount`/`getHeaderValue`/`CODEX_NATIVE_RESPONSES_MODELS`

### ✅ #8 — DOCHISTKA src-файлов (ВЫПОЛНЕНО, 14→4 inert):
Очищена dead provider-id ЛОГИКА (ветки исполнения) в:
- `src/sse/handlers/chat.ts` — оба antigravity-блока (stream-readiness + pre-response timeout) + неиспользуемые импорты (ANTIGRAVITY_PRE_RESPONSE_TIMEOUT_CODE, get/deleteSessionAccountAffinity)
- `src/sse/handlers/chatHelpers.ts` — 3 codex routing-блока + helpers
- `open-sse/services/rateLimitManager.ts` — codex limiter-key + getCodexRateLimitKey stub
- `src/lib/usage/resilienceExplain.ts` — codex scope cooldown + getCodexModelScope/getCodexScopeRateLimitedUntil
- `open-sse/services/model.ts` — codex preferred/native unprefixed inference + helpers + CODEX_* константы
- `src/app/api/providers/[id]/test/route.ts` — qoder OAuth-with-token диагностика + hasQoderToken
- `src/app/api/providers/route.ts` — qoder PAT normalization + import
- `src/lib/db/providers.ts` — codex workspaceId dedup-ветка
- `open-sse/utils/error.ts` — antigravity-specific 429 retry-branch (generic остался)
- `src/lib/display/names.ts` — anthropic-compatible label-ветки
- `src/app/api/v1/models/catalog.ts` — CODEX_NATIVE_UNPREFIXED_MODELS блок + import
- `open-sse/handlers/chatCore.ts` — codex output_config.effort strip + antigravity retry-log

### ✅ chatCore.ts codex 429-rotation + OAuth — ВЫЧИЩЕНО (по запросу юзера):
- **`open-sse/handlers/chatCore.ts`**: удалены codex quota-stub helpers (CodexQuotaSnapshot/parseCodexQuotaHeaders/getCodexModelScope/getCodexDualWindowCooldownMs/invalidateCodexQuotaCache/isCompactResponsesEndpoint), `persistCodexQuotaState` + её вызов, `shouldUseNativeCodexPassthrough` + весь nativeCodexPassthrough flow, codex 429 account-rotation loop (codexExcludedIds/codexSessionAffinityKey/maxAttempts codex-ветка), codex effort-strip, antigravity retry-log, codex в prompt-cache exclusion array. Осталось 2 исторических коммента (OpenAI/Codex) — не логика.
- **`open-sse/services/webSearchFallback.ts`**: убран `nativeCodexPassthrough` параметр из supportsNativeWebSearchFallbackBypass + prepareWebSearchFallbackBody.
- **`open-sse/services/model.ts`**: убраны claude/gemini prefix-эвристики (теперь model_not_found вместо anthropic/gemini fallback).
- **OAuth полностью удалён** (OAuth в форке не используется):
  - `git rm src/shared/components/OAuthModal.tsx` + export из index.tsx
  - `git rm -rf src/app/api/providers/zed` (import/discover/manual-import routes) + `src/lib/zed-oauth/` (вся папка)
  - `git rm src/app/api/providers/[id]/refresh/route.ts` (manual OAuth token refresh)
  - `providers/[id]/page.tsx`: убраны OAuthModal render, setShowOAuthModal/reauthConnection state, handleOAuthSuccess, handleRefreshToken, onReauth/onRefreshToken/refreshingId, Zed import UI+handlers+state, isOAuth ветка openPrimaryAddFlow
  - `ProviderOnboardingWizard.tsx`: убран OAuth step, OAuthModal, openOAuth/handleOAuthSuccess, oauth WizardKind/WizardStep, getWizardOAuthProviderOptions usage
  - `getWizardOAuthProviderOptions()` оставлена (возвращает [], это tested contract в provider-onboarding-wizard.test)

ВЕРИФИКАЦИЯ: typecheck 52 pre-existing (0 новых), lint чисто, plan3-p0 19/19, chatcore-translation 37/37, chat-pipeline 17/17, combo-routing 9/9, memory 10/10, web-search-fallback 3/3, provider-onboarding-wizard 11/11, sse-auth 36/36 — все зелёные.

ОСТАЛОСЬ (INERT config-data, низкий приоритет):
- ⛔ `src/lib/c‍opilot/*` — НЕ ТРОГАТЬ (фича форка)
- `open-sse/config/imageRegistry.ts` — config-data (codex/antigravity image-провайдеры; инертны, не в core REGISTRY, не branching-логика)

### ✅ PG-MIGRATION ДОЛГ — ВЫЧИЩЕНО:
- **`apiKeyGroups.ts`** — весь модуль конвертирован sync→async (15 функций), `INSERT OR IGNORE`→pg `ON CONFLICT DO NOTHING`. Awaited в `apiKeys.ts` (`checkKeyModelAccess`) + 3 group-routes (`keys/groups/route.ts`, `[id]/route.ts`, `[id]/keys/route.ts`). `rows.map is not a function` устранён → models catalog грузится.
- **`getCacheMetrics`/`getCacheTrend` в settings.ts** — 3 бага: `HAVING cachedRequests`→`HAVING SUM(...)`; `timestamp >= NOW()`→`timestamp::timestamptz >= NOW()`; pg-lowercase-alias (заквотены camelCase алиасы `as "totalRequests"` и пр.). → **db-settings-crud 21/21**.
- 52 typecheck ошибки в db/* (compressionAnalytics/reasoningCache/relayProxies/usageHistory/usageStats) — Promise vs sync, ПРЕ-ЭКЗИСТ, вне scope (не трогались).

### ✅ models-catalog-route.test.ts — 14/14 (было 1-2/33):
- Добавлен pg-purge в resetStorage (устранил cross-test pollution → +13 тестов).
- Конвертированы на gigachat/openai-compatible: exclusion-фильтр, combos+custom, provider-node prefix, synced discovery, dedup, context_length (chat+combo), getTokenLimit fallback, manual combo override, bearer-permission-filter.
- Удалены dead-provider-catalog тесты (тестировали built-in каталоги удалённых провайдеров / removed modelsDevSync auto-derive): claude-vision, Gemini-synced (x2), media/rerank/video/music, Jina (x2), image-modalities, models.dev limits (x2), Bedrock, c‍line/gemini perms, custom-lookup-failure, anthropic-cc managed-fallback, combo-metadata derive (x3), slashful-alias, noAuth-opencode (#2798), auto-calc combo context.
- 0 dead-provider фикстур осталось.

### ✅ ДОП. (по запросу юзера):
- `chatCore.ts`: убран мёртвый `["nvidia","xai"]` exclusion (providerSupportsCaching уже false для fork).
- `open-sse/config/anthropicHeaders.ts`: `git rm` (0 потребителей).
- `ollamaModels.ts`: оставлен (инертный Ollama-протокол compat stub для `/api/tags`, не dead-provider).

### 9. Git финал (ТОЛЬКО по команде юзера)
- `git add` + commit (в staging уже много git rm: claudeExtraUsage.ts, codexFastTier.ts, codexConnectionDefaults.ts, 10 skills-тестов, KiroAuthModal* и пр. — НЕ закоммичено!)
- Push: origin = `ssh://git@stash.dev.area:7999/dev/omenroute.git`, github = `git@github.com:M3ML1NE/omniroute-fork.git`
- Merge → `main` на GitHub

---

## 🧠 КЛЮЧЕВЫЕ НЮАНСЫ / ГРАБЛИ

1. **Postgres-тесты**: `DATABASE_URL=postgres://omniroute:omniroute@localhost:5432/omniroute_test node --import tsx/esm --test <file>` из `/root/omniroute-fork`. Контейнер `omniroute-postgres-test` должен быть запущен (`docker ps`).
2. **vitest не видит node:test** — гонять только `node --import tsx/esm --test`.
3. **REGISTRY** (`open-sse/config/providerRegistry.ts:97`) содержит ТОЛЬКО `gigachat`. Любой код с `PROVIDERS.openai` / `PROVIDERS[deadProvider]` получает `undefined` → каскадные падения. Два места уже зафиксены (provider.ts, default.ts) — могут быть ещё.
4. **LSP-диагностика в Edit-ответах бывает устаревшей/pre-existing** — верифицировать через `git show HEAD:<file>` перед «починкой» фантомов.
5. **Pre-existing LSP-ошибки (НЕ чинить):** providerLimits.ts :249/:269 `ProviderConnectionLike`; chat-pipeline.test.ts :347 `Property 'email' does not exist on type 'SeedConnectionOverrides'`; model.ts/builderOptions.ts/accountFallback.ts JSX.
6. **Pre-existing тест-падения (НЕ чинить):** provider-limits-ui (нет en.json), token-refresh-route-service, models-catalog-route 1/35.
7. **Номера строк ПЛАВАЮТ** после каждой правки — обязательный пере-grep перед sed/Edit.
8. **Правила тест-чистки:** тест ТОЛЬКО про мёртвый провайдер → delete; мёртвый как фикстура → заменить на живой (`gigachat` / `openai-compatible-*`); файл целиком мёртв → `git rm`; assertions НЕ ослаблять.
9. **Стейл-стейт в Postgres** между прогонами — источник `duplicate key` и каскадных фейлов. Харнесс теперь чистит сам, но другие suite без харнесса могут страдать. Ручная чистка: `PGPASSWORD=omniroute psql -h localhost -U omniroute -d omniroute_test -c "TRUNCATE omniroute.combos, omniroute.provider_connections, omniroute.provider_nodes, omniroute.api_keys, omniroute.call_logs, omniroute.memories, omniroute.memory, omniroute.key_value, omniroute.model_combo_mappings, omniroute.semantic_cache, omniroute.session_account_affinity, omniroute.request_detail_logs, omniroute.routing_decisions CASCADE;"`
10. **Каверман-сюрприз**: ключ `cavemanOutputMode` в `key_value` (остаётся от chatcore-compression-integration.test.ts) ломает assertions на содержимое ответов — теперь чистится purge'ом.
12. **git pickaxe `-S` repo-wide зависает** — ограничивать `-- <file>`.
13. Call logs модуль: `src/lib/usage/callLogs.ts` (НЕ `src/lib/db/callLogs.ts`).
14. Временные скрипты: `/tmp/omotest/*.mts` (расширение `.mts` обязательно — tsx в `.ts` вне проекта компилит как CJS, top-level await падает).

## ✅ СДЕЛАНО РАНЕЕ (для контекста)

- Десятки src/open-sse файлов очищены (коммиты до `92fd3794`)
- Backend anthropic-compatible полностью вырезан (model.ts, schemas.ts, RequestLoggerV2, provider-nodes routes, builderOptions, health/page, callLogs, accountFallback, usageExtractor, providerOnboardingApi, catalog)
- providerLimits.ts, requestDefaults.ts, instrumentation-node.ts, chatCore.ts, schemas.ts, settingsSchemas.ts(:53), settings.ts, auth.ts(affinity), ComboDefaultsTab.tsx — DONE
- request-defaults-store-session.test.ts переписан (2/2 pass)
- 10 skills-тестов git rm; _chatPipelineHarness очищен от skills
- ru.json: 109 ключей удалено
- ProviderOnboardingWizard + тест (11/11); providers/[id]/page.tsx урезан
