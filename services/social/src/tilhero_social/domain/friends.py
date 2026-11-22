"""Друзья, заявки и блокировки (§1.2).

- Заявка: один pending на неупорядоченную пару (частичный UNIQUE); встречная заявка = принятие. Истекает через
  FRIEND_REQUEST_TTL_DAYS (30): в ответах — сразу `expired`, tick переводит строку.
- Дружба — упорядоченная пара (user_a < user_b, как строки UUID); изменения → social.friendship.changed.v1.
- Блокировка A→B (односторонняя): удаляет дружбу, отменяет pending-заявки в обе стороны, скрывает учеников друг от
  друга в поиске; новые заявки между ними — 403 BLOCKED (кто заблокировал — не раскрывается).
- Санкция social_ban запрещает отправлять и принимать заявки (403 SOCIAL_RESTRICTED {until}).
Все команды — под advisory-блокировкой обоих учеников (в порядке uuid), «удалён?» — после блокировки.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, delete, func, or_, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict, not_found
from tilhero_social.domain import family as fam
from tilhero_social.domain import rules
from tilhero_social.domain.common import (
    BLOCK_CHANGED,
    FRIEND_REQUEST_CREATED,
    FRIENDSHIP_CHANGED,
    blocked,
    emit_event,
    iso,
)
from tilhero_social.models import Block, FriendRequest, Friendship


def request_not_found() -> ApiError:
    return not_found("REQUEST_NOT_FOUND", "Заявка не найдена")


def friends_limit(limit: int) -> ApiError:
    return conflict("FRIENDS_LIMIT", "Достигнут предел друзей", {"limit": limit})


def effective_status(req: FriendRequest, now: datetime, ttl_days: int) -> str:
    if req.status == "pending" and req.created_at + timedelta(days=ttl_days) <= now:
        return "expired"
    return req.status


# ---------------------------------------------------------------- факты


async def are_friends(session: AsyncSession, x: uuid.UUID, y: uuid.UUID) -> bool:
    a, b = rules.ordered_pair(x, y)
    return await session.get(Friendship, (a, b), populate_existing=True) is not None


async def friend_count(session: AsyncSession, user: uuid.UUID) -> int:
    return int((await session.execute(select(func.count()).select_from(Friendship).where(
        or_(Friendship.user_a == user, Friendship.user_b == user)))).scalar_one())


async def friend_ids(session: AsyncSession, user: uuid.UUID) -> list[tuple[uuid.UUID, datetime]]:
    rows = (await session.execute(select(Friendship.user_a, Friendship.user_b, Friendship.created_at).where(
        or_(Friendship.user_a == user, Friendship.user_b == user)))).all()
    return [(b if a == user else a, at) for a, b, at in rows]


async def blocked_any(session: AsyncSession, x: uuid.UUID, y: uuid.UUID) -> bool:
    return (await session.execute(select(func.count()).select_from(Block).where(or_(
        and_(Block.blocker == x, Block.blocked == y), and_(Block.blocker == y, Block.blocked == x))))).scalar_one() > 0


async def same_family(session: AsyncSession, x: uuid.UUID, y: uuid.UUID) -> bool:
    fx = await fam.membership(session, x)
    if fx is None:
        return False
    fy = await fam.membership(session, y)
    return fy is not None and fy.family_id == fx.family_id


async def pending_between(session: AsyncSession, x: uuid.UUID, y: uuid.UUID, now: datetime, ttl_days: int,
                          *, for_update: bool = False) -> FriendRequest | None:
    a, b = rules.ordered_pair(x, y)
    stmt = select(FriendRequest).where(FriendRequest.pair_a == a, FriendRequest.pair_b == b,
                                       FriendRequest.status == "pending")
    if for_update:
        stmt = stmt.with_for_update()
    req = (await session.execute(stmt.execution_options(populate_existing=True))).scalar_one_or_none()
    if req is None:
        return None
    if effective_status(req, now, ttl_days) == "expired":
        req.status, req.decided_at = "expired", req.created_at + timedelta(days=ttl_days)
        await session.flush()
        return None
    return req


def request_view(req: FriendRequest, me: uuid.UUID, member_id: str, nickname: str | None, now: datetime,
                 ttl_days: int) -> dict[str, Any]:
    """FriendRequestView (bff.ts): вторая сторона — только member_id и ник."""
    status = effective_status(req, now, ttl_days)
    return {
        "request_id": str(req.request_id),
        "direction": "out" if req.from_user == me else "in",
        "member_id": member_id,
        "nickname": nickname,
        "status": status,
        "created_at": iso(req.created_at),
        "decided_at": iso(req.decided_at if req.status != "pending"
                          else (req.created_at + timedelta(days=ttl_days) if status == "expired" else None)),
    }


# ---------------------------------------------------------------- дружба


async def add_friendship(session: AsyncSession, x: uuid.UUID, y: uuid.UUID, now: datetime, *, source: str,
                         requester: uuid.UUID | None = None, accepter_nickname: str | None = None,
                         invite_id: uuid.UUID | None = None) -> bool:
    """Дружба + social.friendship.changed.v1 (added); pending-заявки между ними закрываются как принятые.
    False — уже друзья."""
    a, b = rules.ordered_pair(x, y)
    inserted = await session.execute(insert(Friendship).values(user_a=a, user_b=b, invite_id=invite_id,
                                                               created_at=now)
                                     .on_conflict_do_nothing().returning(Friendship.user_a))
    if inserted.first() is None:
        return False
    await session.execute(update(FriendRequest).where(
        FriendRequest.pair_a == a, FriendRequest.pair_b == b, FriendRequest.status == "pending",
    ).values(status="accepted", decided_at=now))
    payload: dict[str, Any] = {"user_a": str(a), "user_b": str(b), "status": "added", "source": source,
                               "at": iso(now)}
    if source == "request":
        payload["requester_user_id"] = str(requester) if requester else None
        payload["accepter_nickname"] = accepter_nickname
    await emit_event(session, FRIENDSHIP_CHANGED, payload)
    return True


async def remove_friendship(session: AsyncSession, x: uuid.UUID, y: uuid.UUID, now: datetime, *,
                            source: str) -> bool:
    a, b = rules.ordered_pair(x, y)
    removed = await session.execute(delete(Friendship).where(Friendship.user_a == a, Friendship.user_b == b)
                                    .returning(Friendship.user_a))
    if removed.first() is None:
        return False
    await emit_event(session, FRIENDSHIP_CHANGED, {"user_a": str(a), "user_b": str(b), "status": "removed",
                                                   "source": source, "at": iso(now)})
    return True


async def check_limits(session: AsyncSession, x: uuid.UUID, y: uuid.UUID, limit: int) -> None:
    """Предел друзей у любой из сторон → 409 FRIENDS_LIMIT {limit}."""
    for user in (x, y):
        if await friend_count(session, user) >= limit:
            raise friends_limit(limit)


# ---------------------------------------------------------------- заявки


async def create_request(session: AsyncSession, me: uuid.UUID, target: uuid.UUID, now: datetime, *,
                         ttl_days: int, per_day: int, friends_max: int, my_nickname: str | None
                         ) -> tuple[FriendRequest, bool]:
    """→ (заявка, created). Встречная pending-заявка — принимается (created=False, status accepted). Вызывать под
    lock_users(me, target), после проверок доступа, удаления, санкции."""
    if await blocked_any(session, me, target):
        raise blocked()
    if await are_friends(session, me, target):
        raise conflict("ALREADY_FRIENDS", "Вы уже друзья")
    pending = await pending_between(session, me, target, now, ttl_days, for_update=True)
    if pending is not None:
        if pending.from_user == me:
            raise conflict("REQUEST_EXISTS", "Заявка уже отправлена", {"request_id": str(pending.request_id)})
        await check_limits(session, me, target, friends_max)
        pending.status, pending.decided_at = "accepted", now
        await session.flush()
        await add_friendship(session, me, target, now, source="request", requester=pending.from_user,
                             accepter_nickname=my_nickname)
        return pending, False
    await check_limits(session, me, target, friends_max)
    recent = (await session.execute(select(func.count()).select_from(FriendRequest).where(
        FriendRequest.from_user == me, FriendRequest.created_at > now - timedelta(hours=24)))).scalar_one()
    if recent >= per_day:
        raise ApiError(429, "REQUESTS_LIMIT", "Слишком много заявок за сутки — попробуйте завтра", {"limit": per_day})
    a, b = rules.ordered_pair(me, target)
    req = FriendRequest(request_id=uuid.uuid4(), from_user=me, to_user=target, pair_a=a, pair_b=b, status="pending",
                        created_at=now)
    session.add(req)
    await session.flush()
    await emit_event(session, FRIEND_REQUEST_CREATED, {
        "request_id": str(req.request_id), "from_user_id": str(me), "to_user_id": str(target),
        "from_nickname": my_nickname, "created_at": iso(now)})
    return req, True


async def load_request(session: AsyncSession, request_id: uuid.UUID, me: uuid.UUID) -> FriendRequest:
    """Заявка, где я — сторона; иначе 404 REQUEST_NOT_FOUND (чужая неотличима)."""
    req = (await session.execute(select(FriendRequest).where(
        FriendRequest.request_id == request_id, or_(FriendRequest.from_user == me, FriendRequest.to_user == me))
        .execution_options(populate_existing=True))).scalar_one_or_none()
    if req is None:
        raise request_not_found()
    return req


async def decide(session: AsyncSession, req: FriendRequest, me: uuid.UUID, action: str, now: datetime, *,
                 ttl_days: int, friends_max: int, my_nickname: str | None) -> FriendRequest:
    """accept / decline — входящая, cancel — исходящая. Повтор с тем же исходом — без изменений; иначе 409
    REQUEST_STATE {status}. Вызывать под lock_users(from, to); строка перечитывается FOR UPDATE."""
    req = (await session.execute(select(FriendRequest).where(FriendRequest.request_id == req.request_id)
                                 .with_for_update().execution_options(populate_existing=True))).scalar_one()
    incoming = req.to_user == me
    if (action == "cancel") == incoming:
        raise request_not_found()
    outcome = {"accept": "accepted", "decline": "declined", "cancel": "cancelled"}[action]
    status = effective_status(req, now, ttl_days)
    if status == outcome:
        return req
    if status != "pending":
        if status == "expired" and req.status == "pending":
            req.status, req.decided_at = "expired", req.created_at + timedelta(days=ttl_days)
            await session.flush()
        raise conflict("REQUEST_STATE", "Заявка уже обработана", {"status": status})
    if action == "accept":
        other = req.from_user
        if await blocked_any(session, me, other):
            raise blocked()
        if not await are_friends(session, me, other):
            await check_limits(session, me, other, friends_max)
        req.status, req.decided_at = "accepted", now
        await session.flush()
        await add_friendship(session, me, other, now, source="request", requester=other,
                             accepter_nickname=my_nickname)
    else:
        req.status, req.decided_at = outcome, now
        await session.flush()
    return req


async def list_requests(session: AsyncSession, me: uuid.UUID, direction: str, now: datetime, *, ttl_days: int,
                        limit: int, after: tuple[datetime, uuid.UUID] | None) -> Sequence[FriendRequest]:
    """Только действующие pending, новые сверху."""
    col = FriendRequest.to_user if direction == "in" else FriendRequest.from_user
    stmt = (select(FriendRequest).where(col == me, FriendRequest.status == "pending",
                                        FriendRequest.created_at > now - timedelta(days=ttl_days))
            .order_by(FriendRequest.created_at.desc(), FriendRequest.request_id.desc()).limit(limit + 1))
    if after is not None:
        stmt = stmt.where(tuple_(FriendRequest.created_at, FriendRequest.request_id) < tuple_(*after))
    return (await session.execute(stmt)).scalars().all()


# ---------------------------------------------------------------- блокировки


async def block(session: AsyncSession, me: uuid.UUID, target: uuid.UUID, now: datetime) -> tuple[Block, bool]:
    """→ (блокировка, created). Удаляет дружбу (событие removed, source block), отменяет pending-заявки в обе
    стороны, social.block.changed.v1 added. Повтор — та же строка без событий."""
    inserted = await session.execute(insert(Block).values(blocker=me, blocked=target, created_at=now)
                                     .on_conflict_do_nothing().returning(Block.blocker))
    if inserted.first() is None:
        row = await session.get(Block, (me, target), populate_existing=True)
        assert row is not None
        return row, False
    await remove_friendship(session, me, target, now, source="block")
    a, b = rules.ordered_pair(me, target)
    await session.execute(update(FriendRequest).where(
        FriendRequest.pair_a == a, FriendRequest.pair_b == b, FriendRequest.status == "pending",
    ).values(status="cancelled", decided_at=now))
    await emit_event(session, BLOCK_CHANGED, {"blocker_user_id": str(me), "blocked_user_id": str(target),
                                              "status": "added", "at": iso(now)})
    row = await session.get(Block, (me, target), populate_existing=True)
    assert row is not None
    return row, True


async def unblock(session: AsyncSession, me: uuid.UUID, target: uuid.UUID, now: datetime) -> bool:
    """Снять свою блокировку (дружба не возвращается)."""
    removed = await session.execute(delete(Block).where(Block.blocker == me, Block.blocked == target)
                                    .returning(Block.blocker))
    if removed.first() is None:
        return False
    await emit_event(session, BLOCK_CHANGED, {"blocker_user_id": str(me), "blocked_user_id": str(target),
                                              "status": "removed", "at": iso(now)})
    return True


async def my_blocks(session: AsyncSession, me: uuid.UUID, limit: int = 500) -> Sequence[Block]:
    return (await session.execute(select(Block).where(Block.blocker == me)
                                  .order_by(Block.created_at.desc(), Block.blocked).limit(limit))).scalars().all()


# ---------------------------------------------------------------- поиск и связь


async def relation(session: AsyncSession, me: uuid.UUID, other: uuid.UUID, now: datetime,
                   ttl_days: int) -> tuple[str, uuid.UUID | None]:
    """MemberRelation карточки и id pending-заявки между нами."""
    if other == me:
        return "self", None
    if await are_friends(session, me, other):
        return "friend", None
    a, b = rules.ordered_pair(me, other)
    req = (await session.execute(select(FriendRequest).where(
        FriendRequest.pair_a == a, FriendRequest.pair_b == b, FriendRequest.status == "pending",
        FriendRequest.created_at > now - timedelta(days=ttl_days)))).scalar_one_or_none()
    if req is None:
        return "none", None
    return ("request_out" if req.from_user == me else "request_in"), req.request_id

