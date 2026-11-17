# support-service

**Владелец:** команда поддержки TilHero (общий сервис Telegram- и Admin-контуров). **Bounded context:** обращения
учеников, переписка с оператором, статусы, SLA, технический контекст обращения, эскалации. Порт 8103, схема PostgreSQL
`support`, внутренний JWT с `aud = support`. Основа — support «Бот турист» (aievent) без туристических категорий и
контекста (INTERNAL_API спринта 1, §6). Жалобы на оценку урока со ссылкой на проверку — спринт 4.

Support **не** делает возвраты, смену тарифа, правку оценок, блокировку и удаление данных — только эскалации.

## API
Все вызовы — по внутреннему JWT (`x-internal-token`). `user_id` — только из `sub` токена (ученик, от имени которого
пишет BFF). Обращение адресуется `ticket_id` (UUID) или номером `TCK-3081` (deep link `startapp=ticket_TCK-3081`).

### Клиентские (вызывает `telegram-bff`, формы — `packages/contracts/src/bff.ts`)
| Метод | Путь | Ответ / ошибки |
|---|---|---|
| GET | `/internal/v1/support/categories` | `{items:[{code, label:{ru, uz}, available, default_priority}]}` (также `admin-bff`) |
| POST | `/internal/v1/me/tickets` + `Idempotency-Key` (обязателен) | 201 `Ticket`; 400 `IDEMPOTENCY_KEY_REQUIRED`; 422 `SUPPORT_CATEGORY_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_KEY_INVALID`, `VALIDATION_ERROR` (лишнее поле контекста); 429 `SUPPORT_TOO_MANY_OPEN` (≤ 10 открытых), `SUPPORT_RATE_LIMITED {retry_after}` (≤ 30 сообщений ученика в час) |
| GET | `/internal/v1/me/tickets?limit=&cursor=` | `Page<TicketSummary>` |
| GET | `/internal/v1/me/tickets/{ref}` | `Ticket` (ответы оператора отмечаются прочитанными); 404 `SUPPORT_TICKET_NOT_FOUND` (в т. ч. чужое) |
| POST | `/internal/v1/me/tickets/{ref}/messages` (+ необязательный `Idempotency-Key`) | `Ticket`; 409 `SUPPORT_TICKET_CLOSED`; 429 `SUPPORT_RATE_LIMITED` |
| POST | `/internal/v1/me/tickets/{ref}/close` | `Ticket` (CLOSED; повтор — без изменений) |

**Категории** (`TicketCategory` bff.ts, подписи RU/UZ — в `domain/constants.py`, сверка с bff.ts — контрактный тест):
`LESSON` урок, `ASSESSMENT` оценка урока, `SCHEDULE_REMINDERS` график и напоминания, `CHILD_PROFILE` детский профиль,
`ACCOUNT` аккаунт и вход, `SUBSCRIPTION_PAYMENT` подписка и оплата (`available=false` до спринта 8 — обращение по ней →
422 `SUPPORT_CATEGORY_INVALID`), `PERSONAL_DATA` персональные данные, `BUG` ошибка в приложении, `OTHER` другое.

**Контекст обращения** — строгая модель, только `deeplink` (https, ≤ 2048, без учётных данных и пробелов) и
`client_version` (обязателен, `[A-Za-z0-9._-]`, ≤ 64). Любое другое поле → 422: персональные данные, тексты уроков и
переписка с ИИ в контекст не попадают. Сервер добавляет канал (по вызывающему BFF) и `correlation_id`.

После обработки `user.deletion.requested.v1` все клиентские вызовы этого `user_id` → **410 `USER_DELETED`** (таблица
`deleted_users`, проверка под той же advisory-блокировкой пользователя, что и обезличивание: гонка «удаление ↔ новое
обращение» не оставляет обращений с `user_id`).

### Staff (вызывает `admin-bff` со спринта 2, сотрудник — claim `actor` токена)
| Метод | Путь | Право |
|---|---|---|
| GET | `/admin/v1/support/tickets?status=open\|all\|NEW,…&category=&priority=&assignee=<id>\|_me\|_none&sla=breached\|soon\|ok&user_id=<uuid>&sort=created\|sla&limit=&cursor=` | `support.read` |
| GET | `/admin/v1/support/tickets/{ref}` — с внутренними заметками, `user_id`, `has_context`, эскалациями, историей | `support.read` |
| GET | `/admin/v1/support/tickets/{ref}/client-view` — «Как видит клиент»: тот же сериализатор, что `GET /internal/v1/me/tickets/{ref}`; только чтение | `support.read` |
| POST | `/admin/v1/support/tickets/{ref}/take` — назначить на себя, NEW→IN_PROGRESS; CLOSED → 409 `SUPPORT_TICKET_CLOSED`; аудит `ticket.take` | `support.reply` |
| GET | `/admin/v1/support/stats?period=today\|7d\|30d` → `{open, in_progress, waiting_customer, breached, avg_first_response_minutes, avg_resolution_minutes}` (`today` — по `STATS_TIMEZONE`, Asia/Tashkent) | `support.read` или `dashboard.read` |
| POST | `/admin/v1/support/tickets/{ref}/messages {text, visibility: public\|internal}` — имя оператора только из `actor.name` токена (поле `author_name` в теле → 422) | `support.reply` |
| PATCH | `/admin/v1/support/tickets/{ref} {status?, priority?, assignee_id?}` → 409 `SUPPORT_INVALID_TRANSITION` | `support.reply` |
| POST | `/admin/v1/support/tickets/{ref}/escalations {type, note}` (+ `Idempotency-Key`) | `support.reply` |
| GET/PUT | `/admin/v1/support/sla-policies` (`PUT {items:[{category\|*, priority, first_response_minutes, resolution_minutes}], reason}`) | `support.manage` |

Типы эскалаций: `billing_review` (оплата → billing), `assessment_review` (оценка урока → методисты), `content_review`
(урок или материалы → методисты), `tech_issue` (технический сбой → разработка), `security_privacy` (безопасность и
персональные данные → security).

Статусы: `NEW → IN_PROGRESS → WAITING_CUSTOMER → RESOLVED → CLOSED`. Оператор (PATCH): NEW→IN_PROGRESS;
IN_PROGRESS→WAITING_CUSTOMER|RESOLVED; WAITING_CUSTOMER→IN_PROGRESS|RESOLVED; RESOLVED→CLOSED|IN_PROGRESS.
Неявно: публичный ответ оператора NEW/IN_PROGRESS → WAITING_CUSTOMER (и назначение на ответившего, если никто не назначен);
сообщение ученика WAITING_CUSTOMER/RESOLVED → IN_PROGRESS; ученик закрывает из любого статуса.

SLA: политика `(category, priority)` с откатом на `('*', priority)`. Сид: low 480/4320, normal 120/1440, high 60/480,
urgent 30/240 минут. Приоритет по умолчанию: `ACCOUNT`, `PERSONAL_DATA`, `CHILD_PROFILE` — high, остальные — normal.
Смена приоритета пересчитывает сроки от момента создания. `sla_state`: таймер идёт в NEW/IN_PROGRESS (цель — первый
ответ, затем решение), `breached` — срок прошёл, `soon` — < 30 мин, иначе `ok`; WAITING_CUSTOMER — пауза.

Внутренние заметки (`visibility=internal`) не возвращаются клиентским API, не порождают событий и уведомлений и не меняют
видимые ученику `updated_at`/`last_message_at`. Ученик видит имя оператора без фамилии и не видит `author_id`.

## События
Публикует (outbox): `support.ticket.created.v1`, `support.ticket.replied.v1` (только публичный ответ оператора, без
текста) и `support.ticket.status.changed.v1` — их потребляет notifications (ответ и решение приходят в центр уведомлений и
в Telegram, AT-15); `admin.audit.recorded.v1` (staff-команды: `ticket.reply`, `ticket.note`, `ticket.status`,
`ticket.assign`, `ticket.take`, `ticket.priority`, `ticket.escalate`, `sla.change`; без текстов сообщений);
`user.domain.deleted.v1 {domain: support, mode: anonymized}`.

Потребляет: `user.deletion.requested.v1` (durable `support.user_deleted`, только от identity-consent; от другого
издателя — игнор с предупреждением) → обезличивание: `user_id → NULL`, тексты ученика и тема → «[удалено по запросу
пользователя]», контекст и `correlation_id` очищаются, открытые обращения закрываются системой. Ответы операторов,
заметки, история и эскалации сохраняются. Повтор рассылки сагой (новый `event_id`, тот же `request_id`) снова
подтверждается.

## Данные
Схема `support`: `tickets` (номер из `ticket_number_seq` с 3000, `UNIQUE(user_id, idempotency_key)`, CHECK категорий
TilHero), `messages` (`visibility` public/internal, CHECK: internal только у оператора; `UNIQUE(ticket_id, client_key)`),
`status_history`, `escalations` (`UNIQUE(ticket_id, idempotency_key)`), `sla_policies`, `deleted_users` (миграция
0002), `outbox`, `inbox`. Модели SQLAlchemy — зеркало миграций, сверка — `tests/test_support_schema.py`. PII: только
`user_id` ученика и тексты, написанные им.

## Runbook
- Миграции: `alembic -c alembic.ini upgrade head` (Railway preDeploy) под ролью-владельцем `support_owner`
  (`MIGRATION_DATABASE_URL`); сервис работает под ролью `support` (`DATABASE_URL`, только DML) — `infra/db/bootstrap.sql`.
- Локально: `infra/dev/stack.sh up`, затем
  `ENV=dev DATABASE_URL=postgresql://support:dev@127.0.0.1:5432/tilhero NATS_URL=nats://127.0.0.1:4222 uv run uvicorn tilhero_support.main:app --port 8103`.
- Тесты: `uv run pytest services/support -q`.
- Очередь просрочек: `GET /admin/v1/support/tickets?sla=breached&sort=sla`.
- Ответ оператора не дошёл до ученика: проверить `support.ticket.replied.v1` в outbox (`published_at`), затем журнал
  notifications (центр уведомлений и `telegram_status`).
