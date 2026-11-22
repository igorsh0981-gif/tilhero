"""Другие ученики в социальных командах lessons (INTERNAL_API §0, §1.2): member_id, проекции social (профиль
сообщества, блокировки, санкции), связь двух учеников и проверка допуска к парному уроку.

- member_id = "mb_" + base64url(HMAC-SHA256(MEMBER_ID_KEY, str(user_id))[:16]) без «=» — одинаков в social,
  gamification и lessons; обратного вычисления нет: member_id → user_id — по проекции `community_members` или
  social `GET /internal/v1/members/{member_id}` (результат сверяется с HMAC — защита от подмены);
- блокировка (любая сторона) — по проекции и по ответу relations: 403 BLOCKED без раскрытия, кто заблокировал;
- санкция social_ban — по проекции и relations: 403 SOCIAL_RESTRICTED {until | null}; идущая комната доигрывается;
- допуск: одна семья — всем; друзья — только 14+ (дети 6–13 — только семья): иначе 403 PARTNER_NOT_ALLOWED.
Проекции обновляются только событиями social (consumers.py); устаревшее событие не откатывает более новое.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, forbidden, not_found
from tilhero_lessons import clients
from tilhero_lessons.domain.common import lock_users
from tilhero_lessons.models import CommunityMember, DeletedUser, LearnerProfile, SocialBlock, SocialSanction

log = logging.getLogger("tilhero.lessons.members")

MEMBER_RE = re.compile(r"^mb_[A-Za-z0-9_-]{22}$")
KIDS_BANDS = frozenset({"6-9", "10-13"})
# место «удалённого участника» в представлениях (member_id обязателен в PairRoomView): HMAC от нулевого UUID
DELETED_USER = uuid.UUID(int=0)


def member_id(user_id: uuid.UUID, key: bytes) -> str:
    digest = hmac.new(key, str(user_id).lower().encode("utf-8"), hashlib.sha256).digest()[:16]
    return "mb_" + base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def member_not_found() -> ApiError:
    return not_found("MEMBER_NOT_FOUND", "Участник не найден")


def blocked() -> ApiError:
    return forbidden("BLOCKED", "Действие недоступно")


def social_restricted(until: datetime | None) -> ApiError:
    return forbidden("SOCIAL_RESTRICTED", "Социальные действия временно ограничены",
                     {"until": until.astimezone(UTC).isoformat().replace("+00:00", "Z") if until else None})


def friends_not_allowed(reason: str) -> ApiError:
    return forbidden("FRIENDS_NOT_ALLOWED", "Друзья пока недоступны", {"reason": reason})


def partner_not_allowed(reason: str) -> ApiError:
    return forbidden("PARTNER_NOT_ALLOWED", "Парный урок — только с другом или членом семьи (детям — с семьёй)",
                     {"reason": reason})


async def resolve(rt: Runtime, db_factory: Any, mid: str, key: bytes) -> uuid.UUID:
    """member_id → user_id: проекция, затем social. Нет / не сходится HMAC / удалён — 404 MEMBER_NOT_FOUND."""
    if not MEMBER_RE.match(mid):
        raise member_not_found()
    async with db_factory() as db:
        row = (await db.execute(select(CommunityMember.user_id).where(CommunityMember.member_id == mid))
               ).scalar_one_or_none()
    user = row if row is not None else await clients.member_user(rt, mid)
    if user is None or not hmac.compare_digest(member_id(user, key), mid):
        if user is not None:
            log.warning("member_id does not match MEMBER_ID_KEY")
        raise member_not_found()
    async with db_factory() as db:
        if await db.get(DeletedUser, user) is not None:
            raise member_not_found()
    return user


async def nicknames(db: AsyncSession, user_ids: list[uuid.UUID]) -> dict[uuid.UUID, str | None]:
    ids = [u for u in user_ids if u is not None]
    if not ids:
        return {}
    rows = (await db.execute(select(CommunityMember.user_id, CommunityMember.nickname)
                             .where(CommunityMember.user_id.in_(ids)))).all()
    return {u: n for u, n in rows}


async def blocked_between(db: AsyncSession, a: uuid.UUID, b: uuid.UUID) -> bool:
    row = (await db.execute(select(SocialBlock.blocker).where(SocialBlock.active.is_(True), or_(
        and_(SocialBlock.blocker == a, SocialBlock.blocked == b),
        and_(SocialBlock.blocker == b, SocialBlock.blocked == a))).limit(1))).first()
    return row is not None


async def active_ban(db: AsyncSession, user_id: uuid.UUID, now: datetime) -> tuple[bool, datetime | None]:
    """Действующий social_ban по проекции: (есть, until — самый поздний; None — бессрочный)."""
    rows = (await db.execute(select(SocialSanction.until).where(
        SocialSanction.user_id == user_id, SocialSanction.kind == "social_ban", SocialSanction.active.is_(True),
        or_(SocialSanction.until.is_(None), SocialSanction.until > now)))).scalars().all()
    if not rows:
        return False, None
    if any(u is None for u in rows):
        return True, None
    return True, max(u for u in rows if u is not None)


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


async def ensure_not_restricted(db: AsyncSession, user_id: uuid.UUID, now: datetime,
                                rel_restricted: bool = False, rel_until: str | None = None) -> None:
    banned, until = await active_ban(db, user_id, now)
    if banned:
        raise social_restricted(until)
    if rel_restricted:
        raise social_restricted(_parse_ts(rel_until))


async def projected_audience(db: AsyncSession, user_id: uuid.UUID) -> str | None:
    profile = await db.get(LearnerProfile, user_id)
    if profile is None:
        return None
    if profile.kind == "child" or profile.age_band in KIDS_BANDS:
        return "kids"
    return {"14-17": "teens", "18+": "adults"}.get(profile.age_band or "")


def strictest(*audiences: str | None) -> str:
    """kids — если кто-то ребёнок или возраст неизвестен (самый строгий набор); teens — если есть подросток."""
    known = [a for a in audiences if a is not None]
    if "kids" in known or not known:
        return "kids"
    return "teens" if "teens" in known else "adults"


@dataclass(frozen=True)
class Admission:
    relation: clients.Relation
    me_audience: str
    partner_audience: str


async def admit(rt: Runtime, db_factory: Any, me: uuid.UUID, partner: uuid.UUID, me_audience: str,
                now: datetime, key: bytes | None = None) -> Admission:
    """Проверки социальной команды (INTERNAL_API §0): санкция (моя), блокировка, аудитория и связь. Партнёр под
    санкцией — 403 PARTNER_NOT_ALLOWED (санкция чужого ученика не раскрывается). Дружба (не семья) — только если
    друзья доступны обоим (`*_social_allowed` social: 14–17 — с согласием родителя, цель social)."""
    rel = await clients.relation(rt, me, partner)
    if rel is None:
        raise member_not_found()
    if key is not None and rel.b_member_id is not None and not hmac.compare_digest(rel.b_member_id,
                                                                                   member_id(partner, key)):
        log.warning("relations member_id does not match MEMBER_ID_KEY")
    async with db_factory() as db:
        await ensure_not_restricted(db, me, now, rel.a_restricted, rel.a_until)
        if rel.blocked_any or await blocked_between(db, me, partner):
            raise blocked()
        partner_banned, _ = await active_ban(db, partner, now)
        partner_projected = await projected_audience(db, partner)
    if partner_banned or rel.b_restricted:
        raise partner_not_allowed("partner_restricted")
    my_aud = strictest(me_audience, rel.a_audience) if rel.a_audience == "kids" else me_audience
    partner_aud = strictest(rel.b_audience, partner_projected) if (rel.b_audience or partner_projected) else "kids"
    if "kids" in (my_aud, partner_aud):
        if not rel.same_family:
            raise partner_not_allowed("family_only")
    elif not rel.same_family:
        if rel.a_social_allowed is False:
            raise friends_not_allowed("guardian_consent" if my_aud == "teens" else "consent")
        if not rel.friends or rel.b_social_allowed is False:
            raise partner_not_allowed("not_friends")
    return Admission(rel, my_aud, partner_aud)


# ---------------------------------------------------------------- проекции (consumers, только от social)


def _at(payload: dict[str, Any], *keys: str, fallback: datetime) -> datetime:
    for k in keys:
        dt = _parse_ts(payload.get(k)) if isinstance(payload.get(k), str) else None
        if dt is not None:
            return dt
    return fallback


async def alive(db: AsyncSession, *user_ids: uuid.UUID) -> bool:
    """Блокировки учеников (как у саги удаления), затем проверка «удалён?»: сага держит блокировку до фиксации, поэтому
    событие, пришедшее во время саги, ждёт и видит удаление — проекция удалённого не воскрешается."""
    await lock_users(db, *user_ids)
    for u in user_ids:
        if await db.get(DeletedUser, u, populate_existing=True) is not None:
            return False
    return True


async def on_profile_updated(db: AsyncSession, payload: dict[str, Any], occurred_at: datetime) -> None:
    """social.profile.updated.v1 → member_id и ник (удалённый ученик не воскрешается)."""
    user_id = uuid.UUID(str(payload["user_id"]))
    if not await alive(db, user_id):
        return
    at = _at(payload, "updated_at", fallback=occurred_at)
    mid = str(payload["member_id"])
    nick = payload.get("nickname") if isinstance(payload.get("nickname"), str) else None
    stmt = insert(CommunityMember).values(user_id=user_id, member_id=mid, nickname=nick, updated_at=at)
    await db.execute(stmt.on_conflict_do_update(
        index_elements=["user_id"], set_={"member_id": mid, "nickname": nick, "updated_at": at},
        where=CommunityMember.updated_at <= at))


async def on_block_changed(db: AsyncSession, payload: dict[str, Any], occurred_at: datetime) -> tuple[
        uuid.UUID, uuid.UUID, bool] | None:
    """social.block.changed.v1 → проекция; → (blocker, blocked, действует ли блокировка) или None — один из учеников
    удалён (событие не исполняется)."""
    blocker, blocked_ = uuid.UUID(str(payload["blocker_user_id"])), uuid.UUID(str(payload["blocked_user_id"]))
    if not await alive(db, blocker, blocked_):
        return None
    active = payload.get("status") == "added"
    at = _at(payload, "at", fallback=occurred_at)
    stmt = insert(SocialBlock).values(blocker=blocker, blocked=blocked_, active=active, at=at)
    await db.execute(stmt.on_conflict_do_update(index_elements=["blocker", "blocked"],
                                                set_={"active": active, "at": at}, where=SocialBlock.at <= at))
    row = await db.get(SocialBlock, (blocker, blocked_), populate_existing=True)
    return blocker, blocked_, bool(row is not None and row.active)


async def on_sanction_changed(db: AsyncSession, payload: dict[str, Any], occurred_at: datetime,
                              partners: list[uuid.UUID] | None = None) -> tuple[uuid.UUID, bool] | None:
    """social.sanction.changed.v1 → проекция; → (user_id, действует ли social_ban после события) или None — ученик
    удалён (событие не исполняется). partners — участники его неотвеченных приглашений: блокируются вместе с ним
    одним упорядоченным набором (отмена приглашений — без взаимных блокировок с командами комнат)."""
    sid, user_id = uuid.UUID(str(payload["sanction_id"])), uuid.UUID(str(payload["user_id"]))
    # блокировки — ученик и партнёры одним порядком; «удалён?» решает только сам ученик: удалённый партнёр не мешает
    # записать санкцию (его неначатые приглашения сага уже удалила)
    await lock_users(db, user_id, *(partners or []))
    if not await alive(db, user_id):
        return None
    at = _at(payload, "changed_at", fallback=occurred_at)
    until = _parse_ts(payload.get("until")) if isinstance(payload.get("until"), str) else None
    values = {"user_id": user_id, "kind": str(payload.get("kind"))[:16], "until": until,
              "active": payload.get("active") is True, "changed_at": at}
    stmt = insert(SocialSanction).values(sanction_id=sid, **values)
    await db.execute(stmt.on_conflict_do_update(index_elements=["sanction_id"], set_=values,
                                                where=SocialSanction.changed_at <= at))
    banned, _ = await active_ban(db, user_id, at)
    return user_id, banned and values["kind"] == "social_ban" and values["active"] is True
