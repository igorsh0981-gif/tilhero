"""Проекция профилей (user.profile.created/updated.v1), дети в семье опекуна, сага удаления."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import emit
from tilhero_social.domain import family as fam
from tilhero_social.domain import friends
from tilhero_social.models import (
    Appeal,
    Block,
    Case,
    CommunityProfile,
    DeletedUser,
    Family,
    FamilyMember,
    FriendRequest,
    Invite,
    InviteRedemption,
    LearnerActivity,
    LearnerIdempotency,
    MemberId,
    NicknameStop,
    Profile,
    Referral,
    ReferralLesson,
    Sanction,
)

DOMAIN_DELETED = "user.domain.deleted.v1"
DELETION_DOMAIN = "social"
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
    """Проекция (вид профиля) + детский профиль 6–13 попадает в семью опекуна (семья создаётся, если её нет).
    Возраст и опекун из события не сохраняются (P-6): опекун нужен только здесь, для семьи."""
    user_id = uuid.UUID(str(payload["user_id"]))
    kind = _valid(payload.get("kind"), KINDS)
    if await _deleted(session, user_id):
        return
    guardian = payload.get("guardian_user_id")
    guardian_id = uuid.UUID(str(guardian)) if guardian else None
    stmt = insert(Profile).values(user_id=user_id, kind=kind, updated_at=now)
    # created мог прийти после updated (повторная доставка): известное согласие родителя не затираем
    await session.execute(stmt.on_conflict_do_update(index_elements=["user_id"], set_={
        "kind": stmt.excluded.kind,
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
    """Обновляет согласие родителя, если оно в changed_fields и в payload; остальные поля (возраст и т. п.) не
    хранятся."""
    user_id = uuid.UUID(str(payload["user_id"]))
    if await _deleted(session, user_id):
        return
    changed = set(payload.get("changed_fields") or [])
    values: dict[str, Any] = {}
    if "guardian_consent" in changed and "guardian_consent" in payload:
        values["guardian_consent"] = _valid(payload["guardian_consent"], GUARDIAN_CONSENTS)
    if values:
        await _upsert(session, user_id, values, now)


async def _delete_social(session: AsyncSession, user_id: uuid.UUID) -> None:
    """Спринт 7 (§1.5): профиль сообщества, member_id, заявки, блокировки, санкции (обжалования — каскадом),
    проекция активности и ключи идемпотентности — удаляются; дела модерации обезличиваются (жалобщик/цель → null,
    комментарий удалённого жалобщика и его ник на момент жалобы — тоже; решение и основание остаются); рефералы —
    обезличиваются (invitee/inviter → null, статус сохраняется; уроки приглашённого удаляются)."""
    await session.execute(delete(CommunityProfile).where(CommunityProfile.user_id == user_id))
    await session.execute(delete(MemberId).where(MemberId.user_id == user_id))
    await session.execute(delete(FriendRequest).where(or_(FriendRequest.from_user == user_id,
                                                          FriendRequest.to_user == user_id)))
    await session.execute(delete(Block).where(or_(Block.blocker == user_id, Block.blocked == user_id)))
    sanction_ids = (await session.execute(delete(Sanction).where(Sanction.user_id == user_id)
                                          .returning(Sanction.sanction_id))).scalars().all()
    await session.execute(delete(Appeal).where(Appeal.user_id == user_id))
    if sanction_ids:
        await session.execute(update(Case).where(Case.sanction_id.in_(sanction_ids)).values(sanction_id=None))
    await session.execute(update(Case).where(Case.reporter_user_id == user_id)
                          .values(reporter_user_id=None, comment=None))
    await session.execute(update(Case).where(Case.target_user_id == user_id)
                          .values(target_user_id=None, target_nickname_at_report=None))
    as_invitee = (await session.execute(update(Referral).where(Referral.invitee_user_id == user_id)
                                        .values(invitee_user_id=None).returning(Referral.referral_id))
                  ).scalars().all()
    if as_invitee:
        await session.execute(delete(ReferralLesson).where(ReferralLesson.referral_id.in_(as_invitee)))
    await session.execute(update(Referral).where(Referral.inviter_user_id == user_id).values(inviter_user_id=None))
    await session.execute(delete(LearnerActivity).where(LearnerActivity.user_id == user_id))
    await session.execute(delete(LearnerIdempotency).where(LearnerIdempotency.user_id == user_id))
    # стоп-лист сброшенных ников остаётся (ключ — не данные ученика), связь с учеником — нет
    await session.execute(update(NicknameStop).where(NicknameStop.user_id == user_id).values(user_id=None))


async def delete_user_data(session: AsyncSession, user_id: uuid.UUID, request_id: uuid.UUID,
                           causation_id: str | None, producer: str) -> None:
    """Сага удаления (TG-FR-006): приглашения пользователя (с ответами на них), его ответы на чужие приглашения,
    дружбы, членство в семье, проекция → ACK user.domain.deleted.v1 (domain=social). Владелец семьи уходит — семья
    переходит к самому раннему взрослому участнику; взрослых нет — семья распускается."""
    await fam.lock_users(session, [user_id])
    await session.execute(delete(Invite).where(Invite.inviter_user_id == user_id))  # ответы — каскадом
    await session.execute(delete(InviteRedemption).where(InviteRedemption.invitee_user_id == user_id))
    # спринт 7: дружбы — с событием removed второму (source deletion)
    now = datetime.now(UTC)
    for other, _ in await friends.friend_ids(session, user_id):
        await friends.remove_friendship(session, user_id, other, now, source="deletion")
    await _delete_social(session, user_id)
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
