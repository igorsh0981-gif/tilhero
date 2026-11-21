"""Парные комнаты в админке (ADM-SOC-02, admin.ts «Парные комнаты»; права проверяются здесь по actor).

- `room.read`: список и карточка — участники (user_id; обезличенные сагой — null), сценарий, статус, длительность,
  секунды речи и минуты каждого, стоимость ИИ, ход событий **без текстов** реплик и без оценок (личные оценки
  участников изолированы — только у assessment и самого ученика);
- `room.manage` + step-up: остановка комнаты с причиной (10..500) → stopped, участникам — событие в ленте и
  уведомление (lesson.pair.completed.v1 end_reason stopped → notifications pair_stopped), отчёт по сделанному;
  аудит `pair_room.stopped` (outbox, та же транзакция);
- обзор (dashboard.read | room.read): завершённые комнаты за период.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.errors import unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit
from tilhero_lessons.domain import pair
from tilhero_lessons.domain.common import AUDIT_EVENT, PRODUCER, decode_cursor, encode_cursor, iso
from tilhero_lessons.domain.pair import Effects, Room
from tilhero_lessons.models import ROOM_ACTIVE, ROOM_ENDED, PairRoom, RoomEvent
from tilhero_lessons.settings import Settings

ROOM_READ = "room.read"
ROOM_MANAGE = "room.manage"
DASHBOARD_READ = "dashboard.read"


def _participant(room: Room, side: str, now: datetime) -> dict[str, Any]:
    p = room.parts[side]
    live = p.minutes if room.r.status in ROOM_ENDED else pair.minutes_of(p)
    return {"user_id": str(p.user_id) if p.user_id else None, "side": side, "role": p.role, "turns": p.turns,
            "speaking_seconds": p.speaking_seconds, "minutes": live, "contributed": p.contributed,
            "network": (("online" if pair.present(p) else "offline") if p.joined_at is not None else None),
            "joined_at": iso(p.joined_at)}


def row(room: Room, now: datetime) -> dict[str, Any]:
    """AdminPairRoomRow: без реплик и оценок."""
    r = room.r
    live = int((now - r.clock_at).total_seconds()) if r.status == "in_progress" and r.clock_at else 0
    return {
        "room_id": str(r.room_id), "status": r.status, "pair_id": r.pair_id, "scenario_id": r.scenario_id,
        "scenario_title": r.title, "mode": r.mode,
        "participants": [_participant(room, side, now) for side in ("inviter", "invitee") if side in room.parts],
        "created_at": iso(r.created_at), "start_at": iso(r.start_at), "started_at": iso(r.started_at),
        "ended_at": iso(r.ended_at), "duration_s": r.progress_seconds + max(live, 0), "end_reason": r.end_reason,
        "ai_cost_usd": float(r.ai_cost_usd or 0),
    }


async def list_rooms(db: AsyncSession, *, status: str | None, date_from: datetime | None, date_to: datetime | None,
                     cursor: str | None, limit: int, now: datetime) -> dict[str, Any]:
    stmt = select(PairRoom)
    if status == "active":
        stmt = stmt.where(PairRoom.status.in_(ROOM_ACTIVE))
    elif status == "ended":
        stmt = stmt.where(PairRoom.status.in_(ROOM_ENDED))
    elif status:
        stmt = stmt.where(PairRoom.status == status)
    if date_from is not None:
        stmt = stmt.where(PairRoom.created_at >= date_from)
    if date_to is not None:
        stmt = stmt.where(PairRoom.created_at < date_to)
    after = decode_cursor(cursor, 2)
    if after is not None:
        try:
            at, rid = datetime.fromisoformat(str(after[0])), uuid.UUID(str(after[1]))
        except ValueError:
            raise unprocessable("INVALID_CURSOR", "Некорректный курсор") from None
        stmt = stmt.where(or_(PairRoom.created_at < at, and_(PairRoom.created_at == at, PairRoom.room_id < rid)))
    rows = list((await db.execute(stmt.order_by(PairRoom.created_at.desc(), PairRoom.room_id.desc())
                                  .limit(limit + 1))).scalars().all())
    page = rows[:limit]
    items = []
    for r in page:
        room = await pair.load(db, r.room_id)
        assert room is not None
        items.append(row(room, now))
    nxt = encode_cursor(page[-1].created_at.isoformat(), str(page[-1].room_id)) if len(rows) > limit else None
    return {"items": items, "next_cursor": nxt}


async def card(db: AsyncSession, room_id: uuid.UUID, now: datetime) -> dict[str, Any]:
    """AdminPairRoom: строка + ход событий без текстов, кто и почему остановил."""
    room = await pair.load(db, room_id)
    if room is None:
        raise pair.room_not_found()
    events = (await db.execute(select(RoomEvent.seq, RoomEvent.kind, RoomEvent.role, RoomEvent.at).where(
        RoomEvent.room_id == room_id).order_by(RoomEvent.seq))).all()
    r = room.r
    return {**row(room, now),
            "timeline": [{"seq": seq, "kind": kind, "role": role, "at": iso(at)} for seq, kind, role, at in events],
            "stopped_by": {"staff_id": r.stopped_by_id, "name": r.stopped_by_name or ""} if r.stopped_by_id else None,
            "stop_reason": r.stop_reason}


async def stop(db: AsyncSession, room_id: uuid.UUID, actor: Actor, reason: str, now: datetime,
               settings: Settings) -> Effects:
    """→ stopped (под блокировками участников); уже завершённая — 409 ROOM_NOT_ACTIVE {status}; аудит."""
    room = await pair.load(db, room_id)
    if room is None:
        raise pair.room_not_found()
    await pair.lock_users(db, *room.users)
    room = await pair.load(db, room_id, fresh=True)
    if room is None:
        raise pair.room_not_found()
    r = room.r
    before = r.status
    if before not in ROOM_ACTIVE:
        raise pair.room_not_active(before)
    eff = await pair.tend(db, room, now, settings)
    if r.status not in ROOM_ACTIVE:  # истекла или завершилась по времени — останавливать нечего
        raise pair.room_not_active(r.status)
    if r.started_at is not None or any(p.joined_at is not None for p in room.parts.values()):
        eff.merge(await pair.finish(db, room, "stopped", "stopped", now, settings))
    else:
        r.status = "stopped"
        r.end_reason = "stopped"
        r.ended_at = now
        pair.release_slots(room)
        pair.add_event(db, room, "stopped", now)
        eff.notify = True
    pair.schedule(room, settings)
    r.stopped_by_id = actor.id[:64]
    r.stopped_by_name = (actor.name or "")[:200] or None
    r.stop_reason = reason[:500]
    await emit(db, AUDIT_EVENT, {
        "record_id": str(uuid.uuid4()), "occurred_at": iso(datetime.now(UTC)), "actor_type": "staff",
        "actor_id": actor.id[:64], "actor_role": actor.role[:64], "action": "pair_room.stopped",
        "object_type": "pair_room", "object_id": str(room_id), "before": {"status": before},
        "after": {"status": "stopped", "end_reason": "stopped"}, "reason": reason,
        "trace_id": context.get_trace_id()[:64]}, producer=PRODUCER)
    return eff
