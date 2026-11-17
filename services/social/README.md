# social-service

**Владелец:** команда Telegram-контура. **Bounded context:** приглашения (семья, друг, реферал) по deep link, семья,
дружба через приглашение (INTERNAL_API §3, AT-09, AT-10). Друзья с поиском, лиги и дуэли — спринт 7.

Порт 8109, схема PostgreSQL `social`, внутренний JWT с `aud = social`. Redis не нужен. Пакет `tilhero_social`.

## API
Вызывает только `telegram-bff`; `sub` — **аккаунт** (не детский профиль). Формы ответов = `bff.ts`
(`Invite`, `InvitePreview`, `InviteAcceptResult`, `Family`). Чужое приглашение неотличимо от несуществующего (404).

| Метод | Путь | Тело → ответ |
|---|---|---|
| POST | `/internal/v1/me/invites` | `{kind: family\|friend\|referral}` + `Idempotency-Key` → 201 `Invite`; 403 `ADULT_REQUIRED` / `INVITES_NOT_ALLOWED`; 409 `INVITES_LIMIT {limit, window: active\|24h}`; `social.invite.created.v1` |
| GET | `/internal/v1/me/invites?limit=&cursor=` | → `Page<Invite>` (новые первыми; `limit` 1…100, по умолчанию 20; битый курсор — 400 `INVALID_CURSOR`) |
| DELETE | `/internal/v1/me/invites/{invite_id}` | → `Invite` (`revoked`); чужое/нет — 404 `INVITE_NOT_FOUND`; повтор — без изменений |
| POST | `/internal/v1/invites:open` | `{token}` → `InvitePreview`; первый раз — строка ответа + `social.invite.opened.v1`; своё — `can_accept=false, reason=self` без записи; неизвестный/битый токен — 404 |
| GET | `/internal/v1/invites/{invite_id}/preview` | → `InvitePreview` только тому, кто уже открывал; иначе 404 |
| POST | `/internal/v1/invites/{invite_id}/accept` | → `InviteAcceptResult`; только после `:open` (иначе 404); 409 `INVITE_SELF`, `INVITE_ALREADY_USED`, `INVITE_EXPIRED`, `INVITE_REVOKED`, `FAMILY_ALREADY_MEMBER`, `FAMILY_FULL`, `ALREADY_FRIENDS`; 403 `INVITES_NOT_ALLOWED`; повтор тем же получателем — 200 тот же результат |
| POST | `/internal/v1/invites/{invite_id}/decline` | → `InvitePreview`; `social.invite.declined.v1` (только по активному); повтор и отклонение после принятия — без изменений; 409 `INVITE_SELF` |
| GET | `/internal/v1/me/family` | → `Family` или 404 `FAMILY_NOT_FOUND` |
| POST | `/internal/v1/invites:tick` | n8n, `Authorization: Bearer <SCHEDULER_TOKEN>` → `{reminders, expired}` |

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
- Причина в карточке (`reason`, порядок): `self` → `revoked` → `expired` → уже принял сам (`already_member` /
  `already_friends`) → `already_used` → `not_allowed` → для family `already_member` / `not_allowed` (семья полна),
  для friend/referral `already_friends` / `already_used` (реферал уже был).
- Конкурентность: принятие сериализуется advisory-блокировкой пригласившего и получателя (в порядке uuid) и
  FOR UPDATE приглашения — одноразовую ссылку принимает ровно один (проверено параллельным тестом).

### identity-consent
`GET /internal/v1/users/{id}/public` (ServiceClient, `sub` не передаётся) → имя пригласившего и участников семьи,
`kind`, `age_band`, `status`. 404 — пользователь удалён (в семье не показывается); прочие ошибки — 503
`UPSTREAM_UNAVAILABLE {service: identity-consent}` (коды identity-consent наружу не пробрасываются). Согласия родителя
в `/public` нет — берётся из проекции `profiles` (`user.profile.updated.v1`); если `/public` начнёт его отдавать,
ответ главнее. Имена не хранятся и не логируются.

## invites:tick (n8n `invites-tick`, каждый час)
Вход как у всех расписаний: Bearer `SCHEDULER_TOKEN` (пустой — вход выключен, 401), внутренний JWT → 403
`CALLER_NOT_ALLOWED`.
1. `active` с `expires_at ≤ now` → `expired` (счётчик `expired`).
2. Ответы, открытые ≥ `INVITE_REMINDER_AFTER_HOURS` (24) и не раньше `INVITE_REMINDER_MAX_AGE_DAYS` (7) назад, без
   принятия/отклонения/напоминания, по активному приглашению → `reminded_at` + `social.invite.reminder_due.v1` (одно на
   получателя приглашения). FOR UPDATE SKIP LOCKED — параллельные запуски не дублируют.

## События
Публикует: `social.invite.created|opened|accepted|declined|reminder_due.v1`, `social.family.member_added.v1`,
`user.domain.deleted.v1` (`domain = social`, `mode = deleted`).

Потребляет: `user.deletion.requested.v1` (`social.user_deletion`); `user.profile.created.v1`,
`user.profile.updated.v1` (`social.profiles`, только от `identity-consent`).

## Данные
Схема `social`: `invites`, `invite_redemptions` (FK → invites ON DELETE CASCADE), `families` (`owner_user_id UNIQUE`),
`family_members` (`user_id UNIQUE`, FK → families CASCADE), `friendships` (`user_a < user_b`), `profiles` (проекция:
kind, age_band, guardian_consent, guardian_user_id — без имени и даты рождения), `deleted_users` (отметка исполненного
удаления), `outbox`/`inbox`. Миграция 0001.

Сага удаления: приглашения пользователя (каскадом — ответы на них), его ответы на чужие приглашения, дружбы,
членство в семье, проекция → ACK. Владелец семьи уходит — семья переходит к самому раннему взрослому участнику; нет
взрослых — семья распускается. Повтор саги снова подтверждается; запоздавшие события профиля удалённого не
воскрешают проекцию.

## Настройки
`DATABASE_URL`, `MIGRATION_DATABASE_URL`, `DB_SCHEMA=social`, `NATS_URL`, `SCHEDULER_TOKEN`, `INVITE_TOKEN_KEY`
(обязателен в stage/prod, ≥ 32 символов), `TELEGRAM_APP_LINK` (https, без query), `IDENTITY_CONSENT_URL`,
`INVITE_FAMILY_TTL_DAYS` (7), `INVITE_FRIEND_TTL_DAYS` (30), `MAX_ACTIVE_INVITES` (10), `MAX_INVITES_PER_DAY` (20),
`FAMILY_MAX_MEMBERS` (10), `INVITE_REMINDER_AFTER_HOURS` (24), `INVITE_REMINDER_MAX_AGE_DAYS` (7), `TICK_BATCH_SIZE`.

## Runbook
- Ссылки не открываются (404 на все): проверить, не сменился ли `INVITE_TOKEN_KEY`.
- Карточки/семья отвечают 503: недоступен identity-consent (`/users/{id}/public`).
- Нет напоминаний о неотвеченных приглашениях: ответ n8n `invites-tick`, `reminded_at` в `invite_redemptions`.
