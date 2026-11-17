# identity-consent

**Владелец:** команда Telegram-контура. **Bounded context:** аккаунт Telegram (снимок профиля после проверки initData в BFF), ученики и опекунство (детские профили 6–13 на аккаунте родителя), возраст (`age_band`), согласия на обработку данных с доказательством, согласие родителя для 14–17 по ссылке, код родителя (PIN) и биометрия, настройки уведомлений по категориям, отключение TilHero, сага удаления и обезличивание (INTERNAL_API §1, CONVENTIONS §8).

Единственный сервис, который хранит Telegram ID, username, имя аккаунта, имя ребёнка и возраст; остальные знают только `user_id` (ученик) и получают `age_band` / `is_minor` из событий и `DeliveryInfo`.

Порт 8101, схема PostgreSQL `identity_consent`, Redis (попытки кода родителя, коды сброса).

## Ученики
- `users.kind = account` — аккаунт Telegram: сам ученик 14+ или родитель. Возраст аккаунта — только `14-17` или `18+` (`PUT /me/age`, один раз; дальше — через поддержку).
- `users.kind = child` — детский профиль 6–13: `telegram_user_id` NULL, `display_name` — имя ребёнка, опекун — `guardian_links` (у ребёнка один опекун, ≤ `MAX_CHILDREN` = 5 детей на аккаунт). Создаёт только аккаунт `18+`; создание = согласие родителя на обработку данных ребёнка (запись `consents` с `basis = guardian`, `granted_by_user_id` = родитель, обязательные цели). Сам детский профиль ничего не вызывает: `sub` = ребёнок на `/me/*` → 404 `USER_NOT_FOUND`.
- Подросток 14–17: `guardian_consent = pending` до решения родителя по ссылке (`granted | declined`); до `granted` необязательные цели согласия (`voice_recording`, `social`, `product_news`) → 403 `GUARDIAN_CONSENT_REQUIRED`. Возраст не выбран — тоже только обязательные (иначе правило обходится выбором возраста после согласия).

## API
Все пути — внутренние, только с внутренним JWT (`x-internal-token`, `aud = identity-consent`). `user_id` берётся **только** из `sub` токена (для identity `sub` — аккаунт). Чужой или несуществующий пользователь → 404 `USER_NOT_FOUND`, чужой ученик → 404 `LEARNER_NOT_FOUND`. Формы ответов совпадают с `packages/contracts/src/bff.ts`. После запроса удаления любые изменения → 409 `USER_DELETION_REQUESTED`.

| Метод | Путь | Вызывает | Ответ / ошибки |
|---|---|---|---|
| POST | `/internal/v1/users/telegram-login` | telegram-bff | `{telegram_user_id, username?, first_name, last_name?, language_code?}` → `{user, security, consent, settings, learners}`; новый аккаунт → `is_new=true` + `user.profile.created.v1 {kind: account}`; `locale` из `language_code`: `uz*` → `uz`, иначе `ru` |
| GET | `/internal/v1/me` | telegram-bff | `{user: UserSummary, security, consent: ConsentState, settings: NotificationSettings, learners}` |
| PATCH | `/internal/v1/me/settings` | telegram-bff | `SettingsPatch` без `display_name` → как GET /me; 422 `QUIET_HOURS_INVALID {field, reason}`; 409 `USER_DISABLED` (включение уведомлений при отключённом TilHero); изменение настроек уведомлений → `user.notification_settings.changed.v1`; смена языка → `user.profile.updated.v1` (аккаунт и его дети) |
| PUT | `/internal/v1/me/age` | telegram-bff | `{age_band: "14-17" \| "18+"}` → как GET /me; повтор того же — 200 без изменений; другой → 409 `AGE_ALREADY_SET {age_band}`; `6-9`/`10-13` → 422; `user.profile.updated.v1` |
| GET | `/internal/v1/me/learners` | telegram-bff | `{items: LearnerSummary[]}` — сам (`kind: self`, `is_active: true`) + дети по дате создания; `onboarding_completed=false` (заполняет BFF из learning-plan) |
| POST | `/internal/v1/me/learners` | telegram-bff | `{display_name 1..40, age_band: "6-9" \| "10-13"}` + необязательный `Idempotency-Key` → **201** `LearnerDetail`; 403 `ADULT_REQUIRED {age_band}`; 409 `CHILDREN_LIMIT {limit}`; 422 `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_KEY_INVALID`; `user.profile.created.v1 {kind: child, guardian_user_id, age_band}` + `consent.accepted.v1` ребёнка |
| GET | `/internal/v1/me/learners/{learner_id}` | telegram-bff | `LearnerDetail` (свой профиль или свой ребёнок); иначе 404 `LEARNER_NOT_FOUND` |
| PATCH | `/internal/v1/me/learners/{learner_id}` | telegram-bff | только ребёнок: `{display_name?, settings?: SettingsPatch.notifications}` → `LearnerDetail`; свой профиль → 404 `LEARNER_NOT_FOUND` (меняется через `/me/settings`); `user.profile.updated.v1 {changed_fields: [display_name]}` (имени в событии нет), `user.notification_settings.changed.v1` |
| POST | `/internal/v1/me/guardian-consent-requests` | telegram-bff | необязательный `Idempotency-Key` → `{token, expires_at}` (7 дней; ссылку `…?startapp=gc_<token>` собирает BFF); прежняя действующая ссылка → `revoked`; после `declined` — снова `pending`; 409 `GUARDIAN_CONSENT_NOT_REQUIRED {age_band, guardian_consent}` (не 14–17 или уже `granted`) |
| GET | `/internal/v1/guardian-consents/{token}` | telegram-bff (без `sub`) | `GuardianConsentPreview {teen_display_name, status: pending\|granted\|declined\|expired, expires_at}` (отозванная/истёкшая — `expired`); неизвестный и некорректный токен → 404 `GUARDIAN_CONSENT_NOT_FOUND` |
| POST | `/internal/v1/guardian-consents/{token}/accept`, `/decline` | telegram-bff, `sub` = аккаунт родителя | `GuardianConsentPreview`; 409 `GUARDIAN_CONSENT_SELF`; 403 `ADULT_REQUIRED` (родитель — аккаунт `18+`); 410 `GUARDIAN_CONSENT_EXPIRED`; 404; решённая ссылка — 200 с прежним статусом (решение не меняется); подростку `user.profile.updated.v1 {guardian_consent}` |
| PUT | `/internal/v1/me/pin` | telegram-bff | `{pin, current_pin?}` → `SecurityState`; 422 `PIN_FORMAT {reason}`, 409 `PIN_ALREADY_SET`, 401 `PIN_INVALID {remaining}`, 423 `PIN_LOCKED {retry_after}` |
| DELETE | `/internal/v1/me/pin` | telegram-bff | `{current_pin}` → `SecurityState` (биометрия снимается вместе с кодом); 409 `PIN_NOT_SET` |
| POST | `/internal/v1/me/pin/verify` | telegram-bff | `{pin}` → `{ok: true}`; 401/423; 409 `PIN_NOT_SET` |
| POST | `/internal/v1/me/pin/reset-request` | telegram-bff | → `{expires_in: 600}`; код — синхронно в notifications (`POST /internal/v1/notifications/transactional`); 429 `PIN_RESET_TOO_OFTEN {retry_after}`, 409 `PIN_NOT_SET`, 409 `BOT_BLOCKED`, 503 `UPSTREAM_UNAVAILABLE` |
| POST | `/internal/v1/me/pin/reset-confirm` | telegram-bff | `{code, new_pin}` → `SecurityState`; 401 `RESET_CODE_INVALID {remaining}`, 410 `RESET_CODE_EXPIRED`, 422 `PIN_FORMAT` |
| PUT / DELETE | `/internal/v1/me/biometric` | telegram-bff | → `{biometric_token, security}` (409 `PIN_REQUIRED`) / `SecurityState` (идемпотентно) |
| POST | `/internal/v1/me/biometric/verify` | telegram-bff | `{biometric_token}` → `{ok: true}`; 401 `BIOMETRIC_INVALID {remaining}`, 423, 409 `BIOMETRIC_NOT_ENABLED` |
| GET | `/internal/v1/legal/policy?lang=ru\|uz` | telegram-bff | `PolicyDocument {version, purposes[{code, required, title, description}], text}`; язык-тег сводится к `ru`/`uz` |
| POST | `/internal/v1/me/consent` | telegram-bff | `{policy_version, purposes}` → `ConsentState {…, purposes}`; 409 `POLICY_VERSION_OUTDATED {current_policy_version}`; 422 `CONSENT_REQUIRED_PURPOSES {missing}`; 422 `CONSENT_PURPOSES_INVALID {unknown}`; 403 `GUARDIAN_CONSENT_REQUIRED {age_band, guardian_consent, purposes}` |
| DELETE | `/internal/v1/me/consent` | telegram-bff | → `ConsentState` (отзыв; идемпотентно) |
| POST | `/internal/v1/me/disable`, `/enable` | telegram-bff | → как GET /me; `user.status.changed.v1` |
| POST | `/internal/v1/me/deletion-request` | telegram-bff | `{pin?, confirm_word?}` → **202** `{request_id, status: "REQUESTED", domains, learners}`; удаляет аккаунт и каждого ребёнка (`learners` = 1 + дети); 422 `DELETION_CONFIRMATION_REQUIRED {method}`, 401/423 при коде; повтор — тот же ответ |
| GET | `/internal/v1/users/{user_id}/delivery` | **только** notifications | `DeliveryInfo` (ниже); 404 `USER_NOT_FOUND` — удалён / не найден / нет адресата |
| GET | `/internal/v1/users/{user_id}/public` | social, notifications | `{user_id, display_name, kind, age_band, status}` — без username и Telegram ID; 404 для удалённых |
| POST | `/internal/v1/telegram-users/{telegram_user_id}/bot-status` | **только** telegram-bot-gateway | `{blocked}` → 204; 404 неизвестный Telegram ID |

`LearnerDetail` = `LearnerSummary` + `settings: NotificationSettings` этого ученика (дополнение к контракту: BFF собирает `Profile.notifications` активного ученика, в т.ч. детского профиля).

**DeliveryInfo** `{user_id, kind, recipient_telegram_user_id, recipient_is_guardian, learner_display_name, locale, age_band, is_minor, notifications_enabled, categories[], quiet_hours {start,end}|null, timezone, status}`. Для ребёнка адресат — опекун: его Telegram ID, его блокировка бота и его язык (сообщение читает родитель), `recipient_is_guardian=true`, `learner_display_name` — имя ребёнка; категории, тихие часы и часовой пояс — ребёнка. `is_minor` — для `6-9`, `10-13`, `14-17`. `notifications_enabled` — итоговая доставка в Telegram: выключатель ученика ∧ ученик и адресат `ACTIVE` ∧ адресат не заблокировал бота (центр уведомлений работает всегда).

OpenAPI: `/openapi.json`, `/docs` (кроме prod). Health: `/health/live`, `/health/ready` (БД, Redis, NATS).

## Правила
- **Настройки уведомлений** — у каждого ученика свои: категории `reminders`, `missed`, `social`, `support`, `product` (по умолчанию только `support`, остальные — явным включением), тихие часы по умолчанию 22:00–08:00 (через полночь допустимо, `null` — выключены, начало ≠ конец), часовой пояс (по умолчанию `Asia/Tashkent`). Выключатель `enabled`: у нового аккаунта выключен, первое согласие (или согласие после отзыва) его включает, отзыв согласия и отключение TilHero выключают, включение TilHero восстанавливает по действующему согласию; у детского профиля включён с создания.
- **Блокировка бота** настройки не меняет: пока бот заблокирован, доставка в Telegram выключена для аккаунта и его детей; разблокировка возвращает доставку по настройкам. Изменение статуса → `user.notification_settings.changed.v1` аккаунту и детям (сброс кэша адресации).
- **Согласие:** политика `CURRENT_POLICY_VERSION` (1.0 — **черновик**, короткие тексты RU/UZ, окончательный текст готовят юристы) в `domain/policy.py`; цели: обязательные `terms`, `privacy`, `learning`, необязательные `voice_recording`, `social`, `product_news`. Отказ от необязательных не блокирует онбординг. Повтор того же набора — без новой записи; другой набор — новая запись, прежняя `superseded`. `evidence_hash = sha256(канонический JSON {user_id, policy_version, purposes, accepted_at (UTC, мс, Z), channel, locale, policy_text_sha256, age_band, basis, granted_by})` — пересчитывается из строки БД. Строки `consents` неизменяемы (триггер `consents_guard`), отзыв фиксируется один раз.
- **Ссылка согласия родителя:** токен 32 байта base64url = `HMAC-SHA256(ключ из INTERNAL_JWT_SECRET, id запроса)`; в БД — только `sha256(token)`; повтор с тем же `Idempotency-Key` возвращает ту же ссылку. Блокировки: аккаунт подростка → строки ссылок (как при создании новой ссылки), поэтому параллельные решения и новая ссылка не блокируют друг друга взаимно.
- **Код родителя (PIN):** 4 или 6 ASCII-цифр, без тривиальных (0000, 1234, 4321, 123456, 987654) → 422 `PIN_FORMAT`. Argon2id с прозрачным перехешированием. Смена и снятие — только с текущим кодом. Попытки: общий счётчик `AttemptLimiter(redis, "pin", 5, 300)` для кода, биометрии и кода при удалении; 5 неудач → 423 на 5 минут, событие `pin_locked`; проверки одного аккаунта сериализуются `SELECT … FOR UPDATE`.
- **Сброс кода:** 6 цифр (`secrets.randbelow`), в Redis только HMAC; TTL 600 с; 5 попыток; одноразовый; не чаще 1 раза в 60 с и 5 раз в сутки. Код уходит **синхронно** в notifications (`template: "pin.reset_code"`, `Idempotency-Key = notification_id`) — ни в событиях, ни в outbox его нет. Успешный сброс снимает блокировку и отключает биометрию.
- **Удаление:** с кодом родителя — подтверждение кодом, без него — слово «УДАЛИТЬ» / «OʻCHIRISH» (без учёта регистра, пробелов по краям и вида апострофа). Аккаунт и каждый его ребёнок → `DELETION_REQUESTED`, у каждого свой `request_id` (запрос ребёнка ссылается на запрос аккаунта `parent_request_id`), события `user.deletion.requested.v1` и `user.status.changed.v1` (`reason_code`: `deletion_requested` / `guardian_deletion_requested`); действующие ссылки согласия родителя отзываются. Когда все `DELETION_DOMAINS` прислали `user.domain.deleted.v1` по запросу ученика, он обезличивается: Telegram ID, username, имя, возраст → NULL, код и биометрия удаляются, связь с опекуном снимается, действующее согласие помечается `deletion`, статус `DELETED`; `user.domain.deleted.v1 {domain: "identity-consent", mode: "anonymized"}` и `user.status.changed.v1`. Повторный вход того же Telegram ID создаёт новый аккаунт.
- **Сага удаления** (`deletion/`): первичная рассылка — `attempt: 1`. Таймер (`deletion/sweeper.py`, раз в `DELETION_SWEEP_SECONDS`, одна реплика — `pg_try_advisory_xact_lock`, строки `FOR UPDATE SKIP LOCKED`) повторяет `user.deletion.requested.v1` (новый `event_id`, тот же `request_id`, `attempt: n`) в точках `requested_at + DELETION_RETRY_SCHEDULE_MINUTES`, дальше раз в сутки, пока запрос открыт. ACK принимается только от самого домена (`producer == domain`), повторные — без эффекта (время первого ACK — `deletion_domain_acks`). Через `DELETION_STUCK_HOURS` без полного ACK → `STUCK` + `user.deletion.stuck.v1` (один раз), повторы продолжаются. **Принудительного завершения без ACK нет.** Админ-API саги (список, ручной повтор) — спринт 2.

## События
Публикует (outbox, схемы `packages/contracts/events`):

| Событие | Когда |
|---|---|
| `user.profile.created.v1` | новый аккаунт (`kind: account`) / детский профиль (`kind: child`, `guardian_user_id`, `age_band`) |
| `user.profile.updated.v1` | возраст, согласие родителя (`guardian_consent`), язык, имя ребёнка (`changed_fields`; `age_band`, `is_minor`, `locale`, `guardian_consent`; без имени) |
| `user.notification_settings.changed.v1` | изменение выключателя, категорий, тихих часов или пояса; первое согласие; блокировка/разблокировка бота (`enabled` — итоговая доставка) |
| `user.security.changed.v1` | `pin_set`, `pin_changed`, `pin_removed`, `pin_reset`, `pin_locked`, `biometric_enabled`, `biometric_disabled` |
| `consent.accepted.v1` / `consent.revoked.v1` | новое согласие (в т.ч. родителя за ребёнка; `age_band`) / отзыв пользователем |
| `user.status.changed.v1` | disable/enable, запрос удаления, обезличивание |
| `user.deletion.requested.v1` | запрос удаления ученика (`attempt: 1`) и повторы саги |
| `user.deletion.stuck.v1` | запрос без полного ACK дольше `DELETION_STUCK_HOURS` |
| `user.domain.deleted.v1` | собственный ACK после обезличивания |

Потребляет: `user.domain.deleted.v1` (durable `identity-consent.deletion_acks`; inbox-дедупликация; свои, чужие и неожиданные ACK игнорируются).

## Данные
Схема `identity_consent` (одна миграция `0001`, prod-БД ещё нет):
- `users` — `user_id`, `kind` (account/child), `telegram_user_id` (UNIQUE, NULL у детей и после удаления), `username`, `display_name`, `locale` (ru/uz), `status`, `age_band` + `age_set_at`, `guardian_consent`, `notifications_enabled`, `notify_categories TEXT[]`, `quiet_hours_start/end`, `timezone`, `bot_blocked`, `created_at`, `last_seen_at`, `updated_at`. CHECK: аккаунт — только 14-17/18+, ребёнок — без Telegram и 6-9/10-13, категории из списка, у `DELETED` нет Telegram-идентичности и имени.
- `guardian_links` (PK `child_user_id`, `guardian_user_id`, `created_at`, `idempotency_key` + `request_fingerprint`, UNIQUE (guardian, key)).
- `guardian_consent_requests` (`id`, `teen_user_id`, `token_hash` UNIQUE, `status` pending/granted/declined/expired/revoked, `guardian_user_id`, `idempotency_key`, `created_at`, `decided_at`, `expires_at`; не больше одной `pending` на подростка).
- `consents` — история: `consent_id`, `user_id`, `policy_version`, `purposes[]`, `accepted_at`, `revoked_at` + `revoke_reason` (user/superseded/deletion), `channel`, `locale`, `age_band`, `basis` (self/guardian), `granted_by_user_id`, `policy_text_sha256`, `evidence_hash`. Не больше одного действующего согласия на ученика.
- `pin_credentials` (Argon2id, длина 4/6), `biometric_credentials` (sha256 токена).
- `deletion_requests` (`status` REQUESTED/STUCK/COMPLETED, `expected_domains[]`, `acked_domains[]`, `attempts`, `last_sent_at`, `next_retry_at`, `stuck_at`, `last_retry_by`, `parent_request_id`), `deletion_domain_acks`, `deletion_attempts`.
- `outbox`, `inbox` — `tilhero_common.messaging`.

Redis: `pin:fail:<user_id>`, `pin:lock:<user_id>`, `pin_reset:code:<user_id>`, `pin_reset:cooldown:<user_id>`, `pin_reset:daily:<user_id>`.

## Переменные окружения
| Переменная | По умолчанию | Назначение |
|---|---|---|
| `DATABASE_URL` | — | Postgres с ролью `identity_consent` (рантайм, только DML) |
| `MIGRATION_DATABASE_URL` | = `DATABASE_URL` | роль-владелец `identity_consent_owner` для preDeploy-миграций |
| `DB_SCHEMA` | `identity_consent` | схема сервиса |
| `REDIS_URL` | — | обязательно в stage/prod (попытки кода, коды сброса) |
| `NATS_URL` | — | JetStream |
| `NOTIFICATIONS_URL` | `http://127.0.0.1:8104` | notifications (синхронная доставка кода сброса) |
| `INTERNAL_JWT_SECRET` | dev-секрет | ≥ 32 символов в stage/prod; ключ HMAC кодов сброса и токенов ссылки родителя |
| `INTERNAL_JWT_PRIVATE_KEY`, `INTERNAL_JWT_PUBLIC_KEYS` | — | внутренний JWT EdDSA, обязательны в stage/prod |
| `ENV` (обязательна), `LOG_LEVEL`, `PORT` | —, `INFO`, 8000 | `dev`\|`test`\|`stage`\|`prod` |
| `CURRENT_POLICY_VERSION` | `1.0` | действующая версия политики (должна быть в `domain/policy.py`) |
| `DEFAULT_TIMEZONE` | `Asia/Tashkent` | |
| `MAX_CHILDREN` | 5 | детских профилей на аккаунт |
| `GUARDIAN_CONSENT_TTL_SECONDS` | 604800 | срок ссылки согласия родителя (7 дней) |
| `PIN_MAX_ATTEMPTS`, `PIN_LOCK_SECONDS` | 5, 300 | |
| `PIN_RESET_CODE_TTL_SECONDS`, `PIN_RESET_CODE_MAX_ATTEMPTS` | 600, 5 | |
| `PIN_RESET_MIN_INTERVAL_SECONDS`, `PIN_RESET_DAILY_LIMIT` | 60, 5 | |
| `DELETION_DOMAINS` | `["learning-plan","social","notifications","support","experience-config"]` | JSON-список доменов, чей ACK нужен до обезличивания |
| `DELETION_RETRY_SCHEDULE_MINUTES` | `15,60,240,720,1440` | точки повтора от запроса, дальше раз в сутки |
| `DELETION_STUCK_HOURS` | 24 | через сколько часов без полного ACK запрос — `STUCK` |
| `DELETION_SWEEP_SECONDS` | 60 | период таймера саги (0 — выключен) |

## Runbook
- **Миграции:** `alembic -c alembic.ini upgrade head` (Railway preDeploy). Локально: `DATABASE_URL=postgresql://identity_consent:dev@127.0.0.1:5432/tilhero REDIS_URL=redis://127.0.0.1:6379/0 uv run uvicorn tilhero_identity.main:app --port 8101`.
- **Тесты:** `source .dev/testenv.sh && uv run pytest services/identity-consent -q -p no:cacheprovider` (стенд `infra/dev/stack.sh up`; схема временная, Redis db 15).
- **Аккаунт заблокирован (423):** блокировка снимается сама через 5 минут или сбросом кода из бота. Вручную (по обращению, после проверки личности): `DEL pin:lock:<user_id> pin:fail:<user_id>`.
- **Код сброса не приходит:** `bot_blocked` у аккаунта (409 `BOT_BLOCKED`), ответы 503 `UPSTREAM_UNAVAILABLE` (доступность notifications), журнал notifications (`template = 'pin.reset_code'`).
- **Родитель не может подтвердить согласие:** 403 `ADULT_REQUIRED` — у аккаунта родителя не выбран возраст 18+ (Mini App просит выбрать); 410 — ссылка истекла или подросток отправил новую; 409 `GUARDIAN_CONSENT_SELF` — ссылку открыли с аккаунта подростка.
- **Удаление зависло** (`STUCK`, событие `user.deletion.stuck.v1`): `SELECT request_id, user_id, expected_domains, acked_domains FROM deletion_requests WHERE status = 'STUCK'` → логи и DLQ (`tilhero.dlq.<consumer>`) неответившего домена → поднять сервис; таймер повторяет запрос раз в сутки. Админ-экран — спринт 2.
- **Проверка доказательства согласия:** пересчитать `evidence_hash` по строке `consents` (`tilhero_identity.domain.evidence.evidence_hash`); `policy_text_sha256` — с `get_policy(version).text_sha256(locale)`.
- **Новая редакция политики** (окончательный текст юристов): добавить версию в `domain/policy.py` (старые тексты не менять), выставить `CURRENT_POLICY_VERSION`; клиенты увидят `consent.policy_version != current_policy_version` и попросят согласие заново.
