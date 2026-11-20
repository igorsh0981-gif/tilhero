"""Общее для домена catalog: хеш тела, время, курсоры, аудит и события (outbox)."""

from __future__ import annotations

import base64
import hashlib
import json
import uuid
from datetime import UTC, date, datetime
from typing import Any, Final
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.errors import ApiError, bad_request, not_found
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit

PRODUCER: Final = "catalog"
AUDIT_EVENT: Final = "admin.audit.recorded.v1"
VERSION_PUBLISHED: Final = "catalog.version.published.v1"
MEDIA_SUSPENDED: Final = "catalog.media.suspended.v1"
REQUEST_CREATED: Final = "catalog.media_request.created.v1"
REQUEST_DECIDED: Final = "catalog.media_request.decided.v1"
GLOSSARY_CHANGED: Final = "catalog.glossary.changed.v1"
DELETION_REQUESTED: Final = "user.deletion.requested.v1"
DOMAIN_DELETED: Final = "user.domain.deleted.v1"

# Системные субъекты: сид контента (автор и проверяющий миграции 0003) и планировщик (catalog:tick)
SEED_ACTOR_ID: Final = "00000000-0000-4000-a000-000000005eed"
SYSTEM_ACTOR_ID: Final = "system:catalog"

# Права сотрудников (PLAN «Права и роли»): проверяются здесь, в домене, а не только в admin-bff
CONTENT_READ: Final = "content.read"
CONTENT_EDIT: Final = "content.edit"
CONTENT_REVIEW: Final = "content.review"
CONTENT_PUBLISH: Final = "content.publish"
MEDIA_RIGHTS: Final = "media.rights"
LANG_MANAGE: Final = "lang.manage"
DASHBOARD_READ: Final = "dashboard.read"
GLOSSARY_MANAGE: Final = "glossary.manage"


def canonical_json(data: Any) -> str:
    return json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def payload_hash(payload: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso_z(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def local_today(tz: str, now: datetime | None = None) -> date:
    """«Сегодня» для прав медиа — по часовому поясу сервиса (Asia/Tashkent)."""
    return (now or utcnow()).astimezone(ZoneInfo(tz)).date()


def as_uuid_or_none(value: str | None) -> str | None:
    """UUID сотрудника для событий (published_by — format uuid); не-UUID (system:…) → None."""
    if not value:
        return None
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return None


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


# ---------------------------------------------------------------- аудит и события


def audit_payload(actor: Actor | None, action: str, object_type: str, object_id: str, *,
                  before: dict[str, Any] | None = None, after: dict[str, Any] | None = None,
                  reason: str | None = None, actor_type: str | None = None) -> dict[str, Any]:
    """admin.audit.recorded.v1 — без текстов контента и заявок (журнал неизменяем): статусы, версии, хеши."""
    return {
        "record_id": str(uuid.uuid4()),
        "occurred_at": iso_z(utcnow()),
        "actor_type": actor_type or ("staff" if actor is not None else "system"),
        "actor_id": (actor.id[:64] if actor is not None else SYSTEM_ACTOR_ID),
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


async def emit_event(session: AsyncSession, event_type: str, payload: dict[str, Any]) -> None:
    await emit(session, event_type, payload, producer=PRODUCER)


def version_object_id(kind: str, key: str, version: int | None = None) -> str:
    return f"{kind}:{key}" if version is None else f"{kind}:{key}@{version}"


# ---------------------------------------------------------------- ошибки домена


def content_not_found(kind: str, key: str) -> ApiError:
    return not_found("CONTENT_NOT_FOUND", f"Нет сущности {kind} «{key}»")


def version_not_found(kind: str, key: str, version: int) -> ApiError:
    return not_found("VERSION_NOT_FOUND", f"Нет версии {version} сущности {kind} «{key}»")
