# OmniRoute (GigaChat Fork)

Форк [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — OpenAI-совместимый прокси, урезанный до поддержки только GigaChat и openai-compatible провайдеров.

---

## Что осталось

| Эндпоинт / функция | Статус |
|---|---|
| `POST /v1/chat/completions` | чат (streaming и non-streaming) |
| `POST /v1/embeddings` | эмбеддинги |
| `GET /v1/models` | список моделей |
| `POST /v1/completions` | completions |
| `POST /v1/audio/speech`, `/v1/images/generations`, `/v1/moderations` | если поддерживается провайдером |
| MCP server skeleton | без tools |
| Admin Next.js dashboard | providers / usage / auth |
| Admin CLI | providers / config / auth / serve |
| Per-key mTLS + custom URL | для GigaChat |
| PostgreSQL persistence | через `DATABASE_URL` |

---

## Что удалено

- 761 провайдер (оставлены `gigachat` и `openai-compatible`)
- Electron desktop app
- Web/OAuth/MITM провайдеры
- CLI agent-client команды (`chat`, `responses`, `tui`)
- 37 MCP tools
- Anthropic `/v1/messages` и вспомогательные endpoints
- 41 локаль (оставлена только `ru`)

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

## Atlassian Integration

OmniRoute теперь работает как **MCP server** для Atlassian Data Center: Jira, Bitbucket Server, Confluence Server. LLM-клиенты (Claude Desktop, Cursor и другие) могут вызывать Atlassian-операции через стандартный MCP протокол.

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
      "url": "http://localhost:3000/api/mcp/sse",
      "transport": "sse"
    }
  }
}
```

После подключения клиент увидит 12 тулов (или меньше, если какие-то сервисы отключены).

#### Health check

```bash
curl http://localhost:3000/api/mcp/health
# {"status":"ok","transport":"sse","server":"omniroute","version":"1.0.0"}
```

### Безопасность

- Пароли service accounts автоматически редактируются в логах (показываются как `***<last4>`)
- `Authorization` headers замаскированы как `[redacted]`
- mTLS поддерживается per-service для дополнительной защиты внутренних endpoints
- Логи **не содержат** raw PEM содержимое или passwords

### Поддерживаемые версии Atlassian

- **Jira Data Center / Server** (REST API v2: `/rest/api/2/`)
- **Bitbucket Server / Stash** (REST API v1: `/rest/api/1.0/`)
- **Confluence Server** (REST API v1: `/rest/api/`)

> **Atlassian Cloud не поддерживается** (api.atlassian.com использует другой API). Только on-prem версии.
