"""Приглашения: создание, список, отзыв, открытие по токену, карточка, принятие (двустороннее), отклонение.

Вызовы identity-consent делает API-слой вне транзакций; сюда приходит готовый Person. Принятие сериализуется
advisory-блокировкой пользователей (пригласивший + получатель) и FOR UPDATE строки приглашения: одноразовую ссылку
принимает ровно один человек, человек попадает ровно в одну семью.
"""

from __future__ import annotations

import base64
import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import and_, exists, func, or_, select, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, bad_request, conflict, not_found
from tilhero_common.messaging import emit
from tilhero_social.domain import family as fam
from tilhero_social.domain import friends, members, referrals, restrictions, rules
from tilhero_social.domain.common import blocked
from tilhero_social.identity import Person, PublicProfile
from tilhero_social.models import Friendship, Invite, InviteRedemption, Profile
from tilhero_social.schemas import InviteOut, InvitePreviewOut
from tilhero_social.settings import Settings

CREATED = "social.invite.created.v1"
OPENED = "social.invite.opened.v1"
ACCEPTED = "social.invite.accepted.v1"
DECLINED = "social.invite.declined.v1"


def invite_not_found() -> ApiError:
    return not_found("INVITE_NOT_FOUND", "Приглашение не найдено")


def _iso(ts: datetime) -> str:
    return ts.isoformat().replace("+00:00", "Z")


class IdempotencyReused(Exception):
    pass


async def person_for(session: AsyncSession, user_id: uuid.UUID, pub: PublicProfile | None) -> Person | None:
    """Ответ identity-consent; согласие родителя — из проекции, если его нет в ответе. Нет `consent_accepted` /
    `purposes` в ответе — согласия нет (fail closed)."""
    if pub is None:
        return None
    consent = pub.guardian_consent
    if consent is None:
        row = await session.get(Profile, user_id)
        consent = row.guardian_consent if row is not None else None
    return Person(user_id, pub.display_name, pub.kind, pub.age_band, pub.status, consent,
                  consent_accepted=pub.consent_accepted is True, purposes=frozenset(pub.purposes or ()))


def to_out(inv: Invite, settings: Settings, now: datetime) -> InviteOut:
    token = rules.make_token(settings.invite_key_bytes(), inv.invite_id)
    return InviteOut.model_validate({
        "invite_id": str(inv.invite_id),
        "kind": inv.kind,
        "link": rules.invite_link(settings.telegram_app_link, token),
        "status": rules.effective_status(inv.status, inv.expires_at, now),
        "expires_at": inv.expires_at,
        "created_at": inv.created_at,
        "accepted_count": inv.uses,
    })


# ---------------------------------------------------------------- создатель


async def find_replay(session: AsyncSession, inviter: uuid.UUID, key: str, kind: str) -> Invite | None:
    inv = (await session.execute(
        select(Invite).where(Invite.inviter_user_id == inviter, Invite.idempotency_key == key))).scalar_one_or_none()
    if inv is not None and inv.kind != kind:
        raise IdempotencyReused
    return inv


async def create(session: AsyncSession, inviter: uuid.UUID, person: Person | None, kind: str, *, key: str,
                 now: datetime, settings: Settings) -> tuple[Invite, bool]:
    """→ (приглашение, replayed). Правила возраста, согласие с целью social, ≤ N активных, ≤ M за сутки;
    social.invite.created.v1."""
    await fam.lock_users(session, [inviter])
    replay = await find_replay(session, inviter, key, kind)
    if replay is not None:
        return replay, True
    rules.check_inviter(person, kind)
    rules.check_consent(person, social=True)
    active = (await session.execute(
        select(func.count()).select_from(Invite).where(
            Invite.inviter_user_id == inviter, Invite.status == "active",
            or_(Invite.expires_at.is_(None), Invite.expires_at > now)))).scalar_one()
    if active >= settings.max_active_invites:
        raise conflict("INVITES_LIMIT", "Слишком много активных приглашений — отзовите ненужные",
                       {"limit": settings.max_active_invites, "window": "active"})
    recent = (await session.execute(
        select(func.count()).select_from(Invite).where(
            Invite.inviter_user_id == inviter, Invite.created_at > now - timedelta(hours=24)))).scalar_one()
    if recent >= settings.max_invites_per_day:
        raise conflict("INVITES_LIMIT", "Слишком много приглашений за сутки — попробуйте завтра",
                       {"limit": settings.max_invites_per_day, "window": "24h"})
    invite_id = uuid.uuid4()
    token = rules.make_token(settings.invite_key_bytes(), invite_id)
    inv = Invite(
        invite_id=invite_id,
        inviter_user_id=inviter,
        kind=kind,
        token_hash=rules.token_hash(token),
        status="active",
        max_uses=rules.MAX_USES[kind],
        uses=0,
        expires_at=rules.expires_at(kind, now, settings.invite_family_ttl_days, settings.invite_friend_ttl_days),
        idempotency_key=key,
        created_at=now,
        updated_at=now,
    )
    session.add(inv)
    await session.flush()
    await emit(session, CREATED, {
        "invite_id": str(invite_id), "inviter_user_id": str(inviter), "kind": kind,
        "expires_at": _iso(inv.expires_at) if inv.expires_at else None,
    }, producer=settings.service_name)
    return inv, False


def encode_cursor(inv: Invite) -> str:
    raw = json.dumps({"c": inv.created_at.isoformat(), "i": str(inv.invite_id)}).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        created = datetime.fromisoformat(data["c"])
        if created.tzinfo is None:
            raise ValueError("naive")
        return created, uuid.UUID(data["i"])
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc


async def list_mine(session: AsyncSession, inviter: uuid.UUID, *, limit: int,
                    cursor: str | None) -> tuple[Sequence[Invite], str | None]:
    stmt = (select(Invite).where(Invite.inviter_user_id == inviter)
            .order_by(Invite.created_at.desc(), Invite.invite_id.desc()).limit(limit + 1))
    if cursor:
        created, invite_id = decode_cursor(cursor)
        stmt = stmt.where(tuple_(Invite.created_at, Invite.invite_id) < tuple_(created, invite_id))
    rows = (await session.execute(stmt)).scalars().all()
    return rows[:limit], encode_cursor(rows[limit - 1]) if len(rows) > limit else None


async def revoke(session: AsyncSession, inviter: uuid.UUID, invite_id: uuid.UUID, now: datetime) -> Invite:
    """Отзыв своего активного приглашения; чужое — 404 (не раскрываем существование); повтор — без изменений."""
    inv = (await session.execute(
        select(Invite).where(Invite.invite_id == invite_id, Invite.inviter_user_id == inviter).with_for_update()
    )).scalar_one_or_none()
    if inv is None:
        raise invite_not_found()
    if rules.effective_status(inv.status, inv.expires_at, now) == "active":
        inv.status = "revoked"
        inv.updated_at = now
        await session.flush()
    return inv


# ---------------------------------------------------------------- получатель


async def find_by_token(session: AsyncSession, token: str) -> Invite | None:
    if not rules.is_token(token):
        return None
    return (await session.execute(
        select(Invite).where(Invite.token_hash == rules.token_hash(token)))).scalar_one_or_none()


async def redemption(session: AsyncSession, invite_id: uuid.UUID, user: uuid.UUID, *,
                     for_update: bool = False) -> InviteRedemption | None:
    stmt = select(InviteRedemption).where(InviteRedemption.invite_id == invite_id,
                                          InviteRedemption.invitee_user_id == user)
    if for_update:
        stmt = stmt.with_for_update()
    return (await session.execute(stmt)).scalar_one_or_none()


async def record_open(session: AsyncSession, inv: Invite, me: uuid.UUID, now: datetime, producer: str) -> None:
    """Первое открытие — строка redemption + social.invite.opened.v1; повтор не создаёт дубль. Своё — ничего."""
    if inv.inviter_user_id == me:
        return
    inserted = await session.execute(
        insert(InviteRedemption).values(invite_id=inv.invite_id, invitee_user_id=me, opened_at=now)
        .on_conflict_do_nothing().returning(InviteRedemption.invitee_user_id)
    )
    if inserted.first() is None:
        return
    await emit(session, OPENED, {
        "invite_id": str(inv.invite_id), "inviter_user_id": str(inv.inviter_user_id), "invitee_user_id": str(me),
        "kind": inv.kind, "opened_at": _iso(now),
    }, producer=producer)


async def _are_friends(session: AsyncSession, x: uuid.UUID, y: uuid.UUID) -> bool:
    a, b = rules.ordered_pair(x, y)
    return await session.get(Friendship, (a, b)) is not None


async def _referral_used(session: AsyncSession, me: uuid.UUID, except_invite: uuid.UUID) -> bool:
    """Получатель уже принял какое-либо реферальное приглашение — повторная активация реферала запрещена."""
    r = InviteRedemption.__table__.c
    i = Invite.__table__.c
    return bool((await session.execute(select(exists().where(and_(
        r.invitee_user_id == me, r.accepted_at.is_not(None), r.invite_id != except_invite,
        i.invite_id == r.invite_id, i.kind == "referral"))))).scalar_one())


@dataclass(frozen=True)
class Facts:
    accepted_by_me: bool
    in_family: bool
    family_full: bool
    already_friends: bool
    referral_used: bool


async def viewer_facts(session: AsyncSession, inv: Invite, me: uuid.UUID, family_max: int) -> Facts:
    red = await redemption(session, inv.invite_id, me)
    in_family = family_full = friends = used = False
    if inv.kind == "family":
        in_family = await fam.membership(session, me) is not None
        owner_family = await fam.membership(session, inv.inviter_user_id)
        family_full = owner_family is not None and await fam.size(session, owner_family.family_id) >= family_max
    else:
        friends = await _are_friends(session, inv.inviter_user_id, me)
        if inv.kind == "referral":
            used = await _referral_used(session, me, inv.invite_id)
    return Facts(bool(red and red.accepted_at), in_family, family_full, friends, used)


def preview_reason(inv: Invite, me: uuid.UUID, viewer: Person | None, facts: Facts, now: datetime) -> str | None:
    """Почему нельзя принять (порядок важен: сначала то, что верно для любого получателя)."""
    if inv.inviter_user_id == me:
        return "self"
    status = rules.effective_status(inv.status, inv.expires_at, now)
    if status == "revoked":
        return "revoked"
    if status == "expired":
        return "expired"
    if facts.accepted_by_me:
        return "already_member" if inv.kind == "family" else "already_friends"
    if status == "accepted":
        return "already_used"
    if not rules.can_receive(viewer):
        return "not_allowed"
    if inv.kind == "family":
        if facts.in_family:
            return "already_member"
        if facts.family_full:
            return "not_allowed"
        return None
    if facts.already_friends:
        return "already_friends"
    if facts.referral_used:
        return "already_used"
    return None


def preview_out(inv: Invite, inviter_name: str, me: uuid.UUID, viewer: Person | None, facts: Facts,
                now: datetime) -> InvitePreviewOut:
    reason = preview_reason(inv, me, viewer, facts, now)
    return InvitePreviewOut.model_validate({
        "invite_id": str(inv.invite_id),
        "kind": inv.kind,
        "inviter_display_name": inviter_name,
        "status": rules.effective_status(inv.status, inv.expires_at, now),
        "can_accept": reason is None,
        "reason": reason,
    })


async def accept(session: AsyncSession, invite_id: uuid.UUID, inviter: uuid.UUID, me: uuid.UUID,
                 person: Person | None, *, now: datetime, settings: Settings) -> tuple[Invite, uuid.UUID | None]:
    """→ (приглашение, family_id для семейного). Повтор тем же получателем — тот же результат без событий."""
    await fam.lock_users(session, [inviter, me])
    inv = (await session.execute(
        select(Invite).where(Invite.invite_id == invite_id).with_for_update()
        .execution_options(populate_existing=True))).scalar_one_or_none()
    if inv is None:
        raise invite_not_found()
    if inv.inviter_user_id == me:
        raise conflict("INVITE_SELF", "Нельзя принять собственное приглашение")
    red = await redemption(session, invite_id, me, for_update=True)
    if red is None:
        raise invite_not_found()  # принять можно только открытое приглашение
    if red.accepted_at is not None:
        member = await fam.membership(session, me) if inv.kind == "family" else None
        return inv, member.family_id if member else None
    status = rules.effective_status(inv.status, inv.expires_at, now)
    if status == "revoked":
        raise conflict("INVITE_REVOKED", "Приглашение отозвано")
    if status == "expired":
        raise conflict("INVITE_EXPIRED", "Срок приглашения истёк")
    if status == "accepted" or (inv.max_uses is not None and inv.uses >= inv.max_uses):
        raise conflict("INVITE_ALREADY_USED", "Приглашение уже использовано")
    if not rules.can_receive(person):
        raise rules.invites_not_allowed()
    rules.check_consent(person, social=True)
    assert person is not None
    family_id: uuid.UUID | None = None
    if inv.kind == "family":
        if await fam.membership(session, me) is not None:
            raise conflict("FAMILY_ALREADY_MEMBER", "Вы уже состоите в семье")
        family_id = await fam.family_of_or_create(session, inv.inviter_user_id, now)
        await fam.lock_family(session, family_id)
        if await fam.size(session, family_id) >= settings.family_max_members:
            raise conflict("FAMILY_FULL", "В семье уже максимум участников",
                           {"limit": settings.family_max_members})
        await fam.add_member(session, family_id, me, rules.member_role(person), now, settings.service_name)
    else:
        if await _are_friends(session, inv.inviter_user_id, me):
            raise conflict("ALREADY_FRIENDS", "Вы уже друзья")
        if inv.kind == "referral" and await _referral_used(session, me, inv.invite_id):
            raise conflict("INVITE_ALREADY_USED", "Реферальное приглашение уже было принято раньше")
        # спринт 7: дружба через приглашение — с теми же запретами, что и заявка (блокировка, санкция, предел)
        if await friends.blocked_any(session, inv.inviter_user_id, me):
            raise blocked()
        await restrictions.require_not_banned(session, me, now)
        await friends.check_limits(session, inv.inviter_user_id, me, settings.friends_max)
        await friends.add_friendship(session, inv.inviter_user_id, me, now, source="invite", invite_id=inv.invite_id)
        await members.register(session, settings.member_key_bytes(), [inv.inviter_user_id, me])
    red.accepted_at = now
    inv.uses += 1
    if inv.max_uses is not None and inv.uses >= inv.max_uses:
        inv.status = "accepted"
    inv.updated_at = now
    await session.flush()
    await emit(session, ACCEPTED, {
        "invite_id": str(inv.invite_id), "inviter_user_id": str(inv.inviter_user_id), "invitee_user_id": str(me),
        "kind": inv.kind, "accepted_at": _iso(now),
    }, producer=settings.service_name)
    if inv.kind == "referral":  # спринт 7: реферал (§1.4) — в той же транзакции
        await referrals.create_from_invite(session, inv.inviter_user_id, me, inv.invite_id, now, red.opened_at,
                                           referrals.policy_of(settings))
    return inv, family_id


async def decline(session: AsyncSession, invite_id: uuid.UUID, me: uuid.UUID, *, now: datetime,
                  producer: str) -> Invite:
    """Отклонение открытого приглашения. Повтор и отклонение после принятия — без изменений. Событие — только по
    активному приглашению (пригласившему нечего сообщать про отозванное или истёкшее)."""
    inv = (await session.execute(
        select(Invite).where(Invite.invite_id == invite_id).with_for_update())).scalar_one_or_none()
    if inv is None:
        raise invite_not_found()
    if inv.inviter_user_id == me:
        raise conflict("INVITE_SELF", "Нельзя отклонить собственное приглашение")
    red = await redemption(session, invite_id, me, for_update=True)
    if red is None:
        raise invite_not_found()
    if red.accepted_at is not None or red.declined_at is not None:
        return inv
    red.declined_at = now
    await session.flush()
    if rules.effective_status(inv.status, inv.expires_at, now) == "active":
        await emit(session, DECLINED, {
            "invite_id": str(inv.invite_id), "inviter_user_id": str(inv.inviter_user_id), "invitee_user_id": str(me),
            "kind": inv.kind, "declined_at": _iso(now),
        }, producer=producer)
    return inv
