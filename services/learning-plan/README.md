# learning-plan-service

**Владелец:** команда учебного контура. **Bounded context:** учебный план ученика — цель, уровень уверенности, темы,
языки интерфейса и объяснений, учебная пара; **график занятий** (дни, время, длительность, напоминания, часовой пояс),
учёт занятий, слоты графика → события «напомнить» и «пропуск» (INTERNAL_API §2, PLAN.md «Правила напоминаний»,
AT-04…08).

Порт 8102, схема PostgreSQL `learning_plan`, внутренний JWT с `aud = learning-plan`. Redis не нужен.
Пакет `tilhero_learning_plan`.

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
| POST | `/internal/v1/plan:tick` | n8n, `Authorization: Bearer <SCHEDULER_TOKEN>` → `{plans_checked, reminders, missed}` |

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
- `streak_days` — дни с занятием после последнего выпущенного пропуска без занятия (дни вне графика серию не рвут:
  по ним пропуск не выпускается; несделанный сегодняшний слот — тоже, день не закончился).
- `week` (пн…вс): `scheduled` — по текущему графику, `done` — было занятие, `missed` — пропуск выпущен (slot_marks)
  и занятия так и нет.

### Занятия
`local_date` — дата `occurred_at` (по умолчанию — сейчас) в зоне плана на момент записи. `occurred_at` — с поясом, не
раньше `ACTIVITY_MAX_AGE_DAYS` (7) и не позже допуска часов (`ACTIVITY_FUTURE_SKEW_SECONDS` = 300) → иначе 422
`ACTIVITY_INVALID {field: occurred_at, reason: out_of_range}`. `Idempotency-Key` (8–128 `[A-Za-z0-9._:-]`):
нет → 400 `IDEMPOTENCY_KEY_REQUIRED`, неверный → 422 `IDEMPOTENCY_KEY_INVALID`; повтор с тем же телом → тот же
результат + `Idempotent-Replayed: true` без новой записи и события; с другим телом → 422 `IDEMPOTENCY_KEY_REUSED`.
Занятие задним числом за день пропуска снимает пропуск в `week` и не рвёт серию.

## plan:tick (n8n `plan-tick`, каждые 5 мин)
Вход: `Authorization: Bearer <SCHEDULER_TOKEN>` (сравнение за постоянное время). Пустой `SCHEDULER_TOKEN` выключает
вход (401 `SCHEDULER_TOKEN_INVALID`); внутренний JWT любого сервиса → 403 `CALLER_NOT_ALLOWED`.

- Окно `(last_tick_at, now]`, не длиннее `TICK_MAX_LOOKBACK_HOURS` (24): после простоя старые слоты не догоняются.
  `tick_state` (одна строка, создаётся миграцией с `now()`) блокируется FOR UPDATE — параллельные запуски идут по
  очереди; часы позади `last_tick_at` — пустое окно, `last_tick_at` назад не двигается.
- Проверяются только планы с `onboarding_completed_at`.
- **Слот** = дата графика + `preferred_time` в зоне плана → UTC через zoneinfo. DST: несуществующее время (перевод
  вперёд) сдвигается на величину перехода (02:30 → 03:30 летнего), неоднозначное — первое из двух; каждой дате — ровно
  один момент слота и один «конец дня», окна не пересекаются → каждое событие ровно в одном окне.
- **reminder** (`learning.reminder.due.v1`): момент слота в окне, `reminders_enabled`, за местную дату слота занятий нет.
  `streak_days` — как в TodayPlan на дату слота. Устаревшие (после простоя) отсекает notifications (> 3 ч → центр).
- **missed** (`learning.session.missed.v1`): в окне закончился местный день слота (00:00 следующей даты), занятий за
  дату нет; выпускается и без `reminders_enabled`. `consecutive_missed` = 1 + выпущенные пропуски после последнего дня
  с занятием; `next_slot_date` — следующая дата графика. Занятие в тот же местный день (до 00:00) отменяет пропуск.
- Идемпотентность: `slot_marks (user_id, local_date, kind)` вставляется ON CONFLICT DO NOTHING, событие — только если
  отметка вставлена, в той же транзакции. Повтор окна (n8n retry) событий не дублирует.
- Смена графика действует со следующего слота: слоты раньше `effective_from` = max(`onboarding_completed_at`,
  `schedule_set_at`) не напоминаются и не считаются пропущенными (`schedule_set_at` двигается при смене времени, дней
  или зоны). Слот, по которому напоминание уже было, не повторяется (отметка по дате) — даже при переезде в другую зону.
  Онбординг после времени слота — сегодня слота нет.
- Удаление (сага) и tick: tick держит план FOR KEY SHARE, удаление сначала удаляет план (ждёт tick), потом отметки —
  сирот не остаётся; PATCH/занятия берут FOR NO KEY UPDATE и tick не ждут.

## События
Публикует (outbox): `learning.plan.updated.v1` (`changed_fields` — имена колонок: goal, level_self, topics, ui_lang,
explain_lang, preset, days, preferred_time, duration_min, reminders_enabled, timezone, onboarding_completed_at; плюс
снимок goal/ui_lang/course_pair/timezone/days/preferred_time/duration_min/reminders_enabled/onboarding_completed),
`learning.reminder.due.v1`, `learning.session.missed.v1`, `learning.activity.recorded.v1`, `user.domain.deleted.v1`
(`domain = learning-plan`, `mode = deleted`).

Потребляет: `user.deletion.requested.v1` (durable `learning-plan.user_deletion`). `user.profile.created/updated.v1` не
потребляются: `is_minor`/`age_band` нет ни в одном payload learning-plan, правила для детей применяет notifications по
`DeliveryInfo`.

## Данные
Схема `learning_plan`: `plans` (+ `schedule_set_at`), `activities` (`UNIQUE(user_id, idempotency_key)`),
`slot_marks` (PK user_id, local_date, kind), `tick_state` (одна строка), `deleted_users` (отметка исполненного удаления:
псевдонимный `user_id` + `request_id`, без PII), `outbox`/`inbox`. Миграция 0001.

Сага удаления: план, занятия и отметки удаляются физически, затем ACK; повтор саги (тот же `request_id`, новый
`event_id`) снова подтверждается; после удаления `/me/*` → 410 `USER_DELETED`.

## Настройки
`DATABASE_URL`, `MIGRATION_DATABASE_URL`, `DB_SCHEMA=learning_plan`, `NATS_URL`, `SCHEDULER_TOKEN`,
`DEFAULT_TIMEZONE` (Asia/Tashkent), `TICK_MAX_LOOKBACK_HOURS` (24), `TICK_BATCH_SIZE` (500),
`ACTIVITY_MAX_AGE_DAYS` (7), `ACTIVITY_FUTURE_SKEW_SECONDS` (300), внутренний JWT (`INTERNAL_JWT_*`).

## Runbook
- Напоминаний нет: проверить `tick_state.last_tick_at` (двигается каждые 5 мин), ответ n8n `plan-tick`, что у ученика
  `onboarding_completed_at` и `reminders_enabled`, нет ли занятия за дату; отметки — `slot_marks`.
- Простой планировщика > 24 ч: пропущенные слоты не догоняются (так задумано); после восстановления окно — последние 24 ч.
- Ротация `SCHEDULER_TOKEN`: сменить в n8n и сервисе одновременно (до смены n8n получает 401, события не теряются —
  следующий tick покроет окно до 24 ч).
