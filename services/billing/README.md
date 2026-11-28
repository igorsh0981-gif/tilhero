# billing (8118, схема `billing`, пакет `tilhero_billing`)

**Спринт 8 — деньги и контроль ИИ.** Каталог тарифов и товаров с версиями (цены сайта в сумах и цены Mini App в
Telegram Stars — отдельными полями), заказы по каналам, платёжный контур с адаптерами Telegram Stars / Payme / Click /
Uzum, фискальные данные сайта, периоды подписки и подписки Stars, реестр минут с удержаниями, возвраты, корректировки
«четыре глаза», сверка, отчёты и курсы. Деньги — отдельный bounded context: gamification и lessons денег не знают.

Контракты: `docs/sprint8/INTERNAL_API.md` §0–§1, §10–§13; решения — `docs/sprint8/PLAN.md`; деньги — целые числа
(`docs/adr/0001-money-integer-minor-units.md`); события — `packages/contracts/events/billing.*.schema.json`.

Потоки: ядро — поток A (`domain/`, `api/{learner,internal,admin,scheduler,common}.py`, `consumers.py`, миграция);
фиатные адаптеры и `api/callbacks.py` — поток B; адаптер Stars и `api/stars.py` — поток G. Граница — протокол
`providers/base.py` (ProviderAdapter) и порт `domain/ports.py` (PaymentPort, реализация — `domain/payments.py`).

## Каналы и провайдеры (§0.2)
| Канал (`chn`) | Откуда | Провайдеры | Цены |
|---|---|---|---|
| `miniapp` | telegram-bff `/v1/*` | только `telegram_stars` | только Stars |
| `web` | telegram-bff `/web/v1/*` (сайт оплаты) | только `payme`, `click`, `uzum` | только сумы (тийины) |
| `renewal` | billing сам (продление подписки Stars) | `telegram_stars` | цена первого платежа |

Пара «канал — провайдер» проверяется в billing (иначе 422 `PROVIDER_NOT_ALLOWED`). Анти-стиринг: канал `miniapp` не
видит цен в сумах, фиатных провайдеров, заказов сайта, источника и цены периодов сайта — только статус подписки и
минуты. Колбэки фиатных провайдеров — только через `apps/payments-edge` с `X-Edge-Token`; Bot API — только через
внутренний API telegram-bot-gateway: **токена бота у billing нет**, Telegram ID в billing не попадает.

## API
**Ученик и сайт** (только `telegram-bff`; `sub` — аккаунт, `lrn` — профиль, `age_band`, `chn`; язык счёта —
`Accept-Language: ru | uz`):

| Метод и путь | Ответ |
|---|---|
| `GET /internal/v1/me/billing/catalog` | miniapp: `BillingCatalog` (только Stars, пробный); web: `WebCatalog` (только тийины, без пробного); детский профиль — `products: []`, `payer_required: true` |
| `GET /internal/v1/me/billing/subscription` | `SubscriptionView` / `WebSubscriptionView` (без `stars_subscription` и `trial_available`) |
| `GET /internal/v1/me/billing/minutes?cursor&limit` | история минут (новые сверху), `learner: self \| child \| null` |
| `POST /internal/v1/me/billing/trial` (Idempotency-Key) | 201 `SubscriptionView`; 409 `TRIAL_USED` / `TRIAL_NOT_AVAILABLE`; 403 `PAYER_REQUIRED` / `GUARDIAN_CONSENT_REQUIRED` |
| `POST /internal/v1/me/billing/orders` (Idempotency-Key) | 201 — создан, 200 — тот же (повтор ключа или незавершённый того же товара); Stars без ссылки на счёт — 503 `STARS_UNAVAILABLE {order_no}` (заказ pending) |
| `GET …/orders?cursor`, `GET …/orders/{order_no}`, `POST …/orders/{order_no}/cancel` | заказы своего канала (miniapp — miniapp и renewal); чужой / другого канала — 404 |
| `POST /internal/v1/me/billing/stars-subscription {auto_renew}` | `SubscriptionView`; 404 `STARS_SUBSCRIPTION_NOT_FOUND`; 503 `STARS_UNAVAILABLE` |

**lessons** (`iss=lessons`, `sub` = ученик = `user_id`, иначе 403 `USER_CONTEXT_MISMATCH`; заголовок
`Idempotency-Key` игнорируется — повтор по `(ref_kind, ref_id)`):
- `POST /internal/v1/holds {user_id, feature, ref_kind, ref_id, minutes_planned}` → `{allowed: true, hold_id,
  minutes_held, minutes_left, period_ends_at}` | `{allowed: false, reason: no_subscription | feature_not_in_plan |
  minutes_exhausted | kids}`;
- `GET /internal/v1/access/{user_id}?feature=ai_lessons|pair_lessons` → `{allowed, reason, minutes_left}`.

**telegram-bot-gateway** — `/internal/v1/stars/*` (поток G, `api/stars.py`). **Провайдеры** — `/provider/v1/*`
(поток B, `api/callbacks.py`, только с `X-Edge-Token`).

**Планировщик** (`Authorization: Bearer <SCHEDULER_TOKEN>`): `POST /internal/v1/billing:tick` (5 мин),
`POST /internal/v1/billing:reconcile` (сутки), `POST /internal/v1/projections/bootstrap?force=`.
n8n `billing-tick` и `billing-reconcile` в репозитории выключены (`"active": false`) — включает поток I.

**Админка** (`/internal/v1/admin/billing/*`, только admin-bff с actor; step-up — `X-Step-Up: ok`; аудит каждой
команды):

| Метод и путь | Право |
|---|---|
| `GET /catalog`, `GET /catalog/{version}` (с diff) | billing.read |
| `PUT /catalog/draft` (If-Match), `DELETE /catalog/draft`, `POST /catalog/draft/validate` | billing.manage |
| `POST /catalog/draft/activate {comment}`, `POST /catalog/{version}/rollback {comment}` | billing.publish + step-up |
| `GET /orders?status&channel&provider&product_kind&from&to&order_no&provider_txn_id&account_id&cursor`, `GET /orders/{order_id}` | billing.read |
| `POST /orders/{order_id}/refunds {reason, force?}` (Idempotency-Key), `POST /refunds/{id}/fail {note}` | billing.refund + step-up |
| `GET /refunds?status&cursor` | billing.read |
| `GET /accounts/{account_id}`, `GET /accounts/{account_id}/ledger?cursor` | billing.read |
| `POST /accounts/{account_id}/adjustments` (Idempotency-Key) | subscriptions.override + step-up |
| `GET /adjustments?status&account_id&cursor` | billing.read |
| `POST /adjustments/{id}/approve {note?}`, `POST /adjustments/{id}/reject {note}` | billing.approve + step-up; автор — 409 `SELF_APPROVAL` |
| `POST /adjustments/{id}/cancel` | только автор |
| `GET /reconciliation/items?status&kind&cursor` / `POST /reconciliation/runs`, `POST /reconciliation/items/{id}/resolve` | billing.read / billing.manage |
| `GET /reports/summary?period=day\|week\|month` (+ `recon_open`), `GET /reports/daily?from&to` (≤ 92 дней) | billing.read \| dashboard.read |
| `GET /fx`, `PUT /fx`, `GET /star-rate`, `PUT /star-rate` | billing.read / billing.manage (422 `FX_INVALID`) |
| `GET /providers` (включён ли, «задан / не задан» ключ, последний колбэк и ошибка) | billing.read |
| `POST /trials:grant-all {reason}` (только `TRIAL_ON_ENFORCEMENT=true`, иначе 409 `TRIAL_GRANT_DISABLED`) | billing.publish + step-up |

`StaffRef.name` — имя сотрудника из actor токена admin-bff (колонки `*_by_name`).

## События
**Публикует** (outbox): `billing.order.paid.v1`, `billing.order.refunded.v1`, `billing.subscription.changed.v1`,
`billing.access.changed.v1` (каждому ученику аккаунта; новому детскому профилю — по текущему тарифу),
`billing.stars_subscription.changed.v1`, `billing.subscription.expiring.v1`, `billing.minutes.low.v1`,
`billing.adjustment.applied.v1`, `billing.catalog.activated.v1`, `user.domain.deleted.v1 {domain: billing, mode:
anonymized}`, `admin.audit.recorded.v1`.

**Потребляет** (inbox, издатель проверяется): `user.profile.created.v1`, `user.profile.updated.v1`,
`user.deletion.requested.v1` (identity-consent); `lesson.session.completed.v1` (`billing_hold_id`,
`billable_minutes`; любой статус; без удержания — ничего), `lesson.pair.completed.v1` (`billing` может быть `null`)
(lessons); `game.til_pack.credited.v1` (paid → fulfilled; повтор — без изменений; `outcome user_deleted` — заказ
остаётся `paid`, пункт сверки `paid_after_deletion` → возврат сотрудником), `game.til_pack.reversed.v1`
(`tils_spent` → пункт `tils_spent_on_refund`) (gamification).

## Данные
Миграция 0001 — все таблицы INTERNAL_API §1.1 + `idempotency`, `deleted_users`, `tick_state`, `projection_loads`,
outbox/inbox; каталог v1 черновиком (`migrations/seed/catalog_v1.json`: цены сайта В2/В5, цены Stars пусты — О1,
реквизиты пусты — О4). Роли: миграции — `billing_owner`, сервис — `billing` (DML). Триггеры: `catalog_guard`,
`txn_guard` (Stars `[*] → performed`), `orders_guard`, `periods_guard`, `ledger_guard` (реестр только на добавление;
сага — `SET LOCAL tilhero.deletion = 'on'`). Блокировки — advisory аккаунта, затем заказа; «удалён?» — после них.

Удаление аккаунта (§1.16): реестр, удержания, остатки, периоды, заявки, проекция — удаляются; заказы, транзакции,
возвраты, подписки Stars, чеки — обезличиваются (В15). Живая подписка Stars отменяется через bot-gateway **до** этого.

## Запуск и настройки
`python -m tilhero_common.serve tilhero_billing.main:app`; миграции — `alembic upgrade head` под
`MIGRATION_DATABASE_URL` (роль `billing_owner`); сервис работает под `DATABASE_URL` (роль `billing`, только DML).

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PAYMENTS_ENABLED` | false (stage/prod), true (dev/test) | общий выключатель новых заказов и приёма платежей |
| `STARS_ENABLED`, `PAYME_ENABLED`, `CLICK_ENABLED`, `UZUM_ENABLED` | false | продажи провайдера; в stage/prod при `true` пустой ключ или реквизит — сервис не стартует |
| `TRIAL_ON_ENFORCEMENT` | false | разрешает разовую выдачу пробного всем активным 14+ |
| `IDENTITY_CONSENT_URL`, `GAMIFICATION_URL`, `BOTGW_URL` (:8108), `WEB_PAY_ORIGIN` | локальный стенд | соседи и адрес сайта оплаты (в stage/prod — явно; сайт — https) |
| `SCHEDULER_TOKEN` | пусто (вход выключен) | n8n `billing-tick`, `billing-reconcile`; в stage/prod ≥ 32 |
| `PAYMENTS_EDGE_TOKEN` | пусто | `X-Edge-Token` от payments-edge (генерирует `infra/railway/setup.py`); в stage/prod ≥ 32 |
| `STAND_CATALOG_ON_START` | true | только dev/test: тестовые цены Stars и активация каталога v1 при старте |
| `PROJECTION_BOOTSTRAP_ON_START`, `PROJECTION_PAGE_SIZE` | true, 500 | начальная загрузка проекции learners (identity-consent `export/profiles`) |
| `TICK_BATCH_SIZE`, `IDEMPOTENCY_DAYS`, `PROVIDER_CALLS_DAYS`, `PRE_CHECKOUTS_DAYS` | 500, 30, 90, 30 | tick: пачки и сроки хранения |
| `STALE_CLICK_MINUTES`, `STARS_RENEWAL_GRACE_MINUTES` | 60, 60 | сверка: Click Prepare без Complete; конец подписки Stars без продления |
| `PAYME_*`, `CLICK_*`, `UZUM_*` | — | ключи и реквизиты провайдеров (§13; потоки B) |

Ключи провайдеров вводит владелец в общие переменные проекта Railway (ссылка `${{shared.<ИМЯ>}}` — только у billing):
не в чат, не в репозиторий, не в БД, не в логи. В тестах — только заведомо тестовые строки.

## Runbook
**Возврат (общее).** Админка → «Заказы и платежи» → заказ → «Возврат» (`billing.refund` + TOTP, причина ≥ 10). Повторный
возврат по заказу невозможен (UNIQUE живого возврата). Подписка — период отзывается (`revoke`), пакет тилов —
`billing.order.refunded.v1` → gamification обратной записью (потрачены — пункт `tils_spent_on_refund`; без `force` —
409 `REFUND_NOT_ALLOWED tils_spent`).
- **Telegram Stars** — сразу через API: `refundStarPayment` (адаптер Stars → bot-gateway); подписка Stars ещё и
  отменяется (`editUserStarSubscription is_canceled`), статус `refunded`. Аккаунт удалён — 409 `STARS_PAYER_UNKNOWN`
  (возврат через API невозможен — решение с юристом).
- **Payme** — возврат `awaiting_provider` с инструкцией `{provider, provider_txn_id, amount_tiyin}`: сотрудник отменяет
  платёж в кабинете **Payme Business**, Payme присылает `CancelTransaction` (state 2, reason 5) → возврат `completed`
  автоматически. Чек возврата — `SetFiscalData` CANCEL (отдельная запись).
- **Click** — через Merchant API (отмена платежа) сразу: только платёж **текущего отчётного месяца** (1-го числа — и
  прошлого; иначе 409 `REFUND_NOT_ALLOWED provider_window`); UZCARD может отказать → возврат `failed`, повторить или
  вернуть иначе по согласованию.
- **Uzum** (после сверки спецификации) — `awaiting_provider`: возврат через Uzum (менеджер / кабинет), Uzum присылает
  `reverse` по проведённой транзакции → `completed`.
- Возврат висит дольше 3 суток — пункт `refund_stuck`; если провайдер отказал — «Закрыть как неудачный»
  (`POST /refunds/{id}/fail`), затем новая заявка.

**Зависшая транзакция** (`stale_created`): Payme — транзакция `created` старше 12 ч 15 мин (Payme сам отменит по
таймауту, reason 4; по нашему `CreateTransaction`/`Perform` — отмена timeout); Click — Prepare без Complete > 1 ч
(новые попытки по заказу допустимы, первая проведённая оплачивает, остальные — `order_closed`). Деньги не
списаны — пункт закрыть с заметкой; списаны у провайдера, а у нас нет — по выписке провайдера, затем корректировкой.

**Рассинхрон подписки Stars** (`stars_subscription_desync`, `stars_unmatched`): сравнить выписку `getStarTransactions`
(сверка) и `stars_subscriptions` (`expires_at`, `last_charge_id`). Продление без записи у нас — обновление придёт
повтором Telegram (bot-gateway ставит отметку `update_id` только после 2xx billing); лишний платёж — возврат
сотрудником. Отмена в саге не удалась — пункт `stars_subscription_desync`: отменить автопродление вручную (bot-gateway).

**Расхождение остатков** (`balance_drift`): суточная сверка пересчитывает `period_balances` по реестру (granted,
spent, removed) и активным удержаниям и создаёт пункт с прежними и новыми значениями. Реестр не правится — только
корректировкой «четыре глаза».

**Оплачено, но не выдано** (`paid_not_fulfilled`, `payer_mismatch`, `unmatched_settlement`, `duplicate_payment`,
`paid_after_deletion`): деньги получены, выдачи нет — возврат сотрудником (или выдача корректировкой «четыре глаза»,
если плательщик и получатель подтверждены). Второй платёж Stars по оплаченному заказу транзакцией не записывается
(один `performed` на заказ) — данные в пункте сверки; возврат такого платежа через API — спринт 9.

**Выключение продаж.** `PAYMENTS_ENABLED=false` — новых заказов нет (409 `PAYMENTS_DISABLED`), фиатные колбэки
отвечают «временно недоступно», Stars pre-checkout — отказ; уже одобренный платёж Stars принимается (деньги получены).
Точечно — флаг провайдера. Учёба не зависит: удержания и доступ работают по выданным периодам и без флагов.
