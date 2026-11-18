# Деплой TilHero на Railway

## Prod (развёрнут 18.11.2026)
Проект Railway **TilHero**, окружение `production`, регион `europe-west4` (ближе к Узбекистану и серверам Telegram).
- Mini App: https://telegram-miniapp-production-c38e67a1.up.railway.app — зарегистрирован в @BotFather `/newapp` с short name `TilHero`.
- BFF: https://telegram-bff-production-76baa800.up.railway.app; webhook бота: https://telegram-bot-gateway-production-c5712e9c.up.railway.app/telegram/webhook.
- Бот: @TilHero_bot; ссылки `https://t.me/TilHero_bot/TilHero?startapp=…` (`TELEGRAM_APP_LINK` у social, telegram-bff, telegram-bot-gateway).
- `BOT_TOKEN` — общая переменная проекта (Project Settings → Shared Variables), её вводит владелец; сервисы ссылаются `${{shared.BOT_TOKEN}}`.
- Роли и схемы БД созданы разовым сервисом `db-bootstrap` (образ `postgres:18-alpine`, `psql` с `infra/db/bootstrap.sql` и паролями из `setup.py`); после `BOOTSTRAP_OK` в логе сервис удаляется вместе с переменными.

Одна среда Railway = один проект: `stage` и `prod` — разные проекты с одинаковым набором сервисов. Код приходит из GitHub (`igorsh0981-gif/tilhero`), ветка `main` — только через PR с зелёным CI.

## 1. Подготовка (один раз на среду)
1. В @BotFather: бот (токен) и Mini App с short name (ссылка `t.me/<bot>/<app>`).
2. Сгенерировать переменные (секреты остаются только в файлах `.dev/`, в git не попадают):
   ```bash
   uv run python infra/railway/setup.py --out .dev/railway-prod --env prod --bot-username TilHero_bot --app-name TilHero
   ```
   В каталоге: `<service>.env` для каждого сервиса, `db-passwords.sql`, `services.md` (Dockerfile, публичный домен, Pre-Deploy Command, healthcheck).
3. Railway: создать Postgres и Redis (шаблоны), `nats` (образ `nats:2.11-alpine`, команда `-js -sd /data`, том `/data`).
4. База: `psql "$DATABASE_PUBLIC_URL" -v ON_ERROR_STOP=1 -f infra/db/bootstrap.sql`, затем `-f .dev/railway-prod/db-passwords.sql`.
5. Сервисы по таблице `services.md`: источник — GitHub, `RAILWAY_DOCKERFILE_PATH` — путь к Dockerfile, корень сборки — корень репозитория; переменные — содержимое `<service>.env` (Raw Editor); `BOT_TOKEN` вписать вручную в telegram-bot-gateway и telegram-bff; Mini App — build arg `VITE_BFF_URL`.
6. Порядок первого запуска: identity-consent → остальные Python-сервисы (social — после identity-consent) → telegram-bff → telegram-miniapp → telegram-bot-gateway (`BOT_AUTO_SETUP=true` регистрирует webhook и кнопку меню) → n8n (расписания включаются, когда заданы адреса сервисов).

## 2. Каждый релиз
- Merge PR в `main` → Railway пересобирает изменённые сервисы; Pre-Deploy Command применяет миграции под ролью `<svc>_owner`, сервис работает под ролью `<svc>` без DDL.
- Проверка после выкладки: `/health/ready` каждого сервиса, вход в Mini App, «Что нового», напоминание тестовому ученику (n8n `plan-tick`), центр уведомлений.

## 3. Секреты и ключи
- Ротация ключа внутреннего JWT сервиса: новый запуск `setup.py` в пустой каталог и замена `INTERNAL_JWT_PRIVATE_KEY` у сервиса и `INTERNAL_JWT_PUBLIC_KEYS` у всех (сначала открытые ключи, потом закрытый).
- `SCHEDULER_TOKEN` — одинаковый у n8n, learning-plan, notifications, social (не короче 32 символов).
- `TELEGRAM_APP_LINK` — одинаковый у social, telegram-bff, telegram-bot-gateway.
