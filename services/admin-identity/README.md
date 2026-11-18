# admin-identity

**Владелец:** admin-контур (спринт 2). **Bounded context:** учётные записи сотрудников, вход (пароль, обязательная
смена пароля, TOTP MFA), роли и матрица прав, four-eyes, `session_version` (отзыв сессий admin-bff).
Порт 8120, схема `admin_identity`, пакет `tilhero_admin_identity`. Спецификация — `docs/sprint2/INTERNAL_API.md`,
формы ответов — `packages/contracts/src/admin.ts`.

## API
Все вызовы — только от `admin-bff` (внутренний JWT EdDSA; иной издатель → 403 `CALLER_NOT_ALLOWED`).

**Вход** (`/internal/v1`, без actor): `POST auth/login`, `POST auth/password`, `POST auth/mfa/enroll/start`,
`POST auth/mfa/enroll/confirm`, `POST auth/mfa/verify`, `POST auth/step-up`, `GET staff/{id}/principal`,
`POST auth/logout` (204, только аудит). Ответы с challenge/секретом — `Cache-Control: no-store`.

Шаги: `password_change` (must_change_password) → `mfa_enroll` (привилегированная роль без MFA) → `mfa` (MFA подключена)
→ `done` (`principal`). Коды ошибок: 401 `INVALID_CREDENTIALS {remaining}` (одинаково для несуществующего email),
423 `ACCOUNT_LOCKED {retry_after}`, 403 `ACCOUNT_DISABLED`, 401 `TEMPORARY_PASSWORD_EXPIRED`, 422 `PASSWORD_WEAK {rules}`
(`min_length_12`, `letters_and_digits`, `not_email`, `not_previous`), 401 `MFA_INVALID {remaining}`,
401 `CHALLENGE_INVALID`, 423 `MFA_LOCKED {retry_after}` (step-up), 409 `MFA_NOT_ENABLED`, 409 `MFA_RESET_REQUIRED`,
501 `AUTH_MODE_UNAVAILABLE` (`AUTH_MODE=ad`).

**Staff API** (`/admin/v1`, actor обязателен, права — по роли сотрудника **из БД** ∩ `actor.permissions` (токен может
только сузить: dev-имперсонация), нет права → 403 `PERMISSION_DENIED {permission}`,
нет actor → 403 `STAFF_CONTEXT_REQUIRED`; actor должен быть существующим активным сотрудником):

| Метод | Путь | Право | Ответ |
|---|---|---|---|
| GET | `staff?q=&role=&status=&cursor=&limit=` | staff.manage | `Page<Staff>` |
| POST | `staff` (`Idempotency-Key` — необязателен) | staff.manage | 201 `StaffCreated` (временный пароль — один раз; при повторе по ключу — `null`) |
| PATCH | `staff/{id}` | staff.manage | `Staff` или 202 `{approval}` (привилегированная роль) |
| POST | `staff/{id}/reset-password` | staff.manage | `{temporary_password}` или 202 `{approval}` (привилегированная цель) |
| POST | `staff/{id}/reset-mfa` | staff.manage | `Staff` или 202 `{approval}` (привилегированная цель) |
| GET | `staff/lookup?ids=a,b` (≤100) | любой сотрудник | `{items: StaffSummary[]}` |
| GET | `roles` | staff.manage или roles.manage | `{items: Role[], permissions}` |
| PUT | `roles/{code}` | roles.manage | 202 `{approval}` |
| GET | `approvals?status=&cursor=&limit=` | staff.manage или roles.manage | `Page<Approval>` |
| POST | `approvals/{id}/approve`, `…/reject` | роль super_admin (по БД) | `ApprovalDecision` (`Approval` + `temporary_password` — только approve заявки сброса пароля) |

Защита от эскалации (403 `PERMISSION_DENIED {permission, role}`): сотрудник с `staff.manage`, но не super_admin,
меняет/сбрасывает пароль или MFA/отключает только тех, чьи права роли ⊆ его собственных, и сразу назначает (создаёт)
только такие роли; учётки super_admin — только super_admin. Привилегированные роли — по-прежнему через four-eyes.

Инварианты (409): `LAST_SUPER_ADMIN`, `SELF_ACTION` (роль/статус/сброс пароля/MFA себя), `STAFF_EMAIL_EXISTS`,
`APPROVAL_PENDING` (одна заявка на объект), `FOUR_EYES_SAME_PERSON`, `APPROVAL_EXPIRED`, `APPROVAL_NOT_PENDING`,
`APPROVAL_NOT_APPLICABLE` (объект изменился после подачи), `SUPER_ADMIN_ROLES_MANAGE`, `ROLE_UNCHANGED`.
Step-up проверяет admin-bff до вызова изменяющих команд.

**Сброс пароля/MFA привилегированного сотрудника** (ревью N1; в т.ч. коллеги с тем же набором привилегированных прав) —
только заявкой `staff.privileged_reset` (summary `{staff, action: "password"|"mfa", role}`): иначе один super_admin
сбрасывает пароль и MFA другого, входит под ним и согласует собственные заявки. Временный пароль генерируется в момент
применения и возвращается **только решающему** в ответе approve (`Cache-Control: no-store`), автору — никогда; в БД —
только argon2-хеш, в аудит/события/логи/Redis не попадает. Для цели-super_admin исключение `single_super_admin` не
действует никогда; для прочих привилегированных при единственном super_admin — применяется сразу (ответ как у прямого
сброса: `{temporary_password}` / `Staff`, заявка `APPLIED` с `waived`). Непривилегированная цель — сразу, как раньше.

**Four-eyes:** назначение привилегированной роли (`staff.role_grant`, `staff.create_privileged` — сотрудник создаётся
с ролью `read_only`), изменение матрицы (`role.permissions_change`), понижение/отключение super_admin при ≥ 2 активных
(`staff.privileged_revoke` — расширение контракта). Роль привилегированна, если она из `PRIVILEGED_ROLES` контракта
**или** содержит хотя бы одно из прав `staff.manage, roles.manage, users.sensitive.read, billing.refund,
subscriptions.override, config.publish, ops.kill_switch, ai.content.read, export.csv, sources.manage`; при применении заявки на
матрицу `roles.privileged` пересчитывается, а если роль стала привилегированной — сессии её сотрудников отзываются
(при входе — подключение MFA). Заявку автора, который уже не ACTIVE, согласовать нельзя (409 `APPROVAL_NOT_APPLICABLE`);
при отключении сотрудника его PENDING-заявки → `REJECTED`. Решает другой активный super_admin; применение —
в той же транзакции. Срок — 72 ч (истёкшие помечаются `EXPIRED` при обращении). Если автор — единственный активный
super_admin и сам не понижал/отключал super_admin за последние 72 ч, заявка применяется сразу (`status=APPLIED`, `waived="single_super_admin"`, аудит `approval.waived`);
ответ — по-прежнему 202 `{approval}`.

## События
Публикует через outbox только `admin.audit.recorded.v1` (payload = запись audit-service, `actor_type` staff/system):
`auth.login`, `auth.login_failed` (email — только sha256), `auth.locked` (вход и step-up), `auth.mfa_enrolled`, `auth.mfa_failed`,
`auth.password_changed`, `auth.step_up`, `auth.logout` (id сессии — только префикс sha256), `staff.created`,
`staff.updated`, `staff.password_reset`, `staff.mfa_reset`, `staff.bootstrap`, `role.permissions_requested`,
`approval.requested` (заявка по сотруднику), `approval.approved|rejected|applied|waived` (email сотрудника в сводке
заявки — только маской).
Пароли, коды, секреты MFA, challenge, временные пароли в события, outbox и логи не попадают (тест
`test_no_secrets_in_logs_or_audit`). Не потребляет.

## Данные
`staff` (email хранится нормализованным, `CHECK email = lower(email)` вместо citext), `roles`, `role_permissions`
(сид матрицы — миграция 0001; права спринта 4 `events.review`, `sources.manage`, `discovery.manage` — миграция 0005:
super_admin и operations, прочим ролям не выдаются; уже изменённая через four-eyes матрица не перезаписывается,
только дополняется; downgrade удаляет эти права у всех ролей и переводит открытые заявки на матрицу с ними в
`EXPIRED`; право спринта 6 `news.manage` (ленты новостей, скрытие новостей; не привилегированное) — миграция 0006 по
тем же правилам: super_admin и operations; право спринта 7 `users.access.manage` (назначение пользователю уровня
доступа к AI — лимит сообщений консьержа, с причиной, сроком и аудитом в ai-control; не привилегированное) —
миграция 0007 по тем же правилам: super_admin и operations; право спринта 8 `ops.queues.manage` (DLQ: маскированный
просмотр, повтор и удаление сообщений; **привилегированное** — MFA обязательна, назначение роли с ним — «четыре глаза») —
миграция 0008: super_admin и operations; права AI-экранов `skills.edit`, `skills.publish`,
`ai.content.read`, `ops.kill_switch` — как были), `approvals` (частичный UNIQUE `target` для PENDING), `outbox`/`inbox`.
Все изменения учёток/ролей/заявок сериализуются `pg_advisory_xact_lock`. Redis: счётчики попыток
(`{ns}:login:*` по sha256 email, `{ns}:stepup:*`), challenge (`{ns}:ch:<sha256>` — сам challenge не хранится),
idempotency создания сотрудника (без временного пароля).

## Безопасность
- argon2id (`argon2-cffi`); для неизвестного email — проверка фиктивного хеша (одинаковое время).
- Попытки резервируются атомарно до проверки секрета: параллельный залп не перебирает больше 5 вариантов.
  Вход: 5 неудач на нормализованный email → 15 мин. TOTP: 5 на challenge и общий счётчик по staff_id для входа,
  подключения MFA и step-up — 5 неудач → 423 `MFA_LOCKED` на 15 мин независимо от challenge (аудит `auth.locked
  {context: login_mfa|mfa_enroll|step_up}`), сброс при успехе, `PATCH {status: ACTIVE}` и `reset-mfa`.
  Попытки во время блокировки в аудит не пишутся (только `auth.locked`). `auth.login_failed` — не чаще раза в минуту
  на `email_hash` с полем `failures` (неудачи с прошлой записи, счётчик в Redis `{ns}:lfa:*`), блокировка — одна
  запись `auth.locked {failures}`.
- `email_hash` (аудит, ключи Redis) — HMAC-SHA256 ключом HKDF-SHA256(`ADMIN_MFA_ENC_KEY`, info
  `tilhero-admin-identity/email-hmac/v1`); после ротации ключа хеши меняются (счётчики попыток обнуляются).
- TOTP RFC 6238 (SHA-1, 6 цифр, 30 с, окно ±1), повтор шага запрещён (`mfa_last_step` под блокировкой строки).
- Секрет MFA: AES-256-GCM, `version || nonce || ct`, AAD = staff_id.
- `session_version` растёт при смене пароля, роли, статуса, сбросе пароля/MFA → admin-bff отзывает сессии.

## Переменные окружения
| Переменная | Назначение |
|---|---|
| `ENV`, `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `REDIS_URL`, `NATS_URL`, `INTERNAL_JWT_*` | как у всех сервисов; `REDIS_URL` и `DATABASE_URL` **обязательны в stage/prod** (без Redis нет блокировки перебора и challenge — сервис не стартует) |
| `ADMIN_MFA_ENC_KEY` | base64url 32 байта; **обязателен в stage/prod** (dev/test — детерминированный dev-ключ). Генерация: `python -c "import secrets,base64;print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('='))"` |
| `AUTH_MODE` | `local` (по умолчанию) или `ad` (LDAP — банковский этап, сейчас 501) |
| `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD` (≥ 12), `ADMIN_BOOTSTRAP_DISPLAY_NAME` | первый super_admin |
| `LOGIN_MAX_ATTEMPTS` (5), `LOGIN_LOCK_SECONDS` (900), `MFA_MAX_ATTEMPTS` (5), `MFA_LOCK_SECONDS` (900), `BOOTSTRAP_PASSWORD_TTL_HOURS` (72), `CHALLENGE_TTL_SECONDS` (300), `TEMP_PASSWORD_TTL_HOURS` (24), `APPROVAL_TTL_HOURS` (72) | лимиты |
| `ARGON2_TIME_COST`, `ARGON2_MEMORY_COST`, `ARGON2_PARALLELISM` | параметры argon2id (по умолчанию 3 / 64 МиБ / 4) |

## Runbook

> Эксплуатация через браузер (Railway, админка, оповещения ops-monitor): [docs/runbooks/admin-identity.md](../../docs/runbooks/admin-identity.md). Ниже — технические детали для разработчика.
- **Первый администратор.** Задать `ADMIN_BOOTSTRAP_EMAIL` и `ADMIN_BOOTSTRAP_PASSWORD`, задеплоить: при старте, если
  в `staff` нет ни одного super_admin, создаётся super_admin с `must_change_password=true` и сроком пароля 72 ч
  (аудит `staff.bootstrap`); пока первый вход не выполнен — предупреждение в лог при каждом старте; если срок истёк, а
  эта учётка — единственный super_admin, при старте пароль из переменной выдаётся заново (аудит `staff.bootstrap
  {refreshed: true}`);
  при первом входе — смена пароля и подключение TOTP. **После первого входа удалите обе переменные** из Railway.
  Повторные старты идемпотентны (super_admin уже есть → ничего не делается, даже при другом email); пока переменные
  заданы, при каждом старте в лог пишется предупреждение `remove ADMIN_BOOTSTRAP_EMAIL/ADMIN_BOOTSTRAP_PASSWORD`
  (значения не логируются). Пароль из переменной — временный: при первом входе его обязательно сменить.
- **Ротация `ADMIN_MFA_ENC_KEY`.** Ограничение: старые секреты MFA зашифрованы прежним ключом и после смены не
  расшифровываются — такие сотрудники получают 409 `MFA_RESET_REQUIRED`. Порядок: новый ключ → super_admin (с ещё
  рабочей MFA до деплоя — заранее подготовить второго) делает `reset-mfa` каждому → сотрудники подключают MFA заново
  при входе. Если пострадали все super_admin — сброс через БД (`UPDATE staff SET mfa_enabled=false, mfa_secret_enc=NULL,
  mfa_last_step=NULL, session_version=session_version+1 WHERE …`) по процедуре break-glass с записью в журнал инцидентов.
- **Разблокировка входа:** `PATCH /admin/v1/staff/{id} {status: "ACTIVE", reason}` (в том числе для уже активной
  учётки — аудит `staff.updated {login_attempts_reset: true}`, сессии не отзываются) или `reset-password` сбрасывают
  счётчик; иначе блокировка снимается сама через 15 мин. Временная блокировка живёт только в Redis и **не** меняет
  `staff.status` на `LOCKED`: иначе злоумышленник, зная email, отзывал бы сессии сотрудника (admin-bff отзывает при
  статусе ≠ ACTIVE). Статус `LOCKED` в схеме зарезервирован (контракт), сервисом не выставляется.
- Миграции: `alembic -c alembic.ini upgrade head` (Railway preDeploy, роль `admin_identity_owner`).
- Локально: `infra/dev/stack.sh up`, затем
  `ENV=dev DATABASE_URL=postgresql://postgres@127.0.0.1:5432/tilhero REDIS_URL=redis://127.0.0.1:6379/0 NATS_URL=nats://127.0.0.1:4222 uv run uvicorn tilhero_admin_identity.main:app --port 8120`.
- Тесты: `uv run pytest services/admin-identity -q` (реальный PG/Redis, временная схема).
