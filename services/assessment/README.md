# assessment (8113, схема `assessment`, пакет `tilhero_assessment`)

Независимая оценка TilHero (AT-44, AT-45, AT-47, AT-52): закрытые задания — правилами по ключам **опубликованной
версии catalog** (не по данным lessons), свободный текст ученика — независимым оценщиком `independent_evaluator`
через ai-gateway; ошибки с доказательствами, исходы навыков, неизменяемые оценки и цепочки переоценок, апелляции,
QA-флаги. Контракты: `docs/sprint4/INTERNAL_API.md` §3, `packages/contracts/src/ai.ts` (IndependentEvaluator*,
ConfirmedError), `bff.ts` «Спринт 4» (EvaluationView, Appeal), `admin.ts` «Контроль диалогов» (EvaluationCard,
Reevaluation, AdminAppeal, AppealDecision), события `assessment.completed.v1`, `assessment.reevaluated.v1`,
`assessment.appeal.decided.v1`. Скилл — LinguaFlow `skills/05_independent_evaluator.md`.
Спринт 5 (`docs/sprint5/INTERNAL_API.md` §5, §1.2): оценка чтения (kind `reading`) и лента ошибок для memory
(`memory-feed`).

## Запуск и настройки
`python -m tilhero_common.serve tilhero_assessment.main:app`; миграции — `alembic upgrade head` (под
`MIGRATION_DATABASE_URL`).

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `CATALOG_URL` | `http://127.0.0.1:8110` (dev/test) | catalog `GET /internal/v1/versions/{kind}/{key}/{version}`; **в stage/prod обязателен** |
| `CATALOG_TIMEOUT_SECONDS` | 3 | таймаут catalog (GET — 2 повтора при сбое сети/5xx) |
| `CONTENT_CACHE_SIZE` | 512 | кеш версий контента (бессрочный — версии неизменяемы; вытеснение LRU) |
| `AI_GATEWAY_URL` | `http://127.0.0.1:8114` (dev/test) | ai-gateway `POST /internal/v1/agents/independent_evaluator/invoke`; **в stage/prod обязателен** |
| `AI_GATEWAY_TIMEOUT_SECONDS` | 26 | таймаут оценщика без повторов (≥ 26 с: попытка v2 до 12 с + повтор/резервная модель); шлюзу — `deadline_ms` = таймаут − 1 с (ревью R1-03); таймаут → оценка без открытой части. Цепочка: BFF finish > lessons → assessment > этот > дедлайн шлюза |
| `EVALUATOR_MIN_CONFIDENCE` | 0.5 | уверенность оценщика ниже порога → `requires_human_review` (баллы не меняются) |
| `APPEAL_WINDOW_DAYS` | 14 | окно подачи апелляции от создания актуальной оценки |
| `STATS_TIMEZONE` | `Asia/Tashkent` | граница «сегодня» в статистике |
| `SCHEDULER_TOKEN` | пусто (вход выключен) | `Authorization: Bearer` для n8n `assessment-tick`; в stage/prod — пусто или ≥ 32 символов |
| `APPEAL_REASON_RETENTION_DAYS` | 90 | текст апелляции стирается через N дней после решения (ревью R1-14) |
| `TICK_BATCH_SIZE` | 500 | сколько апелляций стирает один tick |
| `MEMORY_EVIDENCE_RETENTION_DAYS` | 90 | `memory-feed`: цитата ученика (`evidence`) не отдаётся для сессий старше N дней (срок хранения текста ученика — как реплики в lessons и цитата в карточке memory); оценка не меняется |

## API
Вызывающие и `sub`: lessons — оценка (`sub` = ученик `lrn`); telegram-bff — оценки и апелляции ученика (`sub` =
`lrn`); memory — лента ошибок для карточек (`sub` = ученик, `user_id` из события); admin-bff — админка с `actor`
(права проверяются здесь). Ошибки — ErrorBody.

**lessons** — `POST /internal/v1/evaluations` (`EvaluationRequest` ниже) → 201 `EvaluationView` + `session_id`,
`skill_outcomes` [{skill_id, outcome}] (practice_only — []), `requires_human_review`; повтор по `session_id` → 200 та
же актуальная запись цепочки (`Idempotent-Replayed: true`; без пересчёта, вызовов ИИ и событий). 409
`SESSION_CONFLICT` (сессия другого ученика), 410 `USER_DELETED`, 422 `USER_MISMATCH | CONTENT_REFS_INVALID {reason} |
CONTENT_REF_INVALID {kind, key, version} | ANSWERS_INVALID {reason, item_id?} | TURNS_INVALID | OUTCOME_INVALID |
VALIDATION_ERROR`, 503 `CATALOG_UNAVAILABLE | CATALOG_INVALID_RESPONSE` (без ключей оценка невозможна — повторить) |
`EVALUATION_IN_PROGRESS` (ai-gateway ответил 409 IDEMPOTENCY_IN_PROGRESS: оценщик этой сессии ещё работает в другом
запросе — повтор finish или tick; partial **не** записывается, lessons повторит, шлюз отдаст сохранённый результат;
ревью R1-04).

```
EvaluationRequest {
  session_id: uuid, user_id?: uuid (= sub токена), kind: lesson|scenario|media|review|reading,
  pair_id: "ru-en", audience: kids|teens|adults, locale?: ru|uz (ru),
  content_refs: [{kind: lesson|scenario|rubric|media_asset|media_exercise|reading, key, version}]
              | {lesson?, scenario?, rubric?, media_asset?: {key, version} | null, media_exercises?: [{key, version}],
                 reading?: {key, version} | null},
  answers: [{item_id, answer: int | string | (string|int)[] | null, hinted?: bool, dont_know?: bool}],  // без правильности
  turns: [{turn_id: "T{n}", speaker: learner|character, text ≤ 500, mode?: choice|text, hinted?: bool, node_id?}],
  roleplay: {outcome: success|alt_success|fail|null, hints: int} | null,
  open_answer: {text ≤ 500, prompt?: string} | null,
  practice_only?: bool
}
```
Формы ссылок: lesson — lesson + rubric (= lesson.rubric_id) [+ scenario (= lesson.scenario_id)]; scenario — scenario +
rubric (= scenario.rubric_id); media — media_exercise ≥ 1 (одного медиа) [+ media_asset] + rubric (одна из рубрик
упражнений); review — как у исходной сессии (урок или медиа), всегда practice_only; reading — только `reading`
(рубрика встроенная, ссылка на рубрику — 422), всегда practice_only, без `turns`/`roleplay`/`open_answer` (422
`TURNS_INVALID {reason: closed_only}`). Ссылка `reading` у других видов — 422 `CONTENT_REFS_INVALID`. Ответы: choice — индекс варианта
в порядке контента (или точный текст варианта); gap_fill — строка; order_words / order_lines — строки по порядку
(или индексы вариантов); `null`/`dont_know` — без ответа (неверно). Поля правильности в запросе отклоняются (422).

**ученик (telegram-bff)** — `GET /internal/v1/evaluations/{id}` → `EvaluationView` **актуальной записи цепочки**
(запрошенная заменена переоценкой → `superseded_by` = id показанной записи; иначе null); чужая — 404;
`POST /internal/v1/evaluations/{id}/appeal {reason ≤ 500}` (Idempotency-Key обязателен) → 201 `Appeal` (повтор — 200);
409 `APPEAL_EXISTS {appeal_id}` (одна на оценку сессии) | `APPEAL_WINDOW_CLOSED {closed_at}` | `APPEAL_NOT_ALLOWED`
(practice_only); `GET /internal/v1/appeals?cursor=&limit=` → `{items: Appeal[], next_cursor}` (свои, новые первыми).
`Appeal.reason` — `null`, если текст стёрт по сроку хранения (90 дней после решения; контракт bff.ts — запрос к общему
коду: `reason: string | null`).
Детский профиль — апелляции разрешены (уведомление о решении — опекуну, правила notifications).

**админка (admin-bff)** — формы admin.ts, но сотрудники — id (`created_by`, `taken_by`, `decided_by`,
`flags[].by`; имена подставляет admin-bff); в карточке дополнительно `kind`, `outcome`, `ai_status`,
`superseded_by`, `appeal_id`, `appeal` (AdminAppeal цепочки). В `AdminAppeal` — `reason: string | null` и
`reason_redacted: boolean` («текст стёрт по сроку хранения», ревью R1-14; admin.ts — запрос к общему коду).

**memory** — `GET /internal/v1/evaluations/{id}/memory-feed` (спринт 5, INTERNAL_API §5) → `MemoryFeed` ниже;
вызывающий только memory (иначе 403 `CALLER_NOT_ALLOWED`), без `sub` — 401 `USER_CONTEXT_REQUIRED`; чужая
или несуществующая оценка — 404 `EVALUATION_NOT_FOUND`; удалённый ученик — 410 `USER_DELETED`.

```
MemoryFeed {
  evaluation_id: uuid,          // АКТУАЛЬНАЯ запись цепочки (как у ученика)
  session_id, user_id: uuid, pair_id, kind: lesson|scenario|media|review|reading,
  content_refs: {               // ключи и версии для catalog GET /internal/v1/versions/{kind}/{key}/{version}
    lesson: {key, version} | null,       // урок (и review урока): key_words → карточки
    scenario: {key, version} | null,     // сценарий урока или практики
    media_asset: {key, version} | null,  // медиа (и review медиа): phrases → карточки при allowed_uses ∋ dictionary
    media_exercises: [{key, version}],   // упражнения медиа ([] у остальных)
    reading: {key, version} | null,      // текст для чтения
    rubric: {key, version} | null        // рубрика catalog (у чтения — null: встроенная)
  },
  practice_only: bool,          // review и reading — всегда true
  superseded_by: uuid | null,   // запрошенная заменена переоценкой → id актуальной (= evaluation_id); иначе null
  errors: [{turn_id, evidence: string | null, correction, error_code, severity: low|medium|high}]
}
```
- `errors` — только подтверждённые ошибки **текста ученика**: `turn_id` реплики свободным текстом `T{n}` или
  открытого ответа `OA1` (в INTERNAL_API — `O{n}`); ошибки закрытых заданий (`turn_id` = id задания) не входят —
  их повторяет очередь lessons. Детский профиль — всегда `[]` (свободного текста у детей нет; защита в глубину).
- `evidence` — цитата ученика ≤ 120; `null`, если стёрта по сроку хранения: сессии (исходной оценке цепочки) больше
  `MEMORY_EVIDENCE_RETENTION_DAYS` (90) дней — и для переоценки, скопировавшей цитату позже. Оценка в assessment не
  меняется (неизменяема, цитата — основание оценки; PLAN спринта 4).
- Переоценка: лента любой записи цепочки — данные актуальной (memory архивирует ошибки, которых в ней нет).

**планировщик (n8n `assessment-tick`)** — `POST /internal/v1/assessment:tick`, `Authorization: Bearer
<SCHEDULER_TOKEN>` (внутренний JWT сервиса → 403 `CALLER_NOT_ALLOWED`, неверный/пустой токен → 401
`SCHEDULER_TOKEN_INVALID`) → `{redacted_appeal_reasons}`. Раз в сутки достаточно; повтор безопасен.
| Маршрут | Право | Ответ |
|---|---|---|
| `GET /admin/v1/evaluations?session_id=` | qa.read | `{items: EvaluationCard[], next_cursor: null}` — цепочка (исходная → переоценки) |
| `GET /admin/v1/evaluations/{id}` | qa.read | `EvaluationCard` |
| `GET /admin/v1/evaluations/summary?session_id=…` (≤ 100) | qa.read | `{items: [{session_id, evaluation_id, status, passed, requires_human_review, reevaluated, flagged, appeal_status}]}` — для флагов журнала |
| `POST /admin/v1/evaluations/{id}/flag {reason 3..500}` (Idempotency-Key — необязателен) | qa.read | 201 `EvaluationCard`; оценка не меняется |
| `POST /admin/v1/evaluations/{id}/reevaluate Reevaluation` (Idempotency-Key — необязателен; step-up — admin-bff) | qa.review | 201 `EvaluationCard` новой записи; 409 `EVALUATION_SUPERSEDED {superseded_by} | SELF_REEVALUATION | APPEAL_DECIDED`; 422 `SCORES_INVALID | SKILL_OUTCOMES_INVALID | ERRORS_INVALID | APPEAL_MISMATCH` |
| `GET /admin/v1/appeals?status=&cursor=&limit=` | qa.read | `Page<AdminAppeal>` (старые первыми) |
| `GET /admin/v1/appeals/{id}` | qa.read | `AdminAppeal` |
| `POST /admin/v1/appeals/{id}/take` | qa.review | `AdminAppeal` (new → in_review; 409 `APPEAL_ALREADY_TAKEN | APPEAL_DECIDED`) |
| `POST /admin/v1/appeals/{id}/decide AppealDecision` (step-up — admin-bff) | qa.review | `AdminAppeal`; 409 `APPEAL_DECIDED | APPEAL_HAS_REEVALUATION`; 422 `NEW_EVALUATION_REQUIRED | NEW_EVALUATION_INVALID | NEW_EVALUATION_NOT_ALLOWED` |
| `GET /admin/v1/assessment/stats?period=today|7d|30d` | dashboard.read или qa.read | `{period, evaluations, passed, insufficient_evidence, partial, reevaluations, appeals_new, appeals_open, human_review_open}` |

Reevaluation: `scores` — Partial (не переданный критерий сохраняет балл, `null` — «не оценивался», pronunciation —
только null); `skill_outcomes` — по тем же навыкам, что в оценке (practice_only — []), `demonstrated` — только при
зачтённой рубрике и при наличии заданий навыка; `confirmed_errors` (≤ 5) — turn_id задания оценки или реплики
свободного текста; `reason` ≥ 10; `appeal_id` — апелляция той же сессии (new/in_review). Решение `corrected` —
только с `new_evaluation_id` переоценки, сделанной по этой апелляции; `upheld` — без неё (и если по апелляции
переоценки не было).

## События (outbox) и аудит
- `assessment.completed.v1 {evaluation_id, user_id, pair_id, session_id, kind, skill_outcomes, passed,
  practice_only, supersedes: null, created_at}` — новая оценка (practice_only — `skill_outcomes: []`) → diagnostics,
  memory (kind `lesson | scenario | media | review | reading`; чтение — `practice_only: true`, `skill_outcomes: []`).
- `assessment.reevaluated.v1 {evaluation_id, supersedes, session_id, user_id, pair_id, skill_outcomes, passed,
  appeal_id, created_at}` → diagnostics (может отменить demonstrated), learning-plan (`session_id` — сессия заменённой
  оценки: сопоставление с пройденным уроком).
- `assessment.appeal.decided.v1 {appeal_id, evaluation_id, user_id, decision, decided_at}` → notifications (текст
  решения не передаётся).
- `user.domain.deleted.v1 {domain: assessment, mode: deleted}` — ACK саги.
- `admin.audit.recorded.v1`: `qa.flagged` (reason — флаг сотрудника), `qa.reevaluated` (баллы до/после, исходы,
  основание), `qa.appeal_taken`, `qa.appeal_decided` (reason — решение сотрудника). Тексты ученика (реплики, ответы,
  причина апелляции) в аудит и события не попадают.
- Потребляет `user.deletion.requested.v1` (только от identity-consent, inbox `assessment.user_deletion`).

## Правила оценки (`domain/rules.py`, `domain/evaluate.py`)
- **Ключи** — только из catalog по версиям запроса (кеш бессрочный). Сравнение: single_choice / translate_choice /
  comprehension / phrase_meaning — индекс; gap_fill — без регистра, лишних пробелов и концевой пунктуации
  (`. , ! ? ; : …`), типографские апострофы = `'`; order_words / order_lines — точный порядок. Урок и медиа —
  все задания версии (без ответа — неверно), повтор — только отвеченные. shadowing и roleplay медиа не оцениваются.
- **Чтение (спринт 5)**: все вопросы версии текста (`questions`; без ответа — неверно): `single_choice` /
  `true_false` (варианты `["True", "False"]`) — индекс (или точный текст варианта), `gap_fill` — как выше (любой из
  допустимых ответов). Встроенная рубрика `reading-comprehension@1`: единственный критерий `comprehension` = доля
  верных (≥ 0,8 → 3, ≥ 0,6 → 2, ≥ 0,3 → 1, иначе 0), вердикт по одному критерию — зачёт при ≥ 2; статус `ok`;
  оценщик ИИ не вызывается; `practice_only: true`, `skill_outcomes: []` (навыки не меняются); апелляция — 409
  `APPEAL_NOT_ALLOWED`; ошибки — неверные вопросы (`turn_id` = id вопроса) — в итогах ученика, но не в `memory-feed`.
  Переоценка — по той же встроенной рубрике (только `comprehension`, без исходов навыков).
- **Критерии по правилам**: vocabulary, grammar, fluency, pronunciation — null; task — исход сценария (success 3,
  alt_success 2, fail 1; не дошёл до конца или ни одной реплики ученика — 0), без ролевой ситуации (медиа, урок без
  сценария) — доля верных закрытых заданий (≥ 0,8 → 3, ≥ 0,6 → 2, ≥ 0,3 → 1, иначе 0); independence — подсказки
  (0 → 3, 1 → 2, 2 → 1, 3+ → 0; подсказки сцены = max(roleplay.hints, подсказанные реплики) + подсказанные задания);
  comprehension — доля верных закрытых заданий; у медиа vocabulary — доля верных gap_fill и phrase_meaning.
- **Оценщик** — только при свободном тексте ученика (реплики `mode=text`, открытый ответ) и не детям. Контекст —
  строго `IndependentEvaluatorContext` (рубрика, задача и исход, реплики сцены и открытый ответ `OA1` с заданием
  `Q1`, подсказки, целевой уровень); описательные поля `*_en` (goal_en, completion_criteria_en, descriptor_en) —
  русская локализация из catalog при любом языке ученика (ai.ts, INTERNAL_API §9), реплики ученика — как есть; `request_id` = uuid5(session_id) — повтор не
  оплачивается дважды. Наложение: pronunciation и fluency — всегда null (по тексту не оцениваются);
  independence — по правилам; comprehension — по правилам при закрытых заданиях; task — не выше исхода по графу;
  vocabulary, grammar — оценщик. `pronunciation_score` и `cefr_certificate` вывода не используются вовсе.
- **Статус**: оценённых критериев < 2 → `insufficient_evidence` (вердикта нет); оценщик ответил
  `insufficient_evidence` (в свободном тексте нет доказательств), но правила оценили ≥ 2 критериев → `partial`:
  баллы и вердикт, исходы навыков — по правилам, критерии оценщика — null, `requires_human_review` — как решил оценщик
  (флаг или уверенность < порога) (ревью R1-01); оценщик недоступен / отказал / ответ не по схеме → `partial`
  (≥ 2 критериев по правилам) или `pending_review`, `requires_human_review = true`; иначе `ok`
  (`requires_human_review` — по флагу оценщика или уверенности < порога).
- **Зачёт** — по оценённым критериям: weighted = Σw·s / Σw (null не входят) ≥ `min_weighted` и каждый ≥
  `min_per_criterion`.
- **Навыки**: навыки урока (основной + дополнительные), сценария, медиа (+ навыки заданий); `demonstrated` — верно
  **без подсказок** ≥ 2/3 заданий навыка (не меньше 1) и рубрика зачтена; иначе `learning`; без заданий —
  `not_assessed`. practice_only и review — исходов нет.
- **Ошибки**: оценщика — только с turn_id реплики **свободного текста** и цитатой, дословно (с точностью до пробелов)
  встречающейся в ней, ≤ 120 (выбранные варианты — текст контента, не ошибка); неверные закрытые задания — ответ
  ученика (цитата) и верный ответ ключа, `severity: medium`; хранится ≤ 5 по severity, ученику — 1–3.

## Данные (миграции 0001–0003)
`evaluations` (неизменяема — триггер `evaluations_immutable`; DELETE — только сага; у сессии одна исходная запись —
частичный UNIQUE, цепочка линейна — UNIQUE `supersedes`; снимок рубрики версии; метаданные реплик без текста),
`appeals` (одна на сессию; триггер `appeals_guard`: поля подачи неизменяемы, переходы new → in_review →
upheld|corrected, решённая неизменяема — кроме стирания текста по сроку хранения: `reason` → NULL с
`reason_redacted_at`, миграция 0002), `flags` (append-only), `deleted_users`, `outbox`/`inbox`. Миграция 0003 —
`evaluations.kind` + `reading` (откат удаляет оценки чтения и флаги к ним).

## Срок хранения текстов ученика (ревью R1-14)
- `appeals.reason` — 90 дней после решения (`upheld`/`corrected`), затем NULL (tick); нерешённые не стираются.
- Оценки не стираются: цитаты-доказательства ошибок (≤ 120) и исправления остаются в assessment (PLAN «Хранение
  реплик»); копию оценки в lessons через 90 дней чистит `lessons-tick`.

## Сага удаления
`user.deletion.requested.v1` → апелляции, флаги и все оценки ученика удаляются физически, отметка `deleted_users`,
ACK. После удаления запросы ученика и lessons — 410 `USER_DELETED`. Агрегаты статистики не хранятся.

## Runbook
- `CATALOG_UNAVAILABLE` у lessons — catalog недоступен: lessons повторяет завершение (оценка идемпотентна).
- `EVALUATION_IN_PROGRESS` у lessons — оценщик этой сессии ещё работает в параллельном запросе: lessons повторяет
  через tick, результат первого вызова шлюз отдаёт из кеша (без повторной оплаты).
- n8n `assessment-tick` не настроен — тексты апелляций не стираются: проверить `SCHEDULER_TOKEN` и workflow.
- Рост `human_review_open` на обзоре — ИИ недоступен или исчерпан бюджет (`ai_status` в карточке оценки); разбор —
  переоценкой (qa.review).
- Тесты: `uv run pytest services/assessment -q -p no:cacheprovider` (стенд PostgreSQL; catalog и ai-gateway —
  заглушки на реальном сиде catalog; текст для чтения — фикстура `READINGS` в `tests/as_testkit.py`).
