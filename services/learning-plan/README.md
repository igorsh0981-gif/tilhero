# learning-plan-service

**Владелец:** команда учебного контура. **Bounded context:** учебный план ученика — цель, уровень уверенности, темы,
языки интерфейса и объяснений, учебная пара; **график занятий** (дни, время, длительность, напоминания, часовой пояс),
учёт занятий, слоты графика → события «напомнить» и «пропуск» (INTERNAL_API §2, PLAN.md «Правила напоминаний»,
AT-04…08).

Спринт 3: **траектория уроков** — последовательность уроков опубликованного курса по цели, диагностике и карте
навыков, обязательные и дополнительные, «почему следующий», ревизии с историей (INTERNAL_API спринта 3 §3, AT-36, AT-34).

Спринт 4: **занятия по реальным урокам и пройденные уроки** — события `lesson.session.completed.v1` (lessons) дают
занятие дня (график, серия, пропуски и напоминания считаются по ним) и пройденный урок в траектории (`completed`,
следующий — первый не пройденный успешно, без зачёта — «повторить»); оценка (`assessment.completed.v1`, в т. ч.
полученная после завершения сессии) и переоценка (`assessment.reevaluated.v1`) задают исход урока — сопоставление по
`session_id`, порядок событий любой (INTERNAL_API спринта 4 §5, AT-46, AT-47, ревью R1-05).

Спринт 6: **заморозка серии** — `game.streak.frozen.v1` (gamification) закрывает пропущенный день (`frozen_days`):
серия и цепочка пропусков через него не рвутся, неделя показывает `frozen`; `learning.activity.recorded.v1` несёт
`streak_days` (INTERNAL_API спринта 6 §2, AT-66). Единственное обратное влияние игры на учёбу.

Порт 8102, схема PostgreSQL `learning_plan`, внутренний JWT с `aud = learning-plan`. Redis не нужен.
Пакет `tilhero_learning_plan`. Исходящие вызовы: catalog (снимок курса).

## API
Клиентский API вызывает только `telegram-bff` (`iss`); ученик — только из `sub` токена (BFF кладёт туда активного
ученика `lrn`). Формы ответов = `packages/contracts/src/bff.ts`.

| Метод | Путь | Тело → ответ |
|---|---|---|
| GET | `/internal/v1/me/plan?tz=` | → `LearningPlan` + `ETag: "<version>"`; при первом обращении создаёт план по умолчанию (зона — `?tz=`, если это известная IANA-зона, иначе `DEFAULT_TIMEZONE` = Asia/Tashkent) |
| PATCH | `/internal/v1/me/plan` | `PlanPatch` (+ необязательный `If-Match: <version>` / `"<version>"` / `W/"<version>"`) → `LearningPlan`; 409 `PLAN_VERSION_CONFLICT {current_version}`; 422 `PLAN_INVALID {field, reason}`; `learning.plan.updated.v1 {changed_fields}` |
| POST | `/internal/v1/me/plan/onboarding/complete` | → `LearningPlan`; 409 `PLAN_INCOMPLETE {missing: [goal, level_self, schedule]}`; повтор — 200 без изменений |
| GET | `/internal/v1/me/plan/today` | → `TodayPlan` |
| POST | `/internal/v1/me/activities` | `{kind: lesson\|review\|practice\|diagnostic, minutes 1..240, occurred_at?}` + `Idempotency-Key` (обязателен) → `TodayPlan`; `learning.activity.recorded.v1` |
| GET | `/internal/v1/directory/goals`, `/internal/v1/directory/topics` | → `{items: DirectoryItem[]}` (6 целей, 12 тем, RU/UZ) |
| POST | `/internal/v1/plan:tick` | n8n, `Authorization: Bearer <SCHEDULER_TOKEN>` → `{plans_checked, reminders, missed, skipped}`; пока идёт предыдущий tick — сразу 200 `{…, skipped: true}` |
| GET | `/admin/v1/plans?updated_after=&cursor=&limit=` | спринт 2, **только `user-admin`** (внутренний JWT без actor; actor от него — 403 `ACTOR_NOT_ALLOWED`) → `{items: [{user_id, goal, level_self, ui_lang, schedule, onboarding_completed_at, updated_at}], next_cursor}` — сверка read-модели админки. Курсор `(updated_at, user_id)` по возрастанию (индекс `ix_plans_updated`, миграция 0002); `updated_after` — ISO-8601 с часовым поясом, строго позже (без зоны — 422); `limit` 1..500 (100); 400 `INVALID_CURSOR`. План по умолчанию (без события) тоже выгружается; планов удалённых учеников нет |

| GET | `/internal/v1/plan/trajectory?pair_id=&audience=` | спринт 3 → `Trajectory` (bff.ts); вызывающие — telegram-bff и (спринт 4) **lessons** (следующий урок в итогах), ученик — из `sub`; `pair_id` `^[a-z]{2,8}-[a-z]{2,8}$`, по умолчанию `DEFAULT_PAIR` (ru-en); `audience` (`kids\|teens\|adults`, необязательный, **расширение контракта**) — сегмент активного ученика от BFF (как `audience=` у catalog). 409 `PAIR_NOT_AVAILABLE {pair_id}` (пары нет в `PAIR_COURSES` или catalog: курс не опубликован — 404), 410 `USER_DELETED`, 503 `CATALOG_UNAVAILABLE` (catalog недоступен и снимка в кеше нет), 422 `VALIDATION_ERROR` |

План по умолчанию: `goal`/`level_self` null, тем нет, `ui_lang`/`explain_lang` = ru, `course_pair` = ru-en,
`daily` (1..7), 19:00, 20 минут, напоминания выключены, `version` = 1. Создание по умолчанию — не правка: события нет.

### Валидация PATCH (`422 PLAN_INVALID {field, reason}`)
Ошибки формы тела тоже отдаются как `PLAN_INVALID` (а не общий `VALIDATION_ERROR`): лишнее поле → `unknown_field`,
явный `null` → `null_not_allowed`, неверный тип → тип ошибки pydantic (`int_type`, `list_type`, …).

| Поле | Правило | reason |
|---|---|---|
| `goal` | `work\|career\|travel\|daily\|study\|exam` | `unknown_value` |
| `level_self` | `zero\|beginner\|some\|confident` | `unknown_value` |
| `topics` | коды справочника, ≤ 5, без повторов | `unknown_topic`, `too_many`, `duplicate` |
| `ui_lang`, `explain_lang` | `ru\|uz` (смена языка интерфейса не меняет `course_pair`, AT-05) | `unknown_value` |
| `schedule.preset` | `daily\|weekdays\|three_per_week\|custom` | `unknown_value` |
| `schedule.days` | ISO 1..7, 1–7 дней, без повторов (порядок нормализуется) | `empty`, `out_of_range`, `duplicate` |
| preset ↔ days | пресет без дней → канонические дни (custom — текущие); пресет + дни → для не-custom дни обязаны совпасть (`daily` 1..7, `weekdays` 1..5, `three_per_week` 1,3,5); дни без пресета → текущий пресет, если дни канонические для него, иначе `custom` | `preset_mismatch` |
| `schedule.preferred_time` | `HH:MM` 00:00…23:59 | `format` |
| `schedule.duration_min` | 10 / 15 / 20 / 30 | `not_allowed` |
| `schedule.timezone` | известная IANA-зона (`available_timezones()`, без `localtime`/`Factory`) | `unknown_timezone` |
| `If-Match` | целое, можно в кавычках и с `W/` | `format` (field `If-Match`) |

Повтор того же PATCH — no-op (версия и события не меняются). Шаг графика онбординга считается пройденным, когда ученик
сам прислал хоть одно поле графика, кроме `timezone` (зона приходит из `Intl` клиента) — даже со значениями по
умолчанию (`schedule_set_at`).

### TodayPlan
- `local_date`, `is_scheduled_today`, `slot_time` — по зоне плана; `done_today`/`minutes_today` — занятия за местную дату.
- `next_slot` — сегодня, если сегодня день графика и занятия ещё не было, иначе ближайшая следующая дата графика.
- `streak_days` — дни с занятием после последнего выпущенного пропуска без занятия **и без заморозки** (спринт 6;
  дни вне графика серию не рвут: по ним пропуск не выпускается; несделанный сегодняшний слот — тоже, день не
  закончился). Замороженный день серию сохраняет, но занятием не считается (в счёт не входит).
- `week` (пн…вс): `scheduled` — по текущему графику, `done` — было занятие, `missed` — пропуск выпущен (slot_marks)
  и занятия так и нет, `frozen` (спринт 6) — пропуск (`missed` остаётся `true`), закрытый заморозкой серии. День с
  занятием важнее заморозки: `done`, без `missed` и `frozen` (заморозка, пришедшая позже позднего события урока, на
  learning-plan не влияет; списанную заморозку gamification не возвращает — INTERNAL_API спринта 6 §2).

### Занятия
`local_date` — дата `occurred_at` (по умолчанию — сейчас) в зоне плана на момент записи. `occurred_at` — с поясом, не
раньше `ACTIVITY_MAX_AGE_DAYS` (7) и не позже допуска часов (`ACTIVITY_FUTURE_SKEW_SECONDS` = 300) → иначе 422
`ACTIVITY_INVALID {field: occurred_at, reason: out_of_range}`. `Idempotency-Key` (8–128 `[A-Za-z0-9._:-]`):
нет → 400 `IDEMPOTENCY_KEY_REQUIRED`, неверный → 422 `IDEMPOTENCY_KEY_INVALID`; повтор с тем же телом → тот же
результат + `Idempotent-Replayed: true` без новой записи и события; с другим телом → 422 `IDEMPOTENCY_KEY_REUSED`.
Занятие задним числом за день пропуска снимает пропуск в `week` и не рвёт серию.

**Спринт 4 — занятия из событий уроков.** `lesson.session.completed.v1` со `status = completed` → запись в
`activities`: kind `lesson` (сессия урока) или `practice` (сценарий, медиа, повтор ошибок `review`), минуты из
события (не больше 240), `local_date` — из события, а если её нет — дата `finished_at` в зоне плана (плана нет —
`DEFAULT_TIMEZONE`; план событием не создаётся), `recorded_at` = `finished_at`, `session_id` — сессия lessons.
Одна запись на сессию (частичный уникальный индекс `uq_activities_session`; ключ `lesson/<session_id>` — с «/»,
недопустимым в ключах клиента): повтор доставки или повторная публикация минуты не удваивает. Новая запись —
`learning.activity.recorded.v1`, как у ручной. `cancelled` / `failed` — не занятие. Ручная активность Mini App
(`POST /me/activities`) больше не нужна Mini App, но работает (совместимость) и суммируется с уроками.

**Спринт 5 — «Повторение дня» и чтение** (INTERNAL_API спринта 5 §6, AT-59). `memory.review.completed.v1`
(издатель — только memory; `completed` и `expired` с ответами) → занятие kind `review`: минуты из события,
`local_date` — дата `finished_at` в зоне плана (плана нет — `DEFAULT_TIMEZONE`), `session_id` — сессия повторения,
ключ `review/<session_id>`; одна запись на сессию (повтор доставки, повторная публикация, повтор со сменой статуса —
без второго занятия); `minutes = 0` — не занятие (день не засчитывается, события нет). Новая запись —
`learning.activity.recorded.v1` (kind `review`). День графика, серия, пропуски и напоминания (tick, TodayPlan)
учитывают его как любое занятие. Сессия чтения lessons (`lesson.session.completed.v1` kind `reading`) — занятие
`practice`; оценка вопросов (`assessment.completed.v1` kind `reading`) принимается без влияния на пройденные уроки.
Спринт 7 (INTERNAL_API спринта 7 §10, решение 2): дуэль и парный урок (`lesson.session.completed.v1` kind `duel`,
`pair`) — тоже занятие `practice` (день графика и серия, минуты из события; пройденным уроком не считаются).

**Спринт 6 — `streak_days` в `learning.activity.recorded.v1`** (необязательное поле схемы, всегда заполняется): серия
на последний день ученика с занятием после записи (для занятия сегодня — то же, что `TodayPlan.streak_days`; занятие
задним числом за пропущенный день несёт восстановленную серию). Считается без часов сервиса — одинаково для ручной
активности и событий уроков и повторений. Потребитель — gamification (значки серии).

## Траектория уроков (спринт 3)
Навык `curriculum_planner` — детерминированными правилами без LLM (`domain/curriculum.py`, чистые функции):

1. **Аудитория**: детям 6–13 — только уроки с `audience ∋ kids`, подросткам — `∋ teens`, взрослым — `∋ adults`.
   Сегмент: `?audience=` от BFF, иначе проекция профиля (`learner_audience`); **детский «липкий»** — если ребёнок по
   любому источнику, только детские уроки (подсказка BFF и событие профиля его не понижают); ничего не известно —
   `kids` (самый строгий набор). Порядок курса — модули снимка по порядку, внутри — `lesson_ids` модуля.
2. **Старт**: есть диагностика — `recommended_start_lesson_id` (если core и подходит аудитории), иначе правило
   diagnostics: первый core-урок, чей основной навык не освоен и не **строго ниже** уровня ученика, с закрытыми
   предпосылками (нет такого — первый из не освоенных и не ниже уровня, предпосылки вставляются; все ниже уровня —
   первый не освоенный урок высшего уровня курса, нет — обязательных нет); нет диагностики — начало курса.
   Следующий урок плана после диагностики = её рекомендация (тест `test_lp_diagnostics_consistency.py` на сиде
   catalog и банках diagnostics).
3. **Обязательные** — core-уроки от старта по порядку, кроме уроков с освоенным основным навыком (`demonstrated |
   retained`). Перед уроком вставляются уроки, дающие его недостающие предпосылки (`prerequisite_skill_ids` урока ∪
   `prerequisites` основного навыка; рекурсивно, без повторов и циклов; урок-«учитель» — core раньше optional).
   Предпосылка закрыта, если навык освоен, его даёт урок выше в плане или уровень навыка **не выше** полосы,
   оценённой диагностикой в его области; для функций, говорения, письма и неоценённых областей — не выше
   предварительного уровня; уровня нет — только оценённые области (одно правило с diagnostics, ревью спринта 3;
   версия алгоритма `cp-2` — траектории пересчитываются при следующем чтении).
4. **Дополнительные** — optional-уроки с совпадением цели или тем (≤ `OPTIONAL_LESSONS_MAX` = 8): больше совпадений —
   выше, затем порядок курса; с освоенным навыком и уже стоящие в плане — нет.
5. **Следующий** — первый обязательный (нет — первый дополнительный, нет и их — `null`).
6. **Причины**: основная — `start_after_diagnostic` / `no_diagnostic` (первый урок от старта), `prerequisite_missing`
   (вставленный), `next_in_course`; уточняющие — `weak_area` (область основного навыка ниже предварительного уровня
   диагностики), `goal_match`, `topic_match`. Объяснение следующего — Localized RU/UZ из кодов (цель — названием из
   справочника); детям — мягкие формулировки без сравнения.

**Ревизии** (`trajectories`, PK `(user_id, pair_id, revision)`): чтение сравнивает входы `basis` {algorithm,
audience, goal, topics, diagnostic_result_id, diagnostic_revision, course_snapshot_version, skills_hash (освоенные
навыки)} с последней ревизией: совпали — отдаётся она (без события), иначе — новая ревизия + `learning.trajectory.updated.v1`
в той же транзакции (под advisory-блокировкой ученика). Прежние ревизии хранятся и неизменяемы (триггер запрещает
UPDATE и роли сервиса; удаление — только сага). `items` ревизии самодостаточны (карточки уроков на момент расчёта).
Спринт 4 (алгоритм `cp-3`): **пройденные уроки** — `completed_lessons` (строка на завершённую сессию урока; актуальна
последняя сессия урока по `completed_at`). Пройденный с зачётом (`passed = true`) в обязательные и дополнительные не
входит, его основной навык закрывает предпосылки (урок-«учитель» не вставляется); пройденный без зачёта
(`passed = false`, а также `null` — оценка без вердикта) остаётся на своём месте с пометкой «повторить»: в
объяснении — своя фраза первой («Повторим этот урок — в прошлый раз зачёт не получен»; детям — «Пройдём этот урок ещё
раз — так дальше будет легче»), в `reason_codes` — **`weak_area`** как ближайший существующий код (кода `repeat` в
`ReasonCode` bff.ts нет — запрос к контракту; детям код-заменитель не ставится, чтобы не показывать «слабая
область»). `completed` ответа — `LessonCard & {passed, evaluation_id, completed_at}` по последней сессии каждого урока,
новые первыми, карточка из снимка курса (урок, которого в курсе больше нет, не показывается); хранится в `items`
ревизии (ревизии спринта 3 — пустой список). В `basis` — `completed_hash` (урок, сессия, passed, evaluation_id):
новая сессия урока или переоценка → новая ревизия при следующем чтении. `lessons_available` — флаг
`LESSONS_AVAILABLE` (true; не часть ревизии).

**Пересчёт отложенный** (при следующем чтении): события-входы и смена цели/тем в `PATCH /me/plan` только обновляют
проекции и пометки — без обращения к catalog. Смена языка интерфейса, графика, уровня-самооценки траекторию не меняет.

**Снимок курса**: `GET {CATALOG_URL}/internal/v1/courses/{course_id}/snapshot` (внутренний JWT `iss=learning-plan`,
без `sub`; `course_id` — из `PAIR_COURSES`). Кеш — таблица `course_snapshots` (общая для реплик): моложе
`CATALOG_SNAPSHOT_MAX_AGE_SECONDS` (300) и не помечен — без запроса; иначе `If-None-Match` → 304 (подтверждён) или 200
(заменён). Пометку «устарел» ставит `catalog.version.published.v1` и снимает только запрос, начатый после неё.
catalog недоступен (сеть, 5xx, circuit breaker, ответ не по контракту `CourseSnapshot`): есть кеш — расчёт по нему
(WARNING), нет — 503. HTTP — вне транзакции БД.

## plan:tick (n8n `plan-tick`, каждые 5 мин)
Вход: `Authorization: Bearer <SCHEDULER_TOKEN>` (сравнение за постоянное время). Пустой `SCHEDULER_TOKEN` выключает
вход (401 `SCHEDULER_TOKEN_INVALID`); внутренний JWT любого сервиса → 403 `CALLER_NOT_ALLOWED`.

- Окно `(last_tick_at, now]`, не длиннее `TICK_MAX_LOOKBACK_HOURS` (24): после простоя старые слоты не догоняются.
  `tick_state` — одна строка, создаётся миграцией с `now()`; часы позади `last_tick_at` — пустое окно,
  `last_tick_at` назад не двигается.
- **Один tick за раз, повтор не ждёт** (ревью P-1): на весь проход берётся сессионная advisory-блокировка
  `pg_try_advisory_lock('LPTI', crc32(схема))` на выделенном соединении (на нём же идут транзакции пачек).
  Занято — сразу 200 `{plans_checked: 0, reminders: 0, missed: 0, skipped: true}`: повторы n8n по таймауту не
  занимают пул. Блокировка снимается в `finally` (`pg_advisory_unlock_all`); не удалось (разрыв, отмена) —
  соединение закрывается, блокировка уходит вместе с сессией сервера. Ключ зависит от схемы: стенды и тесты в одной
  БД друг другу не мешают. tick занимает одно соединение пула (2 + 1), запросы учеников идут по остальным.
- **Пачки** по `TICK_BATCH_SIZE` (500, ключ — `user_id`), у каждой своя короткая транзакция: отметки и события
  пачки фиксируются вместе, relay будится после каждой пачки с событиями. `last_tick_at` двигается только после всех
  пачек. Сбой посреди прохода: следующий tick проходит то же окно ещё раз, выпущенное не повторяется (`slot_marks`),
  невыпущенное выпускается.
- **Внутри пачки — фиксированное число запросов**: планы с событием в окне перечитываются `FOR KEY SHARE`; занятия
  за все пары (ученик, дата) — одним запросом (`unnest`); все отметки — одной вставкой `ON CONFLICT DO NOTHING
  RETURNING`; `streak_days` и `consecutive_missed` — по одному запросу на пачку; события outbox — одной пакетной
  вставкой (`make_envelope` + `outbox`, как `emit`). Нагрузка (стенд, 10 000 планов в одном слоте): напоминания
  33,0 с → 0,8 с, пропуски 31,5 с → 0,9 с; 20 000 — 1,9 с, повторы во время прохода — `skipped`, запрос ученика —
  0,1 с (было 28 с). Регресс — `tests/test_lp_tick_batches.py::test_load_10k_plans_one_slot` (`-m slow`).
- Проверяются только планы с `onboarding_completed_at`.
- **Слот** = дата графика + `preferred_time` в зоне плана → UTC через zoneinfo. DST: несуществующее время (перевод
  вперёд) сдвигается на величину перехода (02:30 → 03:30 летнего), неоднозначное — первое из двух; каждой дате — ровно
  один момент слота и один «конец дня», окна не пересекаются → каждое событие ровно в одном окне.
- **reminder** (`learning.reminder.due.v1`): момент слота в окне, `reminders_enabled`, за местную дату слота занятий нет.
  `streak_days` — как в TodayPlan на дату слота; считается после вставки всех отметок пачки, поэтому пропуск за
  предыдущую дату, выпущенный в том же проходе (слот 00:00 или окно после простоя), серию уже обнуляет.
  Устаревшие (после простоя) отсекает notifications (> 3 ч → центр).
- **missed** (`learning.session.missed.v1`): в окне закончился местный день слота (00:00 следующей даты), занятий за
  дату нет; выпускается и без `reminders_enabled`. `consecutive_missed` = 1 + выпущенные пропуски после последнего дня
  с занятием **или с заморозкой** (спринт 6: замороженный день разрывает цепочку и сам в неё не входит);
  `next_slot_date` — следующая дата графика. Занятие в тот же местный день (до 00:00) отменяет пропуск.
- Идемпотентность: `slot_marks (user_id, local_date, kind)` вставляется ON CONFLICT DO NOTHING, событие — только если
  отметка вставлена, в той же транзакции. Повтор окна (n8n retry) событий не дублирует.
- Смена графика действует со следующего слота: слоты раньше `effective_from` = max(`onboarding_completed_at`,
  `schedule_set_at`) не напоминаются и не считаются пропущенными (`schedule_set_at` двигается при смене времени, дней
  или зоны). Слот, по которому напоминание уже было, не повторяется (отметка по дате) — даже при переезде в другую зону.
  Онбординг после времени слота — сегодня слота нет.
- Удаление (сага) и tick: пачка держит планы с событиями FOR KEY SHARE, удаление сначала удаляет план (ждёт конца
  транзакции пачки — секунды, не весь tick), потом отметки — сирот не остаётся; PATCH/занятия берут FOR NO KEY
  UPDATE и tick не ждут.

## События
Публикует (outbox): `learning.plan.updated.v1` (`changed_fields` — имена колонок: goal, level_self, topics, ui_lang,
explain_lang, preset, days, preferred_time, duration_min, reminders_enabled, timezone, onboarding_completed_at; плюс
снимок goal/ui_lang/course_pair/timezone/days/preferred_time/duration_min/reminders_enabled/onboarding_completed),
`learning.reminder.due.v1`, `learning.session.missed.v1`, `learning.activity.recorded.v1`, `user.domain.deleted.v1`
(`domain = learning-plan`, `mode = deleted`).

Спринт 3: `learning.trajectory.updated.v1 {user_id, pair_id, revision, next_lesson_id, reason_codes (следующего),
computed_at}` — на каждую новую ревизию траектории.

Потребляет (издатель проверяется — защита в глубину, ревью P-7: от другого издателя — предупреждение в логе с типом
события и издателем, без `user_id`, событие подтверждается шине без действия; невалидный payload — DLQ):

| Durable | События (издатель) | Действие |
|---|---|---|
| `learning-plan.user_deletion` | `user.deletion.requested.v1` (identity-consent) | сага удаления, ACK `user.domain.deleted.v1` |
| `learning-plan.diagnostics` | `diagnostics.completed.v1` (diagnostics) | `learner_diagnostics` — последний результат по паре (старее по `completed_at`, затем `revision` — не перезаписывает) |
| | `skills.state.changed.v1` (diagnostics) | `skill_states` — локальная карта навыков (изменение старше сохранённого по `occurred_at` — не применяется) |
| `learning-plan.catalog` | `catalog.version.published.v1` (catalog) | kind `course\|module\|lesson\|skill` → снимок курса (`course_id` события; нет — все) помечается устаревшим |
| `learning-plan.profiles` | `user.profile.created.v1`, `user.profile.updated.v1` (identity-consent) | `learner_audience`: детский профиль / 6–13 → kids, 14–17 → teens, иначе adults (возраст не хранится; `age_band: null` в обновлении — без изменений; kids не понижается) |
| `learning-plan.lessons` | `lesson.session.completed.v1` (lessons) | спринт 4: `completed` → занятие (`activities`, + `learning.activity.recorded.v1`) и для kind `lesson` — пройденный урок (`completed_lessons`); kind `reading` (спринт 5), `duel` и `pair` (спринт 7) — занятие `practice`; идемпотентно по `session_id`; `cancelled`/`failed` — без действия |
| | `assessment.completed.v1` (assessment) | спринт 4 (R1-05): kind `lesson` → проекция `lesson_evaluations` (session_id из события); пройденному уроку сессии — актуальная оценка (`evaluation_id`, `passed`). Оценка, полученная после завершения (assessment был недоступен при finish, событие сессии ушло с null), доходит до траектории; пришла раньше события сессии — применяется при его записи. Остальные kind — без действия |
| | `assessment.reevaluated.v1` (assessment) | спринт 4: `session_id` в схеме v1 нет (появится в событии — используется напрямую) — сессия берётся у заменённой оценки (`supersedes`: проекция или пройденный урок с этой оценкой); заменённая ещё не пришла — запись ждёт с `session_id = null`, затем он протягивается по цепочке. Актуальна последняя оценка цепочки (`created_at`); чужая оценка не трогается; повтор — без изменений |
| `learning-plan.memory` | `memory.review.completed.v1` (memory) | спринт 5: `completed` / `expired` → занятие kind `review` (`activities`, + `learning.activity.recorded.v1`), `local_date` по зоне плана из `finished_at`; идемпотентно по `session_id`; `minutes = 0` — без действия |
| `learning-plan.game` | `game.streak.frozen.v1` (gamification) | спринт 6: `frozen_days (user_id, local_date)` ON CONFLICT DO NOTHING — повтор доставки, повторная публикация и вторая операция за тот же день ничего не меняют; событий не выпускает; плана не создаёт |

События удалённого ученика проекции не воскрешают (`deleted_users` под той же блокировкой). Правила доставки детям
по-прежнему применяет notifications по `DeliveryInfo`.

## Данные
Схема `learning_plan`: `plans` (+ `schedule_set_at`), `activities` (`UNIQUE(user_id, idempotency_key)`),
`slot_marks` (PK user_id, local_date, kind), `tick_state` (одна строка), `deleted_users` (отметка исполненного удаления:
псевдонимный `user_id` + `request_id`, без PII), `outbox`/`inbox`. Миграции 0001; 0002 (спринт 2) — индекс
`ix_plans_updated (updated_at, user_id)` для `GET /admin/v1/plans`; 0003 (спринт 3) — `trajectories` (ревизии, триггер
`trajectories_no_update`), `course_snapshots` (кеш снимка: etag, snapshot_version, payload, fetched_at, checked_at,
stale_since), проекции `learner_diagnostics`, `skill_states`, `learner_audience`; 0004 (спринт 4) —
`activities.session_id` + `uq_activities_session`, `completed_lessons` (session_id PK, user_id, pair_id, lesson_id,
passed, evaluation_id, completed_at, recorded_at, updated_at; индексы по ученику/уроку и ученику/оценке); 0005
(спринт 4, R1-05) — `lesson_evaluations` (evaluation_id PK, user_id, session_id | null, supersedes, passed, created_at,
recorded_at; индексы ученик/сессия/время и ученик/supersedes) — проекция оценок уроков; 0006 (спринт 6) —
`frozen_days` (PK user_id, local_date; op_id — операция списания в реестре gamification; created_at).

Сага удаления: план, занятия, отметки, траектории, проекции, пройденные уроки и их оценки, дни с заморозкой ученика
удаляются физически, затем ACK; повтор саги (тот же `request_id`, новый
`event_id`) снова подтверждается; после удаления `/me/*` → 410 `USER_DELETED`.

## Настройки
`DATABASE_URL`, `MIGRATION_DATABASE_URL`, `DB_SCHEMA=learning_plan`, `NATS_URL`, `SCHEDULER_TOKEN` (в stage/prod —
пусто, т. е. вход выключен, или ≥ 32 символов, иначе сервис не стартует; ревью P-8),
`DEFAULT_TIMEZONE` (Asia/Tashkent), `TICK_MAX_LOOKBACK_HOURS` (24), `TICK_BATCH_SIZE` (500),
`ACTIVITY_MAX_AGE_DAYS` (7), `ACTIVITY_FUTURE_SKEW_SECONDS` (300), внутренний JWT (`INTERNAL_JWT_*`).
Спринт 3: `CATALOG_URL` (`http://127.0.0.1:8110`; **в stage/prod обязателен** — без него сервис не стартует;
Railway — приватный адрес catalog), `CATALOG_TIMEOUT_SECONDS` (3),
`CATALOG_SNAPSHOT_MAX_AGE_SECONDS` (300), `PAIR_COURSES` (JSON, `{"ru-en": "en-core"}`), `DEFAULT_PAIR` (ru-en; обязан
быть ключом `PAIR_COURSES`, иначе сервис не стартует), `OPTIONAL_LESSONS_MAX` (8). Спринт 4: `LESSONS_AVAILABLE`
(true) — `Trajectory.lessons_available`; вызывающий `lessons` — его открытый ключ в `INTERNAL_JWT_PUBLIC_KEYS`. catalog должен принимать
вызывающего `learning-plan` (его открытый ключ — в `INTERNAL_JWT_PUBLIC_KEYS` catalog).

## Runbook
- Траектория 503 `CATALOG_UNAVAILABLE`: catalog недоступен и кеша нет (первый запуск) — проверить catalog
  (`/health/ready`), `CATALOG_URL`, ключ `learning-plan` в catalog; WARNING `catalog unavailable, cached course
  snapshot used` — работаем по кешу (`course_snapshots.checked_at`). Принудительная перепроверка снимка:
  `UPDATE course_snapshots SET stale_since = now()`.
- План не изменился после публикации курса: событие `catalog.version.published.v1` (durable `learning-plan.catalog`),
  `course_snapshots.stale_since` / `snapshot_version`; страховка — TTL `CATALOG_SNAPSHOT_MAX_AGE_SECONDS`.
- Ребёнку показаны недетские уроки: `learner_audience` ученика и `basis->>'audience'` последней ревизии
  `trajectories`; сегмент без проекции и подсказки BFF — `kids`.
- Ответ `skipped: true` — предыдущий tick ещё идёт (норма для повтора n8n). Если `skipped` подряд дольше 10 мин —
  искать зависшую сессию: `SELECT pid, state, query_start FROM pg_locks JOIN pg_stat_activity USING (pid) WHERE
  locktype = 'advisory' AND classid = 1280332873` (`'LPTI'`), при необходимости `pg_terminate_backend(pid)`.
- Напоминаний нет: проверить `tick_state.last_tick_at` (двигается каждые 5 мин), ответ n8n `plan-tick`, что у ученика
  `onboarding_completed_at` и `reminders_enabled`, нет ли занятия за дату; отметки — `slot_marks`.
- Простой планировщика > 24 ч: пропущенные слоты не догоняются (так задумано); после восстановления окно — последние 24 ч.
- Ротация `SCHEDULER_TOKEN`: сменить в n8n и сервисе одновременно (до смены n8n получает 401, события не теряются —
  следующий tick покроет окно до 24 ч).
