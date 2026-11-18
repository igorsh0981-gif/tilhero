"""Семья: одна на владельца, человек — не больше чем в одной семье. Изменения сериализуются advisory-блокировкой
по пользователям (lock_users — в порядке uuid, без взаимных блокировок) и FOR UPDATE строки семьи."""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from datetime import datetime

from sqlalchemy import case, func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import emit
from tilhero_social.models import Family, FamilyMember

MEMBER_ADDED = "social.family.member_added.v1"
_LOCK_CLASS = 0x534F434C  # 'SOCL' — пространство advisory-ключей сервиса


async def lock_users(session: AsyncSession, users: Iterable[uuid.UUID]) -> None:
    for user in sorted(set(users), key=lambda u: u.int):
        obj = int.from_bytes(user.bytes[:4], "big", signed=True)
        await session.execute(text("SELECT pg_advisory_xact_lock(:c, :o)"), {"c": _LOCK_CLASS, "o": obj})


async def membership(session: AsyncSession, user_id: uuid.UUID) -> FamilyMember | None:
    return (await session.execute(select(FamilyMember).where(FamilyMember.user_id == user_id))).scalar_one_or_none()


async def members(session: AsyncSession, family_id: uuid.UUID) -> Sequence[FamilyMember]:
    owner_first = case((FamilyMember.role == "owner", 0), else_=1)
    return (await session.execute(
        select(FamilyMember).where(FamilyMember.family_id == family_id)
        .order_by(owner_first, FamilyMember.joined_at, FamilyMember.user_id)
    )).scalars().all()


async def size(session: AsyncSession, family_id: uuid.UUID) -> int:
    return int((await session.execute(
        select(func.count()).select_from(FamilyMember).where(FamilyMember.family_id == family_id))).scalar_one())


async def lock_family(session: AsyncSession, family_id: uuid.UUID) -> None:
    await session.execute(select(Family.family_id).where(Family.family_id == family_id).with_for_update())


async def family_of_or_create(session: AsyncSession, user_id: uuid.UUID, now: datetime) -> uuid.UUID:
    """Семья, в которой состоит user_id; если её нет — новая семья с ним как владельцем (без события: это он сам).
    Вызывать под lock_users(user_id)."""
    existing = await membership(session, user_id)
    if existing is not None:
        return existing.family_id
    family_id = uuid.uuid4()
    session.add(Family(family_id=family_id, owner_user_id=user_id, created_at=now))
    await session.flush()
    session.add(FamilyMember(family_id=family_id, user_id=user_id, role="owner", joined_at=now))
    await session.flush()
    return family_id


async def add_member(session: AsyncSession, family_id: uuid.UUID, user_id: uuid.UUID, role: str, now: datetime,
                     producer: str) -> bool:
    """Добавляет участника и публикует social.family.member_added.v1. False — уже состоит в какой-то семье."""
    inserted = await session.execute(
        insert(FamilyMember).values(family_id=family_id, user_id=user_id, role=role, joined_at=now)
        .on_conflict_do_nothing().returning(FamilyMember.user_id)
    )
    if inserted.first() is None:
        return False
    owner_user_id = (await session.execute(
        select(Family.owner_user_id).where(Family.family_id == family_id)
    )).scalar_one()
    await emit(session, MEMBER_ADDED, {
        "family_id": str(family_id), "owner_user_id": str(owner_user_id), "user_id": str(user_id), "role": role,
        "added_at": now.isoformat().replace("+00:00", "Z"),
    }, producer=producer)
    return True
