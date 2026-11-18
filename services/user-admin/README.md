# user-admin

**Владелец:** команда Admin. **Bounded context:** read-модель пользователей для админки (ТЗ Admin «Users»,
`docs/sprint2/INTERNAL_API.md` § user-admin). Данными **не владеет**: authoritative-источник профиля — identity-consent,
онбординга — preferences, обращений — support. Порт 8121, схема `user_admin`, пакет `tilhero_user_admin`.

PII: копия `username`/`display_name` — только для поиска; полный Telegram ID не хранится и не отдаётся (только маска
`••••••789` от identity-consent; раскрытие — `POST identity-consent /admin/v1/users/{id}/reveal` через admin-bff).
В логах — только тип события/ошибки, без username, имени и user_id.

## API (вызывает только `admin-bff`, claim `actor` обязателен, права проверяются здесь же)
| Метод | Путь | Право | Ответ |
|---|---|---|---|
| GET | `/admin/v1/users?q=&status=&locale=&has_open_tickets=&access_level=&access_level_source=&cursor=&limit=` | `users.read` | `Page<AdminUserRow>` (новые сверху) |
| GET | `/admin/v1/users/{id}` | `users.read` | `AdminUserCard` без `tickets` и `ai_conversations` (их добавляет admin-bff) |
| GET | `/admin/v1/users/stats?period=today\|7d\|30d` | `dashboard.read` | `{total, new_in_period, onboarding_completed_pct, by_status, active_in_period, active_today}` (спринт 8: активные — `last_seen_at` с начала периода / дня, Ташкент; индекс — миграция 0003) |

- `q`: UUID пользователя; `@username` (префикс, без регистра); `TCK-3081` (владелец обращения); иначе — часть имени
  или username (`ILIKE`, спецсимволы `%`/`_` экранируются). `status` — один или несколько через запятую.
- Карточка перечитывает identity-consent (`GET /admin/v1/users/{id}`), если `refreshed_at` старше
  `CARD_MAX_AGE_SECONDS` (60). Источник недоступен → последние известные данные с прежним `refreshed_at`;
  пользователь ещё ни разу не читался из источника → 503 `UPSTREAM_UNAVAILABLE {service}`; источник ответил 404 → 404 `USER_NOT_FOUND`.
- Спринт 7: в строке и карточке `access_level: {level, source: default|manual, expires_at}` — действующий уровень
  доступа к AI из проекции ai-control: ручное назначение, пока не истёк срок; иначе `source: default` (`level` — код
  уровня по умолчанию из события сброса или `null`, если событий не было). Authoritative-значение и назначение
  (`users.access.manage`, причина, срок, аудит) — ai-control `GET/PUT/DELETE /internal/v1/access/users/{id}`.
  Фильтры: `access_level=plus[,vip]` (≤ 10 кодов `^[a-z][a-z0-9_]{1,31}$`) — действующие ручные назначения;
  `access_level_source=manual|default`. Неверный код → 422 `USER_FILTER_INVALID`.
- `stats`: `total` — неудалённые; `new_in_period` — профили, созданные с начала периода (`today` — по `STATS_TIMEZONE`,
  Asia/Tashkent); `onboarding_completed_pct` — доля среди неудалённых, 1 знак.
- Ошибки: 401 (нет/неверный токен), 403 `CALLER_NOT_ALLOWED` (не admin-bff), 403 `STAFF_CONTEXT_REQUIRED` (нет actor),
  403 `PERMISSION_DENIED {permission}`, 400 `INVALID_CURSOR`, 422 `USER_FILTER_INVALID` / `VALIDATION_ERROR`.

## События
Потребляет (`user-admin.projection`, inbox-дедупликация; принимаются только от домена-владельца, остальные — warning):
| Событие | Издатель | Действие |
|---|---|---|
| `user.profile.created.v1` | identity-consent | строка, `created_at`, `locale`; досрочная сверка (username есть только в источнике) |
| `user.status.changed.v1`, `user.deletion.requested.v1` | identity-consent | статус |
| `consent.accepted.v1`, `consent.revoked.v1` | identity-consent | блок согласия |
| `user.security.changed.v1` | identity-consent | PIN / биометрия |
| `user.preferences.updated.v1` | preferences | онбординг, `changed_fields` |
| `support.ticket.created.v1`, `support.ticket.status.changed.v1` | support | `ticket_refs` → счётчики `open_tickets`/`tickets_total`, поиск по TCK |
| `user.domain.deleted.v1` (`domain=identity-consent`) | identity-consent | DELETED: стереть username/имя/маску и уровень доступа, отвязать обращения |
| `user.deletion.stuck.v1` (спринт 9) | identity-consent | `deletion_stuck_at` — «удаление зависло» (поле `deletion_stuck_at` в строке и карточке); стирается при DELETED |
| `user.access_level.changed.v1` (спринт 7) | ai-control | `access_level`, `access_level_source`, `access_level_expires_at`; порядок — по `version` назначения (старая/повтор — без изменений), битый payload — warning |

Список сортируется по `(created_at, user_id)`; `created_at` фиксируется один раз, когда профиль подтверждён (`user.profile.created.v1` или снимок identity-consent), и дальше не меняется — курсор стабилен. Строки, известные только по событиям других доменов (`profile_known=false`), в список и статистику не входят.

Порядок доставки не гарантирован: у каждой группы полей своя версия (`*_at`), старое событие не перезаписывает новое
состояние; DELETED — конечный. Не публикует событий.

## Сверка с identity-consent
При старте (фоновая задача, старт не ждёт источник) и каждые `SYNC_INTERVAL_SECONDS` (600), досрочно — после
`user.profile.created.v1`: `GET identity-consent /admin/v1/users?updated_after=&cursor=&limit=` постранично; водяной
знак `updated_at` — в `sync_state` после каждой страницы, окно с перекрытием `SYNC_OVERLAP_SECONDS` (120). Сбой
источника не роняет сервис и не влияет на readiness: тип ошибки — в лог и `sync_state.last_error`.

## Данные (схема `user_admin`)
- `admin_user_summary` — строка на пользователя (CHECK: у DELETED нет username/имени и уровня доступа); миграция 0002 —
  `access_level*` (CHECK формата и источника, частичный индекс по ручным назначениям); миграция 0004 (спринт 9) —
  `deletion_stuck_at` (CHECK: у DELETED — NULL);
- `ticket_refs` — номер/статус/владелец обращения (счётчики пересчитываются из неё — идемпотентно);
- `sync_state` — водяной знак и исход сверки; `outbox`/`inbox` (`create_messaging_tables`).

## Настройки
`DATABASE_URL`, `MIGRATION_DATABASE_URL`, `NATS_URL`, `INTERNAL_JWT_*` (общие), `IDENTITY_URL` (identity-consent,
по умолчанию `http://127.0.0.1:8101`), `SYNC_ENABLED`, `SYNC_INTERVAL_SECONDS`, `SYNC_OVERLAP_SECONDS`,
`CARD_MAX_AGE_SECONDS`, `STATS_TIMEZONE`. identity-consent должен принимать вызывающего `user-admin`.

## Runbook

> Эксплуатация через браузер (Railway, админка, оповещения ops-monitor): [docs/runbooks/user-admin.md](../../docs/runbooks/user-admin.md). Ниже — технические детали для разработчика.
- Миграции: `alembic -c alembic.ini upgrade head` (Railway preDeploy).
- Локально: `infra/dev/stack.sh up`, `ENV=dev DATABASE_URL=postgresql://user_admin:dev@127.0.0.1:5432/tilhero
  uv run uvicorn tilhero_user_admin.main:app --port 8121`.
- Read-модель отстала/пуста: проверить `SELECT * FROM user_admin.sync_state` (`last_error`, `watermark`); полная
  пересверка — `UPDATE user_admin.sync_state SET watermark = NULL` и перезапуск сервиса.
- Тесты: `uv run pytest services/user-admin -q`.
