# telegram-bff

**Владелец:** команда Telegram-контура. **Bounded context:** сессия Mini App TilHero по Telegram `initData`, активный ученик (родитель ↔ детский профиль 6–13) и агрегация API доменов для Mini App. Своих данных не хранит (stateless), в Redis — refresh-сессии с активным учеником, одноразовость initData, счётчики лимитов.

Стек: Node 22, Fastify 5, TypeBox, `@tilhero/ts-common` (контекст трассировки, формат ошибок, внутренний JWT, `ServiceClient`, лимитер, health). Порт 8001.
Публичный контракт — `packages/contracts/src/bff.ts` (типы импортируются, схемы TypeBox в `src/schemas.ts` сверяются с ними при `tsc`). Внутренние API доменов — `docs/sprint1/INTERNAL_API.md` §1–§6, §9.

## Как это работает

```
Mini App ──initData──▶ POST /v1/session/telegram ──▶ identity-consent /internal/v1/users/telegram-login (аккаунт, ученики)
          ◀── access JWT (15 мин) + refresh (12 ч)      learning-plan /internal/v1/me/plan?tz= × каждый ученик (onboarding)
Mini App ──Bearer──▶ /v1/... ──внутренний JWT v2 (EdDSA, kid=iss=telegram-bff, aud=<домен>, sub=аккаунт|ученик)──▶ домены
```

- **Два субъекта сессии.** Access JWT (HS256, `SESSION_JWT_SECRET`, `iss=telegram-bff`, `aud=telegram-miniapp`): `sub` — аккаунт Telegram, `lrn` — активный ученик (по умолчанию сам аккаунт), `sid`, `pin`. Новая сессия всегда начинается с `lrn = sub`.
- **Субъект внутреннего JWT** (`src/account.ts`: `asAccount` / `asLearner`):

  | Домен | sub |
  |---|---|
  | learning-plan (план, график, today, activities, справочники) | ученик (`lrn`) |
  | notifications — центр уведомлений (`/me/inbox*`) | ученик |
  | experience-config — `release-notes/for-me`, `/seen`, `/feed` | ученик |
  | identity-consent `/me/*`, `guardian-consents/{token}/accept\|decline` | аккаунт |
  | social (приглашения, семья) | аккаунт |
  | support | аккаунт (пишет и получает ответы в Telegram аккаунт) |
  | identity `telegram-login`, `legal/policy`, `GET guardian-consents/{token}`; experience `experience/miniapp/current` | без sub |

  Матрица по всем маршрутам — `test/subjects.test.ts`.
- **Переключение ученика** (`POST /v1/session/learner`): BFF проверяет ученика в identity-consent `GET /internal/v1/me/learners/{id}` от имени аккаунта (свой или свой ребёнок, иначе `404 LEARNER_NOT_FOUND`; ответ сверяется: тот же id, `kind=child`, есть в `/me.learners`). Выход **из** детского профиля (к родителю или другому ребёнку) при заданном коде родителя требует `pin` (нет/неверный → `401 PIN_INVALID`, блокировка → `423 PIN_LOCKED`, лимит `tg.pin` 5/мин); вход в детский профиль кода не требует. Ответ собирается до перевыпуска refresh (сбой домена не ломает текущую сессию), затем в той же сессии перевыпускаются токены с новым `lrn`. **Активный ученик — свойство сессии в Redis:** access-токен, выданный до переключения, сразу перестаёт действовать (`401 TOKEN_EXPIRED {reason: learner_switched}` → клиент делает refresh).
- **Refresh** — 32 случайных байта (base64url), в Redis только `sha256` → `{sid, uid, lrn, pin}`; ротация на каждом использовании, повтор использованного токена = кража → отзыв всей сессии. При refresh ученик перепроверяется по `/me.learners`: детский профиль исчез → активным становится аккаунт.
- **Гейт кода родителя** (как PIN aievent): если код задан, новая сессия получает `pin=false` (`security.pin_required=true`), до `POST /v1/session/pin/verify` или `/biometric/verify` доступны только `/v1/session/*` (кроме `learner`), сброс кода, политика, конфиг, просмотр ссылки согласия родителя; остальное → `423 PIN_REQUIRED`.
- **Сброс кода с задержкой (ревью T-8).** Верный прежний код (проверка, выход из детского профиля) отменяет ожидающий сброс. Если срок сброса наступил, identity вводит новый код в действие при проверке и отвечает `pin_reset_applied: true` — BFF отзывает все остальные сессии аккаунта (текущая, подтвердившая новый код, остаётся).
- **Детский профиль** (`lrn ≠ sub`): приглашения — `403 INVITES_NOT_ALLOWED` (контракт); команды взрослого — создание детей, решение по согласию подростка и список/отзыв решений, код родителя и биометрия, согласия и возраст аккаунта (`POST/DELETE /v1/profile/consent`, `PUT /v1/profile/age`), удаление аккаунта, переписка с поддержкой (CONVENTIONS §8: детям — никаких сообщений от незнакомых) — `403 ADULT_REQUIRED`. Домены в этих случаях не вызываются.
- **Зона клиента для плана** (QA D-03, ревью T-2): learning-plan создаёт план по умолчанию при первом `GET /internal/v1/me/plan` в зоне `?tz=`. BFF передаёт зону клиента в **каждый** запрос плана: `GET /v1/plan?tz=<IANA>` (контракт) или заголовок `X-Timezone` (Mini App шлёт его с каждым запросом; не формата IANA — игнорируется), в том числе при сборке сессии, профиля и списка учеников (`onboarding_completed` каждого ученика). При первом входе (identity `is_new=true`) план аккаунта не запрашивается вовсе: его ещё нет, `onboarding_completed=false`; план создаст первый `GET /v1/plan?tz=` клиента. Без зоны клиента (не Mini App) learning-plan берёт зону по умолчанию, как раньше.
- **Профиль:** `account` — identity `/me`; `learners` — ученики из identity + `onboarding_completed` из плана каждого (learning-plan, параллельно; сбой → 503, частичного профиля нет); `notifications` — активного ученика: аккаунт — `/me.settings`, детский профиль — `settings` из identity `/me/learners/{id}` (если identity их не отдаёт — настройки аккаунта, см. «Отклонения»). `PATCH /v1/profile/settings`: `locale` — всегда аккаунту (`/me/settings`), `notifications` и `display_name` — активному ученику (аккаунт → `/me/settings`, ребёнок → `PATCH /me/learners/{id}` `{display_name?, settings?}`); `display_name` у аккаунта → 422.
- **«Что нового»** (`GET /v1/whats-new`): из плана активного ученика — `onboarded_at = onboarding_completed_at`, из identity — `lang = locale` аккаунта (язык интерфейса Mini App и сообщений; один источник языка для родителя и детских профилей — ревью T-6) и возраст ученика → `age`: `kids` (6-9, 10-13), `teens` (14-17), `adults` (18+ и не выбран); режим выбирает experience-config. Онбординг не завершён → `{mode: none}` без вызова experience-config. Заметок ≤ 5; маршрут/иконка пункта не из `packages/contracts/release-notes.json` → `null`; режим вне контракта или пусто → `none`. Лента `GET /v1/news` — тот же сегмент.
- **Согласие родителя (14–17):** `POST /v1/profile/guardian-consent` → identity `{token, expires_at}` → ссылка `${TELEGRAM_APP_LINK}?startapp=gc_<token>` (токен неожиданного формата → 503, ссылка не строится). `GET /v1/guardian-consents/{token}` — публично (лимит по IP), решение — от имени аккаунта родителя (родитель без своего согласия → `403 CONSENT_REQUIRED {purpose: "terms"}` identity, проходит клиенту). Решения родителя (§11): `GET /v1/family/guardian-consents` → identity `GET /internal/v1/me/guardian-consents`, `POST /v1/family/guardian-consents/{teen_user_id}/revoke` → identity `POST /internal/v1/me/guardian-consents/{teen_user_id}:revoke` (sub = аккаунт; чужой подросток — `404 GUARDIAN_CONSENT_NOT_FOUND` identity; неверный формат id — тот же 404 без вызова домена; ответ о другом подростке → 503). Статус домена `revoked` → `declined`, записи вне контракта не показываются.
- **Идемпотентность:** `Idempotency-Key` (UUID) обязателен для `POST /v1/plan/activity`, `POST /v1/invites`, `POST /v1/support/tickets` (`422 IDEMPOTENCY_KEY_REQUIRED`), необязателен для `POST /v1/learners` и сообщений поддержки; пробрасывается в домен в нижнем регистре. Создающие команды с ключом ServiceClient повторяет после 5xx/таймаута с тем же ключом, без ключа — не повторяет.
- **If-Match** (`PATCH /v1/plan`): `3`, `"3"` или `W/"3"` → домену `If-Match: 3`; ServiceClient заголовков не принимает — `DomainClient` добавляет их через `AsyncLocalStorage` (см. «Запросы к общему коду»).
- **Ответы сериализуются по схеме** (fast-json-stringify): клиент получает только поля контракта; маршрут `/v1` без схемы 2xx не даёт приложению стартовать. Перечисления домена вне контракта приводятся в `src/views.ts` (центр уведомлений: `telegram_status=skipped` → `in_app_only`, неизвестная категория → `service`, `startapp` не формата start_param → `null`).
- **Ошибки доменов** (4xx) отдаются клиенту как есть: `code`, HTTP-статус, `details`, `trace_id` запроса. Недоступность/таймаут/5xx/открытый circuit breaker и отказ внутренней авторизации (`INTERNAL_*`, `USER_CONTEXT_*`, `CALLER_*`, `ACTOR_*`) → `503 UPSTREAM_UNAVAILABLE {service}`. Любой другой **401 домена** тоже → 503, кроме ответов о коде (`PIN_INVALID`, `BIOMETRIC_INVALID`, `RESET_CODE_INVALID`): для Mini App 401 — «сессия истекла» (refresh и повтор), а сессию BFF домен оценить не может (ревью T-4). Ошибки роутера (битый URL, параметр длиннее 100 символов) — ErrorBody без эха пути (в пути бывают токены). Stack trace наружу не уходит (`500 INTERNAL_ERROR`).
- **Remote Experience Config** — кэш в памяти инстанса `EXPERIENCE_CACHE_SECONDS`, при недоступности experience-config — последняя полученная версия.

## API (`/openapi.json` — только вне production)

Авторизация — `Authorization: Bearer <access_token>`, кроме помеченных «публично». Все маршруты — `bff.ts`; ниже — домен и особенности BFF.

| Метод | Путь | Домен (sub) | Примечание |
|---|---|---|---|
| POST | `/v1/session/telegram` | identity, learning-plan | публично; 10/мин с IP; `start_param` из initData (только `[A-Za-z0-9_-]{1,64}`); 401 `INIT_DATA_*`; 410 `USER_DELETED` |
| POST | `/v1/session/refresh` | identity, learning-plan | публично; 401 `REFRESH_INVALID` |
| POST | `/v1/session/pin/verify`, `/biometric/verify` | identity (аккаунт) | 5/мин; ученик сохраняется |
| POST | `/v1/session/learner` | identity (аккаунт), learning-plan | `SwitchLearnerRequest`; 404 `LEARNER_NOT_FOUND`; 401 `PIN_INVALID` / 423 `PIN_LOCKED` при выходе из детского профиля |
| POST | `/v1/session/logout` | — | 204 |
| GET | `/v1/profile` | identity (аккаунт), learning-plan (каждый ученик) | `Profile` |
| PATCH | `/v1/profile/settings` | identity (аккаунт) | 422 `QUIET_HOURS_INVALID` |
| PUT | `/v1/profile/age` | identity | 409 `AGE_ALREADY_SET` |
| GET / POST | `/v1/learners` | identity, learning-plan | POST: 201; 403 `ADULT_REQUIRED`; 409 `CHILDREN_LIMIT` |
| POST | `/v1/profile/guardian-consent` | identity | `GuardianConsentLink`; 409 `GUARDIAN_CONSENT_NOT_REQUIRED` |
| GET | `/v1/guardian-consents/{token}` | identity (без sub) | публично; 404 `GUARDIAN_CONSENT_NOT_FOUND` (и неверный формат токена); 410 |
| POST | `/v1/guardian-consents/{token}/accept`, `/decline` | identity (аккаунт родителя) | 409 `GUARDIAN_CONSENT_SELF`; 403 `ADULT_REQUIRED` / `CONSENT_REQUIRED {purpose: terms}` |
| GET | `/v1/family/guardian-consents` | identity `/me/guardian-consents` (аккаунт) | `{items: GuardianConsentGrant[]}`; 403 `ADULT_REQUIRED` в детском профиле |
| POST | `/v1/family/guardian-consents/{teen_user_id}/revoke` | identity `/me/guardian-consents/{id}:revoke` (аккаунт) | `GuardianConsentGrant`; 404 `GUARDIAN_CONSENT_NOT_FOUND` (не этот родитель / не UUID); 403 `ADULT_REQUIRED` |
| GET | `/v1/legal/policy?lang=ru\|uz` | identity | публично, `Cache-Control: public, max-age=300` |
| POST / DELETE | `/v1/profile/consent` | identity | 409 `POLICY_VERSION_OUTDATED`; 422 `CONSENT_REQUIRED_PURPOSES {missing}`; 403 `GUARDIAN_CONSENT_REQUIRED`; 403 `ADULT_REQUIRED` в детском профиле |
| PUT / DELETE | `/v1/profile/security/pin` | identity | код родителя; 422 `PIN_FORMAT`; PUT отзывает другие сессии |
| POST | `/v1/profile/security/pin/reset-request`, `/reset-confirm` | identity | доступно при `pin_required`; reset-confirm → `SecurityState` с `pin_reset_effective_at` (ревью T-8: новый код заработает через 24 ч, сессия не меняется, другие не отзываются) |
| POST | `/v1/profile/security/pin/reset-cancel` | identity | `{current_pin}` → `SecurityState`; отмена ожидающего сброса прежним кодом (401 `PIN_INVALID`, 423, лимит `tg.pin`); доступно при `pin_required`; 403 `ADULT_REQUIRED` в детском профиле |
| PUT / DELETE | `/v1/profile/security/biometric` | identity | 409 `PIN_REQUIRED` |
| POST | `/v1/profile/delete-request` | identity | 202 `DeletionResponse` (с `learners`); все сессии отозваны |
| GET / PATCH | `/v1/plan` | learning-plan (ученик) | GET: `?tz=<IANA>` (или `X-Timezone`) → learning-plan `?tz=`; PATCH: `If-Match`; 409 `PLAN_VERSION_CONFLICT`; 422 `PLAN_INVALID {field, reason}` |
| POST | `/v1/plan/onboarding/complete` | learning-plan | 409 `PLAN_INCOMPLETE {missing}` |
| GET | `/v1/plan/today` | learning-plan | `TodayPlan` |
| POST | `/v1/plan/activity` | learning-plan (`/me/activities`) | `Idempotency-Key` обязателен |
| GET | `/v1/directory/goals`, `/v1/directory/topics` | learning-plan | `Cache-Control: private, max-age=300` |
| GET | `/v1/notifications?limit=&cursor=` | notifications (ученик) | `Page<InboxItem>` |
| GET | `/v1/notifications/unread-count` | notifications | `{unread}` |
| POST | `/v1/notifications/read` | notifications (`/me/inbox:read`) | 422, если нет ни `ids`, ни `all` |
| POST / GET | `/v1/invites` | social (аккаунт) | POST: `Idempotency-Key` обязателен, 201; 403 `ADULT_REQUIRED` / `INVITES_NOT_ALLOWED`; 409 `INVITES_LIMIT` |
| DELETE | `/v1/invites/{invite_id}` | social | чужое/не-UUID → 404 `INVITE_NOT_FOUND` |
| POST | `/v1/invites/open` | social (`/invites:open`) | токен неверного формата → 404 `INVITE_NOT_FOUND` |
| GET | `/v1/invites/{invite_id}/preview` | social | |
| POST | `/v1/invites/{invite_id}/accept`, `/decline` | social | `family.members[].is_me` — активный ученик |
| GET | `/v1/family` | social | 204 — семьи нет (`FAMILY_NOT_FOUND` домена) |
| GET | `/v1/whats-new` | learning-plan + identity + experience-config (for-me, ученик) | см. выше |
| POST | `/v1/whats-new/seen` | experience-config (ученик) | 204 |
| GET | `/v1/news?limit=&cursor=` | experience-config (`release-notes/feed`, ученик) | `Page<WhatsNewNote>` |
| GET | `/v1/experience/config` | experience-config | публично, кэш 60 с |
| POST / GET | `/v1/support/tickets` | support (аккаунт) | POST: `Idempotency-Key` обязателен, 10/ч (`tg.support_create`, повтор ключа лимит не тратит); 422 `SUPPORT_CATEGORY_INVALID` |
| GET | `/v1/support/tickets/{id}` | support | UUID или `TCK-NNNN`; 404 `SUPPORT_TICKET_NOT_FOUND` |
| POST | `/v1/support/tickets/{id}/messages`, `/close` | support | 409 `SUPPORT_TICKET_CLOSED` |
| GET | `/v1/support/categories` | support | категории TilHero RU/UZ |
| GET | `/v1/languages` | catalog `/pairs` | `MyLanguages`: `ru-en` активна, прочие пары (кроме archived) — `available=false` («скоро»); кеш `PAIRS_CACHE_SECONDS`, при сбое catalog — последний список |
| GET | `/v1/diagnostics/state?pair_id=` | diagnostics (ученик), `?audience=` | `DiagnosticState`; 409 `PAIR_NOT_AVAILABLE`; 410 `USER_DELETED` |
| POST | `/v1/diagnostics/sessions` | diagnostics, `?audience=` | `Idempotency-Key` обязателен; 201; 409 `DIAGNOSTIC_TOO_SOON {next_allowed_at}` / `PAIR_NOT_AVAILABLE` |
| GET | `/v1/diagnostics/sessions/{id}/next` | diagnostics | `DiagnosticItem` (явная сборка полей — ключ ответа не уходит) или `{done: true}`; 404 `DIAGNOSTIC_SESSION_NOT_FOUND`; 409 `DIAGNOSTIC_SESSION_EXPIRED` / `_CLOSED` |
| POST | `/v1/diagnostics/sessions/{id}/answers` | diagnostics | `AnswerResult` без правильности; «Не знаю» с ответом → 422 `ANSWER_INVALID`; 409 `ITEM_NOT_CURRENT` |
| POST | `/v1/diagnostics/sessions/{id}/listening-unavailable` | diagnostics | 204 |
| POST | `/v1/diagnostics/sessions/{id}/finish` | diagnostics | `DiagnosticResult`; 422 `DIAGNOSTIC_EMPTY` |
| POST | `/v1/diagnostics/results/{id}/followup` | diagnostics | `{area}` (только vocabulary/grammar/reading/listening) → 201 `DiagnosticSession`; 409 `FOLLOWUP_NOT_AVAILABLE {area, reason}` |
| GET | `/v1/diagnostics/results?pair_id=` | diagnostics (`?limit=50`) | `{items}` — история |
| GET | `/v1/skills/map?pair_id=` | diagnostics + снимок курса catalog | названия, область, уровень, предпосылки — из снимка (ETag, `If-None-Match` не чаще `COURSE_SNAPSHOT_REVALIDATE_SECONDS`); навык вне курса не показывается, `counts` пересчитаны; снимка нет — 503 `CATALOG_UNAVAILABLE` |
| GET | `/v1/plan/trajectory?pair_id=` | learning-plan (ученик), `?audience=` | `Trajectory`; 409 `PAIR_NOT_AVAILABLE`; 410; 503 `CATALOG_UNAVAILABLE` (код домена передаётся как есть) |
| GET | `/v1/scenarios?goal=&level=&topic=&cursor=&limit=` | catalog (ученик), `?audience=` | `Page<ScenarioCard>`; элемент не по контракту отбрасывается |
| GET | `/v1/scenarios/{id}` | catalog, `?audience=` | `ScenarioDetail` без графа; 404 `SCENARIO_NOT_FOUND` |
| GET | `/v1/media?type=&level=&topic=&cursor=&limit=` | catalog, `?audience=` | `Page<MediaCard>` |
| GET | `/v1/media/{id}` | catalog, `?audience=` | `MediaDetail`; без `show_transcript` — `transcript: null` и в BFF; 404 `MEDIA_NOT_AVAILABLE` |
| GET | `/v1/media/{id}/audio` | catalog (байты), `?audience=` | прокси: `Content-Type` из ответа (только audio/mpeg\|ogg\|mp4), ≤ 3 МБ (больше — 503 без чтения в память), `ETag`, `Cache-Control: private, max-age=3600`, `If-None-Match` клиента → 304; кеш байтов `AUDIO_CACHE_MB`, но каждый запрос перепроверяется в catalog (`If-None-Match` → 304) — права и аудитория проверяются всегда |
| GET / POST | `/v1/media/requests` | catalog (**аккаунт**, claims `lrn`, `age_band`) | детский профиль → 403 `KIDS_NOT_ALLOWED` до вызова catalog; POST: `Idempotency-Key` обязателен, 201, `ui_locale` — язык аккаунта; > 5 в сутки → 429 `MEDIA_REQUEST_LIMIT {retry_after}` + `Retry-After`; ссылка только `https://`, BFF её не открывает |

Сегмент ученика `audience` (kids / teens / adults) — по возрасту активного ученика, как для «Что нового»: детский профиль
(`lrn ≠ sub`) — всегда kids без запроса к identity; возраст аккаунта не выбран — kids (самый строгий набор). Кеш
`AUDIENCE_CACHE_SECONDS`, сбрасывается при `PUT /v1/profile/age`. Ответы catalog, diagnostics и learning-plan сверяются
со схемой контракта до ответа Mini App (`src/check.ts`): не по контракту → 503 `UPSTREAM_UNAVAILABLE {service}`.

## Переменные окружения

| Переменная | По умолчанию (вне production) | Описание |
|---|---|---|
| `ENV` | из `NODE_ENV` | `dev\|test\|stage\|prod`. **stage/prod или `NODE_ENV=production`** — защищённое окружение: все секреты/URL обязательны, dev-значения запрещены, `MINIAPP_ORIGIN` только https, `/openapi.json` выключен, dev-деривация ключа внутреннего JWT запрещена |
| `PORT` / `HOST` | `8001` / `::` | Railway требует `::`; без IPv6 — откат на `0.0.0.0` |
| `BOT_TOKEN` | dev-токен | токен бота для проверки initData |
| `SESSION_JWT_SECRET` | dev-секрет | ≥ 32 символов; ≠ `INTERNAL_JWT_SECRET` |
| `INTERNAL_JWT_PRIVATE_KEY` | — | **stage/prod обязателен**: base64url seed Ed25519 (`infra/scripts/gen_internal_keys.py`) |
| `INTERNAL_JWT_PUBLIC_KEYS` | `{}` | общая переменная `{issuer: base64url pub}` (BFF только подписывает) |
| `INTERNAL_JWT_SECRET` | `dev-internal-secret-change-me` | только dev/test: деривация ключа Ed25519 |
| `REDIS_URL` / `REDIS_KEY_PREFIX` | `redis://127.0.0.1:6379/0` / `bff:` | сессии, лимиты, одноразовость initData |
| `INIT_DATA_MAX_AGE_SECONDS` / `INIT_DATA_ONE_TIME` | `600` / `true` | срок и одноразовость initData |
| `ACCESS_TTL_SECONDS` / `REFRESH_TTL_SECONDS` | `900` / `43200` | |
| `MINIAPP_ORIGIN` | `http://localhost:5173` | CORS, список через запятую |
| `TELEGRAM_APP_LINK` | `https://t.me/tilhero_dev_bot/app` | прямая ссылка Mini App `https://t.me/<bot>/<app>` (без query) — для ссылки согласия родителя `?startapp=gc_<token>`; в stage/prod обязательна |
| `IDENTITY_URL`, `LEARNING_PLAN_URL`, `SUPPORT_URL`, `NOTIFICATIONS_URL`, `EXPERIENCE_URL`, `SOCIAL_URL` | `http://127.0.0.1:8101 / 8102 / 8103 / 8104 / 8106 / 8109` | адреса доменов (Railway: `http://<svc>.railway.internal:<port>`) |
| `CATALOG_URL`, `DIAGNOSTICS_URL` | `http://127.0.0.1:8110 / 8111` | спринт 3; в stage/prod обязательны |
| `COURSE_SNAPSHOT_REVALIDATE_SECONDS` / `PAIRS_CACHE_SECONDS` | `60` / `60` | перепроверка снимка курса по ETag / кеш языковых пар |
| `AUDIO_CACHE_MB` / `AUDIENCE_CACHE_SECONDS` | `32` / `30` | кеш байтов аудио медиатеки (LRU, 0 — выключен) / кеш сегмента ученика |
| `UPSTREAM_TIMEOUT_MS` / `UPSTREAM_RETRIES` | `3000` / `1` | таймаут и повторы (GET и команды с `Idempotency-Key`) |
| `EXPERIENCE_CACHE_SECONDS` | `60` | кэш конфига интерфейса |
| `RATE_LIMIT_USER_PER_MIN` / `RATE_LIMIT_SESSION_IP_PER_MIN` / `RATE_LIMIT_PIN_PER_MIN` / `RATE_LIMIT_PUBLIC_IP_PER_MIN` | `120` / `10` / `5` / `120` | политики `tg.user`, `tg.session_ip`, `tg.pin` (код родителя, в т. ч. при выходе из детского профиля; сброс — отдельный счётчик), `tg.public_ip`; `tg.support_create` — из каталога |
| `RATE_LIMITS_ENABLED`, `RATE_LIMIT_OVERRIDE_REFRESH_SECONDS` | `true`, `30` | единый лимитер ts-common |
| `TRUST_PROXY_HOPS` | `1` | доверенные прокси (Railway edge) |
| `LOG_LEVEL`, `SERVICE_VERSION` | `info`, версия package.json | |

Ошибка конфигурации — процесс не стартует и печатает список всех проблемных переменных.

## Безопасность

- initData не логируется и не хранится (в Redis — только SHA-256 подписи на срок жизни), принимается один раз (`INIT_DATA_REPLAYED`).
- `user_id` — только из сессии; учебный субъект — только `lrn`, выставленный BFF после проверки опекунства в identity и сверяемый с сессией в Redis на каждом запросе. Тела и query — `additionalProperties: false` (лишние поля, в т. ч. `user_id`, → 422).
- Код родителя проверяется на формат в BFF (`^(\d{4}|\d{6})$` → `422 PIN_FORMAT`), мусор не тратит попытку.
- Логи — JSON без PII: redact-пути + рекурсивная вычистка ключей (`init_data`, `pin`, `*_token`, `token`, `text`, `display_name`, `teen_display_name`, `inviter_display_name`, `link`, `start_param`, `startapp`, `telegram_user_id`, `username`, …); пользователь — только `user_pid` (псевдоним аккаунта); access-лог пишет шаблон маршрута (`/v1/guardian-consents/:token`), не путь.
- Ответы с токенами и данными — `Cache-Control: no-store`; `X-Content-Type-Options: nosniff`; CORS — только `MINIAPP_ORIGIN` (разрешены `idempotency-key`, `if-match`, `if-none-match`, `x-timezone`), без credentials.
- Спринт 3: в логах не бывает текста заявок (`comment`, `decision_note`, `link`) и ответов диагностики (`answer`);
  проверка ответа домена пишет только сервис, имя проверки, путь и правило схемы — без значений.
- Сбой Redis → `503` (fail-closed).

## Отклонения от контракта и обходы

- **Биометрия** (`PUT/DELETE /v1/profile/security/biometric`, `POST /v1/session/biometric/verify`) — маршруты aievent; в `bff.ts` нет их типов. Типы объявлены локально в `src/schemas.ts`. Типы кода родителя — из `bff.ts` (сверка `assertSame`).
- **Заголовок `X-Timezone`** (зона устройства для плана по умолчанию) в `bff.ts` не описан — запрос к контракту; без него поведение прежнее.
- **Настройки уведомлений ребёнка:** INTERNAL_API не даёт их прочитать (`GET/PATCH /me/learners/{id}` → `LearnerSummary`). BFF берёт `settings` из ответа identity, если оно есть, иначе показывает настройки аккаунта.
- **`locale` в детском профиле** применяется к аккаунту (у ребёнка своего `locale` в API identity нет; язык интерфейса ученика — `plan.ui_lang`).
- Детский профиль: `403 ADULT_REQUIRED` для поддержки, кода родителя, удаления, создания детей, решения по согласию подростка, согласий и возраста аккаунта — решение BFF по CONVENTIONS §8 и §10–§11 (возраст — защита в глубину по рекомендации ревью T-5).
- `TOKEN_EXPIRED {reason: learner_switched}` — access-токен выдан до переключения ученика.
- **Claims внутреннего JWT для catalog** (`lrn`, `age_band` — catalog README): на всех вызовах catalog от ученика
  (`/scenarios`, `/scenarios/{id}`, `/media`, `/media/{id}`, `/media/{id}/audio`, заявки) `sub` — аккаунт, `lrn` — активный
  ученик, `age_band` — возраст аккаунта (в детском профиле не передаётся). `issueInternalToken` ts-common не умеет
  дополнительные claims; BFF подписывает такой токен сам тем же ключом и в том же формате (`issueWithClaims`,
  `src/upstream.ts`), GET повторяется при сетевой ошибке/5xx. Запрос к ts-common: `RequestOptions.claims`.
- **`AreaResult.evidence`** (по уровням): BFF отдаёт только `{band, answered, correct}`, для `not_assessed` — `[]`;
  `correct > answered` у домена → 503 `UPSTREAM_UNAVAILABLE`.
- **`409 DIAGNOSTIC_TOO_SOON`** бывает и после трёх незаконченных результатов, но причина в `details` не приходит —
  Mini App выводит её из последнего результата (нет оценённой области → «Слишком много незаконченных проверок…»).
  Запрос к diagnostics: `details.reason`.
- `POST /v1/diagnostics/sessions` и `…/followup` всегда отвечают 201 (повтор с тем же ключом домен отдаёт 200 — клиенту
  статус не важен, тело то же).
- `GET /v1/diagnostics/results/{id}?revision=` домена в контракте BFF нет — Mini App показывает историю из списка.

## Локальная разработка

```bash
bash infra/dev/stack.sh up                      # Redis/PG/NATS
cd services/telegram-bff
npm run dev                                     # tsx watch, порт 8001, dev-секреты
npx tsx scripts/dev-init-data.ts --user-id 900001 --name Игорь --start-param route_home --json \
  | curl -s -XPOST localhost:8001/v1/session/telegram -H 'content-type: application/json' -d @-
```

Проверки: `npx tsc -p tsconfig.json --noEmit`, `npx vitest run` (нужен Redis; тесты — DB 14, `TEST_REDIS_URL`; домены — in-memory подделка в `test/helpers.ts`, проверяющая внутренний JWT и берущая субъекта только из `sub`). Сборка: `npm run build -w @tilhero/ts-common && npm run build -w @tilhero/telegram-bff` (из корня).

## Runbook

- **Деплой (Railway):** `RAILWAY_DOCKERFILE_PATH=services/telegram-bff/Dockerfile` (контекст — корень репозитория), healthcheck `/health/ready`.
- **`/health/ready` = 503 `redis: down`:** проверить Redis и `REDIS_URL`; пока Redis недоступен, авторизованные запросы → 503.
- **Массовые `503 UPSTREAM_UNAVAILABLE {service}`:** строки лога `domain unavailable` (`upstream`, `upstream_status`, `upstream_code`). `INTERNAL_TOKEN_*` / `CALLER_NOT_ALLOWED` — у домена нет открытого ключа `telegram-bff` или домен не разрешает `telegram-bff`.
- **Вход падает 503 `learning-plan`:** сессия не создаётся (онбординг ученика неизвестен), initData можно предъявить снова после восстановления.
- **Частые `401 TOKEN_EXPIRED {reason: learner_switched}`:** Mini App продолжает слать старый access-токен после `POST /v1/session/learner` — ошибка клиента (токены надо заменить из ответа).
- **Отозвать сессии аккаунта:** `redis-cli smembers bff:usid:<user_id>` → `del bff:sid:<sid>` для каждого. Компрометация `SESSION_JWT_SECRET` — заменить секрет и удалить `bff:sid:*`, `bff:rt:*`, `bff:usid:*`.
- **Всплеск `refresh_token_reuse`:** параллельные refresh в клиенте или кража токенов — сессии уже отозваны.
