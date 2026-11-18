"""Аудит действий сотрудников: `admin.audit.recorded.v1` через outbox в транзакции изменения (payload = RecordIn
audit-service). Тексты шаблонов и рассылок в журнал не попадают — только ключи, версии, статусы и причины;
Telegram chat id тестовых получателей — только индекс."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit

AUDIT_EVENT = "admin.audit.recorded.v1"
PRODUCER = "notifications"
TEMPLATE = "notification_template"
CAMPAIGN = "campaign"


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def record(
    action: str,
    object_type: str,
    object_id: str,
    *,
    actor: Actor | None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    reason: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    return {
        "record_id": str(uuid.uuid4()),
        "occurred_at": _iso(now or datetime.now(UTC)),
        "actor_type": "staff" if actor is not None else "system",
        "actor_id": actor.id[:64] if actor is not None else None,
        "actor_role": actor.role[:64] if actor is not None else None,
        "action": action,
        "object_type": object_type,
        "object_id": object_id[:200],
        "before": before,
        "after": after,
        "reason": reason,
        "trace_id": context.get_trace_id()[:64],
    }


async def emit_audit(session: AsyncSession, payload: dict[str, Any]) -> None:
    await emit(session, AUDIT_EVENT, payload, producer=PRODUCER)
