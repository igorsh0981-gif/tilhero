"""Внутренние выгрузки для начальной загрузки проекций gamification и lessons (ревью спринта 7, п. 3):
`GET /internal/v1/export/<name>?cursor=&limit=` → `{items, next_cursor}`; элемент — ровно payload события, которым
social поддерживает эту проекцию дальше. Удалённые ученики (deleted_users) не выгружаются. Порядок — по ключу (keyset),
курсор непрозрачный. История до спринта 7 есть только у семей и дружб (профиль сообщества, блокировки, санкции —
новые: их проекции строятся из событий с нуля; возраст и согласие родителя — у identity-consent)."""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from typing import Any, Final

from sqlalchemy import exists, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import bad_request
from tilhero_social.domain.common import decode_cursor, encode_cursor, iso
from tilhero_social.models import DeletedUser, Family, FamilyMember, Friendship

Page = tuple[list[dict[str, Any]], str | None]


def _alive(col: Any) -> Any:
    return ~exists().where(DeletedUser.user_id == col)


def _uuids(cursor: str | None, arity: int) -> list[uuid.UUID] | None:
    parts = decode_cursor(cursor, arity)
    if parts is None:
        return None
    try:
        return [uuid.UUID(str(p)) for p in parts]
    except ValueError:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from None


async def families(session: AsyncSession, cursor: str | None, limit: int) -> Page:
    """payload social.family.member_added.v1 для каждого текущего члена семьи (и владельца, role owner)."""
    after = _uuids(cursor, 1)
    stmt = (select(FamilyMember.family_id, Family.owner_user_id, FamilyMember.user_id, FamilyMember.role,
                   FamilyMember.joined_at)
            .join(Family, Family.family_id == FamilyMember.family_id)
            .where(_alive(FamilyMember.user_id)).order_by(FamilyMember.user_id).limit(limit + 1))
    if after is not None:
        stmt = stmt.where(FamilyMember.user_id > after[0])
    rows = (await session.execute(stmt)).all()
    items = [{"family_id": str(f), "owner_user_id": str(o), "user_id": str(u), "role": role, "added_at": iso(at)}
             for f, o, u, role, at in rows[:limit]]
    return items, encode_cursor(str(rows[limit - 1][2])) if len(rows) > limit else None


async def friendships(session: AsyncSession, cursor: str | None, limit: int) -> Page:
    """payload social.friendship.changed.v1 (status added) для каждой действующей дружбы; source — invite
    (приглашение Telegram) или request (заявка)."""
    after = _uuids(cursor, 2)
    stmt = (select(Friendship.user_a, Friendship.user_b, Friendship.invite_id, Friendship.created_at)
            .where(_alive(Friendship.user_a), _alive(Friendship.user_b))
            .order_by(Friendship.user_a, Friendship.user_b).limit(limit + 1))
    if after is not None:
        stmt = stmt.where(tuple_(Friendship.user_a, Friendship.user_b) > tuple_(*after))
    rows = (await session.execute(stmt)).all()
    items = [{"user_a": str(a), "user_b": str(b), "status": "added", "source": "invite" if inv else "request",
              "at": iso(at)} for a, b, inv, at in rows[:limit]]
    last = rows[limit - 1] if len(rows) > limit else None
    return items, encode_cursor(str(last[0]), str(last[1])) if last is not None else None


EXPORTS: Final[dict[str, Callable[[AsyncSession, str | None, int], Awaitable[Page]]]] = {
    "families": families,
    "friendships": friendships,
}
