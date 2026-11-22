"""Жалобы, дела модерации, санкции и обжалования (§1.3, ADM-SOC-03, AT-79).

- Жалоба ученика создаёт дело: модератор видит только предмет жалобы (ник цели на момент жалобы, id заявки,
  приглашения, дуэли или комнаты и статус, если social его знает) и счётчики — без переписки. Повтор на ту же цель
  (цель + вид + предмет) за 24 ч — то же дело; не больше COMPLAINTS_PER_DAY в сутки.
- Решение (moderation.manage): dismiss | warning | social_ban (1..30 дней или бессрочно; > 7 и бессрочно — step-up) |
  nickname_reset; фиксирует основание, исполнителя и срок. Цели — social.sanction.changed.v1 (applied), жалобщику —
  social.case.resolved.v1 (без подробностей).
- Снятие санкции и обжалование (одно на санкцию; overturned снимает санкцию) — тоже события.
Каждая команда сотрудника — аудит admin.audit.recorded.v1 (без текстов учеников).
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, delete, func, or_, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict, not_found
from tilhero_common.internal_auth import Actor
from tilhero_social.domain import community, members
from tilhero_social.domain.common import (
    APPEAL_DECIDED,
    CASE_RESOLVED,
    SANCTION_CHANGED,
    emit_audit,
    emit_event,
    is_deleted,
    iso,
    staff_ref,
)
from tilhero_social.domain.restrictions import ban_active
from tilhero_social.models import (
    Appeal,
    Case,
    CommunityProfile,
    FriendRequest,
    Invite,
    InviteRedemption,
    NicknameStop,
    Sanction,
)


def case_not_found() -> ApiError:
    return not_found("CASE_NOT_FOUND", "Дело не найдено")


def sanction_not_found() -> ApiError:
    return not_found("SANCTION_NOT_FOUND", "Санкция не найдена")


def appeal_not_found() -> ApiError:
    return not_found("APPEAL_NOT_FOUND", "Обжалование не найдено")


def sanction_is_active(s: Sanction, now: datetime) -> bool:
    if s.kind == "social_ban":
        return ban_active(s, now)
    return s.revoked_at is None


# ---------------------------------------------------------------- жалобы (ученик)


async def recent_case(session: AsyncSession, reporter: uuid.UUID, target: uuid.UUID, subject_kind: str,
                      subject_id: uuid.UUID | None, now: datetime) -> Case | None:
    """Жалоба на ту же цель (цель + вид + предмет) за 24 ч — то же дело."""
    stmt = select(Case).where(Case.reporter_user_id == reporter, Case.target_user_id == target,
                              Case.subject_kind == subject_kind, Case.created_at > now - timedelta(hours=24))
    stmt = stmt.where(Case.subject_id.is_(None) if subject_id is None else Case.subject_id == subject_id)
    return (await session.execute(stmt.order_by(Case.created_at.desc()).limit(1))).scalar_one_or_none()


async def complaints_today(session: AsyncSession, reporter: uuid.UUID, now: datetime) -> int:
    return int((await session.execute(select(func.count()).select_from(Case).where(
        Case.reporter_user_id == reporter, Case.created_at > now - timedelta(hours=24)))).scalar_one())


async def subject_related(session: AsyncSession, kind: str, subject_id: uuid.UUID | None, reporter: uuid.UUID,
                          target: uuid.UUID) -> bool:
    """Предмет жалобы связан с жалобщиком и целью (нельзя пожаловаться на чужую заявку или приглашение):
    friend_request — заявка между ними; invite — приглашение Telegram цели, открытое жалобщиком, или жалобщика,
    открытое целью. Приглашение в парный урок (invite с room_id), дуэль и комната — объекты gamification и lessons:
    social их не видит и принимает id как есть (сверка — у модератора по карточке комнаты или дуэли)."""
    if subject_id is None or kind in ("user", "nickname", "duel", "pair_room"):
        return True
    if kind == "friend_request":
        req = await session.get(FriendRequest, subject_id)
        return req is not None and {req.from_user, req.to_user} == {reporter, target}
    invite = await session.get(Invite, subject_id)
    if invite is None:
        return True  # не приглашение social — приглашение в парный урок (room_id), см. выше
    for owner, guest in ((target, reporter), (reporter, target)):
        if invite.inviter_user_id == owner and (
                await session.get(InviteRedemption, (invite.invite_id, guest))) is not None:
            return True
    return False


async def create_case(session: AsyncSession, reporter: uuid.UUID, target: uuid.UUID, *, subject_kind: str,
                      subject_id: uuid.UUID | None, reason: str, comment: str | None, now: datetime) -> Case:
    profile = await community.get(session, target)
    case = Case(case_id=uuid.uuid4(), reporter_user_id=reporter, target_user_id=target, subject_kind=subject_kind,
                subject_id=subject_id, reason=reason, comment=comment,
                target_nickname_at_report=profile.nickname if profile is not None else None,
                status="open", created_at=now)
    session.add(case)
    await session.flush()
    return case


# ---------------------------------------------------------------- представления


def sanction_view(s: Sanction, appeal: Appeal | None, now: datetime) -> dict[str, Any]:
    """SanctionView (bff.ts) — кто решал, не показывается."""
    active = sanction_is_active(s, now)
    return {
        "sanction_id": str(s.sanction_id),
        "kind": s.kind,
        "basis": s.basis,
        "decided_at": iso(s.decided_at),
        "until": iso(s.until),
        "active": active,
        "revoked_at": iso(s.revoked_at),
        "appeal": None if appeal is None else {
            "appeal_id": str(appeal.appeal_id), "status": appeal.status, "text": appeal.text,
            "created_at": iso(appeal.created_at), "decided_at": iso(appeal.decided_at),
            "decision_note": appeal.decision_note},
        "can_appeal": appeal is None and s.revoked_at is None and (s.kind != "social_ban" or active),
    }


def admin_sanction(s: Sanction, appeal: Appeal | None, now: datetime) -> dict[str, Any]:
    return {
        "sanction_id": str(s.sanction_id), "user_id": str(s.user_id), "kind": s.kind, "until": iso(s.until),
        "active": sanction_is_active(s, now), "basis": s.basis,
        "case_id": str(s.case_id) if s.case_id else None,
        "decided_by": staff_ref(s.decided_by, s.decided_by_name), "decided_at": iso(s.decided_at),
        "revoked_at": iso(s.revoked_at), "revoked_by": staff_ref(s.revoked_by, s.revoked_by_name),
        "revoke_reason": s.revoke_reason,
        "appeal": None if appeal is None else {"appeal_id": str(appeal.appeal_id), "status": appeal.status},
    }


async def appeals_of(session: AsyncSession, sanction_ids: list[uuid.UUID]) -> dict[uuid.UUID, Appeal]:
    if not sanction_ids:
        return {}
    rows = (await session.execute(select(Appeal).where(Appeal.sanction_id.in_(sanction_ids)))).scalars().all()
    return {a.sanction_id: a for a in rows}


async def sanctions_of(session: AsyncSession, user_id: uuid.UUID) -> Sequence[Sanction]:
    return (await session.execute(select(Sanction).where(Sanction.user_id == user_id)
                                  .order_by(Sanction.decided_at.desc(), Sanction.sanction_id.desc()))
            ).scalars().all()


async def admin_sanctions_of(session: AsyncSession, user_id: uuid.UUID, now: datetime) -> list[dict[str, Any]]:
    rows = await sanctions_of(session, user_id)
    appeals = await appeals_of(session, [s.sanction_id for s in rows])
    return [admin_sanction(s, appeals.get(s.sanction_id), now) for s in rows]


async def _complaints_30d(session: AsyncSession, targets: list[uuid.UUID], now: datetime) -> dict[uuid.UUID, int]:
    if not targets:
        return {}
    rows = (await session.execute(select(Case.target_user_id, func.count()).where(
        Case.target_user_id.in_(targets), Case.created_at > now - timedelta(days=30)).group_by(Case.target_user_id)
    )).all()
    return {t: int(n) for t, n in rows if t is not None}


async def case_rows(session: AsyncSession, cases: Sequence[Case], now: datetime) -> list[dict[str, Any]]:
    """AdminCaseRow: текущий ник цели и жалоб на цель за 30 дней."""
    targets = [c.target_user_id for c in cases if c.target_user_id is not None]
    nicks = await community.nicknames_of(session, list(dict.fromkeys(targets)))
    counts = await _complaints_30d(session, list(dict.fromkeys(targets)), now)
    return [{
        "case_id": str(c.case_id), "status": c.status,
        "reporter_user_id": str(c.reporter_user_id) if c.reporter_user_id else None,
        "target_user_id": str(c.target_user_id) if c.target_user_id else None,
        "target_nickname": nicks.get(c.target_user_id) if c.target_user_id else None,
        "subject_kind": c.subject_kind, "subject_id": str(c.subject_id) if c.subject_id else None,
        "reason": c.reason,
        "target_complaints_30d": counts.get(c.target_user_id, 0) if c.target_user_id else 0,
        "created_at": iso(c.created_at), "resolved_at": iso(c.resolved_at),
    } for c in cases]


async def _subject_status(session: AsyncSession, c: Case) -> str | None:
    """Статус предмета, если social его знает: заявка в друзья или приглашение Telegram (дуэль и комната — карточки
    в «Лигах и дуэлях» и «Парных комнатах»)."""
    if c.subject_id is None:
        return None
    if c.subject_kind == "friend_request":
        req = await session.get(FriendRequest, c.subject_id)
        return req.status if req is not None else None
    if c.subject_kind == "invite":
        inv = await session.get(Invite, c.subject_id)
        return inv.status if inv is not None else None
    return None


async def case_full(session: AsyncSession, c: Case, now: datetime) -> dict[str, Any]:
    [row] = await case_rows(session, [c], now)
    resolution = None
    if c.resolution is not None:
        resolution = {"action": c.resolution, "sanction_id": str(c.sanction_id) if c.sanction_id else None,
                      "basis": c.resolution_basis or "",
                      "resolved_by": staff_ref(c.resolved_by, c.resolved_by_name)}
    return {**row, "comment": c.comment,
            "subject": {"nickname_at_report": c.target_nickname_at_report,
                        "status": await _subject_status(session, c)},
            "resolution": resolution,
            "target_sanctions": (await admin_sanctions_of(session, c.target_user_id, now)
                                 if c.target_user_id else [])}


# ---------------------------------------------------------------- админ: дела


async def list_cases(session: AsyncSession, status: str | None, limit: int,
                     after: tuple[datetime, uuid.UUID] | None) -> tuple[Sequence[Case], bool]:
    """open — старые сверху (очередь), остальные — новые сверху."""
    asc = status == "open"
    stmt = select(Case)
    if status is not None:
        stmt = stmt.where(Case.status == status)
    key = tuple_(Case.created_at, Case.case_id)
    if after is not None:
        stmt = stmt.where(key > tuple_(*after) if asc else key < tuple_(*after))
    order = (Case.created_at.asc(), Case.case_id.asc()) if asc else (Case.created_at.desc(), Case.case_id.desc())
    rows = (await session.execute(stmt.order_by(*order).limit(limit + 1))).scalars().all()
    return rows[:limit], len(rows) > limit


async def load_case(session: AsyncSession, case_id: uuid.UUID, *, for_update: bool = False) -> Case:
    stmt = select(Case).where(Case.case_id == case_id)
    if for_update:
        stmt = stmt.with_for_update()
    c = (await session.execute(stmt.execution_options(populate_existing=True))).scalar_one_or_none()
    if c is None:
        raise case_not_found()
    return c


async def apply_sanction(session: AsyncSession, actor: Actor, user_id: uuid.UUID, kind: str, until: datetime | None,
                         basis: str, case_id: uuid.UUID | None, now: datetime) -> Sanction:
    s = Sanction(sanction_id=uuid.uuid4(), user_id=user_id, kind=kind, until=until, basis=basis, case_id=case_id,
                 decided_by=actor.id[:64], decided_by_name=(actor.name or "")[:120], decided_at=now)
    session.add(s)
    await session.flush()
    await emit_event(session, SANCTION_CHANGED, {
        "user_id": str(user_id), "sanction_id": str(s.sanction_id), "kind": kind, "until": iso(until),
        "active": kind != "social_ban" or until is None or until > now, "change": "applied", "changed_at": iso(now)})
    return s


async def resolve_case(session: AsyncSession, actor: Actor, c: Case, *, action: str, days: int | None, basis: str,
                       now: datetime, member_key: bytes) -> Case:
    """Только open (иначе 409 CASE_STATE {status}). Санкция — цели дела (обезличенная цель — только dismiss)."""
    if c.status != "open":
        raise conflict("CASE_STATE", "Дело уже закрыто", {"status": c.status})
    sanction: Sanction | None = None
    if action != "dismiss":
        if c.target_user_id is None or await is_deleted(session, c.target_user_id):
            raise conflict("CASE_STATE", "Ученик удалён — дело можно только закрыть", {"status": c.status})
        until = now + timedelta(days=days) if action == "social_ban" and days is not None else None
        sanction = await apply_sanction(session, actor, c.target_user_id, action, until, basis, c.case_id, now)
        if action == "nickname_reset":
            profile = await community.get(session, c.target_user_id, for_update=True)
            if profile is not None:
                [mid] = (await members.register(session, member_key, [c.target_user_id])).values()
                await community.reset_nickname(session, profile, mid, now, sanction.sanction_id)
    c.status = "dismissed" if action == "dismiss" else "resolved"
    c.resolution, c.resolution_basis = action, basis
    c.sanction_id = sanction.sanction_id if sanction else None
    c.resolved_by, c.resolved_by_name, c.resolved_at = actor.id[:64], (actor.name or "")[:120], now
    await session.flush()
    if c.reporter_user_id is not None:
        await emit_event(session, CASE_RESOLVED, {
            "case_id": str(c.case_id), "reporter_user_id": str(c.reporter_user_id),
            "outcome": "dismissed" if action == "dismiss" else "action_taken", "resolved_at": iso(now)})
    await emit_audit(session, actor, "social.case.resolved", "moderation_case", str(c.case_id),
                     before={"status": "open"},
                     after={"status": c.status, "action": action, "days": days,
                            "sanction_id": str(sanction.sanction_id) if sanction else None,
                            "target_user_id": str(c.target_user_id) if c.target_user_id else None},
                     reason=basis)
    return c


# ---------------------------------------------------------------- админ: санкции и обжалования


async def list_sanctions(session: AsyncSession, user_id: uuid.UUID | None, active: bool | None, now: datetime,
                         limit: int, after: tuple[datetime, uuid.UUID] | None) -> tuple[Sequence[Sanction], bool]:
    stmt = select(Sanction)
    if user_id is not None:
        stmt = stmt.where(Sanction.user_id == user_id)
    if active is not None:
        live = and_(Sanction.revoked_at.is_(None), or_(
            Sanction.kind != "social_ban",
            and_(Sanction.expired_at.is_(None), or_(Sanction.until.is_(None), Sanction.until > now))))
        stmt = stmt.where(live if active else ~live)
    if after is not None:
        stmt = stmt.where(tuple_(Sanction.decided_at, Sanction.sanction_id) < tuple_(*after))
    rows = (await session.execute(stmt.order_by(Sanction.decided_at.desc(), Sanction.sanction_id.desc())
                                  .limit(limit + 1))).scalars().all()
    return rows[:limit], len(rows) > limit


async def load_sanction(session: AsyncSession, sanction_id: uuid.UUID, *, user_id: uuid.UUID | None = None,
                        for_update: bool = False) -> Sanction:
    stmt = select(Sanction).where(Sanction.sanction_id == sanction_id)
    if user_id is not None:
        stmt = stmt.where(Sanction.user_id == user_id)
    if for_update:
        stmt = stmt.with_for_update()
    s = (await session.execute(stmt.execution_options(populate_existing=True))).scalar_one_or_none()
    if s is None:
        raise sanction_not_found()
    return s


async def _lift(session: AsyncSession, s: Sanction, actor: Actor, reason: str, change: str, now: datetime) -> None:
    s.revoked_at, s.revoked_by, s.revoked_by_name, s.revoke_reason = now, actor.id[:64], (actor.name or "")[:120], \
        reason[:500]
    await session.flush()
    if s.kind == "nickname_reset":
        # снятие сброса ника (отмена, обжалование): ник — со стоп-листа, ограничение смены после сброса снимается
        await session.execute(delete(NicknameStop).where(NicknameStop.sanction_id == s.sanction_id))
        await session.execute(update(CommunityProfile).where(
            CommunityProfile.user_id == s.user_id, CommunityProfile.nickname.is_(None),
        ).values(nickname_reset_at=None, updated_at=now))
    await emit_event(session, SANCTION_CHANGED, {
        "user_id": str(s.user_id), "sanction_id": str(s.sanction_id), "kind": s.kind, "until": iso(s.until),
        "active": False, "change": change, "changed_at": iso(now)})


async def revoke(session: AsyncSession, actor: Actor, s: Sanction, reason: str, now: datetime) -> Sanction:
    """Уже снята — 409 SANCTION_STATE."""
    if s.revoked_at is not None:
        raise conflict("SANCTION_STATE", "Санкция уже снята", {"status": "revoked"})
    await _lift(session, s, actor, reason, "revoked", now)
    await emit_audit(session, actor, "social.sanction.revoked", "sanction", str(s.sanction_id),
                     before={"active": True, "kind": s.kind, "until": iso(s.until)}, after={"active": False},
                     reason=reason)
    return s


async def create_appeal(session: AsyncSession, me: uuid.UUID, sanction_id: uuid.UUID, text: str, key: str,
                        now: datetime) -> tuple[Sanction, Appeal, bool]:
    """→ (санкция, обжалование, created). Тот же Idempotency-Key — повтор (created=False); другое обжалование уже
    есть — 409 APPEAL_EXISTS; снятая или истёкшая санкция — 409 SANCTION_STATE."""
    s = await load_sanction(session, sanction_id, user_id=me, for_update=True)
    existing = (await session.execute(select(Appeal).where(Appeal.sanction_id == s.sanction_id))).scalar_one_or_none()
    if existing is not None:
        if existing.idempotency_key == key:
            return s, existing, False
        raise conflict("APPEAL_EXISTS", "Санкцию можно обжаловать один раз")
    if s.revoked_at is not None or not sanction_is_active(s, now):
        raise conflict("SANCTION_STATE", "Санкция уже не действует",
                       {"status": "revoked" if s.revoked_at is not None else "expired"})
    appeal = Appeal(appeal_id=uuid.uuid4(), sanction_id=s.sanction_id, user_id=me, text=text, status="open",
                    idempotency_key=key, created_at=now)
    session.add(appeal)
    await session.flush()
    return s, appeal, True


async def list_appeals(session: AsyncSession, status: str | None, limit: int,
                       after: tuple[datetime, uuid.UUID] | None) -> tuple[Sequence[Appeal], bool]:
    asc = status == "open"
    stmt = select(Appeal)
    if status is not None:
        stmt = stmt.where(Appeal.status == status)
    key = tuple_(Appeal.created_at, Appeal.appeal_id)
    if after is not None:
        stmt = stmt.where(key > tuple_(*after) if asc else key < tuple_(*after))
    order = (Appeal.created_at.asc(), Appeal.appeal_id.asc()) if asc else (Appeal.created_at.desc(),
                                                                            Appeal.appeal_id.desc())
    rows = (await session.execute(stmt.order_by(*order).limit(limit + 1))).scalars().all()
    return rows[:limit], len(rows) > limit


async def appeal_view(session: AsyncSession, a: Appeal, now: datetime) -> dict[str, Any]:
    s = await session.get(Sanction, a.sanction_id)
    assert s is not None
    return {"appeal_id": str(a.appeal_id), "sanction": admin_sanction(s, a, now), "text": a.text,
            "status": a.status, "created_at": iso(a.created_at),
            "decided_by": staff_ref(a.decided_by, a.decided_by_name), "decided_at": iso(a.decided_at),
            "decision_note": a.decision_note}


async def load_appeal(session: AsyncSession, appeal_id: uuid.UUID, *, for_update: bool = False) -> Appeal:
    stmt = select(Appeal).where(Appeal.appeal_id == appeal_id)
    if for_update:
        stmt = stmt.with_for_update()
    a = (await session.execute(stmt.execution_options(populate_existing=True))).scalar_one_or_none()
    if a is None:
        raise appeal_not_found()
    return a


async def decide_appeal(session: AsyncSession, actor: Actor, a: Appeal, decision: str, note: str,
                        now: datetime) -> Appeal:
    """Уже решено — 409 APPEAL_STATE {status}; overturned снимает санкцию (sanction.changed overturned)."""
    if a.status != "open":
        raise conflict("APPEAL_STATE", "Обжалование уже рассмотрено", {"status": a.status})
    s = await load_sanction(session, a.sanction_id, for_update=True)
    a.status, a.decided_by, a.decided_by_name = decision, actor.id[:64], (actor.name or "")[:120]
    a.decided_at, a.decision_note = now, note
    await session.flush()
    if decision == "overturned" and s.revoked_at is None:
        await _lift(session, s, actor, note, "overturned", now)
    await emit_event(session, APPEAL_DECIDED, {
        "appeal_id": str(a.appeal_id), "sanction_id": str(s.sanction_id), "user_id": str(a.user_id),
        "decision": decision, "decided_at": iso(now)})
    await emit_audit(session, actor, "social.appeal.decided", "sanction_appeal", str(a.appeal_id),
                     before={"status": "open"}, after={"status": decision, "sanction_id": str(s.sanction_id)},
                     reason=note)
    return a
