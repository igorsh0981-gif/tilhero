# audit-service

**Владелец:** платформа (общий сервис Telegram- и Admin-контуров TilHero). **Bounded context:** неизменяемый журнал
действий учеников, сотрудников и сервисов, событий безопасности, согласий и удаления (append-only, хеш-цепочка).
Порт 8105, схема PostgreSQL `audit`, внутренний JWT с `aud = audit`.

## Кто пишет
**Через шину** (`admin.audit.recorded.v1`, outbox издателя в транзакции изменения): спринт 1 (INTERNAL_API §7) —
`identity-consent`, `learning-plan`, `social`, `experience-config`, `support`, `notifications`; спринт 2 —
`admin-identity` (`auth.*`, `staff.*`, `role.*`, `approval.*`) (`consumers.AUDIT_EVENT_PRODUCERS`). Актора определяет
издатель: сотрудник — из токена admin-bff (claim `actor`), ученик — из `sub`, иначе сам сервис. События безопасности,
согласий и удаления — только от `identity-consent` (`SECURITY_EVENT_PRODUCERS`). События остальных издателей
игнорируются с предупреждением в логе.

**По HTTP** (`POST /internal/v1/records`, синхронный аудит — запись до выдачи результата; спринт 2,
docs/sprint2/INTERNAL_API.md §3): только `admin-identity` и `identity-consent` (`api/routes.py WRITERS`); любой другой
сервис → 403 `CALLER_NOT_ALLOWED` (проверка вызывающего — до разбора тела). `actor_*` в теле запрещены (422), актор —
только из токена (сервис-издатель, ученик из `sub`). Сотрудник в теле (`on_behalf_of`) — только по списку `DELEGATION`
(издатель → действия): `identity-consent` → `sensitive.view`, `sensitive.view_rate_limited` (раскрытие Telegram ID
ученика сотрудником: claim `actor` audit принимает только от admin-bff, поэтому домен передаёт сотрудника из своего
actor-токена); иное → 403 `DELEGATION_NOT_ALLOWED`. Повтор `record_id` того же издателя идемпотентен (та же запись),
`record_id` чужой записи → 409 `AUDIT_RECORD_CONFLICT` (запись не перезаписывается и не возвращается).

## API
| Метод | Путь | Кто вызывает | Право |
|---|---|---|---|
| POST | `/internal/v1/records` | admin-identity, identity-consent | — (идемпотентно по `record_id`) |
| GET | `/admin/v1/audit/records?action=&actor_id=&object_type=&object_id=&date_from=&date_to=&limit=&cursor=` | admin-bff | `audit.read` |
| GET | `/admin/v1/audit/records/{record_id}` | admin-bff | `audit.read` |
| GET | `/admin/v1/audit/verify` | admin-bff | `audit.read` |

Список — новые первыми, `limit` 1…100 (50), курсор непрозрачный; неверный курсор → 400 `INVALID_CURSOR`; нет записи →
404 `AUDIT_RECORD_NOT_FOUND`. Писатели журнал не читают.

## События
Потребляет (inbox, `audit.admin_records`, `audit.security_events`):
- `admin.audit.recorded.v1` (payload = запись `RecordIn`, `record_id` задаёт издатель — повтор идемпотентен);
  невалидная запись от доверенного издателя (актор вне перечня, лишнее поле) не пишется: повтор → DLQ;
- от `identity-consent`: `consent.accepted.v1` → `consent.accept`, `consent.revoked.v1` → `consent.revoke`,
  `user.deletion.requested.v1` → `user.deletion_request` (повторы рассылки сагой `attempt > 1` не пишутся),
  `user.status.changed.v1` → `user.status_change`, `user.security.changed.v1` → `user.security_change`.
  `record_id = uuid5(event_id)`; в `after` — только коды и идентификаторы (`status`, `policy_version`, `purposes`,
  `change`, `reason_code`, `request_id`), возраст не пишется.

Не публикует.

## Данные
Схема `audit`, таблица `audit_records`: `hash = sha256(prev_hash + canonical_json(запись))`. UPDATE/DELETE/TRUNCATE запрещены
триггером **и правами**: схема и таблицы принадлежат `audit_owner` (миграции, `MIGRATION_DATABASE_URL`), роль сервиса
`audit` имеет только `USAGE` + `SELECT, INSERT` на журнал (миграция 0002, `infra/db/bootstrap.sql`) и не может снять триггер;
добавление сериализуется `pg_advisory_xact_lock`; `/verify` пересчитывает хеши всей цепочки. Хранятся только
идентификаторы и коды, без PII и текстов пользователей.

## Runbook
- Проверка целостности: `GET /admin/v1/audit/verify` → `valid=false, broken_at_seq=N` означает вмешательство в БД в обход
  сервиса: заморозить доступ к БД, снять дамп, эскалировать в security.
- Записи не появляются: проверить, что издатель есть в `AUDIT_EVENT_PRODUCERS` (иначе WARNING
  `audit event from unexpected producer ignored`), затем DLQ консьюмера `audit.admin_records`.
- Миграции: `alembic -c alembic.ini upgrade head` (Railway preDeploy).
- Локально: `infra/dev/stack.sh up`, `ENV=dev DATABASE_URL=postgresql://audit:dev@127.0.0.1:5432/tilhero
  NATS_URL=nats://127.0.0.1:4222 uv run uvicorn tilhero_audit.main:app --port 8105`.
- Тесты: `uv run pytest services/audit -q`. Права: `tests/test_audit.py::test_runtime_role_cannot_tamper_with_journal` —
  под ролью сервиса UPDATE/DELETE/TRUNCATE, `DISABLE TRIGGER`, `DROP TRIGGER`, смена владельца и CREATE TABLE →
  `insufficient_privilege`.
