# Спринт 1 — внутренние контракты между сервисами

Публичный API Mini App ↔ BFF — `packages/contracts/src/bff.ts` (единственный источник типов). События — `packages/contracts/events/*.schema.json` (генератор `infra/scripts/gen_event_schemas.py`, правится только он). Внутренние HTTP API доменов — ниже; авторизация — внутренний JWT (CONVENTIONS §2). `{me}` — субъект из `sub` токена: **ученик** для учебных доменов (learning-plan, notifications-inbox, experience-config/for-me), **аккаунт** для аккаунтных (identity-consent `/me/*`, social). Формы ответов совпадают с типами `bff.ts`, если не сказано иное: BFF проксирует без перекладывания.

Расписания (n8n, `Authorization: Bearer <SCHEDULER_TOKEN>`; пустой токен выключает вход; внутренний JWT сервиса → 403 `CALLER_NOT_ALLOWED`): `learning-plan POST /internal/v1/plan:tick` (5 мин), `notifications POST /internal/v1/notifications:dispatch` (5 мин), `social POST /internal/v1/invites:tick` (1 ч).

## 1. identity-consent (8101, схема `identity_consent`) — основа aievent
Вызывают: telegram-bff, notifications (`/users/{id}/delivery`), telegram-bot-gateway (`bot-status`), social (`/users/{id}/public`).

Изменения относительно aievent:
- `users`: `locale` ∈ `ru|uz`; новые `kind` (`account` | `child`), `age_band` (`6-9|10-13|14-17|18+`, NULL до выбора), `guardian_consent` (`not_required|pending|granted|declined`), `notify_categories` TEXT[] (по умолчанию `{support}`; `reminders`, `missed`, `social`, `product` — только после явного включения), тихие часы по умолчанию 22:00–08:00. `age_confirmed_18_plus` и `digest_time` удаляются. Детский профиль: `kind=child`, `telegram_user_id` NULL, `display_name` — имя ребёнка.
- `guardian_links(child_user_id PK, guardian_user_id, created_at)` — у ребёнка один опекун; ≤ 5 детей на аккаунт.
- `guardian_consent_requests(id, teen_user_id, token_hash UNIQUE, status pending|granted|declined|expired|revoked, guardian_user_id, created_at, decided_at, expires_at)`.
- Согласие: `consents.age_band` вместо `age_confirmed_18_plus`; цели политики: обязательные `terms`, `privacy`, `learning`; необязательные `voice_recording`, `social`, `product_news`. Подросток без `granted` не может принять необязательные → 403 `GUARDIAN_CONSENT_REQUIRED`.
- Код родителя = PIN aievent (4/6 цифр, Argon2id, 5 попыток → 5 мин), биометрия — без изменений.

| Метод | Путь | Тело → ответ |
|---|---|---|
| POST | `/internal/v1/users/telegram-login` | `{telegram_user_id, username?, first_name, last_name?, language_code?}` → `LoginResponse {user: UserSummary, security, consent, learners: LearnerSummary[]}` (`is_new=true` при создании + `user.profile.created.v1 {kind: account}`) |
| GET | `/internal/v1/me` | → `MeResponse {user, security, consent, settings: NotificationSettings, learners}` — `sub` = аккаунт |
| PATCH | `/internal/v1/me/settings` | `SettingsPatch` (bff.ts, без display_name) → `MeResponse`; изменение категорий/выключателя → `user.notification_settings.changed.v1` |
| PUT | `/internal/v1/me/age` | `{age_band: "14-17"\|"18+"}` → `MeResponse`; 409 `AGE_ALREADY_SET`; 14-17 → `guardian_consent=pending`; `user.profile.updated.v1` |
| GET | `/internal/v1/me/learners` | → `{items: LearnerSummary[]}` (сам + дети, `onboarding_completed` — `false`, его заполняет BFF из learning-plan) |
| POST | `/internal/v1/me/learners` | `{display_name, age_band: "6-9"\|"10-13"}` → 201 `LearnerSummary`; 403 `ADULT_REQUIRED`; 409 `CHILDREN_LIMIT`; `user.profile.created.v1 {kind: child, guardian_user_id, age_band}` |
| GET | `/internal/v1/me/learners/{learner_id}` | → `LearnerSummary` — свой или свой ребёнок; иначе 404 `LEARNER_NOT_FOUND` |
| PATCH | `/internal/v1/me/learners/{learner_id}` | `{display_name?, settings?: SettingsPatch.notifications}` → `LearnerSummary` (только ребёнок; категории уведомлений ребёнка) |
| POST | `/internal/v1/me/guardian-consent-requests` | → `{token, expires_at}` (токен 32 байта base64url, хранится sha256; прежний pending → revoked); 409 `GUARDIAN_CONSENT_NOT_REQUIRED` |
| GET | `/internal/v1/guardian-consents/{token}` | → `GuardianConsentPreview` (без авторизации ученика, только внутренний токен BFF) |
| POST | `/internal/v1/guardian-consents/{token}/accept` \| `/decline` | `sub` = аккаунт родителя → `GuardianConsentPreview`; 409 `GUARDIAN_CONSENT_SELF`; 403 `ADULT_REQUIRED`; 410 `GUARDIAN_CONSENT_EXPIRED`; `user.profile.updated.v1 {guardian_consent}` для подростка |
| GET/POST/DELETE | `/internal/v1/me/pin*`, `/me/biometric*`, `/legal/policy`, `/me/consent`, `/me/disable`, `/me/enable` | как в aievent (policy `?lang=ru\|uz`) |
| POST | `/internal/v1/me/deletion-request` | как в aievent + запускает удаление каждого ребёнка (отдельный `request_id` на ученика); ответ `DeletionResponse` с `learners` |
| GET | `/internal/v1/users/{user_id}/delivery` | (только notifications) → `DeliveryInfo {user_id, kind, recipient_telegram_user_id, recipient_is_guardian, learner_display_name, locale, age_band, is_minor, notifications_enabled, categories[], quiet_hours {start,end}\|null, timezone, status}`; для ребёнка адресат — опекун (его `telegram_user_id`, его `bot_blocked`); 404 удалён/не найден |
| GET | `/internal/v1/users/{user_id}/public` | (social, notifications) → `{user_id, display_name, kind, age_band, status}` — имя без username и Telegram ID |
| POST | `/internal/v1/telegram-users/{telegram_user_id}/bot-status` | (только bot-gateway) `{blocked}` → 204 |

Сага удаления: домены спринта — `learning-plan`, `social`, `notifications`, `support`, `experience-config` (`DELETION_DOMAINS`). ACK — `user.domain.deleted.v1`, только от самого домена.

## 2. learning-plan (8102, схема `learning_plan`) — новый
Вызывают: telegram-bff. Потребляет `user.deletion.requested.v1`, `user.profile.created.v1`, `user.profile.updated.v1` (проекция `is_minor`), со спринта 4 — события уроков.

Данные: `plans` (`user_id` PK, `goal`, `level_self`, `topics` TEXT[], `ui_lang`, `explain_lang`, `course_pair`, `preset`, `days` SMALLINT[], `preferred_time` TIME, `duration_min` CHECK IN (10,15,20,30), `reminders_enabled`, `timezone`, `onboarding_completed_at`, `version`, `created_at`, `updated_at`); `activities` (`activity_id` PK, `user_id`, `local_date`, `kind`, `minutes`, `idempotency_key` UNIQUE(user_id, key), `recorded_at`); `slot_marks` (`user_id`, `local_date`, `kind` reminder\|missed, `emitted_at`, PK(user_id, local_date, kind)) — идемпотентность tick; `tick_state` (одна строка, `last_tick_at`).

| Метод | Путь | Тело → ответ |
|---|---|---|
| GET | `/internal/v1/me/plan` | → `LearningPlan` (создаёт план по умолчанию при первом обращении; `timezone` по умолчанию из `?tz=` или Asia/Tashkent) |
| PATCH | `/internal/v1/me/plan` | `PlanPatch` (+ заголовок `If-Match`) → `LearningPlan`; 409 `PLAN_VERSION_CONFLICT`; 422 `PLAN_INVALID {field, reason}`; `learning.plan.updated.v1` с `changed_fields` |
| POST | `/internal/v1/me/plan/onboarding/complete` | → `LearningPlan`; 409 `PLAN_INCOMPLETE {missing}` (нужны goal, level_self, schedule); повтор — 200 без изменений |
| GET | `/internal/v1/me/plan/today` | → `TodayPlan` |
| POST | `/internal/v1/me/activities` | `{kind: lesson\|review\|practice\|diagnostic, minutes, occurred_at?}` + `Idempotency-Key` → `TodayPlan`; `learning.activity.recorded.v1`; `local_date` — по зоне плана |
| GET | `/internal/v1/directory/goals`, `/directory/topics` | → `{items: DirectoryItem[]}` (сид: 6 целей, 12 тем, RU/UZ) |
| POST | `/internal/v1/plan:tick` | n8n → `{plans_checked, reminders, missed}` |

Правила tick (окно `(last_tick_at, now]`, не больше 24 ч назад; планы с `onboarding_completed_at`):
- **reminder**: в окно попал момент слота (`local_date` ∈ `days`, `preferred_time`), `reminders_enabled`, сегодня (местная дата) нет активности → `learning.reminder.due.v1` (`streak_days` — по TodayPlan). Отметка `slot_marks(reminder)`.
- **missed**: в окно попала местная полночь после дня слота без активности → `learning.session.missed.v1` с `consecutive_missed` (слоты подряд без активности, назад до первого сделанного) и `next_slot_date`. Отметка `slot_marks(missed)`. Публикуется и без `reminders_enabled` (решение — в notifications по категории `missed`).
- Смена графика действует со следующего слота; слот, на который успел прийти reminder, не повторяется.

## 3. social (8109, схема `social`) — новый
Вызывают: telegram-bff. Исходящие: identity-consent `/users/{id}/public` (имя пригласившего, возраст получателя). Потребляет `user.deletion.requested.v1`, `user.profile.created.v1` (дети попадают в семью опекуна).

Данные: `invites` (`invite_id`, `inviter_user_id`, `kind`, `token_hash` UNIQUE — sha256 токена; сам токен не хранится: `token = base64url(HMAC-SHA256(INVITE_TOKEN_KEY, invite_id))[:32]`, создатель видит ссылку повторно, `status`, `max_uses` (family 1, friend 1, referral NULL), `uses`, `expires_at`, `idempotency_key` UNIQUE(inviter, key), `created_at`); `invite_redemptions` (`invite_id`, `invitee_user_id`, `opened_at`, `accepted_at`, `declined_at`, `reminded_at`, PK(invite_id, invitee_user_id)); `families` (`family_id`, `owner_user_id` UNIQUE); `family_members` (`family_id`, `user_id` UNIQUE, `role`); `friendships` (`user_a`, `user_b`, `created_at`, PK по упорядоченной паре — спринт 1 только создание через приглашение).

| Метод | Путь | Тело → ответ |
|---|---|---|
| POST | `/internal/v1/me/invites` | `{kind}` + `Idempotency-Key` → 201 `Invite` (bff.ts, `link` = `TELEGRAM_APP_LINK?startapp=inv_<token>`); правила: family — только 18+ аккаунт (иначе 403 `ADULT_REQUIRED`); дети и подростки без согласия родителя → 403 `INVITES_NOT_ALLOWED`; ≤ 10 активных → 409 `INVITES_LIMIT`; `social.invite.created.v1` |
| GET | `/internal/v1/me/invites` | → `Page<Invite>` |
| DELETE | `/internal/v1/me/invites/{invite_id}` | → `Invite` (revoked); чужое → 404 |
| POST | `/internal/v1/invites:open` | `{token}`, `sub` = получатель → `InvitePreview`; первый раз — строка redemption + `social.invite.opened.v1`; самоприглашение → `can_accept=false, reason=self` |
| POST | `/internal/v1/invites/{invite_id}/accept` | `sub` = получатель → `InviteAcceptResult`; только после `:open`; 409 `INVITE_SELF`, `INVITE_ALREADY_USED`, `INVITE_EXPIRED`, `INVITE_REVOKED`, `FAMILY_ALREADY_MEMBER`; повтор — 200 тот же результат; family → получатель в семью пригласившего (`social.family.member_added.v1`), friend/referral → дружба; `social.invite.accepted.v1` |
| POST | `/internal/v1/invites/{invite_id}/decline` | → `InvitePreview`; `social.invite.declined.v1` |
| GET | `/internal/v1/invites/{invite_id}/preview` | `sub` = получатель, только если он уже открывал приглашение → `InvitePreview`; иначе 404 `INVITE_NOT_FOUND` (кнопка из напоминания `invite_<invite_id>`) |
| GET | `/internal/v1/me/family` | → `Family` или 404 `FAMILY_NOT_FOUND` |
| POST | `/internal/v1/invites:tick` | n8n → `{reminders, expired}`: открыто ≥ 24 ч, без ответа, без `reminded_at`, приглашение активно → `social.invite.reminder_due.v1` (одно на получателя); истёкшие → `expired` |

## 4. notifications (8104, схема `notifications`) — основа aievent
Политика (в момент отправки): категория включена у ученика (`DeliveryInfo.categories`, для `support`/`service` — всегда) → `notifications_enabled` (выключено → только центр уведомлений) → тихие часы (отложить до конца) → **дети** (`is_minor` и `age_band` 6-9/10-13): окно 08:00–20:00 местного, адресат — опекун, шаблон `*.kid` → лимит: ≤ 3 сообщения категорий `reminders`+`missed`+`social` в местные сутки на ученика (сверх — только центр, `telegram=in_app_only`) → дедупликация `dedup_key` UNIQUE.

| Потребляет | Шаблон | Категория | Правило |
|---|---|---|---|
| `learning.reminder.due.v1` | `lesson.reminder` / `lesson.reminder.kid` | reminders | `dedup_key = reminder:<user>:<date>`; устарело (> 3 ч после слота) → только центр |
| `learning.session.missed.v1` | `lesson.missed` / `lesson.missed.kid`; при `consecutive_missed ≥ 4` — `lesson.comeback` | missed | отправить в следующий слот-время утра (`preferred_time` следующего дня) или сразу, если ещё не 22:00; `consecutive_missed ≥ 4` — не чаще раза в 7 дней (`missed_state`) |
| `social.invite.accepted.v1` | `invite.accepted` → пригласившему | social | `invite.accepted:<invite>:<invitee>` |
| `social.invite.declined.v1` | — | — | только центр пригласившему (без Telegram) |
| `social.invite.reminder_due.v1` | `invite.pending` → получателю | social | одно |
| `social.family.member_added.v1` | `family.joined` → владельцу семьи (кроме добавления ребёнка самим родителем) | social | |
| `support.ticket.replied.v1`, `support.ticket.status.changed.v1`→RESOLVED | `support.reply`, `support.resolved` | support | как aievent |
| `experience.release_note.published.v1` | — | product | только центр (Telegram-рассылка — кампании спринта 2) |
| `user.deletion.requested.v1` | — | — | удаление журнала, центра, состояний → ACK `notifications` |
| `user.status.changed.v1`, `consent.revoked.v1`, `user.notification_settings.changed.v1`, `user.profile.updated.v1` | — | — | сброс кэша адресации |

Шаблоны RU/UZ — в коде (`templates.py`), язык — `DeliveryInfo.locale`; детские — мягкие, без «потери серии»/«провала». Тексты — без PII, кроме имени ребёнка в сообщении родителю и имени пригласившего/принявшего (notifications запрашивает имя у identity-consent `GET /internal/v1/users/{id}/public`). Кнопка «Открыть» (`startapp`): напоминание и пропуск → `route_home`; приглашение принято / в семье новый участник → `route_family`; неотвеченное приглашение → `invite_<invite_id>`; поддержка → `ticket_<number>`.

| Метод | Путь | Тело → ответ |
|---|---|---|
| GET | `/internal/v1/me/inbox?limit=&cursor=` | → `Page<InboxItem>` (bff.ts; `sub` = ученик; для детского профиля — его сообщения) |
| GET | `/internal/v1/me/inbox/unread-count` | → `{unread}` |
| POST | `/internal/v1/me/inbox:read` | `InboxReadRequest` → `{unread}` |
| POST | `/internal/v1/notifications/transactional` | как aievent (только identity-consent, код сброса PIN) |
| POST | `/internal/v1/notifications:dispatch` | n8n → `{sent, scheduled, in_app_only, failed}`: отправка отложенных (`scheduled_for ≤ now`) |

Журнал = центр уведомлений: каждая запись хранит `category`, отрисованные `title`/`body` на языке ученика (для центра), `startapp`, `telegram_status` (`sent|scheduled|in_app_only|failed|skipped`), `read_at`; срок 90 дней.

## 5. experience-config (8106) — основа aievent
- Payload miniapp: `{theme: {id: notebook|notebook_dark, version, tokens}, home: {sections}, flags}`; секции `today_plan, lesson_of_day, review, whats_new, family, news`; токены — `packages/ui-tokens/token-names.json` (контрактный тест), шрифты Onest/Unbounded/Caveat. Сид: miniapp 1.0.0 (текущая), admin 1.0.0.
- «Что нового» (`release_notes`): тексты `{ru, uz}` обязательны оба (пустой перевод → 422 `RELEASE_NOTE_TRANSLATION_MISSING`), `audience` ∈ `new|existing|all`, `segments {age?: [kids|teens|adults], ui_lang?: [ru|uz]}` (пусто = все), каталог маршрутов/иконок — `packages/contracts/release-notes.json`. Публикация → `experience.release_note.published.v1`.
- `release_note_views(user_id, release_note_id, seen_at, PK)` — отметки просмотра; участник саги удаления (`experience-config`, mode deleted).
- Сид: опубликованная заметка `welcome-1` (audience `new`, 5 пунктов знакомства: герой растёт за навыки, урок 20 минут, повторения, график и напоминания, семья) и черновик `2026.11` (audience existing).

| Метод | Путь | Тело → ответ |
|---|---|---|
| GET | `/internal/v1/experience/{app}/current` | как aievent |
| GET | `/internal/v1/release-notes/for-me?onboarded_at=<ISO>&lang=ru\|uz&age=kids\|teens\|adults` | `sub` = ученик → `WhatsNew` (bff.ts). Если ученик ещё не видел ни одной заметки `new` и такие опубликованы → `mode=welcome`: все опубликованные `new` + последняя `all`, ещё не просмотренные. Иначе `mode=updates`: непросмотренные `existing\|all`, опубликованные после `onboarded_at`. Фильтр по сегментам (`age`, `lang`); ≤ 5, новые первыми; пусто → `mode=none`. Без `onboarded_at` (онбординг не завершён) → `none` |
| POST | `/internal/v1/release-notes/seen` | `{release_note_ids}` → 204 (идемпотентно; неизвестный id игнорируется) |
| GET | `/internal/v1/release-notes/feed?lang=&age=&limit=&cursor=` | → `Page<WhatsNewNote>` — все опубликованные для сегмента (лента «Новости») |
| `/admin/v1/release-notes*` | staff | как aievent + поля `audience`, `segments`, тексты `{ru, uz}`; вызывает admin-bff (спринт 2) |

## 6. support (8103) — основа aievent
Категории — `TicketCategory` bff.ts; контекст — только `deeplink`, `client_version`. Остальное без изменений.

## 7. audit (8105) — основа aievent
Писатели через шину: identity-consent, learning-plan, social, experience-config, support, notifications. HTTP-писатели спринта 1: нет.

## 8. telegram-bot-gateway (8107 публичный webhook / 8108 внутренний)
Только транспорт. `/start [payload]` → сообщение с кнопкой web_app «Открыть TilHero» (payload `inv_…`, `gc_…`, `route_…` передаётся как `startapp` прямой ссылки); прочие команды и текст — одна подсказка с той же кнопкой. `POST /internal/v1/messages` (только notifications) — как aievent. Блокировка бота → identity-consent `bot-status`. Операторский чат и ops-сообщения — не в спринте 1.

## 9. telegram-bff (8001)
Маршруты — `bff.ts`. Сессия: `sub` = аккаунт, `lrn` = активный ученик (по умолчанию сам аккаунт). Для каждого запроса к учебным доменам BFF выпускает внутренний JWT с `sub = lrn`; к identity-consent `/me/*` и social — `sub = аккаунт`. `start_param` из initData возвращается в `SessionResponse`. `onboarding_completed` ученика — из learning-plan. `GET /v1/whats-new`: BFF берёт `onboarded_at` из плана ученика, `lang` — язык интерфейса плана, `age` — kids (6-9, 10-13), teens (14-17), adults (18+, и если возраст не выбран); режим выбирает experience-config. `GET /v1/invites/{invite_id}/preview` → social preview.

## 10. Уточнения по итогам реализации (18.11.2026, приняты координатором)
Пункты ниже — часть контракта; при расхождении с разделами 1–9 действует этот раздел.

**identity-consent**
- `GET/PATCH /me/learners/{id}` → `LearnerDetail` = `LearnerSummary` + `settings: NotificationSettings` ребёнка; `LoginResponse` тоже содержит `settings`.
- `/users/{id}/public` дополнительно отдаёт `guardian_consent` (social решает по нему, может ли подросток 14–17 приглашать и принимать приглашения).
- `DeliveryInfo.locale` ребёнка — язык опекуна. `user.notification_settings.changed.v1` выпускается при любом изменении настроек, при первом согласии и при блокировке/разблокировке бота; `enabled` в нём — итоговая доставка. Блокировка бота не меняет настройки, а выключает доставку аккаунту и его детям до разблокировки.
- Детский профиль создаётся с `guardian_consent=granted` и записью согласия с основанием `guardian` и id родителя.
- `POST /me/guardian-consent-requests` → 200; токен = HMAC(ключ сервиса, request_id) — повтор с тем же `Idempotency-Key` даёт ту же ссылку; хранится sha256. Срок — 7 дней.
- Новые коды: 404 `GUARDIAN_CONSENT_NOT_FOUND`, 422 `CONSENT_PURPOSES_INVALID {unknown}`, 422 `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_KEY_INVALID`; родитель без выбранного возраста → 403 `ADULT_REQUIRED {age_band: null}`. Админ-API aievent (снимки, раскрытие Telegram ID, статистика саги) вернутся по контракту спринта 2.

**learning-plan**
- `plans.schedule_set_at` — новый график действует со следующего слота; `deleted_users` → после удаления `/me/*` отвечает 410 `USER_DELETED`.
- Напоминание — в момент слота. `consecutive_missed` считается по выпущенным пропускам после последнего дня с занятием.
- Новые коды: `ACTIVITY_INVALID` (`occurred_at` вне −7 дней…+5 мин), `IDEMPOTENCY_KEY_REQUIRED|INVALID|REUSED`; ошибки формы PATCH → `PLAN_INVALID`. `GET /me/plan?tz=<IANA>` создаёт план с этой зоной (неизвестная → Asia/Tashkent).

**social**
- `social.family.member_added.v1` содержит обязательный `owner_user_id`.
- Лимиты: 10 активных приглашений, 20 созданий за 24 ч (`INVITES_LIMIT {window: active|24h}`), семья — до 10 участников (409 `FAMILY_FULL`); 409 `ALREADY_FRIENDS`; реферальное приглашение каждый получатель принимает один раз за всё время; подросток без согласия родителя не принимает никакие приглашения. Напоминание — по открытиям не старше 7 дней. При удалении владельца семья переходит к самому раннему взрослому участнику, без взрослых — распускается.

**notifications**
- Выключенная категория → запись `skipped`, в центр не попадает (в центр попадает только при выключенном общем выключателе, тихих часах, лимите, блокировке бота).
- `lesson.comeback.kid` — мягкий вариант для родителя. Пропуск, который не успели отправить до 22:00 следующего дня, — только центр.
- «Что нового» в центре создаётся при первом чтении центра учеником (адресатов в событии нет), заметки `audience=new` в центр не попадают; кнопка — `route_news`.
- Бот заблокирован → `in_app_only` + `telegram.delivery.failed.v1 {reason: blocked}`.

**telegram-bot-gateway**: белый список payload `/start` — `inv_`, `gc_`, `route_`, `invite_<uuid>`, `ticket_TCK-`, до 64 символов; при заданной `TELEGRAM_APP_LINK` бот присылает кнопку-ссылку `t.me/<bot>/<app>?startapp=…`, иначе `web_app` на `MINIAPP_URL?startapp=…`.

**experience-config**: оба перевода обязательны уже в черновике; `lang` и `age` в `for-me`/`feed` обязательны; после удаления ученика `for-me` и `seen` → 410 `USER_DELETED`; секция каждого типа — не больше одной; токены темы `notebook` — светлая палитра.

**telegram-bff**
- Сессия хранит `lrn` в Redis; после переключения ученика прежний access-токен → 401 `TOKEN_EXPIRED {reason: learner_switched}` (клиент делает refresh). Выход из детского профиля при заданном коде родителя требует `pin`.
- В детском профиле: приглашения → 403 `INVITES_NOT_ALLOWED`; создание детей, решение по согласию подростка, код родителя, биометрия, удаление аккаунта и обращения в поддержку → 403 `ADULT_REQUIRED`.
- Маршруты кода родителя и биометрии — как в aievent (`/v1/profile/security/pin*`, `/biometric`, `/v1/session/biometric/verify`); `/v1/profile/disable|enable` удалены. `GET /v1/plan?tz=` передаётся в learning-plan.

**Общий код**: каталог лимитов без туристических политик; `gw.llm.user` закреплена за ai-gateway (спринт 4). Вынести проверку `SCHEDULER_TOKEN` и `Idempotency-Key` в `tilhero_common` — техдолг спринта 2.

## 11. Исправления по ревью и QA (18.11.2026)
Источник: `docs/qa/sprint1-review-python.md`, `docs/qa/sprint1-review-ts.md`, `docs/qa/sprint1-qa-report.md`. Решения координатора:

**Необязательные цели согласия работают как выключатели функций (P-3).**
- identity-consent `/users/{id}/public` дополнительно: `consent_accepted: bool` (действующее согласие с terms и privacy; у ребёнка — согласие родителя с основанием guardian) и `purposes: string[]` (цели действующего согласия).
- `DeliveryInfo.categories`: `social` учитывается только при цели `social`, `product` — только при цели `product_news` (identity-consent фильтрует сам; notifications ничего не меняет).
- social: создать приглашение и принять приглашение — только при `consent_accepted` и цели `social` (403 `CONSENT_REQUIRED {purpose: "social"}`); открыть и посмотреть — при `consent_accepted` (иначе 403 `CONSENT_REQUIRED {purpose: "terms"}`). Детские профили — по-прежнему `INVITES_NOT_ALLOWED`.
- Mini App: при `CONSENT_REQUIRED {purpose: "social"}` — шторка «Разрешить приглашения и семью» → повторный `POST /v1/profile/consent` с добавленной целью → повтор действия.

**Согласие родителя за подростка 14–17 (P-4).**
- Решать может взрослый с действующим своим согласием (terms, privacy), иначе 403 `CONSENT_REQUIRED {purpose: "terms"}`.
- accept → запись `consents` подростка: основание `guardian`, `granted_by_user_id` = родитель, версия политики, хеш текста, evidence, locale; событие `consent.accepted.v1 {basis: guardian, granted_by_user_id}`. decline → только статус.
- `GET /internal/v1/me/guardian-consents` (sub = родитель) → `{items: GuardianConsentGrant[]}` — подростки, за которых решал этот родитель (последнее решение по каждому).
- `POST /internal/v1/me/guardian-consents/{teen_user_id}:revoke` → `GuardianConsentGrant`; только родитель, который дал согласие (иначе 404 `GUARDIAN_CONSENT_NOT_FOUND`); у подростка `guardian_consent=declined`, необязательные цели сняты; события `consent.revoked.v1 {basis: guardian, revoked_by_user_id}`, `user.profile.updated.v1`, `user.notification_settings.changed.v1`.
- BFF: `GET /v1/family/guardian-consents`, `POST /v1/family/guardian-consents/{teen_user_id}/revoke` (bff.ts).

**Прочее.**
- learning-plan `plan:tick` (P-1): обработка пачками со своей транзакцией, `last_tick_at` — после всех пачек; повтор, пока идёт предыдущий tick, не ждёт блокировку: 200 `{skipped: true}` (`pg_try_advisory_xact_lock`); пакетные запросы вместо поштучных внутри пачки.
- social `invites:tick` (QA D-02, P-5): напоминание только тому, кто сейчас может принять приглашение (те же правила, что `can_accept` в preview).
- social (P-2): `TELEGRAM_APP_LINK` обязателен в stage/prod, значение по умолчанию только для dev/test и совпадает с BFF. (P-6): проекция `profiles` без `age_band` и `guardian_user_id`, если они не используются.
- Потребители `user.deletion.requested.v1` принимают событие только от identity-consent (P-7). `SCHEDULER_TOKEN` в stage/prod — не короче 32 символов (P-8). bot-gateway: `MINIAPP_URL` в stage/prod обязателен и не localhost (P-12).
- BFF: `GET /v1/plan?tz=` передаётся в learning-plan, план при входе не создаётся без зоны клиента (QA D-03, T-2); в детском профиле `POST/DELETE /v1/profile/consent` → 403 `ADULT_REQUIRED` (T-5); 401 доменов не выдаются клиенту как 401 сессии (T-4).
- Mini App: экран «Код родителя» в профиле взрослого и предложение задать код при создании первого детского профиля (T-1); время занятия детского профиля — только в окне 08:00–19:30 с пояснением (QA D-04); перевод кодов ошибок доменов (T-3); текст `already_member` (T-7).

**Уточнения после исправлений.**
- identity-consent: действующее согласие — одно на ученика и основание (`self` | `guardian`); у подростка одновременно своё согласие и согласие родителя. `guardian_consent_requests` дополнительно хранит `consent_id` и `revoked_at`. Отзыв родителем снимает у подростка только необязательные цели — обучение и напоминания продолжаются. Список решений родителя — до 100 записей.
- learning-plan: ответ `plan:tick` — `{plans_checked, reminders, missed, skipped}`; блокировка повторов — сессионная `pg_try_advisory_lock` на выделенном соединении.
- social: create/accept без согласия с политикой → `CONSENT_REQUIRED {purpose: "terms"}`, без цели social → `{purpose: "social"}`; open/preview/decline требуют согласия с политикой; `can_accept` в карточке цель social не учитывает (кнопка ведёт к шторке разрешения). Напоминание о приглашении — только при `consent_accepted` и возможности принять.
- telegram-bff: язык «Что нового» и ленты — `locale` аккаунта; заголовок `X-Timezone` (bff.ts); 401 доменов (кроме `PIN_INVALID`, `BIOMETRIC_INVALID`, `RESET_CODE_INVALID`) → 503; в детском профиле `PUT /v1/profile/age` → 403 `ADULT_REQUIRED`.
- Техдолг спринта 2 (`tilhero_common`): пакетная запись outbox, проверка издателя удаления, проверка `SCHEDULER_TOKEN`, `Idempotency-Key`; learning-plan — чтение плана без создания; типы биометрии в bff.ts.
