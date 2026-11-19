"""Общее для домена ai-gateway: время, хеши, деньги, курсоры, права, аудит и события (outbox)."""

from __future__ import annotations

import base64
import hashlib
import json
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Final
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.errors import bad_request
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit

PRODUCER: Final = "ai-gateway"
AUDIT_EVENT: Final = "admin.audit.recorded.v1"
DELETION_REQUESTED: Final = "user.deletion.requested.v1"
DOMAIN_DELETED: Final = "user.domain.deleted.v1"

# Системные субъекты: сид версий (автор и публикующий миграции 0002, как в catalog) и сам шлюз
SEED_ACTOR_ID: Final = "00000000-0000-4000-a000-000000005eed"
SYSTEM_ACTOR_ID: Final = "system:ai-gateway"

# Права сотрудников (PLAN «Права и роли», admin.ts): проверяются здесь, в домене, а не только в admin-bff
AI_READ: Final = "ai.read"
AI_MANAGE: Final = "ai.manage"
AI_PUBLISH: Final = "ai.publish"
COSTS_READ: Final = "costs.read"
COSTS_MANAGE: Final = "costs.manage"
QA_READ: Final = "qa.read"
DASHBOARD_READ: Final = "dashboard.read"

Q6: Final = Decimal("0.000001")


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso_z(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_json(data: Any) -> str:
    return json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)


def sha256_hex(data: Any) -> str:
    return hashlib.sha256(canonical_json(data).encode("utf-8")).hexdigest()


def usd(value: Decimal | int | float | None) -> float:
    """Деньги в JSON — число с 6 знаками (контракт ai.ts — number); расчёты — только Decimal."""
    if value is None:
        return 0.0
    return float(Decimal(value).quantize(Q6, rounding=ROUND_HALF_UP))


def month_start(now: datetime) -> datetime:
    """Потолок месяца — календарный месяц UTC."""
    n = now.astimezone(UTC)
    return datetime(n.year, n.month, 1, tzinfo=UTC)


def local_day_start(now: datetime, tz: str) -> datetime:
    """Начало «сегодня» по часовому поясу (Asia/Tashkent) в UTC — лимит ученика в день."""
    local = now.astimezone(ZoneInfo(tz))
    return datetime(local.year, local.month, local.day, tzinfo=ZoneInfo(tz)).astimezone(UTC)


def local_date(value: datetime, tz: str) -> date:
    return value.astimezone(ZoneInfo(tz)).date()


def days_ago(now: datetime, days: int) -> datetime:
    return now - timedelta(days=days)


# ---------------------------------------------------------------- курсоры (непрозрачные)


def encode_cursor(*parts: Any) -> str:
    raw = json.dumps(list(parts), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str | None, arity: int) -> list[Any] | None:
    if cursor is None:
        return None
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        parts = json.loads(raw)
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc
    if not isinstance(parts, list) or len(parts) != arity:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор")
    return parts


# ---------------------------------------------------------------- аудит


def audit_payload(actor: Actor | None, action: str, object_type: str, object_id: str, *,
                  before: dict[str, Any] | None = None, after: dict[str, Any] | None = None,
                  reason: str | None = None, actor_type: str | None = None,
                  actor_id: str | None = None) -> dict[str, Any]:
    """admin.audit.recorded.v1 — без текстов инструкций и реплик (журнал неизменяем): версии, хеши, числа."""
    return {
        "record_id": str(uuid.uuid4()),
        "occurred_at": iso_z(utcnow()),
        "actor_type": actor_type or ("staff" if actor is not None else "system"),
        "actor_id": actor_id or (actor.id[:64] if actor is not None else SYSTEM_ACTOR_ID),
        "actor_role": (actor.role[:64] if actor is not None else None),
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


def version_object_id(agent_id: str, version: int | None = None) -> str:
    return agent_id if version is None else f"{agent_id}@{version}"
