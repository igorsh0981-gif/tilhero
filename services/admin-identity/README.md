# admin-identity

**Владелец:** админ-контур (спринт 2). **Bounded context:** учётные записи сотрудников, вход (пароль, обязательная
смена пароля, TOTP MFA), роли и матрица прав, four-eyes, `session_version` (отзыв сессий admin-bff).
Порт 8120, схема `admin_identity`, пакет `tilhero_admin_identity`. Спецификация — `docs/sprint2/INTERNAL_API.md` §1,
формы ответов — `packages/contracts/src/admin.ts` (RBAC, Auth, «Сотрудники и роли»). Форк admin-identity «Бот турист»
(aievent) без режима AD/LDAP, AI-уровней доступа и прав спринтов 4–9 aievent.

## Роли и права
Каталог — зеркало `admin.ts` (`Permission` — 46 прав, `RoleCode` — 10 ролей, `PRIVILEGED_ROLES`), матрица по умолчанию —
`docs/sprint2/PLAN.md` §«Роли и права» + §«Права и роли» `docs/sprint3/PLAN.md`, `docs/sprint4/PLAN.md`,
`docs/sprint5/PLAN.md`, `docs/sprint6/PLAN.md` и §«Права» `docs/sprint7/PLAN.md`, сид — миграции `0001`, `0003`–`0007`
(0003–0007 добавляют права к действующей матрице, ничего не затирая); дальше матрица меняется только через four-eyes.
Названия RU/EN хранятся у ролей (новых ролей в спринтах 5–7 нет); подписи прав — в admin-web.

| Роль | Права | MFA |
|---|---|---|
| super_admin | все 46 | обязательна |
| operations | dashboard.read, users.read, support.read, audit.read, config.read, config.edit, config.publish, content.read, ai.read, qa.read, costs.read, costs.manage, memory.read, memory.manage, game.read, game.manage, game.publish, wallet.adjust, social.read, moderation.manage, referral.read, referral.manage, league.read, league.manage, room.read, room.manage | обязательна |
| communications | dashboard.read, whatsnew.manage, whatsnew.publish, notif.templates.manage, notif.campaigns.manage, notif.campaigns.send | обязательна |
| support | dashboard.read, users.read, support.read, support.reply, game.read, social.read, moderation.manage, referral.read, room.read | обязательна (moderation.manage, с спринта 7) |
| methodist | dashboard.read, users.read, content.read, content.edit, content.review, content.publish, ai.read, ai.manage, ai.publish, qa.read, qa.transcripts, qa.review, memory.read, glossary.manage, game.read | обязательна (content.publish, ai.publish, qa.review) |
| content_manager (Контент-менеджер) | dashboard.read, content.read, content.edit, media.rights, glossary.manage, game.read, game.manage, league.read | обязательна (media.rights) |
| qa_analyst (QA-аналитик) | dashboard.read, content.read, ai.read, qa.read, qa.transcripts, memory.read | по желанию |
| analyst | dashboard.read, users.read, content.read, ai.read, qa.read, costs.read, memory.read, game.read, social.read, referral.read, league.read, room.read | по желанию |
| auditor | dashboard.read, audit.read, content.read, ai.read, qa.read, costs.read, memory.read, game.read, social.read, referral.read, league.read, room.read | по желанию |
| read_only | dashboard.read | по желанию |

`users.sensitive.read`, `staff.manage`, `roles.manage`, `support.manage`, `lang.manage` — только super_admin. Роль
привилегированна (MFA обязательна, назначение — four-eyes), если она из `PRIVILEGED_ROLES` **или** содержит хотя бы одно
из прав, чьи команды требуют step-up: `users.sensitive.read, staff.manage, roles.manage, config.publish,
whatsnew.publish, notif.templates.manage, notif.campaigns.send`, (спринт 3) `content.publish, media.rights,
lang.manage`, (спринт 4) `ai.publish, qa.review, costs.manage`, (спринт 5) `memory.manage`, (спринт 6) `game.publish,
wallet.adjust` и (спринт 7) `moderation.manage, referral.manage, league.manage, room.manage` (без MFA повторный TOTP невозможен; `glossary.manage`, `game.manage` — без step-up, `memory.read`,
`game.read`, `social.read`, `referral.read`, `league.read`, `room.read` — чтение). `wallet.adjust`, `referral.manage`,
`league.manage`, `room.manage` — только operations и super_admin. Поэтому methodist, content_manager и (с спринта 7)
support — привилегированные, хотя `PRIVILEGED_ROLES` admin.ts их не перечисляет (`Role.privileged` в API — по
составу прав); qa_analyst (чтение и реплики с причиной, `qa.transcripts` — без step-up) — нет. При применении заявки на
матрицу `roles.privileged` пересчитывается; если роль стала привилегированной — сессии её сотрудников отзываются (при
входе — подключение MFA). Миграции 0003 и 0004 делают то же (0003 — methodist; 0004 — роль, ставшая привилегированной
по ai.publish/qa.review/costs.manage, например methodist, у которого content.publish сняли через four-eyes); 0005 —
то же для memory.manage (по матрице его получают только operations и super_admin — уже привилегированные); 0006 — то же
для game.publish и wallet.adjust (тоже только operations и super_admin); 0007 — support получает moderation.manage и
становится привилегированной: сессии её сотрудников отзываются, при входе — подключение TOTP.
Сверка с контрактом — `tests/test_aid_contract.py` (admin.ts и PLAN.md спринтов 2–7 разбираются регулярками).

## API
Все вызовы — только от `admin-bff` (внутренний JWT EdDSA; иной издатель → 403 `CALLER_NOT_ALLOWED`).

**Вход** (`/internal/v1`, без actor): `POST auth/login`, `POST auth/password`, `POST auth/mfa/enroll/start`,
`POST auth/mfa/enroll/confirm`, `POST auth/mfa/verify`, `POST auth/step-up`, `GET staff/{id}/principal`,
`POST auth/logout` (204, только аудит). Ответы с challenge/секретом — `Cache-Control: no-store`.

Шаги: `password_change` (must_change_password) → `mfa_enroll` (привилегированная роль без MFA) → `mfa` (MFA подключена)
→ `done` (`principal`). Коды ошибок: 401 `INVALID_CREDENTIALS {remaining}` (одинаково для несуществующего email),
423 `ACCOUNT_LOCKED {retry_after}`, 403 `ACCOUNT_DISABLED`, 401 `TEMPORARY_PASSWORD_EXPIRED`, 422 `PASSWORD_WEAK {rules}`
(`min_length_12`, `letters_and_digits`, `not_email`, `not_previous`), 401 `MFA_INVALID {remaining}`,
401 `CHALLENGE_INVALID`, 423 `MFA_LOCKED {retry_after}`, 409 `MFA_NOT_ENABLED`, 409 `MFA_RESET_REQUIRED`.
TOTP: issuer «TilHero Admin», RFC 6238 (SHA-1, 6 цифр, 30 с, окно ±1); код одноразовый (повтор шага → `MFA_INVALID`).

**Staff API** (`/admin/v1`, actor обязателен, права — по роли сотрудника **из БД** ∩ `actor.permissions` (токен может
только сузить: dev-имперсонация admin-bff), нет права → 403 `PERMISSION_DENIED {permission}`,
нет actor → 403 `STAFF_CONTEXT_REQUIRED`; actor должен быть существующим (`ACTOR_UNKNOWN`) активным
(`ACCOUNT_DISABLED`) сотрудником):

| Метод | Путь | Право | Ответ |
|---|---|---|---|
| GET | `staff?q=&role=&status=&cursor=&limit=` | staff.manage | `Page<Staff>` |
| GET | `staff/{id}` | staff.manage | `Staff`; 404 `STAFF_NOT_FOUND` |
| POST | `staff` (`Idempotency-Key` **обязателен**: нет → 422 `IDEMPOTENCY_KEY_REQUIRED`, не `[A-Za-z0-9_\-:.]{8,128}` → 422 `IDEMPOTENCY_KEY_INVALID`) | staff.manage | 201 `StaffCreated` (временный пароль — один раз; привилегированная роль — `null`, пароль получит решающий; повтор по ключу — тот же ответ с `null`; ключ с другим телом → 422 `IDEMPOTENCY_KEY_REUSED`) |
| PATCH | `staff/{id}` | staff.manage | `Staff` или 202 `{approval}` (привилегированная роль; включение привилегированного; понижение/отключение super_admin); заявка применена сразу (waived) с выпуском пароля — 202 `{approval, temporary_password}` |
| POST | `staff/{id}/reset-password` | staff.manage | `{temporary_password}` или 202 `{approval}` (привилегированная цель) |
| POST | `staff/{id}/reset-mfa` | staff.manage | `Staff` или 202 `{approval}` (привилегированная цель) |
| GET | `staff/lookup?ids=a,b` (≤100) | любой активный сотрудник | `{items: StaffSummary[]}` |
| GET | `roles` | staff.manage или roles.manage | `{items: Role[], permissions}` |
| PUT | `roles/{code}` | roles.manage | 202 `{approval}` |
| GET | `approvals?status=&cursor=&limit=` | staff.manage или roles.manage | `Page<Approval>` |
| POST | `approvals/{id}/approve`, `…/reject` | staff.manage или roles.manage, роль super_admin (по БД) | `ApprovalDecision` (`Approval` + `temporary_password` — только approve заявки сброса пароля) |

`Staff` — ровно поля `admin.ts` (без `auth_provider`). Step-up проверяет admin-bff до вызова изменяющих команд.

Защита от эскалации (403 `PERMISSION_DENIED {permission, role}`): сотрудник с `staff.manage`, но не super_admin,
меняет/сбрасывает пароль или MFA/отключает только тех, чьи права роли ⊆ его собственных, и сразу назначает (создаёт)
только такие роли; учётки super_admin — только super_admin. Привилегированные роли — по-прежнему через four-eyes.

Инварианты (409): `LAST_SUPER_ADMIN`, `SELF_ACTION` (роль/статус/сброс пароля/MFA себя), `STAFF_EMAIL_EXISTS`,
`APPROVAL_PENDING` (одна заявка на объект), `FOUR_EYES_SAME_PERSON`, `APPROVAL_EXPIRED`, `APPROVAL_NOT_PENDING`,
`APPROVAL_NOT_APPLICABLE` (объект изменился после подачи), `SUPER_ADMIN_ROLES_MANAGE`, `ROLE_UNCHANGED`.

**Сброс пароля/MFA привилегированного сотрудника** (в т.ч. коллеги с тем же набором привилегированных прав) — только
заявкой `staff.privileged_reset` (summary `{staff, action: "password"|"mfa", role}`): иначе один super_admin
сбрасывает пароль и MFA другого, входит под ним и согласует собственные заявки. Временный пароль генерируется в момент
применения и возвращается **только решающему** в ответе approve (`Cache-Control: no-store`), автору — никогда; в БД —
только argon2-хеш, в аудит/события/логи/Redis не попадает. Для цели-super_admin исключение `single_super_admin` не
действует никогда; для прочих привилегированных при единственном super_admin — применяется сразу (ответ как у прямого
сброса, заявка `APPLIED` с `waived`). Автор учётки, которая ещё ни разу не входила, перевыпускает её временный пароль
без заявки, только если согласовать некому (нет третьего входившего активного super_admin).

**Four-eyes:** назначение привилегированной роли (`staff.role_grant`, `staff.create_privileged` — сотрудник создаётся
с ролью `read_only` и **без пароля**, автору `temporary_password: null`), изменение матрицы (`role.permissions_change`),
понижение/отключение super_admin при ≥ 2 активных (`staff.privileged_revoke`), включение (DISABLED → ACTIVE)
сотрудника с привилегированной ролью — текущей или назначаемой в той же команде (`staff.reactivate_privileged`,
summary `{staff, role, to_role, from_status}`). Разблокировка входа уже активного сотрудника (`{status: ACTIVE}`) —
прямой командой, как раньше; непривилегированного включают сразу.

**«Мёртвые» заглушки:** если `staff.create_privileged` отклонена (решением или из-за отключения автора) или истекла,
заглушка (ACTIVE, роль-заглушка `read_only`, без пароля) переводится в `DISABLED`: аудит `staff.disabled {approval_id,
approval_status}` с причиной «Заявка на создание сотрудника отклонена | истекла» (при истечении — `actor_type
system`). Заглушку, которую уже изменили (роль, статус, пароль выдан прямым сбросом), не трогаем. Истечение
фиксируется лениво — при списке заявок и сотрудников, карточке, решении и командах по сотрудникам — под
`lock_identity`. Включить отключённую заглушку (read_only) можно прямой командой.

**Учётные данные при применении (ревью P2-1, P2-2):** при применении `staff.create_privileged`, `staff.role_grant`
и `staff.reactivate_privileged` у цели выпускается новый временный пароль (`must_change_password`, 24 ч), MFA
сбрасывается, сессии отзываются (аудит `staff.credentials_reset {cause, approval_id}`), счётчики попыток — с нуля.
Пароль — **решающему** в ответе approve (`ApprovalDecision.temporary_password`, no-store); при waived — автору
(он же единственный решающий): в `StaffCreated.temporary_password` или в 202 `{approval, temporary_password}` PATCH.
Так тот, кто знал прежние учётные данные (создал учётку, сбросил ей пароль до согласования, помнит их до
отключения), не получает второго голоса four-eyes. Заявку автора, который уже не ACTIVE, согласовать нельзя (409 `APPROVAL_NOT_APPLICABLE`);
при отключении сотрудника его PENDING-заявки → `REJECTED`. Решает другой активный super_admin; применение — в той же
транзакции. Срок — 72 ч (истёкшие помечаются `EXPIRED` при обращении). Если автор — единственный активный super_admin
и сам не понижал/отключал super_admin за последние 72 ч, заявка применяется сразу (`status=APPLIED`,
`waived="single_super_admin"`, аудит `approval.waived`); ответ — по-прежнему 202 `{approval}`.

## События
Публикует через outbox только `admin.audit.recorded.v1` (payload = запись audit-service, `actor_type` staff/system;
audit принимает издателя `admin-identity` — `services/audit` `AUDIT_EVENT_PRODUCERS`):
`auth.login`, `auth.login_failed` (email — только HMAC), `auth.locked` (вход и step-up), `auth.mfa_enrolled`,
`auth.mfa_failed`, `auth.password_changed`, `auth.step_up`, `auth.logout` (id сессии — только префикс sha256),
`staff.created`, `staff.updated`, `staff.disabled` (заглушка отклонённого/истёкшего создания), `staff.password_reset`, `staff.mfa_reset`, `staff.credentials_reset`, `staff.bootstrap`,
`role.permissions_requested`, `approval.requested` (заявка по сотруднику), `approval.approved|rejected|applied|waived`
(email сотрудника в сводке заявки — только маской). Пароли, коды, секреты MFA, challenge, временные пароли в события,
outbox и логи не попадают (тест `test_no_secrets_in_logs_or_audit`). В audit пишет только через шину — права
HTTP-записи (`POST /internal/v1/records`) у сервиса нет. Не потребляет.

## Данные
Миграция `0001`: `staff` (email хранится нормализованным, `CHECK email = lower(email)` вместо citext), `roles`
(названия RU/EN), `role_permissions` (сид матрицы), `approvals` (частичный UNIQUE `target` для PENDING), `outbox`/`inbox`;
`0002` — вид заявки `staff.reactivate_privileged` в `ck_approval_kind` (ревью P2-2); `0003` (спринт 3) — права
`content.read|edit|review|publish`, `media.rights`, `lang.manage`, роль `content_manager`, пересчёт `roles.privileged` и
отзыв сессий сотрудников ролей, ставших привилегированными (откат: content_manager → read_only, PENDING-заявки с новыми
правами/ролью → REJECTED); `0004` (спринт 4) — права `ai.read|manage|publish`, `qa.read|transcripts|review`,
`costs.read|manage`, роль `qa_analyst` (QA-аналитик), тот же пересчёт привилегированности и отзыв сессий (откат:
qa_analyst → read_only с отзывом сессий, PENDING-заявки с новыми правами/ролью → REJECTED); `0005` (спринт 5) — права
`memory.read`, `memory.manage` (step-up), `glossary.manage` по матрице PLAN спринта 5, новых ролей нет, тот же пересчёт
привилегированности и отзыв сессий (откат: права удаляются, PENDING-заявки с ними → REJECTED, пересчёт); `0006`
(спринт 6) — права `game.read`, `game.manage`, `game.publish` (step-up), `wallet.adjust` (step-up) по матрице PLAN
спринта 6, новых ролей нет, тот же пересчёт и отзыв сессий, тот же откат; `0007` (спринт 7) — права `social.read`,
`moderation.manage`, `referral.read|manage`, `league.read|manage`, `room.read|manage` (`*.manage` — step-up) по матрице
PLAN спринта 7, новых ролей нет; support становится привилегированной (отзыв сессий), тот же откат.
Все изменения учёток/ролей/заявок сериализуются `pg_advisory_xact_lock`. Redis: счётчики попыток
(`{ns}:login:*` по HMAC email, `{ns}:mfa:*` по staff_id), challenge (`{ns}:ch:<sha256>` — сам challenge не хранится),
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
- Секрет MFA: AES-256-GCM, `version || nonce || ct`, AAD = staff_id.
- `session_version` растёт при смене пароля, роли, статуса, сбросе пароля/MFA → admin-bff отзывает сессии.
- Ошибка конфигурации при старте не печатает значения переменных (`hide_input_in_errors`).

## Переменные окружения
| Переменная | Назначение |
|---|---|
| `ENV`, `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `REDIS_URL`, `NATS_URL`, `INTERNAL_JWT_*` | как у всех сервисов; `REDIS_URL` и `DATABASE_URL` **обязательны в stage/prod** (без Redis нет блокировки перебора и challenge — сервис не стартует) |
| `ADMIN_MFA_ENC_KEY` | base64 или base64url, 32 байта; **обязателен в stage/prod** (dev/test — детерминированный dev-ключ). Генерация: `python -c "import secrets,base64;print(base64.b64encode(secrets.token_bytes(32)).decode())"` |
| `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD`, `ADMIN_BOOTSTRAP_DISPLAY_NAME` | первый super_admin; пароль проходит правила (≥ 12, буквы и цифры, не email), иначе сервис не стартует (в ошибке — только коды правил) |
| `LOGIN_MAX_ATTEMPTS` (5), `LOGIN_LOCK_SECONDS` (900), `MFA_MAX_ATTEMPTS` (5), `MFA_LOCK_SECONDS` (900), `BOOTSTRAP_PASSWORD_TTL_HOURS` (72), `CHALLENGE_TTL_SECONDS` (300), `TEMP_PASSWORD_TTL_HOURS` (24), `APPROVAL_TTL_HOURS` (72) | лимиты |
| `ARGON2_TIME_COST`, `ARGON2_MEMORY_COST`, `ARGON2_PARALLELISM` | параметры argon2id (по умолчанию 3 / 64 МиБ / 4) |

## Runbook
- **Первый администратор.** Задать `ADMIN_BOOTSTRAP_EMAIL` и `ADMIN_BOOTSTRAP_PASSWORD`, задеплоить: при старте, если
  нет ни одного **активного** super_admin, создаётся super_admin с `must_change_password=true` и сроком пароля 72 ч
  (аудит `staff.bootstrap`); email, уже занятый любой учёткой (в т.ч. отключённой), не используется. Пока первый вход
  не выполнен — предупреждение в лог при каждом старте; если срок истёк, а эта учётка — единственный активный
  super_admin, при старте пароль из переменной выдаётся заново (аудит `staff.bootstrap {refreshed: true}`).
  При первом входе — смена пароля и подключение TOTP. **После первого входа удалите обе переменные** из Railway:
  пока они заданы, при каждом старте в лог пишется напоминание (значения не логируются). Повторные старты идемпотентны.
- **Ротация `ADMIN_MFA_ENC_KEY`.** Старые секреты MFA зашифрованы прежним ключом и после смены не расшифровываются —
  такие сотрудники получают 409 `MFA_RESET_REQUIRED`. Порядок: новый ключ → super_admin (с ещё рабочей MFA до деплоя —
  заранее подготовить второго) делает `reset-mfa` каждому → сотрудники подключают MFA заново при входе. Если пострадали
  все super_admin — сброс через БД (`UPDATE staff SET mfa_enabled=false, mfa_secret_enc=NULL, mfa_last_step=NULL,
  session_version=session_version+1 WHERE …`) по процедуре break-glass с записью в журнал инцидентов.
- **Разблокировка входа:** `PATCH /admin/v1/staff/{id} {status: "ACTIVE", reason}` (в том числе для уже активной
  учётки — аудит `staff.updated {login_attempts_reset: true}`, сессии не отзываются) или `reset-password` сбрасывают
  счётчик; иначе блокировка снимается сама через 15 мин. Временная блокировка живёт только в Redis и **не** меняет
  `staff.status` на `LOCKED` (иначе, зная email, можно было бы отзывать сессии сотрудника). Статус `LOCKED` в схеме
  зарезервирован (контракт), сервисом не выставляется.
- Миграции: `alembic -c alembic.ini upgrade head` (Railway preDeploy, роль `admin_identity_owner`).
- Локально: `infra/dev/stack.sh up`, затем
  `ENV=dev DATABASE_URL=postgresql://postgres@127.0.0.1:5432/tilhero REDIS_URL=redis://127.0.0.1:6379/0 NATS_URL=nats://127.0.0.1:4222 uv run uvicorn tilhero_admin_identity.main:app --port 8120`.
- Тесты: `uv run pytest services/admin-identity -q -p no:cacheprovider` (реальный PG/Redis, временная схема).
