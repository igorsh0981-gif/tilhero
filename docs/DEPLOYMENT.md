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
- «Что нового» релиза (с 6.1, CONVENTIONS §10) публикует миграция experience-config при выкладке: experience-config — **последним**, после telegram-bff, telegram-miniapp и admin-web этого релиза (заметка показывается ученику один раз — до новой Mini App он увидел бы её без картинки и без кнопок в новые экраны). Снять заметку — админка «Что нового» → «В архив».
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

## 7. Выкладка спринта 5 поверх релиза 4.1 (память и повторения, чтение, произношение)
Новый сервис `memory` (8116, схема `memory`) — без публичного домена. Остальное — обновления существующих сервисов (автодеплой с main) с миграциями: catalog 0004–0005 (чтение, словарь курса, сид 12 текстов), ai-gateway 0004–0005 (`teaching_coach` v2, речь, подлимит), lessons 0002, assessment 0003, admin-identity 0005, identity-consent — политика 1.1.
```
uv run python infra/railway/extend.py --env-from .dev/railway-prod/learning-plan.env \
  --public-keys .dev/railway-prod-s4/public-keys.json --out .dev/railway-prod-s5 --only memory
```
Порядок важен (enum событий расширен, новые consumers memory читают историю стрима, сага удаления ждёт memory):
1. **База:** разовый `db-bootstrap` с `bootstrap.sql` из `railway-prod-s5` (схема и роли `memory`, `memory_owner`) → `BOOTSTRAP_OK` → удалить сервис.
2. **Открытые ключи:** `INTERNAL_JWT_PUBLIC_KEYS` из `updates.json` — всем существующим сервисам (catalog, assessment, ai-gateway, identity-consent должны принимать токены издателя `memory`).
3. **audit** (издатель `memory`) → **admin-identity** (права `memory.*`, `glossary.manage`) → **learning-plan**, **diagnostics**, **notifications** (новые consumers и шаблон `reviews_due`).
4. **catalog** → **assessment** → **ai-gateway** → **lessons**. Перед ai-gateway: если в prod есть черновик `teaching_coach` от сотрудника — миграция 0004 не создаст v2 (предупреждение в логе); удалить черновик и повторить деплой.
5. **memory:** сервис из `memory.env` (Dockerfile `services/memory/Dockerfile`, Pre-Deploy `alembic upgrade head`, healthcheck `/health/ready`, europe-west4, restart ON_FAILURE). Проверка: `/health/ready`; в логе consumers без повторяющихся ошибок.
6. **identity-consent** — после memory (новый домен саги `memory` и политика 1.1: при следующем входе каждый пользователь один раз подтверждает согласие).
7. **admin-bff** (`MEMORY_URL`) → **admin-web**; **telegram-bff** (`MEMORY_URL`) → **telegram-miniapp**.
8. **n8n:** `MEMORY_URL` → перезапуск: включается `memory-tick` (каждые 15 мин). Ручной прогон.
9. **Владелец:**
   - Azure Speech: ресурс Speech (регион, например `westeurope`), общие переменные проекта `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` (в чат и файлы не попадают) → Deploy ai-gateway. Без них «Произнести» скрыто.
   - «Агенты» → `teaching_coach` v2 → прогон золотых тестов на anthropic → публикация. До публикации перевод по тапу отвечает «перевод недоступен» (словарь курса работает).
   - Подлимит речи $5 в месяц — «Затраты ИИ → Лимиты» (по умолчанию уже 5).
10. **Проверка:** Mini App — урок → слова в «Словаре», «Повторение дня» (выбор, ввод, «Не помню», итоги), чтение с переводом по тапу и «в словарь», вопросы к тексту; «Произнести» (после ключа Azure; ребёнок — после согласия родителя в «Семье»); вечернее напоминание; админка — «Словарь курса» (очередь ИИ), «Контент → Чтение», «Память» ученика, «Аналитика забывания», затраты речи.

## 8. Выкладка релиза 5.1 (оценка произношения на своём сервере, политика 1.2)
Azure Speech не используется: запись распознаёт сервис `tts` (faster-whisper `base.en`, int8, CPU), сравнение со словами эталона и баллы — ai-gateway (провайдер `whisper`). Аудио не сохраняется нигде, расход $0. Новых сервисов нет; миграция ai-gateway 0006 (провайдер `whisper`, модель `whisper-base-en`).
1. **tts:** новый образ скачивает модель на этапе сборки — Hugging Face `Systran/faster-whisper-base.en`, коммит `3d3d5dee26484f91867d81cb899cfcf72b96be6c`. После первой сборки взять из лога строки `ASR_SHA256 not pinned …` и закрепить суммы следующим коммитом (build-arg `ASR_SHA256_*`). Переменные: `ASR_ENGINE=whisper` (по умолчанию), `ASR_CONCURRENCY=1`, `ASR_TIMEOUT_SECONDS=10`. Память — не меньше 1 ГБ (модель ≈ 150 МБ + Piper), CPU — 1–2 vCPU. `INTERNAL_JWT_PUBLIC_KEYS` tts должен содержать ключ издателя `ai-gateway`.
2. **ai-gateway:** `SPEECH_PROVIDER=whisper`, `TTS_URL=http://${{tts.RAILWAY_PRIVATE_DOMAIN}}:8115`; переменные `AZURE_SPEECH_*` удалить. Pre-Deploy `alembic upgrade head` (0006).
3. **identity-consent:** политика 1.2 (текст «запись распознаётся на серверах TilHero и сразу удаляется»). При следующем входе пользователь один раз подтверждает согласие; согласие на голос по политике 1.1 действует.
4. **admin-bff → admin-web:** «Агенты → Модели и цены» показывают «Свой сервер (Whisper)»; цена часа не редактируется.
5. **Проверка:** `GET /internal/v1/status` ai-gateway → `speech_available: true`; в Mini App «Произнести» в словаре и чтении → баллы по словам; время ответа ≤ 10 с; в логах tts нет текста и аудио. Нагрузку tts смотреть в Railway Metrics первые дни.

## 9. Выкладка спринта 6 поверх релиза 5.1 (игра и герои)
Новый сервис `gamification` (8117, схема `gamification`) — без публичного домена. Остальное — обновления существующих сервисов (автодеплой с main) с миграциями: learning-plan 0006 (`frozen_days`), notifications 0004 (категория `game`), admin-identity 0006 (права `game.*`, `wallet.adjust`), ai-gateway 0007 (`gameplay_director` → code).
```
uv run python infra/railway/extend.py --env-from .dev/railway-prod/learning-plan.env \
  --public-keys .dev/railway-prod-s5/public-keys.json --out .dev/railway-prod-s6 --only gamification
```
Порядок:
1. **База:** разовый `db-bootstrap` с `bootstrap.sql` из `railway-prod-s6` (схема и роли `gamification`, `gamification_owner`) → `BOOTSTRAP_OK`.
2. **Открытые ключи:** `INTERNAL_JWT_PUBLIC_KEYS` из `updates.json` — существующим сервисам (издатель `gamification`).
3. **audit** (издатель `gamification`) → **admin-identity** (права, роли) → **learning-plan**, **notifications** (consumers `game.*`), **identity-consent** (домен саги `gamification`) — автодеплой с main.
4. **gamification:** сервис из `gamification.env` (Dockerfile `services/gamification/Dockerfile`, Pre-Deploy `alembic upgrade head` — сид правил v1, 9 героев, 27 картинок, магазин, значки; healthcheck `/health/ready`, europe-west4, restart ON_FAILURE). Consumers читают стрим с начала (7 дней): прошлые уроки и повторения начисляются задним числом по дате события, уведомления о значках и росте героя по событиям старше 60 минут не отправляются. Бонус 2 заморозки получает каждый ученик при первом ходе (событие или первый запрос).
5. **telegram-bff**, **admin-bff**: `GAMIFICATION_URL=http://${{gamification.RAILWAY_PRIVATE_DOMAIN}}:8117` → **telegram-miniapp**, **admin-web**.
6. **n8n:** `GAMIFICATION_URL` → перезапуск: включается `game-tick` (каждые 15 мин).
7. **Проверка:** Mini App — главная (герой, уровень, тилы, заморозки, задания), выбор героя, магазин, история, значки, награды после урока; админка — «Герои», «Геймификация», «События и сезоны», блок «Игра» на главной; `game:tick` в n8n без ошибок; логи gamification без повторяющихся ошибок consumers.

## 10. Релиз 6.1 («Что нового» с иллюстрацией, автопубликация)
Ученики не узнали о релизах 5, 5.1 и 6: заметки «Что нового» публиковал вручную сотрудник. Релиз 6.1 добавляет иллюстрацию заметки и публикует заметку о спринтах 5–6 при выкладке. Новых сервисов и переменных нет. Миграции: experience-config **0006** (колонка `release_notes.illustration`, триггер неизменности дополнен ею) и **0007** (`s6-heroes` для 14+ и `s6-heroes-kids` для 6–13 — опубликованы, `published_by = system:release`, иллюстрация `s6-heroes`; приветствию `welcome-1` — иллюстрация `welcome`; черновик `2026.11` — в архив).
Порядок (автодеплой с main — у experience-config на время выкладки отключить автодеплой или выкладывать его вручную последним):
1. **Перед выкладкой:** в админке «Что нового» нет действующих заметок с метками `s6-heroes`, `s6-heroes-kids` (иначе миграция 0007 упадёт с `label is taken` — архивировать и повторить деплой).
2. **notifications** (кнопки рассылок: `heroes`, `shop`, `badges`, `game_history`, `game_settings`, `dictionary`, `reading`) → **telegram-bff**, **admin-bff** (поле `illustration`, новые маршруты).
3. **telegram-miniapp** (иллюстрации `public/whatsnew/*.webp`, заставка, переходы) → **admin-web** (выбор иллюстрации и предпросмотр; Docker-сборка копирует `apps/telegram-miniapp/public/whatsnew`, `Dockerfile.dockerignore` обновлён).
4. **experience-config** — последним: Pre-Deploy `alembic upgrade head` (0006, 0007). В одной транзакции: заметки, события `experience.release_note.published.v1` (notifications кладёт запись в центр уведомлений, категория `product`) и аудит `release_note.publish | update | archive` (`actor_type system`, `system:release`).
5. **Проверка:**
   - `SELECT slug, status, illustration, published_by FROM experience_config.release_notes ORDER BY seq` — `welcome-1` published `welcome`; `2026.11` archived; `s6-heroes`, `s6-heroes-kids` published `s6-heroes`, `system:release`; outbox experience-config без зависших событий;
   - админка «Что нового» — обе заметки «опубликована», в предпросмотре — картинка; «Аудит» — `release_note.publish` от `system:release`;
   - Mini App тестовым учеником, занимающимся до выкладки: при входе — «Что изменилось» с иллюстрацией, 6 карточек, «Подробнее» → выбор героя; детский профиль — версия на «ты»; повторный вход — заставки нет; новичок — знакомство с иллюстрацией `welcome`; центр уведомлений — запись «Что нового».
6. **Telegram-сообщение** о заметке нынешний notifications не отправляет (событие публикации → только центр уведомлений, `in_app_only`). Если нужно сообщение в Telegram — рассылка в админке «Рассылки» (кнопка «Выбор героя», сегмент 14–17 / 18+, детям рассылки не адресуются).
7. **Откат:** снять заметку — админка → «В архив» (ученики её больше не видят). Полный откат данных — `alembic downgrade 0006` в experience-config: удаляет обе заметки и их отметки просмотра, неотправленные события публикации, возвращает черновик `2026.11` и снимает иллюстрацию приветствия (уже ушедшие события и записи центра уведомлений остаются).


## 11. Выкладка спринта 7 поверх релиза 6.1 (социальное)
Новых сервисов нет. Миграции (Pre-Deploy `alembic upgrade head`): social **0002** (сообщество, друзья, блокировки, жалобы
и модерация, реферальные кампании и перенос рефералов спринта 6, реестр `member_id`), gamification **0002** (лиги, дуэли,
награды рефералов, дожитие pending спринта 6, проекции и `projection_loads`), lessons **0003** (наборы дуэлей, комнаты
уроков вдвоём), admin-identity **0007** (права `social.read`, `moderation.manage`, `referral.*`, `league.*`, `room.*`;
**support становится привилегированной**), ai-gateway **0008** (`cooperative_lesson_coach` — llm, черновик v1 с
golden-тестами, бюджет комнаты 0,10 $; `duel_host` → code; `referral_integrity_reviewer` → rules), identity-consent
**0005** и user-admin **0003** (категория уведомлений `game`), experience-config **0008** (меню админки 1.7.0 —
«Сообщество» после «Игры») и **0009** (заметки «Что нового» `s7-social` 14+ и `s7-social-kids` 6–13, иллюстрации
`s7-social` и `s7-family`).

**Переменные** (значения не в чат и не в репозиторий):
- `MEMBER_ID_KEY` — новый общий секрет ≥ 32 символов (`secrets.token_urlsafe(48)`), один на social, gamification и
  lessons: shared variable проекта и ссылка `${{shared.MEMBER_ID_KEY}}` в трёх сервисах. **Не менять после выкладки** —
  смена меняет все `member_id`. Без ключа social, gamification и lessons в prod не стартуют (и миграция social не идёт).
- gamification: `SOCIAL_URL` (:8109), `LESSONS_URL` (:8112), `DIAGNOSTICS_URL` (:8111), `IDENTITY_CONSENT_URL` (:8101).
- lessons: `SOCIAL_URL`, `IDENTITY_CONSENT_URL` (+ действующие `AI_GATEWAY_URL` и прочие).
- admin-bff: `SOCIAL_URL`.
- Новые callers в `infra/railway/setup.py` — открытые ключи JWT у всех уже есть (новых издателей нет).

Порядок:
1. **Перед мержем:** выставить переменные выше (автоперезапуск текущих деплоев безопасен — старый код их не читает);
   experience-config привязать к текущему коммиту main (`connect-service-source commitSha=<main>`), чтобы заметки
   «Что нового» опубликовались только после Mini App.
2. **Мерж → автодеплой** остальных сервисов. Зависимости разрешаются сами: начальная загрузка проекций gamification
   (семьи и дружбы — social, уровни — diagnostics, возраст и согласие — identity-consent) идёт в фоне и повторяется
   каждым `game:tick`, пока источники не ответят; learning-plan принимает `kind duel|pair` до первых уроков вдвоём.
3. **n8n** — перезапуск: `lessons-tick` теперь каждые 5 минут (обслуживание комнат).
4. **telegram-miniapp**, **admin-web** — по автодеплою; убедиться, что новая версия Mini App отдаётся
   (`/whatsnew/s7-social.webp`, `/whatsnew/s7-family.webp`).
5. **experience-config — последним:** снять привязку к коммиту (`connect-service-source` без `commitSha`) → 0008, 0009.
6. **Сотрудники support:** миграция admin-identity 0007 отзывает их сессии; при следующем входе — подключение TOTP.
   Предупредить заранее.
7. **Проверка:**
   - логи gamification: `projection bootstrap` без повторяющихся ошибок; `SELECT name, completed_at, items FROM
     gamification.projection_loads` — четыре строки (`families`, `friendships`, `levels`, `profiles`) завершены;
   - Mini App: профиль сообщества (ник, код друга), друзья и заявки, лиги (друзья, семья, общая 14+), дуэль, урок вдвоём,
     рефералы; детский профиль — только семья и выбор реплик; при входе — «Что изменилось» с иллюстрацией (детям —
     `s7-family`);
   - админка: «Сообщество» (друзья и жалобы, модерация, рефералы, лиги и дуэли, комнаты), права ролей, аудит;
   - ai-gateway: `cooperative_lesson_coach` v1 — черновик; до публикации владельцем комнаты идут по сценарию с выбором
     реплик.
8. **Откат:** код — предыдущий деплой сервиса; данные — `alembic downgrade` соответствующих миграций (social 0001,
   gamification 0001 — `expired` → `void` у рефералов спринта 6, lessons 0002, experience-config 0007 — снимает заметки
   спринта 7). `MEMBER_ID_KEY` не удалять: при повторной выкладке нужен тот же ключ.
