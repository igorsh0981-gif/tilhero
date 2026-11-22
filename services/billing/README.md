# billing (8118, схема `billing`, пакет `tilhero_billing`)

**Спринт 8 — деньги и контроль ИИ.** Каталог тарифов и товаров с версиями (цены сайта в сумах и цены Mini App в
Telegram Stars — отдельными полями), заказы по каналам, платёжный контур с адаптерами Telegram Stars / Payme / Click /
Uzum, фискальные данные сайта, периоды подписки и подписки Stars, реестр минут с удержаниями, возвраты, корректировки
«четыре глаза», сверка, отчёты и курсы. Деньги — отдельный bounded context: gamification и lessons денег не знают.

Контракты: `docs/sprint8/INTERNAL_API.md` §0–§1, §10–§13; решения — `docs/sprint8/PLAN.md`; деньги — целые числа
(`docs/adr/0001-money-integer-minor-units.md`); события — `packages/contracts/events/billing.*.schema.json`.

> Статус: **каркас потока 0** — настройки, health, клиенты соседей, alembic (роли `billing_owner` / `billing`),
> протокол адаптера `providers/base.py` и порт `domain/ports.py`. Миграцию 0001, домен, API, tick и README целиком
> пишет поток A; адаптеры — потоки B (Payme, Click, Uzum, `api/callbacks.py`) и G (Stars, `api/stars.py`).

## Каналы и провайдеры (§0.2)
| Канал (`chn`) | Откуда | Провайдеры | Цены |
|---|---|---|---|
| `miniapp` | telegram-bff `/v1/*` | только `telegram_stars` | только Stars |
| `web` | telegram-bff `/web/v1/*` (сайт оплаты) | только `payme`, `click`, `uzum` | только сумы (тийины) |
| `renewal` | billing сам (продление подписки Stars) | `telegram_stars` | цена первого платежа |

Пара «канал — провайдер» проверяется в billing (`providers/base.py` `CHANNEL_PROVIDERS`; иначе 422
`PROVIDER_NOT_ALLOWED`). Колбэки фиатных провайдеров — только через публичный `apps/payments-edge` с `X-Edge-Token`;
у billing публичного домена нет. Bot API — только через внутренний API telegram-bot-gateway: **токена бота у billing
нет**, Telegram ID в billing не попадает.

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
| `PAYME_MERCHANT_ID`, `PAYME_LOGIN` (`Paycom`), `PAYME_KEY`, `PAYME_CHECKOUT_URL`, `PAYME_ALLOWED_CIDRS`, `PAYME_SUBSCRIBE_URL`, `PAYME_SUBSCRIBE_KEY` | — | Payme (§1.6) |
| `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_MERCHANT_USER_ID`, `CLICK_SECRET_KEY`, `CLICK_PAY_URL`, `CLICK_API_URL`, `CLICK_ALLOWED_CIDRS` | — | Click (§1.7) |
| `UZUM_SERVICE_ID`, `UZUM_LOGIN`, `UZUM_PASSWORD`, `UZUM_ACCOUNT_FIELD` (`order_id`), `UZUM_CHECKOUT_URL_TEMPLATE`, `UZUM_ALLOWED_CIDRS` | — | Uzum (§1.8, за флагом до сверки) |

Ключи провайдеров вводит владелец в общие переменные проекта Railway (ссылка `${{shared.<ИМЯ>}}` — только у billing):
не в чат, не в репозиторий, не в БД, не в логи. В тестах — только заведомо тестовые строки.
