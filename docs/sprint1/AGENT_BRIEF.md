# Бриф исполнителя спринта 1 (общий для всех)

Репозиторий: `/home/claude/tilhero` (git, ветка `sprint/0-1-foundation`, база — форк фундамента aievent, закоммичена). Стенд уже запущен: PostgreSQL 127.0.0.1:5432 (суперпользователь `postgres` без пароля, БД `tilhero_test`), Redis 127.0.0.1:6379, NATS 127.0.0.1:4222 (JetStream). Если упал: `bash infra/dev/stack.sh up`. Переменные тестов: `source .dev/testenv.sh`.

## Прочитать перед началом
1. `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md` (обязательные правила, особенно §8 «Дети и подростки»), `docs/SPRINTS.md` (спринт 1).
2. `docs/sprint1/PLAN.md` — состав, приёмочные тесты AT-01…15, правила напоминаний.
3. `docs/sprint1/INTERNAL_API.md` — внутренние контракты (единственный источник путей, полей, кодов ошибок). `packages/contracts/src/bff.ts` — публичный контракт BFF ↔ Mini App. `packages/contracts/events/*.schema.json` — схемы событий (генератор `infra/scripts/gen_event_schemas.py`). `packages/contracts/release-notes.json` — каталог «Что нового».
4. Эталонный сервис — `services/audit/`: settings, models, schemas, domain, api, consumers, main (`build_app(settings, runtime)` для тестов), alembic.ini + migrations (первая миграция вызывает `create_messaging_tables(op)`), Dockerfile (по образцу `infra/docker/python.Dockerfile`), README, tests (временная схема + `migrate()` + `InMemoryBus` + `internal_headers()`).
5. Каркас `packages/py-common/src/tilhero_common/` (Runtime, create_app, InternalAuth/Principal, emit/outbox, add_consumer/inbox, ServiceClient, IdempotencyStore, AttemptLimiter, rate_limit, testing.assert_event_conforms) и `packages/ts-common/src/` для Node.
6. Исходник форка — `/home/claude/aievent` (тот же код до переименования, с историей спринтов и `docs/qa/*`): проверенные решения бери оттуда, но удаляй всё, что относится к туризму (события, офферы, ссылки, AI-консьерж, watch, news и т. п.).
7. Согласованный прототип — Claude Design canvas в `/home/claude/lf/project/`: `Main.dc.html` (Mini App), `Admin.dc.html` (админка), `ScreensGame.dc.html`, `ScreensPractice.dc.html`, `Decisions.dc.html`, `Competitors.dc.html`. Герои — `/home/claude/heroes/cut/*.webp` (карта — `/home/claude/heroes/assets.json`).

## Правила работы
- Меняй только свои каталоги (указаны в задаче). `packages/*`, корневые `pyproject.toml` / `package.json` / `uv.lock` / `package-lock.json`, `infra/*`, `.github/*`, `docs/*` (кроме README своего сервиса) НЕ трогай. Нужно изменение общего кода, зависимость, новое событие или поле контракта — опиши в отчёте (раздел «Запросы к общему коду»), у себя сделай минимальный обход.
- Зависимости уже установлены (`uv sync --all-packages`, `npm install`). Не запускай `uv add` / `uv lock` / `npm install <pkg>`.
- Правила: UUID для ID; `user_id` только из токена; аудит изменяющих команд (`admin.audit.recorded.v1` не нужен — пишет только админ-контур; пользовательские изменения — доменные события); пагинация списков (`Page<T>`); версия в пути (`/internal/v1`, `/v1`); PII в логах и тестовых выводах — только маской; `Idempotency-Key` для создающих команд; ошибки — `ErrorBody {code, message, trace_id}`.
- Дети и подростки (CONVENTIONS §8): возраст хранит только identity-consent; другие сервисы получают `is_minor` / `age_band` из событий или `DeliveryInfo`; детям 6–13 — без давления («потеряешь серию», «провал» запрещены), адресат сообщений — родитель, окно 08:00–20:00; игра и монеты не влияют на оценки.
- Тексты для пользователя — по-русски и по-узбекски (латиница) там, где контракт требует RU/UZ; сообщения ошибок API — по-русски. Код и комментарии — по-английски допустимо.
- Тесты на реальном стенде: `uv run pytest <твой каталог> -q -p no:cacheprovider`, линт `uv run ruff check <каталог>`, типы `uv run mypy <каталог>/src`. Для TS: `npx vitest run`, `npx tsc -p tsconfig.json --noEmit` в каталоге пакета.
- Минимум тестов на эндпоинт: happy path, 401 без токена / с неверным, 403 чужой вызывающий, 404, 422, идемпотентность, изоляция пользователей (чужой ресурс → 404). Для событий — `assert_event_conforms` и дедупликация потребителя. Для расписаний — повторный вызов не дублирует события.
- Перед сдачей пройди чек-лист внутреннего QA (IDOR, AuthZ, PII в логах и ответах, replay / idempotency, часовые пояса и переход через полночь, граничные значения) и исправь найденное.
- Не коммить и не пушить. Итоговый отчёт (кратко, по-русски): что сделано; эндпоинты; события (выпускает / потребляет); таблицы и миграции; результаты тестов цифрами (pytest / vitest, ruff, mypy / tsc); отклонения от контракта с причиной; «Запросы к общему коду».
