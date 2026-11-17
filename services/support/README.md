# support-service

**Владелец:** команда Support (общий сервис Telegram- и Admin-контуров, решение 07.10.2026).
**Bounded context:** обращения клиентов, переписка, статусы, SLA, технический контекст события/оффера, эскалации.
ТЗ: Telegram §9 «Поддержка», TG-FR-040…044, BR-TG-011, «Support context helper»; Admin «Support Operations».

Support **не** выполняет refund, override подписки, блокировку и удаление данных — только эскалации (related request).

## API
Все вызовы — по внутреннему JWT (`x-internal-token`). `user_id` — только из `sub` токена.
Обращение адресуется `ticket_id` (UUID) или номером `TCK-3081` (deep link `startapp=ticket_TCK-3081`).

### Клиентские (вызывает `telegram-bff`, формы — `packages/contracts/src/bff.ts`)
| Метод | Путь | Ответ / ошибки |
|---|---|---|
| GET | `/internal/v1/support/categories` | `{items:[{code,label:{ru,en},available,default_priority}]}` (также `admin-bff`) |
| POST | `/internal/v1/me/tickets` + `Idempotency-Key` (обязателен) | 201 `Ticket`; 400 `IDEMPOTENCY_KEY_REQUIRED`; 422 `SUPPORT_CATEGORY_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `VALIDATION_ERROR` (лишнее поле контекста); 429 `SUPPORT_TOO_MANY_OPEN` (≤ 10 открытых), `SUPPORT_RATE_LIMITED {retry_after}` (≤ 30 сообщений клиента в час) |
| GET | `/internal/v1/me/tickets?limit=&cursor=` | `{items: TicketSummary[], next_cursor}` |
| GET | `/internal/v1/me/tickets/{ref}` | `Ticket` (ответы оператора отмечаются прочитанными); 404 `SUPPORT_TICKET_NOT_FOUND` (в т.ч. чужое) |
| POST | `/internal/v1/me/tickets/{ref}/messages` (+ необязательный `Idempotency-Key`) | `Ticket`; 409 `SUPPORT_TICKET_CLOSED`; 429 `SUPPORT_RATE_LIMITED` |
| POST | `/internal/v1/me/tickets/{ref}/close` | `Ticket` (CLOSED; повтор — без изменений) |

После обработки `user.deletion.requested.v1` все клиентские вызовы этого `user_id` → **410 `USER_DELETED`** (таблица
`deleted_users`, проверка под той же advisory-блокировкой пользователя, что и обезличивание: гонка «удаление ↔ новое
обращение» не оставляет обращений с `user_id`, ревью P3).

Контекст обращения (TG-FR-041) — строгая модель: `event_id`, `offer_id`, `provider_id` (≤ 64, `[A-Za-z0-9_.:-]`),
`deeplink` (только https, ≤ 2048, без учётных данных), `price_snapshot {amount: строка-десятичное ≤ 2 знаков ("850.00"),
currency: USD, fetched_at}` — JSON-число (float) → 422 (ревью T3); хранится Decimal, отдаётся строкой `"850.00"`,
`event_title` (≤ 200), `client_version` (обязателен). Сервер добавляет канал (по вызывающему BFF) и `correlation_id`.

### Staff (вызывает `admin-bff`, `actor` в токене)
| Метод | Путь | Право |
|---|---|---|
| GET | `/admin/v1/support/tickets?status=open\|all\|NEW,…&category=&priority=&assignee=<id>\|_me\|_none&sla=breached\|soon\|ok&user_id=<uuid>&sort=created\|sla&limit=&cursor=` | `support.read` |
| GET | `/admin/v1/support/tickets/{ref}` — с внутренними заметками, `user_id`, эскалациями, историей | `support.read` |
| GET | `/admin/v1/support/tickets/{ref}/client-view` — «Как видит клиент» (A42): тот же сериализатор и выборка, что `GET /internal/v1/me/tickets/{ref}` (без внутренних заметок и служебных полей); только чтение — непрочитанные клиента не сбрасываются | `support.read` |
| POST | `/admin/v1/support/tickets/{ref}/take` — назначить на себя, NEW→IN_PROGRESS (иной статус не меняется); повтор тем же оператором — без изменений; CLOSED → 409 `SUPPORT_TICKET_CLOSED`; аудит `ticket.take` | `support.reply` |
| GET | `/admin/v1/support/stats?period=today\|7d\|30d` → `{open, in_progress, waiting_customer, breached, avg_first_response_minutes, avg_resolution_minutes}` (очередь — сейчас; средние — за период, `today` по `STATS_TIMEZONE`) | `support.read` или `dashboard.read` |
| POST | `/admin/v1/support/tickets/{ref}/messages {text, visibility: public\|internal}` — имя оператора только из `actor.name` токена admin-bff (поле `author_name` в теле → 422, ревью P5) | `support.reply` |
| PATCH | `/admin/v1/support/tickets/{ref} {status?, priority?, assignee_id?}` → 409 `SUPPORT_INVALID_TRANSITION` | `support.reply` |
| POST | `/admin/v1/support/tickets/{ref}/escalations {type, note}` (+ `Idempotency-Key`) | `support.reply` |
| GET/PUT | `/admin/v1/support/sla-policies` (`PUT {items:[{category\|*, priority, first_response_minutes, resolution_minutes}], reason}`) | `support.manage` |

Статусы: `NEW → IN_PROGRESS → WAITING_CUSTOMER → RESOLVED → CLOSED`. Оператор (PATCH): NEW→IN_PROGRESS;
IN_PROGRESS→WAITING_CUSTOMER|RESOLVED; WAITING_CUSTOMER→IN_PROGRESS|RESOLVED; RESOLVED→CLOSED|IN_PROGRESS.
Неявно: публичный ответ оператора NEW/IN_PROGRESS → WAITING_CUSTOMER (и назначение на ответившего, если никто не назначен);
сообщение клиента WAITING_CUSTOMER/RESOLVED → IN_PROGRESS; клиент закрывает из любого статуса.

SLA: политика `(category, priority)` с откатом на `('*', priority)`. Сид: low 480/4320, normal 120/1440, high 60/480,
urgent 30/240 минут. Приоритет по умолчанию: `ACCOUNT`, `PERSONAL_DATA` — high, остальные — normal. Смена приоритета
пересчитывает сроки от момента создания. `sla_state`: таймер идёт в NEW/IN_PROGRESS (цель — первый ответ, затем решение),
`breached` — срок прошёл, `soon` — < 30 мин, иначе `ok`; WAITING_CUSTOMER — пауза (`sla_paused=true`).

Внутренние заметки (`visibility=internal`) не возвращаются клиентским API, не порождают событий и уведомлений и не меняют
видимые клиенту `updated_at`/`last_message_at`. Клиент видит имя оператора без фамилии и не видит `author_id`.

## События
Публикует (outbox): `support.ticket.created.v1`, `support.ticket.replied.v1` (только публичный ответ оператора, без текста),
`support.ticket.status.changed.v1`, `admin.audit.recorded.v1` (staff-команды: `ticket.reply`, `ticket.note`,
`ticket.status`, `ticket.assign`, `ticket.priority`, `ticket.escalate`, `sla.change`; без текстов сообщений),
`user.domain.deleted.v1 {domain: support, mode: anonymized}`.
Потребляет: `user.deletion.requested.v1` (durable `support.user_deleted`) → обезличивание: `user_id → NULL`, тексты клиента
и тема → «[удалено по запросу пользователя]», контекст и correlation_id очищаются, открытые обращения закрываются системой.
Ответы операторов, заметки, история и эскалации сохраняются (retention/audit).

## Данные
Схема `support`: `tickets` (номер из `ticket_number_seq` с 3000, `UNIQUE(user_id, idempotency_key)`), `messages`
(`visibility` public/internal, CHECK: internal только у оператора; `UNIQUE(ticket_id, client_key)`), `status_history`,
`escalations` (`UNIQUE(ticket_id, idempotency_key)`), `sla_policies`, `deleted_users` (миграция 0002), `outbox`, `inbox`.
Модели SQLAlchemy — зеркало миграций (ограничения, индексы, CHECK), сверка — `tests/test_support_schema.py`. PII: только `user_id` и тексты, написанные клиентом.

## Runbook

> Эксплуатация через браузер (Railway, админка, оповещения ops-monitor): [docs/runbooks/support.md](../../docs/runbooks/support.md). Ниже — технические детали для разработчика.
- Миграции: `alembic -c alembic.ini upgrade head` (Railway preDeploy) под ролью-владельцем `support_owner`
  (`MIGRATION_DATABASE_URL`); сервис работает под ролью `support` (`DATABASE_URL`, только DML) — `infra/db/bootstrap.sql`.
- Локально: `infra/dev/stack.sh up`, затем
  `ENV=dev DATABASE_URL=postgresql://support:dev@127.0.0.1:5432/tilhero NATS_URL=nats://127.0.0.1:4222 uv run uvicorn tilhero_support.main:app --port 8103`.
- Тесты: `uv run pytest services/support -q`.
- Очередь просрочек: `GET /admin/v1/support/tickets?sla=breached&sort=sla`.
- Ответ оператора не дошёл до клиента: проверить `support.ticket.replied.v1` в outbox (`published_at`), затем журнал
  notifications (`notifications.status`, `failure_reason`).
