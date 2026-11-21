"""Участники социального (INTERNAL_API спринта 7 §0, §2.1): member_id, чтение проекций social и diagnostics.

member_id = "mb_" + base64url(HMAC-SHA256(MEMBER_ID_KEY, str(user_id))[:16]) без «=» — 25 символов, одинаков в
social, gamification и lessons; обратного вычисления нет. member_id → user_id: проекция профиля сообщества, затем
друзья и семья ученика (их member_id вычисляется), затем social `GET /internal/v1/members/{member_id}` (ответ
сверяется с HMAC). Наружу (API ученика) user_id других учеников не отдаётся никогда.

Все чтения здесь — без блокировок; решения команд, зависящие от связи учеников, перепроверяются под блокировками
учеников в доменных модулях.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import uuid
from collections.abc import Iterable
from datetime import datetime
from typing import Any, Final

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_gamification.domain import assets
from tilhero_gamification.models import (
    Badge,
    Community,
    FamilyMember,
    Hero,
    Learner,
    LearnerLevel,
    Sanction,
    SocialBlock,
    SocialFriend,
)
from tilhero_gamification.settings import Settings

MEMBER_RE: Final = re.compile(r"^mb_[A-Za-z0-9_-]{22}$")
BANDS: Final = ("A0-A1", "A2", "B1+")
DEFAULT_BAND: Final = "A0-A1"
# provisional_level диагностики → полоса лиги
BAND_OF_LEVEL: Final = {"A0": "A0-A1", "A1": "A0-A1", "A2": "A2", "B1": "B1+", "B2": "B1+"}
# разрешённые значки в рейтингах — не связанные с ошибками (все значки игры — за достижения); ≤ 3 последних
STANDING_BADGES: Final = 3


def member_id(user_id: uuid.UUID, key: str) -> str:
    digest = hmac.new(key.encode("utf-8"), str(user_id).lower().encode("utf-8"), hashlib.sha256).digest()[:16]
    return "mb_" + base64.urlsafe_b64encode(digest).decode().rstrip("=")


def member_of(settings: Settings, user_id: uuid.UUID) -> str:
    return member_id(user_id, settings.member_id_key.get_secret_value())


def ordered_pair(a: uuid.UUID, b: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID]:
    """Пара дружбы: user_a < user_b по строке UUID (как в social.friendship.changed.v1)."""
    return (a, b) if str(a) < str(b) else (b, a)


def pair_key(a: uuid.UUID, b: uuid.UUID) -> str:
    x, y = ordered_pair(a, b)
    return f"{x}:{y}"


# ---------------------------------------------------------------- проекции: чтение


async def friends_of(session: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    rows = (await session.execute(select(SocialFriend.user_a, SocialFriend.user_b).where(
        SocialFriend.status == "added", or_(SocialFriend.user_a == user_id, SocialFriend.user_b == user_id)))).all()
    return [b if a == user_id else a for a, b in rows]


async def are_friends(session: AsyncSession, a: uuid.UUID, b: uuid.UUID) -> bool:
    x, y = ordered_pair(a, b)
    row = await session.get(SocialFriend, (x, y))
    return row is not None and row.status == "added"


async def blocked_with(session: AsyncSession, user_id: uuid.UUID, others: Iterable[uuid.UUID]) -> set[uuid.UUID]:
    """Кто из others заблокирован учеником или заблокировал его (в любую сторону)."""
    ids = list(set(others))
    if not ids:
        return set()
    rows = (await session.execute(select(SocialBlock.blocker_user_id, SocialBlock.blocked_user_id).where(
        SocialBlock.status == "added",
        or_(and_(SocialBlock.blocker_user_id == user_id, SocialBlock.blocked_user_id.in_(ids)),
            and_(SocialBlock.blocked_user_id == user_id, SocialBlock.blocker_user_id.in_(ids)))))).all()
    return {b if a == user_id else a for a, b in rows}


async def family_of(session: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Члены семьи ученика (с ним самим); пусто — семьи нет."""
    family = (await session.execute(select(FamilyMember.family_id).where(FamilyMember.user_id == user_id))).scalar()
    if family is None:
        return []
    return list((await session.execute(select(FamilyMember.user_id).where(FamilyMember.family_id == family)
                                       .order_by(FamilyMember.added_at, FamilyMember.user_id))).scalars().all())


async def community(session: AsyncSession, ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, Community]:
    ids = list(set(ids))
    if not ids:
        return {}
    return {c.user_id: c for c in (await session.execute(select(Community).where(Community.user_id.in_(ids))))
            .scalars().all()}


async def active_ban(session: AsyncSession, user_id: uuid.UUID, now: datetime) -> tuple[bool, datetime | None]:
    """Действует social_ban: (да/нет, конец — null бессрочно)."""
    rows = (await session.execute(select(Sanction.until).where(
        Sanction.user_id == user_id, Sanction.kind == "social_ban", Sanction.active.is_(True),
        or_(Sanction.until.is_(None), Sanction.until > now)))).scalars().all()
    if not rows:
        return False, None
    return True, None if any(u is None for u in rows) else max(u for u in rows if u is not None)


async def banned_among(session: AsyncSession, ids: Iterable[uuid.UUID], now: datetime) -> set[uuid.UUID]:
    ids = list(set(ids))
    if not ids:
        return set()
    return set((await session.execute(select(Sanction.user_id).where(
        Sanction.user_id.in_(ids), Sanction.kind == "social_ban", Sanction.active.is_(True),
        or_(Sanction.until.is_(None), Sanction.until > now)))).scalars().all())


async def active_pair(session: AsyncSession, settings: Settings, user_id: uuid.UUID) -> str:
    """Активная пара — пара последней диагностики; без диагностики — DEFAULT_PAIR_ID."""
    pair = (await session.execute(select(LearnerLevel.pair_id).where(LearnerLevel.user_id == user_id)
                                  .order_by(LearnerLevel.completed_at.desc()).limit(1))).scalar()
    return str(pair) if pair else settings.default_pair_id


async def band_of(session: AsyncSession, user_id: uuid.UUID, pair_id: str) -> str:
    """Полоса уровня ученика по паре (последняя диагностика); без диагностики — A0-A1."""
    row = await session.get(LearnerLevel, (user_id, pair_id))
    return row.level_band if row is not None else DEFAULT_BAND


def band_index(band: str) -> int:
    return BANDS.index(band) if band in BANDS else 0


# ---------------------------------------------------------------- member_id → user_id


async def resolve_local(session: AsyncSession, settings: Settings, me: uuid.UUID, mid: str) -> uuid.UUID | None:
    """Без social: профиль сообщества, затем друзья и семья ученика (их member_id вычисляется)."""
    if not MEMBER_RE.match(mid):
        return None
    found = (await session.execute(select(Community.user_id).where(Community.member_id == mid))).scalar()
    if found is not None:
        return uuid.UUID(str(found))
    for other in [*await friends_of(session, me), *await family_of(session, me)]:
        if member_of(settings, other) == mid:
            return other
    return None


# ---------------------------------------------------------------- строки рейтингов и карточки соперника


async def member_cards(session: AsyncSession, settings: Settings, ids: Iterable[uuid.UUID],
                       images: dict[uuid.UUID, dict[str, Any]] | None = None) -> dict[uuid.UUID, dict[str, Any]]:
    """{user_id: {member_id, nickname, hero, badges}} — только то, что можно показывать другим (APP-SOC-09):
    ник, герой (код, ступень, картинка), до 3 последних значков. Без имени, возраста, ответов и покупок."""
    ids = list(set(ids))
    if not ids:
        return {}
    profiles = await community(session, ids)
    learners = {r.user_id: r for r in (await session.execute(
        select(Learner.user_id, Learner.hero_code, Learner.hero_stage).where(Learner.user_id.in_(ids)))).all()}
    codes = {r.hero_code for r in learners.values() if r.hero_code}
    heroes = {h.code: h for h in (await session.execute(select(Hero).where(Hero.code.in_(codes)))).scalars().all()
              } if codes else {}
    want: dict[uuid.UUID, uuid.UUID] = {}
    for uid, r in learners.items():
        hero = heroes.get(r.hero_code) if r.hero_code else None
        if hero is None or hero.published_at is None:
            continue
        stage = next((s for s in hero.stages if int(s["stage"]) == int(r.hero_stage)), None)
        if stage is not None:
            want[uid] = uuid.UUID(str(stage["asset_id"]))
    imgs = images if images is not None else await assets.learner_images(session, list(set(want.values())))
    badge_rows = (await session.execute(select(Badge.user_id, Badge.badge_code).where(Badge.user_id.in_(ids))
                                        .order_by(Badge.user_id, Badge.earned_at.desc(), Badge.badge_code))).all()
    badges: dict[uuid.UUID, list[str]] = {}
    for uid, code in badge_rows:
        lst = badges.setdefault(uid, [])
        if len(lst) < STANDING_BADGES:
            lst.append(code)
    out: dict[uuid.UUID, dict[str, Any]] = {}
    for uid in ids:
        prof = profiles.get(uid)
        lr = learners.get(uid)
        hero_view = None
        if lr is not None and uid in want and want[uid] in imgs:
            hero_view = {"code": lr.hero_code, "stage": int(lr.hero_stage), "image": dict(imgs[want[uid]])}
        mid = prof.member_id if prof is not None else member_of(settings, uid)
        out[uid] = {"member_id": mid, "nickname": prof.nickname if prof is not None else None,
                    "hero": hero_view, "badges": badges.get(uid, [])}
    return out
