# notification-service

**Владелец:** Telegram-контур (support-notification из ТЗ Admin реализован здесь, отдельного деплоя нет).
**Bounded context:** политика уведомлений (критичное сразу, тихие часы, дедупликация), шаблоны RU/EN, журнал доставки,
доставка в Telegram через telegram-bot-gateway, ежедневный дайджест (спринт 6). ТЗ: TG-FR-007, TG-FR-032, TG-FR-033,
TG-FR-043, AT-27, AT-32, AT-33, A-AT-41.

## API
Входящего HTTP API для клиентов нет — `/health/live`, `/health/ready` (БД, Redis, NATS, потребители) и внутренние:

| Метод | Путь | Кто вызывает | Описание |
|---|---|---|---|
| POST | `/internal/v1/notifications/transactional` | **только** identity-consent | `{notification_id, user_id, template: "pin.reset_code", params: {code, ttl_minutes?}, dedup_key}` → `{notification_id, status: sent\|queued\|failed\|skipped, reason}`. Синхронная доставка секретных транзакционных сообщений мимо шины (ревью P2): запись в журнал и немедленная отправка; временная ошибка → `queued` с повтором планировщиком; конечный статус очищает `params`. Повтор с тем же `notification_id`/`dedup_key` не отправляет второй раз. Удалённый пользователь → `skipped user_deleted` без записи. 422 — шаблон не из списка `direct_only` или невалидные параметры |
| POST | `/internal/v1/notifications:digest` | **только** n8n (каждые 15 мин), `Authorization: Bearer <SCHEDULER_TOKEN>` | собрать дайджесты пользователей, у которых наступило `digest_time` → `200 {users, digests, items, postponed, errors}`. Идемпотентно: повтор в тот же локальный день — `digests: 0`. 401 `SCHEDULER_TOKEN_INVALID` (нет/неверный токен, пустой `SCHEDULER_TOKEN` выключает вход), 403 `CALLER_NOT_ALLOWED` (внутренний JWT сервиса) |

Исходящие вызовы (внутренний JWT, `iss=notifications`):
- `GET identity-consent /internal/v1/users/{id}/delivery` → `{telegram_user_id, locale, notifications_enabled, quiet_hours,
  digest_time, timezone, status}` (`DeliveryInfo`; `digest_time` — спринт 6) — кэш Redis 5 мин (`<prefix>:delivery:<user_id>`); 404 → `skipped user_not_found`.
- `POST telegram-bot-gateway /internal/v1/messages` — **внутренний порт** bot-gateway (`BOTGW_URL`, по умолчанию
  `http://127.0.0.1:8108`; Railway: `http://telegram-bot-gateway.railway.internal:8108`) с `idempotency_key = notification_id` (повтор после сбоя не задваивает
  сообщение). HTTP-клиент без собственных повторов — повторы делает планировщик.
- `POST telegram-bot-gateway /internal/v1/ops-messages` (спринт 8 §6) — оповещения операторам, см. «Оповещения операторам».

## События
Потребляет (durable consumer, inbox):
| Durable | События | Действие |
|---|---|---|
| `notifications.requests` | `notification.requested.v1` (watch, news) | `kind: critical` — в журнал и сразу; `kind: digest` — в `digest_queue` (только `watch.price_drop`, `news.digest`; иначе `failed digest_unsupported`). Шаблоны с секретом (`pin.reset_code`, `direct_only`) через шину не принимаются → `failed direct_only`; `digest.daily` собирает только сам сервис → `failed internal_only`; невалидный конверт → DLQ |
| `notifications.support` | `support.ticket.replied.v1`, `support.ticket.status.changed.v1` (→ RESOLVED) | `support.reply` / `support.resolved` (kind `standard`); текст ответа оператора в уведомление не кладётся |
| `notifications.user_deleted` | `user.deletion.requested.v1` | отметка `deleted_users`, удаляет журнал пользователя, его `digest_queue` и кэш адреса → `user.domain.deleted.v1 {domain: notifications, mode: deleted}`; запоздавшие запросы для удалённого → `skipped` без записи (advisory-блокировка пользователя сериализует приём и удаление, ревью P3) |
| `notifications.delivery_cache` | `user.status.changed.v1`, `consent.revoked.v1` | сбрасывает кэш адресации (отключение/отзыв действуют сразу, ревью #17) |
| `notifications.ops_alerts` | `ops.alert.raised.v1` (ops-monitor, спринт 8) | сообщение в чат операторов через bot-gateway; журнал `ops_deliveries` (см. ниже) |

Публикует: `notification.delivered.v1` (успех), `telegram.delivery.failed.v1 {reason: blocked|invalid_chat|rate_limited|error}`
(конечная неудача, в т.ч. неизвестный шаблон/невалидные параметры), `user.domain.deleted.v1`.

## Оповещения операторам (спринт 8, `docs/sprint8/INTERNAL_API.md` §6)
- Шаблоны `ops.alert.<kind>.<state>` (`ops_alerts.py`; kind `status|unstable|route_spike|dlq_growth|lag|outbox_stuck|
  feeds_problem`, state `open|resolved|reminder`) — только русский, обычный текст (bot-gateway шлёт без разметки).
  Текст — из `subject` (поставщик / консьюмер / сервис) и `params` (статусы, доля ошибок, p95, классы ошибок,
  коды мест, счётчики): без PII. Кнопка «Открыть мониторинг» → `ADMIN_WEB_URL/#/monitoring/<providers|queues>`
  (admin-web — hash-маршрутизация); без https `ADMIN_WEB_URL` — без кнопки. Тихих часов нет.
- `dedup_key` = `ops:<alert_id>:<state>:<state_seq>`, у напоминания ещё минута события `:<YYYYMMDDHHMM>` (ops-monitor
  шлёт напоминания с тем же `state_seq` — каждое доходит один раз, повтор того же события — нет); `ops_deliveries` хранит исход: `sent` / `skipped` / `failed`
  конечные (повтор события ничего не отправляет), `pending` — ждёт повтора.
- Ответы bot-gateway: 409 `OPS_CHAT_NOT_CONFIGURED` → `skipped` без повтора; 409 `OPS_CHAT_UNAVAILABLE` (бота
  исключили из группы) → `failed` + WARNING; 429 → повтор не раньше `retry_after` (`TransientError(retry_after=…)`,
  nak шины); 5xx/сеть → повтор с backoff шины; после `OPS_MAX_ATTEMPTS` (20, ≈ час) → `failed`; прочие 4xx и
  `TELEGRAM_ERROR permanent` → `failed` без повтора. Невалидный payload → DLQ.

## Политика
| kind | Когда отправлять |
|---|---|
| `critical`, `transactional` | сразу, в т.ч. в тихие часы (кроме выключенных уведомлений / неактивного пользователя) |
| `standard` (support.reply/resolved) | в тихие часы пользователя — отложить до их конца (`status=scheduled`, `scheduled_for`) |
| `digest` (`watch.price_drop`, `news.digest`) | копится в `digest_queue`; раз в локальный день в `digest_time` — одно сообщение `digest.daily`, которое как `standard` откладывается тихими часами |

### Дайджест (спринт 6, `docs/sprint6/INTERNAL_API.md` §5)
- Прогон (`:digest`, `digest.py`): пользователи с ждущими пунктами и `not_before ≤ now` (≤ `DIGEST_BATCH_USERS`).
  Для каждого — `digest_time` и `timezone` из identity-consent; если локальное время в окне
  `[digest_time, digest_time + DIGEST_WINDOW_MINUTES)` (120, окно может перейти через полночь) — сборка, иначе
  `not_before = min(следующее digest_time, now + DIGEST_RECHECK_MINUTES)` (смена настроек подхватывается за час).
  Пункты, пришедшие после дайджеста дня или вне окна, уходят в следующий день.
- Сборка: «Слежения» — снижения цены одного события сливаются (последняя цена, сумма снижений), по убыванию;
  «Новости» — новые сверху, без повторов (`news_id`/URL). Всего ≤ 10 пунктов (каждой секции не меньше 5, если
  другой хватает), остальное — «Ещё N — в приложении». Пусто — ничего не отправляется.
- Идемпотентность: `notification_id = uuid5("digest.daily:<user>:<локальная дата>")`, `dedup_key` UNIQUE; захват
  пунктов `FOR UPDATE` под advisory-блокировкой пользователя → повтор прогона и две реплики дают одно сообщение.
  Пункт с тем же `notification_id`/`dedup_key`, что уже есть в очереди или журнале, не добавляется.
- После сборки `params` пункта очищаются, строка хранится `DIGEST_RETENTION_DAYS` (7) как отметка дедупликации.
- Издателям: news публикует свой `news.digest` заранее (до `digest_time` пользователя) — опоздавший на прогон
  пакет новостей уйдёт на следующий день.

- Тихие часы `{start, end}` (HH:MM, окно может переходить через полночь) — в часовом поясе пользователя (`zoneinfo`,
  неизвестная зона → `DEFAULT_TIMEZONE`=Asia/Tashkent). Решение пересчитывается в момент отправки.
- Уведомления выключены или статус пользователя не `ACTIVE` → `skipped` (`notifications_disabled` / `user_inactive`),
  кроме `transactional` + `pin.reset_code` (код сброса PIN доставляется всегда).
- Дедупликация: `dedup_key` UNIQUE (повтор запроса/события → одна запись, одно сообщение); для ответов поддержки
  ключ `support.reply:<message_id>`, для решения — `support.resolved:<ticket_id>:<event_id>`.
- Повторы: 429 → через `retry_after`; 5xx/сеть/identity недоступен → backoff 30 с, 2 мин, 10 мин, 30 мин, 1 ч…;
  после `MAX_ATTEMPTS` (8) → `failed` + `telegram.delivery.failed.v1`. 409 `TELEGRAM_BLOCKED` → `failed blocked` сразу;
  постоянная ошибка Telegram (chat not found) → `failed invalid_chat`.
- После конечного статуса (`sent|failed|skipped`) `params` очищаются (CHECK в БД) — код сброса PIN не хранится.

## Шаблоны (RU/EN, HTML с экранированием каждого параметра)
`pin.reset_code {code: 6 цифр, ttl_minutes: 1–60 = 10}` (только синхронный HTTP), `support.reply {number}`, `support.resolved {number}` (кнопка «Открыть обращение»,
`startapp=ticket_<number>`). Шаблон без своих кнопок + `startapp` в запросе → кнопка «Открыть TilHero».

Спринт 6 — `params` в `notification.requested.v1` (строго: лишнее поле → `failed params_invalid`; `event_id` — UUID):
| Шаблон | kind | Издатель | params | Кнопки |
|---|---|---|---|---|
| `watch.critical` | `critical` | watch (§2.3, lifecycle критичный) | `{watch_id?, event_id, event_title, change: postponed\|cancelled\|sold_out\|low_inventory\|sales_open\|venue_changed}` | «Открыть событие» `event_<uuid>` |
| `watch.price_drop` | `digest` | watch (§2.3, price_drop) | `{watch_id?, event_id, event_title, tier: economy\|comfort\|premium, price_usd, drop_usd, drop_pct?, flight_delta_usd?, hotel_delta_usd?}` (деньги — строки) | `event_<uuid>`, «Все изменения» `watch` |
| `news.digest` | `digest` | news (§3.3, ≤ 10 новостей) | `{items: [{news_id?, title, source: {name, domain, url}, event_id?}] 1..10}` — источник обязателен (имя + https-URL); `domain` нормализуется (IDNA: кириллица → `xn--…`); показ — Unicode (`lenta.рф`), только если каждая метка целиком латиница или кириллица, иначе punycode (подмена похожими буквами); URL обязан быть на домене или поддомене; новость с невалидным доменом или чужим URL отбрасывается (остальные остаются, AT-33) | «Все новости» `news` |
| `digest.daily` | `digest` | только сам сервис | `{date, watch: [{event_id, event_title, tier, price_usd, drop_usd}], news: [как выше], more}`; 1..10 пунктов | одно событие без новостей — `event_<uuid>`; «Слежения» `watch`, «Все новости» `news` |

Deep link кнопок — то, что разбирает Mini App (`apps/telegram-miniapp/src/tg/deeplink.ts`): `event_<uuid>`, `watch`,
`news`, `ticket_<number>`. В дайджесте заголовки обрезаются до 120 символов; если текст длиннее 4000 (лимит Telegram
4096) — источник без ссылки, только имя.

## Данные
Схема `notifications`: `notifications` (`notification_id` PK, `user_id`, `kind`, `template`, `params` JSONB, `startapp`,
`dedup_key` UNIQUE, `status queued|scheduled|sent|failed|skipped`, `attempts`, `next_attempt_at`, `scheduled_for`,
`sent_at`, `telegram_message_id`, `failure_reason`, `source_event_id`, `created_at`, `updated_at`), `deleted_users`
(миграция 0002), `digest_queue` (миграция 0003: `item_id` = notification_id запроса, `user_id`, `section watch|news`,
`template`, `params`, `dedup_key` UNIQUE, `not_before`, `digest_id`, `created_at`, `consumed_at`; CHECK — после сборки
`params` пусты), `ops_deliveries` (миграция 0004, спринт 8: `delivery_id` PK, `dedup_key` UNIQUE, `alert_id`,
`template`, `status pending|sent|skipped|failed`, `attempts`, `last_error` — код, `telegram_message_id`,
`source_event_id`, `created_at`, `updated_at`, `sent_at`), `outbox`, `inbox`. Модели — зеркало миграций, сверка — `tests/test_notifications_schema.py`.
Telegram ID в БД не хранится (только в кэше Redis на 5 мин).

## Планировщик
`runtime.spawn` при старте: цикл `run_once` — захват пачки `queued|scheduled` с `next_attempt_at <= now`
(`FOR UPDATE SKIP LOCKED` + «аренда» `LEASE_SECONDS` — безопасно для нескольких реплик и падения процесса),
решение политики, отправка, конечный статус и событие в одной транзакции. Будится после коммита нового уведомления,
иначе опрос раз в `DISPATCH_INTERVAL_SECONDS`. Ошибки итерации не останавливают цикл (backoff, в журнал — только тип).

## Runbook

> Эксплуатация через браузер (Railway, админка, оповещения ops-monitor): [docs/runbooks/notifications.md](../../docs/runbooks/notifications.md). Ниже — технические детали для разработчика.
- Миграции: `alembic -c alembic.ini upgrade head` (Railway preDeploy) под `notifications_owner` (`MIGRATION_DATABASE_URL`);
  рантайм — роль `notifications` (`infra/db/bootstrap.sql`).
- Локально: `ENV=dev DATABASE_URL=postgresql://notifications:dev@127.0.0.1:5432/tilhero REDIS_URL=redis://127.0.0.1:6379/0
  NATS_URL=nats://127.0.0.1:4222 IDENTITY_CONSENT_URL=http://127.0.0.1:8101 BOTGW_URL=http://127.0.0.1:8108
  uv run uvicorn tilhero_notifications.main:app --port 8104`.
- Переменные дайджеста: `SCHEDULER_TOKEN` (общий с n8n; пусто — вход планировщика выключен), `DIGEST_DEFAULT_TIME`
  (09:00), `DIGEST_WINDOW_MINUTES` (120), `DIGEST_RECHECK_MINUTES` (60), `DIGEST_BATCH_USERS` (500),
  `DIGEST_CONCURRENCY` (5), `DIGEST_MAX_ITEMS` (10), `DIGEST_RETENTION_DAYS` (7).
- Оповещения операторам (спринт 8): `ADMIN_WEB_URL` (https, для кнопки), `OPS_MAX_ATTEMPTS` (20). Чат задаётся
  только в bot-gateway (`OPS_ALERT_CHAT_ID`); пока он пуст, оповещения пишутся как `skipped`.
- n8n: `POST {NOTIFICATIONS_URL}/internal/v1/notifications:digest` каждые 15 мин с `Authorization: Bearer $SCHEDULER_TOKEN`.
- Тесты: `uv run pytest services/notifications -q` (включая сквозной support → notifications → bot-gateway).
- Дайджест «не пришёл»: `SELECT section, not_before, digest_id FROM notifications.digest_queue WHERE user_id = …`
  (ждёт `not_before`), затем журнал `template = 'digest.daily'` (`scheduled` — тихие часы, `skipped` — выключены).
- Уведомление «не пришло»: `SELECT status, failure_reason, attempts, next_attempt_at FROM notifications.notifications
  WHERE user_id = …` — `skipped` (выключены/неактивен), `scheduled` (тихие часы), `queued` с `failure_reason`
  (повторы), `failed blocked` (бот заблокирован).
