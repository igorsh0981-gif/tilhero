"""Общее для домена memory: события, права, ошибки (коды bff.ts «Спринт 5»), блокировки, время, курсоры, аудит."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import uuid
from collections.abc import Callable, Iterable
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Final
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.errors import ApiError, bad_request, conflict, not_found
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit

PRODUCER: Final = "memory"
REVIEW_COMPLETED: Final = "memory.review.completed.v1"
REVIEWS_DUE: Final = "memory.reviews.due.v1"
RETENTION_CHECKED: Final = "memory.retention.checked.v1"
DOMAIN_DELETED: Final = "user.domain.deleted.v1"
AUDIT_EVENT: Final = "admin.audit.recorded.v1"

# права сотрудников (PLAN «Права и роли») — проверяются в домене по actor (защита в глубину)
MEMORY_READ: Final = "memory.read"
MEMORY_MANAGE: Final = "memory.manage"
DASHBOARD_READ: Final = "dashboard.read"

KIDS_BANDS: Final = frozenset({"6-9", "10-13"})
AGE_BANDS: Final = frozenset({"6-9", "10-13", "14-17", "18+"})

_LOCK_USER: Final = 0x4D454D55  # 'MEMU' — команды одного ученика
Localized = dict[str, str]


def loc(ru: str, uz: str) -> Localized:
    return {"ru": ru, "uz": uz}


# ---------------------------------------------------------------- ошибки


def card_not_found() -> ApiError:
    return not_found("CARD_NOT_FOUND", "Карточка не найдена")


def session_not_found() -> ApiError:
    return not_found("REVIEW_SESSION_NOT_FOUND", "Повторение не найдено")


def task_not_found() -> ApiError:
    return not_found("TASK_NOT_FOUND", "Задание не найдено")


def content_not_found() -> ApiError:
    return not_found("CONTENT_NOT_FOUND", "Материал не найден или не опубликован")


def session_state(status: str, **extra: Any) -> ApiError:
    return conflict("REVIEW_SESSION_STATE", "Действие недоступно в текущем состоянии повторения",
                    {"status": status, **extra})


def task_not_current(current: uuid.UUID | None) -> ApiError:
    return conflict("TASK_NOT_CURRENT", "Это не текущее задание",
                    {"current_task_id": str(current) if current else None})


def hints_not_allowed() -> ApiError:
    return conflict("HINTS_NOT_ALLOWED", "Для этого задания подсказки недоступны")


def nothing_to_review(next_due_at: str | None) -> ApiError:
    return conflict("NOTHING_TO_REVIEW", "Сегодня повторять нечего", {"next_due_at": next_due_at})


def cards_limit(limit: int) -> ApiError:
    return ApiError(422, "CARDS_LIMIT", "В словаре уже максимум карточек", {"limit": limit})


def word_not_in_content() -> ApiError:
    return ApiError(422, "WORD_NOT_IN_CONTENT", "Этого слова нет в тексте")


def gloss_unavailable() -> ApiError:
    return ApiError(422, "GLOSS_UNAVAILABLE", "Перевод сейчас недоступен")


def answer_invalid(field: str) -> ApiError:
    return ApiError(422, "ANSWER_INVALID", "Некорректный ответ", {"field": field})


def user_deleted() -> ApiError:
    return ApiError(410, "USER_DELETED", "Данные ученика удалены по запросу")


def idempotency_reused() -> ApiError:
    return ApiError(422, "IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными")


# ---------------------------------------------------------------- блокировки, время


def _lock_key(value: uuid.UUID) -> int:
    return int.from_bytes(value.bytes[:4], "big", signed=True)


async def lock_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    """Сериализация команд одного ученика (сессия, ответы, карточки, consumers, tick, сага) до конца транзакции."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, :o)"), {"c": _LOCK_USER, "o": _lock_key(user_id)})


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def zone(name: str | None, default: str) -> ZoneInfo:
    for candidate in (name, default):
        if candidate:
            try:
                return ZoneInfo(candidate)
            except (ZoneInfoNotFoundError, ValueError):
                continue
    return ZoneInfo("UTC")


def local_date(now: datetime, tz: ZoneInfo) -> date:
    return now.astimezone(tz).date()


def day_start(d: date, tz: ZoneInfo) -> datetime:
    return datetime.combine(d, time(0, 0), tzinfo=tz).astimezone(UTC)


def end_of_local_day(now: datetime, tz: ZoneInfo) -> datetime:
    """Последний момент местного дня (UTC): начало следующего местного дня − 1 мкс."""
    return day_start(local_date(now, tz) + timedelta(days=1), tz) - timedelta(microseconds=1)


def ceil_minutes(seconds: int) -> int:
    return min(60, math.ceil(max(seconds, 0) / 60))


def days_until(due: datetime | None, now: datetime) -> int | None:
    if due is None:
        return None
    return max(0, math.ceil((due - now).total_seconds() / 86_400))


Clock = Callable[[], datetime]


# ---------------------------------------------------------------- воспроизводимость по seed


def digest(*parts: object) -> str:
    return hashlib.sha256(":".join(str(p) for p in parts).encode("utf-8")).hexdigest()


def seeded_order[T](seed: str, items: Iterable[T], key: Callable[[T], str]) -> list[T]:
    """Перемешивание по seed (sha256): одинаковый seed — одинаковый порядок."""
    return sorted(items, key=lambda it: digest(seed, key(it)))


def seeded_pick(seed: str, n: int) -> int:
    return int(digest(seed)[:8], 16) % max(n, 1)


def request_hash(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()


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


# ---------------------------------------------------------------- события и аудит


async def emit_event(session: AsyncSession, event_type: str, payload: dict[str, Any],
                     causation_id: str | None = None) -> None:
    await emit(session, event_type, payload, producer=PRODUCER, causation_id=causation_id)


def audit_payload(actor: Actor, action: str, object_type: str, object_id: str, *,
                  before: dict[str, Any] | None = None, after: dict[str, Any] | None = None,
                  reason: str | None = None) -> dict[str, Any]:
    """admin.audit.recorded.v1 — без текстов ученика: идентификаторы, статусы, сроки; reason — основание сотрудника."""
    return {
        "record_id": str(uuid.uuid4()),
        "occurred_at": iso(datetime.now(UTC)),
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
