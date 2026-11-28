# telegram-bot-gateway

**Владелец:** Telegram-контур. **Bounded context:** только транспорт Telegram Bot API (решение заказчика №1, INTERNAL_API
§8): webhook, `/start` с кнопкой «Открыть TilHero» и `startapp`, кнопка меню, доставка сообщений notifications,
учёт блокировки бота. Диалогов нет. **Без БД**, только Redis (идемпотентность).

**Спринт 8 — Telegram Stars** (`docs/sprint8/INTERNAL_API.md` §1.5, §2): единственный, кто вызывает Bot API для Stars
(токен бота — только здесь и в telegram-bff): внутренний API для billing (счёт, возврат, автопродление, выписка),
платёжные обновления webhook → billing, команды `/paysupport`, `/support`, `/terms` (требование Telegram для продаж за
Stars). Telegram ID в billing не попадает — bot-gateway переводит его в `account_id` через identity-consent.

## Порты
Один процесс (`python -m tilhero_botgw`), один uvicorn-сервер на двух сокетах; запросы разводятся по локальному
порту соединения (`PortRouter`), у каждого порта своё FastAPI-приложение — маршрутов другого порта в нём нет:

| Порт | Где доступен | Маршруты |
|---|---|---|
| `PORT` (8107; на Railway — порт публичного домена) | интернет | `POST /telegram/webhook`, `/health/*` |
| `INTERNAL_PORT` (8108) | только приватная сеть (`telegram-bot-gateway.railway.internal:8108`) | `POST /internal/v1/messages`, `/internal/v1/stars/*`, `/health/*` |

`INTERNAL_PORT == PORT` — ошибка конфигурации (сервис не стартует). notifications и billing обращаются к
`http://telegram-bot-gateway.railway.internal:8108` (`BOT_GATEWAY_URL` у notifications, `BOTGW_URL` у billing).

## API
| Метод | Путь | Кто вызывает | Описание |
|---|---|---|---|
| POST | `/telegram/webhook` | Telegram (публично) | `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET` (`hmac.compare_digest`, иначе 401 `WEBHOOK_UNAUTHORIZED`; пустой секрет — закрыто для всех); `update_id` — Redis `SET NX` 48 ч, дубль → `{"ok":true}`; 400 `WEBHOOK_INVALID` (не JSON, вложенность > 32), 413, 503 `WEBHOOK_UNAVAILABLE` (Redis недоступен — Telegram повторит) |
| POST | `/internal/v1/messages` (только `INTERNAL_PORT`) | только `notifications` | `{telegram_user_id, text (HTML), buttons?: [[{text, startapp}\|{text, url}]], disable_notification?, idempotency_key}` → `{message_id}` |
| POST | `/internal/v1/stars/invoice-links` (только `INTERNAL_PORT`) | только `billing` | `{order_id, title (1..32), description (1..255), payload (≤ 128 байт), amount_stars (1..100 000), subscription_period: 2592000 \| null}` → `createInvoiceLink` (`currency: XTR`, `provider_token: ""`, ровно одна позиция `prices`; `subscription_period` — только для подписки, цена ≤ 10 000) → `{invoice_link}`; идемпотентность по `order_id` (Redis 24 ч; другое тело — 422 `IDEMPOTENCY_KEY_REUSED`) |
| POST | `/internal/v1/stars/refunds` | только `billing` | `{account_id, telegram_payment_charge_id}` → identity-consent `GET /internal/v1/accounts/{id}/telegram-user` → `refundStarPayment` → `{ok}`; уже возвращён (400 `CHARGE_ALREADY_REFUNDED`) — `{ok, already: true}`; Telegram ID неизвестен — 409 `STARS_PAYER_UNKNOWN` |
| POST | `/internal/v1/stars/subscriptions/edit` | только `billing` | `{account_id, telegram_payment_charge_id (первого платежа), is_canceled}` → `editUserStarSubscription` → `{ok}`; 409 `STARS_PAYER_UNKNOWN` |
| GET | `/internal/v1/stars/transactions?offset&limit` (1..100) | только `billing` | `getStarTransactions` → `{items: [{id, amount, nanostar_amount, date, direction: in\|out, partner_type, transaction_type, invoice_payload, subscription_period}], count}` — **без данных пользователя**; `count` — размер страницы Telegram до отбора |
| GET | `/health/live`, `/health/ready` | Railway | ready проверяет Redis |

Ошибки Bot API во внутреннем API Stars: 502 `TELEGRAM_ERROR {permanent}` (400/403 — постоянная, `reason`; 429, 5xx,
сеть — временная), identity-consent недоступен — 503 `UPSTREAM_UNAVAILABLE`.

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
- `/paysupport` и `/support` → «вопросы по оплате — в поддержке TilHero» + кнопка на раздел «Поддержка» Mini App
  (`startapp=route_support`) и пояснение, что поддержка Telegram с покупками в ботах не помогает; `/terms` → кнопка на
  оферту (`TERMS_URL`, только домен Mini App). Тексты RU/UZ — черновики до вычитки юристом (О6). **Анти-стиринг:** ни
  в одном тексте бота нет сайта оплаты, ссылок на него, названий Payme/Click/Uzum, цен в сумах и «других способов
  оплаты» (тест `test_bot_texts_have_no_steering`).

### Платёжные обновления Telegram Stars (спринт 8)
Исключение из «ack ≤ 1 с без исходящих» — укладываемся в лимиты Bot API:
- `pre_checkout_query` → identity-consent `GET /internal/v1/telegram-users/{id}/account` (2 с; 404 — `account_id: null`;
  `status: DELETION_REQUESTED` — отказ без billing) → billing `POST /internal/v1/stars/pre-checkout` (3 с) →
  **`answerPreCheckoutQuery` в теле ответа webhook** (≤ 10 с Bot API, исходящего вызова нет). Любая ошибка или таймаут —
  `ok: false` и текст RU/UZ по `from.language_code` («Оплата временно недоступна…»; коды billing — свои тексты).
  `update_id` не отмечается: повтор доставки получает ответ заново (billing хранит ответ по `query_id`).
- `message.successful_payment`, `message.refunded_payment`, `subscription` (BotSubscriptionUpdated, Bot API 10.2) →
  billing `stars/payments` | `stars/refunds-received` | `stars/subscription-updates` (5 с на попытку, один повтор на
  сеть/5xx, всё обновление ≤ 9 с). Ключ `update_id` — сначала «в обработке» (SET NX, 60 с; параллельный дубль — 503),
  **после 2xx billing — «готово» (48 ч)**; иначе ключ снимается и ответ **503 — Telegram повторит**. billing
  идемпотентен по `telegram_payment_charge_id`: повтор не зачисляет дважды. identity-consent недоступен — тоже 503.
  Непригодное обновление (нет charge id, сумма не число) — подтверждается без обработки (сверка выписки найдёт).

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
(url, secret_token, `allowed_updates=[message, callback_query, my_chat_member, pre_checkout_query, subscription]` — при
заданном списке Telegram присылает только перечисленные типы, поэтому Stars-обновления включены явно,
`drop_pending_updates`),
`setMyCommands` — `/start`, `/paysupport`, `/support`, `/terms` (по умолчанию RU, `ru`, `uz`), `setChatMenuButton` (web_app `MINIAPP_URL`),
`setMyDescription`/`setMyShortDescription` (по умолчанию RU, `ru`, `uz`).

## Переменные окружения
`ENV` (dev|test|stage|prod), `PORT`, `INTERNAL_PORT` (8108), `HOST` (`::`), `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`
(≥ 32 символов `[A-Za-z0-9_-]` в prod), `TELEGRAM_WEBHOOK_URL` (для setup), `MINIAPP_URL` (https; **обязателен в
stage/prod и не localhost** — `localhost`, `*.localhost`, `127.*`, `::1`, `0.0.0.0` запрещены, иначе сервис не стартует,
ревью P-12; в dev/test по умолчанию `https://localhost:5173`),
`TELEGRAM_APP_LINK` (`https://t.me/<bot>/<app>`, как у social; пусто — payload через `?startapp=` у `web_app`),
`TELEGRAM_API_BASE` (по умолчанию `https://api.telegram.org`), `REDIS_URL`, `IDENTITY_CONSENT_URL`,
`INTERNAL_JWT_PRIVATE_KEY` + `INTERNAL_JWT_PUBLIC_KEYS` (stage/prod; в dev/test ключи выводятся из
`INTERNAL_JWT_SECRET`; спринт 8 — нужен открытый ключ издателя `billing`), `MENU_BUTTON_TEXT` (по умолчанию `TilHero`).
`DATABASE_URL` не нужен.

Спринт 8: `BILLING_URL` (приватный адрес billing, `:8118`), `TELEGRAM_TEST_ENV` (`true` — тестовая среда Telegram:
`{TELEGRAM_API_BASE}/bot<token>/test/<METHOD>`, и webhook, и вызовы Stars; prod — `false`), `TERMS_URL` (оферта для
`/terms`: только https на домене `MINIAPP_URL`; пусто — `<origin MINIAPP_URL>/legal/offer`),
`STARS_IDENTITY_TIMEOUT_SECONDS` (2) + `STARS_PRE_CHECKOUT_TIMEOUT_SECONDS` (3) — вместе ≤ 9, иначе не стартует;
`STARS_BILLING_TIMEOUT_SECONDS` (5), `STARS_UPDATE_DEADLINE_SECONDS` (9), `STARS_PROCESSING_TTL_SECONDS` (60).

## Безопасность
- Токен бота живёт только в base_url HTTP-клиента: логгеры `httpx`/`httpcore` отключены, описания ошибок Telegram
  очищаются от токена, исключения httpx не попадают в логи и ответы (`raise … from None`).
- Тексты сообщений, initData, Telegram ID, payload `/start` в логи не пишутся (общий фильтр `tilhero_common.logging`).
- Публичен только `/telegram/webhook` (и health); `/internal/*` существует лишь на `INTERNAL_PORT` (приватная сеть)
  и требует внутренний JWT (EdDSA, ключ издателя): `/messages` — только `iss=notifications`, `/stars/*` — только
  `iss=billing`. В stage/prod `/docs` и `/openapi.json` выключены.
- Stars: Telegram ID — только в памяти запроса (в billing — `account_id`); в логах нет Telegram ID, `invoice_payload`
  и charge id (только `charge_ref` — sha256-префикс 12 символов); выписка `getStarTransactions` отдаётся без `user`,
  `affiliate`, подарков и медиа.

## События
Не публикует и не потребляет (транспорт). Платёжные обновления Stars — не события шины: передаются billing синхронно,
повтор — через Telegram (INTERNAL_API спринта 8 §10). Последствия блокировки бота фиксирует identity-consent; результат доставки —
notifications (`notification.delivered.v1`, `telegram.delivery.failed.v1`).

## Runbook
- Локально: `infra/dev/stack.sh up`; `ENV=dev HOST=127.0.0.1 PORT=8107 INTERNAL_PORT=8108 REDIS_URL=redis://127.0.0.1:6379/0
  BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… MINIAPP_URL=https://… TELEGRAM_APP_LINK=https://t.me/<bot>/<app> uv run python -m tilhero_botgw`.
- Тесты: `uv run pytest apps/telegram-bot-gateway -q` (Telegram и identity-consent — `httpx.MockTransport`).
- Бот молчит: `getWebhookInfo` (last_error_message), проверить логи `bot auto-setup` и перезапустить сервис.
- Смена секрета или токена: обновить переменную → деплой (webhook перенастроится при старте).
- **Stars — платёж «застрял»:** в логах `billing rejected stars update` / `stars update postponed` — billing или
  identity-consent недоступны, Telegram повторяет обновление сам (503); после восстановления зачисление одно (billing
  идемпотентен). Telegram перестал повторять — расхождение найдёт сверка выписки (`stars_unmatched` в billing).
- **Stars — pre-checkout отказывает всем:** `stars pre-checkout answered` с `reason` (`billing_timeout`,
  `identity_unavailable`, `billing_503`, `payments_disabled`…) — проверить billing (`STARS_ENABLED`, `PAYMENTS_ENABLED`),
  identity-consent и открытые ключи JWT (`billing` ↔ `telegram-bot-gateway`).
- **Stars — возврат:** делает сотрудник в админке (billing → `/internal/v1/stars/refunds` → `refundStarPayment`;
  повтор безопасен — «уже возвращён» = ок). Для подписки billing дополнительно отменяет автопродление
  (`subscriptions/edit is_canceled=true`).
- **Тестовая среда Telegram (stage):** тестовый бот из тестового @BotFather, `TELEGRAM_TEST_ENV=true`, `BOT_TOKEN`
  тестового бота; `BOT_AUTO_SETUP=true` настроит webhook в тестовой среде. Чек-лист проверки S1–S5 — отчёт потока G
  спринта 8 (счёт, оплата, повтор, продление, отмена, возврат, выписка).
