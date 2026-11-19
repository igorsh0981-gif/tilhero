# Бриф исполнителя спринта 4 (общий для всех)

Репозиторий: `/home/claude/tilhero`, ветка `sprint/4-lessons` (не переключай ветки, не коммить — коммитит координатор). Стенд: PostgreSQL 127.0.0.1:5432 (`postgres` без пароля, БД `tilhero_test`), Redis 127.0.0.1:6379, NATS 127.0.0.1:4222. Если упал: `bash infra/dev/stack.sh up`; переменные тестов: `source .dev/testenv.sh`.

## Прочитать перед началом
1. `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md` (особенно §8 «Дети и подростки»), `docs/sprint4/PLAN.md` (решения владельца!), `docs/sprint4/INTERNAL_API.md`.
2. Контракты: `packages/contracts/src/ai.ts` (агенты, вызов, контексты и выводы — источник истины), `bff.ts` (раздел «Спринт 4»), `admin.ts` (раздел «ИИ, контроль диалогов, затраты»), `content.ts` (форматы уроков, сценариев, рубрик, медиа — спринт 3), схемы событий `packages/contracts/events/*.schema.json` (новые: lesson.*, assessment.*).
3. Принятые решения прошлых спринтов: `docs/sprint3/INTERNAL_API.md` (включая «Уточнения реализации» и «Решения по независимому ревью»), `docs/sprint2/INTERNAL_API.md`, отчёты `docs/qa/sprint3-*`.
4. Эталоны TilHero: Python-сервис с версиями и публикацией — `services/catalog/` (жизненный цикл, неизменяемость, advisory-блокировки, аудит через outbox), сессии и воспроизводимость — `services/diagnostics/`; Node — `services/admin-bff/`, `services/telegram-bff/`; фронтенд — `apps/admin-web/` (раздел `screens/content/`), `apps/telegram-miniapp/` (`screens/diagnostics/`, `screens/practice/`).
5. Исходники LinguaFlow 1.2: `/home/claude/in/zip/LinguaFlow_Handoff_1.2/` — `skills/00_orchestrator.md`, `03_teaching_coach.md`, `04_conversation_partner.md`, `05_independent_evaluator.md`, `06_error_analyst.md`, `10_safety_quality_gate.md`, `docs/04_Архитектура_и_агенты.md` §3–4, `docs/03_…админка.md` (ADM-AGENT, ADM-QA, ADM-MONEY), `docs/requirements.json` (APP-LESS, APP-COACH, APP-VOICE-03, APP-MEDIA-02).

## Правила работы
- Меняй только свои каталоги (указаны в задаче). `packages/*`, корневые `pyproject.toml`/`package.json`/`uv.lock`/`package-lock.json`, `infra/*`, `.github/*` НЕ трогай (новые пакеты зарегистрированы координатором). Нужно изменение общего кода, контракта, зависимости — опиши в отчёте («Запросы к общему коду»), у себя — минимальный обход.
- Зависимости установлены; не запускай `uv add`/`uv lock`/`npm install <pkg>`. HTTP к провайдеру ИИ — через `httpx` (уже есть), SDK провайдера не ставим.
- **Ключ провайдера ИИ** — только переменная `ANTHROPIC_API_KEY` у ai-gateway: не в БД, не в логах, не в ответах, не в тестах; в тестах и на стенде — `AI_PROVIDER=fake`. Настоящий провайдер в тестах не вызывается (сеть к api.anthropic.com из стенда закрыта).
- **ИИ необязателен:** любой путь ученика проходит при `unavailable`/`refused` от ai-gateway (выбор реплик, оценка закрытых заданий). Ошибки провайдера ученику не показываются.
- **Дети 6–13:** свободный текст в ИИ не отправляется (ai-gateway отклоняет, lessons и BFF не предлагают ввод); только детские материалы; без давления и сравнения; апелляции и уведомления — по правилам спринта 1.
- **Независимость оценки:** оценщик не доверяет правильности от lessons и словам коуча; ключи — только из опубликованной версии catalog; генерирующий агент не меняет баллы и навыки.
- Правила: UUID для сущностей учеников; `user_id`/`staff_id` только из токена; права проверяются в домене по actor (защита в глубину); аудит каждой привилегированной команды; пагинация; ErrorBody; Idempotency-Key для создающих команд; события — outbox в той же транзакции; consumers — inbox с дедупликацией и проверкой издателя.
- Тексты учеников (реплики, открытые ответы, причины апелляций) и PII — никогда в логах, событиях, метриках, ответах (кроме контракта); в ai-gateway — только метаданные вызова.
- Тесты на стенде: Python — `uv run pytest <каталог> -q -p no:cacheprovider`, `uv run ruff check <каталог>`, `uv run mypy <каталог>/src`; TS — `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`; фронт — ещё `npx playwright test`, `npm run build`.
- Минимум тестов на эндпоинт: happy path, 401, 403 (чужой вызывающий и нет права), 404, 422, 409 (переходы статусов), идемпотентность, изоляция учеников. События — `assert_event_conforms`. Для ИИ — сценарии `ok`, `unavailable` (выключен, бюджет, таймаут, неверный JSON), `refused` (дети).
- Перед сдачей — внутренний QA-чек-лист (IDOR, AuthZ, переходы статусов, неизменяемость, PII и тексты, граничные значения, дети, ИИ выключен, повторная отправка) и исправление найденного.
- Итоговый отчёт (кратко, по-русски): что сделано; эндпоинты; события; таблицы и миграции; тесты цифрами; отклонения от контракта; «Запросы к общему коду».
