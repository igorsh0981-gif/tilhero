# Спринт 7 — внутренние контракты (социальное)

Публичные API:
- ученик — `packages/contracts/src/bff.ts`, раздел «Спринт 7»;
- админка — `admin.ts`, раздел «Социальное»;
- события — `packages/contracts/events/*.schema.json` (генерируются `infra/scripts/gen_event_schemas.py`).

Общие механизмы — как в спринтах 1–6: внутренний JWT (`sub` — аккаунт, `lrn`/`age_band` — активный ученик), actor, права в домене, outbox/inbox с проверкой издателя, ErrorBody, Idempotency-Key, пагинация, сага удаления, аудит, step-up заголовком `X-Step-Up: ok` от admin-bff.

## 0. Общее
- **Где что живёт:**
  - social — профиль сообщества (ник, код друга, скрытие), друзья и заявки, блокировки, жалобы и модерация, рефералы и кампании;
  - gamification — лиги и дуэли (оркестровка, результаты, награды), совместные достижения;
  - lessons — задания дуэли и парные комнаты;
  - ai-gateway — коуч парного урока и распознавание речи для комнаты.
- **Синхронные вызовы (новые):**
  - gamification → lessons (`POST /internal/v1/duel-sets`);
  - gamification → social и lessons → social (`GET /internal/v1/relations/{a}/{b}`);
  - lessons → ai-gateway (`cooperative_lesson_coach`, `speech:transcribe`);
  - lessons → identity-consent (согласие на голос — как memory в спринте 5).
- **Аудитории:** `kids` (6–13), `teens` (14–17), `adults` (18+), по `age_band` из токена или проекции.
  - 6–13: без друзей и заявок (как в спринте 1), без общей лиги; лига, дуэль и парный урок — только с членами своей семьи; парный урок — только выбор реплик.
  - 14–17: друзья и всё социальное — с согласием родителя (`guardian_consent = granted`, как приглашения спринта 1).
- **Санкция `social_ban`** (активная) запрещает: заявки в друзья, вызовы на дуэль, приглашения в парный урок, участие в общей лиге. Уже идущая дуэль или комната доигрывается. Ответ — 403 `SOCIAL_RESTRICTED {until | null}`.
- **Блокировка** A→B (односторонняя) отменяет pending-заявки, вызовы и приглашения между ними в обе стороны, удаляет дружбу и скрывает их друг от друга в поиске и лигах друзей. Новые заявки, вызовы и приглашения между ними — 403 `BLOCKED` (без раскрытия, кто заблокировал).
- **Приватность (APP-SOC-09):** наружу из social — только `nickname`, герой (из gamification), XP, место, разрешённые значки. Без имени, Telegram, возраста, ответов, ошибок, покупок. `user_id` наружу не отдаётся: в API ученика друзья и участники идут по `member_id` — непрозрачному стабильному идентификатору (HMAC от `user_id`, ключ `MEMBER_ID_KEY`, одинаков в social, gamification и lessons; telegram-bff его не расшифровывает).

## 1. social (8109)

### 1.1 Профиль сообщества
- **Таблица `community_profiles`:**
  - `user_id` PK;
  - `nickname` (3–20, `^[\p{L}\p{N}_]+$`, RU/UZ/EN буквы), `nickname_lc` UNIQUE;
  - `friend_code` UNIQUE (`TH-XXXX-XXXX`, алфавит без 0/O/1/I);
  - `game_profile_hidden` (false);
  - `nickname_reset_at`, `created_at`, `updated_at`.
- **Создание.** Профиль создаётся лениво при первом обращении. Ник `null`, пока ученик его не задал. Без ника нельзя в общую лигу, но можно дружить: друзьям виден код.
- **Ник:**
  - `PUT /internal/v1/me/community/nickname {nickname}` → 409 `NICKNAME_TAKEN`, 422 `NICKNAME_INVALID {reason: length|chars|forbidden}`;
  - фильтр запрещённых слов — список RU/UZ/EN в коде плюс нормализация (регистр, ё/е, латиница-кириллица двойники);
  - смена не чаще 1 раза в 7 дней → 429 `NICKNAME_COOLDOWN {until}`.
- **Код друга:** `POST /internal/v1/me/community/friend-code:rotate` → новый код, старый перестаёт работать (не чаще 3 раз в сутки).
- **Скрытие игрового профиля:** `PATCH /internal/v1/me/community {game_profile_hidden}` — не виден в лигах друзей и семьи (себе виден); в общей лиге участия нет.
- **`GET /internal/v1/me/community`** → `{member_id, nickname, friend_code, game_profile_hidden, restrictions: {social_ban_until | null}}`.
- **Событие** `social.profile.updated.v1 {user_id, member_id, nickname | null, game_profile_hidden}` → gamification.

### 1.2 Друзья
- **Таблица `friend_requests`:** `request_id`, `from_user`, `to_user`, `status` (`pending | accepted | declined | cancelled | expired`), `created_at`, `decided_at`. Один `pending` на пару в любую сторону; встречная заявка = принятие.
- **`GET /internal/v1/me/friends/search?q=`** — точный код (`TH-…`, без учёта дефисов и регистра) или точный ник → 0 или 1 карточка `{member_id, nickname, relation}`, `relation: none | friend | request_out | request_in | self`. Заблокированные в любую сторону и дети 6–13 не находятся. Лимит `tg.social.search` — 30/мин; нет — 200 `{items: []}`.
- **Заявки и дружба:**
  - `POST /internal/v1/me/friend-requests {member_id}` (Idempotency-Key) → 201. Ошибки: 409 `ALREADY_FRIENDS`, `REQUEST_EXISTS`, `FRIENDS_LIMIT` (200); 429 `REQUESTS_LIMIT` (20/сутки); 403 `BLOCKED`, `SOCIAL_RESTRICTED`, `FRIENDS_NOT_ALLOWED`;
  - `GET /internal/v1/me/friend-requests?direction=in|out`;
  - `POST …/{request_id}/accept | decline | cancel` — повтор с тем же исходом → 200;
  - `GET /internal/v1/me/friends?cursor` → `{member_id, nickname, since}` (порядок — по нику);
  - `DELETE /internal/v1/me/friends/{member_id}`.
- **Заявки через Telegram-приглашение** (спринт 1, `kind friend`) остаются: принятие создаёт дружбу сразу.
- **Блокировки** (таблица `blocks (blocker, blocked)`):
  - `POST /internal/v1/me/blocks {member_id}` → 201;
  - `DELETE /internal/v1/me/blocks/{member_id}`;
  - `GET /internal/v1/me/blocks`.
- **События:**
  - `social.friend_request.created.v1 {request_id, from_user_id, to_user_id}` → notifications;
  - `social.friendship.changed.v1 {user_a, user_b, status: added | removed, at}` → gamification;
  - `social.block.changed.v1 {blocker_user_id, blocked_user_id, status: added | removed}` → gamification, lessons.
- **Связь двух учеников** (для gamification и lessons): `GET /internal/v1/relations/{user_a}/{user_b}` → `{friends, same_family, blocked_any, a_restricted, b_restricted, a_audience, b_audience}`.
  - Вызывающие — gamification, lessons.
  - `member_id` переводится в `user_id` только внутри доменов: `GET /internal/v1/members/{member_id}` → `{user_id}` (только gamification, lessons, telegram-bff не допускается).

### 1.3 Жалобы и модерация
- **Таблицы:**
  - `cases`: `case_id`, `reporter_user_id`, `target_user_id`, `subject_kind` (`user | nickname | friend_request | invite | duel | pair_room`), `subject_id`, `reason` (`spam | abuse | inappropriate_nickname | cheating | other`), `comment` ≤ 500, `status` (`open | resolved | dismissed`), `resolution`, `created_at`, `resolved_by`, `resolved_at`;
  - `sanctions`: `sanction_id`, `user_id`, `kind` (`warning | social_ban | nickname_reset`), `until` | null, `basis` ≤ 500, `case_id`, `decided_by`, `decided_at`, `revoked_at`, `revoked_by`, `revoke_reason`;
  - `appeals`: `appeal_id`, `sanction_id`, `text` ≤ 1000, `status` (`open | upheld | overturned`), `decided_by`, `decided_at`, `decision_note`.
- **Ученик:**
  - `POST /internal/v1/me/complaints {member_id, subject_kind, subject_id?, reason, comment?, block?: bool}` (Idempotency-Key) → 201. Повтор на ту же цель за 24 ч → 200 тот же `case_id`. Лимит 10/сутки. `block: true` ставит блокировку;
  - `GET /internal/v1/me/sanctions` → активные и прошлые с `basis` и `until`;
  - `POST /internal/v1/me/sanctions/{id}/appeal {text}` → одно обжалование на санкцию.
- **Админ (`moderation.manage`):**
  - `GET /internal/v1/admin/moderation/cases?status&cursor` — без переписки: виден предмет жалобы (ник, id приглашения, дуэли или комнаты, статус) и счётчики (сколько жалоб на цель за 30 дней);
  - `POST …/cases/{id}/resolve {action: dismiss | warning | social_ban | nickname_reset, days?: 1..30 | null, basis ≥ 10}` — `days > 7` и бессрочный бан требуют step-up;
  - `POST …/sanctions/{id}/revoke {reason}`;
  - `GET …/appeals?status`, `POST …/appeals/{id}/decide {decision: upheld | overturned, note ≥ 10}` (overturned снимает санкцию).
- **Модерация и аудит:** каждая команда — аудит. Модератор видит историю санкций цели.
- **Админ (`social.read`):** `GET /internal/v1/admin/social/users/{user_id}` → профиль сообщества, число друзей, заявки (статусы и даты, без чужих ников), блокировки (число), дела и санкции.
- **События:**
  - `social.sanction.changed.v1 {user_id, sanction_id, kind, until | null, active}` → gamification, lessons, notifications;
  - `social.case.resolved.v1 {case_id, reporter_user_id, outcome: action_taken | dismissed}` → notifications (жалобщику — без подробностей).

### 1.4 Рефералы (APP-REF-01…04, ADM-REF-01/02)
- **Кампании `referral_campaigns`** — версии: `draft | active | archived`, одна активная.
  - Пример `payload`: `{require_diagnostic: true, min_lessons: 3, min_days: 2, window_days: 30, inviter_reward: {freeze: 2, til: 0}, invitee_reward: {freeze: 0, til: 0}, monthly_cap: 10, review: {velocity_per_day: 5, min_lesson_minutes: 3}}`.
  - Активация — `referral.manage` + step-up + комментарий; версия 1 — в миграции.
- **`referrals`:**
  - поля: `referral_id`, `inviter_user_id`, `invitee_user_id` UNIQUE, `invite_id`, `campaign_version`, `accepted_at`, `diagnostic_at`, `status`, `reject_code` (публичный), `risk_flags` (внутренние, только админке), `decided_by`, `decided_at`, `decision_note`, `qualified_at`;
  - `status`: `invited | diagnostic_done | learning | review | qualified | rewarded | rejected | expired | capped`;
  - `referral_lessons (referral_id, session_id UNIQUE, local_date, minutes)`.
- **Источники:** `social.invite.accepted.v1` (kind `referral`, свой) создаёт строку; `diagnostics.completed.v1` (diagnostics) → `diagnostic_at`; `lesson.session.completed.v1` (lessons; `kind lesson`, `status completed`, `practice_only false`) → `referral_lessons` (дубль `session_id` — одна запись).
- **Квалификация** (`referral_integrity_reviewer`, правила):
  - условия — диагностика (если требуется), `≥ min_lessons` уроков, `≥ min_days` различных `local_date`, в пределах `window_days` от принятия;
  - риски → `review`: пригласивший получил больше `velocity_per_day` квалификаций за сутки; больше половины уроков короче `min_lesson_minutes`; занятия приглашённого раньше принятия приглашения; приглашённый — член семьи пригласившего (семья — не реферал);
  - иначе — `qualified` → проверка `monthly_cap` пригласившего (календарный месяц по Ташкенту): `capped` (без награды) или событие `social.referral.qualified.v1` → после ack от gamification (`game.referral.rewarded.v1`) — `rewarded`;
  - окно истекло → `expired` (tick).
- **Ученик:** `GET /internal/v1/me/referrals?cursor` → `{referral_id, invitee_nickname | null, status, progress: {diagnostic: bool, lessons: n, lessons_required, days: n, days_required}, reward: {freeze, til} | null, reject_code | null, accepted_at}`. Причина отказа — публичные коды: `not_new_user | family_member | window_expired | review_rejected | monthly_cap`, без правил антифрода.
- **Админ (`referral.read`, `referral.manage`):**
  - кампании: список, черновик, проверка, активация, история;
  - очередь `review`: факты — даты, число уроков, дни, минуты, `risk_flags`, без ПДн. Команды: `POST …/referrals/{id}/approve {note}` и `…/reject {reject_code, note}` — `referral.manage`, причина ≥ 10, аудит; решение можно пересмотреть один раз с сохранением прежнего (`decision_history`);
  - статистика по кампаниям.
- **События:**
  - `social.referral.qualified.v1 {referral_id, inviter_user_id, invitee_user_id, campaign_version, inviter_reward, invitee_reward, qualified_at}` → gamification, notifications;
  - `social.referral.rejected.v1 {referral_id, inviter_user_id, reject_code}` → notifications;
  - `social.referral.held.v1 {referral_id}` → только аналитика.

### 1.5 tick и сага
- `POST /internal/v1/invites:tick` (существующий, n8n): истечение заявок в друзья через 30 дней, рефералов по окну, санкций по сроку (`social.sanction.changed.v1 active=false`).
- **Сага:**
  - удаляет профиль сообщества, заявки, дружбы (событие `removed` второму), блокировки и обжалования, рефералы ученика как приглашённого;
  - у пригласившего — обезличивает: `invitee_user_id → null`, статус сохраняется;
  - дела модерации обезличивает: `reporter/target → null`, решение и основание остаются;
  - санкции удаляет.

## 2. gamification (8117)

### 2.1 Проекции
- `friends` — из `social.friendship.changed.v1`;
- `blocks` — из `social.block.changed.v1`;
- `community` (`member_id`, `nickname`, `hidden`) — из `social.profile.updated.v1`;
- `families` — из `social.family.member_added.v1`;
- `sanctions` — из `social.sanction.changed.v1`;
- уровень для лиги — из `diagnostics.completed.v1`: `level_band` `A0-A1 | A2 | B1+` и `pair_id`.

### 2.2 Лиги недели (APP-SOC-08, ADM-GAME-02)
- **Неделя** — понедельник 00:00 – воскресенье 24:00 по Asia/Tashkent, одна на всех. **XP недели** — сумма XP-операций с reason `lesson | scenario | media | reading | review | skill_demonstrated | skill_retained | quest | quest_bonus | duel | pair_lesson` за неделю. Ручные операции, призы и бонусы не считаются.
- **Лига друзей** — на лету: я + друзья (без скрытых и заблокированных), без призов.
- **Семейная лига** — члены семьи. Дети 6–13 видят только её; опекун видит её и свою лигу друзей. Без призов.
- **Общая лига (только `teens` и `adults`):**
  - участие — `league_opt_in` в настройках игры (по умолчанию false); без ника — 409 `NICKNAME_REQUIRED`; при санкции — 403 `SOCIAL_RESTRICTED`;
  - группы `league_groups (week, pair_id, level_band, group_no)` по 20–30 участников: формируются в начале недели по tick; включившиеся в середине недели — в группу с местом или в новую;
  - `league_members (week, group_id, user_id, joined_at)`; рейтинг — по XP недели, при равенстве — кто раньше набрал;
  - **закрытие недели** (tick после конца недели) — одна транзакция на группу: `league_results (week, group_id, version, standings jsonb, closed_at, closed_by: system | staff:<id>)` неизменяемы; призы — операции `league_prize` (тилы по `rules.league.prizes`, по умолчанию `[50, 30, 20]` для 1–3 мест), ключ `league:<week>:<group>:<user>`; событие `game.league.closed.v1 {week, group_id, version, standings: [{user_id, place, xp, prize_til}]}`;
  - повтор закрытия ничего не меняет.
  - **Аномалии.** XP недели больше чем 5 × медиана группы и больше 1500 → отметка `anomaly` у участника; призы группы удерживаются до решения админа.
- **Переоценка группы** (`league.manage` + step-up + причина) — исключить участника или пересчитать:
  - создаётся `version + 1`, прежняя запись хранится;
  - разница призов — обратными записями и новыми операциями;
  - событие с новой `version`.
- **API ученика:**
  - `GET /internal/v1/game/leagues` → `{week, ends_at, friends: Standings, family: Standings | null, general: {opt_in, group: Standings | null, prizes}}`. `Standings`: до 50 строк `{member_id, nickname | null (друзьям — ник или «Друг»), hero: {code, stage, image}, xp, place, badges: [code] (только разрешённые: значки, не связанные с ошибками), me}`;
  - `PATCH /internal/v1/game/settings {league_opt_in}`;
  - `GET /internal/v1/game/leagues/history?cursor` — мои итоги прошлых недель.
- **Тексты.** Детям — без мест «последний», формулировки «вместе набрали».

### 2.3 Дуэли (APP-SOC-07, ADM-GAME-02)
- **Таблица `duels`:**
  - поля: `duel_id`, `challenger`, `opponent`, `pair_id`, `level_band`, `status`, `set_id`, `accept_deadline` (+24 ч), `play_deadline` (+48 ч после принятия), `scores` `{user: {correct, total, finished_at}}`, `result` (`challenger | opponent | draw | none`), `result_version`, `created_at`, `finished_at`;
  - `status`: `challenged | declined | expired | accepted | finished | cancelled`.
- **Вызов:** `POST /internal/v1/game/duels {opponent_member_id, pair_id?}` (Idempotency-Key):
  - проверка через social relations: друзья (14+) или одна семья (с детьми); нет блокировки и санкций;
  - не больше 3 активных вызовов от ученика; не больше 1 активной дуэли между парой;
  - уровни участников различаются больше чем на одну полосу → 409 `LEVELS_INCOMPATIBLE` (набор берётся по нижней полосе, если разница — одна полоса);
  - → `game.duel.challenged.v1` (notifications).
- **Ответ на вызов:** `POST …/duels/{id}/accept | decline`. Принятие → синхронно `POST lessons /internal/v1/duel-sets {duel_id, pair_id, level_band, user_ids}` → `set_id` (недоступность lessons → 503 `DUEL_SET_UNAVAILABLE`, дуэль остаётся `challenged`).
- **Попытка.** Прохождение — в lessons (§3.1). Consumer `lesson.session.completed.v1 kind duel` (только lessons) пишет `scores`.
- **Завершение** — оба сыграли или `play_deadline` (tick):
  - победитель — больше `correct`, при равенстве — ничья;
  - сыграл один — техническая победа сыгравшего; никто — `cancelled`;
  - XP по `rules.duel`: `{win: 30, draw: 15, participation: 10, daily_cap: 3}` — reason `duel`, ключ `duel:<id>:<user>`, не больше 3 наградных дуэлей в день на ученика;
  - событие `game.duel.finished.v1`.
- **API ученика:** `GET /internal/v1/game/duels?status=active|finished&cursor` — соперник как `member_id` + ник, мой и чужой счёт только после завершения; `GET …/duels/{id}`.
- **Споры (админ, `league.manage`):**
  - `POST /internal/v1/admin/game/duels/{id}/reevaluate {result, reason}` + step-up → `result_version + 1`, прежний результат в `duel_results_history`, награды исправляются обратными записями;
  - событие `game.duel.finished.v1` с новой версией.

### 2.4 Рефералы и парные уроки
- **Рефералы.** Consumer `social.referral.qualified.v1` (только social): пригласившему `inviter_reward` (freeze, til), приглашённому `invitee_reward` — reason `referral_bonus` / `referral_welcome`, ключ `referral:<id>:<role>` → событие `game.referral.rewarded.v1 {referral_id}`. Правило спринта 6 «после первого урока» отключено: `referrals` gamification — только история, pending → `void` миграцией.
- **Парные уроки.** Consumer `lesson.pair.completed.v1` (только lessons): участнику с `contributed = true` — XP `rules.pair_lesson.xp` (по умолчанию 25), reason `pair_lesson`, ключ `pair:<room>:<user>`. Если `team_goal_reached` и вклад обоих — значок `together_1` обоим (APP-SOC-06). Молчавший ничего не получает.

### 2.5 Правила
`rules` (версия 3 миграцией, на основе активной): `+ league {prizes: [50, 30, 20], group_size: [20, 30], anomaly: {median_factor: 5, min_xp: 1500}}`, `+ duel {...}`, `+ pair_lesson {xp: 25}`; `bonuses.referral_*` больше не используются. Валидатор — как в спринте 6.

### 2.6 Админ (`league.read`, `league.manage`)
- `GET /internal/v1/admin/game/leagues?week` — группы, размеры, статус закрытия, аномалии;
- `GET …/leagues/{group_id}` — участники с XP, призами и версиями результата;
- `POST …/leagues/{group_id}/reevaluate {exclude_user_ids, reason}` (step-up);
- `POST …/leagues/{group_id}/release-prizes {reason}` — снятие удержания по аномалиям;
- `GET …/duels?status&cursor`, `GET …/duels/{id}`, `POST …/duels/{id}/reevaluate`.

## 3. lessons (8112)

### 3.1 Задания дуэли (`duel_host`, код)
- **`POST /internal/v1/duel-sets {duel_id, pair_id, level_band, user_ids}`** (только gamification): 10 закрытых заданий (choice, gap, order, match) с ключами из каталога пары и полосы уровня.
  - Выбор детерминирован (`sha256(duel_id)`), сложность — сбалансирована по навыкам.
  - Один набор на дуэль: повтор → тот же `set_id`.
  - Ключи в ответ не идут.
- **`POST /internal/v1/me/duel-sessions {duel_id}`** (telegram-bff) → сессия `kind duel`: только участник набора, одна на участника — повтор возвращает ту же.
  - Задания — без подсказок и ИИ. Ответ — по ключу (как закрытые задания урока), повтор `submission_id` — один результат.
  - Завершение → `lesson.session.completed.v1 {kind: duel, duel_id, score: {correct, total}}`.
  - После дедлайна (из набора) — 409 `DUEL_CLOSED`.
- **Разбор ошибок** — только после завершения дуэли (`game.duel.finished.v1`). До этого `GET …/sessions/{id}` не отдаёт ключи.

### 3.2 Парные комнаты (`cooperative_lesson_coach`, APP-SOC-03…06)
- **Таблицы:**
  - `pair_rooms`: `room_id`, `pair_id`, `scenario_id`, `mode` (`free | choices`), `status`, `start_at`, `inviter`, `invitee`, `created_at`, `started_at`, `ended_at`, `end_reason`, `ai_cost_usd`, `seq`;
  - `status`: `invited | declined | expired | waiting | in_progress | paused | finished | abandoned | stopped`;
  - `room_participants`: `room_id`, `user_id`, `role` (`A | B`), `joined_at`, `last_seen_at`, `network` (`online | offline`), `turns`, `speaking_seconds`, `minutes`, `contributed`, `report` (json, приватный);
  - `room_events`: `room_id`, `seq`, `kind`, `payload`, `at` — лента для long-poll; тексты реплик видят только участники.
- **Приглашение.** `POST /internal/v1/me/pair-rooms {partner_member_id, pair_id, scenario_id, start: now | <ISO ≤ 7 дней>}` (Idempotency-Key):
  - проверка relations: друзья (14+) или одна семья; блокировки и санкции; аудитория: дети — только `choices`;
  - не больше 1 активной комнаты на ученика;
  - → `lesson.pair.invited.v1 {room_id, inviter_user_id, invitee_user_id, scenario_id, start_at}` → notifications;
  - `accept | decline`; без ответа: старт сейчас — 15 мин, запланированный — до `start_at + 15 мин` → `expired`.
- **Вход и присутствие.** `POST …/{id}/join` (оба → `in_progress`, коуч раздаёт роли A/B и цель), `POST …/{id}/heartbeat` (каждые 10 с), `POST …/{id}/leave`.
  - Без heartbeat 30 с → участник `offline`; если сейчас его ход — `paused`.
  - Возврат в течение 3 мин — продолжение без новой сессии и без повторного учёта.
  - Больше 3 мин нет участника — оставшийся завершает соло с коучем или выходит → `abandoned` для ушедшего, отчёт по сделанному.
- **Лента.** `GET …/{id}/state?after_seq=N` — long-poll до 25 с → `{status, seq, events[], my_role, next_speaker: A | B | both | null, prompt, options?, team_goal_progress}`.
- **Ход.** `POST …/{id}/turns {text? | choice_id? | audio_id?}` (Idempotency-Key): только чей ход → 409 `NOT_YOUR_TURN`. Текст ≤ 300; дети — только `choice_id`.
  - Голос: `POST …/{id}/audio` (тело — запись до 30 с, как произношение спринта 5) → `audio_id`. Только с согласием на голос (политика 1.1+), иначе 403 `VOICE_CONSENT_REQUIRED`. Распознавание — ai-gateway `POST /internal/v1/speech:transcribe` (Whisper в tts). Аудио не хранится; длительность идёт в `speaking_seconds`.
  - Без голоса `speaking_seconds` = время от подсказки до ответа (не больше 60 с на ход).
- **Коуч.**
  - ai-gateway `cooperative_lesson_coach` (вход и выход — по скиллу 11) → следующий говорящий, реплика, прогресс цели, `individual_evidence[]`.
  - Безопасность и дети — фильтр `safety_quality_gate` как у `conversation_partner`.
  - Без ИИ (бюджет, аварийная остановка, недоступность) — сценарий из каталога: реплики персонажей и варианты для ролей A/B по очереди (`mode` → `choices`).
- **Оценка.** Свободные ответы каждого → assessment отдельными доказательствами этого ученика (как реплики разговора урока). Молчавший (`turns = 0`) — без оценки, отчёт «не участвовал».
- **Отчёт.** `GET …/{id}/report` — только свой: реплики, секунды, навыки, 1–3 подсказки, общий итог команды. Чужие ошибки не показываются.
- **Минуты.** `minutes` = ⌈время в `in_progress` у участника / 60⌉ — учитываются, не списываются (спринт 8). Переподключение не создаёт вторую сессию.
- **Завершение** → `lesson.pair.completed.v1 {room_id, scenario_id, pair_id, team_goal_reached, participants: [{user_id, contributed, turns, speaking_seconds, minutes}], ended_at, end_reason}`. Плюс по участнику `lesson.session.completed.v1 {kind: pair, session_id = room_id, evaluation_id}` — для памяти, плана и рефералов это не урок (`kind pair`).
- **Админ (`room.read`, `room.manage`):**
  - `GET /internal/v1/admin/pair-rooms?status&from&to&cursor` — комната, участники (`user_id`), сценарий, статус, длительность, секунды каждого, стоимость ИИ. Без реплик и оценок;
  - `GET …/{id}` — то же плюс ход событий без текстов;
  - `POST …/{id}/stop {reason ≥ 10}` (step-up) → `stopped`, участникам — событие в ленте и уведомление, отчёт по сделанному.
- **tick** (n8n `lessons-tick`, существующий): истечение приглашений, `offline` по heartbeat, автозавершение комнат без активности 10 мин, закрытие наборов дуэлей после дедлайна.

## 4. ai-gateway
- **Агент `cooperative_lesson_coach`** → `llm`, версия 1 (черновик, `owner_role methodist`).
  - Инструкции — по скиллу 11; выход — JSON-схема: `next_speaker`, `prompt` ≤ 300, `options` ≤ 3 для `choices`, `team_goal_progress` 0..1, `individual_evidence[]`, `status`.
  - 8 золотых тестов: молчащий участник, монополизация, чужой транскрипт, ребёнок, переподключение, грубость, уход от темы, оценка без вклада.
  - Бюджет: на комнату `ai_room_cap_usd` (0,10) и общий месячный.
  - Публикует владелец после золотых тестов; до публикации комнаты идут по сценарию с выбором.
- **`duel_host`** → `code` (`implemented_in lessons`), **`referral_integrity_reviewer`** → `rules` (`implemented_in social`).
- **`POST /internal/v1/speech:transcribe`** (только lessons) → `{text, words, duration_ms}` через tts recognize. Расход $0, аварийная остановка речи действует.

## 5. notifications
- **Шаблоны RU/UZ:**
  - `friend_request`, `friend_accepted`;
  - `duel_challenged`, `duel_finished`;
  - `league_closed` (место и приз);
  - `pair_invited`, `pair_starting` (за 5 мин до запланированного);
  - `referral_qualified`, `referral_rejected`;
  - `sanction_applied`, `appeal_decided`, `complaint_resolved`.
- **Дети** — как в спринте 6 (центр детского профиля, без push).
- **Категории `game` и `social` — полноценные:**
  - `game` в `NotificationCategory` (bff.ts, admin.ts), identity-consent (`CATEGORIES` + миграция), telegram-bff, admin-bff, Mini App (настройки уведомлений);
  - `GAME_CATEGORY_GATE=game`, по умолчанию категория включена;
  - центр без Telegram при выключенной — как в спринте 6.

## 6. identity-consent, admin-identity, experience-config, audit
- **identity-consent:** категория уведомлений `game`; сага — домены без изменений (`social`, `gamification`, `lessons` уже есть).
- **admin-identity:** права `social.read`, `moderation.manage`, `referral.read`, `referral.manage`, `league.read`, `league.manage`, `room.read`, `room.manage`; step-up — санкции больше 7 дней и бессрочные, активация кампании, переоценка лиг и дуэлей, остановка комнаты; роли — PLAN.
- **experience-config:** `ADMIN_MENU` — `friends`, `moderation`, `referrals`, `leagues`, `pair_rooms`.
- **audit:** издатели без изменений (social, gamification, lessons уже есть).

## 7. События (новые)
| Событие | Издатель | Потребители |
|---|---|---|
| `social.profile.updated.v1` | social | gamification |
| `social.friend_request.created.v1` | social | notifications |
| `social.friendship.changed.v1` | social | gamification, notifications (`added` → `friend_accepted`) |
| `social.block.changed.v1` | social | gamification, lessons |
| `social.sanction.changed.v1` | social | gamification, lessons, notifications |
| `social.case.resolved.v1` | social | notifications |
| `social.referral.qualified.v1` · `.rejected.v1` · `.held.v1` | social | gamification, notifications |
| `game.referral.rewarded.v1` | gamification | social |
| `game.league.closed.v1` | gamification | notifications |
| `game.duel.challenged.v1` · `.finished.v1` | gamification | notifications, lessons (разбор после финиша) |
| `lesson.pair.invited.v1` · `.completed.v1` | lessons | notifications · gamification |
| `lesson.session.completed.v1` | lessons | `kind` + `duel`, `pair`; поля `duel_id`, `score` (необязательные) |

## 8. Ошибки (новые коды)
`NICKNAME_TAKEN`, `NICKNAME_INVALID`, `NICKNAME_COOLDOWN`, `NICKNAME_REQUIRED`, `ALREADY_FRIENDS`, `REQUEST_EXISTS`, `FRIENDS_LIMIT`, `REQUESTS_LIMIT`, `FRIENDS_NOT_ALLOWED`, `BLOCKED`, `SOCIAL_RESTRICTED`, `MEMBER_NOT_FOUND`, `COMPLAINTS_LIMIT`, `APPEAL_EXISTS`, `LEVELS_INCOMPATIBLE`, `DUELS_LIMIT`, `DUEL_EXISTS`, `DUEL_SET_UNAVAILABLE`, `DUEL_CLOSED`, `ROOM_LIMIT`, `ROOM_NOT_ACTIVE`, `NOT_YOUR_TURN`, `VOICE_CONSENT_REQUIRED`, `PARTNER_NOT_ALLOWED`, `CAMPAIGN_INVALID`, `REFERRAL_STATE`, `RESULT_STATE`.
