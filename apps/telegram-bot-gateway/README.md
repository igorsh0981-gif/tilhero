# telegram-bot-gateway

**Владелец:** Telegram-контур. **Bounded context:** транспорт Telegram Bot API — webhook, команды бота, кнопка меню,
доставка сообщений с inline-кнопками. Отдельного чат-бота нет (решение заказчика №8): бот открывает нужный раздел
Mini App и доставляет уведомления. **Без БД**, только Redis (идемпотентность).

ТЗ: Telegram «DevOps, Security» §4 (webhook secret, update_id idempotency), NFR «Telegram webhook ack ≤ 1 s».

## Порты (ревью спринта 1, P1)
Один процесс (`python -m tilhero_botgw`), один uvicorn-сервер на двух сокетах; запросы разводятся по локальному
порту соединения (`PortRouter`), у каждого порта своё FastAPI-приложение — маршрутов другого порта в нём нет:

| Порт | Где доступен | Маршруты |
|---|---|---|
| `PORT` (8107; на Railway — порт публичного домена) | интернет | `POST /telegram/webhook`, `/health/*` |
| `INTERNAL_PORT` (8108) | только приватная сеть (`telegram-bot-gateway.railway.internal:8108`) | `POST /internal/v1/messages`, `POST /internal/v1/ops-messages`, `/health/*` |

`INTERNAL_PORT == PORT` — ошибка конфигурации (сервис не стартует). Публичному домену Railway назначается только
`PORT`; notifications обращается к `BOTGW_URL=http://telegram-bot-gateway.railway.internal:8108`.

## API
| Метод | Путь | Кто вызывает | Описание |
|---|---|---|---|
| POST | `/telegram/webhook` | Telegram (публично) | `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET` (`hmac.compare_digest`, иначе 401 `WEBHOOK_UNAUTHORIZED`; пустой секрет — закрыто для всех); `update_id` — Redis `SET NX` 48 ч, дубль → `{"ok":true}`; 400 `WEBHOOK_INVALID`, 413, 503 `WEBHOOK_UNAVAILABLE` (Redis недоступен — Telegram повторит) |
| POST | `/internal/v1/messages` (только `INTERNAL_PORT`) | только `notifications` | `{telegram_user_id, text (HTML), buttons?: [[{text, startapp}\|{text, url}]], disable_notification?, idempotency_key}` → `{message_id}` |
| POST | `/internal/v1/ops-messages` (только `INTERNAL_PORT`, спринт 8) | только `notifications` | `{text: 1..3500 (обычный текст), button?: {text ≤ 40, url: https на домене ADMIN_WEB_URL}, dedup_key}` → `{message_id}` в чат операторов `OPS_ALERT_CHAT_ID` |
| GET | `/health/live`, `/health/ready` | Railway | ready проверяет Redis |

### Webhook
- Команды `/start [param]`, `/events`, `/watch`, `/support`, `/help` → сообщение с inline-кнопкой `web_app` на
  `MINIAPP_URL?startapp=<раздел>` (`home`, `catalog`, `watch`, `support`); `/start param` — deep link, `param`
  проверяется `^[A-Za-z0-9_-]{1,64}$` (иначе `home`). Обычный текст и неизвестные команды — приветствие с кнопкой.
- Язык по `language_code`: ru/uz/kk → RU, иначе EN. Только личные чаты; группы и боты игнорируются.
- Ответ на команду возвращается **в теле ответа webhook** (метод Bot API) — ack ≤ 1 с без исходящих запросов.
  Анти-спам: не более 20 ответов в чат в минуту.
- `my_chat_member` (личный чат): `kicked` → `POST identity-consent /internal/v1/telegram-users/{id}/bot-status {blocked:true}`,
  `member` → `{blocked:false}` — фоном после ответа, 3 попытки на 5xx/сеть.
- `my_chat_member` в группе/супергруппе (спринт 8): бота добавили (`member`/`administrator`) → INFO-лог
  `ops chat candidate chat_id=<id> title='<название группы>'` — так узнают id нужной группы для `OPS_ALERT_CHAT_ID`. Id добавившего не пишется.
- `callback_query` → `answerCallbackQuery` «Скоро» / «Coming soon».

### Доставка (`/internal/v1/messages`)
`parse_mode=HTML` (параметры экранирует notifications), превью ссылок выключено, кнопка `startapp` → `web_app`
на `MINIAPP_URL?startapp=…`, кнопка `url` — только https без учётных данных. Идемпотентность по `idempotency_key`
(Redis 24 ч; повтор → тот же `message_id`, заголовок `Idempotent-Replayed`; тот же ключ с другим телом → 422
`IDEMPOTENCY_KEY_REUSED`; параллельный дубль → 409 `IDEMPOTENCY_IN_PROGRESS`).
Ошибки Telegram: 429 → 429 `TELEGRAM_RATE_LIMITED {retry_after}`; 403 → 409 `TELEGRAM_BLOCKED`;
400 → 502 `TELEGRAM_ERROR {permanent: true, reason: chat_not_found|bad_request}`; сеть/5xx/прочее → 502
`TELEGRAM_ERROR {permanent: false}`. При ошибке ключ идемпотентности освобождается — повтор отправит заново.

### Оповещения операторам (`/internal/v1/ops-messages`, спринт 8 §6)
Чат — **только** из env `OPS_ALERT_CHAT_ID` (группа — отрицательное число), вызывающий чат не выбирает. Текст
отправляется без `parse_mode` (разметка не интерпретируется), превью ссылок выключено. Кнопка — только https на
домене `ADMIN_WEB_URL` (иначе 422 `VALIDATION_ERROR`); если `ADMIN_WEB_URL` не задан — сообщение уходит без кнопки
(WARNING `ops button dropped`). Идемпотентность по `dedup_key` (Redis 24 ч, как у `/messages`).
Ошибки: `OPS_ALERT_CHAT_ID` пуст → 409 `OPS_CHAT_NOT_CONFIGURED`; больше `OPS_MESSAGES_PER_MINUTE` (20) в минуту →
429 `RATE_LIMITED` (`Retry-After`; повтор уже отправленного ключа не считается); бот исключён / чат не найден /
группа стала супергруппой → 409 `OPS_CHAT_UNAVAILABLE` + WARNING; 429 Telegram → 429 `TELEGRAM_RATE_LIMITED`;
прочие 400 → 502 `TELEGRAM_ERROR {permanent: true}`; сеть/5xx → 502 `TELEGRAM_ERROR {permanent: false}`.

Как подключить чат: создать группу, добавить бота → в логах bot-gateway `ops chat candidate chat_id=-100…` → задать
`OPS_ALERT_CHAT_ID` этим числом и перезапустить сервис.

## Настройка бота
`BOT_AUTO_SETUP=true` (prod в Railway): при каждом запуске, без сброса ожидающих обновлений; ошибка только логируется (`bot auto-setup …`), старт не блокируется. Вручную: `python -m tilhero_botgw.setup` (со сбросом ожидающих). Если `TELEGRAM_WEBHOOK_URL` не задан, берётся `https://$RAILWAY_PUBLIC_DOMAIN/telegram/webhook`. Вызовы: `setWebhook` (url, secret_token,
`allowed_updates=[message, callback_query, my_chat_member]`, `drop_pending_updates`), `setMyCommands` (по умолчанию EN,
`ru`, `en`), `setChatMenuButton` (web_app `MINIAPP_URL`), `setMyDescription`/`setMyShortDescription` RU/EN.

## Переменные окружения
`ENV` (обязательна: dev|test|stage|prod), `PORT`, `INTERNAL_PORT` (8108), `HOST` (`::`), `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (≥ 32 символов `[A-Za-z0-9_-]` в prod), `TELEGRAM_WEBHOOK_URL` (для setup),
`MINIAPP_URL` (https), `TELEGRAM_API_BASE` (по умолчанию `https://api.telegram.org`), `REDIS_URL`,
`IDENTITY_CONSENT_URL`, `OPS_ALERT_CHAT_ID` (пусто — оповещения операторам выключены), `ADMIN_WEB_URL` (https, домен кнопки
оповещений), `OPS_MESSAGES_PER_MINUTE` (20), `INTERNAL_JWT_PRIVATE_KEY` + `INTERNAL_JWT_PUBLIC_KEYS` (stage/prod; в dev/test ключи
выводятся из `INTERNAL_JWT_SECRET`), `MENU_BUTTON_TEXT` (по умолчанию `TilHero`). `DATABASE_URL` не нужен.

## Безопасность
- Токен бота живёт только в base_url HTTP-клиента: логгеры `httpx`/`httpcore` отключены, описания ошибок Telegram
  очищаются от токена, исключения httpx не попадают в логи и ответы (`raise … from None`).
- Тексты сообщений, initData, Telegram ID в логи не пишутся (общий фильтр `tilhero_common.logging`).
- Публичен только `/telegram/webhook` (и health); `/internal/*` существует лишь на `INTERNAL_PORT` (приватная сеть)
  и требует внутренний JWT `iss=notifications` (EdDSA, ключ издателя). В stage/prod `/docs` и `/openapi.json` выключены.

## События
Не публикует и не потребляет (транспорт). Последствия блокировки бота фиксирует identity-consent; результат доставки —
notifications (`notification.delivered.v1`, `telegram.delivery.failed.v1`).

## Runbook

> Эксплуатация через браузер (Railway, админка, оповещения ops-monitor): [docs/runbooks/telegram-bot-gateway.md](../../docs/runbooks/telegram-bot-gateway.md). Ниже — технические детали для разработчика.
- Локально: `infra/dev/stack.sh up`; `ENV=dev HOST=127.0.0.1 PORT=8107 INTERNAL_PORT=8108 REDIS_URL=redis://127.0.0.1:6379/0
  BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… MINIAPP_URL=https://… uv run python -m tilhero_botgw`.
- Тесты: `uv run pytest apps/telegram-bot-gateway -q` (Telegram и identity-consent — `httpx.MockTransport`).
- Бот молчит: `getWebhookInfo` (last_error_message), проверить логи `bot auto-setup` и перезапустить сервис.
- Смена секрета или токена: обновить переменную → деплой (webhook перенастроится при старте).
