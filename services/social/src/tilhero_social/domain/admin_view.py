"""Админ-карточка ученика (social.read, ADM-SOC-01) и блок дашборда SocialStats (§9). Без переписки: заявки — статусы
и даты без ника и id второй стороны; блокировки — числа; дела — счётчики и строки."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import not_found
from tilhero_social.domain import community, friends, members, moderation
from tilhero_social.domain.common import is_deleted, iso
from tilhero_social.domain.restrictions import active_ban
from tilhero_social.models import (
    Block,
    Case,
    CommunityProfile,
    FamilyMember,
    FriendRequest,
    Friendship,
    Invite,
    InviteRedemption,
    LearnerActivity,
    MemberId,
    Profile,
    Referral,
    Sanction,
)


async def known(session: AsyncSession, user_id: uuid.UUID) -> bool:
    """Ученик известен social: есть проекция профиля из identity-событий (user.profile.created/updated.v1), строка
    реестра member_id (регистрация ученика, миграция 0002, выдача member_id), профиль сообщества, проекция
    активности (уроки, диагностика) или любой след в приглашениях, семье, дружбе, заявках, блокировках, делах,
    санкциях и рефералах."""
    traces = (
        exists().where(Profile.user_id == user_id), exists().where(MemberId.user_id == user_id),
        exists().where(CommunityProfile.user_id == user_id), exists().where(LearnerActivity.user_id == user_id),
        exists().where(FamilyMember.user_id == user_id),
        exists().where(or_(Friendship.user_a == user_id, Friendship.user_b == user_id)),
        exists().where(Invite.inviter_user_id == user_id), exists().where(InviteRedemption.invitee_user_id == user_id),
        exists().where(or_(FriendRequest.from_user == user_id, FriendRequest.to_user == user_id)),
        exists().where(or_(Block.blocker == user_id, Block.blocked == user_id)),
        exists().where(or_(Case.reporter_user_id == user_id, Case.target_user_id == user_id)),
        exists().where(Sanction.user_id == user_id),
        exists().where(or_(Referral.inviter_user_id == user_id, Referral.invitee_user_id == user_id)),
    )
    return bool((await session.execute(select(or_(*traces)))).scalar_one())


async def social_card(session: AsyncSession, user_id: uuid.UUID, now: datetime, *, member_key: bytes,
                      ttl_days: int) -> dict[str, Any]:
    """AdminSocialCard. Ученика, известного social (known), без профиля сообщества — профиль без ника, нули и
    member_id. Удалённый или неизвестный social — 404 SOCIAL_PROFILE_NOT_FOUND (неотличимо)."""
    if await is_deleted(session, user_id) or not await known(session, user_id):
        raise not_found("SOCIAL_PROFILE_NOT_FOUND", "Профиль сообщества не найден")
    profile = await community.get(session, user_id)
    mid = members.member_id_of(member_key, user_id)
    reqs = (await session.execute(select(FriendRequest).where(
        or_(FriendRequest.from_user == user_id, FriendRequest.to_user == user_id))
        .order_by(FriendRequest.created_at.desc(), FriendRequest.request_id.desc()).limit(50))).scalars().all()
    given = int((await session.execute(select(func.count()).select_from(Block).where(Block.blocker == user_id))
                 ).scalar_one())
    received = int((await session.execute(select(func.count()).select_from(Block).where(Block.blocked == user_id))
                    ).scalar_one())

    async def count(*cond: Any) -> int:
        return int((await session.execute(select(func.count()).select_from(Case).where(*cond))).scalar_one())

    recent = (await session.execute(select(Case).where(
        or_(Case.reporter_user_id == user_id, Case.target_user_id == user_id))
        .order_by(Case.created_at.desc(), Case.case_id.desc()).limit(20))).scalars().all()
    ban = await active_ban(session, user_id, now)
    return {
        "user_id": str(user_id), "member_id": mid,
        "nickname": profile.nickname if profile else None,
        "friend_code": profile.friend_code if profile else None,
        "game_profile_hidden": bool(profile.game_profile_hidden) if profile else False,
        "nickname_changed_at": iso(profile.nickname_changed_at) if profile else None,
        "friends": await friends.friend_count(session, user_id),
        "requests": [{"request_id": str(r.request_id), "direction": "out" if r.from_user == user_id else "in",
                      "status": friends.effective_status(r, now, ttl_days), "created_at": iso(r.created_at),
                      "decided_at": iso(r.decided_at)} for r in reqs],
        "blocks": {"given": given, "received": received},
        "cases": {
            "as_reporter": await count(Case.reporter_user_id == user_id),
            "as_target": await count(Case.target_user_id == user_id),
            "open_as_target": await count(Case.target_user_id == user_id, Case.status == "open"),
            "recent": await moderation.case_rows(session, recent, now),
        },
        "sanctions": await moderation.admin_sanctions_of(session, user_id, now),
        "restrictions": {"social_ban": ban[0], "social_ban_until": iso(ban[1]) if ban[0] else None},
    }


async def stats(session: AsyncSession, period: str, since: datetime) -> dict[str, Any]:
    """SocialStats; duels_finished и pair_rooms_finished — null (их добавляет admin-bff из gamification и lessons)."""

    async def count(model: Any, *cond: Any) -> int:
        return int((await session.execute(select(func.count()).select_from(model).where(*cond))).scalar_one())

    return {
        "period": period,
        "friend_requests": await count(FriendRequest, FriendRequest.created_at >= since),
        "friendships_added": await count(Friendship, Friendship.created_at >= since),
        "duels_finished": None,
        "pair_rooms_finished": None,
        "referrals_in_review": await count(Referral, Referral.status == "review"),
        "cases_opened": await count(Case, Case.created_at >= since),
        "cases_open": await count(Case, Case.status == "open"),
    }


def period_start(period: str, now: datetime, day_start: datetime) -> datetime:
    if period == "today":
        return day_start
    return now - timedelta(days=7 if period == "7d" else 30)
