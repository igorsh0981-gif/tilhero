"""События недели (§1.1 game_events, §1.11): период ≤ 14 дней, аудитория, множители XP или тилов по виду действия.
Действует только опубликованное событие в свой период. Пересечение периода, аудитории и пары действие/валюта с уже
опубликованным — 409 EVENT_OVERLAP {event_id}; начало в прошлом — 422. Отмена действовавшие начисления не
пересчитывает. tick переводит published → finished после окончания."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict, not_found, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_gamification.domain.common import emit_audit, iso, staff_ref
from tilhero_gamification.models import GameEvent

MAX_DAYS = 14


def event_not_found() -> ApiError:
    return not_found("EVENT_NOT_FOUND", "Событие не найдено")


def event_state(status: str) -> ApiError:
    return conflict("EVENT_STATE", "Действие недоступно в текущем статусе события", {"status": status})


def check_period(starts_at: datetime, ends_at: datetime) -> None:
    if ends_at <= starts_at:
        raise unprocessable("EVENT_INVALID", "Конец события раньше начала", {"reason": "period"})
    if ends_at - starts_at > timedelta(days=MAX_DAYS):
        raise unprocessable("EVENT_INVALID", "Событие длится не больше 14 дней", {"reason": "too_long"})


def check_multipliers(multipliers: list[dict[str, Any]]) -> None:
    pairs = [(m["action"], m["currency"]) for m in multipliers]
    if len(set(pairs)) != len(pairs):
        raise unprocessable("EVENT_INVALID", "Повтор пары действие/валюта", {"reason": "multipliers"})


def admin_view(ev: GameEvent) -> dict[str, Any]:
    return {"event_id": str(ev.event_id), "code": ev.code, "title": ev.title, "description": ev.description,
            "starts_at": iso(ev.starts_at), "ends_at": iso(ev.ends_at), "audiences": list(ev.audiences),
            "multipliers": [{"action": m["action"], "currency": m["currency"], "factor": _factor(m["factor"])}
                            for m in ev.multipliers],
            "status": ev.status, "created_by": staff_ref(ev.created_by, ev.created_by_name),
            "published_by": staff_ref(ev.published_by, ev.published_by_name), "updated_at": iso(ev.updated_at)}


def learner_view(ev: GameEvent) -> dict[str, Any]:
    """ActiveGameEvent (bff.ts)."""
    return {"event_id": str(ev.event_id), "title": ev.title, "description": ev.description,
            "ends_at": iso(ev.ends_at),
            "multipliers": [{"action": m["action"], "currency": m["currency"], "factor": _factor(m["factor"])}
                            for m in ev.multipliers]}


def _factor(value: Any) -> float | int:
    f = float(value)
    return int(f) if f.is_integer() else f


async def admin_list(session: AsyncSession, status: str | None) -> dict[str, Any]:
    stmt = select(GameEvent).order_by(GameEvent.starts_at.desc(), GameEvent.event_id)
    if status is not None:
        stmt = stmt.where(GameEvent.status == status)
    return {"items": [admin_view(e) for e in (await session.execute(stmt)).scalars().all()]}


async def _event(session: AsyncSession, event_id: uuid.UUID) -> GameEvent:
    ev = await session.get(GameEvent, event_id, with_for_update=True, populate_existing=True)
    if ev is None:
        raise event_not_found()
    return ev


async def create(session: AsyncSession, actor: Actor, data: dict[str, Any], now: datetime) -> dict[str, Any]:
    check_period(data["starts_at"], data["ends_at"])
    check_multipliers(data["multipliers"])
    if (await session.execute(select(GameEvent.event_id).where(GameEvent.code == data["code"]))).first():
        raise conflict("EVENT_CODE_TAKEN", "Событие с таким кодом уже есть", {"code": data["code"]})
    ev = GameEvent(event_id=uuid.uuid4(), code=data["code"], title=data["title"], description=data["description"],
                   starts_at=data["starts_at"], ends_at=data["ends_at"], audiences=data["audiences"],
                   multipliers=data["multipliers"], status="draft", created_by=actor.id[:64],
                   created_by_name=(actor.name or "")[:120], created_at=now, updated_at=now)
    session.add(ev)
    await session.flush()
    await emit_audit(session, actor, "game.event.created", "game_event", str(ev.event_id),
                     after={"code": ev.code, "starts_at": iso(ev.starts_at), "ends_at": iso(ev.ends_at),
                            "audiences": ev.audiences, "multipliers": ev.multipliers})
    return admin_view(ev)


async def patch(session: AsyncSession, actor: Actor, event_id: uuid.UUID, changes: dict[str, Any],
                now: datetime) -> dict[str, Any]:
    ev = await _event(session, event_id)
    if ev.status != "draft":
        raise event_state(ev.status)
    if "code" in changes and changes["code"] != ev.code and (await session.execute(
            select(GameEvent.event_id).where(GameEvent.code == changes["code"]))).first():
        raise conflict("EVENT_CODE_TAKEN", "Событие с таким кодом уже есть", {"code": changes["code"]})
    for key, value in changes.items():
        setattr(ev, key, value)
    check_period(ev.starts_at, ev.ends_at)
    check_multipliers(ev.multipliers)
    ev.updated_at = now
    await emit_audit(session, actor, "game.event.updated", "game_event", str(event_id),
                     after={"fields": sorted(changes), "starts_at": iso(ev.starts_at), "ends_at": iso(ev.ends_at)})
    return admin_view(ev)


def _overlaps(a: GameEvent, b: GameEvent) -> bool:
    if not (a.starts_at < b.ends_at and b.starts_at < a.ends_at):
        return False
    if not set(a.audiences) & set(b.audiences):
        return False
    pairs = {(m["action"], m["currency"]) for m in a.multipliers}
    return any((m["action"], m["currency"]) in pairs for m in b.multipliers)


async def _lock_events(session: AsyncSession) -> None:
    """Публикации событий недели — по очереди: проверка пересечений видит все уже опубликованные."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, 0)"), {"c": 0x47414D45})  # 'GAME'


async def publish(session: AsyncSession, actor: Actor, event_id: uuid.UUID, comment: str | None,
                  now: datetime) -> dict[str, Any]:
    await _lock_events(session)
    ev = await _event(session, event_id)
    if ev.status != "draft":
        raise event_state(ev.status)
    if ev.starts_at < now:
        raise unprocessable("EVENT_STARTS_IN_PAST", "Начало события уже прошло", {"starts_at": iso(ev.starts_at)})
    others = (await session.execute(select(GameEvent).where(
        GameEvent.status == "published", GameEvent.event_id != ev.event_id).with_for_update())).scalars().all()
    for other in others:
        if _overlaps(ev, other):
            raise conflict("EVENT_OVERLAP", "Пересекается с опубликованным событием",
                           {"event_id": str(other.event_id)})
    ev.status, ev.published_by, ev.published_by_name = "published", actor.id[:64], (actor.name or "")[:120]
    ev.published_at = now
    ev.updated_at = now
    await emit_audit(session, actor, "game.event.published", "game_event", str(event_id),
                     before={"status": "draft"}, after={"status": "published"}, reason=comment)
    return admin_view(ev)


async def cancel(session: AsyncSession, actor: Actor, event_id: uuid.UUID, comment: str | None,
                 now: datetime) -> dict[str, Any]:
    ev = await _event(session, event_id)
    if ev.status not in ("draft", "published"):
        raise event_state(ev.status)
    before = ev.status
    ev.status = "cancelled"
    ev.updated_at = now
    await emit_audit(session, actor, "game.event.cancelled", "game_event", str(event_id),
                     before={"status": before}, after={"status": "cancelled"}, reason=comment)
    return admin_view(ev)
