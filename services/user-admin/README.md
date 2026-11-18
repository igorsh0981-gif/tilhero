# user-admin

**Владелец:** команда Admin. **Bounded context:** read-модель учеников для админки (раздел «Ученики» и блок
дашборда, `docs/sprint2/INTERNAL_API.md` §2). Данными **не владеет**: authoritative-источники — identity-consent
(аккаунт и детский профиль, опекун, возраст, согласия, безопасность, настройки уведомлений), learning-plan (цель,
уровень, график, онбординг, занятия), support (обращения). Порт 8121, схема `user_admin`, пакет `tilhero_user_admin`.

Ученик (learner) — строка `admin_learner_summary`: `kind=account` — аккаунт Telegram (сам ученик 14+ или опекун),
`kind=child` — детский профиль 6–13 под опекуном (`guardian_user_id`), без Telegram ID и username.

PII: копия `username`/`display_name`; полный Telegram ID не хранится и не отдаётся — только маска `••••••789` (CHECK
`ck_learner_mask`; источник по ошибке прислал полный ID — маскируется до записи). `username` в ответах (строки,
карточка, её `children` и `guardian`) — маска `ig•••81` (первые 2 и последние 2 символа; короче 5 — `•••`; без «@», как и полный username), полностью —
только сотруднику с `users.sensitive.read` (ревью T2-3). `display_name` отдаётся как есть — поддержке для обращения.
Раскрытие — `POST identity-consent /admin/v1/users/{id}/reveal` через admin-bff. В логах — только тип события/ошибки,
без username, имени и user_id.

## API (вызывает только `admin-bff`, claim `actor` обязателен, права проверяются здесь же)
| Метод | Путь | Право | Ответ |
|---|---|---|---|
| GET | `/admin/v1/learners?q=&kind=&age_band=&status=&locale=&has_open_tickets=&cursor=&limit=` | `users.read` | `Page<AdminLearnerRow>` (новые сверху) |
| GET | `/admin/v1/learners/stats?period=today\|7d\|30d` | `dashboard.read` | `DashboardLearners` |
| GET | `/admin/v1/learners/{id}` | `users.read` | `AdminLearnerCard` без `tickets` (их добавляет admin-bff) |

- `q`: UUID ученика; `@username` — **точное** совпадение полного username без регистра (маска в ответе не мешает;
  префикс и подстрока не ищутся — иначе username раскрывался бы по буквам); `TCK-3081` → автор обращения — **только
  при праве `support.read`** у сотрудника (без него поиск по номеру не выполняется, пустой результат); иначе — часть
  отображаемого имени (`ILIKE` по `search_text` = lower(display_name), `%`, `_` и `\` — литералы). Номер ищется по
  проекции `ticket_refs` (события support), а не вызовом support: staff API support принимает только admin-bff, actor
  от user-admin не принимается (`ACTOR_NOT_ALLOWED`).
- Фильтры: `kind=account|child`; `age_band=6-9,10-13,14-17,18+,unknown` (`18+` без `%2B` приходит как `18 ` —
  принимается); `status=ACTIVE,DISABLED,…`; `locale=ru|uz`; `has_open_tickets=true|false`; `limit` 1..100 (20).
  Сортировка `(created_at, user_id)` по убыванию; `created_at` фиксируется один раз, когда профиль подтверждён
  (`user.profile.created.v1` или снимок identity-consent) — курсор стабилен. Строки, известные только по событиям
  других доменов (`profile_known=false`), в список и статистику не входят.
- `children_count` (у аккаунта) — действующие (не удалённые) детские профили, считается при чтении.
- Карточка **всегда** перечитывает identity-consent (`GET /admin/v1/users/{id}`, `refreshed_at` — момент чтения);
  `children` — детские профили аккаунта (кроме удалённых), `guardian` — опекун детского профиля; `plan` —
  `AdminLearnerPlan` из проекции learning-plan. Источник недоступен → данные проекции, `refreshed_at` — момент
  последнего чтения (или обновления проекции, если чтения ещё не было); ученик не известен проекции → 503
  `UPSTREAM_UNAVAILABLE {service}`; источник ответил 404 и профиль не подтверждён → 404 `LEARNER_NOT_FOUND`.
- `stats` (по действующим — профиль подтверждён, не DELETED): `total_accounts`/`total_children`; `new_in_period` —
  профили, созданные с начала периода (включая позже удалённые — это приток); `active_in_period` — с занятием
  (`learning.activity.recorded.v1`) с начала периода; `onboarding_completed_pct`, `reminders_enabled_pct` — доля,
  1 знак; `by_age_band`, `by_locale` (+ `unknown`). `today` — с полуночи по `STATS_TIMEZONE` (Asia/Tashkent).
- Ошибки: 401 (нет/неверный токен), 403 `CALLER_NOT_ALLOWED` (не admin-bff), 403 `STAFF_CONTEXT_REQUIRED` (нет actor),
  403 `PERMISSION_DENIED {permission}`, 400 `INVALID_CURSOR`, 404 `LEARNER_NOT_FOUND`, 422 `LEARNER_FILTER_INVALID` /
  `VALIDATION_ERROR`, 503 `UPSTREAM_UNAVAILABLE`.

### Сверка для n8n
`POST /internal/v1/reconcile` — `Authorization: Bearer <SCHEDULER_TOKEN>` (постоянное время; пустой токен — вход
выключен, 401 `SCHEDULER_TOKEN_INVALID`; внутренний JWT сервиса → 403 `CALLER_NOT_ALLOWED`). Прогоняет обе сверки →
200 `{identity: {ok, applied, skipped, error}, plans: {…}}` (`skipped: true` — прогон источника уже идёт, без
ожидания); источник недоступен → 503 `RECONCILE_FAILED {failed, applied}`. Повтор безопасен.

## События
Потребляет (durable `user-admin.projection`, inbox-дедупликация; принимаются только от домена-владельца, остальные —
warning без данных). Не публикует.
| Событие | Издатель | Действие |
|---|---|---|
| `user.profile.created.v1` | identity-consent | строка: `kind`, `guardian_user_id`, `locale`, `age_band`, `created_at`; досрочная сверка (имя и username есть только в источнике) |
| `user.profile.updated.v1` | identity-consent | `locale`, `age_band`, `guardian_consent`; смена имени → досрочная сверка |
| `user.status.changed.v1`, `user.deletion.requested.v1` | identity-consent | статус (`DELETION_REQUESTED`) |
| `consent.accepted.v1`, `consent.revoked.v1` | identity-consent | блок `consent`: у аккаунта — только `basis=self` (собственное согласие; решение родителя о подростке — `guardian_consent`), у детского профиля — только `basis=guardian` (ревью P2-3); вид ещё не известен — принимается, исправит снимок |
| `user.notification_settings.changed.v1` | identity-consent | блок `notifications` |
| `user.security.changed.v1` | identity-consent | `pin_enabled`, `pin_reset_pending` (pin_set/changed/reset/removed, pin_reset_requested/cancelled) |
| `user.domain.deleted.v1` (`domain=identity-consent`) | identity-consent | DELETED: стереть имя, username, маску, `search_text`, связь с опекуном, возраст, план, настройки, активность; отвязать обращения |
| `learning.plan.updated.v1` | learning-plan | `plan` (цель, язык, график, онбординг), `goal`, `reminders_enabled`, `onboarding_completed`; уровня и пресета в событии нет → досрочная сверка планов |
| `learning.activity.recorded.v1` | learning-plan | `last_activity_at` (максимум) |
| `support.ticket.created.v1`, `support.ticket.status.changed.v1` | support | `ticket_refs` → счётчики `open_tickets`/`tickets_total`, поиск по TCK |

Порядок доставки не гарантирован: у каждой группы полей своя версия (`*_at`: `source_updated_at`, `profile_at`,
`status_at`, `consent_at`, `pin_at`, `pin_reset_at`, `notifications_at`, `plan_at`), старое событие не перезаписывает
новое состояние; DELETED — конечный. Снимок источника против версии, выставленной событием, — с допуском 2 с
(`SNAPSHOT_CLOCK_SKEW`): версия снимка — момент изменения строки источника (часы БД), а `occurred_at` события той же
транзакции чуть позже (часы приложения); без допуска снимок не исправлял бы блок, искажённый событием. Версия после
снимка не уменьшается (max). Снимок, прочитанный до события и попавший в допуск, скрывает событие только до следующей
сверки (окно с перекрытием) или открытия карточки.

## Сверка с источниками
При старте (фоновые задачи, старт не ждёт источники) и каждые `RECONCILE_INTERVAL_SECONDS` (600), досрочно — после
событий без нужных данных (не чаще `RECONCILE_MIN_GAP_SECONDS`) и по `POST /internal/v1/reconcile`:
identity-consent `GET /admin/v1/users?updated_after=&cursor=&limit=500` и learning-plan
`GET /admin/v1/plans?updated_after=&cursor=&limit=` постранично (`RECONCILE_PAGE_SIZE`, 200); водяной знак
`updated_at` — в `reconcile_state` (`identity`, `plans`) после каждой страницы, окно с перекрытием
`RECONCILE_OVERLAP_SECONDS` (120). Снимок применяется по версии (`updated_at` источника): событие новее не затирается.
Страница — пачкой (ревью P2-6): одна вставка, одна выборка FOR UPDATE по возрастанию `user_id`, один запрос счётчиков
новых строк, одно отвязывание обращений удалённых, UPDATE строк — executemany (10 тыс. снимков ≈ 4 с вместо 48 с).
Один прогон источника за раз во всём сервисе: сессионная `pg_try_advisory_lock` (класс `UARC`, объект — схема +
источник) на выделенном соединении, на нём же транзакции страниц — прогон занимает одно соединение пула. Прогон уже
идёт (в процессе или на другой реплике) — новый не ждёт: `skipped`. Сбой источника не роняет сервис и не влияет на
readiness: тип ошибки — в лог и `reconcile_state.last_error`. Источники должны принимать вызывающего `user-admin`.

## Данные (схема `user_admin`, миграция 0001)
- `admin_learner_summary` — строка на ученика: поля `AdminLearnerRow` + JSONB `consent`, `security`, `notifications`,
  `plan` + служебные (`search_text`, `source_updated_at`, версии групп полей, `profile_known`, `refreshed_at`,
  `erased_at`). CHECK: формат маски, у детского профиля нет Telegram, опекун только у ребёнка, у DELETED нет PII,
  связи с опекуном и плана; индексы — `(created_at, user_id)`, `status`, `guardian_user_id` (частичный),
  `last_activity_at`;
- `ticket_refs` — номер/статус/автор обращения (счётчики пересчитываются из неё — идемпотентно);
- `reconcile_state` — водяной знак и исход сверки по источнику; `outbox`/`inbox` (`create_messaging_tables`).

## Настройки
`DATABASE_URL`, `MIGRATION_DATABASE_URL`, `NATS_URL`, `INTERNAL_JWT_*` (общие), `IDENTITY_CONSENT_URL`
(`http://127.0.0.1:8101`), `LEARNING_PLAN_URL` (`http://127.0.0.1:8102`), `UPSTREAM_TIMEOUT_SECONDS` (5),
`SCHEDULER_TOKEN` (stage/prod: пусто или ≥ 32 символов), `RECONCILE_ENABLED`, `RECONCILE_INTERVAL_SECONDS`,
`RECONCILE_MIN_GAP_SECONDS`, `RECONCILE_OVERLAP_SECONDS`, `RECONCILE_PAGE_SIZE` (200, ≤ 500), `STATS_TIMEZONE`.

## Runbook
- Миграции: `alembic -c alembic.ini upgrade head` (Railway preDeploy).
- Локально: `infra/dev/stack.sh up`, `ENV=dev DATABASE_URL=postgresql://user_admin:dev@127.0.0.1:5432/tilhero
  uv run uvicorn tilhero_user_admin.main:app --port 8121`.
- Read-модель отстала/пуста: `SELECT * FROM user_admin.reconcile_state` (`last_error`, `watermark`); внеочередной
  прогон — `POST /internal/v1/reconcile` (n8n); полная пересверка — `UPDATE user_admin.reconcile_state SET watermark =
  NULL` и `POST /internal/v1/reconcile`.
- Тесты: `uv run pytest services/user-admin -q`.
