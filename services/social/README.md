# social-service

**Владелец:** команда Telegram-контура. **Bounded context:** приглашения (семья, друг, реферал) по deep link, семья,
дружба через приглашение (INTERNAL_API §3, AT-09, AT-10). Спринт 7 (docs/sprint7/INTERNAL_API.md §1) — профиль
сообщества, друзья и заявки, блокировки, жалобы и модерация, рефералы и кампании, связь учеников для gamification и
lessons — раздел «Спринт 7» ниже. Лиги и дуэли — gamification, парные комнаты — lessons.

Порт 8109, схема PostgreSQL `social`, внутренний JWT с `aud = social`. Redis не нужен. Пакет `tilhero_social`.

## API
Вызывает только `telegram-bff`; `sub` — **аккаунт** (не детский профиль). Формы ответов = `bff.ts`
(`Invite`, `InvitePreview`, `InviteAcceptResult`, `Family`). Чужое приглашение неотличимо от несуществующего (404).

| Метод | Путь | Тело → ответ |
|---|---|---|
| POST | `/internal/v1/me/invites` | `{kind: family\|friend\|referral}` + `Idempotency-Key` → 201 `Invite`; 403 `ADULT_REQUIRED` / `INVITES_NOT_ALLOWED` / `CONSENT_REQUIRED {purpose: terms\|social}`; 409 `INVITES_LIMIT {limit, window: active\|24h}`; `social.invite.created.v1` |
| GET | `/internal/v1/me/invites?limit=&cursor=` | → `Page<Invite>` (новые первыми; `limit` 1…100, по умолчанию 20; битый курсор — 400 `INVALID_CURSOR`) |
| DELETE | `/internal/v1/me/invites/{invite_id}` | → `Invite` (`revoked`); чужое/нет — 404 `INVITE_NOT_FOUND`; повтор — без изменений |
| POST | `/internal/v1/invites:open` | `{token}` → `InvitePreview`; 403 `CONSENT_REQUIRED {purpose: terms}` (до поиска токена и записи открытия); первый раз — строка ответа + `social.invite.opened.v1`; своё — `can_accept=false, reason=self` без записи; неизвестный/битый токен — 404 |
| GET | `/internal/v1/invites/{invite_id}/preview` | → `InvitePreview` только тому, кто уже открывал; иначе 404; 403 `CONSENT_REQUIRED {purpose: terms}` |
| POST | `/internal/v1/invites/{invite_id}/accept` | → `InviteAcceptResult`; только после `:open` (иначе 404); 409 `INVITE_SELF`, `INVITE_ALREADY_USED`, `INVITE_EXPIRED`, `INVITE_REVOKED`, `FAMILY_ALREADY_MEMBER`, `FAMILY_FULL`, `ALREADY_FRIENDS`; 403 `INVITES_NOT_ALLOWED`, `CONSENT_REQUIRED {purpose: terms\|social}`; повтор тем же получателем — 200 тот же результат |
| POST | `/internal/v1/invites/{invite_id}/decline` | → `InvitePreview`; `social.invite.declined.v1` (только по активному); повтор и отклонение после принятия — без изменений; 409 `INVITE_SELF`; 403 `CONSENT_REQUIRED {purpose: terms}` (ответ — карточка) |
| GET | `/internal/v1/me/family` | → `Family` или 404 `FAMILY_NOT_FOUND` |
| POST | `/internal/v1/invites:tick` | n8n, `Authorization: Bearer <SCHEDULER_TOKEN>` → `{reminders, expired}`; напоминание — только тому, кто сейчас может принять (D-02) |

### Ссылка и токен
`token = base64url(HMAC-SHA256(INVITE_TOKEN_KEY, invite_id))[:32]` (192 бита), в БД — только `sha256(token)`
(`token_hash UNIQUE`). Ссылка `TELEGRAM_APP_LINK?startapp=inv_<token>` пересчитывается из `invite_id` — создатель видит
её повторно. Смена `INVITE_TOKEN_KEY` делает все выданные ссылки недействительными.

### Правила
- Сроки: family — 7 дней, одноразовая; friend — 30 дней, одноразовая; referral — без срока, многоразовая
  (`accepted_count`). Статус в ответах — `expired`, как только срок прошёл (не дожидаясь tick).
- **Кто приглашает:** активный аккаунт; family — только 18+ (иначе `ADULT_REQUIRED`); friend/referral — 18+ или
  14–17 с `guardian_consent = granted`; ребёнок 6–13, детский профиль, возраст не выбран, аккаунт не ACTIVE →
  `INVITES_NOT_ALLOWED`. Лимиты: ≤ `MAX_ACTIVE_INVITES` (10) активных и ≤ `MAX_INVITES_PER_DAY` (20) созданий за
  скользящие 24 ч (отзыв лимит не возвращает) → 409 `INVITES_LIMIT`.
- **Кто принимает:** активный аккаунт 18+ или 14–17 с согласием родителя (иначе 403 `INVITES_NOT_ALLOWED`, в
  карточке `not_allowed`). Дети 6–13 приглашений не получают — детский профиль попадает в семью опекуна сам
  (`user.profile.created.v1`).
- **Принятие двустороннее:** пригласивший создаёт ссылку, получатель открывает и принимает. Самоприглашение →
  `INVITE_SELF`; повторная активация одноразовой ссылки другим человеком → `INVITE_ALREADY_USED`; реферал принимается
  получателем только один раз за всё время (вторая реферальная ссылка → `INVITE_ALREADY_USED`).
- **family:** получатель попадает в семью пригласившего (если тот уже участник чужой семьи — в неё; если семьи нет —
  создаётся, пригласивший — `owner`); роль `adult` (18+) или `teen` (14–17); человек — не больше чем в одной семье
  (`FAMILY_ALREADY_MEMBER`); размер ≤ `FAMILY_MAX_MEMBERS` (10) → `FAMILY_FULL` (детей опекуна это не ограничивает).
  `social.family.member_added.v1` — для принятого и для ребёнка (владельцу о себе события нет).
- **friend/referral:** дружба — упорядоченная пара; уже друзья → `ALREADY_FRIENDS`.
- **Согласие** (INTERNAL_API §11, ревью P-3; `consent_accepted` и `purposes` из `/users/{id}/public`):
  создать и принять приглашение — при действующем согласии с политикой и необязательной цели `social`; открыть,
  посмотреть и отклонить (ответ — карточка) — при действующем согласии. Нет согласия с политикой → 403
  `CONSENT_REQUIRED {purpose: "terms"}` (Mini App показывает политику); согласие есть, цели нет → 403
  `CONSENT_REQUIRED {purpose: "social"}` (шторка «Разрешить приглашения и семью» → повторный
  `POST /v1/profile/consent` → повтор действия). Порядок проверок: сначала правила профиля (дети, подростки без
  согласия родителя, статус → `INVITES_NOT_ALLOWED` / `ADULT_REQUIRED` — шторка согласия им не поможет), при
  принятии — ещё и состояние приглашения (`INVITE_REVOKED`, `INVITE_EXPIRED`, … — принимать уже нечего), затем
  согласие. Открытие проверяет согласие до поиска токена: без согласия не пишется даже строка открытия. В карточке
  `can_accept` цель `social` не учитывает (иначе Mini App не покажет кнопку, ведущую к шторке). Отзыв своего
  приглашения, список своих и `GET /me/family` согласия не требуют.
- Причина в карточке (`reason`, порядок): `self` → `revoked` → `expired` → уже принял сам (`already_member` /
  `already_friends`) → `already_used` → `not_allowed` → для family `already_member` / `not_allowed` (семья полна),
  для friend/referral `already_friends` / `already_used` (реферал уже был).
- Конкурентность: принятие сериализуется advisory-блокировкой пригласившего и получателя (в порядке uuid) и
  FOR UPDATE приглашения — одноразовую ссылку принимает ровно один (проверено параллельным тестом).

### identity-consent
`GET /internal/v1/users/{id}/public` (ServiceClient, `sub` не передаётся) → имя пригласившего и участников семьи,
`kind`, `age_band`, `status`, `guardian_consent`, `consent_accepted`, `purposes`. 404 — пользователь удалён (в семье
не показывается); прочие ошибки — 503 `UPSTREAM_UNAVAILABLE {service: identity-consent}` (коды identity-consent наружу
не пробрасываются). `guardian_consent` нет в ответе — из проекции `profiles` (`user.profile.updated.v1`).
**Fail closed:** нет `consent_accepted` / `purposes` в ответе (identity-consent старой версии) — считается, что
согласия нет: создать, открыть, посмотреть, принять и отклонить приглашение нельзя (403 `CONSENT_REQUIRED
{purpose: terms}`), напоминаний нет. Выкладывать social вместе с identity-consent, который отдаёт эти поля (или
после него). Имена не хранятся и не логируются.

## invites:tick (n8n `invites-tick`, каждый час)
Вход как у всех расписаний: Bearer `SCHEDULER_TOKEN` (пустой — вход выключен, 401), внутренний JWT → 403
`CALLER_NOT_ALLOWED`.
1. `active` с `expires_at ≤ now` → `expired` (счётчик `expired`).
2. Ответы, открытые ≥ `INVITE_REMINDER_AFTER_HOURS` (24) и не раньше `INVITE_REMINDER_MAX_AGE_DAYS` (7) назад, без
   принятия/отклонения/напоминания, по активному приглашению → `reminded_at` + `social.invite.reminder_due.v1` (одно на
   получателя приглашения) — **только если получатель сейчас может принять** (QA D-02, ревью P-5): те же правила, что
   `can_accept` в карточке (`preview_reason is None`: активный аккаунт 14+, подросток — с согласием родителя; не в
   семье, семья не заполнена; не друзья; реферал не использован) и действующее согласие с политикой
   (`consent_accepted`, как для просмотра карточки). Профили получателей — `/users/{id}/public` вне транзакций БД (не
   больше 8 запросов одновременно); identity-consent недоступен или пользователь не найден — без напоминания в этот
   раз, tick не падает.
3. Кто сейчас принять не может — без напоминания **и без отметки**: строка проверяется в следующих tick, пока
   открытие не старше 7 дней (подросток получил согласие родителя — напоминание придёт, одно). Поэтому кандидаты
   просматриваются целиком страницами по `TICK_BATCH_SIZE` (ключ `opened_at, invite_id, invitee_user_id`), отложенные
   не вытесняют остальных. Строки берутся FOR UPDATE SKIP LOCKED с повторной проверкой условий — параллельные запуски
   не дублируют. Число отложенных — в логе (`count`, без идентификаторов).

## События
Публикует: `social.invite.created|opened|accepted|declined|reminder_due.v1`, `social.family.member_added.v1`,
`user.domain.deleted.v1` (`domain = social`, `mode = deleted`).

Потребляет: `user.deletion.requested.v1` (`social.user_deletion`, только от `identity-consent` — ревью P-7: от другого
издателя — предупреждение в логе с типом события и издателем, без `user_id`; событие подтверждается шине без
удаления и без ACK); `user.profile.created.v1`, `user.profile.updated.v1` (`social.profiles`, только от
`identity-consent`).

## Данные
Схема `social`: `invites`, `invite_redemptions` (FK → invites ON DELETE CASCADE), `families` (`owner_user_id UNIQUE`),
`family_members` (`user_id UNIQUE`, FK → families CASCADE), `friendships` (`user_a < user_b`), `profiles` (проекция:
`kind` и `guardian_consent` — запасной источник согласия родителя; без имени, даты рождения, возраста и опекуна —
CONVENTIONS §8, ревью P-6: опекун ребёнка берётся из `user.profile.created.v1` в момент добавления в семью),
`deleted_users` (отметка исполненного удаления), `outbox`/`inbox`. Миграция 0001 (изменена до первого prod: колонки
`age_band`, `guardian_user_id` убраны).

Сага удаления: приглашения пользователя (каскадом — ответы на них), его ответы на чужие приглашения, дружбы,
членство в семье, проекция → ACK. Владелец семьи уходит — семья переходит к самому раннему взрослому участнику; нет
взрослых — семья распускается. Повтор саги снова подтверждается; запоздавшие события профиля удалённого не
воскрешают проекцию.

## Настройки
`DATABASE_URL`, `MIGRATION_DATABASE_URL`, `DB_SCHEMA=social`, `NATS_URL`, `SCHEDULER_TOKEN` (в stage/prod — пусто,
т. е. вход выключен, или ≥ 32 символов; ревью P-8), `INVITE_TOKEN_KEY` (обязателен в stage/prod, ≥ 32 символов),
`TELEGRAM_APP_LINK` (https, без query; **обязателен в stage/prod** — ревью P-2; в dev/test по умолчанию
`https://t.me/tilhero_dev_bot/app`, как у telegram-bff: ссылки приглашений и согласия родителя ведут в одно
приложение; в stage/prod — то же значение, что у telegram-bff и bot-gateway), `IDENTITY_CONSENT_URL`,
`INVITE_FAMILY_TTL_DAYS` (7), `INVITE_FRIEND_TTL_DAYS` (30), `MAX_ACTIVE_INVITES` (10), `MAX_INVITES_PER_DAY` (20),
`FAMILY_MAX_MEMBERS` (10), `INVITE_REMINDER_AFTER_HOURS` (24), `INVITE_REMINDER_MAX_AGE_DAYS` (7), `TICK_BATCH_SIZE`.

## Runbook
- Ссылки не открываются (404 на все): проверить, не сменился ли `INVITE_TOKEN_KEY`.
- Карточки/семья отвечают 503: недоступен identity-consent (`/users/{id}/public`).
- Нет напоминаний о неотвеченных приглашениях: ответ n8n `invites-tick`, `reminded_at` в `invite_redemptions`; в логе
  `invites:tick: reminders deferred` — получатель сейчас не может принять (карточка показала бы `reason`) или
  identity-consent был недоступен.
- Все действия с приглашениями → 403 `CONSENT_REQUIRED {purpose: terms}` у всех: identity-consent не отдаёт
  `consent_accepted` / `purposes` (старая версия) — обновить identity-consent.

---

# Спринт 7 — социальное (INTERNAL_API спринта 7 §0, §1; AT-73, AT-78, AT-79, AT-82)

Социальное не меняет учёбу. Ученик API — **активный ученик**: claim `lrn` (без него — `sub`), `age_band` — его полоса
(вызывающий — только telegram-bff; приглашения и семья спринта 1 по-прежнему от имени аккаунта `sub`). Другие ученики —
только `member_id` и ник: user_id, имени, Telegram и возраста в ответах нет. Формы ответов — `bff.ts` «Спринт 7» и
`admin.ts` «Социальное» (telegram-bff и admin-bff проксируют как есть).

**member_id** (§0) = `"mb_" + base64url(HMAC-SHA256(MEMBER_ID_KEY, str(user_id))[:16])` без `=` (25 символов), один ключ у
social, gamification и lessons. Обратного вычисления нет — реестр `member_ids` (строка появляется, когда social отдаёт
или узнаёт ученика: профиль, семья, друзья, заявки, связь, `user.profile.created.v1`; миграция 0002 заполнила его для
известных учеников). Удалённый ученик в реестре не находится.

**Аудитории.** Детский профиль (`lrn ≠ sub`) или 6–13 — без друзей, заявок, поиска (403 `FRIENDS_NOT_ALLOWED
{reason: kids}`), жалоб, блокировок и рефералов (403 `KIDS_NOT_ALLOWED`); ник и скрытие — можно (видны только семье).
14–17 — после согласия родителя (`guardian_consent`), друзья — ещё и с целью согласия `social` (403 `CONSENT_REQUIRED
{purpose}`). Возраст неизвестен или аккаунт не активен — как дети. Возраст, согласие и цели — identity-consent
`/users/{id}/public` (вне транзакций; недоступен — 503 `UPSTREAM_UNAVAILABLE {service: identity-consent}`); ученик без
доступа к друзьям в поиске и заявках неотличим от несуществующего (404 `MEMBER_NOT_FOUND`).

**Санкция `social_ban`** (активна, пока не снята и не истёк срок — по времени, не ждёт tick) запрещает отправлять и
принимать заявки, принимать приглашение kind friend/referral (403 `SOCIAL_RESTRICTED {until}`); gamification и lessons
узнают о ней из `social.sanction.changed.v1` и `relations`. **Блокировка** A→B — 403 `BLOCKED` в обе стороны, без
раскрытия, кто заблокировал.

## API ученика (`/internal/v1/me/…`)
| Метод и путь | Ответ и ошибки |
|---|---|
| `GET /community` | `CommunityProfile` (создаётся при первом обращении: ник null, код `TH-XXXX-XXXX`) |
| `PATCH /community {game_profile_hidden}` | `CommunityProfile`; изменение → `social.profile.updated.v1` |
| `PUT /community/nickname {nickname}` | 422 `NICKNAME_INVALID {reason: length\|chars\|forbidden}`; 409 `NICKNAME_TAKEN`; 429 `NICKNAME_COOLDOWN {until}`; тот же ник — 200 |
| `POST /community/friend-code:rotate` | новый код, прежний сразу не находится; 429 `FRIEND_CODE_LIMIT {until}` (3 за 24 ч) |
| `GET /friends/search?q=` | `{items: [MemberCard]}` — точный код (без регистра и дефисов) или ник (ключ уникальности); не находятся заблокированные, дети, без доступа, удалённые |
| `POST /friend-requests {member_id}` (Idempotency-Key) | 201 `FriendRequestView`; встречная pending = принятие (200, accepted); 409 `ALREADY_FRIENDS`/`REQUEST_EXISTS`/`FRIENDS_LIMIT {limit}`; 429 `REQUESTS_LIMIT {limit}`; 403 `BLOCKED`/`SOCIAL_RESTRICTED`/`FRIENDS_NOT_ALLOWED`/`CONSENT_REQUIRED`; 404 `MEMBER_NOT_FOUND`; себе — 422; повтор ключа — 200 тот же ответ |
| `GET /friend-requests?direction=in\|out&cursor&limit` | `Page<FriendRequestView>` — действующие pending, новые сверху |
| `POST /friend-requests/{id}/accept\|decline\|cancel` | `FriendRequestView`; повтор с тем же исходом — 200, иначе 409 `REQUEST_STATE {status}`; чужая/не та сторона — 404 `REQUEST_NOT_FOUND` |
| `GET /friends?cursor&limit` | `Page<FriendView>` по нику (без ника — в конце) |
| `DELETE /friends/{member_id}` | 204 (повтор — 204); `social.friendship.changed.v1 removed` |
| `POST /blocks {member_id}`, `GET /blocks`, `DELETE /blocks/{member_id}` | 201/200 `BlockView`, `BlocksResponse`, 204 |
| `POST /complaints` (Idempotency-Key) | 201 `ComplaintResult`; та же цель (цель + вид + предмет) за 24 ч — 200 тот же `case_id`; 429 `COMPLAINTS_LIMIT` (10/сутки); `subject_id` обязателен для friend_request/invite/duel/pair_room, иначе null (422) |
| `GET /sanctions`, `POST /sanctions/{id}/appeal {text}` (Idempotency-Key) | `SanctionsResponse`; 201 `SanctionView`; 409 `APPEAL_EXISTS`/`SANCTION_STATE`; 404 `SANCTION_NOT_FOUND` |
| `GET /referrals?cursor&limit` | `ReferralsResponse` (условия активной кампании, квалификации месяца) |
| `GET /family` (спринт 1) | у каждого члена семьи + `member_id` |

## Выгрузки (только gamification и lessons, INTERNAL_API §1.6)
`GET /internal/v1/export/families|friendships?cursor=&limit=` (`limit` ≤ 1000, по умолчанию 500) → `{items, next_cursor}`;
элемент — payload `social.family.member_added.v1` (все текущие члены семей, включая владельца) или
`social.friendship.changed.v1` (`status added`, все действующие дружбы). Удалённые не выгружаются.

## Связь учеников (только gamification и lessons)
- `GET /internal/v1/relations/{user_a}/{user_b}` → `{friends, same_family, blocked_any, a_restricted, b_restricted,
  a_audience, b_audience}` + `a_restricted_until`, `b_restricted_until`, `a_social_allowed`, `b_social_allowed`
  (друзья доступны: 14–17 с согласием родителя, цель social), `a_member_id`, `b_member_id`. Ученик удалён или
  неизвестен identity-consent — 404 `MEMBER_NOT_FOUND`; identity-consent недоступен — 503.
- `GET /internal/v1/members/{member_id}` → `{user_id}`; 404 `MEMBER_NOT_FOUND`.

## Админ-API (`/internal/v1/admin/…`, только admin-bff с actor)
Step-up — заголовок `X-Step-Up: ok` (или claim `step_up: true`), иначе 403 `STEP_UP_REQUIRED`. Каждая команда — аудит
`admin.audit.recorded.v1` (`social.case.resolved`, `social.sanction.revoked`, `social.appeal.decided`,
`referral.campaign.*`, `referral.approved|rejected`), без текстов учеников.

| Путь | Право |
|---|---|
| `GET /social/users/{user_id}` → `AdminSocialCard` (удалённый — 404 `SOCIAL_PROFILE_NOT_FOUND`) | social.read |
| `GET /social/stats?period=today\|7d\|30d` → `SocialStats` (`duels_finished`, `pair_rooms_finished` — null, их добавляет admin-bff) | dashboard.read \| social.read |
| `GET /moderation/cases?status&cursor`, `GET /moderation/cases/{id}`, `POST …/{id}/resolve {action, days, basis}` | moderation.manage (social_ban > 7 дней и бессрочный — step-up) |
| `GET /moderation/sanctions?user_id&active&cursor`, `POST …/{id}/revoke {reason}` | moderation.manage |
| `GET /moderation/appeals?status&cursor`, `POST …/{id}/decide {decision, note}` | moderation.manage |
| `GET /referrals/campaigns`, `GET …/stats`, `GET …/{version}` | referral.read |
| `PUT /referrals/campaigns/draft` (If-Match), `DELETE …/draft`, `POST …/draft/validate`, `POST …/draft/activate {comment}` | referral.manage (активация — step-up) |
| `GET /referrals?status&cursor`, `GET /referrals/{id}` | referral.read |
| `POST /referrals/{id}/approve {note}`, `POST /referrals/{id}/reject {reject_code, note}` | referral.manage |

## Правила
- **Ник:** 3–20, буквы RU/UZ/EN (кириллица + ЎҚҒҲ, латиница + ʻ ʼ), цифры, `_`; ввод — NFC, пробелы по краям
  убираются. Ключ уникальности `nickname_lc`: регистр, ё=е, кириллические двойники латиницы (А/A, В/B, Н/H, Р/P, С/C…
  и строчные г/r, и/u, п/n, ш/w, ь/b). Запрещённые слова — корни RU/UZ/EN в коде (мат, оскорбления, «admin», «tilhero»,
  «support»…) после нормализации и цифр-подстановок (0→o, 1→i, 3→e, 4→a…). Смена — раз в 7 дней; первый ник и ник после
  сброса модератором — через 7 дней от сброса; сброшенный ник (ключ) — в глобальном стоп-листе `nickname_stoplist`:
  его не задаст никто, включая самого ученика (ревью, п. 5). Снятие санкции (отмена, обжалование) убирает ник со
  стоп-листа и снимает ограничение смены.
- **Заявки:** один pending на пару (частичный UNIQUE), встречная = принятие; ≤ 20 в сутки, ≤ 200 друзей у каждой
  стороны; истекает через 30 дней (в ответах — сразу, строку переводит tick). Дружба через приглашение kind
  friend/referral (спринт 1) — с теми же запретами (блокировка, санкция, предел) и событием `source invite`.
- **Модерация:** дело — без переписки (ник цели на момент жалобы, предмет, комментарий жалобщика, счётчик жалоб на
  цель за 30 дней). Решение фиксирует основание, исполнителя и срок; nickname_reset сбрасывает ник. Обжалование —
  одно на санкцию; overturned снимает санкцию.
- **Рефералы** (`referral_integrity_reviewer` — правила): строка — при принятии приглашения kind referral (в той же
  транзакции). Диагностика (`diagnostics.completed.v1`, первая; до принятия — тоже), зачётные уроки
  (`lesson.session.completed.v1`: `kind lesson`, `status completed`, `practice_only false`; одна запись на session_id,
  урок — по lesson_id: повтор урока не считается), окно [принятие, + window_days], день — `local_date` события или день
  Ташкента. Семья пригласившего → `rejected family_member`. Условия выполнены → риски (`velocity`, `short_lessons`,
  `activity_before_accept`) → `review` + `social.referral.held.v1`, иначе qualified → лимит месяца (Ташкент, по времени
  квалификации) → `capped` или `social.referral.qualified.v1` → ack `game.referral.rewarded.v1` (gamification) →
  `rewarded`. Окно истекло — tick → `expired`. «Не новый ученик» — зарегистрирован раньше чем за
  `REFERRAL_NEW_USER_HOURS` (48) до первого открытия приглашения → `rejected not_new_user`; регистрация —
  `learner_activity.first_seen_at` из `user.profile.created.v1` (`created_at`), для учеников до спринта 7 — самый
  ранний след в social (миграция; не позже настоящей регистрации). Нет данных — не отклоняется. Оператор: review →
  одобрить/отклонить; отклонённое оператором → одобрить (пересмотр — один раз, история решений сохраняется);
  автоматические отказы правил (семья, не новый) не пересматриваются. Одобрение идёт через правила кампании
  (снимаются только риски): не проходит — 409 `REFERRAL_STATE {status, outcome}`.
- **Перенесённые из спринта 6** (`legacy`, INTERNAL_API §1.7): диагностика засчитана, окно — от выкладки,
  истечение — без уведомления и без причины ученику (`reject_code null`, `legacy true`), `not_new_user` и `activity_before_accept` не применяются; ack gamification закрывает
  их как `rewarded` из любого незавершённого статуса.
- **Жалоба:** предмет связан с жалобщиком и целью — заявка между ними; приглашение Telegram цели, открытое
  жалобщиком (или наоборот); иначе 422. Дуэль, комната и приглашение в парный урок — id других доменов, принимаются
  как есть.
- **Кампании:** версии draft → validate → activate (step-up, комментарий ≥ 10); одна draft и одна active; версия 1 —
  миграцией; номера монотонны (счётчик `counters`: удалённый черновик номер не освобождает); реферал остаётся на
  версии, по которой принят.
- **Реестр member_id:** новые строки — под advisory-блокировкой учеников с проверкой «удалён?» (после саги не
  воскресает); уже зарегистрированные — без блокировок (списки друзей и блокировок не конкурируют с командами).
- **Конкурентность:** команды — под advisory-блокировкой учеников (порядок uuid); «удалён?» — после блокировки (сага
  держит ту же); рефералы — блокировка приглашённого и пригласившего (лимит месяца и скорость) + FOR UPDATE.

## invites:tick (спринт 7)
Ответ `+ {friend_requests_expired, referrals_expired, sanctions_expired}`: заявки старше 30 дней → expired; рефералы с
истёкшим окном → expired (`social.referral.rejected.v1 window_expired`; обезличенные сагой не трогаются); social_ban с
прошедшим сроком → `social.sanction.changed.v1 {change: expired, active: false}` (один раз); ключи идемпотентности
команд ученика старше `IDEMPOTENCY_DAYS` удаляются.

## События (спринт 7)
Публикует: `social.profile.updated.v1`, `social.friend_request.created.v1`, `social.friendship.changed.v1` (source
request | invite | removed | block | deletion), `social.block.changed.v1`, `social.sanction.changed.v1` (applied |
expired | revoked | overturned), `social.case.resolved.v1`, `social.appeal.decided.v1`, `social.referral.qualified.v1`,
`social.referral.rejected.v1`, `social.referral.held.v1`, `admin.audit.recorded.v1`.

Потребляет (проверка издателя): `diagnostics.completed.v1` (diagnostics, `social.diagnostics`),
`lesson.session.completed.v1` (lessons, `social.lessons`), `game.referral.rewarded.v1` (gamification,
`social.referral_rewards`); `user.profile.created.v1` дополнительно регистрирует member_id.

## Данные (миграция 0002)
`member_ids`, `community_profiles`, `friend_requests`, `blocks`, `cases`, `sanctions`, `appeals` (FK → sanctions
CASCADE), `referral_campaigns` (версия 1 — active), `referrals` (принятые реферальные приглашения последних 30 дней
перенесены со статусом `invited` и `legacy`; `opened_at`, `window_from`), `referral_lessons`, `learner_activity`
(регистрация, первый урок, диагностика), `learner_idempotency`, `nickname_stoplist`, `counters`. `downgrade`
симметричен (данные спринта 1 не меняются).

**Сага (спринт 7):** профиль сообщества, member_id, заявки, дружбы (событие `removed`, source deletion), блокировки,
санкции и обжалования, проекция активности, ключи идемпотентности — удаляются; стоп-лист ников — без ученика (ключ
остаётся); дела — обезличиваются (жалобщик и цель →
null, комментарий удалённого жалобщика и ник удалённой цели — тоже; решение и основание остаются); рефералы —
обезличиваются (invitee/inviter → null, статус сохраняется, уроки приглашённого удаляются).

## Настройки (спринт 7)
`MEMBER_ID_KEY` (обязателен в stage/prod, ≥ 32 и не равен dev-константе; тот же у gamification и lessons; dev/test
без него — общая константа `dev-member-id-key-change-me-0000000000`), `FRIENDS_MAX` (200), `FRIEND_REQUESTS_PER_DAY` (20),
`FRIEND_REQUEST_TTL_DAYS` (30), `NICKNAME_COOLDOWN_DAYS` (7), `FRIEND_CODE_ROTATIONS_PER_DAY` (3), `COMPLAINTS_PER_DAY`
(10), `SOCIAL_TIMEZONE` (Asia/Tashkent), `IDEMPOTENCY_DAYS` (7), `REFERRAL_NEW_USER_HOURS` (48).

## Runbook (спринт 7)
- member_id у social и gamification/lessons не совпадают — разные `MEMBER_ID_KEY` (должен быть один).
- `relations` и друзья отвечают 503 — недоступен identity-consent (`/users/{id}/public`).
- Реферал «завис» в `qualified` — нет ack от gamification (`game.referral.rewarded.v1`): проверить её consumer.
- Очередь `review` растёт — пороги кампании (`review.velocity_per_day`, `min_lesson_minutes`) слишком строгие: новая
  версия кампании; решения по очереди — `POST /referrals/{id}/approve|reject`.
