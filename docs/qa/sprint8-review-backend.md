# Спринт 8 «Деньги и контроль ИИ» — независимое ревью бэкенда (деньги, безопасность, анти-стиринг)

Ветка `sprint/8-money`, рабочее дерево поверх коммитов потока 0 (`0a79563`), незакоммиченные изменения на 28.11.2026.
Область: billing (ядро, провайдеры `payme` / `click` / `uzum` / `telegram_stars`, API), telegram-bot-gateway (Stars,
webhook, команды), payments-edge (Caddyfile), изменения спринта 8 в lessons и gamification (удержания, списание минут,
`til_orders`), ai-gateway (деградация, тарифы, стоимость), notifications (шаблоны billing, анти-стиринг),
identity-consent (`telegram-users/{id}/account`, `accounts/{id}/telegram-user`, сага billing, выгрузка `profiles`),
admin-identity 0008, user-admin 0004, experience-config 0010/0011, фильтр логов py-common, `infra/railway`
(`setup.py`, `extend.py`). Вне области: telegram-bff (в т. ч. `src/web/**`), admin-bff, фронтенды.

Режим: полный разбор по чек-листу AGENT_BRIEF «Чек-лист ревью». Ничего не исправлялось. Три находки подтверждены
временным тестом (`services/billing/tests/stars/test_tmp_review_s8.py`) — файл удалён, `git status` от него чист.
Уровни уверенности: ✅ — видно в коде или подтверждено тестом; ⚠️ — зависит от поведения внешней системы, проверить.

**Вердикт: ОТКЛОНИТЬ — 1 🔴.** Платёж Telegram Stars, который нельзя выдать, в ряде случаев не записывается вовсе
(в одном — падение `AssertionError` и бесконечная повторная доставка), а записанный — нельзя вернуть: инструмента
возврата нет. Это прямое нарушение пункта чек-листа «несоответствия — пункт сверки, не потеря денег» и риска R4.
Исправление локальное (ядро billing + сага детского профиля). Остальное — 🟡 и 🟢. Фиатный контур (Payme, Click,
Uzum), реестр минут, удержания, «четыре глаза», подписи, секреты и анти-стиринг серверной части — без блокеров.

## Прогоны

| Набор | Результат |
|---|---|
| billing | 444 passed, 23 skipped (живой прогон `caddy` в `test_payments_edge.py` — нет бинаря `caddy` на стенде) |
| telegram-bot-gateway / lessons / gamification | 163 / 170 / 126 passed |
| ai-gateway / notifications / identity-consent | 513 / 619 / 420 passed |
| admin-identity / user-admin / experience-config / py-common | 114 / 78 / 194 / 218 passed (py-common — 1 skipped) |
| infra/railway + infra/n8n | 38 passed (в т. ч. «`BOT_TOKEN` только у bot-gateway и telegram-bff») |
| ruff (billing, bot-gateway, lessons, gamification, ai-gateway, notifications, identity-consent); mypy billing, bot-gateway | чисто |
| Временный тест (3 сценария Stars через настоящий `PaymentService` и миграцию 0001) | все три дефекта воспроизведены (п. 1, 2) |

## 🔴 Блокеры

| № | Находка | Где | Исполнитель |
|---|---|---|---|
| 1 | Stars: деньги получены, платёж не записан или не может быть возвращён; при удалённом детском профиле — `AssertionError` 500 и бесконечная повторная доставка | `billing/domain/payments.py:120, 401-406, 420-432, 458-461`, `domain/saga.py:119-127`, `domain/refunds.py:180-186`, `providers/telegram_stars.py:441-444`, `bot-gateway/stars.py:276-277` | A (ядро) + G (Stars) |

**🔴 1. Stars: «деньги получены — пункт сверки» не выполняется: часть платежей не записывается, записанные нельзя
вернуть, у подписки с несоответствием продления списываются дальше.** ✅ (временный тест)

Деньги за Stars уже у бота в момент `successful_payment`; по §1.5 несоответствие не отвергается, а записывается
транзакцией и пунктом сверки → «возврат сотрудником». Фактически:

- **1а. Детский профиль удалён при открытом заказе тилов → падение.** Сага детского профиля (`saga._child`,
  `saga.py:119-127`) только обнуляет `beneficiary_id` у заказов и **не отменяет** `pending`-заказы с получателем-ребёнком.
  `_first_payment` проверяет удаление только плательщика (`payments.py:409`), затем `deliver` падает на
  `assert order.account_id is not None and order.beneficiary_id is not None` (`payments.py:120`). Временный тест:
  заказ `til_100` ребёнку → сага ребёнка → `POST /internal/v1/stars/payments` → **500 `AssertionError`**,
  `provider_transactions` — 0 строк, пункта сверки нет. bot-gateway на не-2xx отвечает Telegram 503
  (`webhook.py:149-153`), Telegram повторяет обновление «разумное число раз» и бросает его: платёж не записан нигде,
  кроме суточной сверки выписки (`stars_unmatched`). Payme и Click в том же состоянии отвечают -32400 / -7 — провайдер
  повторит и отменит попытку по своим правилам; у Stars деньги уже у бота.
- **1б. Второй платёж и «чужие» платежи не записываются, вернуть их нечем.** Второй успешный платёж по уже оплаченному
  заказу (`payments.py:401-406`), продление без подписки (`:458-461`) и платёж по неизвестному заказу (`:370-373`) —
  только пункт сверки, **транзакция не создаётся** (`uq_txn_order_performed` не даёт второй `performed`). Возврат
  сотрудником (`POST …/orders/{id}/refunds`) требует заказ `paid|fulfilled` и проведённую транзакцию этого заказа
  (`refunds.py:180-186`) — для таких платежей и для записанного платежа по отменённому заказу (`unmatched_settlement`,
  `payments.py:414-419` → `REFUND_NOT_ALLOWED not_paid`) инструмента возврата нет; разбор пункта — только «resolved /
  ignored» с заметкой. Если Telegram сам вернёт такой платёж (`refunded_payment`), billing отвечает 409
  `STARS_TXN_NOT_FOUND` (`telegram_stars.py:441-444`), bot-gateway считает 4xx «не доставлено» (`stars.py:276-277`) →
  503 → повторы до отказа Telegram. Временный тест: `refunds-received` по незаписанному charge → 409.
- **1в. Подписка с несоответствием продлевается и списывает деньги каждый месяц.** Первый платёж подписки с
  `payer_mismatch` / `unmatched_settlement` / `duplicate_payment` (`payments.py:420-432`) переводит заказ в `paid`, но
  строку `stars_subscriptions` не создаёт. Подписка в Telegram при этом живая: каждое продление → `SubscriptionNotFound`
  → пункт `unmatched_settlement`, транзакции нет (временный тест: после продления `provider_transactions` = 1).
  Возврат первого платежа подписку в Telegram не отменяет: `stars_subscription_of` → `None` → `sub_charge = None`
  (`refunds.py:271-273`), `editUserStarSubscription` не вызывается; отключить автопродление из Mini App тоже нельзя
  (404 `STARS_SUBSCRIPTION_NOT_FOUND`).

Нарушено: чек-лист AGENT_BRIEF («`successful_payment`: … несоответствия — пункт сверки, не потеря денег»), §1.5
(«транзакция записывается, заказ не выдаётся, пункт сверки → возврат сотрудником»), R4.

Предложение:
1. `deliver` и `_first_payment`: получатель `NULL` или удалён — транзакция записывается, заказ `paid` без выдачи, пункт
   `paid_after_deletion`, без `assert`. Сага детского профиля — как у аккаунта: `pending`-заказы с получателем-ребёнком →
   `cancelled`, их `created`-транзакции → `cancelled (order_closed)`.
2. Каждый полученный charge Stars — строка транзакции. Например, частичный индекс `uq_txn_order_performed … WHERE
   state = 'performed' AND provider <> 'telegram_stars'` плюс правило «выдача — только по первой проведённой» или
   отдельная таблица неразобранных платежей; возврат сотрудником — по транзакции (`POST
   …/transactions/{txn_id}/refunds`, `billing.refund` + step-up) для `duplicate_payment`, `unmatched_settlement`,
   `payer_mismatch`.
3. Первый платёж подписки с несоответствием: строка `stars_subscriptions` (`first_charge_id`, статус `canceled`) и сразу
   `editUserStarSubscription is_canceled=true` вне транзакции; сбой — пункт `stars_subscription_desync`.
4. `refunded_payment` по неизвестному charge: пункт сверки и 200 (или 409 только первые N минут), чтобы обновление не
   стало «ядовитым».
5. Тесты: каждая ветка `_first_payment` и `_renewal` с несоответствием → транзакция записана, возврат сотрудником
   проходит, продление после несоответствия не теряется.

## 🟡 Важно

| № | Находка | Исполнитель |
|---|---|---|
| 2 | Вторая подписка по ссылке первого заказа: pre-checkout отвечает `ok`, её продления засчитываются продлениями первой | A + G |
| 3 | Возврат подписки Stars: сбой отмены автопродления только в лог; продление «оживляет» возвращённую подписку | A |
| 4 | Сага: сбой отмены подписки Stars → ACK → Telegram ID стёрт → списания удалённому ученику каждый месяц | A (+ D identity-consent) |
| 5 | `BILLING_ENFORCED=false` не равно спринту 7: `paid_only` с 90 % выключает ИИ всем (подписчиков нет), `economy` с 80 % | D (ai-gateway) |
| 6 | Payme при выключенной оплате отвечает -32504 и на Perform/Cancel/Check уже созданных транзакций | B |
| 7 | n8n `billing-tick` и `billing-reconcile` выключены (`"active": false`) — нет tick, сверки и повтора начальной загрузки | I |

**🟡 2. Вторая подписка Stars по ссылке первого заказа.** ✅ код и временный тест / ⚠️ поведение Telegram.
- Где: `payments.py:275-283` (pre-checkout по payload заказа с живой подпиской — `ok` без проверки статуса заказа, решение
  §14 S2), `:401-406`, `_renewal` `:456-509`.
- Сценарий: подписка оформлена и оплачена; ученик повторно открывает ту же `invoice_link` (вторая вкладка, повторный
  `openInvoice` до обновления статуса). Временный тест: pre-checkout → `{ok: true}`; второй «первый» платёж → 200
  `duplicate_payment`, транзакции нет (п. 1б); продление **второй** подписки (тот же payload) → заказ `renewal`, новый
  период, `last_charge_id` первой подписки перезаписан. Итог — двойное списание каждый месяц, пункт сверки только один
  раз. Пустит ли Telegram оплатить ссылку подписки повторно тем же пользователем — не подтверждено (S2).
- Предложение: проверить S2 в тестовой среде; если pre-checkout на продление не приходит — отвечать на pre-checkout
  `already_paid` для оплаченного заказа. Иначе — в `_renewal` сверять `subscription_expiration_date` с `sub.expires_at`
  (продление раньше срока более чем на сутки — пункт `stars_subscription_desync`, без выдачи), а «первый» платёж по
  оплаченному заказу подписки — сразу `editUserStarSubscription is_canceled=true` (п. 1.3).

**🟡 3. Возврат подписки Stars: отмена автопродления не гарантирована.** ✅
- Где: `refunds.py:279-283` (`edit_star_subscription` — исключение только в лог), `refunds.py:101-109` (`complete`
  ставит подписке `refunded`), `payments.py:492-499` (продление при статусе ≠ `active` возвращает `active`).
- Сценарий: возврат по подписке, `refundStarPayment` прошёл, `editUserStarSubscription` упал (bot-gateway или Telegram
  недоступны). У нас подписка `refunded`, в Telegram — живая; через месяц продление → подписка снова `active`, новый
  период: ученик, получивший возврат, снова платит. Отключить из Mini App нельзя (`live_stars` не видит `refunded` → 404).
  Пункта сверки нет — сотрудник не узнает (AT-94: «`refundStarPayment` и отмена подписки»).
- Предложение: сбой отмены — пункт `stars_subscription_desync` (как в саге) и повтор из tick; продление по подписке
  `refunded` — пункт сверки без выдачи и без смены статуса.

**🟡 4. Сага удаления: сбой отмены подписки Stars делает её неотменяемой.** ✅
- Где: `consumers.py:100-102`, `saga.py:47-62, 86-93` (сбой → пункт `stars_subscription_desync`, ACK уходит);
  identity-consent снимает Telegram ID после ACK всех доменов (`identity-consent/settings.py:11-14`,
  `service.telegram_of_account`).
- Сценарий: ученик удаляет аккаунт, bot-gateway в этот момент недоступен → billing ACK → identity-consent стирает
  Telegram ID. Подписка в Telegram живёт, каждый месяц — списание, `_renewal` → `paid_after_deletion`, вернуть нельзя
  (`STARS_PAYER_UNKNOWN`), отменить нельзя (Telegram ID нет). Решение §1.16 «сага не блокируется» сознательное, но
  кратковременный сбой соседа даёт бессрочные списания у удалённого ученика.
- Предложение: отмену повторять (`TransientError`, ограниченно — например, до суток) до ACK billing; по исчерпании — ACK
  с пунктом сверки. Либо identity-consent хранит Telegram ID до отдельного подтверждения отмены от billing.

**🟡 5. `BILLING_ENFORCED=false` — не поведение спринта 7: ИИ выключается всем с 90 % месяца.** ✅
- Где: `ai-gateway/migrations/versions/0009_sprint8_ai_control.py:67-70` (`degradation_mode auto`, 80 / 90),
  `domain/degradation.py` (`auto_level`, `LevelState.refusal`: `paid_only` и ученик `free` → `degraded`),
  `domain/tiers.py` (нет строки — `free`); lessons с выключенным пэйволом стартует по `ai_available`, не по уровню
  (`sessions.py:507-515`, `clients.py:153-162`).
- Сценарий: выкладка в prod с выключенными флагами — billing событий `access.changed` не шлёт, все ученики `free`.
  При 80 % потолка всем — резервная модель, при 90 % — `paid_only`: каждый вызов ИИ любого ученика → `unavailable:
  degraded` (уроки стартуют `full` и деградируют на первом вызове; коуч урока вдвоём тоже). В спринте 7 ИИ работал до
  100 %. Решение В14 рассчитано на наличие подписчиков; AGENT_BRIEF требует при `BILLING_ENFORCED=false` поведения
  спринта 7.
- Предложение: до включения пэйвола — `paid_only_at_percent = 100` миграцией (или `paid_only` без подписчиков
  равен `economy`), включать порог вместе с `BILLING_ENFORCED`; пункт в чек-лист включения DEPLOYMENT §12.

**🟡 6. Payme: «выключено» отвечает -32504 и по уже созданным транзакциям.** ✅
- Где: `providers/payme.py:363-364` — проверка `enabled()` до разбора метода; Click и Uzum уже созданные транзакции
  обрабатывают и при выключенной оплате (`click.py:13-14`, `uzum.py:245`).
- Сценарий: `PAYMENTS_ENABLED=false` или `PAYME_ENABLED=false` (аварийное выключение продаж) при живых транзакциях
  Payme: `PerformTransaction` → -32504 (деньги покупателя вернёт таймаут Payme), а `CancelTransaction` state 2 после
  возврата в кабинете Payme Business → -32504 → возврат у нас не завершается, период остаётся активным, хотя деньги
  возвращены; `SetFiscalData` → -32504 — чек не сохраняется. §1.6 формально так и требует, но правило расходится с Click
  и Uzum и с runbook «выключение продаж».
- Предложение: -32504 по флагам — только `CheckPerformTransaction` и `CreateTransaction` новой транзакции; Perform,
  Cancel, CheckTransaction, GetStatement, SetFiscalData — обрабатывать (Basic и IP — как сейчас). Поправить §1.6.

**🟡 7. Планировщик billing выключен.** ✅
- Где: `infra/n8n/workflows/billing-tick.json:4`, `billing-reconcile.json:4` — `"active": false` (§16: «включение —
  вместе с выкладкой billing»).
- Сценарий: без tick не истекают удержания (80 ч) и заявки (72 ч), не заканчиваются подписки Stars без продления, нет
  `subscription.expiring`, повторов фискализации Click, сверки и **повтора начальной загрузки проекции `learners`**:
  она запускается один раз при старте (`bootstrap.on_start`); если identity-consent в этот момент перезапускается
  (выкладка вместе), проекция пуста до ручного `projections/bootstrap` → на сайте все `payer_required`, подростки с
  согласием в Mini App — `GUARDIAN_CONSENT_REQUIRED`, `access.changed` не доходит детским профилям.
- Предложение: включить оба потока в той же выкладке, что и billing (флаги продаж при этом выключены — tick безопасен),
  проверка в `infra/n8n/test_workflows.py`; пункт DEPLOYMENT §12.

## 🟢 Мелочи

| № | Находка | Исполнитель |
|---|---|---|
| 8 | `python -m tilhero_botgw.setup` по умолчанию сбрасывает ожидающие обновления (`setup.py:31, 86`) — вместе с необработанными `successful_payment`. В runbook — предупреждение или `drop_pending_updates=False` по умолчанию | G |
| 9 | gamification: возврат пакета тилов, который не начислялся (Stars с несоответствием — заказ `paid` без `order.paid`), — `TransientError` около суток и DLQ (`til_packs.py:161`); подтверждать `not_credited` / `tils_spent` | C |
| 10 | pre-checkout отказывает только `DELETION_REQUESTED` (`bot-gateway/stars.py:171`); аккаунт `DISABLED` (заблокирован сотрудником) платить может | G |
| 11 | `POST …/trials:grant-all` выполняется в HTTP-запросе (`api/admin.py:402-420`, `account.grant_trials_all`) — на тысячах аккаунтов дольше таймаута admin-bff; повтор запускает второй проход (дублей нет благодаря `uq_period_trial`, но двойная нагрузка). Фоном с отметкой прогона | A |
| 12 | Сверка `stale_created`: выборка `state = 'created' LIMIT 500` без порядка и фильтра по возрасту (`reconciliation.py:76-78`) — при большом числе свежих попыток старые не попадают | A |
| 13 | `account.settle_event`: `assert row is not None` после блокировки (`account.py:360-361`) — гонка с сагой (удержания удалены) роняет обработчик до повтора; вернуть «не найдено» | A |
| 14 | Удержание, полученное уже после завершения занятия (`sessions._billed` при гонке, `rooms._keep_hold` после `finish`), живёт 80 ч и даёт пункт `hold_expired`; снимать сразу (расчёт с 0) | C |
| 15 | `stars_subscription_state` с `account_id = null` меняет статус без проверки плательщика (`payments.py:553`) — риск низкий (вебхук с секретом), но логичнее пункт сверки | A |
| 16 | Сага не удаляет ключи идемпотентности сотрудников с ответами, где есть `account_id` ученика (`saga.py:116` — только ключи ученика); живут до 30 дней | A |
| 17 | Колбэк Payme > 64 КиБ → 413 вместо HTTP 200 JSON-RPC (`api/callbacks.py:163-164`); payments-edge режет раньше — косметика | B |
| 18 | Откат каталога при существующем черновике: черновик остаётся с номером меньше активной версии (`catalog.py:536-562`) — сбивает с толку в истории версий | A |
| 19 | `periods_guard` без проверки `INSERT` (`0001_initial.py:726`): вставка периода в любом статусе не ограничена триггером (код вставляет только `scheduled`/`active`) | A |
| 20 | Живой прогон `caddy` для payments-edge на стенде пропущен (23 skipped) — убедиться, что в CI бинарь есть и тесты не пропускаются | B / I |

## Проверено без замечаний

- **Деньги — целые (ADR-0001).** Во всём billing нет `float`/`Decimal` для сумм; тийины `BIGINT`, Stars `INTEGER`,
  ровно одно поле заполнено (CHECK в `orders`, `provider_transactions`, `refunds`), `XTR ⇔ telegram_stars`,
  `telegram_stars ⇔ miniapp|renewal`. Click: `parse_sum_string` по `[0-9]{1,12}(\.[0-9]{1,2})?` без float, ссылка —
  `format_sum`; Payme/Uzum — целые тийины, JSON провайдера — `parse_float=str`. НДС «внутри цены» — целочисленно.
- **Сумма только из каталога.** `orders.create` берёт цену канала из активной версии (`channel_price`), снимок товара
  неизменяем (`orders_guard`); Payme/Click/Uzum и pre-checkout сверяют сумму с заказом; `createInvoiceLink` — сумма
  заказа, `subscription_period` 2592000 только для `stars_mode: subscription` и ≤ 10 000 (billing и bot-gateway).
- **Идемпотентность и гонки.** `UNIQUE (provider, provider_txn_id)`, `uq_txn_order_performed`; повторная проверка
  транзакции под блокировками «аккаунт → заказ»; Payme — одна транзакция в ожидании (`OrderBusy`); тесты гонок есть и
  зелёные (две Perform Payme, две попытки Click, 6 параллельных `successful_payment`, продление против tick, возврат
  против проведения, два удержания пула, два решения по заявке, удаление против заказа). Повтор события занятия —
  `settle` по статусу удержания; повтор обновления Telegram — отметка `update_id` только после 2xx billing
  (`webhook._payment_update`), параллельный дубль — 503.
- **Машины состояний.** Триггеры `txn_guard` (`[*] → created`, Stars `[*] → performed`), `orders_guard` (§1.4, в т. ч.
  `expired → paid|fulfilled`), `periods_guard` (§1.10), `ledger_guard` (только добавление; в саге — DELETE и
  `learner_id → NULL`), `catalog_guard`; роли `billing_owner` / `billing` — тест под ролями.
- **Реестр минут.** Итоги и запись — одна транзакция; CHECK `granted − spent − removed ≥ 0`, `held ≤ доступно`;
  списание `min(billable, удержание + доступно)`, перерасход — в итоге, ученику не выставляется; поздний расчёт по
  истёкшему удержанию — один раз (ключ пункта сверки); сверка `balance_drift` пересчитывает из реестра.
- **Payme.** Всегда HTTP 200; Basic (логин и пароль за постоянное время, пустой ключ не совпадает); IP по CIDR;
  таймаут 43 200 000 мс от `time` Payme (отмена reason 4, -31008) в Create и Perform; повтор Create/Perform/Cancel — тот
  же ответ; -31007 не возвращается; `SetFiscalData` PERFORM/CANCEL — разные записи; `message` RU/UZ/EN.
- **Click.** Подпись MD5 по полям «как пришли», `compare_digest`; `service_id`; -2 по строке суммы; `error < 0` →
  отмена и -9; повтор Complete → -4; повтор Prepare — тот же `merchant_prepare_id`; чужой `click_trans_id` → -8.
  Reversal — только «соединение не установлено» повторяется; окно возврата — текущий месяц по Ташкенту.
- **payments-edge и вход колбэков.** `X-Edge-Token` подставляется Caddy, входящий вырезается; billing без верного
  токена — 404, неотличимый от отсутствия маршрута (`secret_equals`); тело ≤ 64 КиБ; адрес клиента — второй справа в
  `X-Forwarded-For`; лимит `pay.callback_ip` с псевдонимом IP; `provider_calls` — только метаданные.
- **Stars, bot-gateway.** Pre-checkout в теле webhook: identity 2 с + billing 3 с (валидатор настроек ≤ 9 с), billing
  укладывается в 2,5 с, любая ошибка — `ok: false` с текстом RU/UZ без упоминания других способов оплаты; внутренний API
  Stars — только `iss=billing` и только на `INTERNAL_PORT`; `refundStarPayment` «уже возвращён» → `{ok, already}`;
  `/paysupport`, `/support`, `/terms` (оферта только на домене Mini App — валидатор `TERMS_URL`); тело billing без
  Telegram ID (`extra=forbid`), логи — `charge_ref`, логгеры httpx заглушены (токен в URL Bot API).
- **Возвраты и «четыре глаза».** Возврат: `billing.refund` + step-up, причина ≥ 10, один живой возврат на заказ
  (частичный UNIQUE + проверка под блокировками), пред-проверка тилов, Payme/Uzum — `awaiting_provider` и завершение по
  `CancelTransaction` state 2 / `reverse`. Корректировки: автор ≠ решающий (код и CHECK), step-up у заявки и решения,
  проверки при подаче и применении, `before/after`, аудит обоих, истечение 72 ч.
- **Права (0008).** Роль `finance` (без `subscriptions.override`), `support` + `billing.read` и `subscriptions.override`,
  `operations` — всё, `analyst`/`auditor` — `billing.read`; привилегированность по правам со step-up, сессии
  ставших привилегированными отзываются; откат симметричен.
- **Флаги.** `PAYMENTS_ENABLED` не задан → `false` в stage/prod (проверено запуском `Settings` с `ENV=prod`), `true` в
  dev/test; в stage/prod флаг провайдера без ключа и реквизитов — сервис не стартует; `setup.py` выставляет все флаги
  `false`, `BILLING_ENFORCED=false`; `STARS_ENABLED=false` — pre-checkout отказывает, платёж по одобренному счёту и
  продление принимаются.
- **`BILLING_ENFORCED=false` в lessons.** billing не вызывается (`_billable`, `_payer`), режим — как в спринте 7;
  ИИ-секунды и `billable_minutes` только пишутся в событие, без `billing_hold_id` billing ничего не списывает
  (оговорка по ai-gateway — п. 5).
- **Ключи JWT новых вызовов.** billing — в `JWT_ISSUERS`; `extend.py` раздаёт новый `INTERNAL_JWT_PUBLIC_KEYS` всем
  издателям (gamification, identity-consent, telegram-bot-gateway получают ключ billing; billing — все ключи); адреса:
  `BOTGW_URL` → внутренний порт 8108, `BILLING_URL` у bot-gateway, lessons, telegram-bff, admin-bff, n8n; разрешённые
  вызывающие: identity-consent `export/profiles` — gamification и billing, `telegram-users/{id}/account` — bot-gateway и
  telegram-bff, `accounts/{id}/telegram-user` — только bot-gateway; gamification `by-order` — только billing.
- **Начальная загрузка проекции `learners`.** Выгрузка `profiles` + `guardian_user_id`, «вставить, если нет; обновить,
  если новее», удалённые — после блокировки, одна загрузка за раз (сессионная блокировка), повтор с курсора (оговорка —
  п. 7). `learner_tiers` ai-gateway и `tier` user-admin начинают с нуля по новым событиям — загрузка не нужна (нет
  строки = `free`).
- **Сага.** Блокировка аккаунта и `SET LOCAL tilhero.deletion`; минуты, удержания, остатки, периоды, заявки,
  `learners` удаляются; заказы, транзакции, возвраты, подписки Stars, чеки — обезличены; Payme/Click по заказу,
  отменённому сагой, получают -31008 / -9; платёж Stars после удаления — `paid_after_deletion` (оговорки — п. 1а, 4).
- **Анти-стиринг на сервере.** Канал `miniapp` видит только заказы `miniapp|renewal`, цены и провайдер только Stars,
  подписку без источника и цены периодов сайта; валидатор каталога запрещает названия Payme/Click/Uzum и адрес сайта в
  названиях, описаниях и заголовке счёта, `offer.url` — не на домене сайта; шаблоны notifications для заказов `web`
  нейтральны (без суммы и способа), автотест каталога шаблонов есть; тексты бота — автотест
  `test_bot_texts_have_no_steering`; заметка «Что нового» s8 — только о Stars, детская версия без цен и призывов,
  создаётся черновиком (публикация — решение 20).
- **Секреты и PII.** Ключи провайдеров — `SecretStr`, ссылки `${{shared.*}}` только у billing; `BOT_TOKEN` — только у
  двух сервисов (тест `setup.py`); фильтр логов py-common дополнен (`key`, `sign_string`, `secret_key`, `code_verifier`,
  `id_token`, `client_secret`); `provider_meta` чистится от ключей вида секретов, карт и Telegram ID; события и пункты
  сверки — без Telegram ID и ПДн.

## Что подтвердить вне кода (⚠️)

- §14 S2 — приходит ли `pre_checkout_query` на продление и можно ли повторно оплатить ссылку подписки (влияет на п. 2).
- Поведение Telegram при постоянном 503 на платёжное обновление: сколько попыток и задерживает ли оно последующие
  обновления бота (влияет на тяжесть п. 1а и 1б) — проверить на тестовом боте.
- Живой прогон `caddy validate` и маршрутов payments-edge (на стенде бинаря нет).
