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
- `SCHEDULER_TOKEN` — одинаковый у n8n, learning-plan, notifications, social, catalog, lessons, assessment (не короче 32 символов; у lessons и assessment обязателен — от tick зависит стирание текстов учеников через 90 дней).
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


## 5. Выкладка спринта 4 поверх спринта 3 (урок 20 минут и независимая оценка)
Новые сервисы `ai-gateway` (8114), `assessment` (8113), `lessons` (8112) — без публичных доменов. Генератор дозаполнения теперь в git — `infra/railway/extend.py` (секретов в нём нет; `setup.py` для работающего prod не годится — он генерирует **все** секреты заново):
```
uv run python infra/railway/extend.py --env-from .dev/railway-prod/learning-plan.env \
  --public-keys .dev/railway-prod-s3/public-keys.json --out .dev/railway-prod-s4 --only lessons,assessment,ai-gateway
```
Выход в `.dev/railway-prod-s4/` (вне git): `<svc>.env` трёх сервисов, `bootstrap.sql` (bootstrap + пароли новых ролей), `db-passwords.sql`, `public-keys.json`, `updates.json` (что выставить существующим сервисам).
1. **База:** разовый `db-bootstrap` (образ `postgres:18-alpine`, `BOOTSTRAP_SQL` = `bootstrap.sql` из `railway-prod-s4`) — добавит схемы и роли `lessons`, `assessment`, `ai_gateway` и `_owner` с паролями. После `BOOTSTRAP_OK` в логе — удалить сервис.
2. **Ключ провайдера ИИ:** общая переменная проекта `ANTHROPIC_API_KEY` (Project Settings → Shared Variables; вводит владелец, в чат и файлы не попадает). Ссылка `${{shared.ANTHROPIC_API_KEY}}` есть только у ai-gateway. Без ключа уроки идут без ИИ (выбор реплик, оценка по правилам).
3. **Открытые ключи:** `INTERNAL_JWT_PUBLIC_KEYS` из `updates.json` — **всем** существующим сервисам, дождаться перезапуска до старта новых издателей.
4. **Потребители и вызываемые (до новых сервисов):** **audit** — обязательно раньше новых издателей: запись аудита от неизвестного издателя подтверждается и теряется (R3-02); **catalog** (версии с ключами, упражнения медиа — без него не стартует ни одно занятие), **learning-plan** (миграции 0004, 0005), **diagnostics** (0003), **notifications** (шаблон `appeal_decided`).
5. **Новые сервисы:** `ai-gateway` → `assessment` → `lessons` (Dockerfile `services/<svc>/Dockerfile`, Pre-Deploy `alembic upgrade head`, healthcheck `/health/ready`, регион europe-west4, restart ON_FAILURE). ai-gateway: миграции загружают 17 агентов, золотые кейсы и версии; `AI_PROVIDER=anthropic` (fake в prod запрещён). assessment и lessons: `SCHEDULER_TOKEN` обязателен в prod; lessons — `USER_REF_SECRET`. Проверка: `/health/ready` каждого, в админке «Агенты» → провайдер «ключ задан».
6. **identity-consent** (новые домены саги удаления) — **после** шага 5: запросы на удаление, созданные раньше, новых доменов не ждут.
7. **admin-identity** (миграция 0004: права ai.*, qa.*, costs.*, роль qa_analyst; сессии отзываются только у ролей, ставших привилегированными) → **admin-bff** (`AI_GATEWAY_URL`, `LESSONS_URL`, `ASSESSMENT_URL` — без них в prod не стартует) → **admin-web**.
8. **telegram-bff** (`LESSONS_URL`, `ASSESSMENT_URL`; `LESSONS_TIMEOUT_MS=25000`, `LESSONS_FINISH_TIMEOUT_MS=45000` — значения по умолчанию) → **telegram-miniapp**.
9. **n8n:** `LESSONS_URL`, `ASSESSMENT_URL` → перезапуск: entrypoint импортирует и включает `lessons-tick` (каждые 15 мин) и `assessment-tick` (03:35 UTC). Ручной прогон обоих.
10. **Включение ИИ после проверки инструкций на реальной модели:** версии агентов v1/v2 опубликованы миграциями без прогона на anthropic. Сразу после выкладки в админке «Агенты» — запустить золотые тесты `teaching_coach`, `conversation_partner`, `independent_evaluator` (≈ $0,3–0,5 из месячного потолка; аварийная остановка их не блокирует). Если обязательный кейс провален — «Затраты» → аварийная остановка до исправления версии.
11. **Проверка:** Mini App — урок целиком (без ИИ и с ИИ), «Объясни проще», разговор с персонажем, итоги, «повторить» в плане, карта навыков, апелляция → решение → уведомление в Telegram; админка — «Агенты», «Контроль диалогов» (реплики с причиной → запись `qa.transcript_viewed` в аудите), «Затраты», обзор с блоками «Уроки» и «ИИ».
- Порог бюджета: потолок $20 в месяц, $0,05 на ученика в день, $0,03 на урок — правятся в «Затратах» (step-up). Лимит в Anthropic Console владелец ставит отдельно.

## 6. Выкладка релиза 4.1 (серверная озвучка)
Новый сервис `tts` (8115) — без публичного домена, без БД и шины, только Redis-кеш MP3. Голоса Piper скачиваются при сборке образа (≈ 160 МБ моделей, ОЗУ ≈ 0,5 ГБ).
```
uv run python infra/railway/extend.py --env-from .dev/railway-prod/learning-plan.env \
  --public-keys .dev/railway-prod-s4/public-keys.json --out .dev/railway-prod-s41 --only tts
```
1. **tts:** создать сервис из `tts.env` (Dockerfile `services/tts/Dockerfile`, без Pre-Deploy, healthcheck `/health/ready`, регион europe-west4, restart ON_FAILURE). Открытые ключи остальных сервисов не меняются: tts только проверяет токены telegram-bff (`VERIFY_ONLY`). Проверка: `/health/ready`; в логе `voice loaded` для двух голосов.
2. **telegram-bff:** `TTS_URL` из `updates.json`. Без него `POST /v1/speech` отвечает 503, Mini App откатывается на синтез устройства — поэтому порядок 1 → 2 не критичен.
3. **telegram-miniapp** — тот же коммит.
4. **Проверка на телефонах (Android и iOS в Telegram):**
   - тест на уровень, задание на аудирование: звук на полной громкости, прослушивание списывается только при реальном воспроизведении;
   - урок → разговор → «Прослушать»;
   - медиа без файла.
