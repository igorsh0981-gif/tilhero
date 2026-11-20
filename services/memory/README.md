# memory (8116, схема `memory`, пакет `tilhero_memory`)

Память и повторения TilHero (спринт 5; APP-MEM-01…05, APP-ADV-01, ADM-MEM-01/02; AT-53…62; навык
`spaced_repetition_coach` — **код, не LLM**): личный словарь (слова, фразы, ошибки), журнал ошибок, интервальные
повторения **FSRS-5** («Повторение дня»: узнавание → самостоятельное воспроизведение), проверки удержания через 7 и
30 дней, перевод по тапу (словарь курса → кеш → `teaching_coach` gloss_word), оценка произношения через ai-gateway,
вечернее напоминание, админка памяти и аналитика забывания, сага удаления.

Контракты: `docs/sprint5/INTERNAL_API.md` §1 (memory), §2.3–2.4 (catalog), §3.2 (речь), §5 (memory-feed),
§6 (соседи); `packages/contracts/src/bff.ts` «Спринт 5»; `admin.ts` «Память, словарь курса, чтение»; `ai.ts`
(`TeachingCoachGlossContext/Output`, `SpeechAssessMeta`, `PronunciationResult`, `AiStatus`); события
`packages/contracts/events/memory.*.schema.json`.

## Запуск и настройки
`python -m tilhero_common.serve tilhero_memory.main:app`; миграции — `alembic upgrade head` (под
`MIGRATION_DATABASE_URL`).

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `CATALOG_URL` | `http://127.0.0.1:8110` | версии контента (lesson, media_asset, reading, scenario), словарь курса, задания проверок — **обязателен в stage/prod** |
| `ASSESSMENT_URL` | `http://127.0.0.1:8113` | `GET /internal/v1/evaluations/{id}/memory-feed` — **обязателен в stage/prod** |
| `AI_GATEWAY_URL` | `http://127.0.0.1:8114` | статус, `teaching_coach` gloss_word, оценка произношения — **обязателен в stage/prod** |
| `IDENTITY_CONSENT_URL` | `http://127.0.0.1:8101` | `GET /internal/v1/users/{lrn}/public` — согласие на запись голоса — **обязателен в stage/prod** |
| `SCHEDULER_TOKEN` | пусто (вход выключен) | `Authorization: Bearer` n8n `memory-tick`; в stage/prod ≥ 32 символов (от tick зависят сроки хранения) |
| `CATALOG_TIMEOUT_SECONDS` / `ASSESSMENT_TIMEOUT_SECONDS` / `IDENTITY_TIMEOUT_SECONDS` | 3 / 5 / 3 | таймауты клиентов |
| `GLOSS_DEADLINE_MS` / `GLOSS_TIMEOUT_SECONDS` | 8000 / 9 | `deadline_ms` gloss_word и сколько memory ждёт ответа (< 12 с BFF); таймаут > дедлайна |
| `AI_STATUS_TIMEOUT_SECONDS` / `SPEECH_TIMEOUT_SECONDS` | 2 / 15 | статус ai-gateway; оценка произношения (< 20 с BFF) |
| `DEFAULT_PAIR_ID` / `DEFAULT_TIMEZONE` | `ru-en` / `Asia/Tashkent` | без проекции плана |
| `REVIEW_VOICE` | `en-US` | голос озвучки заданий (`ReviewTask.voice`) |
| `DUE_LIMIT_ADULTS` / `DUE_LIMIT_KIDS` | 20 / 10 | карточек к сроку в сессии |
| `NEW_LIMIT_ADULTS` / `NEW_LIMIT_KIDS` | 5 / 3 | новых в день |
| `CHECKS_PER_SESSION` / `CHECK_ITEMS` | 2 / 3 | проверок удержания в сессии и заданий в проверке |
| `INACTIVITY_MINUTES` / `SESSION_EXPIRY_MINUTES` | 10 / 120 | пауза не идёт в активное время; бездействие → expired |
| `CARDS_LIMIT` | 2000 | карточек на ученика |
| `GLOSS_CACHE_TTL_SECONDS` | 3600 | кеш перевода Redis `gloss:v1:<pair>:<key>` |
| `REMINDER_HOUR` / `REMINDER_WINDOW_MINUTES` / `REMINDER_MIN_DUE` / `REMINDERS_PER_TICK` | 19 / 15 / 5 / 500 | вечернее напоминание |
| `INACTIVITY_DAYS_FOR_CHECKS` | 14 | без активности — срок проверки +1 день |
| `ERROR_CARD_RETENTION_DAYS` / `PRONUNCIATION_RETENTION_DAYS` / `ANSWER_RETENTION_DAYS` | 90 / 180 / 90 | сроки хранения |
| `STATS_TIMEZONE` | `Asia/Tashkent` | граница «сегодня» блока обзора |

## API ученика (только `telegram-bff`; ученик — claim `lrn`, аккаунт — `sub`, возраст — claim `age_band`)
Чужие карточки и сессии → 404. Query: `pair_id` (по умолчанию — пара плана), `audience` (подсказка BFF; детский
профиль не понижается), `locale` ru|uz (язык вариантов перевода и советов; иначе язык плана). Удалённый ученик —
410 `USER_DELETED`. Аудитория: 6-9 / 10-13 → kids, 14-17 → teens, 18+ → adults; `lrn ≠ sub` (детский профиль) — kids;
полоса ребёнка неизвестна — поведение 6–9 (сборка вместо ввода).

| Метод и путь | Ответ |
|---|---|
| `GET /internal/v1/overview` | `MemoryOverview` (`pronunciation`: available \| consent_self \| consent_guardian \| unavailable) |
| `GET /internal/v1/cards?kind=&status=&q=&cursor=&limit=` | `Page<DictionaryCard>` (без archived; q ≤ 60 — по английскому и переводу) |
| `POST /internal/v1/cards/lookup` `{texts ≤ 50}` | `{items: [{text, card_id \| null}]}` — есть ли слова в словаре (для `ReadingView.glossary[].in_dictionary`) |
| `GET /internal/v1/cards/{id}` | `DictionaryCardDetail` (10 последних оценок, последняя попытка произношения; цитата ошибки — только здесь) |
| `POST /internal/v1/cards` (Idempotency-Key) `AddCardRequest` | 201 новая / 200 уже была; 404 `CONTENT_NOT_FOUND`; 422 `WORD_NOT_IN_CONTENT` / `GLOSS_UNAVAILABLE` / `CARDS_LIMIT {limit}` / `IDEMPOTENCY_KEY_REUSED`; принимает и форму `{source: {kind, key, version, text_en}}` |
| `POST` / `DELETE /internal/v1/cards/{id}/known` | `DictionaryCard` (known — не оценка FSRS; возврат — срок «сейчас»); 409 `CARD_STATE` (заморожена) |
| `DELETE /internal/v1/cards/{id}` | 204 (archived; повтор — 204) |
| `GET /internal/v1/errors?cursor=` | `Page<ErrorJournalItem>` без цитаты; у детей — пусто |
| `POST /internal/v1/review-sessions` (Idempotency-Key) | 201 `ReviewSession`; активная или повтор ключа — 200; 409 `NOTHING_TO_REVIEW {next_due_at}` |
| `GET /internal/v1/review-sessions/active` | `{session: ReviewSession \| null}` |
| `GET /internal/v1/review-sessions/{id}` | `ReviewSession` |
| `GET …/{id}/current` | `ReviewTask` (без ключа); всё пройдено — 409 `TASK_NOT_CURRENT {current_task_id: null}` |
| `POST …/{id}/tasks/{task_id}` `ReviewAnswer` | `ReviewTaskResult`; повтор — тот же результат; 409 `TASK_NOT_CURRENT {current_task_id}` / `REVIEW_SESSION_STATE {status}`; 422 `ANSWER_INVALID {field}` |
| `POST …/tasks/{task_id}/hint` `{kind}` | `ReviewHint`; 409 `HINTS_NOT_ALLOWED` (check_item, intro, first_letter у выбора) |
| `POST …/{id}/finish` | `ReviewSummary` (повтор — тот же итог); не всё пройдено — 409 `TASK_NOT_CURRENT` |
| `POST …/{id}/cancel` | `ReviewSession` (cancelled, ответы остаются; блок проверки возвращается в очередь) |
| `POST /internal/v1/translate` `{text ≤ 60, content \| content_ref}` | `WordGloss`; 404 `CONTENT_NOT_FOUND`; 422 `WORD_NOT_IN_CONTENT` |
| `POST /internal/v1/pronunciation?target_kind=card\|sentence&target=` (или `target=card:<id>` / `sentence:<kind>:<key>:<version>:<locator>`), тело `audio/wav` | `PronunciationView`; 403 `VOICE_CONSENT_REQUIRED {who}`; 404 `CARD_NOT_FOUND` / `CONTENT_NOT_FOUND`; 422 `AUDIO_INVALID {reason}` / `REFERENCE_INVALID`; 503 `SPEECH_UNAVAILABLE` |

## Admin API (только `admin-bff` с actor; права — в домене; step-up `memory.manage` — в admin-bff)
| Метод и путь | Право | Ответ |
|---|---|---|
| `GET /admin/v1/memory/learners/{user_id}` | `memory.read` | `LearnerMemorySummary`; 404 `MEMORY_LEARNER_NOT_FOUND` |
| `GET /admin/v1/memory/learners/{user_id}/cards?status=&kind=&cursor=` | `memory.read` | `Page<AdminCardRow>` (без цитаты ошибки) |
| `GET /admin/v1/memory/cards/{card_id}` | `memory.read` | `AdminCardDetail` + первая страница истории |
| `GET /admin/v1/memory/cards/{card_id}/log?cursor=` | `memory.read` | `Page<ReviewLogRow>` (`actor_id` — UUID сотрудника у ручных правок, иначе null) |
| `POST /admin/v1/memory/cards/{card_id}/actions` `CardAction` | `memory.manage` | `AdminCardDetail`; 409 `CARD_STATE {status}`; 422 `DUE_AT_RANGE` / reason < 10 |
| `GET /admin/v1/memory/analytics?pair_id=&period=30d\|90d` | `memory.read` \| `dashboard.read` | `ForgettingAnalytics` (k-анонимность: < 5 учеников — `hidden`) |
| `GET /admin/v1/memory/stats?period=today\|7d\|30d` | `dashboard.read` | `MemoryStats` (`ai_glosses_pending` = null — дописывает admin-bff из catalog) |

Ручная правка — строка `review_log` (`actor: staff:<id>`, `actor_name`, причина) и аудит `memory.card_adjusted`
(`admin.audit.recorded.v1`, object `memory_card`, before/after — снимок FSRS + `user_id`, `action`). FSRS не
пересчитывается: перенос меняет только `due_at` (1..365 дней), сброс → `new`, заморозка/разморозка — статус.

## Планировщик
`POST /internal/v1/memory:tick` (n8n `memory-tick`, каждые 15 минут, `SCHEDULER_TOKEN`; одна реплика — сессионная
advisory-блокировка, занято — `{skipped: true}`): истечение сессий → напоминания (19:00–19:14 по поясу плана) →
перенос проверок без активности 14 дней → сроки хранения (ошибки 90 дней → archived + цитата стёрта; произношение
180 дней — удалить; ввод в заданиях 90 дней — стереть; ключи идемпотентности 7 дней). Ответ — счётчики шагов.

## События
**Публикует** (outbox): `memory.review.completed.v1` (completed; expired — если был ответ), `memory.reviews.due.v1`,
`memory.retention.checked.v1`, `user.domain.deleted.v1 {domain: memory}`, `admin.audit.recorded.v1`.

**Потребляет** (inbox, издатель проверяется — чужие игнорируются):
| Событие | Издатель | Что делает |
|---|---|---|
| `assessment.completed.v1`, `assessment.reevaluated.v1` | assessment | memory-feed → карточки урока (`key_words`), медиа (`phrases`, если `allowed_uses ∋ dictionary`), ошибки текста ученика (`T{n}`, `OA{n}`; детям — нет); переоценка архивирует исчезнувшие ошибки; идемпотентно по evaluation_id (`feed_log`) |
| `skills.state.changed.v1` | diagnostics | проекция навыков; `→ demonstrated` — проверка d7; выход из demonstrated — отмена |
| `learning.plan.updated.v1` | learning-plan | проекция: пояс, пара, напоминания, язык |
| `lesson.session.completed.v1` | lessons | день активности |
| `user.deletion.requested.v1` | identity-consent | сага удаления |
| `catalog.glossary.changed.v1` | catalog | сброс кеша перевода по формам |

## Данные
`cards` (уникальность ученик+пара+вид+ключ; `status` поверх `fsrs_state`), `review_log` (**неизменяема**, триггер),
`review_sessions` (частичный UNIQUE active), `review_tasks` (показанное неизменяемо, ответ — один раз, триггер),
`retention_checks` (одна незавершённая на навык), `pronunciation_attempts` (без аудио), `learner_projection`
(+ полоса возраста из claims — детский режим в consumers), `skill_projection`, `reminders_sent`, `activity_days`,
`feed_log`, `idempotency`, `deleted_users`, `outbox`/`inbox`.

## Правила
- **FSRS-5** (`domain/fsrs.py`, `fsrs5-default-1`, r = 0,9, интервал 1..365) — единственный источник сроков.
  Эталон INTERNAL_API R(3; 3,173) ≈ 0,9019 приблизителен: по формуле §1.4 — 0,9047 (тест считает формулой).
- **Оценка** (`domain/tasks.py`): неверно / «Не помню» / пропуск → again; выбор верно → hard; ввод/сборка с первой
  буквой или почти → hard; без подсказки → good; `easy` — никогда. «Знаю это» — `known`, строка истории без оценки.
- **Задания по стадии**: new → intro + meaning_choice; learning / S < 3 → meaning_choice | listen_choice;
  S ≥ 3 → typed | cloze (дети 6–9 — assemble); error → error_fix (цитата стёрта — typed с объяснением);
  проверка → check_item без подсказок. Вариант детерминирован (seed = session_id + card_id). Отвлекающие — из
  ключевых слов того же урока / фраз медиа (снимок в карточке) и карточек ученика, без дублей перевода.
- **Сравнение** (`domain/normalize.py`): §1.6 + без внутренней пунктуации, заготовка «…» = 0..3 слова,
  «A / B» — варианты; check_item — правила assessment.
- **Перевод**: слово обязано быть в опубликованной версии (catalog lookup); детям ИИ разрешён (текста ученика нет).
- **Произношение**: аудио — только в памяти процесса; в логах — длительность и статус.

## Обходы и запросы к общему коду
- Тело до 600 000 байт: общий `RequestContextMiddleware` режет 256 КиБ — внешний слой `audio.py` только для
  `POST /internal/v1/pronunciation` (нужен лимит тела по маршруту в `tilhero_common.app`).
- Свои таймауты на вызов (`asyncio.timeout` поверх `ServiceClient`): у ServiceClient таймаут общий на клиента.

## Тесты
`uv run pytest services/memory -q -p no:cacheprovider` (стенд: PG, Redis; заглушки catalog / assessment / ai-gateway /
identity-consent — `tests/mem_testkit.py` на реальном сиде catalog).
