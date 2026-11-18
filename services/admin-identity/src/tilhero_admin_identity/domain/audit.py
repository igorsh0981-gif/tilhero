"""Запись аудита: событие admin.audit.recorded.v1 через outbox в транзакции изменения.

Payload = RecordIn audit-service. Никогда не кладём пароли, коды, секреты, challenge, cookie/id сессии
(только хеш), email при неудачном входе — только хеш.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.messaging import emit

PRODUCER = "admin-identity"
AUDIT_EVENT = "admin.audit.recorded.v1"


def audit_payload(
    action: str,
    *,
    actor_id: str | uuid.UUID | None = None,
    actor_role: str | None = None,
    object_type: str | None = None,
    object_id: str | uuid.UUID | None = None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    reason: str | None = None,
    ip: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    return {
        "record_id": str(uuid.uuid4()),
        "occurred_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "actor_type": "staff" if actor_id is not None else "system",
        "actor_id": str(actor_id)[:64] if actor_id is not None else None,
        "actor_role": actor_role[:64] if actor_role else None,
        "action": action,
        "object_type": object_type,
        "object_id": str(object_id)[:128] if object_id is not None else None,
        "before": before,
        "after": after,
        "reason": reason[:2000] if reason else None,
        "ip": ip[:64] if ip else None,
        "session_id": session_id[:64] if session_id else None,
        "trace_id": context.get_trace_id()[:64],
    }


async def record(session: AsyncSession, action: str, **kw: Any) -> None:
    await emit(session, AUDIT_EVENT, audit_payload(action, **kw), producer=PRODUCER)
