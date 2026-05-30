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
