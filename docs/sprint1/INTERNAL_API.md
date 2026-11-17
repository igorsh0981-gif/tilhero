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
