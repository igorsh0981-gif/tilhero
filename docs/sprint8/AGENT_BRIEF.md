# Бриф исполнителя спринта 8 (общий для всех)

Репозиторий: `/home/claude/tilhero`, ветка `sprint/8-money`. Не переключай ветки и не коммить — коммитит координатор.

Стенд:
- PostgreSQL 127.0.0.1:5432 (`postgres` без пароля, БД `tilhero_test`), Redis 127.0.0.1:6379, NATS 127.0.0.1:4222;
- если стенд упал: `bash infra/dev/stack.sh up`;
- переменные тестов: `source .dev/testenv.sh`.

## Прочитать перед началом
1. `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md` (§2 — деньги в спринте 8 **только целые числа**: тийины и Stars,
   ADR-0001; §8 «Дети и подростки»; §10 «Что нового»), `docs/sprint8/PLAN.md` (решения владельца от 22.11.2026 — оба
   блока, решения координатора, открытые вопросы с умолчаниями), `docs/sprint8/INTERNAL_API.md` — главный документ.
2. Контракты — источник истины:
   - `packages/contracts/src/bff.ts` — раздел «Спринт 8» (Mini App, только Stars); `web.ts` — сайт оплаты;
   - `admin.ts` — раздел «Деньги», права, роль `finance`, меню; `ai.ts` — `AiStatus`, `AiBudget`, деградация, стоимость;
   - схемы событий `packages/contracts/events/*.schema.json` (`infra/scripts/gen_event_schemas.py`);
   - лимиты `rate-limit-policies.json`; каталог «Что нового» `release-notes.json`;
   - протокол адаптера `services/billing/src/tilhero_billing/providers/base.py` и порт `domain/ports.py` (нулевой поток).
3. Решения прошлых спринтов:
   - `docs/sprint6/INTERNAL_API.md` и `docs/qa/sprint6-qa-report.md` — реестр только на добавление, итоги и сверка,
     версии (черновик → проверка → активация), tick, сага, проверка «удалён?» после блокировки;
   - `docs/sprint7/INTERNAL_API.md` — парные комнаты, выгрузки для начальной загрузки проекций, ack-события;
   - `docs/sprint4/INTERNAL_API.md` и `services/ai-gateway/README.md` — режимы `full`/`choices`, бюджеты, резерв, резервная
     модель, аварийная остановка;
   - `apps/telegram-bot-gateway/README.md` — webhook, идемпотентность `update_id`, внутренний порт, токен бота.
4. Эталоны TilHero: домен с реестром, версиями, tick, проекциями и сагой — `services/gamification/`; сессии и комнаты —
   `services/lessons/`; бюджеты — `services/ai-gateway/src/tilhero_ai_gateway/domain/budget.py`; Node —
   `services/telegram-bff/src/routes/game.ts`, `services/admin-bff/src/routes/game.ts`; фронтенд —
   `apps/telegram-miniapp/src/screens/game/`, `apps/admin-web/src/screens/game/`; Caddy и статика — `apps/admin-web`.
5. Документация провайдеров и Telegram — INTERNAL_API §15; что не подтверждено — §14 (не додумывай: неизвестное — в
   константу или настройку и в отчёт).

## Порядок
1. **Поток 0 (координатор) — до старта остальных:** контракты (`bff.ts`, новый `web.ts`, `admin.ts`, `ai.ts`), схемы
   событий, лимиты (3 копии), `release-notes.json`; каркас `services/billing` (pyproject, Dockerfile, alembic, settings,
   `providers/base.py`, `domain/ports.py`); каркасы `apps/web-pay` и `apps/payments-edge` (Dockerfile, Caddyfile-заготовка);
   в telegram-bff — регистрация плагинов маршрутов `routes/billing.ts` и `web/index.ts` и ключи `config.ts`; регистрация в
   `infra` (`setup.py`, `extend.py`, `bootstrap.sql`, n8n `billing-tick`, `billing-reconcile`; тест «`BOT_TOKEN` только у
   bot-gateway и telegram-bff»); ключи `authorization`, `sign_string`, `secret_key`, `password`, `key`, `client_secret`,
   `code`, `code_verifier`, `id_token` в фильтре логов py-common и ts-common; ADR-0001; ARCHITECTURE.
2. **A–H — параллельно** на заглушках соседей (httpx.MockTransport, mock BFF, мок Telegram). Первым делом A отдаёт
   реализацию `PaymentPort` (день 1) потокам B и G, C — внутренние `holds`/`access`, D — эндпоинты identity-consent
   «Telegram ID ↔ аккаунт» потокам G и H.
3. **I — интеграция** после сдачи A–H: e2e, анти-стиринг, ревью, исправления, QA, деплой.

## Потоки
### A. billing — ядро
Каталоги: `services/billing/**`, **кроме** `src/tilhero_billing/providers/**`, `api/callbacks.py`, `api/stars.py`,
`tests/providers/**`, `tests/stars/**`.
- Миграция 0001 — все таблицы INTERNAL_API §1.1 (в т. ч. таблицы адаптеров и Stars), триггеры (`catalog_guard`,
  `txn_guard` с переходом Stars `[*] → performed`, реестр только на добавление, переходы заказов и периодов), каталог v1
  черновиком; `domain/stand.py` — тестовые цены в Stars и активация в dev/test. Модели — зеркало, `schema_drift`, тест под
  ролями.
- Домен: каталог и валидатор (§1.2, в т. ч. ограничения Stars); заказы и каналы (§1.3, пара «канал — провайдер», каталог
  по каналу, правила подписки Stars); `PaymentPort` (§1.4, все операции, включая `paid`, `refunded`,
  `stars_subscription_state`), выдача в одной транзакции с проведением; периоды, `ensure_current`, продления Stars
  (§1.10); подписки Stars и их tick (§1.5 — доменная часть); реестр и удержания (§1.11); возвраты (§1.12, через
  `adapter.refund`); «четыре глаза» (§1.13); сверка (§1.14, через `adapter.remote_status`); отчёты и курсы (§1.15); tick,
  проекция `learners`, сага с отменой автопродления Stars через адаптер (§1.16).
- API: ученика (с фильтрацией по каналу), внутренний (`holds`, `access`), админ (§1.17); аудит; события §10.
- Блокировки: advisory аккаунта, затем заказа — всегда в этом порядке. Проверка «удалён?» — после блокировки.
- README: API, события, данные, переменные, runbook (возврат по каждому провайдеру, зависшая транзакция, рассинхрон
  подписки Stars, расхождение остатков, выключение продаж).

### B. Фиатные провайдеры и edge
Каталоги: `services/billing/src/tilhero_billing/providers/{payme,click,uzum,common}.py`, `api/callbacks.py`,
`services/billing/tests/providers/**`, `apps/payments-edge/**`.
- Адаптеры Payme (§1.6), Click (§1.7), Uzum (§1.8, за флагом) по `ProviderAdapter`; общие помощники: разбор суммы Click
  строкой, `hmac.compare_digest`, CIDR (пусто — выключено), ответы в формате провайдера (Payme — всегда HTTP 200).
  Заказы канала не `web` — «заказ не найден».
- Коды, поля и URL провайдера — в одной таблице констант адаптера (§14: часть сверяется позже).
- `api/callbacks.py`: `/provider/v1/*`, `X-Edge-Token` (иначе 404), лимит `pay.callback_ip`, строка `provider_calls`.
- Исходящие: Click Merchant API (статус, отмена, фискализация), Payme `receipts.get_all` — если задан ключ; таймаут 10 с,
  повтор на сеть/5xx, circuit breaker.
- Ссылки оплаты: Payme GET, Click кнопка, Uzum шаблон; `return_url` — `{WEB_PAY_ORIGIN}/orders/{order_no}`.
- Симуляторы (`tests/providers/simulators.py`); контрактные тесты — строка таблицы = тест; оба сценария песочницы Payme;
  сценарии тест-утилиты Click.
- `apps/payments-edge`: Caddyfile по §4, README; `caddy validate` в тесте сборки.

### C. lessons + gamification
Каталоги: `services/lessons`, `services/gamification`.
- lessons (§5): миграция 0004; клиент billing; режим урока и сценария по удержанию; ИИ-секунды и `billable_minutes`; урок
  вдвоём — подписка пригласившего, удержание при старте с коучем, `coach_active_seconds`; поля событий;
  `BILLING_ENFORCED=false` — поведение спринта 7 (регрессия).
- gamification (§6): миграция 0003 (`til_orders`); consumers `billing.order.paid.v1`, `billing.order.refunded.v1` (только
  от billing, любой канал); `by-order` (только billing); события `game.til_pack.*`; сага.

### D. ai-gateway + контур
Каталоги: `services/ai-gateway`, `notifications`, `identity-consent`, `admin-identity`, `experience-config`, `audit`,
`user-admin`.
- ai-gateway (§7): миграция 0009; тариф ученика; дневной лимит по тарифу; уровни деградации и событие; `AiStatus`;
  стоимость занятий; `GET|PUT /admin/v1/ai/degradation`, `GET /admin/v1/ai/unit-costs`; `contracts.py` 1:1 с ai.ts.
- notifications (§8): 9 шаблонов RU/UZ (миграция), consumers `billing.*`, выбор шаблона по каналу заказа,
  `campaigns.ROUTES`; **тест анти-стиринга каталога шаблонов** (нет URL кроме `startapp`, нет названий Payme, Click,
  Uzum, адреса сайта, «сум»/«soʻm» в шаблонах заказов).
- identity-consent (§9): домен саги `billing` и порядок удаления Telegram ID; `guardian_user_id` в выгрузке;
  `GET /internal/v1/telegram-users/{id}/account` (bot-gateway, telegram-bff) и `GET /internal/v1/accounts/{id}/telegram-user`
  (только bot-gateway) — **отдаёт первым** потокам G и H.
- admin-identity: 0008 (права, `finance`, step-up, отзыв сессий). experience-config: 0010 (меню), 0011 (заметка
  `s8-plus` / `s8-plus-kids` только о Stars, тест по образцу `test_release_6.py`), `ILLUSTRATIONS`. audit: издатель
  `billing`. user-admin: 0004, consumer `billing.access.changed.v1`, фильтр `tier`.

### E. Mini App + telegram-bff (канал Mini App)
Каталоги: `apps/telegram-miniapp`, `services/telegram-bff` **кроме** `src/web/**`.
- telegram-bff: `routes/billing.ts` и кодеки `contractBilling.ts` (§12); claim `chn: "miniapp"` во внутреннем токене;
  только `provider: telegram_stars`; ответы без сумм в тийинах и фиатных провайдеров (контрактный тест);
  `purchase_available`; лимиты `tg.billing.*`; billing недоступен → 503 `BILLING_UNAVAILABLE`.
- Mini App (`screens/billing/`):
  - «Подписка» — статус, счётчик минут, даты, следующий период, пробный; подписка Stars — «Автопродление: вкл./выкл.» и
    дата следующего списания; история минут;
  - покупка — товар, цена в Stars, срок, минуты и что входит **до оплаты**, оферта и согласие, подтверждение замены
    пробного; `Telegram.WebApp.openInvoice(invoice_link)` (только через `src/tg/`), после закрытия — опрос заказа до 60 с;
  - «История платежей» — **только заказы Stars**; «Вопрос по оплате» — обращение в поддержку `SUBSCRIPTION_PAYMENT`;
  - «Купить тилы» за Stars, получатель — я или детский профиль; вход из магазина при нехватке тилов;
  - плашка `ai_locked` и «ИИ: осталось N мин» на старте урока; лист «Уроки вдвоём — в подписке»;
  - детский профиль — без цен, кнопок и призывов; «Подписка семьи активна до …».
- **Анти-стиринг:** в коде, словарях i18n и сборке нет адреса сайта, ссылок на него, Payme/Click/Uzum, цен в сумах и
  фраз о «другом способе оплаты»; тест по `dist/` (поток I добавит его в CI).
- `nav.ts`: `subscription`, `til_shop`; i18n RU/UZ («⭐ 300»); Playwright на mock BFF (3 вьюпорта, `openInvoice` —
  заглушка `src/tg/`). Иллюстрации `public/whatsnew/s8-plus.webp`, `s8-plus-kids.webp` (1200×675).

### F. Админка
Каталоги: `services/admin-bff`, `apps/admin-web`.
- admin-bff: `routes/billing.ts`, `routes/finance.ts`, дополнения `routes/ai.ts`, `dashboard.ts` (`money`), вкладка
  «Тариф»; step-up — §12; обзор — целочисленно (BigInt: микродоллары × тийины за USD; Stars × тийины за Star — с пометкой
  «оценка»).
- admin-web (`screens/money/`), меню «Деньги»: «Тарифы и товары» (две цены — в сумах и в Stars, режим Stars, заголовок
  счёта ≤ 32, фискальные реквизиты для сайта, пробный, лимиты, оферта; diff, проверка, активация и откат с TOTP);
  «Заказы и платежи» (фильтр по каналу и провайдеру, карточка: транзакции, подписка Stars, чеки, возвраты, вызовы
  провайдера, «Возврат» с TOTP и предупреждением о тилах); «Корректировки» (автор не видит «Подтвердить»); «Сверка»;
  «Финансовый обзор» (сайт и Stars раздельно, курсы USD и Star, «без комиссий провайдеров и магазинов приложений»);
  карточка ученика → «Тариф»; «Затраты ИИ» — деградация, лимит подписчика, стоимость занятий. Playwright.

### G. Telegram Stars
Каталоги: `services/billing/src/tilhero_billing/providers/telegram_stars.py`, `api/stars.py`,
`services/billing/tests/stars/**`, `apps/telegram-bot-gateway/**`.
- billing: адаптер (`checkout` — ссылка через bot-gateway; `refund`; `remote_status` — выписка) и маршруты
  `/internal/v1/stars/*` (только `iss=telegram-bot-gateway`) → `PaymentPort` (§1.5): pre-checkout ≤ 3 с, платёж
  (первый и продление; несоответствия — пункт сверки, не отказ), `refunded_payment`, обновления подписки; автопродление
  из Mini App.
- bot-gateway (§2): внутренний API `/internal/v1/stars/*` (только `iss=billing`); `allowed_updates` + `pre_checkout_query`,
  `subscription`; `pre_checkout_query` → identity-consent → billing → `answerPreCheckoutQuery` в теле ответа webhook ≤ 10
  с (свои таймауты 2 + 3 с); `successful_payment`, `refunded_payment`, `subscription` → billing; **отметка `update_id` —
  только после 2xx billing**, иначе 503 и повтор Telegram; команды `/paysupport`, `/support`, `/terms` (RU/UZ, без ссылок
  на сайт); `TELEGRAM_TEST_ENV`; логи без Telegram ID и charge id. Токен бота — только здесь (и в telegram-bff, как
  раньше).
- Тесты: мок Bot API (`httpx.MockTransport`): `createInvoiceLink` (XTR, одна позиция, пустой `provider_token`,
  `subscription_period` только для подписки), повтор обновлений, таймауты внутри 10 с, billing 5xx → 503 и повторная
  доставка без двойного зачисления, `refundStarPayment` «уже возвращён» → ок.
- Проверка на тестовой среде Telegram (тестовый бот): счёт, оплата, продление (если доступно), отмена, возврат —
  результат в отчёте (§14 S1–S5).

### H. Веб-оплата
Каталоги: `apps/web-pay/**`, `services/telegram-bff/src/web/**`, `services/telegram-bff/test/web/**`.
- telegram-bff `src/web/` (§3): OIDC «Log In with Telegram» (Authorization Code + PKCE S256, `state` в Redis и cookie,
  обмен `code` с Basic `client_id:client_secret`, проверка `id_token` по JWKS: подпись, `iss`, `aud`, `exp`, кеш ключей);
  вход только существующего аккаунта (identity-consent); cookie-сессия `__Host-wp_session` (JWT, `jti`, выход — список
  отзыва в Redis); CSRF-токен и проверка `Origin`; маршруты `/web/v1/*` → billing с `chn: "web"`; лимиты `web.*`;
  `WEB_PAY_ENABLED=false` → 404; `TELEGRAM_OIDC_BASE` — подмена только в dev/test (мок OIDC).
- `apps/web-pay`: React + Vite + TS, Caddy (статика, `/api/*` → telegram-bff по приватной сети, заголовки и CSP §3);
  страницы §3; суммы — целочисленно из тийинов («49 000 сум» / «49 000 soʻm», U+02BB); без сторонних скриптов, шрифтов,
  аналитики; RU/UZ; адаптивность; Playwright на mock BFF; тест заголовков ответа Caddy.
- Тесты: подделанный `id_token` (чужая подпись, `aud`, просрочен), повтор `state`, отсутствие cookie, нет аккаунта,
  ребёнок/подросток без согласия, CSRF, Origin, ПДн в URL (ни один ответ не редиректит с ПДн в query).

### I. Интеграция (координатор)
`infra/*`, `docs/*`: `infra/e2e/mock_payments.py` (Payme, Click, Uzum — запросы в billing с `X-Edge-Token`), расширение
`mock_telegram.py` (Bot API: `createInvoiceLink`, `refundStarPayment`, `editUserStarSubscription`, `getStarTransactions`;
отправка обновлений `pre_checkout_query`, `successful_payment`, `refunded_payment`, `subscription` в webhook bot-gateway),
мок OIDC Telegram (JWKS, `/auth`, `/token`); e2e `scenario_money.py`; CI-проверка анти-стиринга (сборка Mini App,
тексты бота, шаблоны); терпимые читатели `lesson.*` у learning-plan, memory, social, gamification; ревью, QA-отчёт,
DEPLOYMENT §12, деплой (флаги выключены).

## Правила работы
- **Только свои каталоги** (указаны в потоке). `packages/*`, корневые `pyproject.toml`/`package.json`/`uv.lock`/
  `package-lock.json`, `infra/*`, `.github/*` и общие файлы telegram-bff (`app.ts`, `config.ts`) НЕ трогай. Нужно
  изменение общего кода, контракта или зависимости — опиши в отчёте («Запросы к общему коду»), у себя — минимальный обход.
- **Зависимости установлены.** Не запускай `uv add`/`uv lock`/`npm install <pkg>`. MD5, SHA-1, base64, HMAC, PKCE —
  стандартная библиотека; проверка JWT по JWKS — библиотека, уже используемая для внутреннего JWT (иначе — запрос).
- **Деньги:**
  - суммы — только целые: тийины (`int`, `BIGINT`) и Stars (`int`, `INTEGER`), в TS — целые `number` ≤ 10¹¹ или
    `bigint`; ни float, ни `Decimal`; пересчёта Stars ↔ сумы в домене нет; сумма заказа — только из каталога;
  - каждое изменение денег и минут — запись в реестре и итог в той же транзакции; исправление — новой записью;
  - идемпотентность — по `(provider, provider_txn_id)` (у Stars — `telegram_payment_charge_id`), повтор — тот же ответ;
  - состояния — только переходы INTERNAL_API §1.4 и §1.10 (код + триггер + тест на запрещённый переход).
- **Токен бота** — только в bot-gateway (Bot API) и telegram-bff (initData). Никаких новых переменных `BOT_TOKEN`, никаких
  передач токена в запросах, событиях, логах. Секрет клиента OIDC — только telegram-bff.
- **Анти-стиринг** (решение владельца В1): Mini App, бот, его команды, уведомления и заметка «Что нового» не упоминают
  сайт оплаты, не ссылаются на него и не называют Payme, Click, Uzum и цены в сумах; канал `miniapp` не видит заказов
  сайта. Сомневаешься — не пиши и спроси координатора.
- **Секреты провайдеров** — только из настроек (`SecretStr`), сравнение за постоянное время; не в БД, логах, событиях,
  ответах, тексте ошибок, `repr`. Тела колбэков в лог не пишутся. В тестах — только заведомо тестовые строки.
- **Telegram ID** — только в identity-consent, bot-gateway (в памяти запроса) и telegram-bff (в памяти запроса); в billing,
  событиях, логах, URL — никогда.
- **Дети 6–13** не платят и не видят цен; детскому профилю тилы покупает родитель; уведомления об оплате — плательщику.
  **Подростки 14–17** — оплата только с согласием родителя.
- **Учёба не зависит от денег:** billing или bot-gateway недоступны — уроки без ИИ, остальное работает.
- **Общие правила:** UUID сущностей; `user_id`/`staff_id` — только из токена; права — в домене по actor; step-up — по
  списку INTERNAL_API §12; аудит привилегированных команд; пагинация; ErrorBody; Idempotency-Key; события — outbox в той
  же транзакции; consumers — inbox с дедупликацией и проверкой издателя.
- **Тексты ученика и PII** — никогда в логах, событиях, метриках. Комментарий сотрудника ученику не показывается.
- **Тесты на стенде:** Python — `uv run pytest <каталог> -q -p no:cacheprovider`, `uv run ruff check <каталог>`,
  `uv run mypy <каталог>/src` (каждый сервис отдельно; время — внедряемые часы: таймаут Payme 12 ч, конец периода,
  `subscription_expiration_date`, 72 ч заявки); TS — `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`; фронт — ещё
  `npx playwright test`, `npm run build`.
- **Минимум тестов на эндпоинт:**
  - happy path, 401, 403 (чужой вызывающий, нет права, нет step-up, детский профиль, подросток без согласия, чужой
    канал), 404, 422, 409 (переходы, баланс, «четыре глаза», подписка Stars уже есть), идемпотентность, изоляция
    аккаунтов (чужой заказ — 404);
  - колбэки и обновления Telegram — каждая строка таблиц §1.5–1.8, повтор каждого, неверная подпись/Basic/секрет,
    выключенный провайдер;
  - события — `assert_event_conforms`;
  - гонки: два `PerformTransaction` одновременно; Complete двух попыток Click; два `successful_payment` с одним charge id
    одновременно; продление Stars одновременно с tick конца периода; два удержания одного пула (родитель и ребёнок);
    возврат одновременно с проведением; два решения по одной заявке; повторное событие завершения занятия;
  - удаление аккаунта под блокировкой (проверка «удалён?» после захвата блокировки).
- **Перед сдачей** — внутренний QA: IDOR (`order_no`, `account_id`, `beneficiary_id`), AuthZ, переходы, повторная
  отправка, граничные суммы (100 тийинов, 10¹¹, сумма с копейками у Click, 1 и 10 000 Stars), дети и подростки,
  анти-стиринг, соседний сервис недоступен (billing, bot-gateway, gamification, ai-gateway, identity-consent, oauth.telegram.org)
  → понятная ошибка, учёба работает. Найденное исправь.
- **Итоговый отчёт** — кратко, по-русски: что сделано; эндпоинты; события; таблицы и миграции; тесты цифрами; отклонения
  от контракта; что не подтверждено документацией и как закрыто; «Запросы к общему коду».

## Чек-лист ревью (два независимых ревью; одно — деньги, безопасность и анти-стиринг)
**Деньги и состояния**
- [ ] Нет float/`Decimal` в суммах; тийины и Stars — разные колонки, ровно одна заполнена; Click `amount` — строкой.
- [ ] Цена заказа — из каталога; снимок в заказе; смена цен не задевает оплаченное; цена подписки Stars ≤ 10 000.
- [ ] `UNIQUE (provider, provider_txn_id)`; один `performed` на заказ; Payme — одна транзакция в ожидании на заказ.
- [ ] Проведение и выдача периода — одна транзакция БД; тилы — ack gamification, иначе пункт сверки.
- [ ] Переходы транзакции, заказа, периода — только §1.4/§1.10; Stars — `[*] → performed`; триггеры на месте.
- [ ] Реестр минут — только добавление; баланс ≥ 0; удержания в «доступно»; перерасход не выставляется ученику.
- [ ] Повтор любого колбэка, обновления Telegram и события занятия — без второго зачисления или списания.
- [ ] Порядок блокировок «аккаунт → заказ»; сага проверяет удаление после блокировки.

**Telegram Stars**
- [ ] `createInvoiceLink`: XTR, пустой `provider_token`, одна позиция, `payload` ≤ 128 байт, `title` ≤ 32,
      `subscription_period` 2592000 только для подписки.
- [ ] `pre_checkout_query`: ответ в теле webhook ≤ 10 с; проверки заказа, суммы, срока, плательщика, живой подписки;
      таймауты — отказ с понятным текстом, без упоминания других способов оплаты.
- [ ] `successful_payment`: зачисление только по нему; несоответствия — пункт сверки, не потеря денег; отметка
      `update_id` после 2xx billing; первый платёж и продление различаются по `is_recurring`/`is_first_recurring`.
- [ ] Подписка: `subscription` canceled/active/failed; автопродление из Mini App — `editUserStarSubscription`; при
      возврате и удалении аккаунта — отмена.
- [ ] Возврат — `refundStarPayment`, «уже возвращён» идемпотентен; `refunded_payment` без заявки — пункт сверки.
- [ ] `/paysupport`, `/support`, `/terms` отвечают; Telegram ID нет в billing и логах.

**Сайт оплаты**
- [ ] OIDC: PKCE S256, `state` одноразовый и привязан к cookie, подпись `id_token` по JWKS, `iss`, `aud`, `exp`; секрет
      клиента не в логах; токен бота не используется.
- [ ] Только существующий аккаунт; ребёнок не входит, подросток без согласия не платит.
- [ ] Cookie `__Host-`, HttpOnly, Secure, SameSite; CSRF и `Origin`; выход отзывает сессию.
- [ ] CSP и прочие заголовки §3; нет внешних скриптов; `Referrer-Policy: no-referrer`; в URL нет ПДн; адрес очищается
      после входа.
- [ ] Канал `web` — только Payme/Click/Uzum и цены в сумах; возврат покупателя — на страницу заказа.

**Анти-стиринг**
- [ ] Сборка Mini App, i18n, тексты бота, шаблоны уведомлений, заметка «Что нового» — без адреса сайта, ссылок на него,
      названий Payme/Click/Uzum, цен в сумах (автотесты есть и зелёные).
- [ ] API канала `miniapp` не отдаёт заказов сайта, сумм в тийинах, фиатных провайдеров; уведомления о заказах сайта
      нейтральны.

**Фиатные провайдеры**
- [ ] Payme: всегда HTTP 200; Basic с ключом кассы за постоянное время; -32504 при выключенной оплате; `message` RU/UZ/EN;
      таймаут 43 200 000 мс; -31007 не возвращается; `SetFiscalData` PERFORM и CANCEL раздельно.
- [ ] Click: подпись по полям «как пришли»; `service_id`; `error < 0` → отмена и -9; повтор Complete → -4.
- [ ] Uzum — за флагом, коды в одной таблице, «не сверено» в отчёте.
- [ ] `X-Edge-Token` обязателен; IP-список настраивается; `provider_calls` без тел и подписей.

**Сотрудники, ученики, ИИ, релиз**
- [ ] «Четыре глаза»: автор ≠ решающий (код и CHECK), step-up, аудит обоих, истечение 72 ч.
- [ ] Возврат: step-up, причина, окно Click, пред-проверка тилов, повтор невозможен.
- [ ] Каталог: валидатор, фискальные реквизиты сайта обязательны в stage/prod, активация и откат со step-up.
- [ ] Дети и подростки — по правилам; `BILLING_ENFORCED=false` — поведение спринта 7; billing недоступен — урок без ИИ.
- [ ] Списание `⌈ИИ-секунды/60⌉`; деградация не списывает; комната с ребёнком бесплатна; приглашение без подписки — 403.
- [ ] Контроль ИИ: лимит по тарифу, `paid_only` без расхода на бесплатных, `economy` — резервная модель, событие уровня.
- [ ] Контракты TS ↔ Python совпадают; события строгие; лимиты — три копии совпадают; `BOT_TOKEN` только у двух сервисов.
- [ ] «Что нового»: взрослая и детская версии RU/UZ, иллюстрации, только о Stars; флаги в stage/prod выключены.

## e2e `scenario_money.py` (живой стенд, fake-ИИ, флаги включены, моки Telegram, OIDC и провайдеров)
Сдвиг времени — только строки своих учеников через psql с записью в журнал прогона (как `scenario_game.py`).
1. Взрослый A, его детский профиль, взрослый B (друг A). Каталог Mini App — только Stars (нет тийинов и фиатных
   провайдеров); детский профиль — `products: []`, `payer_required: true`.
2. `BILLING_ENFORCED=true`, урок A без подписки → `choices`, `ai_locked no_subscription`; реестр пуст.
3. Пробный A → урок `full`, удержание → списание 1 минуты; повтор события — без второго списания; второй пробный — 409.
4. Подписка за Stars в Mini App: заказ без `confirm_forfeit` → 409; с ним → `invoice_link` (мок Bot API получил XTR,
   одну позицию, `subscription_period` 2592000) → мок Telegram шлёт `pre_checkout_query` → bot-gateway отвечает `ok`
   (замер времени < 10 с) → `successful_payment` (`is_recurring`, `is_first_recurring`) дважды → один период до
   `subscription_expiration_date`, пробный `superseded`, `stars_subscriptions` `active`; `pre_checkout_query` по чужому
   заказу (другой аккаунт) → `ok: false`.
5. Продление: `successful_payment` (`is_recurring`, не первый) → заказ `renewal`, следующий период; обновление
   `subscription` `canceled` → автопродление выкл.; «Включить автопродление» в Mini App → мок получил
   `editUserStarSubscription is_canceled false`.
6. Тилы ребёнку за Stars (разовый счёт) → gamification → `fulfilled`, тилы ребёнка +N.
7. Сайт: вход через мок OIDC (неверная подпись `id_token` → отказ; B без аккаунта не входит; A входит, адрес очищен,
   cookie `__Host-wp_session`); каталог сайта — только сумы; заказ «Плюс 90» Payme (`after_current`):
   `CheckPerformTransaction` (`detail`), `CreateTransaction` ×2, `PerformTransaction` ×2 → `fulfilled`, период
   `scheduled`; `SetFiscalData` → ссылка на чек на странице заказа; без CSRF-заголовка → 403.
8. Анти-стиринг: история платежей Mini App A не содержит заказа сайта; уведомление о нём — `purchase_applied` без суммы
   и провайдера; ответы канала `miniapp` не содержат тийинов.
9. Тилы ребёнку на сайте через Click: Prepare ×2, Complete → тилы +100; неверная подпись → -1; повтор Complete → -4.
10. Урок вдвоём: B приглашает A → 403 `SUBSCRIPTION_REQUIRED`; A приглашает B → комната с коучем → одно списание у A.
    Семейная комната A с ребёнком — без проверки и списания.
11. «Четыре глаза»: support — заявка +30 минут; он же подтверждает → 409 `SELF_APPROVAL`; finance — подтверждение → +30,
    аудит обоих, `minutes_adjusted`.
12. Контроль ИИ: ручной `paid_only` (TOTP) → B: перевод по тапу `unavailable degraded`; A: урок `full`; событие и аудит;
    возврат в `auto`.
13. Возвраты: тилы Click → reversal (мок) → тилы обратной записью; подписка Stars → `refundStarPayment` и
    `editUserStarSubscription is_canceled true` (мок получил оба), период `revoked`, `refund_completed`; заказ Payme →
    `awaiting_provider` → `CancelTransaction` (state 2, reason 5) → `refunded`.
14. Сверка: мок `getStarTransactions` с лишней транзакцией → `stars_unmatched`; Click Prepare без Complete + сдвиг на 2 ч
    → `stale_created`; разбор с заметкой и аудитом.
15. Удаление A: живая подписка Stars отменена через мок до удаления; минуты, периоды, удержания удалены; заказы,
    транзакции, подписки Stars обезличены; ACK `billing`; Payme `CreateTransaction` по отменённому заказу — -31050.
16. Отдельный прогон с выключенными флагами: `STARS_ENABLED=false` → `pre_checkout_query` `ok: false`;
    `PAYMENTS_ENABLED=false` → заказ 409, Payme -32504; `WEB_PAY_ENABLED=false` → `/web/v1/*` 404;
    `BILLING_ENFORCED=false` → урок `full` без обращения к billing.
