"""Рефералы (§1.4, APP-REF-01…04, ADM-REF-02; скилл `referral_integrity_reviewer` — правила, не LLM).

Строка — из принятого приглашения kind referral (в транзакции принятия). Источники прогресса:
- `diagnostics.completed.v1` (только diagnostics) → `diagnostic_at` (первая диагностика; пройденная до принятия
  приглашения тоже засчитывается — онбординг);
- `lesson.session.completed.v1` (только lessons; `kind lesson`, `status completed`, `practice_only false`; duel и
  pair — не уроки) → `referral_lessons`: одна запись на session_id (повтор события не считается), урок — по
  lesson_id (повтор того же урока не считается вторым), местный день — `local_date` события или день Ташкента по
  `finished_at`. Засчитываются уроки в окне [принятие, принятие + window_days].

Квалификация (по времени события): условия — диагностика (если требуется), ≥ min_lessons разных уроков, ≥ min_days
разных дней. Семья пригласившего — `rejected family_member` (семья — не реферал; проверяется при каждом шаге).
Риски → `review` (+ social.referral.held.v1; флаги — только админке): velocity — у пригласившего уже
velocity_per_day квалификаций за сутки; short_lessons — больше половины уроков короче min_lesson_minutes;
activity_before_accept — уроки приглашённого раньше принятия. Иначе — qualified → лимит месяца пригласившего
(календарный месяц Ташкента по времени квалификации): `capped` (social.referral.rejected.v1 monthly_cap) или
social.referral.qualified.v1 → ack gamification game.referral.rewarded.v1 → `rewarded`. Окно истекло — tick →
`expired` (window_expired). Недостаток данных — не мошенничество: без условий статус просто не продвигается.

Конкурентность: изменения реферала — под advisory-блокировкой приглашённого и пригласившего (лимиты месяца и
скорости пригласившего сериализуются) и FOR UPDATE строки; «удалён?» — после блокировки.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Final
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, or_, select, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict, not_found
from tilhero_common.internal_auth import Actor
from tilhero_social.domain import campaigns, community
from tilhero_social.domain import family as fam
from tilhero_social.domain.common import (
    REFERRAL_HELD,
    REFERRAL_QUALIFIED,
    REFERRAL_REJECTED,
    emit_audit,
    emit_event,
    event_time,
    is_deleted,
    iso,
    local_date,
    month_bounds,
    staff_ref,
    zone,
)
from tilhero_social.domain.friends import same_family
from tilhero_social.models import LearnerActivity, Referral, ReferralCampaign, ReferralLesson
from tilhero_social.settings import Settings

ACTIVE: Final = ("invited", "diagnostic_done", "learning")
RECORDING: Final = (*ACTIVE, "review")  # уроки ещё пишутся (видны оператору)
REWARDING: Final = ("qualified", "rewarded")  # идут в лимит месяца (кроме наград по правилу спринта 6)
REWARD_OUTCOMES: Final = ("rewarded", "legacy", "inviter_capped")
QUALIFIED_ANY: Final = ("qualified", "rewarded", "capped")  # квалификации для порога скорости


def _counts_to_cap() -> Any:
    """Квалификация занимает место в лимите месяца: qualified/rewarded, кроме наград по правилу спринта 6."""
    return and_(Referral.status.in_(REWARDING),
                or_(Referral.reward_outcome.is_(None), Referral.reward_outcome != "legacy"))


def referral_not_found() -> ApiError:
    return not_found("REFERRAL_NOT_FOUND", "Реферал не найден")


@dataclass(frozen=True)
class Policy:
    """Параметры правил из настроек: пояс календарного месяца и дня, порог «не новый ученик»."""

    tz: ZoneInfo
    new_user_grace: timedelta = timedelta(hours=48)


def policy_of(settings: Settings) -> Policy:
    return Policy(tz=zone(settings.social_timezone), new_user_grace=timedelta(hours=settings.referral_new_user_hours))


def window_start(r: Referral) -> datetime:
    """Начало окна условий: принятие; перенесённый из спринта 6 — момент выкладки (window_from)."""
    return r.window_from or r.accepted_at


def window_end(r: Referral, payload: dict[str, Any]) -> datetime:
    return window_start(r) + timedelta(days=int(payload["window_days"]))


@dataclass(frozen=True)
class Progress:
    lessons: int  # разных уроков
    days: int  # разных местных дней
    minutes: int
    rows: int  # записей (сессий)
    short: int  # записей короче порога


async def progress(session: AsyncSession, referral_id: uuid.UUID, min_minutes: int = 0) -> Progress:
    rows = (await session.execute(select(ReferralLesson.lesson_key, ReferralLesson.local_date,
                                         ReferralLesson.minutes)
                                  .where(ReferralLesson.referral_id == referral_id))).all()
    return Progress(lessons=len({k for k, _, _ in rows}), days=len({d for _, d, _ in rows}),
                    minutes=sum(int(m) for _, _, m in rows), rows=len(rows),
                    short=sum(1 for _, _, m in rows if int(m) < min_minutes))


async def _activity(session: AsyncSession, user_id: uuid.UUID) -> LearnerActivity | None:
    return await session.get(LearnerActivity, user_id, populate_existing=True)


async def upsert_activity(session: AsyncSession, user_id: uuid.UUID, now: datetime, *,
                          seen_at: datetime | None = None, lesson_at: datetime | None = None,
                          diagnostic_at: datetime | None = None) -> None:
    """Первая (самая ранняя) регистрация и активность: события могут прийти не по порядку. Вызывать под блокировкой
    ученика после проверки «удалён?»."""
    stmt = insert(LearnerActivity).values(user_id=user_id, first_seen_at=seen_at, first_lesson_at=lesson_at,
                                          diagnostic_at=diagnostic_at, updated_at=now)
    ex = stmt.excluded
    await session.execute(stmt.on_conflict_do_update(index_elements=["user_id"], set_={
        "first_seen_at": func.least(LearnerActivity.first_seen_at, ex.first_seen_at),
        "first_lesson_at": func.least(LearnerActivity.first_lesson_at, ex.first_lesson_at),
        "diagnostic_at": func.least(LearnerActivity.diagnostic_at, ex.diagnostic_at),
        "updated_at": now,
    }))


# ---------------------------------------------------------------- события


async def _emit_rejected(session: AsyncSession, r: Referral, at: datetime) -> None:
    if r.inviter_user_id is None or r.reject_code is None:
        return
    if r.legacy and r.reject_code == "window_expired":
        return  # перенесённый из спринта 6 закрывается тихо (решение оркестратора)
    await emit_event(session, REFERRAL_REJECTED, {"referral_id": str(r.referral_id),
                                                  "inviter_user_id": str(r.inviter_user_id),
                                                  "reject_code": r.reject_code, "rejected_at": iso(at)})


async def _reject(session: AsyncSession, r: Referral, code: str, at: datetime, now: datetime,
                  flags: list[str] | None = None) -> None:
    r.status, r.reject_code, r.updated_at = "rejected", code, now
    if flags:
        r.risk_flags = sorted(set(r.risk_flags or []) | set(flags))
    await session.flush()
    await _emit_rejected(session, r, at)


async def qualify(session: AsyncSession, r: Referral, payload: dict[str, Any], at: datetime, now: datetime,
                  tz: ZoneInfo) -> None:
    """qualified → лимит месяца пригласившего (календарный месяц Ташкента по времени квалификации)."""
    r.qualified_at, r.updated_at = at, now
    start, end = month_bounds(at, tz)
    taken = int((await session.execute(select(func.count()).select_from(Referral).where(
        Referral.inviter_user_id == r.inviter_user_id, Referral.referral_id != r.referral_id,
        _counts_to_cap(), Referral.qualified_at >= start, Referral.qualified_at < end))).scalar_one())
    if taken >= int(payload["monthly_cap"]):
        r.status, r.reject_code = "capped", "monthly_cap"
        await session.flush()
        await _emit_rejected(session, r, at)
        return
    r.status, r.reject_code = "qualified", None
    await session.flush()
    assert r.inviter_user_id is not None and r.invitee_user_id is not None
    await emit_event(session, REFERRAL_QUALIFIED, {
        "referral_id": str(r.referral_id), "inviter_user_id": str(r.inviter_user_id),
        "invitee_user_id": str(r.invitee_user_id), "campaign_version": r.campaign_version,
        "inviter_reward": dict(payload["inviter_reward"]), "invitee_reward": dict(payload["invitee_reward"]),
        # лимит кампании, по которой квалифицирован (ревью Н3: gamification считает лимит по нему)
        "inviter_monthly_cap": int(payload["monthly_cap"]),
        "qualified_at": iso(at)})


async def _not_new_user(session: AsyncSession, r: Referral, policy: Policy) -> bool:
    """Приглашённый зарегистрирован раньше чем за new_user_grace до первого открытия приглашения. Регистрация —
    learner_activity.first_seen_at (user.profile.created.v1 created_at; до спринта 7 — самый ранний след в social).
    Нет данных — не отклоняем (недостаток данных — не мошенничество). Перенесённым из спринта 6 не применяется."""
    if r.legacy or r.invitee_user_id is None:
        return False
    act = await _activity(session, r.invitee_user_id)
    seen = act.first_seen_at if act is not None else None
    opened = r.opened_at or r.accepted_at
    return seen is not None and seen < opened - policy.new_user_grace


async def assess(session: AsyncSession, r: Referral, at: datetime, now: datetime, policy: Policy, *,
                 operator: bool = False) -> None:
    """Правила (скилл referral_integrity_reviewer): автоматические отказы (не новый ученик, семья) → условия кампании
    → риски → квалификация и лимит месяца. operator=True — одобрение оператора: риски сняты решением, но
    автоматические отказы и условия кампании действуют (статус не продвигается, если условия не выполнены)."""
    assert r.inviter_user_id is not None and r.invitee_user_id is not None
    if await _not_new_user(session, r, policy):
        await _reject(session, r, "not_new_user", at, now)
        return
    if await same_family(session, r.inviter_user_id, r.invitee_user_id):
        await _reject(session, r, "family_member", at, now, ["family_member"])
        return
    payload = await campaigns.payload_of(session, r.campaign_version)
    review = payload["review"]
    prog = await progress(session, r.referral_id, int(review["min_lesson_minutes"]))
    diagnostic_ok = not payload["require_diagnostic"] or r.diagnostic_at is not None
    if not (diagnostic_ok and prog.lessons >= int(payload["min_lessons"]) and prog.days >= int(payload["min_days"])):
        if operator:
            return
        status = "learning" if prog.rows else ("diagnostic_done" if r.diagnostic_at is not None else "invited")
        if status != r.status:
            r.status, r.updated_at = status, now
            await session.flush()
        return
    if not operator:
        flags: list[str] = []
        recent = int((await session.execute(select(func.count()).select_from(Referral).where(
            Referral.inviter_user_id == r.inviter_user_id, Referral.referral_id != r.referral_id,
            Referral.status.in_(QUALIFIED_ANY), Referral.qualified_at > at - timedelta(hours=24),
            Referral.qualified_at <= at))).scalar_one())
        if recent >= int(review["velocity_per_day"]):
            flags.append("velocity")
        if prog.short * 2 > prog.rows:
            flags.append("short_lessons")
        act = await _activity(session, r.invitee_user_id)
        if (not r.legacy and act is not None and act.first_lesson_at is not None
                and act.first_lesson_at < r.accepted_at):
            flags.append("activity_before_accept")
        if flags:
            r.status, r.risk_flags, r.updated_at = "review", sorted(set(r.risk_flags or []) | set(flags)), now
            await session.flush()
            await emit_event(session, REFERRAL_HELD, {"referral_id": str(r.referral_id), "held_at": iso(at)})
            return
    await qualify(session, r, payload, at, now, policy.tz)


async def evaluate(session: AsyncSession, r: Referral, at: datetime, now: datetime, policy: Policy) -> None:
    """Шаг правил после любого факта (принятие, регистрация, диагностика, урок). Только для статусов в работе и
    необезличенных."""
    if r.status not in ACTIVE or r.inviter_user_id is None or r.invitee_user_id is None:
        return
    await assess(session, r, at, now, policy)


async def _locked(session: AsyncSession, invitee: uuid.UUID) -> Referral | None:
    """Реферал приглашённого под блокировкой обоих учеников (порядок uuid) и FOR UPDATE строки."""
    inviter = (await session.execute(select(Referral.inviter_user_id).where(Referral.invitee_user_id == invitee))
               ).scalar_one_or_none()
    await fam.lock_users(session, [invitee] + ([inviter] if inviter is not None else []))
    return (await session.execute(select(Referral).where(Referral.invitee_user_id == invitee).with_for_update()
                                  .execution_options(populate_existing=True))).scalar_one_or_none()


async def create_from_invite(session: AsyncSession, inviter: uuid.UUID, invitee: uuid.UUID, invite_id: uuid.UUID,
                             accepted_at: datetime, opened_at: datetime | None, policy: Policy) -> Referral | None:
    """Принято приглашение kind referral (транзакция принятия, оба ученика уже заблокированы). Один реферал на
    приглашённого за всё время. Диагностика, пройденная до принятия, засчитывается; зарегистрированный раньше чем за
    new_user_grace до открытия приглашения — `rejected not_new_user`."""
    if (await session.execute(select(Referral.referral_id).where(Referral.invitee_user_id == invitee))
            ).scalar_one_or_none() is not None:
        return None
    campaign = await campaigns.active(session)
    act = await _activity(session, invitee)
    r = Referral(referral_id=uuid.uuid4(), inviter_user_id=inviter, invitee_user_id=invitee, invite_id=invite_id,
                 campaign_version=campaign.version, accepted_at=accepted_at, status="invited", risk_flags=[],
                 decision_history=[], opened_at=opened_at, legacy=False, created_at=accepted_at,
                 updated_at=accepted_at)
    if act is not None and act.diagnostic_at is not None and act.diagnostic_at <= window_end(r, campaign.payload):
        r.diagnostic_at = act.diagnostic_at
    session.add(r)
    await session.flush()
    await evaluate(session, r, accepted_at, accepted_at, policy)
    return r


async def on_diagnostic(session: AsyncSession, payload: dict[str, Any], now: datetime, policy: Policy) -> None:
    user = uuid.UUID(str(payload["user_id"]))
    at = event_time(payload.get("completed_at"), now)
    r = await _locked(session, user)
    if await is_deleted(session, user):
        return
    await upsert_activity(session, user, now, diagnostic_at=at)
    if r is None or r.status not in ACTIVE or r.diagnostic_at is not None:
        return
    if at > window_end(r, await campaigns.payload_of(session, r.campaign_version)):
        return
    r.diagnostic_at, r.updated_at = at, now
    await session.flush()
    await evaluate(session, r, at, now, policy)


def _lesson_date(payload: dict[str, Any], finished: datetime, tz: ZoneInfo) -> date:
    raw = payload.get("local_date")
    if isinstance(raw, str):
        try:
            return date.fromisoformat(raw)
        except ValueError:
            pass
    return local_date(finished, tz)


async def on_lesson(session: AsyncSession, payload: dict[str, Any], now: datetime, policy: Policy) -> None:
    """Зачётный урок: kind lesson, status completed; practice_only — только проекция активности."""
    if payload.get("kind") != "lesson" or payload.get("status") != "completed":
        return
    user = uuid.UUID(str(payload["user_id"]))
    finished = event_time(payload.get("finished_at"), now)
    r = await _locked(session, user)
    if await is_deleted(session, user):
        return
    await upsert_activity(session, user, now, lesson_at=finished)
    if payload.get("practice_only") is not False or r is None or r.status not in RECORDING:
        return
    camp = await campaigns.payload_of(session, r.campaign_version)
    if finished < window_start(r) or finished > window_end(r, camp):
        return
    session_id = uuid.UUID(str(payload["session_id"]))
    lesson_key = str(payload.get("lesson_id") or session_id)[:200]
    inserted = await session.execute(insert(ReferralLesson).values(
        session_id=session_id, referral_id=r.referral_id, lesson_key=lesson_key,
        local_date=_lesson_date(payload, finished, policy.tz), minutes=max(0, int(payload.get("minutes") or 0)),
        finished_at=finished).on_conflict_do_nothing().returning(ReferralLesson.session_id))
    if inserted.first() is None:
        return  # та же сессия — одна запись
    await evaluate(session, r, finished, now, policy)


async def on_rewarded(session: AsyncSession, payload: dict[str, Any], now: datetime) -> None:
    """ack gamification (game.referral.rewarded.v1; outcome — нет поля = rewarded). Закрывает реферал из qualified;
    перенесённый из спринта 6 — из любого незавершённого статуса (в т. ч. expired). Повтор — без изменений.
    - rewarded — награда кампании выдана → rewarded;
    - legacy — награда выдана раньше по правилу спринта 6 → rewarded без повторного «вы получили» (reward null) и вне
      лимита месяца;
    - inviter_capped — пригласивший не получил награду из-за месячного лимита gamification → capped (monthly_cap,
      social.referral.rejected.v1: поправка к уже ушедшему referral_qualified)."""
    r = (await session.execute(select(Referral).where(Referral.referral_id == uuid.UUID(str(payload["referral_id"])))
                               .with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
    if r is None:
        return
    legacy_open = r.legacy and r.status in (*RECORDING, "qualified", "expired")
    if r.status != "qualified" and not legacy_open:
        return
    outcome = payload.get("outcome") or "rewarded"
    if outcome not in REWARD_OUTCOMES:
        outcome = "rewarded"
    at = event_time(payload.get("rewarded_at"), now)
    r.reward_outcome, r.updated_at = outcome, now
    if outcome == "inviter_capped":
        r.status, r.reject_code = "capped", "monthly_cap"
        await session.flush()
        await _emit_rejected(session, r, at)
        return
    r.status, r.reject_code, r.rewarded_at = "rewarded", None, at
    await session.flush()


# ---------------------------------------------------------------- tick


async def expire_due(session: AsyncSession, now: datetime, limit: int) -> int:
    """Окно истекло → expired (window_expired; перенесённый из спринта 6 — без уведомления). Окно — от принятия или,
    для перенесённых, от выкладки. Обезличенные сагой не трогаются (статус сохраняется)."""
    window = func.make_interval(0, 0, 0, ReferralCampaign.payload["window_days"].as_integer())
    rows = (await session.execute(
        select(Referral, ReferralCampaign.payload)
        .join(ReferralCampaign, ReferralCampaign.version == Referral.campaign_version)
        .where(Referral.status.in_(ACTIVE), Referral.inviter_user_id.is_not(None),
               Referral.invitee_user_id.is_not(None),
               func.coalesce(Referral.window_from, Referral.accepted_at) + window <= now)
        .order_by(Referral.accepted_at).limit(limit).with_for_update(of=Referral, skip_locked=True)
        .execution_options(populate_existing=True))).all()
    for r, payload in rows:
        r.status, r.reject_code, r.updated_at = "expired", "window_expired", now
        await session.flush()
        await _emit_rejected(session, r, window_end(r, payload))
    return len(rows)


# ---------------------------------------------------------------- ученик


async def my_page(session: AsyncSession, me: uuid.UUID, limit: int,
                  after: tuple[datetime, uuid.UUID] | None) -> tuple[Sequence[Referral], bool]:
    stmt = select(Referral).where(Referral.inviter_user_id == me)
    if after is not None:
        stmt = stmt.where(tuple_(Referral.accepted_at, Referral.referral_id) < tuple_(*after))
    rows = (await session.execute(stmt.order_by(Referral.accepted_at.desc(), Referral.referral_id.desc())
                                  .limit(limit + 1))).scalars().all()
    return rows[:limit], len(rows) > limit


async def learner_view(session: AsyncSession, r: Referral) -> dict[str, Any]:
    """ReferralView (bff.ts): без флагов риска и правил антифрода; причина отказа — публичный код."""
    payload = await campaigns.payload_of(session, r.campaign_version)
    prog = await progress(session, r.referral_id)
    nick = None
    if r.invitee_user_id is not None:
        nick = (await community.nicknames_of(session, [r.invitee_user_id]))[r.invitee_user_id]
    return {
        "referral_id": str(r.referral_id),
        "invitee_nickname": nick,
        "status": r.status,
        "progress": {
            "diagnostic": r.diagnostic_at is not None,
            "diagnostic_required": bool(payload["require_diagnostic"]),
            "lessons": prog.lessons, "lessons_required": int(payload["min_lessons"]),
            "days": prog.days, "days_required": int(payload["min_days"]),
            "window_ends_at": iso(window_end(r, payload)),
        },
        # награда кампании: начисляется (qualified) или начислена (rewarded); по правилу спринта 6 — null (без
        # повторного «вы получили»), исход — reward_outcome
        "reward": (dict(payload["inviter_reward"])
                   if r.status == "qualified" or (r.status == "rewarded" and r.reward_outcome != "legacy") else None),
        "reward_outcome": r.reward_outcome,
        # перенесённый из спринта 6 и тихо истёкший — без причины «окно истекло» (ревью Н6): Mini App показывает
        # «Приглашение по прежней программе» по legacy
        "reject_code": None if r.legacy and r.reject_code == "window_expired" else r.reject_code,
        "legacy": bool(r.legacy),
        "accepted_at": iso(r.accepted_at),
    }


def terms(c: ReferralCampaign) -> dict[str, Any]:
    p = c.payload
    return {"campaign_version": c.version, "require_diagnostic": bool(p["require_diagnostic"]),
            "min_lessons": int(p["min_lessons"]), "min_days": int(p["min_days"]),
            "window_days": int(p["window_days"]), "inviter_reward": dict(p["inviter_reward"]),
            "invitee_reward": dict(p["invitee_reward"]), "monthly_cap": int(p["monthly_cap"])}


async def month_count(session: AsyncSession, inviter: uuid.UUID, at: datetime, tz: ZoneInfo) -> int:
    start, end = month_bounds(at, tz)
    return int((await session.execute(select(func.count()).select_from(Referral).where(
        Referral.inviter_user_id == inviter, _counts_to_cap(), Referral.qualified_at >= start,
        Referral.qualified_at < end))).scalar_one())


# ---------------------------------------------------------------- админка


async def admin_row(session: AsyncSession, r: Referral) -> dict[str, Any]:
    prog = await progress(session, r.referral_id)
    return {
        "referral_id": str(r.referral_id),
        "inviter_user_id": str(r.inviter_user_id) if r.inviter_user_id else None,
        "invitee_user_id": str(r.invitee_user_id) if r.invitee_user_id else None,
        "campaign_version": r.campaign_version, "status": r.status, "accepted_at": iso(r.accepted_at),
        "diagnostic_at": iso(r.diagnostic_at), "lessons": prog.lessons, "days": prog.days,
        "minutes_total": prog.minutes, "risk_flags": list(r.risk_flags or []), "reject_code": r.reject_code,
        "reward_outcome": r.reward_outcome,
        "qualified_at": iso(r.qualified_at), "decided_by": staff_ref(r.decided_by, r.decided_by_name),
        "decided_at": iso(r.decided_at),
    }


def can_redecide(r: Referral) -> bool:
    """Пересмотр — один раз и только решения оператора: rejected оператором → одобрить (после одобрения отклонить
    нельзя). Автоматические отказы правил (не новый ученик, семья) не пересматриваются."""
    history = list(r.decision_history or [])
    return (r.status == "rejected" and r.inviter_user_id is not None and r.invitee_user_id is not None
            and bool(history) and history[-1].get("decision") == "rejected"
            and not any(h.get("decision") == "approved" for h in history))


async def admin_full(session: AsyncSession, r: Referral, tz: ZoneInfo) -> dict[str, Any]:
    log = (await session.execute(select(ReferralLesson.local_date, ReferralLesson.minutes)
                                 .where(ReferralLesson.referral_id == r.referral_id)
                                 .order_by(ReferralLesson.finished_at, ReferralLesson.session_id))).all()
    payload = await campaigns.payload_of(session, r.campaign_version)
    month = await month_count(session, r.inviter_user_id, r.accepted_at, tz) if r.inviter_user_id else 0
    return {**await admin_row(session, r),
            "lessons_log": [{"local_date": d.isoformat(), "minutes": int(m)} for d, m in log],
            "inviter_month": {"qualified": month, "cap": int(payload["monthly_cap"])},
            "decision_history": list(r.decision_history or []),
            "can_redecide": can_redecide(r)}


async def admin_page(session: AsyncSession, status: str | None, limit: int,
                     after: tuple[datetime, uuid.UUID] | None) -> tuple[Sequence[Referral], bool]:
    """review — старые сверху (очередь), иначе — новые сверху."""
    asc = status == "review"
    stmt = select(Referral)
    if status is not None:
        stmt = stmt.where(Referral.status == status)
    key = tuple_(Referral.accepted_at, Referral.referral_id)
    if after is not None:
        stmt = stmt.where(key > tuple_(*after) if asc else key < tuple_(*after))
    order = ((Referral.accepted_at.asc(), Referral.referral_id.asc()) if asc
             else (Referral.accepted_at.desc(), Referral.referral_id.desc()))
    rows = (await session.execute(stmt.order_by(*order).limit(limit + 1))).scalars().all()
    return rows[:limit], len(rows) > limit


async def load_locked(session: AsyncSession, referral_id: uuid.UUID) -> Referral:
    """Реферал для команды оператора: блокировка обоих учеников (лимит месяца пригласившего) и FOR UPDATE."""
    found = (await session.execute(select(Referral.inviter_user_id, Referral.invitee_user_id)
                                   .where(Referral.referral_id == referral_id))).one_or_none()
    if found is None:
        raise referral_not_found()
    await fam.lock_users(session, [u for u in found if u is not None])
    r = (await session.execute(select(Referral).where(Referral.referral_id == referral_id).with_for_update()
                               .execution_options(populate_existing=True))).scalar_one()
    return r


def _decision(r: Referral, actor: Actor, decision: str, code: str | None, note: str, now: datetime) -> None:
    r.decision_history = [*(r.decision_history or []), {
        "decision": decision, "reject_code": code, "note": note, "by": staff_ref(actor.id[:64], actor.name or ""),
        "at": iso(now)}]
    r.decided_by, r.decided_by_name, r.decided_at, r.decision_note = actor.id[:64], (actor.name or "")[:120], now, note


async def approve(session: AsyncSession, actor: Actor, r: Referral, note: str, now: datetime,
                  policy: Policy) -> None:
    """review или отклонённый оператором (пересмотр, один раз) → правила (assess, operator=True): автоматические
    отказы и условия кампании действуют, снимаются только риски → qualified → лимит месяца → capped или награда.
    Иначе 409 REFERRAL_STATE {status, outcome} без изменений (транзакция откатывается)."""
    before = r.status
    if not (r.status == "review" or can_redecide(r)) or r.inviter_user_id is None or r.invitee_user_id is None:
        raise conflict("REFERRAL_STATE", "Реферал нельзя одобрить в текущем статусе", {"status": r.status})
    _decision(r, actor, "approved", None, note, now)
    r.reject_code = None
    await assess(session, r, now, now, policy, operator=True)
    if r.status not in ("qualified", "capped"):
        outcome = r.reject_code if r.status == "rejected" else "conditions_not_met"
        raise conflict("REFERRAL_STATE", "Реферал не проходит правила кампании", {"status": before,
                                                                                  "outcome": outcome})
    await emit_audit(session, actor, "referral.approved", "referral", str(r.referral_id),
                     before={"status": before}, after={"status": r.status}, reason=note)


async def reject(session: AsyncSession, actor: Actor, r: Referral, code: str, note: str, now: datetime) -> None:
    """Только review → rejected (reject_code публичный)."""
    if r.status != "review":
        raise conflict("REFERRAL_STATE", "Отклонить можно только реферал на проверке", {"status": r.status})
    _decision(r, actor, "rejected", code, note, now)
    await _reject(session, r, code, now, now)
    await emit_audit(session, actor, "referral.rejected", "referral", str(r.referral_id),
                     before={"status": "review"}, after={"status": "rejected", "reject_code": code}, reason=note)


async def campaign_stats(session: AsyncSession) -> dict[str, Any]:
    """ReferralCampaignStats по версиям (новые сверху); награды — выданные (rewarded) суммарно."""
    counts: dict[int, dict[str, int]] = {}
    for version, status, n in (await session.execute(select(Referral.campaign_version, Referral.status,
                                                            func.count()).group_by(Referral.campaign_version,
                                                                                   Referral.status))).all():
        counts.setdefault(int(version), {})[str(status)] = int(n)
    # выдано кампанией: rewarded без наград по правилу спринта 6
    paid = dict((await session.execute(select(Referral.campaign_version, func.count()).where(
        Referral.status == "rewarded", or_(Referral.reward_outcome.is_(None), Referral.reward_outcome != "legacy"))
        .group_by(Referral.campaign_version))).all())
    items = []
    for c in (await session.execute(select(ReferralCampaign).where(ReferralCampaign.status != "draft")
                                    .order_by(ReferralCampaign.version.desc()))).scalars().all():
        by = counts.get(c.version, {})
        rewarded = by.get("rewarded", 0)
        campaign_paid = int(paid.get(c.version, 0))
        p = c.payload
        items.append({
            "version": c.version, "invited": sum(by.values()),
            "in_progress": sum(by.get(s, 0) for s in ACTIVE), "in_review": by.get("review", 0),
            "qualified": by.get("qualified", 0) + rewarded, "rejected": by.get("rejected", 0),
            "expired": by.get("expired", 0), "capped": by.get("capped", 0),
            "rewards": {side: {k: int(p[f"{side}_reward"][k]) * campaign_paid for k in ("freeze", "til")}
                        for side in ("inviter", "invitee")},
        })
    return {"items": items}
