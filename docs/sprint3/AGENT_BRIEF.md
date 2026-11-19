# Бриф исполнителя спринта 3 (общий для всех)

Репозиторий: `/home/claude/tilhero`, ветка `sprint/3-content` (не переключай ветки, не коммить — коммитит координатор). Стенд: PostgreSQL 127.0.0.1:5432 (`postgres` без пароля, БД `tilhero_test`), Redis 127.0.0.1:6379, NATS 127.0.0.1:4222. Если упал: `bash infra/dev/stack.sh up`; переменные тестов: `source .dev/testenv.sh`.

## Прочитать перед началом
1. `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md` (особенно §8 «Дети и подростки»), `docs/sprint3/PLAN.md`, `docs/sprint3/INTERNAL_API.md`.
2. Контракты: `packages/contracts/src/content.ts` (форматы контента — источник истины), `bff.ts` (раздел «Спринт 3»), `admin.ts` (раздел «Контент и диагностика»), схемы событий `packages/contracts/events/*.schema.json` (новые: catalog.*, diagnostics.*, skills.*, learning.trajectory.*).
3. Принятые решения прошлых спринтов: `docs/sprint1/INTERNAL_API.md` §10–11, `docs/sprint2/INTERNAL_API.md`, отчёты `docs/qa/sprint2-*`.
4. Эталоны TilHero: Python-сервис — `services/experience-config/` (версии, публикация, staff API с actor) и `services/audit/`; Node — `services/admin-bff/`, `services/telegram-bff/`; фронтенд — `apps/admin-web/`, `apps/telegram-miniapp/`.
5. Исходники требований LinguaFlow 1.2: `/home/claude/in/zip/LinguaFlow_Handoff_1.2/` (`docs/requirements.json`, `skills/01_diagnostic.md`, `02_curriculum_planner.md`, `15_media_lesson_designer.md`, `source_specs/05_multilanguage_media_requirements.md`).

## Правила работы
- Меняй только свои каталоги (указаны в задаче). `packages/*`, корневые `pyproject.toml`/`package.json`/`uv.lock`/`package-lock.json`, `infra/*`, `.github/*` НЕ трогай (новые пакеты зарегистрированы координатором). Нужно изменение общего кода, контракта, зависимости — опиши в отчёте («Запросы к общему коду»), у себя — минимальный обход.
- Зависимости установлены; не запускай `uv add`/`uv lock`/`npm install <pkg>`.
- Правила: UUID для сущностей учеников; `user_id`/`staff_id` только из токена; права проверяются в домене по actor (защита в глубину); аудит каждой привилегированной команды; пагинация; ErrorBody; Idempotency-Key для создающих команд; события — outbox в той же транзакции; consumers — inbox с дедупликацией.
- Дети 6–13: контент только с audience kids, без внешних ссылок, без давления и сравнения; заявки на песни/фильмы — только аккаунты.
- **Права на медиа:** ничего не скачивается, не парсится и не открывается по ссылке ученика; полные тексты песен и сцен из памяти не генерируются (ни в коде, ни в сиде).
- PII и секреты — никогда в логах, событиях, ответах (кроме контракта).
- Тесты на стенде: Python — `uv run pytest <каталог> -q -p no:cacheprovider`, `uv run ruff check <каталог>`, `uv run mypy <каталог>/src`; TS — `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`; фронт — ещё `npx playwright test`, `npm run build`.
- Минимум тестов на эндпоинт: happy path, 401, 403 (чужой вызывающий и нет права), 404, 422, 409 (переходы статусов), идемпотентность, изоляция учеников. События — `assert_event_conforms`.
- Перед сдачей — внутренний QA-чек-лист (IDOR, AuthZ, переходы статусов, неизменяемость опубликованного, PII, граничные значения, дети) и исправление найденного.
- Итоговый отчёт (кратко, по-русски): что сделано; эндпоинты; события; таблицы и миграции; тесты цифрами; отклонения от контракта; «Запросы к общему коду».
