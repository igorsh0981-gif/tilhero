# diagnostics (8111, схема `diagnostics`, пакет `tilhero_diagnostics`)

Входная диагностика TilHero (AT-32…35, AT-38): банк заданий и версии теста, адаптивный воспроизводимый подбор,
профиль по областям с уверенностью и `not_assessed`, уточнение сомнительной области (ревизия результата), повтор
с ограничением частоты, история результатов, карта навыков ученика по паре. Навык `diagnostic_assessor`
реализован **детерминированными правилами без LLM** (`engine.py`). Контракты: `docs/sprint3/INTERNAL_API.md` §2,
`packages/contracts/src/bff.ts` (Спринт 3), `admin.ts` (Диагностика), события `diagnostics.completed.v1`,
`skills.state.changed.v1`; спринт 4 — `docs/sprint4/INTERNAL_API.md` §5 (навыки по оценкам уроков).

## Запуск и настройки
`python -m tilhero_common.serve tilhero_diagnostics.main:app`; миграции — `alembic upgrade head` (под
`MIGRATION_DATABASE_URL`).

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `CATALOG_URL` | `http://127.0.0.1:8110` (dev/test) | catalog: `GET /internal/v1/pairs`, `GET /internal/v1/courses/{id}/snapshot`; **в stage/prod обязателен** (http(s)), иначе сервис не стартует |
| `CATALOG_TIMEOUT_SECONDS` | 3 | таймаут запросов к catalog |
| `PAIRS_CACHE_TTL_SECONDS` | 60 | кеш списка пар; catalog недоступен → только `DEFAULT_PAIR_ID` (кеш 10 с) |
| `SNAPSHOT_REVALIDATE_SECONDS` | 30 | перепроверка снимка курса (If-None-Match/ETag); при недоступности — последний снимок |
| `DEFAULT_PAIR_ID` / `DEFAULT_COURSE_ID` | `ru-en` / `en-core` | пара по умолчанию и её курс (запасной вариант) |
| `DIAG_RETEST_DAYS` | пусто | повтор не чаще N дней; пусто — `config.retest_days` теста (14) |
| `STATS_TIMEZONE` | `Asia/Tashkent` | граница «сегодня» в статистике |

## Данные (миграции)
- `0001` — `tests` (версии; опубликованная/архивная неизменяема — триггер `tests_guard`, на (пару, аудиторию) одна
  published), `sessions`, `answers`, `results` (PK `result_id, revision`), `skill_states`, `skill_evidence`,
  `learner_profiles` (проекция identity-consent: kind, age_band), `deleted_users`, `outbox`/`inbox`.
  `answers`, `results`, `skill_evidence` — append-only (UPDATE запрещён триггером; DELETE — только сага удаления).
- `0003_lesson_outcomes` (спринт 4) — `skill_states.state_ref` (ref_id свидетельства, установившего текущее
  состояние: result_id диагностики | evaluation_id оценки урока; null — до спринта 4) и `lesson_evaluations`
  (полученные оценки assessment: evaluation_id PK, user_id, pair_id, session_id, supersedes, practice_only,
  outcomes; неизменяема — триггер `lesson_evaluations_immutable`, DELETE — только сага).
- `0002_seed_tests` — `migrations/seed/*.json` → опубликованные v1 (автор `seed`) + запись аудита в outbox.
  Каждый файл проверяется валидатором `testdef.py` (тот же, что при публикации): невалидный файл — миграция падает.
  Банки: `dx-en-adult.v1.json` (90 заданий), `dx-en-kids.v1.json` (36) — от тестолога.

Формат файла: `{test_id, version, pair_id, audience: adults|kids, config: {areas, items_per_area, start_band,
min_items_assessed, min_correct_per_band (по умолчанию 2), followup_items, retest_days, time_limit_min}, items: [{item_id,
area, band, tags[], skill_ids[], type, instruction{ru,uz}, prompt_en, passage_en|null, audio_text_en|null,
options[], answer: index | string[]}]}`. Проверки: поля и типы, тип ↔ область (чтение — `read_choice` с текстом
≤ 600, аудирование — `listen_choice` с текстом ≤ 300), ключ в пределах вариантов, порядок слов — перестановка
вариантов и не в показанном порядке, UZ — латиница, без управляющих символов и **внешних ссылок**, в каждой
области ≥ `items_per_area + followup_items` заданий; детский тест — без слов спешки и «провала».

## Правила (engine.py)
- **Подбор**: области по кругу V → G → R → L (следующая после последнего ответа сессии), квота `items_per_area`;
  лестница области — от полосы показанного задания: верно → выше, неверно/«не знаю» → ниже (A0…B2), старт
  `start_band`; задание — ещё не показанное, нужной полосы, иначе ближайшей доступной (при равенстве — ниже),
  внутри полосы — минимальный `sha256(seed + item_id)`. Текущее задание не хранится, а вычисляется из
  (версия теста, seed, ответы, доступность аудирования) — подбор воспроизводим.
- **Оценка области**: ответов < `min_items_assessed` → `not_assessed/too_few_items`; аудирование без голоса →
  `no_speech_voice`; говорение и письмо → `not_in_test_yet`. Полоса — наивысшая, где **внутри полосы** верных ≥
  `min_correct_per_band` и точность ≥ 0,6, иначе на ступень ниже старта (≥ A0). Уверенность =
  clamp(0,2 + 0,1·n + 0,4·согласованность − 0,2·скачки, 0, 1) (точно, в дробях); согласованность — доля ответов
  «верно на полосе ≤ итоговой / неверно выше»; скачки — верные ответы выше самой низкой полосы с ошибкой.
  `needs_followup` — уверенность < 0,5.
- **Уровень** — медиана оценённых областей (чётное число — нижняя из двух средних), < 2 оценённых → null;
  `cefr_certificate: false` всегда. **Слабые стороны** — оценённые области ниже медианы, затем области теста без
  оценки.
- **Рекомендация старта** (снимок курса catalog): core-уроки в порядке модулей и уроков, только для сегмента
  ученика (дети — `audience ∋ kids`). Полоса навыка — оценённая полоса его области; для функций, говорения, письма и
  неоценённых областей — предварительный уровень; уровня нет — только оценённые области.
  - урок пропускается, если основной навык demonstrated/retained или его уровень **строго ниже** полосы (ученик A2
    начинает с уроков A2, а не с A0–A1 только потому, что тест стартует с A1);
  - рекомендация — первый непропущенный урок, у которого каждая предпосылка (урока и основного навыка)
    demonstrated/retained или её уровень **не выше** полосы (ученик с полосой A2 владеет навыками A2);
  - пропущены все core-уроки сегмента (ученик выше курса) — первый не освоенный core-урок самого высокого уровня
    курса для сегмента; иначе (нет такого, предпосылка выше полосы, нет снимка) — `null`.

  На сиде catalog и банке тестолога (seed-0000): «всегда неверно» → `l-01-greetings`, «верно до A2» →
  `l-13-flight-check-in`, B2 → `l-13-flight-check-in`, ребёнок «до A2» → `l-02-where-from`. На 100 seed ученик A2
  всегда получает урок уровня A2 (тест `test_a2_learner_never_gets_null_or_lesson_below_a2`).
- **Карта навыков**: навыки задания = `skill_ids` ∪ навыки курса по `diagnostic_tags` (со снимком — только навыки
  курса). На ревизию результата и навык — одно свидетельство: есть верные и нет неверных той же или ниже полосы
  (чем наивысший верный) → positive (demonstrated), иначе есть неверные → negative (learning). Понижение
  demonstrated → learning — только при двух отрицательных подряд; `retained` диагностика не ставит.
- **Навыки по оценкам уроков** (спринт 4, `domain/lesson_outcomes.py`, AT-46/47): `assessment.completed.v1` —
  по `skill_outcomes`: `learning` → not_started | learning → learning (demonstrated — без изменений);
  `demonstrated` → not_started | learning → demonstrated; `not_assessed` — ничего; `retained` не трогается;
  `practice_only` и kind `review` — ничего. На оценённый навык — свидетельство (source `lesson`, ref_id =
  evaluation_id, время — `created_at` оценки) → история карты навыков; состояние `source = lesson`,
  `confidence = null`, `state_ref = evaluation_id`. Переоценка (`assessment.reevaluated.v1` или completed с
  `supersedes`): кроме того же, навык в demonstrated, установленный свидетельством заменённой оценки цепочки
  (`state_ref` ∈ заменённые), без положительных свидетельств действующих оценок или диагностики после него и не
  демонстрируемый новой оценкой (learning, not_assessed или отсутствует) → learning. Демонстрация диагностики
  переоценкой урока не отменяется. Идемпотентно: оценка записывается в `lesson_evaluations`, повторная публикация
  (новый event_id) — без изменений; оценка, уже заменённая пришедшей раньше переоценкой, записывается без
  применения. `skills.state.changed.v1` (source `lesson`, evidence_id = evaluation_id) — только при изменениях.
- **Уточнение**: `POST …/results/{id}/followup {area}` — только если область `needs_followup` в последней
  ревизии, ≤ 24 ч после ревизии 1, одно на область; отдельная сессия той же версии и seed (+`followup_items`
  заданий области). Завершение → ревизия N+1 по всем ответам (основная сессия + завершённые уточнения);
  свидетельства навыков — по новым ответам.
- **Повтор**: 409 `DIAGNOSTIC_TOO_SOON {next_allowed_at}` до `retest_days` от последнего результата, где оценена
  хотя бы одна область. Результаты без оценённой области (прервали в начале) повтор не блокируют, но их не больше
  3 за `retest_days`: 4-я попытка — 409 с `next_allowed_at` = самый ранний из них + `retest_days`; `GET state`
  показывает тот же срок. История не перезаписывается.
- **Основания результата** (`AreaResult.evidence`) — по полосам по возрастанию `[{band, answered, correct}]`, без
  item_id и отметок по заданиям (иначе результат — «оракул» ключей банка); для `not_assessed` — `[]`. Ревизии,
  сохранённые раньше с отметками по заданиям, неизменяемы и сворачиваются по полосам при чтении; отметки по
  заданиям остаются только в БД (ответы, карта навыков, статистика).
- **Сегмент ученика**: `?audience=kids|teens|adults` от telegram-bff (активный ученик `lrn`); проекция
  `learner_profiles` (kind=child или age_band 6-9/10-13 → kids при любом hint); без hint — возраст из проекции,
  затем сегмент последней сессии, иначе adults. kids → тест `audience=kids`.

## API
Ученик (`/internal/v1`, вызывающий — только telegram-bff, `sub` = ученик; чужие сессии/результаты — 404; после
саги удаления — 410 `USER_DELETED`):
| Метод | Путь | Ответ / коды |
|---|---|---|
| GET | `/diagnostics/state?pair_id=&audience=` | DiagnosticState; 409 PAIR_NOT_AVAILABLE |
| POST | `/diagnostics/sessions?audience=` `{pair_id?}` + Idempotency-Key | 201 DiagnosticSession (повтор — 200); 409 DIAGNOSTIC_TOO_SOON, PAIR_NOT_AVAILABLE; 400/422 ключ; 422 IDEMPOTENCY_KEY_REUSED |
| GET | `/diagnostics/sessions/{id}/next` | DiagnosticItem \| `{done: true}`; 409 DIAGNOSTIC_SESSION_EXPIRED / _CLOSED |
| POST | `/diagnostics/sessions/{id}/answers` | AnswerResult; повтор item_id — 200 без изменений; 409 ITEM_NOT_CURRENT; 422 ANSWER_INVALID |
| POST | `/diagnostics/sessions/{id}/listening-unavailable` | 204 |
| POST | `/diagnostics/sessions/{id}/finish` | DiagnosticResult (повтор — тот же); 422 DIAGNOSTIC_EMPTY (нет ответов) |
| POST | `/diagnostics/results/{id}/followup` `{area}` | 201 DiagnosticSession (незавершённое — 200); 409 FOLLOWUP_NOT_AVAILABLE {area, reason: not_needed \| window_closed \| already_done \| no_items} |
| GET | `/diagnostics/results?pair_id=&limit=` | `{items}` — последняя ревизия каждого результата, новые сверху |
| GET | `/diagnostics/results/{id}?revision=` | DiagnosticResult |
| GET | `/skills/map?pair_id=` | SkillMap (без снимка курса — только навыки с состоянием, метаданные null); спринт 4 — вызывающий ещё **lessons** (навыки ученика для этапа повторения; `sub` = ученик) |

Админка (`/admin/v1/diagnostics`, только admin-bff с actor): `GET /tests`, `GET /tests/{id}/versions/{v}` (с ключами и
coverage) — `content.read`; `POST /tests/{id}/versions/{v}/publish {reason}` — `content.publish` (прежняя
опубликованная той же пары и аудитории → archived; повтор — без изменений; 422 TEST_INVALID {errors}; аудит
`diagnostics.test_published`); `GET /stats?period=today|7d|30d` — `dashboard.read`;
`GET /pairs` — `content.read` → `{items: [{pair_id, learners}]}`: число различных учеников хотя бы с одним
результатом по паре (ревизии и повторы одного ученика — один; удалённые не считаются — их результаты удаляет сага,
отметка `deleted_users` исключает их и во время гонки); пары без результатов не возвращаются.

## События
- Издаёт: `diagnostics.completed.v1` (каждая ревизия), `skills.state.changed.v1` (есть переходы),
  `admin.audit.recorded.v1` (публикация, сид), `user.domain.deleted.v1 {domain: diagnostics, mode: deleted}`.
- Потребляет (только от identity-consent): `user.deletion.requested.v1` (сага: сессии, ответы, результаты,
  состояния, свидетельства, проекция, полученные оценки уроков), `user.profile.created.v1` /
  `user.profile.updated.v1` (проекция возраста). Спринт 4 (только от assessment; durable `diagnostics.assessment`):
  `assessment.completed.v1`, `assessment.reevaluated.v1` → карта навыков по оценкам уроков. Чужой издатель —
  предупреждение в логе без user_id, событие подтверждается без действия; payload не по контракту — DLQ.

## Тесты
`uv run pytest services/diagnostics -q -p no:cacheprovider` (стенд: PostgreSQL, `source .dev/testenv.sh`);
catalog — `httpx.MockTransport` (`tests/dx_testkit.py`). `uv run ruff check services/diagnostics`,
`uv run mypy services/diagnostics/src`.
