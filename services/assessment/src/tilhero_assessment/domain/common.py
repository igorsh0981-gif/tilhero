"""Общее для домена assessment: события и права, ошибки, время, курсоры, advisory-блокировки, аудит (outbox)."""

from __future__ import annotations

import base64
import json
import uuid
from datetime import UTC, datetime
from typing import Any, Final

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.errors import ApiError, bad_request, not_found
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit

PRODUCER: Final = "assessment"
AUDIT_EVENT: Final = "admin.audit.recorded.v1"
COMPLETED: Final = "assessment.completed.v1"
REEVALUATED: Final = "assessment.reevaluated.v1"
APPEAL_DECIDED: Final = "assessment.appeal.decided.v1"
DELETION_REQUESTED: Final = "user.deletion.requested.v1"
DOMAIN_DELETED: Final = "user.domain.deleted.v1"

# Права сотрудников (PLAN «Права и роли»): проверяются в домене по actor (защита в глубину)
QA_READ: Final = "qa.read"
QA_REVIEW: Final = "qa.review"
DASHBOARD_READ: Final = "dashboard.read"

EVALUATOR_AGENT: Final = "independent_evaluator"

# классы транзакционных advisory-блокировок assessment
_LOCK_SESSION: Final = 0x0A55
_LOCK_USER: Final = 0x0A56


def iso_z(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _lock_key(value: uuid.UUID) -> int:
    return int.from_bytes(value.bytes[:4], "big", signed=True)


async def lock_session(session: AsyncSession, session_id: uuid.UUID) -> None:
    """Сериализация оценки и переоценок одной сессии (цепочки) до конца транзакции."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, :o)"),
                          {"c": _LOCK_SESSION, "o": _lock_key(session_id)})


async def lock_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    """Сериализация команд одного ученика (апелляции, сага удаления) до конца транзакции."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, :o)"), {"c": _LOCK_USER, "o": _lock_key(user_id)})


# ---------------------------------------------------------------- ошибки


def evaluation_not_found() -> ApiError:
    return not_found("EVALUATION_NOT_FOUND", "Оценка не найдена")


def appeal_not_found() -> ApiError:
    return not_found("APPEAL_NOT_FOUND", "Апелляция не найдена")


def user_deleted() -> ApiError:
    return ApiError(410, "USER_DELETED", "Данные ученика удалены по запросу")


class IdempotencyReused(Exception):
    """Ключ идемпотентности уже использован с другими данными (→ 422 IDEMPOTENCY_KEY_REUSED)."""


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


def cursor_time_id(cursor: str | None) -> tuple[datetime, uuid.UUID] | None:
    parts = decode_cursor(cursor, 2)
    if parts is None:
        return None
    try:
        return datetime.fromisoformat(str(parts[0])), uuid.UUID(str(parts[1]))
    except ValueError as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc


# ---------------------------------------------------------------- аудит


def audit_payload(actor: Actor, action: str, object_type: str, object_id: str, *,
                  before: dict[str, Any] | None = None, after: dict[str, Any] | None = None,
                  reason: str | None = None) -> dict[str, Any]:
    """admin.audit.recorded.v1 — без текстов ученика (реплики, ответы, причина апелляции): идентификаторы, статусы,
    баллы; reason — основание сотрудника."""
    return {
        "record_id": str(uuid.uuid4()),
        "occurred_at": iso_z(datetime.now(UTC)),
        "actor_type": "staff",
        "actor_id": actor.id[:64],
        "actor_role": actor.role[:64],
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


async def emit_event(session: AsyncSession, event_type: str, payload: dict[str, Any],
                     causation_id: str | None = None) -> None:
    await emit(session, event_type, payload, producer=PRODUCER, causation_id=causation_id)
