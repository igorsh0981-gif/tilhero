# admin-bff

**Bounded context:** сессии сотрудников в браузере, CSRF, rate limit, RBAC и step-up TOTP, actor-токены к доменам и агрегация API для admin-web TilHero. Своих данных в БД нет; в Redis — сессии, кэш principal и счётчики лимитов.

Стек: Node 22, Fastify 5, `@tilhero/ts-common` (контекст трассировки, ErrorBody, внутренний JWT v2 EdDSA с `actor`, circuit breaker, health, единый лимитер), ioredis. Порт **8002**.
Публичный контракт — `packages/contracts/src/admin.ts` (единственный источник типов), внутренние — `docs/sprint2/INTERNAL_API.md` §4. Форк admin-bff «Бот турист» (aievent), сокращённый до объёма TilHero.

## Как это работает

```
браузер ──▶ admin-web (Caddy) ──/admin/v1/*──▶ admin-bff ──внутренний JWT v2 (kid=iss=admin-bff, aud=<домен>,
            один origin, cookie first-party       │          actor {id, role, name, permissions})──▶ admin-identity, user-admin,
                                                  │                                                   identity-consent, support, audit,
                                                  └── Redis: sess:<sha256(id)>, principal:<staff_id>, rl:*   experience-config, notifications
```

- **Публичного домена нет.** admin-web проксирует `/admin/v1/*` на `http://${{admin-bff.RAILWAY_PRIVATE_DOMAIN}}:8002`; один origin, CORS не включается.
- **Сессия:** cookie `__Host-tilhero_admin` (Secure, HttpOnly, SameSite=Strict, Path=/, без Domain) с непрозрачным id (32 случайных байта). В Redis ключ — `sha256(id)`, HASH `{staff_id, session_version, created_at, last_seen_at, step_up_until, csrf_token, ip_hash, ua_hash, impersonating, superseded_until}`. Бездействие 30 мин и абсолютный срок 8 ч → `401 SESSION_EXPIRED`. При входе id всегда новый, прежняя cookie браузера удаляется (session fixation). Другой User-Agent с той же cookie → сессия отзывается.
- **Ротация id** (смена пароля, step-up) — атомарный Lua: старая сессия должна существовать и не быть замещённой (параллельный logout побеждает → `401`). После step-up старый id ещё 15 с действует **без** step-up и без продления; logout по любому из двух id удаляет обе. Повторная ротация замещённого id (две вкладки) → `409 SESSION_ROTATED` **без** Set-Cookie (TOTP-код и пароль не тратятся); клиент повторяет запрос один раз.
- **Фоновые запросы:** `X-Background: 1` — запрос обслуживается, но сессию не продлевает.
- **Выход безотказный** (ревью T2-1): `POST auth/logout` — уровень `sessionOnly()`: cookie → сессия → срок → User-Agent → CSRF/Origin, **без** principal admin-identity и без лимитов. Сессия (вместе со связанным ротацией id) удаляется и cookie стирается до обращения к admin-identity; его `/internal/v1/auth/logout` (аудит) — best effort, при недоступности — резервная запись `auth.logout` в audit (actor — из кэша principal или по сессии). Регресс-тест: admin-identity недоступен и кэш principal истёк → 204, та же cookie → 401.
- **Отзыв:** principal (`GET admin-identity /internal/v1/staff/{id}/principal`, строгая проверка формы) кэшируется в Redis ≤ 30 с; статус ≠ ACTIVE, другая `session_version`, 404/403 → `401 SESSION_REVOKED` и удаление сессии. Изменения через BFF (смена пароля, PATCH сотрудника, сбросы, применённый approve) сбрасывают кэш цели сразу.
- **CSRF:** все не-GET — `X-CSRF-Token` = `Me.csrf_token` (сравнение за постоянное время) + `Origin` = `ADMIN_ORIGIN` (без Origin — только `Sec-Fetch-Site: same-origin`) → иначе `403 CSRF_INVALID`. Шаги входа (до сессии) — проверка Origin.
- **RBAC декларативно:** каждый маршрут `/admin/v1/*` объявляет `publicAuth` / `authenticated` / `requirePermission(...)` / `requireRole(...)` и при необходимости `requireStepUp()`; маршрут без объявления или без схемы ответа не регистрируется (приложение не стартует). Проверка — в `onRequest`, **до** разбора тела и вызова домена; домены проверяют `actor.permissions` повторно.
- **Step-up** (`POST /admin/v1/auth/step-up {code}` → новый id с `step_up_until = now + 5 мин`) — по шапке admin.ts: публикация и снятие «Что нового», активация и сброс шаблона, расписание и остановка рассылки, активация и откат конфигурации, раскрытие Telegram ID, все команды по сотрудникам, ролям и заявкам → иначе `403 STEP_UP_REQUIRED {permission}`.
- **Лимиты** (единый лимитер ts-common, GCRA в Redis, общий для реплик): вход 10/мин с IP (IPv6 — по /64) и 5/мин на email (в ключе — хеш с суточной солью); шаги по challenge 30/мин с IP и 5/мин на challenge; step-up и смена пароля 5/мин на сотрудника; команды (не-GET) 60/мин; всё 300/мин на сотрудника → `429 RATE_LIMITED {policy, retry_after}` + `Retry-After`.
- **Ошибки:** ErrorBody. 4xx доменов — как есть (код, статус, details: `TEMPLATE_INVALID {fields}`, `RELEASE_NOTE_TRANSLATION_MISSING {missing}`, `CAMPAIGN_*`, `SUPPORT_INVALID_TRANSITION`, …); недоступность / таймаут / 5xx / битый или испорченный ответ / отказ внутренней авторизации → `503 UPSTREAM_UNAVAILABLE {service}`. Раскрытие: `503 AUDIT_UNAVAILABLE` identity-consent передаётся с этим кодом (значения нет). Сбой Redis → 503 (fail-closed).
- **Строгая проверка ответов доменов** (`src/codec.ts`, `src/contract.ts`): одно описание поля даёт и проверку значения, и схему ответа (fast-json-stringify). `C.obj<T>()` требует ровно ключи типа admin.ts — расхождение с контрактом ломает `tsc`. Лишние поля доменов отбрасываются; не тот тип, неизвестное значение перечисления, время без зоны → 503 (в лог — только путь поля). Тесты проверяют каждый 2xx-ответ до сериализации строгим Ajv (`x-contract-required` → `required`).
- **Защита PII в ответах** (наследник A43 `redactSensitive` aievent — там удалён в спринте 7 вместе с AI-перепиской): `telegram_id_masked`, не похожий на маску (`••••••789`), заменяется на `null` — полный Telegram ID из read-модели наружу не уходит никогда; `username` — полный только сотруднику с `users.sensitive.read`, иначе маска `ig•••81` (короче 5 символов — `•••`, без «@») (маскирует user-admin по actor; если домен вернул полный — маскирует BFF: реестр, карточка, дети, опекун, сводка в тикете; ревью T2-3); подпись тестового получателя с ≥ 5 цифрами подряд → 503; служебные поля (`search_text`, `cursor`, `chat_ids`, `ticket_id` эскалации, каталог прав `/roles`) отбрасываются; значение reveal — только в ответе (`Cache-Control: no-store`).
- **Имена сотрудников** (`created_by_name`, `published_by_name`, `activated_by_name`, `assignee_name`, `author_name` оператора): admin-identity `GET /admin/v1/staff/lookup?ids=` с actor (кэш 60 с, ≤ 100 id); lookup недоступен → `null` (автору-ученику — значение support), экран работает.
- **Агрегация:** карточка ученика = user-admin + support `GET /admin/v1/support/tickets?user_id=&limit=20` (без `support.read` → `tickets: null` без вызова support; support недоступен — тоже `null`). Тикет поддержки = support + сводка ученика из user-admin (`?q=<uuid>&limit=1`, только при `users.read`). Дашборд — 4 независимых блока параллельно (таймаут `DASHBOARD_TIMEOUT_MS`, без повторов): источник недоступен, ответил ошибкой или мусором → `{available: false, data: null, service}`, ответ всегда 200.
- **Аудит действий BFF** (`POST audit /internal/v1/records` с actor): только `dev.impersonate` (без записи режим не включается) и резервный `auth.logout`, если admin-identity недоступен. Остальное аудируют домены.
- **Логи:** JSON, trace_id и псевдоним сотрудника; access-лог — шаблон маршрута (не URL с `q=@username`). Пароли, коды, challenge, секрет MFA, временный пароль, cookie, CSRF, email, Telegram ID, имена, причины и тексты вычищаются (redact pino + рекурсивный `scrub`).

## API (`/admin/v1`, admin.ts)

| Раздел | Маршруты | Право (step-up) | Домен |
|---|---|---|---|
| Вход | POST `auth/login`, `auth/mfa`, `auth/mfa/enroll/start`, `auth/mfa/enroll/confirm`, `auth/password` (с challenge) | публичный: Origin + лимиты | admin-identity `/internal/v1/auth/*` |
| Сессия | POST `auth/password` (в сессии), `auth/step-up`, `auth/logout`; GET `me` | любой вошедший | admin-identity |
| Dev | POST `dev/impersonate` | только ENV=dev (иначе 404); только сужение прав | audit |
| Сотрудники | GET `staff`, `staff/{id}`; POST `staff` (Idempotency-Key обязателен); PATCH `staff/{id}`; POST `staff/{id}/reset-password\|reset-mfa` | staff.manage (step-up на командах) | admin-identity `/admin/v1/*` |
| Роли, заявки | GET `roles`, `approvals`; PUT `roles/{code}`; POST `approvals/{id}/approve\|reject` | staff.manage \| roles.manage; PUT — roles.manage; решения — роль super_admin (step-up) | admin-identity |
| Ученики | GET `learners`, `learners/{id}`; POST `learners/{id}/reveal` | users.read; reveal — users.sensitive.read (step-up) | user-admin; support; identity-consent `/admin/v1/users/{id}/reveal` |
| Дашборд | GET `dashboard?period=` | dashboard.read | user-admin `learners/stats`, support `stats`, experience-config `release-notes/summary`, notifications `campaigns/summary` |
| Поддержка | GET `support/tickets`, `tickets/{id}`, `tickets/{id}/client-view`, `support/templates`, `support/sla-policies`; POST `tickets/{id}/messages` (Idempotency-Key обязателен), `take`, `escalations`; PATCH `tickets/{id}` | support.read / support.reply; `stats` — support.read \| dashboard.read; SLA GET — support.read \| support.manage, PUT — support.manage | support |
| Аудит | GET `audit/records`, `audit/records/{id}`, `audit/verify` | audit.read | audit (`from/to` → `date_from/date_to`) |
| Конфигурация | GET `experience/admin/current` (любой вошедший), `experience/miniapp/current`, `experience/{app}/state\|versions\|versions/{v}\|activations`; POST `experience/{app}/versions`, `activate`, `rollback` | config.read / config.edit / config.publish (step-up) | experience-config |
| «Что нового» | GET `release-notes`, `release-notes/{id}`, `release-notes/{id}/stats`; POST `release-notes`; PUT `release-notes/{id}`; POST `publish`, `archive` | whatsnew.manage; публикация и архив — whatsnew.publish (step-up) | experience-config |
| Шаблоны | GET `notifications/templates`, `templates/{key}`; POST `templates/{key}/versions`, `versions/{v}/preview`, `versions/{v}/test`, `versions/{v}/activate` (step-up), `templates/{key}/reset` (step-up); GET `notifications/test-recipients` | notif.templates.manage (test-recipients — ещё notif.campaigns.manage) | notifications |
| Рассылки | GET `notifications/campaigns`, `campaigns/{id}`; POST `campaigns` (Idempotency-Key обязателен); PATCH `campaigns/{id}`; POST `estimate`, `preview`, `test` | notif.campaigns.manage | notifications |
| Рассылки: запуск | POST `campaigns/{id}/schedule` (step-up), `unschedule`, `stop` (step-up) | notif.campaigns.send | notifications |

Idempotency-Key (8..128, `[A-Za-z0-9_\-:.]`) пробрасывается в домен; где admin.ts говорит «обязателен» — без него `422 IDEMPOTENCY_KEY_REQUIRED`, неверный формат — `422 IDEMPOTENCY_KEY_INVALID`. Повтор, отмеченный доменом `Idempotent-Replayed: true`, передаётся клиенту тем же заголовком.

## Переменные окружения

| Переменная | dev / test по умолчанию | stage / prod |
|---|---|---|
| `ENV` | dev (NODE_ENV=test → test) | stage \| prod |
| `PORT`, `HOST` | 8002, `::` | задаёт Railway |
| `ADMIN_ORIGIN` | `http://localhost:5174` | обязательна, только https, один origin |
| `REDIS_URL`, `REDIS_KEY_PREFIX` | `redis://127.0.0.1:6379/0`, `admin-bff:` | REDIS_URL обязательна |
| `INTERNAL_JWT_PRIVATE_KEY`, `INTERNAL_JWT_PUBLIC_KEYS` | dev-деривация из `INTERNAL_JWT_SECRET` | обязательны (dev-деривация запрещена) |
| `ADMIN_IDENTITY_URL` | `http://127.0.0.1:8120` | обязательна |
| `USER_ADMIN_URL` | `http://127.0.0.1:8121` | обязательна |
| `IDENTITY_URL` | `http://127.0.0.1:8101` | обязательна |
| `SUPPORT_URL` | `http://127.0.0.1:8103` | обязательна |
| `NOTIFICATIONS_URL` | `http://127.0.0.1:8104` | обязательна |
| `AUDIT_URL` | `http://127.0.0.1:8105` | обязательна |
| `EXPERIENCE_URL` | `http://127.0.0.1:8106` | обязательна |
| `SESSION_IDLE_SECONDS`, `SESSION_ABSOLUTE_SECONDS`, `STEP_UP_SECONDS`, `PRINCIPAL_CACHE_SECONDS` | 1800, 28800, 300, 30 (это и максимумы) | |
| `UPSTREAM_TIMEOUT_MS`, `UPSTREAM_RETRIES`, `DASHBOARD_TIMEOUT_MS` | 3000, 1, 2000 | |
| `RATE_LIMIT_LOGIN_IP_PER_MIN`, `RATE_LIMIT_LOGIN_EMAIL_PER_MIN`, `RATE_LIMIT_AUTH_STEP_IP_PER_MIN`, `RATE_LIMIT_MFA_PER_MIN`, `RATE_LIMIT_STAFF_PER_MIN`, `RATE_LIMITS_ENABLED` | 10, 5, 30, 5, 300, true | |
| `TRUST_PROXY_HOPS` | 2 (edge Railway → Caddy admin-web) | |
| `LOG_LEVEL`, `SERVICE_VERSION` | info, версия пакета | |

Имена адресов доменов — как у telegram-bff (`IDENTITY_URL`, `SUPPORT_URL`, `NOTIFICATIONS_URL`, `EXPERIENCE_URL`). Конфигурация проверяется при старте: все проблемы перечисляются разом, процесс не поднимается.

## Запуск и тесты

```bash
cd services/admin-bff
npx tsx src/main.ts                         # dev: домены локального стенда, ENV=dev (имперсонация доступна)
source ../../.dev/testenv.sh                # TEST_REDIS_URL стенда
npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
```

Тесты — реальный Redis (уникальный префикс ключей на приложение) и подделка доменов через `fetchImpl` (проверяет внутренний JWT и запоминает actor): `routes.test.ts` — матрица всех маршрутов (step-up, happy path со строгим Ajv по контракту, домен и actor, 4xx/5xx доменов), `security.test.ts` — реестр маршрутов = admin.ts, 401 без сессии, 8 ролей × маршруты, CSRF на каждом небезопасном маршруте, лимиты, имперсонация, заголовки, логи без PII; `auth.test.ts` — вход/MFA/смена пароля/step-up/ротация/logout/фоновые запросы; `api.test.ts` — агрегация карточки и дашборда, раскрытие, поддержка, заметки, шаблоны и рассылки, строгая проверка ответов; `config.test.ts`.

Docker: `docker build -f services/admin-bff/Dockerfile .` из корня репозитория (как telegram-bff; Node 22.22 alpine, USER node, HEALTHCHECK `/health/live`).

## Отклонения и договорённости

- Lookup имён — `GET /admin/v1/staff/lookup` (так реализовал admin-identity); в INTERNAL_API §1 записан `/internal/v1/staff/lookup`.
- `GET /admin/v1/notifications/test-recipients` — права `notif.templates.manage` **или** `notif.campaigns.manage` (тест нужен и шаблонам, и рассылкам; в admin.ts право маршрута не указано).
- `POST …/campaigns/{id}/estimate` и `…/tickets/{id}/take` принимают только пустое тело (`{}` или без тела; лишнее поле → 422).
- Необязательное (`?:`) поле контракта, пришедшее от домена как `null`, в ответ не попадает (например, `SlaPolicy.updated_by`).
- `Campaign.last_error`: если notifications прошлой версии поля не отдаёт — `null` (испорченное значение — по-прежнему 503).
- `ApprovalDecision.temporary_password` — решающему для `staff.privileged_reset`, `staff.create_privileged`, `staff.role_grant`, `staff.reactivate_privileged` (null домена → ключа нет); `StaffCreated.temporary_password` для привилегированной роли — `null` автору.
