"""Потребители событий: всё, что относится к аудиту, попадает в журнал ровно один раз (inbox).

Приём только от известных издателей (ревью P4 «Бот турист»): записи `admin.audit.recorded.v1` — от доменных
сервисов TilHero, которые пишут аудит через outbox (INTERNAL_API спринта 1, §7; спринта 2 — admin-identity);
события безопасности, согласий и удаления — только от identity-consent. Прочее отбрасывается с предупреждением
(inbox отмечает событие обработанным).
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_audit.domain import EVENT_ACTIONS, append
from tilhero_audit.schemas import RecordIn
from tilhero_common.messaging import Envelope

AUDIT_EVENT = "admin.audit.recorded.v1"
# Писатели через шину: спринт 1 (INTERNAL_API §7) + спринт 2 — admin-identity (вход, сотрудники, роли, four-eyes;
# docs/sprint2/INTERNAL_API.md §1: аудит auth.*, staff.*, role.*, approval.* через admin.audit.recorded.v1).
AUDIT_EVENT_PRODUCERS = frozenset({
    "identity-consent", "learning-plan", "social", "experience-config", "support", "notifications", "admin-identity",
    "catalog", "diagnostics", "lessons", "assessment", "ai-gateway",
})
SECURITY_EVENT_PRODUCERS = frozenset({"identity-consent"})

log = logging.getLogger("tilhero.audit.consumers")


def _attempt(v: object) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) else 1


def _rejected(env: Envelope) -> None:
    log.warning("audit event from unexpected producer ignored",
                extra={"event_type": env.event_type, "producer": env.producer[:64]})


async def on_admin_audit(session: AsyncSession, env: Envelope) -> None:
    """Payload события = RecordIn: издатель сам определяет актора (сотрудник — из токена admin-bff, ученик — из sub,
    иначе сервис) и кладёт запись в outbox в транзакции изменения."""
    if env.producer not in AUDIT_EVENT_PRODUCERS:
        _rejected(env)
        return
    await append(session, RecordIn.model_validate(env.payload), source=env.producer)


async def on_security_event(session: AsyncSession, env: Envelope) -> None:
    if env.producer not in SECURITY_EVENT_PRODUCERS:
        _rejected(env)
        return
    action, object_type = EVENT_ACTIONS[env.event_type]
    p = env.payload
    if env.event_type == "user.deletion.requested.v1" and _attempt(p.get("attempt")) > 1:
        # повтор рассылки сагой (тот же request_id) — не новый запрос пользователя
        return
    user_id = p.get("user_id")
    # только коды и идентификаторы; возраст (age_band) в журнал не попадает — его хранит только identity-consent
    after = {k: v for k, v in p.items()
             if k in {"status", "policy_version", "purposes", "change", "reason_code", "request_id"}}
    await append(
        session,
        RecordIn(
            # record_id детерминирован от event_id: повторная доставка не создаёт дубль даже в обход inbox
            record_id=uuid.uuid5(uuid.NAMESPACE_URL, f"tilhero:{env.event_id}"),
            occurred_at=env.occurred_at,
            actor_type="user" if user_id else "system",
            actor_id=user_id,
            action=action,
            object_type=object_type,
            object_id=user_id,
            after=after or None,
            trace_id=env.correlation_id[:64],
        ),
        source=env.producer,
    )
