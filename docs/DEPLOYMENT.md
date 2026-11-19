# Деплой TilHero на Railway

## Prod (развёрнут 18.11.2026)
Проект Railway **TilHero**, окружение `production`, регион `europe-west4` (ближе к Узбекистану и серверам Telegram).
- Mini App: https://telegram-miniapp-production-c38e67a1.up.railway.app — зарегистрирован в @BotFather `/newapp` с short name `TilHero`.
- BFF: https://telegram-bff-production-76baa800.up.railway.app; webhook бота: https://telegram-bot-gateway-production-c5712e9c.up.railway.app/telegram/webhook.
- Бот: @TilHero_bot; ссылки `https://t.me/TilHero_bot/TilHero?startapp=…` (`TELEGRAM_APP_LINK` у social, telegram-bff, telegram-bot-gateway).
- `BOT_TOKEN` — общая переменная проекта (Project Settings → Shared Variables), её вводит владелец; сервисы ссылаются `${{shared.BOT_TOKEN}}`.
- Админка (спринт 2, 18.11.2026): https://admin-web-production-24a8d0dd.up.railway.app — admin-web (Caddy) проксирует `/admin/v1/*` на admin-bff по приватной сети; admin-bff, admin-identity, user-admin публичных доменов не имеют. Первый super_admin создан из `ADMIN_BOOTSTRAP_EMAIL/ADMIN_BOOTSTRAP_PASSWORD` (временный пароль действует 72 ч, при первом входе — смена пароля и подключение TOTP); после первого входа переменные удаляются. Тестовые чаты для тестовой отправки — `ADMIN_TEST_CHAT_IDS` у notifications (пусто — тест недоступен).
- Спринт 2 добавил издателей внутреннего JWT admin-identity и user-admin и заменил ключ admin-bff: `INTERNAL_JWT_PUBLIC_KEYS` обновлён у всех сервисов; пароли ролей `admin_identity`, `user_admin` (и `_owner`) заданы разовым `db-bootstrap`.
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
- Админка: вход сотрудника, обзор (4 блока с данными), карточка ученика, проверка цепочки аудита. Новые сервисы добавляются по `services.md` из `setup.py`; при добавлении издателя внутреннего JWT — новый `INTERNAL_JWT_PUBLIC_KEYS` у всех сервисов до запуска нового издателя.
- Проекции активности для сегментов рассылок (identity-consent, user-admin) наполняются событиями из NATS (хранение 7 дней): учеников, чья активность старше 7 дней на момент выкладки новой проекции, дозаполнить отдельно (ревью P2-5).

## 3. Секреты и ключи
- Ротация ключа внутреннего JWT сервиса: новый запуск `setup.py` в пустой каталог и замена `INTERNAL_JWT_PRIVATE_KEY` у сервиса и `INTERNAL_JWT_PUBLIC_KEYS` у всех (сначала открытые ключи, потом закрытый).
- `SCHEDULER_TOKEN` — одинаковый у n8n, learning-plan, notifications, social, catalog (не короче 32 символов).
- `TELEGRAM_APP_LINK` — одинаковый у social, telegram-bff, telegram-bot-gateway.

## 4. Выкладка спринта 3 поверх спринта 2 (контент и диагностика)
Новые сервисы `catalog` (8110) и `diagnostics` (8111) — без публичных доменов. Разовый генератор `.dev/sprint3_extend.py` (вне git) берёт действующие секреты и открытые ключи и пишет в `.dev/railway-prod-s3/`: `catalog.env`, `diagnostics.env`, `db-passwords.sql`, `public-keys.json`, `updates.json` (что выставить существующим сервисам).
1. **База:** `bootstrap.sql` (идемпотентен — добавит схемы и роли `catalog`, `diagnostics` и `_owner`), затем `db-passwords.sql` из `railway-prod-s3` — разовым `db-bootstrap`, как в спринте 2.
2. **Открытые ключи:** `INTERNAL_JWT_PUBLIC_KEYS` (с ключами catalog и diagnostics) — у всех сервисов из `updates.json` **до** запуска новых издателей.
3. **catalog → diagnostics:** создать сервисы (Dockerfile `services/<svc>/Dockerfile`, Pre-Deploy `alembic upgrade head` — миграции загружают сид курса, сценариев, медиа и тестов диагностики как опубликованную v1). Проверка: `/health/ready`, в логе нет ошибок сида.
4. **Адреса:** `CATALOG_URL` — learning-plan, diagnostics, telegram-bff, admin-bff, n8n; `DIAGNOSTICS_URL` — telegram-bff, admin-bff (оба BFF без них в prod не стартуют). `SCHEDULER_TOKEN` у catalog — тот же, что у n8n. Затем выкладка learning-plan, notifications, experience-config, audit, admin-identity (миграция 0003: права контента, роль content_manager — **сессии методистов отзываются, при входе нужен TOTP**), BFF, Mini App, admin-web.
5. **n8n:** импорт `infra/n8n/workflows/catalog-tick.json` (каждый час в :05 — истечение прав медиа), включить.
6. **Проверка:** Mini App — «Мои языки», диагностика целиком, результат, план, карта навыков, практика (сценарии, медиа), заявка на песню; админка — раздел «Контент» (урок, сценарий, медиа, проверка), «Языки и курсы», обзор с блоками «Контент» и «Диагностика».
- Сага удаления: identity-consent ждёт подтверждения и от catalog, diagnostics — запросы на удаление, пришедшие до их запуска, догоняются из NATS (хранение 7 дней).
- Детские профили старше 7 дней не попадут в проекцию профилей diagnostics и learning-plan; детский сегмент для них держится на параметре `audience` и claims от telegram-bff (BFF всегда вычисляет kids для детского профиля).

