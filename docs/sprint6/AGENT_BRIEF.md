# Бриф исполнителя спринта 6 (общий для всех)

Репозиторий: `/home/claude/tilhero`, ветка `sprint/6-game`. Не переключай ветки и не коммить — коммитит координатор.

Стенд:
- PostgreSQL 127.0.0.1:5432 (`postgres` без пароля, БД `tilhero_test`), Redis 127.0.0.1:6379, NATS 127.0.0.1:4222;
- если стенд упал: `bash infra/dev/stack.sh up`;
- переменные тестов: `source .dev/testenv.sh`.

## Прочитать перед началом
1. `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md` (особенно §8 «Дети и подростки»), `docs/sprint6/PLAN.md` (решения владельца!), `docs/sprint6/INTERNAL_API.md` — главный документ спринта.
2. Контракты — источник истины:
   - `packages/contracts/src/bff.ts`:
     - раздел «Спринт 6» — `GameSummary`, `MyHero`, `HeroView`, `DailyQuests`, `BadgeView`, `ShopItemView`, `PurchaseResult`, `GameOperation`, `SessionRewards`, `GameSettings`;
     - `TodayPlan.week[].frozen`;
   - `admin.ts` — раздел «Игра и герои», права `game.*` и `wallet.adjust`, `Dashboard.game`;
   - схемы событий `packages/contracts/events/game.*.schema.json`, `learning.activity.recorded.v1` (`streak_days`);
   - лимиты `packages/contracts/rate-limit-policies.json`: `tg.game.*`.
3. Принятые решения прошлых спринтов: `docs/sprint5/INTERNAL_API.md`, `docs/sprint4/INTERNAL_API.md` (§9, §9.1), отчёты `docs/qa/sprint5-qa-report.md`, `docs/qa/sprint4-qa-report.md`.
4. Эталоны TilHero:
   - реестр без изменений задним числом, триггеры, сага — `services/memory/` (`review_log`), `services/assessment/`;
   - версии с черновиком, проверкой, активацией и откатом — `services/experience-config/`, `services/ai-gateway/` (версии агентов);
   - consumers, tick, outbox и аудит — `services/memory/`, `services/lessons/`;
   - загрузка бинарных файлов — `services/catalog/` (аудио), `services/tts/`;
   - Node — `services/telegram-bff/` (`routes/memory.ts`), `services/admin-bff/` (`routes/memory.ts`, `contractAi.ts` — строгие кодеки);
   - фронтенд — `apps/telegram-miniapp/` (`screens/home/`, `screens/memory/`, `ui/kit.tsx` — герои), `apps/admin-web/` (`screens/memory/`, `screens/ai/`).
5. Исходники LinguaFlow 1.2 (`/home/claude/in/zip/LinguaFlow_Handoff_1.2/`):
   - `skills/12_gameplay_director.md`, `skills/10_safety_quality_gate.md`;
   - `docs/04_Архитектура_и_агенты.md`, `docs/03_…админка.md` (ADM-GAME);
   - `docs/requirements.json` — APP-GAME-01…07, APP-PROG-01, APP-PROG-03, ADM-GAME-01/03/04/05.

## Правила работы
- **Только свои каталоги** (указаны в задаче). `packages/*`, корневые `pyproject.toml`/`package.json`/`uv.lock`/`package-lock.json`, `infra/*`, `.github/*` НЕ трогай. Сервис gamification, схемы событий, лимиты, CI и Railway уже зарегистрированы координатором. Нужно изменение общего кода, контракта или зависимости — опиши в отчёте («Запросы к общему коду»), у себя сделай минимальный обход.
- **Зависимости установлены.** Не запускай `uv add`/`uv lock`/`npm install <pkg>`. Картинки проверяй по сигнатуре байтов и заголовку размеров (webp VP8/VP8L/VP8X, png IHDR) своим кодом, без Pillow.
- **Игра не меняет учёбу.** XP, тилы, ступени и значки не влияют на уровень языка, навыки, план и сроки повторения. Единственное обратное влияние — заморозка дня в learning-plan.
- **Деньги.** Тилы за деньги в спринте 6 не продаются. Никаких экранов оплаты; при нехватке — «Покупка тилов скоро». Операция `purchase` через API не создаётся.
- **Реестр.**
  - Только добавление. Баланс = сумма операций; исправление — обратной записью.
  - `til` и `freeze` не уходят в минус.
  - Клиент не задаёт ни суммы, ни причины начисления.
  - Каждая операция идемпотентна по ключу.
- **Дети 6–13:**
  - без рейтингов, сравнений и давления; тексты на «ты», мягкие;
  - `celebrations: quiet` по умолчанию;
  - уведомления — опекуну в сводке, push ребёнку нет;
  - покупки только за тилы.
- **Общие правила:**
  - UUID для сущностей учеников; `user_id`/`staff_id` — только из токена;
  - права проверяются в домене по actor (защита в глубину);
  - аудит каждой привилегированной команды; step-up для `game.publish` и `wallet.adjust`;
  - пагинация; ErrorBody; Idempotency-Key для создающих команд;
  - события — outbox в той же транзакции; consumers — inbox с дедупликацией и проверкой издателя.
- **Тексты ученика и PII** — никогда в логах, событиях, метриках. Комментарий сотрудника к операции ученику не показывается.
- **Тесты на стенде:**
  - Python — `uv run pytest <каталог> -q -p no:cacheprovider`, `uv run ruff check <каталог>`, `uv run mypy <каталог>/src`. Каждый сервис — отдельным запуском;
  - TS — `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`; фронт — ещё `npx playwright test`, `npm run build`.
- **Минимум тестов на эндпоинт:**
  - happy path, 401, 403 (чужой вызывающий и нет права, нет step-up), 404, 422, 409 (переходы статусов, баланс), идемпотентность, изоляция учеников;
  - события — `assert_event_conforms`;
  - начисления: повтор события, дневной лимит, множитель события недели, версия правил в операции, гонка двух покупок с недостаточным на обе балансом.
- **Перед сдачей** — внутренний QA-чек-лист:
  - IDOR, AuthZ, переходы статусов;
  - неизменяемость реестра и активной версии правил;
  - баланс не уходит в минус ни при каких гонках;
  - повторная отправка;
  - граничные значения;
  - дети;
  - gamification недоступен → учёба работает.

  Найденное исправь.
- **Итоговый отчёт** — кратко, по-русски:
  - что сделано;
  - эндпоинты;
  - события;
  - таблицы и миграции;
  - тесты цифрами;
  - отклонения от контракта;
  - «Запросы к общему коду».
