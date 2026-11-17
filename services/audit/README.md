# audit-service

**Владелец:** платформа (общий сервис Telegram- и Admin-контуров). **Bounded context:** неизменяемый журнал административных и security-действий (ТЗ Admin §10, AD-FR-011).

## API
| Метод | Путь | Кто вызывает | Право |
|---|---|---|---|
| POST | `/internal/v1/records` | только `admin-bff`, `support`, `experience-config`, `identity-consent`, `admin-identity`, `user-admin`, `provider-gateway` (спринт 4) | — (идемпотентно по `record_id`) |
| GET | `/admin/v1/audit/records` | admin-bff | `audit.read` |
| GET | `/admin/v1/audit/records/{record_id}` | admin-bff | `audit.read` |
| GET | `/admin/v1/audit/verify` | admin-bff | `audit.read` |

**Кто действовал — только из токена (ревью P4):** `actor` в токене (его принимают только от admin-bff) → `staff` +
`actor.id`/`actor.role`; иначе `sub` → `user`; иначе `service` + издатель. Поля `actor_type/actor_id/actor_role` в теле
запроса запрещены (422). `source` = издатель токена.

**Делегированный актор (спринт 2):** claim `actor` принимается только от admin-bff, поэтому доменный сервис, который
синхронно пишет запись о команде сотрудника (reveal Telegram ID в identity-consent), передаёт его в
`on_behalf_of {actor_id, actor_role}` → `actor_type=staff`. Принимается **только** от `identity-consent` и **только** для
действий `sensitive.view`, `sensitive.view_rate_limited` (и `provider-gateway` для `ai.kill_switch.on/off`, спринт 4, и `ai.limits.update/reset`, исправление 6.1),
и только если в токене нет `actor`/`sub`; иначе (другой сервис,
другое действие, admin-bff) → 403 `DELEGATION_NOT_ALLOWED`. Остальные домены пишут от своего имени
(`actor_type=service`) или событием `admin.audit.recorded.v1`; admin-bff передаёт сотрудника токеном.

**Спринт 4:** `source-registry` публикует `source.created/updated/enabled/disabled` событием (сотрудник — из токена
admin-bff на стороне издателя), `events` — решения очереди проверки (`review.accepted/rejected/corrected`) событием.
`provider-gateway` (без БД и outbox) — единственный HTTP-писатель из спринта 4: пишет `ai.kill_switch.on/off` синхронно
через `POST /internal/v1/records`, сотрудника передаёт делегированием (`on_behalf_of`, `DELEGATION["provider-gateway"]`
= только `ai.kill_switch.*` и `ai.limits.*`) → `actor_type=staff`. `events` и `source-registry` пишут аудит только событием через outbox
(`AUDIT_EVENT_PRODUCERS`); по HTTP им писать не нужно, поэтому их нет в `WRITERS` (минимальные права) —
`POST /internal/v1/records` от них → 403 `CALLER_NOT_ALLOWED`.

**Спринт 7 (AI-контур, INTERNAL_API §4):** HTTP-писатели += `ai-control`, `ai-concierge` — синхронный аудит **до**
изменения (команды) или до выдачи (раскрытие содержимого). Делегирование:
- `provider-gateway` += `ai.agent.pause/resume`, `ai.provider.pause/resume` (A47); `ai.budget.auto_pause` — от system,
  без `on_behalf_of`;
- `ai-control`: `ai.agent.config.update`, `skill.version.created/updated`, `skill.tested`, `skill.review.requested/decided`,
  `skill.published`, `skill.rolled_back`, `skill.deprecated`, `skill.case.created/updated/deleted`,
  `ai.pricing.create/update/activate`, `ai.budget.alert.ack`, `ai.access_level.update/delete`,
  `user.access_level.assign/reset`; `ai.budget.threshold` — от system (`actor_type=service`, `ai-control`);
- `ai-concierge`: только `ai.content.view` (A43).
Событием `admin.audit.recorded.v1` эти сервисы не пишут (их события игнорируются).

**Спринт 8 (операции, INTERNAL_API §2.4, §3.3):** HTTP-писатель += `ops-monitor`. Делегирование — только
`ops.dlq.replay`, `ops.dlq.delete`, `ops.alert.ack` (синхронно, до действия); `ops.alert.raised` / `ops.alert.resolved`
— от system (`actor_type=service`, `ops-monitor`, отложенная отправка из `audit_pending`). Читать журнал ops-monitor не может.

## События
Потребляет (только от известных издателей: `admin.audit.recorded.v1` — admin-bff, support, experience-config, admin-identity, user-admin, source-registry, events (спринт 4), news (спринт 6: `news.source.*`, `news.item.hidden|unhidden`);
события безопасности — identity-consent; остальное игнорируется с предупреждением): `admin.audit.recorded.v1` (payload = запись), `consent.accepted.v1`, `consent.revoked.v1`, `user.deletion.requested.v1`, `user.status.changed.v1`, `user.security.changed.v1`. Не публикует.

## Данные
Схема `audit`, таблица `audit_records`: `hash = sha256(prev_hash + canonical_json(запись))`. UPDATE/DELETE/TRUNCATE запрещены
триггером **и правами**: схема и таблицы принадлежат `audit_owner` (миграции, `MIGRATION_DATABASE_URL`), роль сервиса
`audit` имеет только `USAGE` + `SELECT, INSERT` на журнал (миграция 0002, `infra/db/bootstrap.sql`) и не может снять триггер; добавление сериализуется `pg_advisory_xact_lock`; `/verify` пересчитывает хеши всей цепочки. Хранятся только идентификаторы, без PII.

## Runbook

> Эксплуатация через браузер (Railway, админка, оповещения ops-monitor): [docs/runbooks/audit.md](../../docs/runbooks/audit.md). Ниже — технические детали для разработчика.
- Проверка целостности: `GET /admin/v1/audit/verify` → `valid=false, broken_at_seq=N` означает вмешательство в БД в обход сервиса: заморозить доступ к БД, снять дамп, эскалировать в security.
- Миграции: `alembic -c alembic.ini upgrade head` (Railway preDeploy).
- Локально: `infra/dev/stack.sh up`, `ENV=dev DATABASE_URL=postgresql://audit:dev@127.0.0.1:5432/tilhero uv run uvicorn tilhero_audit.main:app --port 8105`.
- Права: `tests/test_audit.py::test_runtime_role_cannot_tamper_with_journal` — под ролью сервиса UPDATE/DELETE/TRUNCATE,
  `DISABLE TRIGGER`, `DROP TRIGGER`, смена владельца и CREATE TABLE → `insufficient_privilege`.
