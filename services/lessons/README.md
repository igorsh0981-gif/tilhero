# lessons (8112, схема `lessons`, пакет `tilhero_lessons`)

Оркестратор урока 20 минут TilHero (AT-39…48, AT-52; навык `learning_orchestrator` — **код, не LLM**): сессии урока,
сценария («Разыграть»), медиа, повтора и чтения (спринт 5, AT-57); машина состояний на сервере; этапы и шаги; пауза и
восстановление;
ролевая ситуация по графу сценария (выбор реплик всегда, свободный текст — через `conversation_partner`);
«объясни проще» (`teaching_coach`); итоги с **независимой** оценкой (assessment); журнал сессий для «Контроля
диалогов». Контракты: `docs/sprint4/INTERNAL_API.md` §2, `docs/sprint5/INTERNAL_API.md` §4 (чтение),
`packages/contracts/src/bff.ts` («Спринт 4», «Спринт 5»: шаг `reading`, `ReadingView`, `ReadingCard`), `admin.ts`
(SessionRow / SessionCard / Transcript / LessonStats), `ai.ts` (контексты агентов, `SessionKind`), `content.ts`
(`ReadingPayload`); события `lesson.session.*` (kind + `reading`).

## Запуск и настройки
`python -m tilhero_common.serve tilhero_lessons.main:app`; миграции — `alembic upgrade head` (под
`MIGRATION_DATABASE_URL`).

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `CATALOG_URL` | `http://127.0.0.1:8110` | пары, снимок курса, версии контента с ключами, упражнения к медиа, тексты для чтения — **обязателен в stage/prod** |
| `AI_GATEWAY_URL` | `http://127.0.0.1:8114` | `conversation_partner`, `teaching_coach` — **обязателен в stage/prod** |
| `ASSESSMENT_URL` | `http://127.0.0.1:8113` | `POST /internal/v1/evaluations` — **обязателен в stage/prod** |
| `LEARNING_PLAN_URL` | `http://127.0.0.1:8102` | следующий урок в итогах — **обязателен в stage/prod** |
| `DIAGNOSTICS_URL` | `http://127.0.0.1:8111` | карта навыков: «было» в итогах, порядок предпосылок повторения — **обязателен в stage/prod** |
| `SCHEDULER_TOKEN` | пусто (вход выключен) | `Authorization: Bearer` n8n `lessons-tick`; в stage/prod — пусто или ≥ 32 символов |
| `CATALOG_TIMEOUT_SECONDS` / `AI_TIMEOUT_SECONDS` / `ASSESSMENT_TIMEOUT_SECONDS` / `AUX_TIMEOUT_SECONDS` | 3 / 20 / 32 / 3 | таймауты клиентов (ИИ и оценка — без повторов в клиенте); цепочка — раздел «Таймауты» |
| `AI_STATUS_TIMEOUT_SECONDS` | 2 | `GET ai-gateway /internal/v1/status` при старте занятия: нет ответа — режим full (как ошибка связи) |
| `SUMMARY_AUX_TIMEOUT_SECONDS` / `SUMMARY_REFRESH_TIMEOUT_SECONDS` | 2 / 5 | итоги: «было» навыков + названия (параллельно) и следующий урок — каждый этап ≤ 2 с, иначе без них; повторное чтение оценки в `GET …/summary` ≤ 5 с, иначе сохранённая копия |
| `USER_REF_SECRET` | dev-значение | ключ HMAC псевдонима ученика `user_ref` в карточке сессии — **обязателен в stage/prod** (≥ 32 символов; генерирует `infra/railway/setup.py`); смена меняет все `user_ref` |
| `PAIRS_CACHE_TTL_SECONDS` / `SNAPSHOT_REVALIDATE_SECONDS` / `PUBLISHED_CACHE_SECONDS` | 60 / 30 / 30 | кеши catalog; версии — бессрочно (LRU `VERSIONS_CACHE_SIZE` = 1024) |
| `INACTIVITY_MINUTES` / `PAUSE_EXPIRY_HOURS` / `READY_EXPIRY_HOURS` | 10 / 72 / 24 | авто-пауза, истечение паузы и неначатой сессии |
| `TEXT_RETENTION_DAYS` | 90 | срок хранения свободных реплик и открытых ответов |
| `REVIEW_DELAY_DAYS` | 1 | ошибка/подсказка → задание вернётся в повторение через N дней |
| `EVALUATION_RETRY_DAYS` | 7 | повторная отправка в assessment сессий без оценки (дальше — `failed`) |
| `STATS_TIMEZONE` | `Asia/Tashkent` | граница «сегодня» в статистике админки |
| `PRACTICE_DURATION_MIN` | 10 | длительность практики (сценарий, медиа, повтор, чтение) для ограничения minutes (≤ 2× длительности) |
| `SOCIAL_URL` / `IDENTITY_CONSENT_URL` | `http://127.0.0.1:8109` / `:8101` | спринт 7: связь учеников и member_id → user_id; согласие на голос — **обязательны в stage/prod** |
| `MEMBER_ID_KEY` | dev-значение | спринт 7: ключ member_id (общий с social и gamification) — **обязателен в stage/prod** (≥ 32) |
| `DUEL_ITEMS` / `DUEL_PLAY_HOURS` | 10 / 48 | заданий в наборе дуэли; срок, если gamification не передал `play_deadline` |
| `PAIR_ROOM_MAX_MINUTES` | 20 | длительность парной комнаты в in_progress (wrap_up — за 2 минуты) |
| `PAIR_INVITE_MINUTES` / `PAIR_SCHEDULE_DAYS` | 15 / 7 | ответ на приглашение (и вход после start_at); планирование вперёд |
| `PAIR_OFFLINE_SECONDS` / `PAIR_RECONNECT_MINUTES` / `PAIR_INACTIVITY_MINUTES` | 30 / 3 / 10 | offline без heartbeat; возврат без новой сессии; завершение без активности |
| `PAIR_SILENCE_SECONDS` | 60 | молчание в свой ход — напоминание коуча (один раз за ход); предел секунд речи без голоса на ход |
| `PAIR_POLL_SECONDS` / `PAIR_POLL_INTERVAL_SECONDS` | 20 / 1 | long-poll ленты (контракт ≤ 25 с) и опрос БД (другие экземпляры) |
| `PAIR_AUDIO_MINUTES` / `PAIR_STARTING_MINUTES` | 5 / 5 | срок audio_id; «скоро начнётся» до start_at |
| `PAIR_AI_ROOMS_PER_DAY` | 5 | комнат с ИИ-коучем на ученика в сутки (STATS_TIMEZONE); сверх — комната сценарием с выбором реплик; 0 — без коуча |

## API ученика (только `telegram-bff`; ученик — claim `lrn`, аккаунт — `sub`, возраст — claim `age_band`)
Чужая сессия → 404 `SESSION_NOT_FOUND`. Ключей ответов в ответах нет никогда; правильность проверки без подсказок —
только в итогах (EvaluationView от assessment). Query: `pair_id` (по умолчанию `ru-en`), `audience` (подсказка BFF;
детский профиль не понижается), `locale` ru|uz (язык вариантов проверки понимания и объяснений ИИ).

| Метод и путь | Ответ |
|---|---|
| `GET /internal/v1/lessons/{lesson_id}/card` | `LessonCardDetail` (404 `LESSON_NOT_AVAILABLE`) |
| `POST /internal/v1/lessons/{lesson_id}/sessions` (Idempotency-Key) | 201 `LessonSession` (`ready`); повтор — 200 `Idempotent-Replayed`; 409 `SESSION_ACTIVE {session_id, kind, title}` / `PAIR_NOT_AVAILABLE`; 404 `LESSON_NOT_AVAILABLE`; 422 `IDEMPOTENCY_KEY_REUSED` |
| `POST /internal/v1/scenarios/{id}/sessions`, `POST /internal/v1/media/{asset_id}/sessions` (Idempotency-Key) | то же; медиа без упражнений — 404 `NO_EXERCISES` |
| `POST /internal/v1/readings/{reading_id}/sessions` (Idempotency-Key) | спринт 5: практика «Чтение» → 201 `LessonSession` (kind `reading`, `ai_mode: choices`, `ai_degraded: false`); 404 `READING_NOT_AVAILABLE` (не опубликован, не та аудитория, ребёнку — не детский, версия без вопросов или с вопросом неизвестного типа); остальное — как у старта урока |
| `GET /internal/v1/reading-results?ids=r-a,r-b` (≤ 50) | `{items: [{reading_id, correct, total, finished_at}]}` — последний завершённый результат чтения ученика по каждому тексту (для `ReadingCard.last_result`; текстов без такой сессии в ответе нет); **расширение контракта** — BFF собирает карточки из catalog и этого ответа |
| `POST /internal/v1/sessions/{id}/review` (Idempotency-Key) | повтор заданий с ошибками (practice_only); 409 `NOTHING_TO_REVIEW` (у чтения — всегда: повтора нет, верные ответы к ошибкам уже в итогах) |
| `GET /internal/v1/sessions/active` | `{session: LessonSession \| null}` |
| `GET /internal/v1/sessions?kind=&cursor=&limit=` | `Page<LessonHistoryItem>` (kind: lesson \| scenario \| media \| review \| reading) |
| `GET /internal/v1/sessions/{id}` | `LessonSession` |
| `GET /internal/v1/sessions/{id}/current` | `LessonStep` (ready → in_progress; paused → авто-продолжение) |
| `POST /internal/v1/sessions/{id}/steps/{step_id}` `StepAnswer` | `StepResult`; повтор того же ответа — тот же результат; 409 `STEP_NOT_CURRENT {current_step_id}` / `FREE_TEXT_NOT_ALLOWED` / `AI_BUSY` (та же реплика ещё у ИИ — повторить через 2 с, сессия не изменена); 403 `KIDS_NOT_ALLOWED`; 422 `ANSWER_INVALID {field}` |
| `POST …/steps/{step_id}/hint` | `{hint: Localized}`; 409 `HINTS_NOT_ALLOWED` (проверка, упражнения) |
| `POST …/simpler?locale=ru\|uz` | `SimplerExplanation` (только этап объяснения, иначе 409 `SIMPLER_NOT_AVAILABLE`; 409 `AI_BUSY`); язык объяснения — `locale`, по умолчанию язык сессии |
| `POST …/roleplay/retry` | `LessonStep`; 409 `RETRY_NOT_AVAILABLE` (и у сессий без ролевой ситуации — медиа, чтение) |
| `POST …/pause` \| `resume` \| `cancel` | `LessonSession`; недопустимый переход — 409 `SESSION_STATE {status}` |
| `POST …/finish` | `LessonSummary` (только с шага `done`, иначе 409 `STEP_NOT_CURRENT`); повтор — тот же итог |
| `GET …/summary` | `LessonSummary` завершённой/отменённой сессии (актуальная оценка — повторным POST в assessment) |

## Admin API (только `admin-bff` с `actor`; права проверяются здесь)
| Метод и путь | Право | Ответ |
|---|---|---|
| `GET /admin/v1/lesson-sessions?from=&to=&kind=&status=&outcome=&flag=&lesson_id=&level=&cursor=&limit=` | `qa.read` | `Page<SessionRow-поля lessons>` + `evaluation_id`, `reading_id` (kind `reading`; в SessionRow поля нет — расширение); без `cost_usd/models/p95_latency_ms` (добавляет admin-bff из ai-gateway); флаги `ai_used, ai_unavailable, hints, human_review, failed`; `flag=appealed|flagged` → 422 `FLAG_NOT_SUPPORTED` (ведёт assessment) |
| `GET /admin/v1/lesson-sessions/{id}` | `qa.read` | `SessionCard.session`: `content_versions` (у чтения — ключ `reading:<reading_id>`), `user_ref` (8 hex HMAC-SHA256(user_id, `USER_REF_SECRET`) — сотрудник с `users.read`, зная user_id, без секрета псевдоним не сопоставит), `status_history`, `steps` (`hinted` — подсказка или ключ, виденный в прошлых итогах), `turns_meta` — без текстов |
| `POST /admin/v1/lesson-sessions/{id}/transcript {reason 10..500}` | `qa.transcripts` | `Transcript`; аудит `qa.transcript_viewed` (outbox); стёртые — `text: null, redacted: true` |
| `GET /admin/v1/lesson-sessions/stats?period=day\|week\|month` | `dashboard.read` или `qa.read` | `LessonStats` без `appeals_open`/`human_review_open` (добавляет admin-bff из assessment): `started` — начатые за период (ready → in_progress), `completed` — завершённые за период, `completion_pct` — доля завершённых среди начатых (null при 0), `median_minutes` — медиана minutes завершённых, `by_kind` — начатые по видам (все 5 ключей `SessionKind`, с `reading`), `ai_degraded_pct` — доля начатых в упрощённом режиме; day — с начала суток по `STATS_TIMEZONE` (Asia/Tashkent), week — 7 дней, month — 30 дней |

## Таймауты (R1-16, R2-02)
| Звено | Таймаут | Почему так |
|---|---|---|
| telegram-bff → lessons (шаги, старт, «проще», итоги) | 25 с (`LESSONS_TIMEOUT_MS`) | lessons → ai-gateway 20 с (один вызов агента на команду) + локальная работа < 25 с |
| lessons → ai-gateway `/agents/*/invoke` | 20 с (`AI_TIMEOUT_SECONDS`, без повторов) | превышение — `unavailable`, урок продолжается выбором реплик |
| lessons → ai-gateway `/internal/v1/status` | 2 с (`AI_STATUS_TIMEOUT_SECONDS`) | клиент runtime таймаут на запрос не принимает — срок задаёт `asyncio.timeout` вокруг `clients.ai_available` в `sessions._ai_mode`; не ответил — режим full |
| assessment → ai-gateway (оценщик) | ≥ 26 с (настройка assessment) | один вызов оценщика + повтор с ограничениями внутри ai-gateway |
| lessons → assessment `POST /evaluations` (finish) | 32 с (`ASSESSMENT_TIMEOUT_SECONDS`, без повторов) | больше assessment → ai-gateway (26 с, `deadline_ms` 25 с) + чтение ключей из catalog (3 с); не успел — `completed` без оценки, повтор — tick |
| второстепенные вызовы итогов (finish) | 2 с + 2 с (`SUMMARY_AUX_TIMEOUT_SECONDS`) | до оценки — «было» навыков и названия параллельно, после — следующий урок |
| telegram-bff → lessons `POST …/finish` | 45 с (`LESSONS_FINISH_TIMEOUT_MS`) | 2 + 32 + 2 = 36 с < 45 с (контент сессии — из кеша версий) |
| `GET …/summary` → assessment (повторное чтение оценки) | 5 с (`SUMMARY_REFRESH_TIMEOUT_SECONDS`) | оценка уже есть (идемпотентный POST без ИИ); < 25 с BFF — иначе сохранённая копия |

## Планировщик
`POST /internal/v1/lessons:tick` (`Authorization: Bearer <SCHEDULER_TOKEN>`, сравнение за постоянное время; JWT
сервиса → 403): брошенные `in_progress` → авто-пауза; пауза > 72 ч и `ready` > 24 ч → `cancelled` (+ событие);
стирание текстов старше 90 дней (реплики `mode=text` ученика и ИИ, открытые ответы, цитаты в копии оценки);
повторная отправка в assessment. Ответ — счётчики; повтор безопасен.

## Ход занятия
- **Урок:** `retrieval` (2–3 задания: очередь повторения со сроком, иначе контрольные задания опубликованных уроков,
  где основной навык — предпосылка текущего; порядок предпосылок — learning → demonstrated по карте diagnostics;
  нечего — `notice`) → `explanation` (инструкции, примеры, ключевые слова; «проще»; проверка понимания «что значит…»
  с вариантами — переводы других слов урока, на освоение не влияет) → `roleplay` (сценарий урока; нет/недоступен —
  этап пропущен) → `assessment` (все `control_items` без подсказок, правильность не показывается; при ai_mode full и не
  детям — открытое задание «Напишите 2–3 предложения по задаче урока: «…»», ≤ 300) → `summary` (`done` → finish).
- **Сценарий:** roleplay → summary. **Медиа:** listen (`can_listen` по `allowed_uses ∋ listen`, транскрипт — по
  `show_transcript`, перевод — по `translation`) → exercises (comprehension, gap_fill, order_lines, phrase_meaning) →
  summary. **Повтор:** задания с ошибкой из итогов → summary, `practice_only`.
- **Чтение (спринт 5, INTERNAL_API §4, AT-57):** `reading` → `questions` → `summary`. Старт: пара опубликована;
  `GET catalog /internal/v1/readings/{id}?audience=` (опубликован и подходит аудитории — иначе 404
  `READING_NOT_AVAILABLE`; номер версии — поле `version` ответа, без него — `GET /internal/v1/versions/reading/{id}`)
  → тело версии `GET /internal/v1/versions/reading/{id}/{version}` (кеш бессрочный). Защита в глубину: `reading_id`
  тела совпадает, аудитория ученика ∈ `audience` (ребёнку — только `audience = [kids]`), все вопросы — известного типа.
  Версия фиксируется в `content_versions.reading`: новая публикация или снятие текста не меняют идущую сессию.
  ИИ не нужен: `ai_mode: choices`, `ai_degraded: false`, ai-gateway не вызывается (и статус тоже).
  - шаг `reading` — `ReadingView` (bff.ts): предложения с переводом, глоссарий (`in_dictionary: null` — словарь
    ученика знает memory, дополняет BFF), число и типы вопросов — **без вопросов и ключей**; «Дальше» — `StepAnswer {}`;
  - вопросы — шаги `item` (`graded_later: true`, `hint_available: false`, подсказка → 409 `HINTS_NOT_ALLOWED`,
    `feedback: null`) в порядке текста; `single_choice` → `single_choice`; `true_false` → `single_choice` с вариантами
    `["True", "False"]` (в `StepItemType` нет `true_false`); `gap_fill` → `gap_fill` (без вариантов). Ответ —
    индекс или строка, «не знаю» — `dont_know`;
  - `done` → `finish` → assessment `EvaluationRequest {kind: reading, practice_only: true, content_refs: {reading:
    {key, version}}, answers: [{item_id: question_id, answer, hinted: false, dont_know}]}` (рубрики нет — у assessment
    встроенная `reading-comprehension`) → `LessonSummary`: `evaluation.items` (доля верных — по `correct`, верный ответ —
    только для ошибок), `scores` — `comprehension`, `skills: []`, `key_words` — глоссарий текста, `can_review: false`,
    `next_lesson` — как у медиа → `lesson.session.completed.v1 {kind: reading, practice_only: true}` (`lesson_id`,
    `scenario_id`, `asset_id` — null: поля для текста в схеме события нет);
  - минуты — как у медиа (`PRACTICE_DURATION_MIN`); пауза, отмена, истечение, авто-пауза, `failed` при исчезнувшей
    версии, повторная отправка оценки tick-ом — общие правила.
- **Задания «по порядку»:** слова `order_words` и реплики `order_lines` показываются перемешанными по seed сессии
  (`sha256(seed:order:<item_id>:<позиция>)`); совпал перемешанный порядок с ответом — сдвиг на один; у `order_words` без
  вариантов (опубликовано до запрета в catalog) — слова ответа. Ответ — строки по порядку (assessment сверяет с ключом).
- **Ролевая ситуация:** узел → шаг (варианты = `examples_en[0]` переходов, перемешаны `sha256(seed:node:intent)`).
  Свободный текст → `conversation_partner` (контекст ai.ts: текущий узел, ≤ 6 реплик, реплика ≤ 500, `*_en` — RU
  локализация, где нет английского). Распознано → `reply` (реакция ИИ) + `next` (узел перехода); `unclear/off_topic` →
  уточнение, тот же узел; после 2 подряд — только варианты; `hint_offered: true` (персонаж подсказал) — реплика
  ученика и шаг отмечаются подсказанными, как явная подсказка (`hint_usage` оценщика, `roleplay.hints`);
  `unavailable` → «Давайте выберем ответ», `ai_degraded`,
  ИИ не вызывается до конца этапа; `refused` → только варианты до конца сессии. Конец графа → `roleplay_end`; `fail` →
  одна попытка с ближайшей точки восстановления. После паузы — с ближайшей точки восстановления.
- **Возраст:** kids (claims `lrn ≠ sub` / `age_band` 6–13 / проекция / `?audience=kids`; без сведений — kids) →
  `ai_mode = choices`, только детские материалы, текст — 403, ИИ не вызывается.
- **Повтор урока (R2-01):** задания проверки, верный ответ к которым ученик уже видел в итогах прошлых сессий этого
  урока (оценка есть, задание неверно — `correct_answer` показан; также повтор ошибок), при старте помечаются
  (`ref.key_seen`) и уходят в оценку с `hinted: true`: правильность засчитывается, «демонстрирует» — нет; в итогах у
  задания та же пометка, что у подсказки (`items[].hinted` от assessment). Новых полей контракта нет.
- **Итоги:** `EvaluationRequest` (формат — `services/assessment/README.md`; `sub` = ученик) → assessment (32 с).
  Недоступен — `completed` без оценки (`evaluation: null`, «оценка появится позже»), повтор — tick. Изменения навыков —
  `skill_outcomes` + «было» из карты diagnostics (недоступна — список пуст) + названия из снимка курса. Следующий урок —
  learning-plan (тот же урок — план ещё не пересчитан → null). Ошибки проверки урока → очередь повторения (+1 день).
- **Время:** `minutes = ceil(active_seconds/60) ≤ 2× длительности`; промежутки бездействия > 10 мин не считаются.

## События
- публикует: `lesson.session.started.v1` (ready → in_progress), `lesson.session.completed.v1` (completed |
  cancelled | failed — ровно один раз; `local_date: null` — день считает learning-plan в зоне плана; kind
  `lesson | scenario | media | review | reading`, у чтения `practice_only: true`),
  `admin.audit.recorded.v1` (`qa.transcript_viewed`), `user.domain.deleted.v1 {domain: lessons, mode: deleted}`;
- потребляет (только от identity-consent): `user.deletion.requested.v1` (сага), `user.profile.created|updated.v1`
  (проекция `learner_profiles`).

## Данные (миграции 0001, 0002)
`sessions` (частичный UNIQUE незавершённой на ученика, `UNIQUE(user_id, idempotency_key)`, версии контента, план,
состояние, оценка-копия; 0002 — `reading_id`, kind `reading`, этапы `reading`/`questions`, шаг `reading`, индекс
`ix_sessions_reading_results` для последних результатов; откат 0002 удаляет сессии чтения), `status_history`
(append-only), `steps` (показанный шаг неизменяем, ответ — один раз,
затем только стирание текста — триггер `steps_guard`), `turns` (неизменяемы, кроме стирания текста — `turns_guard`),
`review_items` (очередь повторения), `learner_profiles`, `deleted_users`, `outbox`/`inbox`. Тексты ученика в логи,
события и метрики не попадают; в шаге свободная реплика хранится только хешем (для повтора), текст — в `turns`.

## Тесты
`uv run pytest services/lessons -q -p no:cacheprovider` (стенд PG/Redis/NATS; домены — заглушки httpx.MockTransport на
реальном сиде catalog), `uv run ruff check services/lessons`, `uv run mypy services/lessons/src`. Контрактные тесты
сверяют EvaluationRequest с моделью assessment (в т. ч. чтения) и вызовы агентов с моделями ai-gateway. Тексты для
чтения — свои фикстуры в `tests/ls_testkit.py` (`READINGS`, форма `ReadingPayload`; сид catalog спринта 5 — у
catalog), заглушка `GET /internal/v1/readings/{id}` — по INTERNAL_API §2.1 спринта 5.

## Спринт 7 — дуэли и парные комнаты (docs/sprint7/INTERNAL_API.md §3)

**Дуэль (`duel_host` — код).** `POST /internal/v1/duel-sets {duel_id, pair_id, level_band, user_ids, play_deadline?}`
(только gamification) → `{set_id, duel_id, pair_id, level_band, items_total, play_deadline}` (201; повтор — 200 тот же
набор; другие участники — 409 `DUEL_SET_CONFLICT`; catalog недоступен или мало заданий — 503 `DUEL_SET_UNAVAILABLE`).
10 закрытых заданий опубликованных уроков пары и полосы (мало — соседние уровни, сначала ниже), аудитория — самая
строгая (ребёнок или возраст неизвестен — только детские уроки), выбор по `sha256(duel_id)` по кругу навыков;
снимки заданий с ключами — в `duel_sets.items` (наружу не уходят). `play_deadline` — расширение контракта (нет —
`DUEL_PLAY_HOURS` от выдачи).
- `POST /internal/v1/me/duel-sessions {duel_id}` (Idempotency-Key) → `LessonSession` kind `duel` (одна на участника;
  повтор — 200 та же; не участник — 404 `DUEL_NOT_FOUND`; после срока — 409 `DUEL_CLOSED`). Дальше — общие маршруты
  `/sessions/{id}/…`: задания без подсказок и ИИ, `graded_later`, перемешивание по seed набора (у обоих одинаково),
  проверка по ключу снимка, повтор ответа — тот же результат; `finish` → итог без оценки; `cancel` — 409. Сессия дуэли
  вне правила одной активной сессии, не видна в `/sessions/active` и истории.
- `GET /internal/v1/me/duel-sessions/{session_id}/review` → `DuelReview` — только после `game.duel.finished.v1`
  (раньше 409 `DUEL_NOT_FINISHED`).
- Закрытие: срок набора (лениво у команды ученика и tick) или итог дуэли → незаконченная сессия `completed` со счётом
  по отвеченному → `lesson.session.completed.v1 {kind: duel, duel_id, score, practice_only: true}` (в assessment нет).

**Парная комната (`cooperative_lesson_coach`).** Ученик — `/internal/v1/me/pair-rooms…` (bff.ts «Парный урок»):
`POST` (приглашение, Idempotency-Key), `GET ?status=active|finished`, `GET /{id}`, `POST /{id}/accept|decline|cancel|
join|heartbeat|leave|turns|audio`, `GET /{id}/state?after_seq=&locale=` (long-poll), `GET /{id}/report`.
- Допуск: relations social (`GET /internal/v1/relations/{a}/{b}`) + проекции блокировок и санкций: одна семья —
  всем, друзья — 14+; дети — только семья и только `choices` (коуча не зовут, голоса нет); 403 `BLOCKED` |
  `SOCIAL_RESTRICTED {until}` | `PARTNER_NOT_ALLOWED`; ≤ 1 активной комнаты (`room_participants.holds_slot`,
  частичный UNIQUE) — 409 `ROOM_LIMIT {room_id}`; social недоступен — 503 `UPSTREAM_UNAVAILABLE {service: social}`.
- Ход: роли A (пригласивший) и B; `turns` — ровно одно из `text` (≤ 300) / `choice_id` / `audio_id`; не свой ход —
  409 `NOT_YOUR_TURN`; повтор Idempotency-Key — тот же ответ без второго хода. Голос: `POST …/audio` (WAV 0,5..15 с,
  ≤ 600 000 байт; слой `audio.py` обходит общий лимит тела 256 КиБ) → согласие (identity-consent `/public`,
  `voice_recording`) → ai-gateway `speech:transcribe` → `audio_id` (5 минут, один раз); аудио не хранится.
- Коуч: engine `ai` — ai-gateway (session_kind `pair`, session_id = room_id; коуч видит только роли A/B); ответ
  проверяется (эхо room_id, доказательства — только реплики этой роли); сбой, отказ, бюджет комнаты
  (`AiBudget.room_cap_usd` — у ai-gateway) → engine `script`: сценарий каталога с выбором реплик A/B по очереди
  (`ai_degraded`). Ответ коуча не пришёл (409 у шлюза) — ожидание, повтор с тем же request_id через
  `AI_TIMEOUT_SECONDS + 5`. Коуча ждёт только собственная команда (ход, вход); повтор и напоминание при молчании,
  найденные лентой, heartbeat или карточкой, — фоновой задачей (запрос отдаёт текущее состояние). Суточный лимит —
  `PAIR_AI_ROOMS_PER_DAY` комнат с коучем на ученика; сверх — сценарий с выбором реплик. Коуч получает только
  английский текст сценария (в каталоге нет английских title/task/role/criteria — они собираются из английских
  данных: id, имена персонажей, line_en).
- Планировщик обслуживает только комнаты со сроком `due_at ≤ now` (срок следующего действия пересчитывается после
  каждой команды); приглашение и принятие сначала обслуживают свои просроченные комнаты.
- Присутствие: без heartbeat 30 с — offline (в свой ход — пауза); возврат ≤ 3 мин — та же комната и сессия
  (`session_id = uuid5(room_id, str(user_id))`), время по часам — минуты не удваиваются; дольше — соло для
  оставшегося (`abandoned`, `participant_left`); 10 минут без ходов — `inactivity`; 20 минут — `completed`.
- Итог: `lesson.pair.completed.v1` + по каждому вошедшему `lesson.session.completed.v1 {kind: pair, session_id,
  room_id, minutes}` (минуты учитываются, не списываются); участникам с вкладом — `POST assessment /evaluations`
  (`kind scenario`, своя сессия, только свои реплики и реплики коуча) фоном после фиксации, недошедшие — tick.
  Отчёт — только свой.
- Админ (`/internal/v1/admin/pair-rooms`): список и карточка без текстов (`room.read`), `stop {reason}`
  (`room.manage` + step-up `X-Step-Up: ok`, аудит `pair_room.stopped`), `stats?period` (`dashboard.read | room.read`).
- События: публикует `lesson.pair.invited.v1`, `lesson.pair.starting.v1` (tick за 5 мин), `lesson.pair.completed.v1`;
  потребляет `social.profile.updated.v1`, `social.block.changed.v1` (отмена приглашений между учениками),
  `social.sanction.changed.v1` (отмена неотвеченных приглашений) — только от social; `game.duel.finished.v1` — только
  от gamification.
- Данные (миграция 0003): `duel_sets`, `pair_rooms`, `room_participants`, `room_events` (неизменяемы, кроме стирания
  текста — триггер), `room_audio`, `community_members`, `social_blocks`, `social_sanctions`; `sessions.duel_id`.
- Сага: наборы дуэлей и начатые комнаты обезличиваются (сторона без user_id, отчёта, доказательств; свои реплики
  стёрты; реплики коуча в ответ ему или цитирующие его стёрты; из состояния комнаты убраны подсказка его роли,
  описание роли и подсказки отчёта для неё; отчёт и реплики партнёра не трогаются), неначатые комнаты и проекции
  удаляются; идущая комната — партнёр доигрывает соло. События social и gamification после саги не воскрешают
  данные: обработчики берут блокировки учеников и проверяют удаление после них. Порядок блокировок везде —
  ученики, затем строки (комнаты, наборы); сага держит блокировку удаляемого.
- Разовая загрузка проекций не нужна: семья, дружба, блокировка и санкция проверяются синхронно через relations
  social (приглашение и принятие), уровень набора дуэли передаёт gamification; проекции social (ник, блокировки,
  санкции) — новые в спринте 7 и служат для отмены приглашений по событиям и ника в карточке.
