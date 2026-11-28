# ai-gateway

**Владелец:** платформа (ИИ) + методисты (инструкции агентов). **Bounded context:** реестр 17 агентов LinguaFlow, версии
инструкций LLM-агентов (черновик → золотые тесты → публикация, канарейка, откат), золотые тесты, маршрутизация моделей и
цены, бюджеты и аварийная остановка ИИ, вызов агента со строгой проверкой JSON и правилами безопасности
(`safety_quality_gate`), учёт затрат **без текстов** (спринт 4, AT-49…51; INTERNAL_API §1, §9). Спринт 5
(`docs/sprint5/INTERNAL_API.md` §3): `teaching_coach` v2 с переводом слова `gloss_word` для memory и оценка
произношения `pronunciation_coach` + советы правилами (AT-57, AT-58). Релиз 5.1 (решение владельца 20.11.2026: регистрация
Azure не прошла): по умолчанию свой сервер — запись распознаёт сервис tts (faster-whisper), ai-gateway сравнивает слова с
эталоном (провайдер `whisper`); Azure AI Speech (Pronunciation Assessment) — запасной провайдер.

Порт 8114, схема PostgreSQL `ai_gateway` (роли `ai_gateway_owner` — миграции, `ai_gateway` — рантайм без DDL),
внутренний JWT с `aud = ai-gateway`. Redis — идемпотентность вызовов (результат по `request_id`, 24 ч) и команд
сотрудников, последняя ошибка провайдера. Типы — `packages/contracts/src/ai.ts` (pydantic-модели
`tilhero_ai_gateway/contracts.py` повторяют их 1:1, контрактный тест сверяет поля и перечисления); формы admin API —
`admin.ts` («ИИ, контроль диалогов, затраты»).

**ИИ необязателен:** ответ вызова всегда 200 с `status: ok | unavailable | refused` — вызывающий (lessons, assessment,
memory) обязан продолжить без ИИ при `unavailable`/`refused`; ученик ошибку провайдера не видит. То же для оценки
произношения (`ok | insufficient_evidence | unavailable`).

## Вызов агента (`/internal/v1`, вызывающие — lessons, assessment, memory)
| Метод | Путь | Ответ / ошибки |
|---|---|---|
| POST | `/agents/{agent_id}/invoke` `AgentInvokeRequest` (+ `deadline_ms?` 1000..60000; `session_kind` — `AiSessionKind`: + `reading`, `memory`) | 200 `AgentInvokeResult`; 404 `AGENT_NOT_FOUND`, `AGENT_NOT_ACTIVE` (не `llm`+`active`); 403 `CALLER_NOT_ALLOWED {agent_id, request}` (политика вызывающих ниже); 422 `CONTEXT_INVALID {errors}` (контекст не по ai.ts), `IDEMPOTENCY_KEY_REUSED`; 409 `IDEMPOTENCY_IN_PROGRESS` (дубль не дождался первого вызова); 401 `USER_CONTEXT_REQUIRED` (в токене нет `sub`); 403 `USER_CONTEXT_MISMATCH` |
| GET | `/status` | `AiStatus {ai_available, speech_available}` — `ai_available`: аварийной остановки нет и провайдер LLM готов (lessons — при старте занятия); `speech_available`: нет остановки, ключ и регион Azure заданы (или fake), модель речи включена, месячный потолок не превышен и расход речи за месяц < подлимита речи (memory — перед «Произнести») |
| POST | `/speech/pronunciation` (только memory) | см. «Оценка произношения» |

**Политика вызывающих (спринт 5, защита в глубину):** memory — только `teaching_coach` с `context.request = gloss_word`
(перевод слова, которое memory проверила в опубликованном контенте через catalog); lessons и assessment — все
LLM-агенты, кроме `gloss_word` (иначе в «перевод слова» мог бы попасть текст ученика, а `gloss_word` разрешён детям).
Иное → 403 `CALLER_NOT_ALLOWED`.

**`teaching_coach` — два вида запроса** (ai.ts): `simpler_example | explain_again` (`TeachingCoachContext` →
`TeachingCoachOutput`) и `gloss_word` (`TeachingCoachGlossContext {word ≤ 60, sentence_en ≤ 300, level,
content_kind}` → `TeachingCoachGlossOutput {lemma, part_of_speech, gloss {ru, uz}, forms ≤ 6, confidence}`). `word`
обязано встречаться в `sentence_en` (нормализация §1.6: регистр, апострофы, пробелы) — иначе 422. Контракт вывода
выбирается по виду запроса: схема v2 — объединённая (`anyOf`), вывод «не того» вида → `contract_mismatch` и повтор.
Лимиты `gloss_word` поверх версии (`REQUEST_LIMITS`, INTERNAL_API §3.1): **≤ 200 выходных токенов и ≤ 6 с** (меньшее
из лимитов версии и запроса; оценка стоимости — по 200): у v2 общий `max_output_tokens` 400 и `timeout_ms` 8000 нужны
запросам v1, поэтому лимиты gloss — в коде шлюза, длины полей — в схеме и контракте. Версия, чья схема вывода не
принимает образцовый вывод gloss (v1 и черновики из неё), `gloss_word` не обслуживает → `refused: agent_not_active` без
вызова провайдера (memory показывает «перевода нет» до публикации v2). Детям `gloss_word` разрешён (текста ученика нет).
Правила безопасности gloss (`domain/safety.py`): ссылки, e-mail, телефоны, ключи — как у всех; `gloss.ru` — кириллица
без латиницы («без английского»), `gloss.uz` — латиница без кириллицы, `lemma`/`forms` — без кириллицы →
`wrong_language` и повтор; `oʻ/gʻ`, записанные `' ‘ ’ \``, исправляются на `ʻ` (U+02BB) без повтора
(`warnings: ["uz_apostrophe_fixed"]`). Провайдер fake отвечает `gloss {ru: "[ru] <word>", uz: "[uz] <word>"}`,
`lemma = word`, `confidence 0.9` — языковые правила gloss к нему не применяются (заглушка стенда).

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

## Спринт 7: коуч парного урока и голос комнаты (INTERNAL_API §4)
- **`cooperative_lesson_coach`** — `llm`/`active`, свободный текст (детям — `refused: kids_not_allowed`). Вызывающий —
  только lessons (иначе 403 `CALLER_NOT_ALLOWED`), `session_kind: pair`, `session_id = context.room_id` (иначе 422
  `CONTEXT_INVALID`); вид `pair` — только у коуча, в сессии `duel` ИИ не вызывается (422). Контракт —
  `CooperativeCoachContext` → `CooperativeCoachOutput` (ai.ts): участники только ролями A/B. Версия 1 — черновик сида
  (накладка `migrations/seed/0008`: инструкции по скиллу 11, 8 обязательных золотых кейсов — молчащий, монополизация,
  чужой транскрипт, ребёнок, переподключение, грубость, уход от темы, оценка без вклада); публикует владелец после
  прогона на anthropic (`POST …/cooperative_lesson_coach/versions/1/test-runs` → `…/publish`), на стенде — шлюз при
  старте. До публикации — `refused: agent_not_active` (комнаты идут по сценарию с выбором).
  - Бюджет: потолок комнаты `room_cap_usd` (сумма usage по `session_id = room_id`, по умолчанию 0,10 $) и месяц;
    дневной лимит ученика и лимит урока не применяются. Исчерпан — `unavailable: budget_exceeded`.
  - safety_quality_gate коуча: эхо `room_id` (`room_mismatch`); согласованность статуса и триггера (`coach_state`:
    finished ⇔ отчёт; paused/finished — `next_speaker` null; ход — роль из комнаты или both; roles и цель — только при
    start; варианты — только в режиме choices; прогресс не убывает); язык (`wrong_language`: английские поля без
    кириллицы, ru — кириллица, uz — латиница, апострофы uz исправляются); идентификаторы (room_id, turn_id, skill_id,
    choice_id) не проверяются как текст. Без повтора отбрасываются доказательства чужой роли (`evidence_dropped`) и
    подсказки отчёта роли без вклада или сверх трёх (`tips_dropped`).
- **`duel_host`** → `code` (`implemented_in lessons`), **`referral_integrity_reviewer`** → `rules` (`implemented_in
  social`): вызова и версий нет (404 `AGENT_NOT_ACTIVE`, 409 `AGENT_NOT_LLM`).
- **`POST /internal/v1/speech:transcribe`** (только lessons) — голосовой ход комнаты: WAV как у произношения, мета —
  `X-Speech-Meta` = base64url(JSON `SpeechTranscribeMeta {request_id, user_id, room_id, audience, language}`) → 200
  `SpeechTranscribeResult {text ≤ 600, words ≤ 120, duration_ms, provider, latency_ms}`. Распознаёт tts (`TTS_URL`,
  `whisper-base-en`, 0 $, бюджеты не тратятся) при любом `SPEECH_PROVIDER` (Azure — только оценка произношения),
  `SPEECH_PROVIDER=fake` — `fake_speech`. Ошибки: 403 `KIDS_NOT_ALLOWED` (audience kids или детский токен),
  `USER_CONTEXT_MISMATCH`; 422 `SPEECH_META_INVALID`, `AUDIO_INVALID {reason}`, `IDEMPOTENCY_KEY_REUSED`; 409
  `IDEMPOTENCY_IN_PROGRESS`; 503 `SPEECH_UNAVAILABLE` — аварийная остановка, нет `TTS_URL`, модель речи выключена, tts
  недоступен (сеть, 502/504 — один повтор; 503 и неверный ответ — без повтора) или не успел. Тишина — пустые text и
  words. Учёт — строка `usage` агента коуча (`session_kind pair`, `session_id = room_id`, `audio_ms`, 0 $), без текста;
  повтор `request_id` ≤ 24 ч — сохранённый результат (кеш `transcribe`, стирается сагой), 503 не сохраняется.
- **Миграция 0008:** реестр (снимок для отката — `registry.AGENTS_SPRINT6`), пустая маршрутизация версий двух не-LLM
  агентов удаляется, `budget.room_cap_usd` (CHECK ≤ потолка месяца), `usage.session_kind` + `duel`, `pair`, накладка
  `0008`. `PUT /admin/v1/ai/budget` принимает `room_cap_usd` (необязателен — не передан, прежний; больше потолка месяца
  → 422 `BUDGET_INVALID {fields: [room_cap_usd]}`), `GET` всегда его отдаёт.

## Спринт 8: контроль ИИ (INTERNAL_API §7, ai.ts «Контроль ИИ», AT-98)
- **Тариф ученика** — проекция `billing.access.changed.v1` (только от billing) в `learner_tiers`: `paid` — tier paid и
  `paid_until` NULL или в будущем; нет строки — `free`; позднее событие (меньший `changed_at`) тариф не откатывает.
- **Дневной лимит по тарифу:** free — `learner_daily_cap_usd` (0,05), paid — `paid_learner_daily_cap_usd` (0,30);
  `learner_daily ≤ paid_daily ≤ monthly` (иначе 422 `BUDGET_INVALID {fields: [paid_learner_daily_cap_usd]}`).
- **Уровни деградации** (domain/degradation.py): аварийная остановка → `off`; `manual` → заданный; `auto` — по доле
  расхода месяца UTC с резервами: `< economy_at_percent` (80) — `normal`, `< paid_only_at_percent` (90) — `economy`,
  `< 100 %` — `paid_only`, иначе `off`. `economy` (и `paid_only` у подписчика) — попытки сразу резервной моделью
  версии; `paid_only` у ученика free — `unavailable: degraded` до провайдера ($0, строка usage); `off` — `ai_disabled`
  (остановка или ручной off) / `budget_exceeded` (авто). Золотые прогоны — только потолок месяца; произношение и голос
  комнаты (Whisper) — только `off`. Тариф проверяется по `user_id` вызова: коуч оплаченной комнаты урока вдвоём
  вызывается от имени плательщика (lessons, поток C) — бесплатный приглашённый его не останавливает.
- **Смена действующего уровня** фиксируется там, где её видно (вызов, `/status`, чтение и правка настроек, бюджет,
  остановка): строка `degradation_events` + `ai.degradation.changed.v1 {from, to, mode, reason, spent_percent, at}` в
  одной транзакции, под блокировкой строки бюджета (параллельные наблюдатели пишут смену один раз). Основание:
  `threshold`, `manual` (правка сотрудником, `actor`), `emergency_stop` (вход и выход), `month_reset` (снижение из-за
  нового месяца). Ручная правка — ещё аудит `ai.degradation_updated` (было/стало с действующим уровнем).
- **`GET /internal/v1/status`** — `AiStatus {ai_available, speech_available, level, free_available (normal|economy),
  paid_available (+ paid_only)}`; lessons при старте урока с удержанием billing смотрит `paid_available`.
- **Стоимость занятий:** consumers `lesson.session.completed.v1` (kind lesson | scenario) и `lesson.pair.completed.v1`
  (kind pair, session_id = room_id, ученик — плательщик комнаты) → `session_costs`; стоимость — сумма `usage` по
  session_id. `ai_sessions` — есть успешный вызов или списаны ИИ-минуты; деградированные — есть отказ
  `degraded | budget_exceeded | ai_disabled` (занятие, сразу начатое без ИИ по статусу, вызовов не делает — его видно
  в отчётах billing).
- Миграция `0009`: `budget` + `paid_learner_daily_cap_usd`, `degradation_mode`, `degradation_level`,
  `economy_at_percent`, `paid_only_at_percent`, `last_level`, `last_level_at`, `degradation_updated_at`;
  `learner_tiers`, `session_costs`, `degradation_events`; `usage.reason` + `degraded`. Откат: `degraded` →
  `budget_exceeded`.
- Сага: `learner_tiers` — удаляется, `session_costs.user_id` → NULL.

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
| GET / PUT | `/models` / `/models/{model_id}` `{input_usd_per_mtok, output_usd_per_mtok, audio_usd_per_hour?, active, reason}` | ai.read / ai.publish (снижение цены — ещё costs.manage) | `{items: AiModel[]}` (+ `audio_usd_per_hour`: речь — $ за час аудио, LLM — null) / `AiModel`; 403 `PERMISSION_DENIED {permission: costs.manage}` (снижение цены, в т. ч. часа аудио); 404 `MODEL_NOT_FOUND`; 409 `MODEL_IN_USE {versions}` (LLM; модель речи выключать можно — оценка произношения → `not_configured`); 422 `PRICE_REQUIRED {fields}` (anthropic — цены > 0; azure_speech — час аудио > 0), `PRICE_NOT_APPLICABLE {fields}` (цены токенов у речи ≠ 0 или час аудио у LLM). `audio_usd_per_hour` не передана — прежняя |
| GET | `/provider` | ai.read | `AiProviderStatus` — ключ только «задан / не задан», ошибка — код и время; `speech {provider, key_configured, region, last_error}` (ключ Azure не показывается никогда; регион — как введён) |
| GET / PUT | `/budget` / `AiBudget`-поля `& {reason}` (`updated_at?` — защита от гонки, `ai_enabled?`; `speech_monthly_cap_usd` обязателен) | costs.read / costs.manage | `AiBudget` (+ `speech_monthly_cap_usd`); 409 `BUDGET_CONFLICT`; 422 `BUDGET_INVALID {fields}` (подлимит речи > потолка месяца) |
| POST | `/emergency-stop` `{enabled, reason}` | costs.manage | `AiBudget`; `enabled: true` — остановка включена (ИИ выключен) |
| GET | `/degradation` | costs.read | `AiDegradation {mode, manual_level, level, economy_at_percent, paid_only_at_percent, spent_percent, month, events (≤ 20, новые сверху), updated_at}` (спринт 8) |
| PUT | `/degradation` `AiDegradationUpdate {mode, manual_level, economy_at_percent, paid_only_at_percent, reason 10..500}` | costs.manage + **step-up в домене** (`X-Step-Up: ok` от admin-bff или claim `step_up`) | `AiDegradation`; 403 `STEP_UP_REQUIRED {permission}`; 422 `DEGRADATION_INVALID {fields}` (1 ≤ economy ≤ paid_only ≤ 100; manual_level — только и обязательно в manual); `Idempotency-Key` |
| GET | `/unit-costs?period=week\|month` | costs.read \| dashboard.read | `AiUnitCosts {period, from, to, by_kind {lesson, scenario, pair}, degraded_sessions_pct}` (USD — строки с 6 знаками) |
| GET | `/usage/summary?period=day\|week\|month` | costs.read \| dashboard.read | `AiUsageSummary` (+ `speech {calls, audio_minutes, spent_usd, speech_available, cap_usd}` — вызовы `pronunciation_coach` за период, минуты оценённого аудио, расход; входит в `spent_usd`) |
| GET | `/usage?session_id=\|agent_id=&cursor=&limit=` | costs.read (с `session_id` — ещё qa.read) | `Page<AiCall>` (без user_id и текстов; `audio_ms` — длительность аудио речи, у LLM 0; у речи `status ok` бывает с причиной insufficient_evidence) |
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
- **0004** (спринт 5): `teaching_coach` **v2 — черновик** автора seed (накладка `migrations/seed/0004/`: тексты v1 +
  `gloss_word`, объединённая схема `teaching_coach.v2`, параметры v1) и 8 кейсов `gloss_word` (6 обязательных:
  многозначность по контексту, фразовый глагол, форма → лемма, инъекция в `sentence_en`, ребёнок → ok, имя
  собственное). **Публикация** — после прогона золотых тестов: в stage/prod сотрудник (владелец) прогоняет тесты на
  anthropic и публикует (`POST …/teaching_coach/versions/2/test-runs` → `…/publish`); на dev/e2e-стенде
  (`AI_ALLOW_FAKE_TEST_PUBLISH=true` и `AI_PROVIDER=fake`) это делает сам шлюз при старте (`domain/stand.py`: обычный
  прогон на fake и обычная публикация, автор — системный seed, аудит `ai.test_run` / `ai.version_published` с
  `actor_type: system`; ошибка не мешает старту). Если у агента уже есть черновик сотрудника, v2 не создаётся
  (предупреждение в лог миграции) — удалить черновик и повторить `alembic upgrade`. Новые обязательные кейсы меняют
  набор — прежние прогоны teaching_coach устаревают; черновик из v1 (схема без gloss) их не пройдёт. Там же: модели и
  учёт речи, реестр агентов (`spaced_repetition_coach` → `code`/memory, `pronunciation_coach` → `code`/ai-gateway,
  их пустая маршрутизация версий удаляется). Откат возвращает всё как в спринте 4 (вызовы речи из `usage` удаляются).
- **0005** — подлимит речи `budget.speech_monthly_cap_usd` (5 $). **0006** (релиз 5.1) — провайдер `whisper` в `models` и
  `usage`, сид модели `whisper-base-en` (0 $); откат удаляет вызовы и модель whisper.
- **0007** (спринт 6, INTERNAL_API спринта 6 §7) — реестр: `gameplay_director` → `code`/`active`, `implemented_in =
  gamification` (правила игры кодом: XP и тилы за подтверждённые действия, задания дня, значки, ступени героя; модель не
  вызывается — invoke отвечает 404 `AGENT_NOT_ACTIVE`, версии — 409 `AGENT_NOT_LLM`); пустая маршрутизация версий
  удаляется. Откат — строка спринта 5 (`llm`/`planned`, спринт 6, `registry.AGENTS_SPRINT5`) и пустая маршрутизация.
  `check_seed.py` сверяет реестр (`domain/registry.py`, разбор AST) с ai.ts `AgentId`, ожидаемыми code-агентами и
  файлами сида (у code-агентов их нет).
- Золотые прогоны: не больше `GOLDEN_RUNS_DAILY_LIMIT` (20) в сутки по Ташкенту на все агенты (429 `TEST_RUNS_LIMIT`);
  аварийная остановка прогон **не** блокирует (проверка сотрудником перед включением ИИ), месячный потолок —
  учитывается (ревью R1-11).

## Оценка произношения (`pronunciation_coach`, implementation `code`; INTERNAL_API §1.9, §3.2; AT-58)
`POST /internal/v1/speech/pronunciation` — вызывающий **только memory**. Тело — WAV (PCM 16 бит, моно, 16 000 Гц,
0,5..15 с, ≤ 600 000 байт), `Content-Type: audio/wav`; заголовок `X-Speech-Meta` = base64url(JSON `SpeechAssessMeta
{request_id, user_id, audience, locale, reference_text 1..200, language: "en-US"}`). Ответ — всегда 200
`PronunciationResult` (ai.ts).

| Ошибка | Когда |
|---|---|
| 401 `INTERNAL_TOKEN_MISSING` / `USER_CONTEXT_REQUIRED` | нет токена / в токене нет `sub` |
| 403 `CALLER_NOT_ALLOWED` | вызывающий не memory |
| 403 `USER_CONTEXT_MISMATCH` | `user_id` меты ≠ `sub` / `lrn` токена |
| 422 `SPEECH_META_INVALID {errors}` | нет заголовка, не base64url, не JSON, поля не по контракту (значения не возвращаются) |
| 422 `AUDIO_INVALID {reason: format \| too_short \| too_long \| too_large}` | не RIFF/WAVE, не PCM 16 бит моно 16 кГц, не `audio/wav`; < 0,5 с; > 15 с; > 600 000 байт |
| 422 `IDEMPOTENCY_KEY_REUSED`, 409 `IDEMPOTENCY_IN_PROGRESS` | тот же `request_id` с другой метой/аудио; дубль не дождался первого |

**Провайдер** — `SPEECH_PROVIDER`: `whisper` (по умолчанию, релиз 5.1), `azure` (запасной), `fake` (стенд и тесты).
Все отдают ответ в формате Azure, дальше общий разбор, советы, учёт и идемпотентность (ниже).

**whisper (свой сервер, релиз 5.1).** Запись уходит в сервис tts `POST {TTS_URL}/internal/v1/recognize` (общий
`ServiceClient`, сырое тело `audio/wav`; в токене нет ученика — tts незачем знать, чья запись; эталон в tts не
передаётся — иначе распознаватель «исправит» произношение). Ответ tts `{text, words: [{word, start_ms, end_ms,
probability}], duration_ms, model}` сравнивается с эталоном в `domain/word_score.py` — это оценка **разборчивости
слов** (узнал ли распознаватель слово и насколько уверенно), без оценки отдельных звуков:
- нормализация как в memory (§1.6): регистр, апострофы, краевая пунктуация, сокращения в обе стороны (I'm = I am,
  can't = cannot = can not, …), слова через дефис — части одного слова, числа цифрами — словами (25 = twenty-five,
  10:40 = ten forty, 20th = twentieth);
- выравнивание Левенштейном по словам (части слов; совпадение 0, замена / пропуск / лишнее — 1): совпало —
  `accuracy = round(probability × 100)`, при probability < 0,5 — `mispronunciation`; замена — `mispronunciation`,
  accuracy = 10 + 40 × похожесть написания (≤ 50); пропуск — `omission` (0); лишнее слово — `insertion` (accuracy
  null, на своём месте); не больше 40 слов (лишние отбрасываются первыми);
- scores: accuracy — среднее по словам эталона; completeness — доля слов эталона, распознанных целиком, × 100;
  fluency — 100 − паузы (пауза ≥ 0,7 с — 10, ≥ 1,5 с — 20, вместе ≤ 60) − медленный темп ((1,5 − слов/с) × 40, ≤ 40;
  слов/с — по отрезку от начала первого до конца последнего слова; одно слово — 100); pron = 0,6 × accuracy +
  0,2 × fluency + 0,2 × completeness; confidence — средняя probability распознанных слов;
- insufficient_evidence: нет слов → `not_recognized`, confidence < 0,4 → `low_confidence`, completeness < 30 →
  `incomplete`.
Денег не стоит: модель `whisper-base-en` 0 $ (`cost_usd` 0, учёт в `usage` с `provider whisper` и `audio_ms`), **бюджеты
ИИ и подлимит речи не проверяются и не тратятся**; аварийная остановка действует. `speech_available`: нет остановки,
`TTS_URL` задан, модель включена (сеть на каждом статусе не проверяется). Ошибки tts: сеть (tts не отвечает), 502/504 —
один повтор по общим правилам; 503 `RECOGNITION_UNAVAILABLE` (tts не успел или модель упала), 4xx и неверный ответ —
без повтора (CPU tts не перегружается) → `unavailable: provider_error` (код — `speech.last_error`: `network`,
`http_503`, `bad_response`, `circuit_open`); таймаут попытки → `unavailable: timeout`.

**Общий порядок:** аварийная остановка → `unavailable: ai_disabled`; провайдер не настроен (whisper — нет `TTS_URL`;
azure — нет `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` или регион не похож на регион Azure) или модель речи выключена в
админке → `unavailable: not_configured`; для платных провайдеров (azure, fake) — бюджет (месяц UTC, подлимит речи,
ученик за день по Ташкенту) по оценке стоимости длительности → `unavailable: budget_exceeded` — всё **до** вызова
провайдера.

**azure (запасной).** Azure REST для короткого аудио: `POST https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/
cognitiveservices/v1?language=en-US&format=detailed`, заголовки `Ocp-Apim-Subscription-Key`, `Content-Type: audio/wav;
codecs=audio/pcm; samplerate=16000`, `Accept: application/json`, `Pronunciation-Assessment` = base64(JSON
`{ReferenceText, GradingSystem: HundredMark, Granularity: Word, Dimension: Comprehensive, EnableMiscue: true}`); тело —
WAV как есть. Таймаут попытки ≤ 12 с; **один повтор** при 5xx или сетевой ошибке, если до дедлайна (14,5 с от приёма —
memory ждёт 15 с) осталось ≥ 4 с; таймаут, 4xx и неразборчивый ответ не повторяются (`unavailable: timeout |
provider_error`, код — в `speech.last_error` админки).

Разбор `NBest[0]` (баллы — в элементе в формате REST или в `PronunciationAssessment` в формате SDK; читаются оба):
`RecognitionStatus ≠ Success` → `insufficient_evidence: not_recognized`; `Confidence < 0,4` → `low_confidence`;
`CompletenessScore < 30` → `incomplete` (баллов, слов и советов нет). Иначе `scores {accuracy, fluency, completeness,
pron}` 0..100, `words ≤ 40 [{word, accuracy, error_type: none | omission | insertion | mispronunciation}]`,
`intelligibility` clear (pron ≥ 80) | mostly_clear (60..79) | needs_practice (< 60). Нет баллов у распознанной речи —
`unavailable: provider_error` (`bad_response`). Советы (`domain/speech.py`, скилл 08): ≤ 2 — `mispronunciation` с
точностью < 60 и `omission`, сначала самые низкие, одно слово — один совет; RU/UZ по `locale`; детям (audience kids
или claims токена `lrn ≠ sub` / `age_band` 6–13) — мягкий вариант на «ты»; слова «акцент» нет ни в одном шаблоне.

Учёт — строка `usage`: `agent_id pronunciation_coach`, `model_id azure-speech-pa | fake-speech`, `provider
azure_speech | fake_speech`, `session_kind memory`, `audio_ms`, `cost_usd = audio_ms / 3 600 000 × audio_usd_per_hour` за
каждую оплаченную попытку (успех, `insufficient_evidence`, ответ 200 с неразборчивым телом, таймаут — консервативно;
5xx, сеть, 4xx — 0). `insufficient_evidence` — `status ok` с причиной (`not_recognized | low_confidence | incomplete`).

**Аудио не хранится нигде:** тело читает `SpeechBodyMiddleware` (снаружи общего middleware, только этот маршрут: общий
лимит тела сервисов — 256 КиБ, `tilhero_common.app`), байты — в состоянии запроса до его конца; провайдеру — тело
запроса; в БД, Redis, логи и события не пишутся. Идемпотентность — `request_id` 24 ч: в Redis только JSON результата
(эталон и слова, без аудио), отпечаток — хеш меты и SHA-256 аудио. В логах — статус, причина, `audio_ms`, задержка,
попытки. Ключ Azure — только переменная окружения: не в БД, логах (ошибка httpx — только тип), ответах и `repr`.

**fake** (`SPEECH_PROVIDER=fake`, стенд и тесты; в stage/prod запрещён): средняя |амплитуда| < 200 →
`insufficient_evidence: not_recognized`; иначе слова эталона с точностью 90, слова ≥ 8 букв — 55 и `mispronunciation`;
модель `fake-speech` стоит 0.

## Бюджеты (решение владельца 19.11.2026)
`budget` (singleton): `ai_enabled` (аварийная остановка), `monthly_cap_usd` 20 (календарный месяц UTC),
`speech_monthly_cap_usd` 5 (подлимит речи, спринт 5),
`learner_daily_cap_usd` 0.05 (день — Asia/Tashkent), `lesson_cap_usd` 0.03 (сумма по `session_id`), `alert_percent` 80.
Перевод по тапу (`gloss_word`, `session_kind: memory`) — из лимитов месяца и ученика в день; лимит урока к дневной
сессии memory не применяется (занятия нет). Оценка произношения входит в те же месяц и лимит ученика в день (резерв —
оценка стоимости длительности, $1,32 за час аудио по умолчанию; лимит урока к ней не применяется — сессии нет) и, кроме
того, в **подлимит речи** `speech_monthly_cap_usd` (решение владельца 20.11.2026: 5 $ в месяц внутри общих 20 $,
календарный месяц UTC, миграция 0005): не помещается оценка записи → `unavailable: budget_exceeded`; потрачено на речь
за месяц ≥ подлимита → `speech_available=false` («Произнести» скрыто). Вызовы агентов подлимит не проверяют. Подлимит —
поле `AiBudget` (всегда в ответе), в `PUT /budget` обязателен, 0..`monthly_cap_usd` (больше потолка → 422
`BUDGET_INVALID {fields}`; в БД — CHECK), правка — costs.manage (+ step-up в admin-bff), аудит `ai.budget_updated`; в
сводке — `speech.cap_usd`.
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

- `SPEECH_PROVIDER=whisper` (по умолчанию, релиз 5.1): распознавание — сервис tts (`TTS_URL`, faster-whisper), сравнение
  слов с эталоном — здесь; ключ не нужен. `SPEECH_PROVIDER=azure` (запасной): Azure AI Speech REST для короткого аудио
  через httpx (`providers/speech.py`), ключ — `AZURE_SPEECH_KEY`, регион — `AZURE_SPEECH_REGION`.
  `SPEECH_PROVIDER=fake` — тесты и стенд e2e (в stage/prod запрещён).

**Как добавить ключ:** Railway → сервис ai-gateway → Variables → `ANTHROPIC_API_KEY` (вводит владелец), `AI_PROVIDER=
anthropic`; redeploy. Ключ живёт только в переменной окружения ai-gateway: не в БД, не в логах, не в ответах; в админке —
только «задан / не задан» (`GET /admin/v1/ai/provider`). Без ключа все вызовы — `unavailable: ai_disabled`, уроки идут
без ИИ.

**Ключ Azure Speech (решение владельца 20.11.2026):** Railway → общие переменные проекта (Shared Variables) →
`AZURE_SPEECH_KEY` (ключ ресурса Speech) и `AZURE_SPEECH_REGION` (регион ресурса, например `westeurope`); у ai-gateway
уже заданы ссылки `AZURE_SPEECH_KEY=${{shared.AZURE_SPEECH_KEY}}`, `AZURE_SPEECH_REGION=${{shared.AZURE_SPEECH_REGION}}`,
`SPEECH_PROVIDER=azure` (с релиза 5.1 по умолчанию — `whisper`; Azure включается заменой на `azure`); redeploy
ai-gateway. Пустые переменные — «не настроено»: `speech_available=false`, кнопки
«Произнести» нет, уроки и повторения идут без неё. Проверка — `GET /admin/v1/ai/provider` → `speech.key_configured`,
`speech.region`; цена часа аудио — `PUT /admin/v1/ai/models/azure-speech-pa` (по умолчанию 1.32; бесплатный уровень
Azure F0 — 5 ч в месяц, шлюз его не учитывает и считает по цене).

## События
- Публикует: `admin.audit.recorded.v1` (аудит), `user.domain.deleted.v1 {domain: "ai-gateway", mode: "anonymized"}`,
  `ai.degradation.changed.v1` (спринт 8, смена действующего уровня).
- Потребляет (спринт 8): `billing.access.changed.v1` (только billing) → `learner_tiers`; `lesson.session.completed.v1`,
  `lesson.pair.completed.v1` (только lessons) → `session_costs`.
- Потребляет: `user.deletion.requested.v1` (только от identity-consent; inbox) → `usage.user_id = NULL` (вызовы агентов и
  оценки произношения), `deleted_users`, кеш результатов вызовов и оценок произношения ученика в Redis стирается (аудио
  не хранилось нигде).

## Данные
`agents` (сид 17), `models` (сид: claude-haiku-5-5 0.10/0.50, claude-sonnet-5-5 2.00/10.00, fake 0/0; речь —
`audio_usd_per_hour`: azure-speech-pa 1.32, fake-speech 0 — миграция 0004; whisper-base-en 0 — миграция 0006),
`agent_versions` (триггер неизменяемости),
`agent_rollout` (только LLM-агенты), `golden_cases`, `test_runs` (завершённый неизменяем), `budget`, `usage` (только
метаданные вызова; речь — + `audio_ms`), `deleted_users`, `learner_tiers`, `session_costs`, `degradation_events`
(спринт 8), `outbox`, `inbox`.

## Настройки
`AI_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` (тесты), `AI_ALLOW_FAKE_TEST_PUBLISH` (dev/test; на стенде ещё
и публикация черновиков сида по прогону на fake при старте), `SPEECH_PROVIDER` (whisper | azure | fake), `TTS_URL` (whisper), `AZURE_SPEECH_KEY`,
`AZURE_SPEECH_REGION`, `SEED_DIR`,
`TIMEZONE` (Asia/Tashkent), `GOLDEN_RUN_MAX_AGE_DAYS` (14), `GOLDEN_RUN_STALE_MINUTES` (60), `GOLDEN_RUNS_DAILY_LIMIT`
(20), `INVOKE_CACHE_TTL_SECONDS`
(86400), `CACHE_NAMESPACE`, общие `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `REDIS_URL`, `NATS_URL`, внутренний JWT.

## Runbook
- **Авария провайдера / расходы:** `POST /admin/v1/ai/emergency-stop {enabled: true}` — все вызовы `ai_disabled`.
- **Потолок месяца на исходе (спринт 8):** `PUT /admin/v1/ai/degradation {mode: manual, manual_level: paid_only}`
  (TOTP) — ИИ только подписчикам и резервной моделью; возврат — `{mode: auto, manual_level: null}`. Пороги авто —
  `economy_at_percent` / `paid_only_at_percent`; история смен — `GET /admin/v1/ai/degradation`.
- **Регрессия версии:** `POST /agents/{id}/rollback` (снимает и канарейку).
- **Прогон «завис» в running** (рестарт процесса): при старте прогоны старше 60 минут помечаются `failed`.
- **Произношение не работает:** `GET /admin/v1/ai/provider` → `speech`. whisper: `key_configured` — задан ли
  `TTS_URL`; `last_error`: `network` / `circuit_open` — tts не отвечает (логи и здоровье сервиса tts), `http_503` — tts не
  успел распознать (нагрузка: `ASR_CONCURRENCY`, `ASR_BEAM_SIZE`, `ASR_TIMEOUT_SECONDS` у tts), `timeout`. azure:
  ключ/регион, `http_401` — неверный ключ, `http_429` — лимит ресурса Azure. Выключить без аварийной остановки ИИ —
  `PUT /admin/v1/ai/models/<whisper-base-en | azure-speech-pa> {active: false}` (→ `not_configured`, кнопка скрыта).
- **Переключиться на Azure** (запасной): `SPEECH_PROVIDER=azure` + ключ и регион (выше); обратно — `whisper`.
- **teaching_coach v2 в prod:** `POST /admin/v1/ai/agents/teaching_coach/versions/2/test-runs` (anthropic) → при
  `passed_mandatory` — `POST …/versions/2/publish`. До этого `gloss_word` → `refused: agent_not_active` (перевод только
  из словаря курса).
- Тесты: `uv run pytest services/ai-gateway -q -p no:cacheprovider` (стенд `infra/dev/stack.sh up`).
