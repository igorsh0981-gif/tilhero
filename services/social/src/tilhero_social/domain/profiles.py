"""Проекция профилей (user.profile.created/updated.v1), дети в семье опекуна, сага удаления."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import emit
from tilhero_social.domain import family as fam
from tilhero_social.models import DeletedUser, Family, FamilyMember, Friendship, Invite, InviteRedemption, Profile

DOMAIN_DELETED = "user.domain.deleted.v1"
DELETION_DOMAIN = "social"
AGE_BANDS = frozenset({"6-9", "10-13", "14-17", "18+"})
GUARDIAN_CONSENTS = frozenset({"not_required", "pending", "granted", "declined"})
KINDS = frozenset({"account", "child"})


async def _deleted(session: AsyncSession, user_id: uuid.UUID) -> bool:
    return await session.get(DeletedUser, user_id) is not None


async def _upsert(session: AsyncSession, user_id: uuid.UUID, values: dict[str, Any], now: datetime) -> None:
    await session.execute(
        insert(Profile).values(user_id=user_id, updated_at=now, **values)
        .on_conflict_do_update(index_elements=["user_id"], set_={**values, "updated_at": now})
    )


def _valid(value: object, allowed: frozenset[str]) -> str | None:
    return value if isinstance(value, str) and value in allowed else None


async def on_profile_created(session: AsyncSession, payload: dict[str, Any], now: datetime, producer: str) -> None:
    """Проекция + детский профиль 6–13 попадает в семью опекуна (семья создаётся, если её нет)."""
    user_id = uuid.UUID(str(payload["user_id"]))
    kind = _valid(payload.get("kind"), KINDS)
    if await _deleted(session, user_id):
        return
    values: dict[str, Any] = {"kind": kind, "age_band": _valid(payload.get("age_band"), AGE_BANDS)}
    guardian = payload.get("guardian_user_id")
    guardian_id = uuid.UUID(str(guardian)) if guardian else None
    if guardian_id is not None:
        values["guardian_user_id"] = guardian_id
    stmt = insert(Profile).values(user_id=user_id, updated_at=now, **values)
    # created мог прийти после updated (повторная доставка): уже известные возраст и опекуна не затираем
    await session.execute(stmt.on_conflict_do_update(index_elements=["user_id"], set_={
        "kind": stmt.excluded.kind,
        "age_band": func.coalesce(Profile.age_band, stmt.excluded.age_band),
        "guardian_user_id": func.coalesce(Profile.guardian_user_id, stmt.excluded.guardian_user_id),
        "updated_at": now,
    }))
    if kind != "child" or guardian_id is None or await _deleted(session, guardian_id):
        return
    await fam.lock_users(session, [guardian_id, user_id])
    if await fam.membership(session, user_id) is not None:
        return
    family_id = await fam.family_of_or_create(session, guardian_id, now)
    await fam.lock_family(session, family_id)
    # лимит размера семьи — для приглашений; детей опекуна (≤ 5, identity-consent) добавляем всегда
    await fam.add_member(session, family_id, user_id, "child", now, producer)


async def on_profile_updated(session: AsyncSession, payload: dict[str, Any], now: datetime) -> None:
    """Обновляет только поля из changed_fields, пришедшие в payload (возраст, согласие родителя)."""
    user_id = uuid.UUID(str(payload["user_id"]))
    if await _deleted(session, user_id):
        return
    changed = set(payload.get("changed_fields") or [])
    values: dict[str, Any] = {}
    if "age_band" in changed and "age_band" in payload:
        values["age_band"] = _valid(payload["age_band"], AGE_BANDS)
    if "guardian_consent" in changed and "guardian_consent" in payload:
        values["guardian_consent"] = _valid(payload["guardian_consent"], GUARDIAN_CONSENTS)
    if values:
        await _upsert(session, user_id, values, now)


async def delete_user_data(session: AsyncSession, user_id: uuid.UUID, request_id: uuid.UUID,
                           causation_id: str | None, producer: str) -> None:
    """Сага удаления (TG-FR-006): приглашения пользователя (с ответами на них), его ответы на чужие приглашения,
    дружбы, членство в семье, проекция → ACK user.domain.deleted.v1 (domain=social). Владелец семьи уходит — семья
    переходит к самому раннему взрослому участнику; взрослых нет — семья распускается."""
    await fam.lock_users(session, [user_id])
    await session.execute(delete(Invite).where(Invite.inviter_user_id == user_id))  # ответы — каскадом
    await session.execute(delete(InviteRedemption).where(InviteRedemption.invitee_user_id == user_id))
    await session.execute(delete(Friendship).where(or_(Friendship.user_a == user_id, Friendship.user_b == user_id)))
    owned = (await session.execute(
        select(Family).where(Family.owner_user_id == user_id).with_for_update())).scalar_one_or_none()
    if owned is not None:
        heir = (await session.execute(
            select(FamilyMember).where(FamilyMember.family_id == owned.family_id, FamilyMember.role == "adult")
            .order_by(FamilyMember.joined_at, FamilyMember.user_id).limit(1))).scalar_one_or_none()
        if heir is None:
            await session.execute(delete(Family).where(Family.family_id == owned.family_id))  # участники — каскадом
        else:
            await session.execute(delete(FamilyMember).where(FamilyMember.user_id == user_id))
            owned.owner_user_id = heir.user_id
            heir.role = "owner"
            await session.flush()
    await session.execute(delete(FamilyMember).where(FamilyMember.user_id == user_id))
    await session.execute(delete(Profile).where(Profile.user_id == user_id))
    await session.execute(
        insert(DeletedUser).values(user_id=user_id, request_id=request_id).on_conflict_do_nothing(
            index_elements=["user_id"])
    )
    await emit(session, DOMAIN_DELETED,
               {"user_id": str(user_id), "request_id": str(request_id), "domain": DELETION_DOMAIN, "mode": "deleted"},
               producer=producer, causation_id=causation_id)
