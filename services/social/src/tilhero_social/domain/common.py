"""Общее для социального домена спринта 7: события, права, ошибки (коды §8, bff.ts/admin.ts «Спринт 7»), время,
курсоры, аудит, удаление под блокировкой, идемпотентность команд ученика."""

from __future__ import annotations

import base64
import hashlib
import json
import uuid
from datetime import UTC, date, datetime, time
from typing import Any, Final
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.errors import ApiError, bad_request, forbidden, not_found, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit
from tilhero_social.models import DeletedUser, LearnerIdempotency

PRODUCER: Final = "social"

# события (§7)
PROFILE_UPDATED: Final = "social.profile.updated.v1"
FRIEND_REQUEST_CREATED: Final = "social.friend_request.created.v1"
FRIENDSHIP_CHANGED: Final = "social.friendship.changed.v1"
BLOCK_CHANGED: Final = "social.block.changed.v1"
SANCTION_CHANGED: Final = "social.sanction.changed.v1"
CASE_RESOLVED: Final = "social.case.resolved.v1"
APPEAL_DECIDED: Final = "social.appeal.decided.v1"
REFERRAL_QUALIFIED: Final = "social.referral.qualified.v1"
REFERRAL_REJECTED: Final = "social.referral.rejected.v1"
REFERRAL_HELD: Final = "social.referral.held.v1"
AUDIT_EVENT: Final = "admin.audit.recorded.v1"

# права сотрудников (PLAN «Права») — проверяются в домене по actor
SOCIAL_READ: Final = "social.read"
MODERATION_MANAGE: Final = "moderation.manage"
REFERRAL_READ: Final = "referral.read"
REFERRAL_MANAGE: Final = "referral.manage"
DASHBOARD_READ: Final = "dashboard.read"

KIDS_BANDS: Final = frozenset({"6-9", "10-13"})
AGE_BANDS: Final = frozenset({"6-9", "10-13", "14-17", "18+"})


# ---------------------------------------------------------------- ошибки


def user_deleted() -> ApiError:
    return ApiError(410, "USER_DELETED", "Данные ученика удалены по запросу")


def member_not_found() -> ApiError:
    return not_found("MEMBER_NOT_FOUND", "Участник не найден")


def kids_not_allowed() -> ApiError:
    return forbidden("KIDS_NOT_ALLOWED", "Недоступно в детском профиле")


def friends_not_allowed(reason: str) -> ApiError:
    return forbidden("FRIENDS_NOT_ALLOWED", "Друзья недоступны для этого профиля", {"reason": reason})


def blocked() -> ApiError:
    return forbidden("BLOCKED", "Действие недоступно")


def social_restricted(until: datetime | None) -> ApiError:
    return forbidden("SOCIAL_RESTRICTED", "Социальные действия временно ограничены", {"until": iso(until)})


def self_not_allowed() -> ApiError:
    return unprocessable("VALIDATION_ERROR", "Нельзя выбрать себя", {"errors": [
        {"loc": ["body", "member_id"], "msg": "self", "type": "value_error"}]})


def validation_error(field: str, msg: str) -> ApiError:
    return unprocessable("VALIDATION_ERROR", "Некорректные данные запроса", {"errors": [
        {"loc": ["body", field], "msg": msg, "type": "value_error"}]})


def idempotency_reused() -> ApiError:
    return unprocessable("IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными")


def step_up_required(permission: str) -> ApiError:
    return forbidden("STEP_UP_REQUIRED", "Подтвердите действие кодом из приложения-аутентификатора",
                     {"permission": permission})


# ---------------------------------------------------------------- время


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def zone(name: str | None) -> ZoneInfo:
    for candidate in (name, "Asia/Tashkent"):
        if candidate:
            try:
                return ZoneInfo(candidate)
            except (ZoneInfoNotFoundError, ValueError):
                continue
    return ZoneInfo("UTC")


def local_date(ts: datetime, tz: ZoneInfo) -> date:
    return ts.astimezone(tz).date()


def month_bounds(ts: datetime, tz: ZoneInfo) -> tuple[datetime, datetime]:
    """Календарный месяц (по поясу tz), в котором лежит ts → [начало, конец) в UTC."""
    d = ts.astimezone(tz).date().replace(day=1)
    nxt = (d.replace(year=d.year + 1, month=1) if d.month == 12 else d.replace(month=d.month + 1))
    return (datetime.combine(d, time(0), tzinfo=tz).astimezone(UTC),
            datetime.combine(nxt, time(0), tzinfo=tz).astimezone(UTC))


def day_start(ts: datetime, tz: ZoneInfo) -> datetime:
    return datetime.combine(ts.astimezone(tz).date(), time(0), tzinfo=tz).astimezone(UTC)


def parse_ts(value: object, default: datetime) -> datetime:
    try:
        ts = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return default
    return ts if ts.tzinfo is not None else ts.replace(tzinfo=UTC)


def event_time(value: object, now: datetime) -> datetime:
    """Время события из payload (не позже часов сервиса): день, окно и лимиты — по нему, а не по обработке."""
    return min(parse_ts(value, now), now)


# ---------------------------------------------------------------- курсоры (непрозрачные)


def encode_cursor(*parts: Any) -> str:
    raw = json.dumps(list(parts), separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str | None, arity: int) -> list[Any] | None:
    if cursor is None:
        return None
    try:
        parts = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        if not isinstance(parts, list) or len(parts) != arity:
            raise ValueError("arity")
        return parts
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc


def cursor_time_id(cursor: str | None) -> tuple[datetime, uuid.UUID] | None:
    parts = decode_cursor(cursor, 2)
    if parts is None:
        return None
    try:
        ts = datetime.fromisoformat(str(parts[0]))
        if ts.tzinfo is None:
            raise ValueError("naive")
        return ts, uuid.UUID(str(parts[1]))
    except ValueError as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc


# ---------------------------------------------------------------- удаление, события, аудит


async def is_deleted(session: AsyncSession, user_id: uuid.UUID) -> bool:
    """Отметка исполненной саги. Проверять ПОСЛЕ advisory-блокировки ученика (сага держит ту же блокировку), иначе
    запись, начатая до саги, воскресит данные удалённого (ревью спринта 6)."""
    return await session.get(DeletedUser, user_id) is not None


async def emit_event(session: AsyncSession, event_type: str, payload: dict[str, Any],
                     causation_id: str | None = None) -> None:
    await emit(session, event_type, payload, producer=PRODUCER, causation_id=causation_id)


def staff_ref(staff_id: str | None, name: str | None) -> dict[str, str] | None:
    if staff_id is None:
        return None
    return {"staff_id": staff_id, "name": name or ""}


async def emit_audit(session: AsyncSession, actor: Actor, action: str, object_type: str, object_id: str, *,
                     before: dict[str, Any] | None = None, after: dict[str, Any] | None = None,
                     reason: str | None = None) -> None:
    """admin.audit.recorded.v1 через outbox — идентификаторы, статусы, сроки, основание сотрудника; без текстов
    учеников (комментарий жалобы и текст обжалования в аудит не идут)."""
    await emit(session, AUDIT_EVENT, {
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
    }, producer=PRODUCER)


# ---------------------------------------------------------------- идемпотентность команд ученика


def request_hash(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()


async def idempotent_replay(session: AsyncSession, user_id: uuid.UUID, scope: str, key: str,
                            body: Any) -> dict[str, Any] | None:
    """Сохранённый ответ команды с тем же ключом (тот же ученик): тело то же — ответ, другое — 422."""
    prior = await session.get(LearnerIdempotency, (user_id, scope, key), populate_existing=True)
    if prior is None:
        return None
    if prior.request_hash != request_hash(body):
        raise idempotency_reused()
    return dict(prior.response)


async def idempotent_store(session: AsyncSession, user_id: uuid.UUID, scope: str, key: str, body: Any,
                           status_code: int, response: dict[str, Any], now: datetime) -> None:
    await session.execute(insert(LearnerIdempotency).values(
        user_id=user_id, scope=scope, key=key, request_hash=request_hash(body), status_code=status_code,
        response=response, created_at=now).on_conflict_do_nothing())
