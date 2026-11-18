# Бриф исполнителя спринта 2 (общий для всех)

Репозиторий: `/home/claude/tilhero`, ветка `sprint/2-admin` (не переключай ветки, не коммить — коммитит координатор). Стенд: PostgreSQL 127.0.0.1:5432 (`postgres` без пароля, БД `tilhero_test`), Redis 127.0.0.1:6379, NATS 127.0.0.1:4222. Если упал: `bash infra/dev/stack.sh up`; переменные тестов: `source .dev/testenv.sh`.

## Прочитать перед началом
1. `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md` (особенно §8 «Дети и подростки»), `docs/sprint2/PLAN.md`, `docs/sprint2/INTERNAL_API.md`, `packages/contracts/src/admin.ts` (публичный контракт admin-bff ↔ admin-web), `packages/contracts/src/bff.ts` и `docs/sprint1/INTERNAL_API.md` (§10–11 — принятые уточнения).
2. Исходник форка — `/home/claude/aievent` (тот же каркас, пакет `aievent_*` → `tilhero_*`): `services/admin-identity`, `services/user-admin`, `services/admin-bff`, `apps/admin-web`, `packages/contracts/src/admin.ts`, `docs/sprint2/*` и `docs/qa/sprint2-*` (найденные там дефекты не переносить). Переносить — проверенные решения; туристическое (события, поездки, AI, источники, ленты новостей, мониторинг, биллинг) — удалять.
3. Эталонный Python-сервис TilHero — `services/audit/`; Node — `services/telegram-bff/`; фронтенд — `apps/telegram-miniapp/`.
4. Прототип админки TilHero — `/home/claude/lf/project/Admin.dc.html` (Claude Design canvas; тетрадная тема, тёмная боковая панель, разделы); токены админки — сид experience-config `services/experience-config/migrations/versions/0002_seed.py` (`admin` 1.0.0).

## Правила работы
- Меняй только свои каталоги (указаны в задаче). `packages/*`, корневые `pyproject.toml`/`package.json`/`uv.lock`/`package-lock.json`, `infra/*`, `.github/*` НЕ трогай (новые пакеты уже зарегистрированы координатором). Нужно изменение общего кода, контракта, зависимости — опиши в отчёте («Запросы к общему коду»), у себя — минимальный обход.
- Зависимости установлены; не запускай `uv add`/`uv lock`/`npm install <pkg>`.
- Правила: UUID для ID; `user_id`/`staff_id` только из токена или сессии; аудит каждой изменяющей привилегированной команды; пагинация; версия в пути; PII в логах и тестах — маской; Idempotency-Key для создающих команд; ErrorBody.
- Безопасность: пароли, коды, секреты, challenge, cookie — никогда в логах, аудите, событиях и ответах (кроме разовой выдачи по контракту); сравнение секретов за постоянное время; права проверяются на backend (и в admin-bff, и в домене).
- Тесты на стенде: Python — `uv run pytest <каталог> -q -p no:cacheprovider`, `uv run ruff check <каталог>`, `uv run mypy <каталог>/src`; TS — `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`; фронт — ещё `npx playwright test`.
- Минимум тестов на эндпоинт: happy path, 401, 403 (чужой вызывающий и нет права), 404, 422, идемпотентность, изоляция. События — `assert_event_conforms` и дедупликация.
- Перед сдачей — чек-лист внутреннего QA (IDOR, AuthZ, CSRF, PII, replay, перебор паролей и кодов, граничные значения) и исправление найденного.
- Тексты для сотрудников — RU (и EN в admin-web, как aievent); для учеников (шаблоны, рассылки) — RU и UZ.
- Итоговый отчёт (кратко, по-русски): что сделано; эндпоинты; события; таблицы и миграции; тесты цифрами; отклонения от контракта; «Запросы к общему коду».
