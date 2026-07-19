# OmniRoute (GigaChat Fork)

Форк [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — OpenAI-совместимый прокси, урезанный до поддержки только GigaChat и openai-compatible провайдеров.

---

## Что осталось

| Эндпоинт / функция          | Статус                          |
| --------------------------- | ------------------------------- |
| `POST /v1/chat/completions` | чат (streaming и non-streaming) |
| `POST /v1/embeddings`       | эмбеддинги                      |
| `GET /v1/models`            | список моделей                  |
| Admin Next.js dashboard     | провайдеры, настройки, комбо    |
| PostgreSQL persistence      | через `DATABASE_URL`            |
| Контекстная компрессия      | lite / caveman / rtk            |
| Per-key mTLS + custom URL   | для GigaChat                    |

---

## Что удалено

- 200+ провайдеров, включая все OAuth/WebCookie-провайдеры (оставлены только `gigachat-compatible` и `openai-compatible`) —
  весь связанный код (иконки, executor'ы, реестры моделей, формат-энумы, статические спецификации моделей) удалён
- **mlproxy / mlspace** (внутренние ML-инфраструктурные прокси-провайдеры) — код, executor'ы
  и все `provider_connections` с этими значениями `provider` удалены безвозвратно
  (деструктивная миграция, см. раздел «Конфигурация mTLS» и CHANGELOG)
- Специфичная логика и эндпоинты Claude/Anthropic (`/v1/messages`)
- Подсистема вебхуков (Webhooks)
- Телеметрия квот и кэш (Quota telemetry & cache)
- Фреймворк навыков (Skills framework)
- Страницы Translator, Playground, Search Tools
- UI системных трансформаций (System Transforms)
- Встроенные алиасы моделей (Built-in model aliases)
- Electron desktop app
- 37 оригинальных MCP инструментов
- 41 локаль (оставлена только `ru`)
- Legacy `/v1/completions` эндпоинт
- Cloud agents (`src/lib/cloudAgent/`, `/api/cloud/*`, Codex/Devin/Jules)
- Cloud sync (`cloudSync`, `/api/sync/cloud`, `/api/sync/initialize`)
- Публикация локального инстанса в интернет через сторонние relay-сервисы и связанные API-эндпоинты — подробности в CHANGELOG
- OAuth-авторизация GigaChat — используется только mTLS + `api_key`

---

## Конфигурация mTLS: провайдеры per-certificate

GigaChat поддерживается **только через mTLS** — OAuth/`authUrl` не существует ни в схеме,
ни в UI, ни в executor'е. Аутентификация — исключительно клиентский сертификат
(cert/key/ca) + опциональный `api_key`.

Каждый provider **node** типа `gigachat-compatible` — это отдельный набор
`(baseUrl, cert_path, key_path, ca_path)`. Одна нода может иметь несколько
provider **connections** (например разные модели/приоритеты), но каждая нода несёт
свой собственный сертификат — **сертификаты не шарятся между нодами**, а `mTLS`-агент
кэширует dispatcher по SHA-256 отпечатку файлов сертификата, так что разные ноды
никогда не переиспользуют чужой TLS-идентити.

Создать GigaChat-compatible ноду можно из admin dashboard (кнопка «Добавить совместимый
с GigaChat» на странице Providers) — форма запрашивает `name`, `prefix`, `baseUrl` и три
пути к файлам сертификата (`cert_path`, `key_path`, `ca_path`). Через API:

```bash
curl -X POST http://localhost:3000/api/provider-nodes \
  -H "Content-Type: application/json" \
  -d '{
    "name": "GigaChat prod",
    "prefix": "gc-prod",
    "type": "gigachat-compatible",
    "baseUrl": "https://gigachat.devices.sberbank.ru/api/v1",
    "mtls": {
      "cert_path": "/path/to/client.crt",
      "key_path": "/path/to/client.key",
      "ca_path": "/path/to/ca-chain.pem"
    }
  }'
```

Сервер отклонит запрос без `mtls`-объекта — сертификат обязателен для этого типа ноды
(`createProviderNodeSchema.superRefine`, `src/shared/validation/schemas.ts`).

Каждая созданная нода получает уникальный id вида `gigachat-compatible-<generated-id>`.
Provider connections, создаваемые под этой нодой через `POST /api/providers`, наследуют
`baseUrl`/`mtls`/`prefix` ноды. Идентификатор провайдера соединения (значение колонки
`provider` в `provider_connections`) — тоже `gigachat-compatible-<id>`, что даёт
**изоляцию по соединению**: каждое соединение получает свой executor-инстанс
(`getExecutor()` кэширует по полной provider-строке), свой кэш обнаруженных моделей
(ключ `providerId:connectionId`) и свой TLS-агент — никаких общих "gigachat"-бакетов
между соединениями с разными сертификатами.

**Бывший (устаревший) bare-идентификатор `gigachat`** (без per-certificate суффикса)
и связанный с ним keystore-файл (`~/.omniroute/keys.json` / `OMNIROUTE_KEYSTORE_PATH`)
**больше не поддерживаются** — они относились к mlproxy-инфраструктуре, которая была
удалена. См. раздел «Миграция существующих соединений» ниже.

---

## Миграция существующих соединений

Если в базе остались строки `provider_connections` с устаревшим bare-значением
`provider = 'gigachat'` (созданные до этого релиза), они переименовываются
**автоматически и один раз** при применении миграций (`npm run db:migrate`):

- Миграция `db/migrations/postgres/0012_purge_mlproxy_providers.sql` необратимо
  удаляет все строки с `provider IN ('mlproxy', 'mlspace')` — эти провайдеры больше
  не существуют, восстановление возможно только из бэкапа.
- Миграция `db/migrations/postgres/0013_migrate_gigachat_to_compatible.sql`
  переименовывает каждую оставшуюся строку `provider = 'gigachat'` в
  `gigachat-compatible-<connection-id>` (детерминированная схема разрешения
  коллизий на случай ручных дублей). Все остальные поля соединения (`api_key`,
  `providerSpecificData` с mTLS-путями, `name`, `priority` и т.д.) сохраняются
  без изменений — переименовывается только идентификатор провайдера.
- Миграция `db/migrations/postgres/0014_purge_named_provider_data.sql`
  безвозвратно удаляет из базы все строки, связанные с провайдерами вне списка
  `gigachat-compatible-*`/`openai-compatible-*`, по таблицам
  `provider_connections`, `provider_nodes` (по колонке `type`), `usage_history`,
  `call_logs`, `request_detail_logs`, `routing_decisions`,
  `combo_adaptation_state`, `registered_keys`, а также связанные строки
  `audit_log` (`resource_type = 'provider_connections'`). Перед удалением
  пишется одна сводная запись в `audit_log`
  (`action = 'migration.purge_named_providers'`) с количеством затронутых
  строк по каждой таблице — для последующего аудита.
- Миграция `db/migrations/postgres/0015_purge_combo_provider_steps.sql`
  вычищает из JSON-поля `combos.data->'models'` шаги комбо (`kind: "model"`),
  чей `providerId` не соответствует `gigachat-compatible-*`/`openai-compatible-*`;
  шаги `kind: "combo-ref"` (ссылки на другие комбо) не затрагиваются. Комбо,
  у которого после фильтрации не остаётся ни одного шага (ни модели, ни
  combo-ref), удаляется целиком.

Все миграции идемпотентны: повторный запуск `db:migrate` не находит подходящих
строк и не выполняет никаких действий (подтверждено тестовыми наборами миграций,
включая явные idempotency-тесты для 0014 и 0015). **Действия 0012, 0014 и 0015
разрушительны** — удаление необратимо без резервной копии базы данных, сделанной
до миграции.

---

## GigaChat `functions_state_id` (raw-JSON extension)

При function-calling GigaChat возвращает в `message` непубличное поле
`functions_state_id` — непрозрачный токен состояния диалога, который нужно
вернуть на следующем ходу, чтобы GigaChat продолжил цепочку вызовов функций
без потери контекста.

OmniRoute пробрасывает это поле «как есть» на пути `POST /v1/chat/completions`
(non-streaming): оно появляется на `choices[].message.functions_state_id` в
ответе и переносится обратно на assistant-сообщение истории в запросе к
GigaChat на следующем ходу.

**Контракт — raw-JSON extension с задокументированной деградацией.**
`functions_state_id` не входит в стандартную схему OpenAI, поэтому строгие
OpenAI SDK (например, Python SDK с Pydantic-валидацией) могут отбросить это
поле при десериализации ответа. Это ожидаемая и допустимая деградация: GigaChat
корректно работает и без `functions_state_id`, просто без сохранения состояния
между ходами. Клиентам, которым нужно сохранение состояния, следует читать
ответ как «сырой» JSON. Поле поддерживается **только** на `chat/completions`;
на пути Responses API оно не пробрасывается.

---

## Запуск

```bash
# Запустить PostgreSQL
npm run db:up

# Применить миграции
DATABASE_URL=postgres://omniroute:omniroute@localhost:5432/omniroute_test npm run db:migrate

# Запустить сервер
npm run dev
```

---

## Тесты

```bash
# Unit тесты
node --import tsx/esm --test tests/unit/**/*.test.ts

# Parity тесты
node --import tsx/esm --test tests/parity/**/*.test.ts
```

---

## Лицензия

Форк [OmniRoute](https://github.com/diegosouzapw/OmniRoute) (MIT). Только для внутреннего использования.

---

### Что доступно

12 MCP-тулов (4 на каждый сервис):

**Jira (REST API v2)**:

- `jira_get_issue` — получить issue по ключу
- `jira_search` — поиск по JQL
- `jira_create_issue` — создать issue
- `jira_add_comment` — добавить комментарий

**Bitbucket Server (REST API v1)**:

- `bitbucket_list_prs` — список pull requests
- `bitbucket_get_pr` — детали PR
- `bitbucket_create_pr` — создать PR
- `bitbucket_add_pr_comment` — добавить комментарий к PR

**Confluence Server (REST API v1)**:

- `confluence_get_page` — получить страницу
- `confluence_search` — поиск по CQL
- `confluence_create_page` — создать страницу
- `confluence_update_page` — обновить страницу (auto-version)

### Конфигурация

Создайте `~/.omniroute/atlassian.json` (или укажите путь через `OMNIROUTE_ATLASSIAN_CONFIG_PATH`):

```json
{
  "version": 1,
  "jira": {
    "enabled": true,
    "base_url": "https://jira.company.local",
    "username": "svc-omniroute",
    "password": "REPLACE_ME"
  },
  "bitbucket": {
    "enabled": true,
    "base_url": "https://bitbucket.company.local",
    "username": "svc-omniroute",
    "password": "REPLACE_ME"
  },
  "confluence": {
    "enabled": true,
    "base_url": "https://confluence.company.local",
    "username": "svc-omniroute",
    "password": "REPLACE_ME"
  }
}
```

**Опционально** — mTLS для каждого сервиса:

```json
{
  "version": 1,
  "jira": {
    "enabled": true,
    "base_url": "https://jira.company.local",
    "username": "svc-omniroute",
    "password": "REPLACE_ME",
    "mtls": {
      "cert_path": "/etc/omniroute/certs/client.crt",
      "key_path": "/etc/omniroute/certs/client.key",
      "ca_path": "/etc/omniroute/certs/ca-chain.pem"
    }
  }
}
```

Каждый сервис настраивается независимо. Установите `"enabled": false` чтобы отключить тулы конкретного сервиса. Конфиг перечитывается **автоматически** при изменении файла (hot-reload через `fs.watch`, debounce 200ms).

### Подготовка service accounts

Создайте отдельные service accounts в каждом сервисе:

1. **Jira DC**: создать пользователя `svc-omniroute` в Jira, выдать необходимые права (browse projects, create issues, add comments и т.д.)
2. **Bitbucket Server**: создать пользователя, выдать read+write права на нужные репозитории
3. **Confluence Server**: создать пользователя, выдать права на пространства (spaces)

### Подключение MCP клиента

OmniRoute предоставляет MCP server через **HTTP SSE transport**.

#### Claude Desktop / Cursor / другие MCP клиенты

В конфиге MCP-клиента укажите:

```json
{
  "mcpServers": {
    "omniroute-atlassian": {
```
