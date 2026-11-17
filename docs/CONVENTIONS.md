# TilHero — соглашения разработки

Обязательны для всех сервисов. Отклонение — только через ADR в `docs/adr/`.

## 1. Структура Python-сервиса

```
services/<name>/
  pyproject.toml          # name = "tilhero-<name>", зависимость tilhero-common = { workspace = true }
  README.md               # владелец, bounded context, API, события (публикует/потребляет), данные, runbook
  Dockerfile              # шаблон infra/docker/python.Dockerfile, контекст сборки — корень репозитория
  alembic.ini
  migrations/env.py       # tilhero_common.migrations.run_migrations(...)
  migrations/versions/*.py
  src/tilhero_<pkg>/
    settings.py           # class Settings(ServiceSettings), get_settings() с lru_cache
    models.py             # SQLAlchemy 2.0 typed models, свой Base; таблицы без схемы (search_path)
    schemas.py            # Pydantic-модели API (extra="forbid" на входе)
    domain/               # бизнес-правила без FastAPI (чистые функции/классы — легко тестировать)
    api/                  # роутеры: client.py (через BFF), staff.py (через admin-bff), internal.py
    consumers.py          # обработчики событий
    main.py               # app = create_app(settings, routers=[...], runtime=runtime)
  tests/                  # pytest: unit (domain) + api (httpx.ASGITransport) на реальном PG/Redis
```
Имя Python-пакета уникально: `tilhero_identity`, `tilhero_learning_plan`, `tilhero_social`, `tilhero_support`, `tilhero_notifications`, `tilhero_audit`, `tilhero_experience`, `tilhero_botgw` — все сервисы живут в одном dev-окружении uv.

## 2. API
- Версии в пути: клиентские `/v1/...`, админские `/admin/v1/...` (только admin-bff), внутренние `/internal/v1/...`.
- Домены доступны только по внутреннему JWT: `Depends(InternalAuth({"telegram-bff"}))`. Разрешённых вызывающих перечисляем явно.
- **user_id — только из токена** (`principal.user_id`), никогда из пути или тела (IDOR).
- Права сотрудников — в домене: `principal.require_permission("support.reply")`. Имена прав — из ТЗ Admin (`users.read`, `users.sensitive.read`, `subscriptions.override`, `billing.refund`, `skills.edit`, `skills.publish`, `support.reply`, `audit.read`, `ops.kill_switch`, …).
- Вход — Pydantic с `model_config = ConfigDict(extra="forbid")`; строки с `max_length`; URL — `HttpUrl` и только https.
- Ошибки — `ApiError` с бизнес-кодом в UPPER_SNAKE (`SUPPORT_TICKET_NOT_FOUND`). Сообщение на русском, клиенты переводят по коду.
- Списки — всегда пагинация: `?limit=` (≤100, по умолчанию 20) + `cursor` (непрозрачный) → `{"items": [...], "next_cursor": "..."|null}`.
- Команды, создающие сущности, принимают заголовок `Idempotency-Key`; уникальность обеспечивается ограничением в БД (`UNIQUE(user_id, idempotency_key)`), повтор возвращает тот же результат.
- Деньги — `Decimal`/`NUMERIC(12,2)` + `currency` (ISO 4217); в JSON — строкой или числом с 2 знаками; никогда float в расчётах.
- ID — UUID (`uuid4`). Человекочитаемые номера (TCK-3081) — отдельное поле.
- Время — UTC `timestamptz`, в JSON ISO-8601 с `Z`.

## 3. Данные
- Своя схема и своя роль PostgreSQL; к чужим схемам доступа нет. Чужие данные — через API или проекции из событий.
- Две роли на сервис (`infra/db/bootstrap.sql`): `<svc>_owner` владеет схемой и таблицами, под ним идут только миграции
  (`MIGRATION_DATABASE_URL`); сервис работает под `<svc>` (`DATABASE_URL`) — USAGE + DML, без DDL/TRUNCATE, поэтому
  не может снять триггеры неизменяемости. Тест каждого сервиса прогоняет миграции и рантайм под этими ролями
  (`tilhero_common.testing.migrated_under_roles`).
- Модели SQLAlchemy — зеркало миграций: UNIQUE, индексы и CHECK объявляются и в `__table_args__`; тест сверки
  (`tilhero_common.testing.schema_drift`) обязателен в каждом сервисе.
- outbox — не архив: опубликованные записи удаляются через `OUTBOX_RETENTION_HOURS` (72). Секреты (коды, токены)
  в события и outbox не кладутся — только синхронным вызовом сервиса-получателя.
- Миграции Alembic обязательны, в том числе для outbox/inbox (`messaging_metadata`). Без autogenerate в CI: миграции пишутся и ревьюются руками.
- Мягкое удаление (`is_deleted`) — для бизнес-сущностей. **Исключение:** персональные данные по запросу удаления пользователя удаляются или обезличиваются физически (ТЗ TG-FR-006), с сохранением обязательных для аудита полей.
- PII минимизируем: Telegram ID и username хранит только identity-consent; остальные сервисы знают только `user_id`.

## 4. События
- Публикация только через `emit(session, ...)` (outbox) внутри транзакции изменения.
- Имя: `<context>.<entity>.<action>.v<N>` — как в ТЗ (`support.ticket.created.v1`). Payload — только ID и необходимые поля, без PII (кроме notifications-адресации внутри доверенного контура).
- Схема каждого события — `packages/contracts/events/<event_type>.schema.json`; изменение payload несовместимым образом = новая версия `.v2`.
- Потребитель: `runtime.add_consumer("<service>.<purpose>", [...], handler)`; обработчик идемпотентен (inbox) и сам публикует последствия через outbox.

## 5. Безопасность
- Секреты только в переменных окружения Railway. В коде, логах, ответах — никогда.
- PIN и коды: Argon2id, сравнение за постоянное время, попытки — `AttemptLimiter` (5 → блок 5 мин).
- В логи не пишем PII и пользовательский текст (фильтр `tilhero_common.logging` вычищает известные ключи — не обходить).
- Веб-контент и тексты пользователей — недоверенные данные; в HTML никогда не вставляются без экранирования.

## 6. Тесты (минимум для каждого эндпоинта)
happy path; 401 без/с неверным внутренним токеном; 403 для чужого вызывающего/без права; 404; 422 валидация; идемпотентность повтора; изоляция пользователей (чужой user_id → 404, не 403, чтобы не раскрывать существование). Для событий — публикация через outbox и дедупликация потребителя. Тесты идут на реальном стенде (`infra/dev/stack.sh up`), схема БД — временная (`tilhero_common.testing`).

## 7. TypeScript (BFF, Mini App)
- Node 22, ESM, `strict: true`, без `any` в публичных интерфейсах.
- BFF: Fastify 5 + `@tilhero/ts-common` (контекст трассировки, формат ошибок, внутренний JWT, клиент сервисов, health). Валидация входа JSON Schema (TypeBox).
- Mini App: React 18 + Vite + TS; доступ к Telegram только через `src/tg/` (обёртка над `window.Telegram.WebApp`); данные — через типизированный API-клиент; тексты — только через i18n-словарь RU/UZ (латиница); стили — только CSS-слои и токены `@tilhero/ui-tokens` (никаких inline-цветов).
- Тесты: vitest; для Mini App — testing-library + Playwright e2e на 3 вьюпортах.

## 8. Дети и подростки (TilHero)
- `user_id` в доменах — **ученик** (learner). Ребёнок 6–13 — отдельный ученик без своего Telegram-аккаунта, связанный с родителем (`guardian_links` в identity-consent). BFF выдаёт токен с `sub` = аккаунт Telegram и `lrn` = активный ученик; во внутренний JWT к учебным доменам кладётся `sub` = ученик.
- Возраст хранит только identity-consent (`age_band`: `6-9`, `10-13`, `14-17`, `18+`). Другие сервисы получают только признак `is_minor`/`age_band` в событиях и адресации — без даты рождения.
- Для детей 6–13: никаких публичных рейтингов, чатов и сообщений от незнакомых; уведомления — родителю, не позже 20:00 по местному времени, без формулировок о «потере» и «провале».
- Игровые очки, монеты, серия и лиги никогда не влияют на учебные оценки и уровень языка.

## 9. Git
- Ветка спринта `sprint/<N>-<slug>`, PR в `main`. Коммиты — Conventional Commits (`feat(support): …`).
- Перед PR: lint, typecheck, тесты, независимое ревью другим агентом, QA-отчёт спринта в `docs/qa/`.
