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
  | catalog (контент ученика), lessons, **memory** (спринт 5) | аккаунт + claims `lrn`, `age_band` (у memory — полоса **активного ученика**, см. «Спринт 5») |
  | **gamification** (спринт 6) — игра ученика | аккаунт + claims `lrn`, `age_band` активного ученика (как memory); картинки — без sub |
  | **спринт 7:** social (сообщество, друзья, блокировки, жалобы, санкции, рефералы), gamification (лиги, дуэли), lessons (задания дуэли, парные комнаты) | аккаунт + claims `lrn`, `age_band` **активного ученика** (детский профиль — полоса ребёнка); приглашения и семья спринта 1 — по-прежнему аккаунт без claims |

  Матрица по всем маршрутам — `test/subjects.test.ts`.
- **Переключение ученика** (`POST /v1/session/learner`): BFF проверяет ученика в identity-consent `GET /internal/v1/me/learners/{id}` от имени аккаунта (свой или свой ребёнок, иначе `404 LEARNER_NOT_FOUND`; ответ сверяется: тот же id, `kind=child`, есть в `/me.learners`). Выход **из** детского профиля (к родителю или другому ребёнку) при заданном коде родителя требует `pin` (нет/неверный → `401 PIN_INVALID`, блокировка → `423 PIN_LOCKED`, лимит `tg.pin` 5/мин); вход в детский профиль кода не требует. Ответ собирается до перевыпуска refresh (сбой домена не ломает текущую сессию), затем в той же сессии перевыпускаются токены с новым `lrn`. **Активный ученик — свойство сессии в Redis:** access-токен, выданный до переключения, сразу перестаёт действовать (`401 TOKEN_EXPIRED {reason: learner_switched}` → клиент делает refresh).
- **Refresh** — 32 случайных байта (base64url), в Redis только `sha256` → `{sid, uid, lrn, pin}`; ротация на каждом использовании, повтор использованного токена = кража → отзыв всей сессии. При refresh ученик перепроверяется по `/me.learners`: детский профиль исчез → активным становится аккаунт.
- **Гейт кода родителя** (как PIN aievent): если код задан, новая сессия получает `pin=false` (`security.pin_required=true`), до `POST /v1/session/pin/verify` или `/biometric/verify` доступны только `/v1/session/*` (кроме `learner`), сброс кода, политика, конфиг, просмотр ссылки согласия родителя; остальное → `423 PIN_REQUIRED`.
- **Сброс кода с задержкой (ревью T-8).** Верный прежний код (проверка, выход из детского профиля) отменяет ожидающий сброс. Если срок сброса наступил, identity вводит новый код в действие при проверке и отвечает `pin_reset_applied: true` — BFF отзывает все остальные сессии аккаунта (текущая, подтвердившая новый код, остаётся).
- **Детский профиль** (`lrn ≠ sub`): приглашения — `403 INVITES_NOT_ALLOWED` (контракт); команды взрослого — создание детей, решение по согласию подростка и список/отзыв решений, код родителя и биометрия, согласия и возраст аккаунта (`POST/DELETE /v1/profile/consent`, `PUT /v1/profile/age`), удаление аккаунта, переписка с поддержкой (CONVENTIONS §8: детям — никаких сообщений от незнакомых) — `403 ADULT_REQUIRED`. Домены в этих случаях не вызываются.
- **Зона клиента для плана** (QA D-03, ревью T-2): learning-plan создаёт план по умолчанию при первом `GET /internal/v1/me/plan` в зоне `?tz=`. BFF передаёт зону клиента в **каждый** запрос плана: `GET /v1/plan?tz=<IANA>` (контракт) или заголовок `X-Timezone` (Mini App шлёт его с каждым запросом; не формата IANA — игнорируется), в том числе при сборке сессии, профиля и списка учеников (`onboarding_completed` каждого ученика). При первом входе (identity `is_new=true`) план аккаунта не запрашивается вовсе: его ещё нет, `onboarding_completed=false`; план создаст первый `GET /v1/plan?tz=` клиента. Без зоны клиента (не Mini App) learning-plan берёт зону по умолчанию, как раньше.
- **Профиль:** `account` — identity `/me`; `learners` — ученики из identity + `onboarding_completed` из плана каждого (learning-plan, параллельно; сбой → 503, частичного профиля нет); `notifications` — активного ученика: аккаунт — `/me.settings`, детский профиль — `settings` из identity `/me/learners/{id}` (если identity их не отдаёт — настройки аккаунта, см. «Отклонения»). `PATCH /v1/profile/settings`: `locale` — всегда аккаунту (`/me/settings`), `notifications` и `display_name` — активному ученику (аккаунт → `/me/settings`, ребёнок → `PATCH /me/learners/{id}` `{display_name?, settings?}`); `display_name` у аккаунта → 422.
- **«Что нового»** (`GET /v1/whats-new`): из плана активного ученика — `onboarded_at = onboarding_completed_at`, из identity — `lang = locale` аккаунта (язык интерфейса Mini App и сообщений; один источник языка для родителя и детских профилей — ревью T-6) и возраст ученика → `age`: `kids` (6-9, 10-13), `teens` (14-17), `adults` (18+ и не выбран); режим выбирает experience-config. Онбординг не завершён → `{mode: none}` без вызова experience-config. Заметок ≤ 5; маршрут/иконка пункта не из `packages/contracts/release-notes.json` → `null`; режим вне контракта или пусто → `none`. Лента `GET /v1/news` — тот же сегмент. Релиз 6.1: `WhatsNewNote.illustration` — ключ иллюстрации каталога (формат `limits.illustration_pattern`; список проверяет experience-config, файл `/whatsnew/<key>.webp` — в сборке Mini App), ключ не того формата или его нет (домен до 6.1) → `null`; маршруты `heroes`, `shop`, `badges`, `game_history`, `game_settings`, `dictionary`, `reading`.
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
| GET | `/v1/lessons/{lesson_id}` | lessons `/lessons/{id}/card` (**аккаунт**, claims `lrn`, `age_band`; query `audience`, `locale`) | `LessonCardDetail` (награды не отдаются); ребёнку `roleplay_mode` — `choices`; 404 `LESSON_NOT_AVAILABLE` |
| POST | `/v1/lessons/{lesson_id}/sessions`, `/v1/scenarios/{id}/sessions`, `/v1/media/{id}/sessions` | lessons (то же) | `Idempotency-Key` обязателен → 201 `LessonSession`; 409 `SESSION_ACTIVE {session_id, kind, title}` / `PAIR_NOT_AVAILABLE`; 404 `LESSON_NOT_AVAILABLE` / `SCENARIO_NOT_FOUND` / `NO_EXERCISES` |
| GET | `/v1/sessions/active`, `/v1/sessions?kind=&cursor=&limit=`, `/v1/sessions/{id}` | lessons | `{session}` / `Page<LessonHistoryItem>` (элемент не по контракту отбрасывается) / `LessonSession`; ребёнку `ai_mode` — `choices`; чужая — 404 `SESSION_NOT_FOUND` |
| POST | `/v1/sessions/{id}/pause`, `/resume`, `/cancel` | lessons | `LessonSession`; 409 `SESSION_STATE {status}` |
| GET | `/v1/sessions/{id}/current` | lessons | `LessonStep` — проверка по дискриминатору `type`, явная сборка полей (ключей нет); шаг проверки без подсказок запоминается в Redis (3 сут.) |
| POST | `/v1/sessions/{id}/steps/{step_id}` | lessons | `StepAnswer` → `StepResult`; ребёнок + `text` → 403 `KIDS_NOT_ALLOWED` до вызова lessons; больше одного вида ответа → 422 `ANSWER_INVALID {field}`; на проверке без подсказок `feedback = null` всегда; 409 `STEP_NOT_CURRENT {current_step_id}` / `FREE_TEXT_NOT_ALLOWED` / `AI_BUSY` (тот же ответ ещё обрабатывается — Mini App повторяет его через 2 с, до 3 раз) |
| POST | `/v1/sessions/{id}/steps/{step_id}/hint` | lessons | `{hint}`; шаг проверки без подсказок → 409 `HINTS_NOT_ALLOWED` до вызова lessons |
| POST | `/v1/sessions/{id}/simpler?locale=ru\|uz` | lessons | `SimplerExplanation`; язык — `?locale=`, иначе `Accept-Language`; 409 `SIMPLER_NOT_AVAILABLE` / `AI_BUSY` |
| POST | `/v1/sessions/{id}/roleplay/retry` | lessons | `LessonStep`; 409 `RETRY_NOT_AVAILABLE` |
| POST | `/v1/sessions/{id}/finish` | lessons (таймаут `LESSONS_FINISH_TIMEOUT_MS`) | `LessonSummary`: верный ответ — только у неверных заданий, ключевые ошибки — ≤ 3 по severity; `evaluation: null` — «оценка появится позже»; 409 `STEP_NOT_CURRENT` (не с шага done) |
| GET | `/v1/sessions/{id}/summary` | lessons | `LessonSummary` (то же) |
| POST | `/v1/sessions/{id}/review` | lessons | `Idempotency-Key` обязателен → 201 `LessonSession` (kind review); 409 `NOTHING_TO_REVIEW` / `SESSION_ACTIVE` |
| GET | `/v1/evaluations/{id}` | assessment (**sub = ученик `lrn`**, claims `lrn`, `age_band`) | `EvaluationView` актуальной записи цепочки (то же правило ключей); 404 `EVALUATION_NOT_FOUND` |
| POST | `/v1/evaluations/{id}/appeal` | assessment | `{reason ≤ 500}`, `Idempotency-Key` обязателен → 201 `Appeal`; 409 `APPEAL_EXISTS` / `APPEAL_WINDOW_CLOSED` / `APPEAL_NOT_ALLOWED`; причина не логируется |
| GET | `/v1/appeals` | assessment (`?limit=50`) | `{items: Appeal[]}` (элемент не по контракту отбрасывается); `reason: null` — текст стёрт по сроку хранения (90 дней после решения) |
| GET | `/v1/memory/overview` | memory `/overview` (**аккаунт**, claims `lrn`, `age_band` ученика; query `audience`, `locale`) | спринт 5, `MemoryOverview` (`pronunciation`: available / consent_self / consent_guardian / unavailable) |
| GET | `/v1/memory/cards?kind=&status=&q=&cursor=&limit=` | memory `/cards` | `Page<DictionaryCard>` (элемент не по контракту отбрасывается); `q` ≤ 60, в лог не пишется |
| GET | `/v1/memory/cards/{id}` | memory `/cards/{id}` | `DictionaryCardDetail`; чужая — 404 `CARD_NOT_FOUND` |
| POST | `/v1/memory/cards` | memory `/cards` (таймаут `MEMORY_TRANSLATE_TIMEOUT_MS`) | `AddCardRequest`, `Idempotency-Key` обязателен → 201 новая / 200 уже была (статус memory); 422 `WORD_NOT_IN_CONTENT` / `GLOSS_UNAVAILABLE` / `CARDS_LIMIT {limit}`; 404 `CONTENT_NOT_FOUND`; 429 — общий с переводом лимит `tg.memory.translate` (может вызвать перевод ИИ; повтор отвеченного ключа лимит не тратит, отметка в Redis на 24 ч) |
| POST / DELETE | `/v1/memory/cards/{id}/known` | memory | `DictionaryCard`; 409 `CARD_STATE {status}` |
| DELETE | `/v1/memory/cards/{id}` | memory | 204 |
| GET | `/v1/memory/errors?cursor=&limit=` | memory `/errors` | `Page<ErrorJournalItem>` (у детей пусто) |
| POST | `/v1/memory/review-sessions` | memory | `Idempotency-Key` обязателен → 201 / 200 (уже активная); 409 `NOTHING_TO_REVIEW {next_due_at}` |
| GET | `/v1/memory/review-sessions/active`, `/{id}` | memory | `{session}` / `ReviewSession`; 404 `REVIEW_SESSION_NOT_FOUND` |
| GET | `/v1/memory/review-sessions/{id}/current` | memory | `ReviewTask` — **строгая** проверка (лишнее поле на любом уровне или раскрывающее ответ поле подсказки → 503), явная сборка; задания проверки удержания запоминаются в Redis (26 ч); 409 `REVIEW_SESSION_STATE {status}` / `TASK_NOT_CURRENT` |
| POST | `/v1/memory/review-sessions/{id}/tasks/{task_id}` | memory | `ReviewAnswer` → `ReviewTaskResult`; больше одного вида ответа → 422 `ANSWER_INVALID {field}` до memory; детям ввод разрешён; на проверке удержания `result`/`correct_answer` до конца блока — `null` всегда; 409 `TASK_NOT_CURRENT {current_task_id}`; 429 `tg.memory.answer` (300 / 10 мин на ученика) |
| POST | `/v1/memory/review-sessions/{id}/tasks/{task_id}/hint` | memory | `{kind}` → `ReviewHint`; проверка удержания → 409 `HINTS_NOT_ALLOWED` до вызова memory |
| POST | `/v1/memory/review-sessions/{id}/finish`, `/cancel` | memory | `ReviewSummary` / `ReviewSession`; 409 `TASK_NOT_CURRENT` / `REVIEW_SESSION_STATE` |
| POST | `/v1/memory/translate` | memory `/translate` `{content_ref, text}` (таймаут `MEMORY_TRANSLATE_TIMEOUT_MS`) | `TranslateRequest` → `WordGloss`; 422 `WORD_NOT_IN_CONTENT`; 404 `CONTENT_NOT_FOUND`; 429 `tg.memory.translate` (60 / 10 мин); детям разрешён (слово из контента) |
| POST | `/v1/memory/pronunciation?target=` | memory `/pronunciation?target_kind=&target=` (сырое тело, таймаут `MEMORY_PRONUNCIATION_TIMEOUT_MS`, без повторов) | тело `audio/wav` ≤ 600 000 байт (лимит и парсер — только у этого маршрута); заголовок WAV проверяется до memory → 422 `AUDIO_INVALID {reason: format \| too_short \| too_long \| too_large}`; `target` — `card:<uuid>` \| `sentence:<kind>:<key>:<version>:<locator>` (иначе 422 `VALIDATION_ERROR {field: target}`); → `PronunciationView`; 403 `VOICE_CONSENT_REQUIRED {who}`; 503 `SPEECH_UNAVAILABLE` (код memory как есть); 429 `tg.memory.pronunciation` (20 / 10 мин) |
| GET | `/v1/practice/readings?level=&cursor=&limit=` | catalog `/readings?pair_id=&audience=&level=` (аккаунт + claims) + lessons `/reading-results?ids=` | `Page<ReadingCard>`; `limit` ≤ 50 (один вызов lessons на страницу); lessons недоступен — `last_result: null` |
| GET | `/v1/practice/readings/{id}` | catalog `/readings/{id}?audience=` + memory `/cards/lookup` | `ReadingView` без вопросов и ответов; `in_dictionary` — из memory (сбой — null); 404 `READING_NOT_AVAILABLE` |
| POST | `/v1/practice/readings/{id}/sessions` | lessons `/readings/{id}/sessions` | `Idempotency-Key` обязателен → 201 `LessonSession` (kind reading); дальше — общие маршруты сессий (шаг `reading` строго по схеме, `in_dictionary` из memory); 404 `READING_NOT_AVAILABLE`; 409 `SESSION_ACTIVE` |
| PUT | `/v1/learners/{learner_id}/voice-consent` | identity `/me/learners/{id}/voice-consent` (аккаунт) + learning-plan (онбординг ребёнка) | `{granted}` → `LearnerSummary`; из детского профиля → 403 `ADULT_REQUIRED` до identity; 404 `LEARNER_NOT_FOUND` (чужой, свой аккаунт, не UUID); 403 `ADULT_REQUIRED` / `CONSENT_REQUIRED {purpose}` identity |
| GET | `/v1/game/summary`, `/heroes`, `/quests`, `/badges`, `/shop`, `/settings` | gamification `/internal/v1/game/<то же>` (аккаунт + claims `lrn`, `age_band`) | спринт 6: `GameSummary` (`purchase_available` всегда `false`), `{items: HeroView[], selected, stage}`, `DailyQuests`, `{items: BadgeView[]}`, `{items: ShopItemView[], til_balance, freeze_stock, freeze_max}`, `GameSettings`; url картинок собирает BFF; 429 `tg.game.read` |
| GET | `/v1/game/history?currency=&cursor=` | gamification `/history` | `Page<GameOperation>` (по 30, без `actor` и комментария сотрудника; элемент не по контракту — отброшен) |
| GET | `/v1/game/rewards?source_session_id=` | gamification `/rewards` | `SessionRewards` (`pending` / `ready` / `none`); `source_session_id` — UUID, обязателен |
| PUT | `/v1/game/hero`, `/v1/game/equipment` | gamification `/hero`, `/equipment` | → `GameSummary`; 404 `HERO_NOT_FOUND`, 409 `HERO_NOT_AVAILABLE`, 409 `NOT_OWNED` — как есть; 429 `tg.game.write` |
| PATCH | `/v1/game/settings` | gamification `/settings` | `Partial<GameSettings>` (≥ 1 поле; в домен — только переданные) → `GameSettings`; 429 `tg.game.write` |
| POST | `/v1/game/shop/purchases` | gamification `/purchases` | `Idempotency-Key` обязателен; `PurchaseRequest` → 200 `PurchaseResult` (повтор ключа — тот же ответ); 409 `INSUFFICIENT_TILS` (`details.purchase_available` всегда `false`) / `ALREADY_OWNED` / `FREEZE_STOCK_FULL {max}`, 410 `ITEM_NOT_AVAILABLE`, 404 `ITEM_NOT_FOUND`, 422 `IDEMPOTENCY_KEY_REUSED` — как есть; 429 `tg.game.purchase` |
| GET | `/v1/game/assets/{asset_id}/{sha256}` | gamification `/assets/{asset_id}` (без sub) | **публично**; 600/мин с IP (`tg.game.assets`); байты `image/webp \| image/png` (≤ 1 МБ), `ETag: "<sha256>"`, `Cache-Control: public, max-age=31536000, immutable`, `If-None-Match` → 304; 404 `ASSET_NOT_FOUND` — sha пути ≠ ETag домена, 4xx домена, путь неверного формата (без вызова домена) |
| POST | `/v1/speech` | tts `/internal/v1/speech` (**аккаунт**, и в детском профиле) | release 4.1, `SpeechRequest` → `audio/mpeg` (MP3 из tts как есть, ≤ 3 МБ), `Cache-Control: private, max-age=86400`. Текст нормализуется как в tts (пробелы, табуляция и переводы строки схлопываются, края обрезаются) и уходит в tts уже нормализованным, `speed` по умолчанию `normal`. 422 `TEXT_INVALID {field}` — после нормализации пусто или > 400 знаков (символов Unicode), управляющие символы, нет латиницы, чужой `variant` / `speed`, лишние поля, а также 422 самого tts; 429 `RATE_LIMITED` (`tg.speech`, 120 за 10 минут на аккаунт); 503 `SPEECH_UNAVAILABLE {service: tts}` — `TTS_URL` не задан, tts недоступен / таймаут `TTS_TIMEOUT_MS` (без повторов) / 5xx / любой другой ответ, в том числе не `audio/mpeg` (Mini App откатывается на синтез речи устройства) |

Сегмент ученика `audience` (kids / teens / adults) — по возрасту активного ученика, как для «Что нового»: детский профиль
(`lrn ≠ sub`) — всегда kids без запроса к identity; возраст аккаунта не выбран — kids (самый строгий набор). Кеш
`AUDIENCE_CACHE_SECONDS`, сбрасывается при `PUT /v1/profile/age`. Ответы catalog, diagnostics и learning-plan сверяются
со схемой контракта до ответа Mini App (`src/check.ts`): не по контракту → 503 `UPSTREAM_UNAVAILABLE {service}`.

### Спринт 5 — память, повторения, чтение, произношение

- **memory** (`src/memoryApi.ts`, `src/routes/memory.ts`, `src/routes/pronunciation.ts`): `sub` — аккаунт, claims `lrn` и
  `age_band`; для memory `age_band` — полоса **активного ученика** (детский профиль — полоса ребёнка из identity, кеш
  `AUDIENCE_CACHE_SECONDS`): по ней memory выбирает воспроизведение (6–9 — сборка, 10–13 — ввод). Query `audience`, `locale`.
- **Ключи ответов.** `ReviewTask` (и `next` в `ReviewTaskResult`) — схема `additionalProperties: false` на всех уровнях и
  правило «подсказка не раскрывает ответ» (`typed`/`cloze`/`assemble`/`error_fix` — `text_en`, `example_en`, `speech_text`
  = null; `meaning_choice` — `gloss`; `listen_choice` — `text_en`, `example_en`; `check_item` — плюс `gloss`); нарушение →
  503 и строка `domain response does not match the contract` (`check`, `path`, `rule`: `additionalProperties` /
  `answer_revealed`, без значений).
- **Дети:** ввод в повторении и перевод по тапу не блокируются (сравнение локальное в memory, слово — из контента); чтение
  — только детские тексты (catalog и lessons распознают детский профиль сами); запись голоса — только с согласия опекуна
  (проверяет memory; родитель включает `PUT /v1/learners/{id}/voice-consent`).
- **`LearnerSummary.voice_consent`** — из identity-consent как есть во всех ответах с учениками (сессия, профиль, список,
  создание ребёнка); нет поля — `false`.
- **Произношение:** своя область Fastify — парсер `audio/wav` (`audio/x-wav`, `audio/wave`) как Buffer и `bodyLimit`
  600 000 только у этого маршрута (на остальных — прежние 64 КБ, `audio/wav` → 415). Ошибки разбора тела этого маршрута
  (413, 415) → 422 `AUDIO_INVALID`. Ответ memory — `PronunciationView` или `PronunciationResult` (ai.ts) + `attempt_id`;
  BFF собирает `PronunciationView`: `score = scores.pron`, разборчивость по баллу (≥ 80 / 60–79 / < 60), ≤ 40 слов, ≤ 2
  совета, баллы — только при `ok`, `message` (RU/UZ) — для `insufficient_evidence` / `unavailable`, `attempt_id = null`
  при `unavailable`.

### Спринт 6 — игра и герои

- **gamification** (`src/routes/game.ts`): тонкий прокси `/v1/game/*` → `/internal/v1/game/*`, `sub` — аккаунт, claims `lrn`
  и `age_band` активного ученика (кошелёк, герой, задания, значки — у `lrn`). `GAMIFICATION_URL` необязателен: без него
  все маршруты игры (и картинки) — `503 GAME_UNAVAILABLE {service: gamification}`, при старте — одно предупреждение.
- **Ошибки:** 4xx gamification — как есть; недоступность, таймаут, 5xx, отказ внутренней авторизации, ответ не по контракту
  (строгая сверка `GameDomain.*` в `src/schemas.ts`) → `503 GAME_UNAVAILABLE` (Mini App скрывает игровой блок, учёба
  работает). Сбой identity при определении полосы ученика — по-прежнему `503 UPSTREAM_UNAVAILABLE {service: identity-consent}`.
- **Картинки в ответах:** домен отдаёт `{asset_id, sha256, width, height}` — BFF собирает `url =
  /v1/game/assets/{asset_id}/{sha256}` (путь от адреса BFF, Mini App добавляет `VITE_BFF_URL`). Готовый `url` домена без
  `sha256` принимается, только если это тот же путь для того же `asset_id`; иначе — 503 и строка лога `rule: image_url`
  (внутренние адреса наружу не уходят).
- **Картинка** `GET /v1/game/assets/{asset_id}/{sha256}`: ETag домена (`"<sha>"`, `W/"<sha>"` или без кавычек) должен
  совпасть с sha пути (иначе 404), sha256 байтов — с ETag, тип — `image/webp | image/png` с верной сигнатурой (иначе 503,
  лог `game asset rejected` с `reason`). Кеша в BFF нет: каждый запрос — в gamification (она отдаёт только картинки
  опубликованного), браузер кеширует навсегда.
- **Деньги:** `purchase_available` в `GameSummary` и в `INSUFFICIENT_TILS.details` BFF всегда ставит `false` (тилы за
  деньги — спринт 8), независимо от ответа домена.
- **`TodayPlan.week[].frozen`:** learning-plan до спринта 6 поля не присылает — BFF отдаёт `false`
  (`routes/plan.ts todayView`).

### Спринт 7 — социальное

Маршруты — по таблице INTERNAL_API спринта 7 §9; файлы: `src/routes/social.ts`, `src/routes/leagues.ts`,
`src/routes/pairRooms.ts`, общий вызов от имени ученика — `src/socialApi.ts`.

| Метод | Путь | Домен (`/internal/v1/…`) | Лимит (на ученика) |
|---|---|---|---|
| GET / PATCH | `/v1/community` | social `GET\|PATCH /me/community` | — / `tg.social.write` |
| PUT | `/v1/community/nickname` | social `PUT /me/community/nickname` | `tg.social.write` |
| POST | `/v1/community/friend-code/rotate` | social `POST /me/community/friend-code:rotate` | `tg.social.write` |
| GET | `/v1/friends/search?q=` | social `GET /me/friends/search` | `tg.social.search` |
| POST / GET | `/v1/friends/requests` (`?direction=in\|out` обязателен) | social `POST\|GET /me/friend-requests` | `tg.social.write` / — |
| POST | `/v1/friends/requests/{request_id}/accept\|decline\|cancel` | social `POST /me/friend-requests/{id}/…` | `tg.social.write` |
| GET / DELETE | `/v1/friends`, `/v1/friends/{member_id}` | social `GET /me/friends`, `DELETE /me/friends/{member_id}` | — / `tg.social.write` |
| POST / GET / DELETE | `/v1/blocks`, `/v1/blocks/{member_id}` | social `/me/blocks…` | `tg.social.write` (команды) |
| POST | `/v1/complaints` | social `POST /me/complaints` | `tg.social.complaint` (10/сутки) |
| GET / POST | `/v1/sanctions`, `/v1/sanctions/{id}/appeal` | social `/me/sanctions…` | — / `tg.social.write` |
| GET | `/v1/referrals` | social `GET /me/referrals` | — |
| GET | `/v1/game/leagues`, `/v1/game/leagues/history` | gamification `/game/leagues…` | `tg.game.read` |
| PATCH | `/v1/game/settings {league_opt_in}` | gamification `PATCH /game/settings` | `tg.game.write` |
| POST / GET | `/v1/game/duels`, `/v1/game/duels/{id}`, `…/accept\|decline` | gamification `/game/duels…` | `tg.duel.write` / `tg.game.read` |
| POST / GET | `/v1/duel-sessions`, `/v1/duel-sessions/{session_id}/review` | lessons `/me/duel-sessions…` | `tg.duel.write` / — |
| POST / GET | `/v1/pair-rooms`, `/v1/pair-rooms/{id}` | lessons `/me/pair-rooms…` | `tg.room.write` / — |
| POST | `/v1/pair-rooms/{id}/accept\|decline\|cancel\|join\|leave\|turns` | lessons `/me/pair-rooms/{id}/…` | `tg.room.write` |
| POST / GET | `/v1/pair-rooms/{id}/heartbeat`, `…/state?after_seq=` | lessons | `tg.room.poll` |
| POST | `/v1/pair-rooms/{id}/audio` (audio/wav) | lessons | `tg.room.audio` (30 за 10 мин) |
| GET | `/v1/pair-rooms/{id}/report` | lessons | — |

- **member_id** — `mb_` + 22 символа base64url (INTERNAL_API §0). BFF передаёт его как есть (не расшифровывает) и сверяет
  формат на входе (иначе 422; в пути — 404 `MEMBER_NOT_FOUND`) и в ответах доменов: «сырой» UUID вместо member_id —
  элемент списка отбрасывается (`list items dropped`), объект — 503. `GET /v1/family` отдаёт `member_id` каждого члена
  семьи из social (нет или не того формата — 503 `UPSTREAM_UNAVAILABLE {service: social}`); `user_id` семьи остаётся
  (управление своей семьёй, контракт).
- **Приватность:** ответы собираются явно и сериализуются по схемам контракта — `user_id`, имя, Telegram, возраст,
  покупки, ошибки, флаги антифрода, исполнитель санкции, чужие реплики и оценки наружу не уходят (тест
  `test/privacy7.test.ts` обходит все маршруты спринта 7 по OpenAPI). Счёт соперника — только у дуэли `finished`
  (иначе `result = null`); значков у строки рейтинга ≤ 3, строк ≤ 50; подсказок отчёта ≤ 3, вариантов реплики ≤ 3,
  событий ленты ≤ 50 (больше — первые 50 и `seq` последнего отданного).
- **Idempotency-Key** обязателен: `POST /v1/friends/requests`, `/v1/complaints`, `/v1/sanctions/{id}/appeal`,
  `/v1/game/duels`, `/v1/duel-sessions`, `/v1/pair-rooms`, `/v1/pair-rooms/{id}/turns`; у прочих команд — необязателен
  и пробрасывается, если есть. Статус создающих команд — домена (201 создано, 200 повтор / встречная заявка).
- **Дети** (детский профиль `lrn ≠ sub`, до вызова домена): поиск, заявки, друзья — 403 `FRIENDS_NOT_ALLOWED {reason:
  kids}`; блокировки, жалобы, рефералы — 403 `KIDS_NOT_ALLOWED`; свободный текст хода и голос в комнате — 403
  `KIDS_NOT_ALLOWED` (и при детской полосе аккаунта; голос — до чтения тела). Защита в глубину (6–13 — профиль или
  полоса): лиги — `friends = null`, общая недоступна (`kids`) даже при другом ответе домена (предупреждение
  `kids_no_strangers`); комната — `mode = choices`, `voice_available = false`. Прочее решает домен по `age_band`.
- **Ошибки:** коды доменов — как есть (в т. ч. новые lessons: 409 `FREE_TEXT_NOT_ALLOWED`, `DUEL_SET_CONFLICT`); `503 DUEL_SET_UNAVAILABLE` (принятие дуэли) и `503 SPEECH_UNAVAILABLE` (голос) —
  тоже как есть (`DOMAIN_BUSINESS_503`). Недоступность / 5xx / ответ не по контракту: social и lessons — `503
  UPSTREAM_UNAVAILABLE {service}`, лиги и дуэли (`/v1/game/*`) — `503 GAME_UNAVAILABLE {service: gamification}`, как
  игра спринта 6 (в т. ч. без `GAMIFICATION_URL`).
- **Long-poll ленты** (`GET /v1/pair-rooms/{id}/state`): lessons держит запрос до 25 с, BFF ждёт
  `PAIR_ROOM_POLL_TIMEOUT_MS` (30 с), без повторов GET; клиент закрыл соединение — вызов lessons прерывается
  (`AbortSignal`, лог `long-poll cancelled by client`, 499 `CLIENT_CLOSED_REQUEST` без записи «domain unavailable»).
  **Вход, ход и выход** (`join`, `turns`, `leave`) синхронно ждут ИИ-коуча — `PAIR_ROOM_COACH_TIMEOUT_MS` (30 с, ≥ 25 с),
  без повторов (ход идемпотентен по Idempotency-Key: повтор — только клиентом с тем же ключом).
- **Включение общей лиги** (`PATCH /v1/game/settings` с `league_opt_in: true`): gamification согласий не знает — BFF
  сначала читает профиль сообщества social (`GET /internal/v1/me/community`, тот же ученик): детский профиль — 403
  `KIDS_NOT_ALLOWED` без вызовов; `friends_available = false` → 403 `FRIENDS_NOT_ALLOWED {reason: kids |
  guardian_consent}` или 403 `CONSENT_REQUIRED {purpose: social}` (`reason = consent`); social недоступен или ответ не
  по контракту — 503 `UPSTREAM_UNAVAILABLE {service: social}`; в этих случаях gamification не вызывается. `league_opt_in:
  false` и прочие поля — без проверки. Лимит `tg.game.write` — один на запрос.
- **Голос** (`POST /v1/pair-rooms/{id}/audio`): своя область Fastify, как произношение спринта 5 — только `audio/wav`
  (`audio/x-wav`, `audio/wave`), ≤ 600 000 байт, WAV PCM 16 бит моно 16 кГц 0,5..15 с (иначе 422 `AUDIO_INVALID
  {reason}`); в lessons — сырое тело как есть, без повторов. Аудио и распознанный текст в лог не пишутся (`audio_ms`).
- **Логи:** ник, код друга, запрос поиска, комментарий жалобы, текст обжалования и ходов, подсказки коуча и отчёт — не
  пишутся (`SENSITIVE_KEYS`, redact-пути).

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
| `LESSONS_URL`, `ASSESSMENT_URL` | `http://127.0.0.1:8112 / 8113` | спринт 4; в stage/prod обязательны |
| `LESSONS_TIMEOUT_MS` / `LESSONS_FINISH_TIMEOUT_MS` | `25000` / `45000` | таймаут вызовов lessons и assessment / завершения урока: lessons ждёт оценку assessment до 32 с плюс вспомогательные вызовы, поэтому `LESSONS_FINISH_TIMEOUT_MS` — с запасом, **больше 32 000**. Шаг ролевой ситуации и «проще» ждут ИИ до 20 с (`AI_TIMEOUT_SECONDS` lessons), поэтому `LESSONS_TIMEOUT_MS` должен быть **больше 20 000**: иначе BFF отвечает 503, хотя lessons ответ уже сохранил (ревью R2-02). Ответ на шаг (POST) BFF не повторяет — повтор того же ответа делает Mini App («Отправить ещё раз»), домен идемпотентен по шагу |
| `COURSE_SNAPSHOT_REVALIDATE_SECONDS` / `PAIRS_CACHE_SECONDS` | `60` / `60` | перепроверка снимка курса по ETag / кеш языковых пар |
| `AUDIO_CACHE_MB` / `AUDIENCE_CACHE_SECONDS` | `32` / `30` | кеш байтов аудио медиатеки (LRU, 0 — выключен) / кеш сегмента ученика |
| `TTS_URL` | — | release 4.1: адрес tts (Railway: `http://tts.railway.internal:8115`, локально `http://127.0.0.1:8115`). **Необязателен и в stage/prod**: без него `POST /v1/speech` отвечает 503 `SPEECH_UNAVAILABLE`, при старте — одно предупреждение `TTS_URL is not set` (BFF можно выложить раньше tts). Если задан — только http(s) |
| `TTS_TIMEOUT_MS` | `15000` | таймаут вызова tts (1000–60000), без повторов: длинная фраза синтезируется секунды, кеш MP3 — у tts |
| `MEMORY_URL` | `http://127.0.0.1:8116` | спринт 5: memory (Railway: `http://memory.railway.internal:8116`); в stage/prod обязателен |
| `MEMORY_TIMEOUT_MS` / `MEMORY_TRANSLATE_TIMEOUT_MS` / `MEMORY_PRONUNCIATION_TIMEOUT_MS` | `10000` / `12000` / `20000` | таймауты memory (1000–60000): обычные вызовы / перевод по тапу (memory ждёт `gloss_word` до 8 с) / оценка произношения (memory ждёт ai-gateway до 15 с); GET повторяются по `UPSTREAM_RETRIES`, команды и аудио — нет |
| `GAMIFICATION_URL` | — | спринт 6: gamification (Railway: `http://gamification.railway.internal:8117`, локально `http://127.0.0.1:8117`). **Необязателен и в stage/prod**: без него `/v1/game/*` отвечают 503 `GAME_UNAVAILABLE`, при старте — предупреждение `GAMIFICATION_URL is not set`. Таймаут и повторы GET — `UPSTREAM_TIMEOUT_MS` / `UPSTREAM_RETRIES`; команды не повторяются |
| `PAIR_ROOM_POLL_TIMEOUT_MS` | `30000` | спринт 7: таймаут long-poll ленты парной комнаты (`GET /v1/pair-rooms/{id}/state`), 1000–120000; lessons держит запрос до 25 с, поэтому в **stage/prod — больше 25000** (иначе процесс не стартует); без повторов. Остальные вызовы lessons — `LESSONS_TIMEOUT_MS`, social — `UPSTREAM_TIMEOUT_MS` |
| `PAIR_ROOM_COACH_TIMEOUT_MS` | `30000` | спринт 7: таймаут `join`, `turns`, `leave` парной комнаты — lessons синхронно ждёт ИИ-коуча; 1000–120000, в **stage/prod — не меньше 25000**; без повторов |
| `BILLING_URL` / `BILLING_TIMEOUT_MS` | — / `5000` | спринт 8: billing (Railway: `http://billing.railway.internal:8118`). **Необязателен и в stage/prod**: без него `/v1/billing/*` и `/web/v1/*` отвечают 503 `BILLING_UNAVAILABLE`, при старте — предупреждение `BILLING_URL is not set` (учёба работает). Один клиент `ctx.billing` на Mini App (claim `chn: miniapp`) и сайт оплаты (`chn: web`); таймаут 500–30000, повторы GET — `UPSTREAM_RETRIES` |
| `WEB_PAY_ENABLED` | `false` | спринт 8: сайт оплаты — маршруты `/web/v1/*` (src/web/); `false` — не регистрируются (404) |
| `WEB_PAY_ORIGIN` | dev: `http://localhost:5175` | origin сайта оплаты (Railway: `https://${{web-pay.RAILWAY_PUBLIC_DOMAIN}}`): проверка `Origin`, redirect URI OIDC `{origin}/api/auth/callback`. В stage/prod при `WEB_PAY_ENABLED=true` обязателен, только https и не origin Mini App |
| `TELEGRAM_LOGIN_CLIENT_ID` / `TELEGRAM_LOGIN_CLIENT_SECRET` | dev: фиктивные | «Log In with Telegram» (OIDC): Client ID = ID бота (цифры), секрет клиента из BotFather — вводит владелец (общая переменная проекта, ссылка только у telegram-bff); ≠ `BOT_TOKEN`, в лог и ошибки не попадает. В stage/prod при `WEB_PAY_ENABLED=true` обязательны, dev-значения запрещены |
| `TELEGRAM_OIDC_BASE` | `https://oauth.telegram.org` | адрес OIDC Telegram; другое значение (мок стенда) — только dev/test |
| `WEB_SESSION_SECRET` | dev: фиктивный | подпись cookie-сессии `__Host-wp_session` сайта оплаты (генерирует `infra/railway/setup.py`); ≥ 32, ≠ `SESSION_JWT_SECRET` и `INTERNAL_JWT_SECRET` |
| `UPSTREAM_TIMEOUT_MS` / `UPSTREAM_RETRIES` | `3000` / `1` | таймаут и повторы (GET и команды с `Idempotency-Key`) |
| `EXPERIENCE_CACHE_SECONDS` | `60` | кэш конфига интерфейса |
| `RATE_LIMIT_USER_PER_MIN` / `RATE_LIMIT_SESSION_IP_PER_MIN` / `RATE_LIMIT_PIN_PER_MIN` / `RATE_LIMIT_PUBLIC_IP_PER_MIN` | `120` / `10` / `5` / `120` | политики `tg.user`, `tg.session_ip`, `tg.pin` (код родителя, в т. ч. при выходе из детского профиля; сброс — отдельный счётчик), `tg.public_ip`; `tg.support_create`, `tg.speech` (120 за 600 с на аккаунт, `POST /v1/speech`) и спринт 5 — `tg.memory.translate` (60), `tg.memory.pronunciation` (20), `tg.memory.answer` (300) за 600 с на **ученика**; спринт 6 — `tg.game.read` (120), `tg.game.write` (30), `tg.game.purchase` (10) в минуту на **ученика**, `tg.game.assets` (600 в минуту с IP); спринт 7 — `tg.social.search` (30), `tg.social.write` (30), `tg.duel.write` (20), `tg.room.write` (60), `tg.room.poll` (240) в минуту, `tg.social.complaint` (10 в сутки), `tg.room.audio` (30 за 10 минут) на **ученика** — из каталога |
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
- Спринт 4: тексты ученика (реплики, открытые ответы, причины апелляций — `text`, `answer`, `reason`, `evidence`,
  `correction`, `your_answer`, `correct_answer`, `text_en`) в логи не попадают (redact-пути и вычистка ключей); ключей
  ответов в ответах Mini App нет: задание собирается явно без `answer`, правильность на проверке без подсказок не
  отдаётся никогда, верный ответ в итогах — только у заданий с ошибкой.
- Release 4.1: текст озвучиваемых фраз (`POST /v1/speech`) в логи не попадает — `req.body.text` в redact-путях, ключ `text`
  вычищается из любого объекта лога; предупреждения о tts пишут только статус, код и правило проверки.
- Спринт 5: ввод в повторении, поиск по словарю (`q`), слово перевода, слова глоссария (`texts`), эталон произношения
  (`reference_text`) и цитаты ошибок в логи не попадают. **Аудио произношения** живёт только в памяти процесса на время
  запроса: не пишется на диск, в Redis, логи и метрики; в логе — `audio_ms` и статус (`pronunciation assessed` /
  `pronunciation not assessed`), без target и байтов; POST в memory не повторяется (аудио не пересылается дважды).
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
- **Спринт 4, субъект токена:** lessons — `sub` = аккаунт + claims `lrn`, `age_band` (INTERNAL_API §0, README lessons);
  assessment — `sub` = активный ученик (`lrn`, README assessment), claims те же. В вызовы lessons BFF добавляет query
  `audience` (подсказка) и `locale` (`?locale=` маршрута «проще» или `Accept-Language`, иначе ru).
- **`GET /v1/evaluations/{id}`** в комментариях `bff.ts` не перечислен (есть `EvaluationView` и `superseded_by`) — маршрут
  нужен Mini App для актуальной оценки после апелляции; запрос к контракту — добавить строку маршрута.
- **`POST /v1/sessions/{id}/review`**: `Idempotency-Key` в `bff.ts` не указан — BFF требует его (создающая команда, как
  старт сессий); **`POST /v1/sessions/{id}/simpler?locale=`** — необязательный параметр сверх контракта.
- Открытый ответ (`open_answer`) Mini App отправляет полем `text` (≤ 300; README lessons), в `bff.ts` это не написано.
- **Release 4.1, `POST /v1/speech`:**
  - ошибки tts клиенту **не** передаются как есть (в отличие от остальных доменов): 422 → `422 TEXT_INVALID`, всё прочее
    (4xx, 5xx, таймаут, сеть) → `503 SPEECH_UNAVAILABLE {service: tts}` — Mini App различает только «текст не годится» и
    «озвучки нет, откатиться на устройство»;
  - табуляция и переводы строки (`\t \n \r`) допустимы и схлопываются в пробел, как в tts; прочие управляющие символы
    (Cc) → 422. Длина считается в символах Unicode (как `len()` в tts), не в единицах UTF-16.

- **Спринт 5:**
  - **Строгость `ReviewTask`:** по общему правилу BFF лишние поля доменов допустимы (отбрасываются сериализатором); у задания
    повторения лишнее поле → 503 `UPSTREAM_UNAVAILABLE {service: memory}` (сигнал утечки ключа), как требует задача спринта.
  - **`503 SPEECH_UNAVAILABLE`** memory передаётся клиенту как есть (в `DOMAIN_BUSINESS_503` вместе с
    `CATALOG_UNAVAILABLE`), а не как `UPSTREAM_UNAVAILABLE` — Mini App по нему скрывает «Произнести».
  - **Не тот `Content-Type`** у произношения (JSON, MP3, без типа) → 422 `AUDIO_INVALID {reason: format}` (а не 415): код из
    контракта, Mini App различает только `AUDIO_INVALID`. Принимаются синонимы `audio/x-wav`, `audio/wave`.
  - **Перевод:** тело в memory — `{content_ref, text}` (INTERNAL_API §1.7), в публичном API — `{text, content}` (bff.ts).
  - **`?limit=`** у `/v1/memory/cards`, `/v1/memory/errors` (1–100) и `/v1/practice/readings` (1–50) — сверх контракта
    (необязательный, как у остальных списков).
  - **Проверка удержания:** BFF помнит задания `check_item`, выданные ученику (Redis, 26 ч): подсказка → 409
    `HINTS_NOT_ALLOWED` без вызова memory; `result` до `check_result` и `correct_answer` всегда `null` (защита в глубину).
  - **`DELETE /v1/memory/cards/{id}`** → 204 без тела (контракт), `POST …/cards` и `POST …/review-sessions` — статус memory
    (201 / 200).
  - **Шаг `reading`** общих маршрутов сессий получает `in_dictionary` глоссария из memory (как `GET /v1/practice/readings/{id}`).

- **Спринт 6:**
  - **Пути gamification**, которых нет в INTERNAL_API явно: `GET /internal/v1/game/heroes`, `/quests`, `/badges`, `/shop`
    (по образцу `/summary`, `/history`, `/rewards`, `/settings`); покупка — `POST /internal/v1/game/purchases` (§1.7), в
    публичном API — `/v1/game/shop/purchases`.
  - **Картинки:** в INTERNAL_API нет формы картинки в ответах ученика — BFF принимает `sha256` (как `AdminGameImage`) или
    готовый `url` того же пути (см. «Спринт 6»).
  - **`SessionRewards.operations`** сверяется с `GameOperation` контракта (`op_id`, `status`, `created_at` обязательны), хотя
    §1.8 перечисляет только `currency, amount, reason, capped, multiplier`.
  - **`PATCH /v1/game/settings {}`** → 422 (нужно хотя бы одно поле); `?limit=` у истории не принимается (контракт — по 30).
  - **Покупка** всегда отвечает 200 (в т. ч. на первый запрос): «повтор ключа — тот же ответ».
  - **Картинки:** 4xx gamification (кроме 429) → `404 ASSET_NOT_FOUND`, путь неверного формата — тот же 404 (не 422).

- **Спринт 7:**
  - **Субъект:** social, gamification и lessons спринта 7 — `sub` = аккаунт, claims `lrn` и `age_band` **активного**
    ученика (у lessons спринта 4 `age_band` — возраст аккаунта; для новых маршрутов lessons — полоса ученика, как
    требует §0 «аудитории по `age_band` из токена»). Query `locale` — во все вызовы lessons спринта 7.
  - **Лиги и дуэли** при сбое gamification — `503 GAME_UNAVAILABLE {service: gamification}` (как весь `/v1/game/*`
    спринта 6), а не `UPSTREAM_UNAVAILABLE`; `details.service` есть в обоих случаях.
  - **`GameSettings.league_opt_in`:** gamification до спринта 7 поля не присылает — BFF отдаёт `false` (как
    `TodayPlan.week[].frozen` спринта 6). **Категория уведомлений `game`:** identity до спринта 7 поля не присылает — BFF
    отдаёт `true` (по умолчанию включена, §5).
  - **`PairRoomState.prompt_gloss`:** lessons может прислать строку или `{ru, uz}` коуча (ai.ts: «ученику BFF отдаёт его
    язык») — BFF выбирает язык ученика (`?locale=` → `Accept-Language` → ru); в контракте Mini App — строка.
  - **Неверный формат id в пути** → 404 кода домена без вызова (`REQUEST_NOT_FOUND`, `MEMBER_NOT_FOUND`,
    `SANCTION_NOT_FOUND`, `DUEL_NOT_FOUND`, `SESSION_NOT_FOUND`, `ROOM_NOT_FOUND`), как приглашения спринта 1.
  - **Ник:** длина и символы проверяются в BFF → `422 NICKNAME_INVALID {reason: length | chars}` (буквы `\p{L}`, цифры,
    «_»; RU/UZ/EN-алфавиты и запрещённые слова — social). **Поиск** `q`: 3..20, буквы, цифры, «_», «-», иначе 422.
  - **Жалоба:** `subject_id` обязателен для `friend_request | invite | duel | pair_room` и равен `null` для `user |
    nickname` — иначе `422 VALIDATION_ERROR {field: subject_id}`; комментарий обрезается, пустой не передаётся.
    **Обжалование:** 10..1000 знаков после обрезки.
  - **Приглашение в комнату:** `start` — `now` или ISO-8601 с зоной, не раньше `now − 1 мин` и не позже `now + 7 дней +
    1 мин` (допуск на часы клиента), иначе 422; окончательно решает lessons.
  - **`GET /v1/friends/requests`:** `direction` обязателен (в контракте всегда указан). **`GET /v1/sessions?kind=duel`**
    → 422: сессий дуэли в истории нет (контракт).
  - **`vitest.config.ts`:** `hookTimeout` 30 с — сборка приложения (≈ 250 маршрутов) на нагруженном стенде дольше 10 с.

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
- **Спринт 5, «Произнести»:** `503 SPEECH_UNAVAILABLE` на `/v1/memory/pronunciation` — оценка выключена в ai-gateway (нет
  ключа Azure, аварийная остановка, бюджет; см. ai-gateway); `403 VOICE_CONSENT_REQUIRED` — нет согласия на запись голоса
  (`who: guardian` — родитель включает в карточке ребёнка). Лог `pronunciation not assessed` — `audio_ms`, статус и код memory.
  Массовые `503 UPSTREAM_UNAVAILABLE {service: memory}` на «Повторении дня» при живом memory — строки `domain response does
  not match the contract` с `check: review_task` (`rule: additionalProperties` / `answer_revealed`): memory отдаёт ключ в задании.
- **`503 SPEECH_UNAVAILABLE` на `/v1/speech`:** при старте `TTS_URL is not set` — переменная не задана; иначе строки `domain unavailable` / `speech unavailable` / `speech audio rejected` с `upstream: tts` (статус, код, причина). Mini App в это время озвучивает синтезом устройства, где он есть (в Telegram на Android его нет — там аудирование отмечается недоступным).
- **Спринт 6, игровой блок пропал (`503 GAME_UNAVAILABLE`):** при старте `GAMIFICATION_URL is not set` — переменная не
  задана; строки `domain unavailable` с `upstream: gamification` — домен недоступен / 5xx / `INTERNAL_TOKEN_*`
  (нет открытого ключа `telegram-bff` у gamification); `domain response does not match the contract` с `upstream:
  gamification` (`check`, `path`, `rule`; `rule: image_url` — картинка без `sha256`). Картинки: `game asset rejected`
  (`reason`: `no etag`, `sha256 mismatch`, `unexpected content type`, `signature mismatch`, `image too large`).
- **Вход падает 503 `learning-plan`:** сессия не создаётся (онбординг ученика неизвестен), initData можно предъявить снова после восстановления.
- **Частые `401 TOKEN_EXPIRED {reason: learner_switched}`:** Mini App продолжает слать старый access-токен после `POST /v1/session/learner` — ошибка клиента (токены надо заменить из ответа).
- **Отозвать сессии аккаунта:** `redis-cli smembers bff:usid:<user_id>` → `del bff:sid:<sid>` для каждого. Компрометация `SESSION_JWT_SECRET` — заменить секрет и удалить `bff:sid:*`, `bff:rt:*`, `bff:usid:*`.
- **Всплеск `refresh_token_reuse`:** параллельные refresh в клиенте или кража токенов — сессии уже отозваны.
