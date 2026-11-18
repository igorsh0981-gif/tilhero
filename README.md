# TilHero

Telegram Mini App для изучения иностранных языков с героем, который растёт вместе с навыками ученика, и веб-админка. Отдельного чат-бота нет: бот — только транспорт (кнопка Mini App, уведомления).

MVP: обучение через русский (RU → EN), интерфейс RU / UZ, возраст 6+ (дети 6–13 — профиль у родителя, подростки 14–17 — с согласием родителя).

## Документы
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — сервисы, потоки, данные.
- [docs/CONVENTIONS.md](docs/CONVENTIONS.md) — обязательные правила кода, API, событий, тестов, детей и подростков.
- [docs/SPRINTS.md](docs/SPRINTS.md) — план спринтов 0–9.
- [docs/sprint1/](docs/sprint1/) — план, внутренние контракты, бриф исполнителя спринта 1.
- Контракты: `packages/contracts/src/bff.ts` (Mini App ↔ BFF), `packages/contracts/events/*.schema.json` (события, генерирует `infra/scripts/gen_event_schemas.py`), `packages/contracts/release-notes.json` («Что нового»).

## Состав
| Каталог | Что это |
|---|---|
| `apps/telegram-miniapp` | Mini App (React 18, Vite, TS) |
| `apps/telegram-bot-gateway` | webhook бота, `/start` → кнопка Mini App, доставка сообщений |
| `services/telegram-bff` | BFF Mini App (Node 22, Fastify): сессия, активный ученик, маршруты `bff.ts` |
| `services/identity-consent` | аккаунт, ученики и дети, возраст, согласия, код родителя, удаление |
| `services/learning-plan` | цель, уровень, график (дни, время, длительность), занятия, напоминания и пропуски |
| `services/social` | приглашения по deep link, семья |
| `services/notifications` | шаблоны RU/UZ, категории, тихие часы, правила детей, центр уведомлений |
| `services/experience-config` | конфиг Mini App, «Что нового» |
| `services/support`, `services/audit` | обращения; журнал аудита |
| `packages/*` | общий код Python / TS, контракты, токены дизайна |
| `infra/*` | локальный стенд, bootstrap БД, Docker, n8n (расписания) |

## Локальный запуск
```bash
uv sync --all-packages && npm install
bash infra/dev/stack.sh up            # PostgreSQL 16, Redis, NATS JetStream
source .dev/testenv.sh
uv run pytest services/<сервис> -q    # тесты сервиса на стенде
uv run ruff check . && uv run mypy services/<сервис>/src
(cd services/telegram-bff && npx vitest run)
(cd apps/telegram-miniapp && npx vitest run && npx playwright test)
```

## Процесс
План и внутренние контракты спринта → исполнители по сервисам → независимое ревью → QA-отчёт (`docs/qa/`) → PR → деплой на Railway. Ветки — `sprint/<n>-<тема>`, в `main` — только через PR с зелёным CI.
