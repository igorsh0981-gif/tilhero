# identity-consent

**Владелец:** команда Telegram-контура. **Bounded context:** идентичность пользователя Telegram (снимок профиля после проверки initData в BFF), подтверждение 18+, согласия на обработку данных с доказательством, PIN и биометрия, отключение TilHero, запрос удаления и обезличивание профиля (ТЗ Telegram TG-FR-001…007).

Единственный сервис, который хранит Telegram ID, username и имя; остальные знают только `user_id`.

Порт 8101, схема PostgreSQL `identity_consent`, Redis (попытки PIN, коды сброса).

## API
Все пути — внутренние, только с внутренним JWT (`x-internal-token`, `aud = identity-consent`). `user_id` берётся **только** из `sub` токена. Чужой или несуществующий пользователь → 404 `USER_NOT_FOUND`. Формы ответов совпадают с `packages/contracts/src/bff.ts`.

| Метод | Путь | Вызывает | Ответ / ошибки |
|---|---|---|---|
| POST | `/internal/v1/users/telegram-login` | telegram-bff | `{user, security, consent, settings, onboarding_completed: null}`; новый профиль → `is_new=true` + `user.profile.created.v1` |
| GET | `/internal/v1/me` | telegram-bff | `{user, security, consent, settings}` |
| PATCH | `/internal/v1/me/settings` | telegram-bff | `SettingsPatch` → как GET /me; 409 `USER_DISABLED` (включение уведомлений при отключённом TilHero) |
| PUT | `/internal/v1/me/pin` | telegram-bff | `{pin, current_pin?}` → `SecurityState`; 422 `PIN_FORMAT {reason}`, 409 `PIN_ALREADY_SET`, 401 `PIN_INVALID {remaining}`, 423 `PIN_LOCKED {retry_after}` |
| DELETE | `/internal/v1/me/pin` | telegram-bff | `{current_pin}` → `SecurityState` (биометрия снимается вместе с PIN); 409 `PIN_NOT_SET` |
| POST | `/internal/v1/me/pin/verify` | telegram-bff | `{pin}` → `{ok: true}`; 401/423; 409 `PIN_NOT_SET` |
| POST | `/internal/v1/me/pin/reset-request` | telegram-bff | → `{expires_in: 600}`; код — синхронно в notifications (`POST /internal/v1/notifications/transactional`); 429 `PIN_RESET_TOO_OFTEN {retry_after}`, 409 `PIN_NOT_SET`, 409 `BOT_BLOCKED`, 503 `UPSTREAM_UNAVAILABLE` (notifications недоступен — лимит не расходуется) |
| POST | `/internal/v1/me/pin/reset-confirm` | telegram-bff | `{code, new_pin}` → `SecurityState`; 401 `RESET_CODE_INVALID {remaining}`, 410 `RESET_CODE_EXPIRED`, 422 `PIN_FORMAT` |
| PUT | `/internal/v1/me/biometric` | telegram-bff | → `{biometric_token, security}`; 409 `PIN_REQUIRED` |
| DELETE | `/internal/v1/me/biometric` | telegram-bff | → `SecurityState` (идемпотентно) |
| POST | `/internal/v1/me/biometric/verify` | telegram-bff | `{biometric_token}` → `{ok: true}`; 401 `BIOMETRIC_INVALID {remaining}`, 423, 409 `BIOMETRIC_NOT_ENABLED` |
| GET | `/internal/v1/legal/policy?lang=ru` | telegram-bff | `PolicyDocument`; `lang` сводится к ru/en по тому же правилу, что и `language_code` |
| POST | `/internal/v1/me/consent` | telegram-bff | `ConsentRequest` → `ConsentState`; 422 `AGE_CONFIRMATION_REQUIRED`, 409 `POLICY_VERSION_OUTDATED {current_policy_version}`, 422 `CONSENT_PURPOSES_INVALID {unknown, missing_required}` |
| DELETE | `/internal/v1/me/consent` | telegram-bff | → `ConsentState` (отзыв; идемпотентно) |
| POST | `/internal/v1/me/disable`, `/enable` | telegram-bff | → как GET /me |
| POST | `/internal/v1/me/deletion-request` | telegram-bff | `{pin?, confirm_word?}` → **202** `{request_id, status: "REQUESTED", domains}`; 422 `DELETION_CONFIRMATION_REQUIRED {method}`, 401/423 при PIN |
| GET | `/internal/v1/users/{user_id}/delivery` | **только** notifications | `{telegram_user_id, locale, notifications_enabled, quiet_hours, digest_time, timezone, status}`; 404 для удалённых |
| POST | `/internal/v1/telegram-users/{telegram_user_id}/bot-status` | **только** telegram-bot-gateway | `{blocked}` → 204; `blocked=true` выключает уведомления; 404 неизвестный Telegram ID |

### Админ-контур (спринт 2)
| Метод | Путь | Вызывает | Ответ / ошибки |
|---|---|---|---|
| GET | `/admin/v1/users?updated_after=&cursor=&limit=` | **только** user-admin, без `actor`/`sub` (иначе 403 `CALLER_CONTEXT_NOT_ALLOWED`) | `{items, next_cursor}` по возрастанию `(updated_at, user_id)`; элемент — `{user_id, username, display_name, telegram_id_masked, locale, status, created_at, updated_at, last_seen_at, consent{policy_version, purposes, accepted_at, age_confirmed_18_plus, revoked_at}, security{pin_enabled, biometric_enabled}}`; удалённые профили тоже отдаются (без PII); 400 `INVALID_CURSOR`, 422 (`updated_after` без часового пояса) |
| GET | `/admin/v1/users/{user_id}` | **только** user-admin | тот же снимок; 404 `USER_NOT_FOUND` |
| POST | `/admin/v1/users/{user_id}/reveal` | **только** admin-bff с `actor` и правом `users.sensitive.read` | `{field: "telegram_user_id", reason (5…500)}` → `{field, value, expires_in: 60}` + `Cache-Control: no-store`; сначала синхронная запись `sensitive.view` в audit (`POST /internal/v1/records`, `on_behalf_of` = сотрудник, причина, user_id; значения в записи нет); audit недоступен/отказал → 503 `UPSTREAM_UNAVAILABLE {service: "audit"}`, значение не выдаётся; квота — 20 раскрытий в час на сотрудника (Redis `rl:identity:reveal:<staff_id>`), превышение → 429 `RATE_LIMITED {retry_after}` + `Retry-After` и запись аудита `sensitive.view_rate_limited`; удалённый/неизвестный → 404 |

Полный Telegram ID в админ-контуре — только в ответе reveal: в снимках маска `••••••789`, в событиях, логах и аудите его нет.
`users.updated_at` двигается при входе (`last_seen_at`) и при любом изменении пользователя, включая согласие, PIN и
биометрию (каждое событие с `user_id` в `_emit`), — по нему user-admin курсорно сверяет read-модель (индекс
`ix_users_updated_at`, миграция 0002). Индекс строится `CREATE INDEX CONCURRENTLY IF NOT EXISTS` в autocommit-блоке (невалидный остаток прерванной сборки пересоздаётся). Настройки: `AUDIT_URL`, `AUDIT_TIMEOUT_SECONDS`, `REVEAL_EXPIRES_IN_SECONDS`, `REVEAL_LIMIT_PER_WINDOW` (20), `REVEAL_WINDOW_SECONDS` (3600).

После запроса удаления любые изменения профиля → 409 `USER_DELETION_REQUESTED` (BFF отвечает клиенту 410 `USER_DELETED`).

### Сага удаления — модуль `deletion/` (спринт 9, ADR-009; `docs/sprint9/INTERNAL_API.md` §1)
| Метод | Путь | Вызывает | Ответ / ошибки |
|---|---|---|---|
| GET | `/admin/v1/deletions?status=open\|stuck\|completed&cursor=&limit=` | **только** admin-bff, `actor` с `users.read` | `{items: [DeletionRow], next_cursor}`, новые сверху; `open` = REQUESTED + STUCK; 422 (статус, курсор, limit) |
| GET | `/admin/v1/deletions/{request_id}` | admin-bff, `users.read` | `DeletionDetail` = `DeletionRow` + `domains: [{domain, acked_at, mode, acked}]` + `history: [{attempt, sent_at, by}]` (`by`: `user` — запрос, `system` — таймер, иначе staff_id); 404 `DELETION_NOT_FOUND` |
| POST | `/admin/v1/deletions/{request_id}:retry` | admin-bff, `ops.queues.manage` (step-up — admin-bff) | `Idempotency-Key` + `{reason}` (3..300) → синхронный аудит `user.deletion.retry` (`on_behalf_of`) **до** повтора → внеочередной повтор → `DeletionDetail`. 409 `DELETION_NOT_OPEN`, 409 `DELETION_RETRY_TOO_SOON {retry_after}` (чаще `DELETION_MANUAL_RETRY_MIN_SECONDS`), 503 `AUDIT_UNAVAILABLE` (ничего не меняется), 400 `IDEMPOTENCY_KEY_REQUIRED`, 422 `IDEMPOTENCY_KEY_INVALID`/`IDEMPOTENCY_KEY_REUSED`; повтор ключа — тот же ответ + `Idempotent-Replayed: true` |
| GET | `/internal/v1/deletions:stats` | **только** ops-monitor, без `actor`/`sub` | `{open, stuck, oldest_open_at, pending_by_domain: {domain: n>0}, stuck_items: [{request_id, requested_at, stuck_at, attempts, pending_domains}] ≤ 50}` — без `user_id` |

`DeletionRow` = `{request_id, user_id, status: REQUESTED|STUCK|COMPLETED, requested_at, completed_at, stuck_at, attempts, next_retry_at, acked, expected, pending_domains}`; PII нет (`user_id` — псевдоним).

OpenAPI: `/openapi.json`, `/docs` (кроме prod). Health: `/health/live`, `/health/ready` (БД, Redis, NATS).

## Правила
- **Locale** из `language_code`: ru/uz/kk/be/uk → `ru`, иначе (в т.ч. пусто) → `en`. Задаётся при создании, дальше меняет только пользователь.
- **PIN:** 4 или 6 ASCII-цифр; тривиальные (все одинаковые, возрастающие или убывающие подряд: 0000, 1234, 4321, 123456, 987654) → 422 `PIN_FORMAT`. Хеш Argon2id (argon2-cffi, RFC 9106 low-memory) с прозрачным перехешированием при смене параметров. Смена и снятие — только с текущим PIN. Повторная установка без `current_pin` → 409 `PIN_ALREADY_SET`.
- **Попытки:** общий счётчик `AttemptLimiter(redis, "pin", 5, 300)` для PIN, биометрии и PIN при удалении: 5 неудач → блок 5 минут (423), событие `pin_locked`. Проверки одного пользователя сериализуются блокировкой строки (`SELECT … FOR UPDATE`) — параллельные запросы не дают больше 5 попыток. Успешная проверка обнуляет счётчик.
- **Сброс PIN:** 6-значный код (`secrets.randbelow`), в Redis только `HMAC-SHA256(user_id:code)` с ключом, выведенным из `INTERNAL_JWT_SECRET`; TTL 600 с; 5 попыток (счёт атомарный, до сравнения); код одноразовый; новый код заменяет старый. Не чаще 1 раза в 60 с и 5 раз в сутки (окно от первого запроса). Успешный сброс снимает блокировку и отключает биометрию (её нужно включить заново). Код уходит **синхронно** в notifications `POST /internal/v1/notifications/transactional` (`iss=identity-consent`, тело `{notification_id, user_id, template: "pin.reset_code", params: {code, ttl_minutes}, dedup_key}`, `Idempotency-Key = notification_id`) — ни в событиях, ни в outbox, ни в JetStream кода нет (ревью P2). Ответ `sent`/`queued` — успех; `failed blocked` → 409 `BOT_BLOCKED`; иное/недоступность → 503 `UPSTREAM_UNAVAILABLE`, код аннулируется, резерв лимита (cooldown и суточный счётчик) возвращается.
- **Биометрия:** только при заданном PIN; токен `secrets.token_urlsafe(32)`, хранится sha256, сравнение `hmac.compare_digest`; повторное включение выпускает новый токен.
- **Согласие:** политика `CURRENT_POLICY_VERSION` (1.0) с текстом RU/EN в `domain/policy.py`; цели `personalization` (обязательно) и `notifications` (по желанию). Нужны `age_confirmed_18_plus=true` и актуальная версия. Повтор того же набора — без новой записи; другой набор — новая запись, прежняя помечается `superseded`. `evidence_hash = sha256(канонический JSON {user_id, policy_version, purposes, accepted_at (UTC, мс, Z), channel, locale, policy_text_sha256})` — пересчитывается из строки БД. Строки `consents` неизменяемы (триггер), отзыв фиксируется один раз.
- **Уведомления:** при регистрации выключены; согласие включает их, если выбрана цель `notifications`; отзыв согласия и отключение TilHero выключают; включение TilHero восстанавливает по действующему согласию. Блокировка бота выключает, разблокировка сама не включает.
- **Удаление:** с PIN — подтверждение PIN, без PIN — слово «УДАЛИТЬ» / «DELETE» (без учёта регистра и пробелов по краям). Статус `DELETION_REQUESTED`, запись в `deletion_requests` (ждём `DELETION_DOMAINS`), события `user.deletion.requested.v1` и `user.status.changed.v1`. Повтор возвращает тот же запрос. Когда все домены прислали `user.domain.deleted.v1`, профиль обезличивается: Telegram ID, username, имя → NULL, PIN и биометрия удаляются, действующее согласие помечается `deletion`, статус `DELETED`; публикуются `user.domain.deleted.v1 {domain: "identity-consent", mode: "anonymized"}` и `user.status.changed.v1`. Повторный вход того же Telegram ID создаёт новый профиль.
- **Сага удаления (спринт 9):** первичная рассылка — `attempt: 1`. Таймер (`deletion/sweeper.py`, раз в `DELETION_SWEEP_SECONDS`, одна реплика — `pg_try_advisory_xact_lock`, строки `FOR UPDATE SKIP LOCKED`) повторяет `user.deletion.requested.v1` (новый `event_id`, тот же `request_id`, `attempt: n`) в точках `requested_at + DELETION_RETRY_SCHEDULE_MINUTES` (15, 60, 240, 720, 1440), дальше раз в сутки, пока запрос открыт; после любой рассылки следующий повтор — первая точка расписания позже неё. Запрос рассылается всем доменам; ACK уже ответивших отбрасывается (время первого ACK сохраняется в `deletion_domain_acks`). Через `DELETION_STUCK_HOURS` без полного ACK → `STUCK` + `user.deletion.stuck.v1` (один раз), повторы продолжаются; полный ACK завершает и из `STUCK`. **Принудительного завершения без ACK нет.**

## События
Публикует (outbox, схемы `packages/contracts/events`):

| Событие | Когда |
|---|---|
| `user.profile.created.v1` | новый профиль |
| `user.security.changed.v1` | `pin_set`, `pin_changed`, `pin_removed`, `pin_reset`, `pin_locked`, `biometric_enabled`, `biometric_disabled` |
| `consent.accepted.v1` / `consent.revoked.v1` | новое согласие / отзыв пользователем |
| `user.status.changed.v1` | disable/enable, запрос удаления, обезличивание (`previous_status`, `reason_code`) |
| `user.deletion.requested.v1` | запрос удаления (`attempt: 1`) и повторы саги (тот же `request_id`, новый `event_id`, `attempt: n`) |
| `user.deletion.stuck.v1` | спринт 9: запрос без полного ACK дольше `DELETION_STUCK_HOURS` (`{request_id, user_id, requested_at, stuck_at, pending_domains, attempts}`) |
| `user.domain.deleted.v1` | собственный ACK после обезличивания |

Потребляет: `user.domain.deleted.v1` (durable `identity-consent.deletion_acks`; inbox-дедупликация; свои, чужие и неожиданные ACK игнорируются).

## Данные
Схема `identity_consent`:
- `users` — `user_id`, `telegram_user_id` (UNIQUE, NULL после удаления), `username`, `display_name`, `locale`, `status`, `age_confirmed_18_plus` + `age_confirmed_at`, `notifications_enabled`, `quiet_hours_start/end`, `digest_time`, `timezone` (по умолчанию Asia/Tashkent), `bot_blocked`, `created_at`, `last_seen_at`, `updated_at`. CHECK: у `DELETED` нет Telegram-идентичности.
- `consents` — история: `consent_id`, `user_id`, `policy_version`, `purposes[]`, `accepted_at`, `revoked_at` + `revoke_reason` (user/superseded/deletion), `channel`, `locale`, `age_confirmed_18_plus`, `policy_text_sha256`, `evidence_hash`. Не больше одного действующего согласия на пользователя (частичный уникальный индекс); UPDATE/DELETE ограничены триггером `consents_guard`.
- `pin_credentials` (Argon2id-хеш, длина 4/6), `biometric_credentials` (sha256 токена).
- `deletion_requests` — `request_id`, `status` (REQUESTED/STUCK/COMPLETED), `requested_at`, `completed_at`, `expected_domains[]`, `acked_domains[]`, `attempts`, `last_sent_at`, `next_retry_at`, `stuck_at`, `last_retry_by`; не больше одного открытого (REQUESTED или STUCK) запроса на пользователя. Миграция 0003 (спринт 9).
- `deletion_domain_acks` (PK `request_id, domain`) — время, режим и `event_id` ACK; ACK до спринта 9 перенесены без времени. `deletion_attempts` (PK `request_id, attempt`) — история рассылок. `deletion_idempotency_keys` (PK `actor_id, key`) — ручной повтор.
- `outbox`, `inbox` — `tilhero_common.messaging`.

Redis: `pin:fail:<user_id>`, `pin:lock:<user_id>`, `pin_reset:code:<user_id>` (hash `h`=HMAC, `a`=попытки), `pin_reset:cooldown:<user_id>`, `pin_reset:daily:<user_id>`.

## Переменные окружения
| Переменная | По умолчанию | Назначение |
|---|---|---|
| `DATABASE_URL` | — | Postgres с ролью `identity_consent` (рантайм, только DML) |
| `MIGRATION_DATABASE_URL` | = `DATABASE_URL` | роль-владелец `identity_consent_owner` для preDeploy-миграций (`infra/db/bootstrap.sql`) |
| `NOTIFICATIONS_URL` | `http://127.0.0.1:8104` | notifications (синхронная доставка кода сброса PIN) |
| `DB_SCHEMA` | `identity_consent` | схема сервиса |
| `REDIS_URL` | — | обязательно в prod (попытки PIN, коды сброса) |
| `NATS_URL` | — | JetStream |
| `INTERNAL_JWT_SECRET` | dev-секрет | ≥32 символов в stage/prod; также ключ HMAC кодов сброса |
| `INTERNAL_JWT_PRIVATE_KEY`, `INTERNAL_JWT_PUBLIC_KEYS` | — | внутренний JWT EdDSA, обязательны в stage/prod (`infra/scripts/gen_internal_keys.py`) |
| `ENV` (обязательна), `LOG_LEVEL`, `PORT` | —, `INFO`, 8000 | `dev`\|`test`\|`stage`\|`prod` |
| `CURRENT_POLICY_VERSION` | `1.0` | действующая версия политики (должна быть в `domain/policy.py`) |
| `DEFAULT_TIMEZONE` | `Asia/Tashkent` | |
| `PIN_MAX_ATTEMPTS`, `PIN_LOCK_SECONDS` | 5, 300 | |
| `PIN_RESET_CODE_TTL_SECONDS`, `PIN_RESET_CODE_MAX_ATTEMPTS` | 600, 5 | |
| `PIN_RESET_MIN_INTERVAL_SECONDS`, `PIN_RESET_DAILY_LIMIT` | 60, 5 | |
| `DELETION_DOMAINS` | `["preferences","support","notifications","offers","recommendations","watch","news","ai-concierge","ai-control"]` | JSON-список доменов, чей ACK нужен до обезличивания (offers — спринт 5; recommendations, watch, news — 6; ai-concierge, ai-control — 7) |
| `DELETION_RETRY_SCHEDULE_MINUTES` | `15,60,240,720,1440` | спринт 9: точки повтора от запроса (минуты по возрастанию), дальше раз в сутки |
| `DELETION_STUCK_HOURS` | 24 | через сколько часов без полного ACK запрос — `STUCK` |
| `DELETION_SWEEP_SECONDS` | 60 | период таймера саги (0 — выключен); в логе раз в период `deletion sweep ok` |
| `DELETION_MANUAL_RETRY_MIN_SECONDS` | 300 | ручной повтор сотрудником — не чаще |

## Runbook

> Эксплуатация через браузер (Railway, админка, оповещения ops-monitor): [docs/runbooks/identity-consent.md](../../docs/runbooks/identity-consent.md). Ниже — технические детали для разработчика.
- **Миграции:** `alembic -c alembic.ini upgrade head` (Railway preDeploy). Локально: `DATABASE_URL=postgresql://identity_consent:dev@127.0.0.1:5432/tilhero REDIS_URL=redis://127.0.0.1:6379/0 uv run uvicorn tilhero_identity.main:app --port 8101`.
- **Тесты:** `uv run pytest services/identity-consent -q` (стенд `infra/dev/stack.sh up`; схема временная, Redis db 15).
- **Пользователь заблокирован (423):** блокировка снимается сама через 5 минут или успешным сбросом PIN кодом из бота. Вручную (по обращению в поддержку, после проверки личности): `DEL pin:lock:<user_id> pin:fail:<user_id>`.
- **Код сброса не приходит:** проверить `bot_blocked` у пользователя (409 `BOT_BLOCKED`), ответы 503 `UPSTREAM_UNAVAILABLE` (доступность notifications, `NOTIFICATIONS_URL`), журнал notifications (`template = 'pin.reset_code'`, `status`, `failure_reason`) и `telegram.delivery.failed.v1`.
- **Сага удаления:** ACK `user.domain.deleted.v1` принимается только от самого домена (`producer == domain`), повторные и параллельные ACK идемпотентны (FOR UPDATE запроса удаления + inbox).
- **Удаление зависло** (`STUCK`, оповещение ops-monitor `deletion_stuck`): админка «Пользователи → Удаления» (или `GET /admin/v1/deletions?status=stuck`) — какой домен не прислал ACK → его логи и DLQ `tilhero.dlq.<consumer>` → поднять сервис → «Повторить запрос» (`POST /admin/v1/deletions/{id}:retry`). Таймер и так повторяет запрос раз в сутки.
- **Проверка доказательства согласия:** пересчитать `evidence_hash` по строке `consents` (`tilhero_identity.domain.evidence.evidence_hash`) и сравнить; `policy_text_sha256` — с `get_policy(version).text_sha256(locale)`.
- **Новая редакция политики:** добавить версию в `domain/policy.py` (старые тексты не менять), выставить `CURRENT_POLICY_VERSION`; клиенты получат `consent.policy_version != current_policy_version` и попросят согласие заново.
