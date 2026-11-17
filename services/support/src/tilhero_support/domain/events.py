"""Доменные события support и записи аудита — только через outbox в транзакции изменения.

Payload — строго по packages/contracts/events/*.schema.json: только идентификаторы и коды,
без текста сообщений и персональных данных (тексты ответа в уведомление не кладём).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit
from tilhero_support.domain.constants import ticket_number
from tilhero_support.models import Message, Ticket

TICKET_CREATED = "support.ticket.created.v1"
TICKET_REPLIED = "support.ticket.replied.v1"
TICKET_STATUS_CHANGED = "support.ticket.status.changed.v1"
AUDIT_RECORDED = "admin.audit.recorded.v1"
DOMAIN_DELETED = "user.domain.deleted.v1"
DELETION_REQUESTED = "user.deletion.requested.v1"


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


async def ticket_created(session: AsyncSession, ticket: Ticket, *, producer: str) -> None:
    await emit(
        session,
        TICKET_CREATED,
        {
            "ticket_id": str(ticket.ticket_id),
            "number": ticket_number(ticket.number),
            "user_id": str(ticket.user_id),
            "category": ticket.category,
            "priority": ticket.priority,
            "has_event_context": ticket.context is not None,
            "sla_first_response_at": iso(ticket.sla_first_response_at),
        },
        producer=producer,
    )


async def ticket_replied(session: AsyncSession, ticket: Ticket, message: Message, *, producer: str) -> None:
    """Только публичный ответ оператора клиенту (внутренняя заметка события не порождает)."""
    # Явные проверки (не assert: при python -O они исчезают) — внутренняя заметка не должна уйти клиенту
    if message.visibility != "public" or message.sender_type not in ("operator", "system"):
        raise ValueError("support.ticket.replied.v1 is only for public operator/system replies")
    if ticket.user_id is None:
        raise ValueError("anonymized ticket has no recipient")
    await emit(
        session,
        TICKET_REPLIED,
        {
            "ticket_id": str(ticket.ticket_id),
            "number": ticket_number(ticket.number),
            "user_id": str(ticket.user_id),
            "message_id": str(message.message_id),
            "sender_type": message.sender_type,
            "replied_at": iso(message.created_at),
        },
        producer=producer,
    )


async def status_changed(
    session: AsyncSession, ticket: Ticket, from_status: str, *, changed_by: str, producer: str
) -> None:
    await emit(
        session,
        TICKET_STATUS_CHANGED,
        {
            "ticket_id": str(ticket.ticket_id),
            "number": ticket_number(ticket.number),
            "user_id": str(ticket.user_id) if ticket.user_id else None,
            "from_status": from_status,
            "to_status": ticket.status,
            "changed_by": changed_by,
        },
        producer=producer,
    )


async def domain_deleted(session: AsyncSession, user_id: str, request_id: str, *, producer: str) -> None:
    await emit(
        session,
        DOMAIN_DELETED,
        {
            "user_id": user_id,
            "request_id": request_id,
            "domain": "support",
            "mode": "anonymized",
        },
        producer=producer,
    )


async def audit(
    session: AsyncSession,
    actor: Actor,
    action: str,
    *,
    object_type: str,
    object_id: str,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
    producer: str,
    reason: str | None = None,
    now: datetime | None = None,
) -> None:
    """Аудит изменяющей команды сотрудника (ТЗ Admin §10). Без текстов сообщений: журнал неизменяем и не
    обезличивается при удалении пользователя, поэтому туда попадают только идентификаторы и коды."""
    await emit(
        session,
        AUDIT_RECORDED,
        {
            "record_id": str(uuid.uuid4()),
            "occurred_at": iso(now or datetime.now(UTC)),
            "actor_type": "staff",
            "actor_id": actor.id[:64],
            "actor_role": actor.role[:64],
            "action": action,
            "object_type": object_type,
            "object_id": object_id,
            "before": before,
            "after": after,
            "reason": reason,
            "trace_id": context.get_correlation_id()[:64],
        },
        producer=producer,
    )
