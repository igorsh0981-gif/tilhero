# Бриф исполнителя спринта 5 (общий для всех)

Репозиторий: `/home/claude/tilhero`, ветка `sprint/5-memory`. Не переключай ветки и не коммить — коммитит координатор.

Стенд:
- PostgreSQL 127.0.0.1:5432 (`postgres` без пароля, БД `tilhero_test`), Redis 127.0.0.1:6379, NATS 127.0.0.1:4222;
- если стенд упал: `bash infra/dev/stack.sh up`;
- переменные тестов: `source .dev/testenv.sh`.

## Прочитать перед началом
1. `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md` (особенно §8 «Дети и подростки»), `docs/sprint5/PLAN.md` (решения владельца!), `docs/sprint5/INTERNAL_API.md` — главный документ спринта.
2. Контракты — источник истины:
   - `packages/contracts/src/bff.ts` — раздел «Спринт 5», `ContentRef`, `LearnerSummary.voice_consent`, шаг `reading` в `LessonStep`;
   - `admin.ts` — раздел «Память, словарь курса, чтение», права `memory.*`, `glossary.manage`, `Dashboard.memory`, `AiUsageSummary.speech`;
   - `ai.ts` — `TeachingCoachGlossContext/Output`, `SpeechAssessMeta`, `PronunciationResult`, `AiStatus`, `AiModel.audio_usd_per_hour`, `AiProviderStatus.speech`, `AiSessionKind`;
   - `content.ts` — `ReadingPayload`, `GlossaryEntry`;
   - схемы событий `packages/contracts/events/*.schema.json`. Новые: `memory.*`, `catalog.glossary.changed.v1`; `kind` + `reading` в `lesson.session.*`, `assessment.completed.v1`, `catalog.version.published.v1`;
   - лимиты `packages/contracts/rate-limit-policies.json`: `tg.memory.*`.
3. Принятые решения прошлых спринтов: `docs/sprint4/INTERNAL_API.md` (§9, §9.1), `docs/sprint3/INTERNAL_API.md`, отчёты `docs/qa/sprint4-qa-report.md`, `docs/qa/sprint3-*`.
4. Эталоны TilHero:
   - сессии, шаги, tick, outbox и аудит — `services/lessons/`, `services/assessment/`;
   - версии контента и публикация — `services/catalog/`;
   - вызовы ИИ, бюджет и золотые тесты — `services/ai-gateway/`;
   - Node — `services/telegram-bff/` (`routes/lessons.ts`, `routes/speech.ts`), `services/admin-bff/`;
   - фронтенд — `apps/telegram-miniapp/` (`screens/practice/`, `tg/tts.ts`), `apps/admin-web/` (`screens/content/`, `screens/ai/`).
5. Исходники LinguaFlow 1.2 (`/home/claude/in/zip/LinguaFlow_Handoff_1.2/`):
   - скиллы `skills/07_spaced_repetition.md`, `08_pronunciation.md`, `03_teaching_coach.md`, `10_safety_quality_gate.md`;
   - `docs/04_Архитектура_и_агенты.md`, `docs/03_…админка.md` (ADM-MEM);
   - `docs/requirements.json` — APP-MEM-01…05, APP-ADV-01, APP-VOICE-03/04.

## Правила работы
- **Только свои каталоги** (указаны в задаче). `packages/*`, корневые `pyproject.toml`/`package.json`/`uv.lock`/`package-lock.json`, `infra/*`, `.github/*` НЕ трогай. Новый сервис memory, схемы событий, лимиты, CI и Railway уже зарегистрированы координатором. Нужно изменение общего кода, контракта или зависимости — опиши в отчёте («Запросы к общему коду»), у себя сделай минимальный обход.
- **Зависимости установлены.** Не запускай `uv add`/`uv lock`/`npm install <pkg>`. HTTP — через `httpx` и `fetch`, SDK провайдеров не ставим. FSRS пишем сами, по формулам INTERNAL_API §1.4.
- **Ключи провайдеров** (`ANTHROPIC_API_KEY`, `AZURE_SPEECH_KEY`) — только переменные ai-gateway: не в БД, не в логах, не в ответах, не в тестах. В тестах и на стенде — `AI_PROVIDER=fake`, `SPEECH_PROVIDER=fake`. Настоящие провайдеры не вызываются: сеть стенда закрыта.
- **ИИ и речь необязательны.** Повторение, словарь, чтение и уроки работают при `unavailable`/`refused` и без ключа Azure. Нет перевода ИИ — перевод предложения. Нет речи — кнопка «Произнести» скрыта.
- **Аудио** — только в памяти процесса на время запроса: не на диске, не в Redis, БД, логах, событиях и метриках.
- **Текст ученика** (ввод в повторении, цитаты ошибок, реплики) и PII — никогда в логах, событиях, метриках, ответах вне контракта.
- **Дети 6–13:**
  - свободный текст в ИИ не уходит; ввод в повторении сравнивается локально, ИИ не участвует;
  - только детские тексты;
  - запись голоса — только с согласия опекуна;
  - напоминания — опекуну;
  - без давления, сравнения и наказаний.
- **Срок повторения считает только FSRS в memory.** Клиент и ИИ сроки не задают. `easy` автоматически не ставится. Выбор готового ответа — не выше `hard`.
- **Общие правила:**
  - UUID для сущностей учеников; `user_id`/`staff_id` — только из токена;
  - права проверяются в домене по actor (защита в глубину);
  - аудит каждой привилегированной команды;
  - пагинация; ErrorBody; Idempotency-Key для создающих команд;
  - события — outbox в той же транзакции; consumers — inbox с дедупликацией и проверкой издателя.
- **Тесты на стенде:**
  - Python — `uv run pytest <каталог> -q -p no:cacheprovider`, `uv run ruff check <каталог>`, `uv run mypy <каталог>/src`. Каждый сервис — отдельным запуском;
  - TS — `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`; фронт — ещё `npx playwright test`, `npm run build`.
- **Минимум тестов на эндпоинт:**
  - happy path, 401, 403 (чужой вызывающий и нет права), 404, 422, 409 (переходы статусов), идемпотентность, изоляция учеников;
  - события — `assert_event_conforms`;
  - FSRS — эталоны §1.4;
  - ИИ и речь — `ok`, `unavailable` (выключен, бюджет, нет ключа, таймаут), `refused`/дети, `insufficient_evidence`.
- **Перед сдачей** — внутренний QA-чек-лист: IDOR, AuthZ, переходы статусов, неизменяемость истории, PII и тексты, аудио нигде не сохранено, граничные значения, дети, ИИ и речь выключены, повторная отправка. Найденное исправь.
- **Итоговый отчёт** — кратко, по-русски:
  - что сделано;
  - эндпоинты;
  - события;
  - таблицы и миграции;
  - тесты цифрами;
  - отклонения от контракта;
  - «Запросы к общему коду».
