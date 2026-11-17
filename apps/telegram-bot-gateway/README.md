# telegram-bot-gateway

**Владелец:** Telegram-контур. **Bounded context:** только транспорт Telegram Bot API (решение заказчика №1, INTERNAL_API
§8): webhook, `/start` с кнопкой «Открыть TilHero» и `startapp`, кнопка меню, доставка сообщений notifications,
учёт блокировки бота. Команд и диалогов нет. **Без БД**, только Redis (идемпотентность).

## Порты
Один процесс (`python -m tilhero_botgw`), один uvicorn-сервер на двух сокетах; запросы разводятся по локальному
порту соединения (`PortRouter`), у каждого порта своё FastAPI-приложение — маршрутов другого порта в нём нет:

| Порт | Где доступен | Маршруты |
|---|---|---|
| `PORT` (8107; на Railway — порт публичного домена) | интернет | `POST /telegram/webhook`, `/health/*` |
| `INTERNAL_PORT` (8108) | только приватная сеть (`telegram-bot-gateway.railway.internal:8108`) | `POST /internal/v1/messages`, `/health/*` |

`INTERNAL_PORT == PORT` — ошибка конфигурации (сервис не стартует). notifications обращается к
`BOTGW_URL=http://telegram-bot-gateway.railway.internal:8108`.

## API
| Метод | Путь | Кто вызывает | Описание |
|---|---|---|---|
| POST | `/telegram/webhook` | Telegram (публично) | `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET` (`hmac.compare_digest`, иначе 401 `WEBHOOK_UNAUTHORIZED`; пустой секрет — закрыто для всех); `update_id` — Redis `SET NX` 48 ч, дубль → `{"ok":true}`; 400 `WEBHOOK_INVALID` (не JSON, вложенность > 32), 413, 503 `WEBHOOK_UNAVAILABLE` (Redis недоступен — Telegram повторит) |
| POST | `/internal/v1/messages` (только `INTERNAL_PORT`) | только `notifications` | `{telegram_user_id, text (HTML), buttons?: [[{text, startapp}\|{text, url}]], disable_notification?, idempotency_key}` → `{message_id}` |
| GET | `/health/live`, `/health/ready` | Railway | ready проверяет Redis |

### Webhook
- `/start [payload]` (в т.ч. `/start@<bot>`) → приветствие с кнопкой «Открыть TilHero». `payload` — только из белого
  списка (`texts.PAYLOAD_RULES`, ≤ 64 символов): `inv_<token>` (приглашение), `gc_<token>` (согласие родителя),
  `route_<route>`, `invite_<uuid>`, `ticket_TCK-<n>`. Допустимый payload → кнопка-ссылка на прямую ссылку
  `TELEGRAM_APP_LINK?startapp=<payload>` (`https://t.me/<bot>/<app>`: Telegram передаст payload в
  `initData.start_param`, его отдаёт BFF); без `TELEGRAM_APP_LINK` — кнопка `web_app` на `MINIAPP_URL?startapp=<payload>`.
  Недопустимый payload отбрасывается — кнопка `web_app` на `MINIAPP_URL`.
- Прочие команды и любой текст → одна подсказка («бот только открывает приложение и присылает напоминания») с той
  же кнопкой `web_app` на `MINIAPP_URL`.
- Язык по `language_code`: `uz*` → UZ (латиница), иначе RU. Только личные чаты; группы, каналы и боты игнорируются.
- Ответ возвращается **в теле ответа webhook** (метод Bot API) — ack ≤ 1 с без исходящих запросов. Анти-спам: не
  более 20 ответов в чат в минуту.
- `my_chat_member` (личный чат): `kicked` → `POST identity-consent /internal/v1/telegram-users/{id}/bot-status {blocked:true}`,
  `member` → `{blocked:false}` — фоном после ответа, 3 попытки на 5xx/сеть. Группы — без действий и без логов.
- `callback_query` → `answerCallbackQuery` без текста (callback-кнопок у бота нет).

### Доставка (`/internal/v1/messages`)
`parse_mode=HTML` (значения экранирует notifications), превью ссылок выключено, кнопка `startapp` → `web_app`
на `MINIAPP_URL?startapp=…`, кнопка `url` — только https без учётных данных. Идемпотентность по `idempotency_key`
(Redis 24 ч; повтор → тот же `message_id`, заголовок `Idempotent-Replayed`; тот же ключ с другим телом → 422
`IDEMPOTENCY_KEY_REUSED`; параллельный дубль → 409 `IDEMPOTENCY_IN_PROGRESS`).
Ошибки Telegram: 429 → 429 `TELEGRAM_RATE_LIMITED {retry_after}`; 403 → 409 `TELEGRAM_BLOCKED`;
400 → 502 `TELEGRAM_ERROR {permanent: true, reason: chat_not_found|bad_request}`; сеть/5xx/прочее → 502
`TELEGRAM_ERROR {permanent: false}`. При ошибке ключ идемпотентности освобождается — повтор отправит заново.

## Настройка бота
`BOT_AUTO_SETUP=true` (prod в Railway): при каждом запуске, без сброса ожидающих обновлений; ошибка только логируется
(`bot auto-setup …`), старт не блокируется. Вручную: `python -m tilhero_botgw.setup` (со сбросом ожидающих). Если
`TELEGRAM_WEBHOOK_URL` не задан, берётся `https://$RAILWAY_PUBLIC_DOMAIN/telegram/webhook`. Вызовы: `setWebhook`
(url, secret_token, `allowed_updates=[message, callback_query, my_chat_member]`, `drop_pending_updates`),
`setMyCommands` — только `/start` (по умолчанию RU, `ru`, `uz`), `setChatMenuButton` (web_app `MINIAPP_URL`),
`setMyDescription`/`setMyShortDescription` (по умолчанию RU, `ru`, `uz`).

## Переменные окружения
`ENV` (dev|test|stage|prod), `PORT`, `INTERNAL_PORT` (8108), `HOST` (`::`), `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`
(≥ 32 символов `[A-Za-z0-9_-]` в prod), `TELEGRAM_WEBHOOK_URL` (для setup), `MINIAPP_URL` (https),
`TELEGRAM_APP_LINK` (`https://t.me/<bot>/<app>`, как у social; пусто — payload через `?startapp=` у `web_app`),
`TELEGRAM_API_BASE` (по умолчанию `https://api.telegram.org`), `REDIS_URL`, `IDENTITY_CONSENT_URL`,
`INTERNAL_JWT_PRIVATE_KEY` + `INTERNAL_JWT_PUBLIC_KEYS` (stage/prod; в dev/test ключи выводятся из
`INTERNAL_JWT_SECRET`), `MENU_BUTTON_TEXT` (по умолчанию `TilHero`). `DATABASE_URL` не нужен.

## Безопасность
- Токен бота живёт только в base_url HTTP-клиента: логгеры `httpx`/`httpcore` отключены, описания ошибок Telegram
  очищаются от токена, исключения httpx не попадают в логи и ответы (`raise … from None`).
- Тексты сообщений, initData, Telegram ID, payload `/start` в логи не пишутся (общий фильтр `tilhero_common.logging`).
- Публичен только `/telegram/webhook` (и health); `/internal/*` существует лишь на `INTERNAL_PORT` (приватная сеть)
  и требует внутренний JWT `iss=notifications` (EdDSA, ключ издателя). В stage/prod `/docs` и `/openapi.json` выключены.

## События
Не публикует и не потребляет (транспорт). Последствия блокировки бота фиксирует identity-consent; результат доставки —
notifications (`notification.delivered.v1`, `telegram.delivery.failed.v1`).

## Runbook
- Локально: `infra/dev/stack.sh up`; `ENV=dev HOST=127.0.0.1 PORT=8107 INTERNAL_PORT=8108 REDIS_URL=redis://127.0.0.1:6379/0
  BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… MINIAPP_URL=https://… TELEGRAM_APP_LINK=https://t.me/<bot>/<app> uv run python -m tilhero_botgw`.
- Тесты: `uv run pytest apps/telegram-bot-gateway -q` (Telegram и identity-consent — `httpx.MockTransport`).
- Бот молчит: `getWebhookInfo` (last_error_message), проверить логи `bot auto-setup` и перезапустить сервис.
- Смена секрета или токена: обновить переменную → деплой (webhook перенастроится при старте).
