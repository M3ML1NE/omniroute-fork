# OmniRoute (GigaChat Fork)

Форк [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — OpenAI-совместимый прокси, урезанный до поддержки только GigaChat и openai-compatible провайдеров.

---

## Что осталось

| Эндпоинт / функция | Статус |
|---|---|
| `POST /v1/chat/completions` | чат (streaming и non-streaming) |
| `POST /v1/embeddings` | эмбеддинги |
| `GET /v1/models` | список моделей |
| Admin Next.js dashboard | провайдеры, настройки, комбо |
| PostgreSQL persistence | через `DATABASE_URL` |
| Контекстная компрессия | lite / caveman / rtk |
| Per-key mTLS + custom URL | для GigaChat |

---

## Что удалено

- 200+ провайдеров (оставлены только `gigachat` и `openai-compatible`)
- Специфичная логика и эндпоинты Claude/Anthropic (`/v1/messages`)
- Подсистема вебхуков (Webhooks)
- Телеметрия квот и кэш (Quota telemetry & cache)
- Фреймворк навыков (Skills framework)
- Страницы Translator, Playground, Search Tools
- UI системных трансформаций (System Transforms)
- Встроенные алиасы моделей (Built-in model aliases)
- Electron desktop app
- OAuth/WebCookie провайдеры
- 37 оригинальных MCP инструментов
- 41 локаль (оставлена только `ru`)
- Legacy `/v1/completions` эндпоинт

---

## Конфигурация mTLS

Создайте `~/.omniroute/keys.json` (или укажите путь через `OMNIROUTE_KEYSTORE_PATH`):

```json
{
  "version": 1,
  "keys": [
    {
      "id": "my-gigachat-key",
      "api_key": "ваш-gigachat-api-key",
      "provider": "gigachat",
      "baseUrl": "https://gigachat.devices.sberbank.ru/api/v1",
      "authUrl": "https://ngw.devices.sberbank.ru:9443/api/v2/oauth",
      "mtls": {
        "cert_path": "/path/to/client.crt",
        "key_path": "/path/to/client.key",
        "ca_path": "/path/to/ca-chain.pem"
      }
    }
  ]
}
```

В admin dashboard при создании provider connection укажите `keystore_entry_id: "my-gigachat-key"`.

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
