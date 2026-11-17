# notifications

**Владелец:** Telegram-контур. **Bounded context:** политика доставки (категории, общий выключатель, тихие часы,
правила детей 6–13, лимит дня, дедупликация), шаблоны RU/UZ, журнал доставки = **центр уведомлений в приложении**,
доставка в Telegram через telegram-bot-gateway. Спринт 1 TilHero: `docs/sprint1/INTERNAL_API.md` §4,
`docs/sprint1/PLAN.md` (правила напоминаний, AT-07, 08, 10, 12, 13, 15), `docs/CONVENTIONS.md` §8.

## API
`/health/live`, `/health/ready` (БД, Redis, NATS, потребители) и внутренние (внутренний JWT EdDSA):

| Метод | Путь | Кто вызывает | Описание |
|---|---|---|---|
| GET | `/internal/v1/me/inbox?limit=1..100 (20)&cursor=` | **только** telegram-bff, `sub` = ученик | `Page<InboxItem>` (bff.ts): новые первыми, 90 дней. Видны записи с отрисованным текстом, кроме `skipped`; код PIN не показывается. 400 `INVALID_CURSOR`, 422 `VALIDATION_ERROR` |
| GET | `/internal/v1/me/inbox/unread-count` | telegram-bff | `{unread}` |
| POST | `/internal/v1/me/inbox:read` | telegram-bff | `InboxReadRequest {ids?: ≤100 UUID, all?: true}` → `{unread}`; ни `ids`, ни `all` → 422. Идемпотентно (повтор не меняет `read_at`); чужие и неизвестные id игнорируются без раскрытия |
| POST | `/internal/v1/notifications/transactional` | **только** identity-consent | `{notification_id, user_id, template: "pin.reset_code", params: {code, ttl_minutes?}, dedup_key}` → `{notification_id, status: sent\|queued\|failed\|skipped, reason}`. Код мимо шины: запись в журнал (не в центре) и немедленная отправка, сразу и мимо настроек; временная ошибка → `queued` с повтором; бот заблокирован → `failed blocked`; удалённый → `skipped user_deleted` без записи; повтор с тем же `notification_id`/`dedup_key` второй раз не отправляет |
| POST | `/internal/v1/notifications:dispatch` | **только** n8n (5 мин), `Authorization: Bearer <SCHEDULER_TOKEN>` | обработка записей `scheduled` с `scheduled_for ≤ now` (до `DISPATCH_MAX_BATCHES_PER_CALL` пачек) + срок хранения → `{sent, scheduled, in_app_only, failed}`. Повтор безопасен. 401 `SCHEDULER_TOKEN_INVALID` (пустой токен выключает вход), 403 `CALLER_NOT_ALLOWED` (внутренний JWT) |

`user_id` центра — только из токена (IDOR). Ученик детского профиля видит свои записи; родитель (`sub` = аккаунт) — свои.

Исходящие (внутренний JWT, `iss=notifications`):
- `GET identity-consent /internal/v1/users/{id}/delivery` → `DeliveryInfo` (§1: для ребёнка адресат — опекун, его
  Telegram ID и блокировка бота) и `GET …/users/{id}/public` → имя пригласившего/принявшего/нового участника семьи.
  Кэш Redis 5 мин (`<prefix>:delivery:<id>`, `<prefix>:public:<id>`), сброс событиями (ниже); 404 → `skipped user_not_found` / текст без имени.
- `POST telegram-bot-gateway /internal/v1/messages` — **внутренний порт** (`BOTGW_URL`, по умолчанию
  `http://127.0.0.1:8108`; Railway: `http://telegram-bot-gateway.railway.internal:8108`), `idempotency_key = notification_id`.

## События
Потребляет (durable consumer, inbox-дедупликация):

| Durable | События | Действие |
|---|---|---|
| `notifications.learning` | `learning.reminder.due.v1` | `lesson.reminder` (ребёнку — `.kid`), `reminders`, ключ `reminder:<user>:<date>`; позже слота + 3 ч — только центр |
| | `learning.session.missed.v1` | `lesson.missed(.kid)`; `consecutive_missed ≥ 4` — `lesson.comeback(.kid)` не чаще раза в 7 дней (`missed_state`, иначе без записи); `missed`, ключ `missed:<user>:<date>`; отправка не раньше слот-времени следующего дня, после 22:00 следующего дня — только центр |
| `notifications.social` | `social.invite.accepted.v1` | `invite.accepted` → пригласившему (имя принявшего), `social`, ключ `invite.accepted:<invite>:<invitee>`; для `family` — `family.joined:<inviter>:<invitee>` (общий с `family.joined`, без двойного сообщения владельцу) |
| | `social.invite.declined.v1` | `invite.declined` → пригласившему, **только центр**, категория не проверяется («—» в §4), без имени |
| | `social.invite.reminder_due.v1` | `invite.pending` → получателю (имя пригласившего, кнопка `invite_<invite_id>`), ключ `invite.pending:<invite>:<invitee>` — одно |
| | `social.family.member_added.v1` | `role=owner` — проекция владельца семьи (`family_owners`); `child` — без сообщения (добавил сам родитель); `adult`/`teen` → `family.joined` владельцу, ключ `family.joined:<owner>:<member>`; владелец неизвестен → без сообщения (WARNING) |
| `notifications.support` | `support.ticket.replied.v1`, `support.ticket.status.changed.v1` (→ RESOLVED) | `support.reply` / `support.resolved` (`support` — всегда включена), кнопка `ticket_<number>`; текст ответа в уведомление не кладётся |
| `notifications.product` | `experience.release_note.published.v1` | сохраняется в `broadcasts`; запись центра (`release_note.published`, `product`, `in_app_only`) создаётся ученику при чтении центра — см. «Что нового» |
| `notifications.user_deleted` | `user.deletion.requested.v1` | `deleted_users` + удаление журнала/центра ученика, записей других учеников с его именем (`subject_user_id`), `missed_state`, `inbox_state`, проекции семьи, кэшей → `user.domain.deleted.v1 {domain: notifications, mode: deleted}`; запоздавшие события для удалённого — без записи |
| `notifications.delivery_cache` | `user.status.changed.v1`, `consent.revoked.v1`, `user.notification_settings.changed.v1`, `user.profile.updated.v1` | сброс кэша адресации и имени |

Публикует: `notification.delivered.v1` (отправлено), `telegram.delivery.failed.v1 {reason: blocked|invalid_chat|rate_limited|error}`
(конечная неудача, в т.ч. блокировка бота — запись при этом остаётся в центре), `user.domain.deleted.v1`.

## Политика (в момент отправки, порядок §4)
Приём только создаёт запись (`telegram_status=scheduled`, `scheduled_for=now`); обработчик журнала берёт свежий
`DeliveryInfo`, отрисовывает title/body на языке ученика (для центра) и решает (`domain/policy.py`):

0. статус не `ACTIVE` → `skipped user_inactive` (кроме кода PIN);
1. **категория** не включена (`support`/`service` — всегда; у `invite.declined` не проверяется) → `skipped category_disabled` — ни Telegram, ни центра;
   «только центр» (`invite.declined`, «Что нового») → `in_app_only center_only`; устарело (`stale_after`) → `in_app_only stale`;
2. **общий выключатель** `notifications_enabled=false` → `in_app_only`; нет адреса Telegram → `in_app_only no_recipient`;
   пропуск ждёт `not_before` (слот следующего дня);
3. **тихие часы** (часовой пояс ученика, окно через полночь) → отложить до конца (`scheduled`, `scheduled_for`);
4. **дети 6–13** (`kind=child` или `is_minor` и `age_band` 6-9/10-13) → окно 08:00–20:00 местного (иначе до 08:00),
   адресат — опекун (`recipient_telegram_user_id`), шаблон `*.kid` с именем ребёнка;
5. **лимит** ≤ 3 сообщений `reminders`+`missed`+`social` в местные сутки на **ученика** (под advisory-блокировкой
   ученика; засчитываются отправленные и зарезервированные) → сверх — `in_app_only daily_limit`;
6. **дедупликация** — `dedup_key` UNIQUE при приёме.

Отложенное на момент позже `stale_after` сразу уходит только в центр. Повторы: 429 → через `retry_after`;
5xx/сеть/identity недоступен → backoff 30 с, 2 мин, 10 мин, 30 мин, 1 ч; после `MAX_ATTEMPTS` (8) → `failed` + событие.
`TELEGRAM_BLOCKED` → `in_app_only blocked` (код PIN — `failed blocked`); chat not found → `failed invalid_chat`.
После конечного статуса `params` очищаются (CHECK в БД).

## Шаблоны RU/UZ (`templates.py`)
Узбекский — латиница (oʻ/gʻ — U+02BB, тутук — U+02BC). Текст Telegram — `<b>title</b>\nbody`, каждое значение
экранируется; кнопка «Открыть» — `startapp`.

| Шаблон | Категория | Кнопка `startapp` |
|---|---|---|
| `lesson.reminder`, `lesson.reminder.kid` | reminders | `route_home` |
| `lesson.missed`, `lesson.missed.kid`, `lesson.comeback`, `lesson.comeback.kid` | missed | `route_home` |
| `invite.accepted`, `invite.declined`, `family.joined` | social | `route_family` |
| `invite.pending` | social | `invite_<invite_id>` |
| `support.reply`, `support.resolved` | support | `ticket_<number>` |
| `release_note.published` | product | `route_news` |
| `pin.reset_code` (только синхронный HTTP, не в центре) | service | — |

Детские тексты — родителю, с именем ребёнка, мягкие: без «потери серии», «провала», давления (тест
`test_kid_texts_are_soft_and_name_the_child`). PII в текстах — только имя ребёнка родителю и имя
пригласившего/принявшего/нового участника семьи (identity-consent `/public`, без username и Telegram ID).

## «Что нового» в центре
`experience.release_note.published.v1` без адресатов: заметка хранится в `broadcasts`; при чтении центра
(`inbox`, `unread-count`, `inbox:read`) ученику создаются записи по заметкам, полученным после его водяного знака
(`inbox_state`): статус `ACTIVE`, категория `product` включена, `audience` `existing|all`, сегменты `age`
(kids/teens/adults) и `ui_lang`. Первое чтение центра ставит знак на «сейчас» (старое показывает «Что нового»).
Telegram-рассылки нет (кампании — спринт 2).

## Данные
Схема `notifications` (миграция 0001): `notifications` (`notification_id` PK, `user_id` — ученик, `category`,
`kind standard|transactional`, `template`, `params` JSONB, `subject_user_id`, `title`, `body`, `startapp`,
`dedup_key` UNIQUE, `telegram_status scheduled|sent|in_app_only|failed|skipped`, `reason`, `center_only`,
`not_before`, `stale_after`, `scheduled_for`, `attempts`, `limit_day`, `sent_at`, `telegram_message_id`, `read_at`,
`source_event_id`, `created_at`, `updated_at`; CHECK: `params` только у `scheduled`, у `scheduled` есть
`scheduled_for`), `deleted_users`, `missed_state (user_id, last_notified_date)`, `family_owners (family_id → owner)`,
`broadcasts`, `inbox_state`, `outbox`, `inbox`. Срок хранения журнала/центра — 90 дней (`RETENTION_DAYS`, чистка в
`:dispatch`). Telegram ID в БД не хранится (только кэш Redis 5 мин). Модели — зеркало миграций
(`tests/test_notifications_schema.py`).

## Обработчик журнала
`runtime.spawn` при старте (`DISPATCHER_ENABLED`): `run_once` — захват пачки `scheduled` с `scheduled_for ≤ now`
(`FOR UPDATE SKIP LOCKED` + аренда `LEASE_SECONDS` — безопасно для реплик, падения процесса и параллельного
`:dispatch`), отрисовка, политика, отправка, статус и событие. Будится после коммита новой записи, иначе опрос раз в
`DISPATCH_INTERVAL_SECONDS`. n8n `notifications-dispatch` — страховка (отложенные, повторы).

## Переменные окружения
`DATABASE_URL`, `MIGRATION_DATABASE_URL`, `REDIS_URL`, `NATS_URL`, `IDENTITY_CONSENT_URL`, `BOTGW_URL`,
`SCHEDULER_TOKEN`, `INTERNAL_JWT_PRIVATE_KEY` + `INTERNAL_JWT_PUBLIC_KEYS` (stage/prod), `DEFAULT_TIMEZONE`
(Asia/Tashkent), `DAILY_LIMIT` (3), `REMINDER_STALE_HOURS` (3), `MISSED_STALE_TIME` (22:00), `COMEBACK_MIN_DAYS` (7),
`KID_WINDOW_START`/`KID_WINDOW_END` (08:00/20:00), `RETENTION_DAYS` (90), `DELIVERY_CACHE_TTL_SECONDS` (300).

## Runbook
- Тесты: `infra/dev/stack.sh up`, `source .dev/testenv.sh`, `uv run pytest services/notifications -q`
  (identity-consent и bot-gateway — `httpx.MockTransport`; `test_notifications_e2e.py` — настоящее внутреннее
  приложение bot-gateway).
- Сообщение не пришло: строка журнала по `dedup_key` → `telegram_status`/`reason` (`category_disabled`,
  `notifications_disabled`, `quiet_hours`, `kid_window`, `daily_limit`, `stale`, `blocked`, `identity_unavailable` …).
- Застряли `scheduled` с прошедшим `scheduled_for`: проверить `notifications-dispatch` в n8n и логи
  `dispatcher iteration failed` (в журнал — только тип ошибки).
