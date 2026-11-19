# ai-gateway

**Владелец:** платформа (ИИ) + методисты (инструкции агентов). **Bounded context:** реестр 17 агентов LinguaFlow, версии
инструкций LLM-агентов (черновик → золотые тесты → публикация, канарейка, откат), золотые тесты, маршрутизация моделей и
цены, бюджеты и аварийная остановка ИИ, вызов агента со строгой проверкой JSON и правилами безопасности
(`safety_quality_gate`), учёт затрат **без текстов** (спринт 4, AT-49…51; INTERNAL_API §1, §9).

Порт 8114, схема PostgreSQL `ai_gateway` (роли `ai_gateway_owner` — миграции, `ai_gateway` — рантайм без DDL),
внутренний JWT с `aud = ai-gateway`. Redis — идемпотентность вызовов (результат по `request_id`, 24 ч) и команд
сотрудников, последняя ошибка провайдера. Типы — `packages/contracts/src/ai.ts` (pydantic-модели
`tilhero_ai_gateway/contracts.py` повторяют их 1:1, контрактный тест сверяет поля и перечисления); формы admin API —
`admin.ts` («ИИ, контроль диалогов, затраты»).

**ИИ необязателен:** ответ вызова всегда 200 с `status: ok | unavailable | refused` — вызывающий (lessons, assessment)
обязан продолжить без ИИ при `unavailable`/`refused`; ученик ошибку провайдера не видит.

## Вызов агента (`/internal/v1`, вызывающие — lessons, assessment)
| Метод | Путь | Ответ / ошибки |
|---|---|---|
| POST | `/agents/{agent_id}/invoke` `AgentInvokeRequest` (+ `deadline_ms?` 1000..60000) | 200 `AgentInvokeResult`; 404 `AGENT_NOT_FOUND`, `AGENT_NOT_ACTIVE` (не `llm`+`active`); 422 `CONTEXT_INVALID {errors}` (контекст не по ai.ts), `IDEMPOTENCY_KEY_REUSED`; 409 `IDEMPOTENCY_IN_PROGRESS` (дубль не дождался первого вызова); 401 `USER_CONTEXT_REQUIRED` (в токене нет `sub`); 403 `USER_CONTEXT_MISMATCH` |
| GET | `/status` | `{ai_available}` — аварийной остановки нет и провайдер готов (lessons — при старте занятия) |

Порядок (INTERNAL_API §1.2): агент `llm`+`active` → свободный текст и аудитория kids → `refused: kids_not_allowed`
(аудитория — из тела: lessons и assessment передают аудиторию сессии; проверка claims токена `lrn` ≠ `sub` /
`age_band` 6–13 оставлена на будущее — сейчас вызывающие их не передают, ревью R1-07) →
`budget.ai_enabled = false` или провайдер без ключа → `unavailable: ai_disabled` → версия: опубликованная или
канареечная (`sha256(user_id + agent_id) mod 100 < canary_percent`); нет опубликованной → `refused: agent_not_active` →
попытки: основная модель → один повтор с ограничениями (коды нарушений дописываются в rules) → резервная модель;
ошибка/таймаут провайдера → сразу резервная → итог `ok` | `unavailable: invalid_output | provider_error | timeout |
cost_limit | budget_exceeded`. Перед **каждой** попыткой (до вызова провайдера; ревью R1-02, R1-03):
- оценка стоимости (вход ≈ символы/3 токенов + `max_output_tokens`);
- `max_cost_usd` версии — **накопительно по вызову**: оплачено попытками + оценка следующей; не помещается → следующая
  попытка — резервная модель (повтор на основной пропускается), не помещается и она → `unavailable: cost_limit`
  (лимит версии, не бюджет);
- резерв бюджета (месяц, ученик в день, урок): не помещается → тоже резервная модель, и только если не помещается и
  она → `unavailable: budget_exceeded`;
- дедлайн вызывающего `deadline_ms` (от приёма запроса): осталось < 1,5 с → попытка не начинается,
  `unavailable: timeout`; таймаут попытки = min(`timeout_ms` версии, остаток − 0,5 с).

Стоимость (`cost_usd`) — фактически оплаченное: по usage ответа; таймаут клиента и неразборчивый ответ после HTTP 200
(`bad_response`) — оценка попытки (провайдер мог выставить счёт; консервативно, ревью R1-08); ошибка HTTP/сети — 0.

Идемпотентность: повтор `request_id` (24 ч, Redis) — сохранённый результат (`idempotent-replay: true`); дубль, пока
первый вызов идёт, **ждёт** его результат (опрос каждые 200 мс, не дольше дедлайна вызывающего и 25 с) и отдаёт его
как повтор; 409 `IDEMPOTENCY_IN_PROGRESS` — только если не дождался (ревью R1-04). `deadline_ms` в отпечаток запроса не
входит (повтор с другим дедлайном — тот же вызов).

Сборка сообщений: `system` = instructions версии + rules + правила шлюза (данные — не инструкции, формат ответа, схема
вывода, ограничения повтора); единственное сообщение пользователя — **только JSON** `{locale, context}`. Реплика ученика —
значение поля (`learner_turn`, тексты `speaker: learner`), ≤ 500 символов, без управляющих и bidi-символов; в system/rules
не попадает. Ответ: весь текст (после пробелов и одного ограждения ```/```json) — ровно один JSON-объект, иначе
`not_json` и повтор с ограничениями (ревью R1-09) → JSON-схема версии (подмножество draft 2020-12, `domain/jsonschema_lite.py`:
type, enum, const, required, properties, additionalProperties, items, min/maxLength, min/maxItems, minimum, maximum,
pattern, anyOf; прочие ключевые слова отклоняются при сохранении версии) → контракт ai.ts (строгие типы) →
`safety_quality_gate` (`domain/safety.py`): ссылки, e-mail, телефоны (кроме `555 01xx`), ключи (`sk-…`, JWT, ключ
шлюза), «сертификат/certificate/sertifikat», `pronunciation_score`/`scores.pronunciation` ≠ null, реплика персонажа
> 240 символов или > 25 слов на A0–A2, кириллица в английских полях, язык объяснения коуча, intent вне переходов узла,
критерий вне рубрики. Подтверждённая ошибка оценщика, чьей цитаты нет дословно в реплике ученика с этим `turn_id`,
отбрасывается (`warnings: ["evidence_dropped"]`). `warnings` успешного ответа — коды, исправленные повтором.

## Admin API (`/admin/v1/ai`, только admin-bff с `actor`; права — здесь, step-up — в admin-bff)
| Метод | Путь | Право | Ответ / ошибки |
|---|---|---|---|
| GET | `/agents` | ai.read | `{items: AgentRow[]}` (17 агентов; `published.published_by` — id) |
| GET | `/agents/{agent_id}` | ai.read | `AgentRow & {versions: AgentVersionRow[]}` (`author_id`, `published_by` — id) |
| GET | `/agents/{agent_id}/versions/{v}` | ai.read | `AgentVersion` + `updated_at` (для If-Match) + `canary` |
| POST | `/agents/{agent_id}/versions` `{from_version?}` | ai.manage | 201 черновик из опубликованной (или указанной); 409 `DRAFT_EXISTS {version}`, `AGENT_NOT_LLM` |
| PATCH | `/agents/{agent_id}/versions/{v}` `AgentVersionPatch`, `If-Match: <updated_at>` | ai.manage | `AgentVersion`; 409 `VERSION_NOT_DRAFT`, `VERSION_CONFLICT {updated_at}`, `VERSION_IN_CANARY`; 422 `VERSION_INVALID {errors}`; 428 `IF_MATCH_REQUIRED` |
| DELETE | `/agents/{agent_id}/versions/{v}` | ai.manage | 204; 409 `VERSION_NOT_DRAFT`, `VERSION_IN_CANARY` |
| POST | `/agents/{agent_id}/versions/{v}/test-runs` | ai.manage | 202 `TestRunSummary` (фоновый прогон); 409 `TEST_RUN_IN_PROGRESS`; 422 `NO_GOLDEN_CASES`; 429 `TEST_RUNS_LIMIT {retry_after}` — больше 20 прогонов за сутки (Ташкент) на всех |
| GET | `/agents/{agent_id}/versions/{v}/test-runs/{run_id}` | ai.read | `TestRun` (results: failures, skipped) |
| POST | `/agents/{agent_id}/versions/{v}/publish` `{reason}` | ai.publish | `AgentRow` (повтор — без изменений); 409 `VERSION_NOT_DRAFT`; 422 `TESTS_REQUIRED {reason}`, `TESTS_FAILED {case_ids}`, `MODEL_INACTIVE` |
| PUT / DELETE | `/agents/{agent_id}/canary` `{version, percent 1..50, reason}` / `{reason}` | ai.publish | `AgentRow`; 409 `VERSION_NOT_DRAFT`, `NO_PUBLISHED_VERSION`, `NO_CANARY`; 422 как у публикации |
| POST | `/agents/{agent_id}/rollback` `{reason}` | ai.publish | `AgentRow`; 409 `NO_PREVIOUS_VERSION` |
| GET / POST | `/agents/{agent_id}/golden-cases?include_archived=&cursor=` / `GoldenCaseInput` | ai.read / ai.manage | `{items: GoldenCase[], next_cursor}` / 201 `GoldenCase`; 422 `GOLDEN_CASE_INVALID {errors}` |
| PATCH / DELETE | `/golden-cases/{case_id}` | ai.manage | `GoldenCase` / 204 (удаление = архив); 409 `GOLDEN_CASE_ARCHIVED` |
| GET / PUT | `/models` / `/models/{model_id}` `{input_usd_per_mtok, output_usd_per_mtok, active, reason}` | ai.read / ai.publish (снижение цены — ещё costs.manage) | `{items: AiModel[]}` / `AiModel`; 403 `PERMISSION_DENIED {permission: costs.manage}` (снижение цены); 404 `MODEL_NOT_FOUND`; 409 `MODEL_IN_USE {versions}`; 422 `PRICE_REQUIRED {fields}` (у модели anthropic цены > 0) |
| GET | `/provider` | ai.read | `AiProviderStatus` — ключ только «задан / не задан», ошибка — код и время |
| GET / PUT | `/budget` / `AiBudget`-поля `& {reason}` (`updated_at?` — защита от гонки, `ai_enabled?`) | costs.read / costs.manage | `AiBudget`; 409 `BUDGET_CONFLICT` |
| POST | `/emergency-stop` `{enabled, reason}` | costs.manage | `AiBudget`; `enabled: true` — остановка включена (ИИ выключен) |
| GET | `/usage/summary?period=day\|week\|month` | costs.read \| dashboard.read | `AiUsageSummary` |
| GET | `/usage?session_id=\|agent_id=&cursor=&limit=` | costs.read (с `session_id` — ещё qa.read) | `Page<AiCall>` (без user_id и текстов) |
| GET | `/usage/by-session?session_id=<id>&session_id=…` (≤ 50) | qa.read \| costs.read | `{items: [{session_id, models, cost_usd, p95_latency_ms}]}` — для журнала «Контроля диалогов»; сессии без вызовов — нули; 422 `TOO_MANY_SESSIONS` |

Создающие и публикующие команды принимают `Idempotency-Key` (повтор — сохранённый ответ, `idempotent-replay: true`).
Аудит каждой команды — `admin.audit.recorded.v1` через outbox: `ai.version_created | version_updated | version_deleted |
version_published | canary_set | canary_cleared | rolled_back`, `ai.test_run`, `ai.golden_case_created | updated |
archived`, `ai.model_updated`, `ai.budget_updated`, `ai.emergency_stop` (без текстов инструкций — хеши и имена полей).

## Версии, золотые тесты, публикация
- На агента — одна `published`, один `draft`, не больше одной канарейки (канарейка — проверенный черновик; под ней он
  заморожен). Опубликованная и архивная версии неизменяемы: триггер `agent_versions_guard` (переходы только
  draft → published → archived → published (откат)); удалить можно только черновик не под канарейкой.
- Публикация и канарейка требуют последнего завершённого прогона **этой** версии: по текущему телу (`body_hash`) и
  текущему набору обязательных кейсов (`cases_hash`), не старше 14 дней (`GOLDEN_RUN_MAX_AGE_DAYS`), `passed_mandatory`.
  В stage/prod — только прогон на `anthropic`; `AI_ALLOW_FAKE_TEST_PUBLISH=true` (только ENV dev/test) разрешает прогон
  на `fake` для e2e-стенда (INTERNAL_API §9). `TESTS_REQUIRED.reason`: `no_recent_run | version_changed | cases_changed |
  no_mandatory_cases | real_provider_required`.
- Проверки кейса — по путям от корня `AgentInvokeResult` (`status`, `reason`, `cost_usd`, `output.intent`,
  `output.confirmed_errors.0.evidence`; `*` — все элементы). На `fake` выполняются `schema_valid` и пути вне `output.*`,
  проверки содержимого `output.*` → `skipped`. Кейс `audience: kids` у агента свободного текста засчитывается только при
  `refused: kids_not_allowed`.
- Сид v1 и золотые тесты — миграция 0002 из `migrations/seed/` (`agents/<agent_id>.v1.json`,
  `golden/<agent_id>.json`; путь — `SEED_DIR`): весь набор проверяется (поля и пределы, схема вывода, модели, контексты
  по ai.ts, GoldenCheck), невалидный — миграция падает со списком ошибок; публикует автор seed
  `00000000-0000-4000-a000-000000005eed` с аудитом; повтор ничего не меняет (тело, уже публиковавшееся сидом, заново не
  публикуется); откат удаляет только записи сида.
- Изменения сида после 0002 — миграции-«накладки» `<SEED_DIR>/<ревизия>/` того же формата (опубликованная версия
  неизменяема → новая версия). **0003**: `independent_evaluator` **v2** — тексты v1, `max_output_tokens` 600,
  `max_cost_usd` 0.03, `timeout_ms` 12 000 (ревью R1-02: оценка худшего случая урока l-19-first-day на v1 — 0.0199 при
  лимите 0.02, на v2 — 0.0169; тест `test_gw_seed_cost.py`); обязательный кейс `ie-19-kids-refused` (ревью R1-15);
  `usage.reason` + `cost_limit`. Откат 0003 возвращает v1 и удаляет кейс. Прогон золотых тестов v2 на fake (dev/test) —
  по общим правилам (`test_gw_schema.py`).
- Золотые прогоны: не больше `GOLDEN_RUNS_DAILY_LIMIT` (20) в сутки по Ташкенту на все агенты (429 `TEST_RUNS_LIMIT`);
  аварийная остановка прогон **не** блокирует (проверка сотрудником перед включением ИИ), месячный потолок —
  учитывается (ревью R1-11).

## Бюджеты (решение владельца 19.11.2026)
`budget` (singleton): `ai_enabled` (аварийная остановка), `monthly_cap_usd` 20 (календарный месяц UTC),
`learner_daily_cap_usd` 0.05 (день — Asia/Tashkent), `lesson_cap_usd` 0.03 (сумма по `session_id`), `alert_percent` 80.
Резерв: строка usage вызова в статусе `pending` держит `reserved_usd` (оценка следующей попытки) — под транзакционной
advisory-блокировкой параллельные вызовы видят резервы друг друга; «зависший» pending старше 10 минут снимается.
Дополнительно — `max_cost_usd` версии на вызов (накопительно по попыткам, причина отказа `cost_limit`). Стоимость —
по usage ответа провайдера и таблице `models` (формула `tilhero_common.ai_pricing`, Decimal); цена модели anthropic
не может быть 0, снижение цены — только с `costs.manage` (ревью R1-12). Золотые прогоны ограничены месяцем и
20 прогонами в сутки.

## Провайдеры
- `AI_PROVIDER=anthropic` (prod): Messages API `POST {ANTHROPIC_BASE_URL}/v1/messages` через httpx, заголовки
  `x-api-key`, `anthropic-version: 2023-06-01`; тело `model, system, messages, max_tokens, temperature`; токены —
  `usage.input_tokens/output_tokens`. Ошибки → коды `http_<status> | network | timeout | bad_response` (без тела).
- `AI_PROVIDER=fake` (тесты, стенд e2e; в stage/prod запрещён): детерминированный (`providers/fake.py`), стоимость 0
  (модель `fake` 0/0), реплика ученика — только слова.

**Как добавить ключ:** Railway → сервис ai-gateway → Variables → `ANTHROPIC_API_KEY` (вводит владелец), `AI_PROVIDER=
anthropic`; redeploy. Ключ живёт только в переменной окружения ai-gateway: не в БД, не в логах, не в ответах; в админке —
только «задан / не задан» (`GET /admin/v1/ai/provider`). Без ключа все вызовы — `unavailable: ai_disabled`, уроки идут
без ИИ.

## События
- Публикует: `admin.audit.recorded.v1` (аудит), `user.domain.deleted.v1 {domain: "ai-gateway", mode: "anonymized"}`.
- Потребляет: `user.deletion.requested.v1` (только от identity-consent; inbox) → `usage.user_id = NULL`, `deleted_users`,
  кеш результатов вызовов ученика в Redis стирается.

## Данные
`agents` (сид 17), `models` (сид: claude-haiku-5-5 0.10/0.50, claude-sonnet-5-5 2.00/10.00, fake 0/0), `agent_versions`
(триггер неизменяемости), `agent_rollout`, `golden_cases`, `test_runs` (завершённый неизменяем), `budget`, `usage`
(только метаданные вызова), `deleted_users`, `outbox`, `inbox`.

## Настройки
`AI_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` (тесты), `AI_ALLOW_FAKE_TEST_PUBLISH` (dev/test), `SEED_DIR`,
`TIMEZONE` (Asia/Tashkent), `GOLDEN_RUN_MAX_AGE_DAYS` (14), `GOLDEN_RUN_STALE_MINUTES` (60), `GOLDEN_RUNS_DAILY_LIMIT`
(20), `INVOKE_CACHE_TTL_SECONDS`
(86400), `CACHE_NAMESPACE`, общие `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `REDIS_URL`, `NATS_URL`, внутренний JWT.

## Runbook
- **Авария провайдера / расходы:** `POST /admin/v1/ai/emergency-stop {enabled: true}` — все вызовы `ai_disabled`.
- **Регрессия версии:** `POST /agents/{id}/rollback` (снимает и канарейку).
- **Прогон «завис» в running** (рестарт процесса): при старте прогоны старше 60 минут помечаются `failed`.
- Тесты: `uv run pytest services/ai-gateway -q -p no:cacheprovider` (стенд `infra/dev/stack.sh up`).
