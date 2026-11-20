"""Начисления по событиям (§1.2). Каждый обработчик — одна транзакция с inbox (дедупликация по event_id в Runtime);
операции идемпотентны по ключу `<reason>:<event_id>[:<suffix>]` (навыки — `skill:<user>:<skill_id>:<to>`, заморозка —
`freeze:<user>:<local_date>`), поэтому повтор события второй операции не даёт даже при обходе inbox. Правила —
активные на момент обработки, версия пишется в операцию. Удалённый ученик не воскрешается."""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_gamification.domain import badges, quests
from tilhero_gamification.domain.common import (
    AGE_BANDS,
    STAGE_REACHED,
    STREAK_FROZEN,
    day_end,
    emit_event,
    iso,
    local_date,
    lock_user,
    lock_users,
    parse_ts,
    valid_tz,
    zone,
)
from tilhero_gamification.domain.engine import (
    Turn,
    ensure_learner,
    is_deleted,
    merge_effects,
    open_turn,
    pg_zone_known,
    recent,
)
from tilhero_gamification.domain.rules import stage_of
from tilhero_gamification.models import EvidenceReward, Learner, Ledger, Referral, SessionReward, SkillState
from tilhero_gamification.settings import Settings

log = logging.getLogger("tilhero.gamification.earning")

LESSON_KINDS = ("lesson", "scenario", "media", "reading")
QUEST_BY_KIND = {"lesson": "lesson_complete", "scenario": "scenario_complete", "media": "media_complete",
                 "reading": "reading_complete"}


def _uuid(value: object) -> uuid.UUID:
    return uuid.UUID(str(value))


# ---------------------------------------------------------------- урок (lessons)


async def on_lesson(session: AsyncSession, settings: Settings, now: datetime, payload: dict[str, Any],
                    event_id: str) -> None:
    """lesson.session.completed.v1: XP и тилы по `earn[kind]`; урок с passed — бонус; practice_only — практика.
    Счётчики значков, задания, реферальный бонус пригласившему за первый урок приглашённого."""
    user_id = _uuid(payload["user_id"])
    session_id = _uuid(payload["session_id"])
    kind = str(payload.get("kind"))
    referral = None
    if payload.get("status") == "completed" and kind == "lesson":
        referral = await session.get(Referral, user_id)
        if referral is not None and referral.status == "pending":
            await lock_users(session, user_id, referral.inviter_user_id)
    turn = await open_turn(session, settings, now, user_id, event_id=event_id,
                           at=parse_ts(payload.get("finished_at"), now))
    if turn is None:
        return
    if referral is not None:  # перечитать под блокировкой: параллельный урок мог уже наградить пригласившего
        referral = await session.get(Referral, user_id, populate_existing=True, with_for_update=True)
    turn.session_id = session_id
    evaluation = _uuid_or_none(payload.get("evaluation_id"))
    if payload.get("status") != "completed" or kind not in LESSON_KINDS:
        await _close_session(turn, evaluation)
        return
    earn = turn.rules.earn
    if kind == "lesson":
        if payload.get("practice_only"):
            amounts = dict(earn["lesson_practice"])
        else:
            amounts = {c: int(earn["lesson"][c]) + (int(earn["lesson_passed_bonus"][c]) if payload.get("passed")
                                                    is True else 0) for c in ("xp", "til")}
        turn.learner.lessons_completed += 1
    else:
        amounts = dict(earn[kind])
        if kind == "reading":
            turn.learner.readings_completed += 1
    turn.learner.last_session_id = session_id
    turn.learner.last_session_at = now
    await quests.ensure_today(turn)
    ops = await turn.earn(reason=kind, action=kind, amounts=amounts, key=f"{kind}:{event_id}",
                          source_ref=event_id)
    await quests.advance(turn, QUEST_BY_KIND[kind], delta=1)
    if any(op.currency == "xp" for op in ops):
        await quests.advance_xp(turn)
    await badges.check(turn, {"lessons", "readings"})
    await _close_session(turn, evaluation)
    if referral is not None and referral.status == "pending":
        await _referral_reward(session, settings, now, referral, event_id)


def _uuid_or_none(value: object) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


async def _close_session(turn: Turn, evaluation: uuid.UUID | None) -> None:
    """Итоги занятия + итоги навыков, пришедшие раньше урока по тому же доказательству (evidence_id = evaluation_id)."""
    row = await turn.record_session(evaluation_id=evaluation)
    if row is None or evaluation is None:
        return
    pending = await turn.session.get(EvidenceReward, (turn.user_id, evaluation), with_for_update=True)
    if pending is not None:
        merge_effects(row, pending, turn.now)
        await turn.session.delete(pending)


# ---------------------------------------------------------------- повторение (memory)


async def on_review(session: AsyncSession, settings: Settings, now: datetime, payload: dict[str, Any],
                    event_id: str) -> None:
    """memory.review.completed.v1: при status completed и `reviewed ≥ min_cards` — xp_base + min(correct, cap) XP
    и тилы; пройденные карточки (и у expired) — в счётчик значков и задание review_cards."""
    user_id = _uuid(payload["user_id"])
    turn = await open_turn(session, settings, now, user_id, event_id=event_id,
                           at=parse_ts(payload.get("finished_at"), now))
    if turn is None:
        return
    turn.session_id = _uuid(payload["session_id"])
    reviewed = max(0, int(payload.get("reviewed") or 0))
    correct = max(0, int(payload.get("correct") or 0))
    cfg = turn.rules.earn["review"]
    # пройденные карточки считаются и у истёкшей сессии (значок, задание); награда — только за завершённую
    turn.learner.reviews_cards += reviewed
    await quests.ensure_today(turn)
    if payload.get("status") == "completed" and reviewed >= int(cfg["min_cards"]):
        ops = await turn.earn(reason="review", action="review",
                              amounts={"xp": int(cfg["xp_base"]) + min(correct, int(cfg["xp_per_correct_cap"])),
                                       "til": int(cfg["til"])},
                              key=f"review:{event_id}", source_ref=event_id)
        if any(op.currency == "xp" for op in ops):
            await quests.advance_xp(turn)
    if reviewed:
        await quests.advance(turn, "review_cards", delta=reviewed)
    await badges.check(turn, {"reviews_cards"})
    await turn.record_session()


# ---------------------------------------------------------------- навыки (diagnostics)


async def on_skills(session: AsyncSession, settings: Settings, now: datetime, payload: dict[str, Any],
                    event_id: str) -> None:
    """skills.state.changed.v1: проекция состояний; награда за → demonstrated (из learning/not_started) и
    → retained (кроме source diagnostic), одно состояние навыка — один раз за жизнь, не больше skill_max_per_event
    навыков на событие. Ступень героя = f(навыки в demonstrated/retained, подтверждённые уроком или проверкой
    удержания; отметка первичной диагностики не считается) и не понижается."""
    user_id = _uuid(payload["user_id"])
    at = parse_ts(payload.get("occurred_at"), now)
    turn = await open_turn(session, settings, now, user_id, event_id=event_id, at=at)
    if turn is None:
        return
    pair_id = str(payload.get("pair_id") or "")[:16]
    # Итоги навыков — занятию: по доказательству (evidence_id = evaluation_id урока) в любом порядке событий; без
    # доказательства — последнему уроку, если он был не раньше SESSION_ATTRIBUTION_MINUTES назад
    evidence = next((e for e in (_uuid_or_none(c.get("evidence_id")) for c in payload.get("changes") or []) if e),
                    None)
    if evidence is not None:
        turn.session_id = (await session.execute(select(SessionReward.session_id).where(
            SessionReward.user_id == user_id, SessionReward.evaluation_id == evidence).limit(1))).scalar()
    elif recent(turn.learner.last_session_at, now, settings.session_attribution_minutes):
        turn.session_id = turn.learner.last_session_id
    rewarded = 0
    max_per_event = int(turn.rules.earn["skill_max_per_event"])
    demonstrated = 0
    retained_new = 0
    await quests.ensure_today(turn)
    for change in payload.get("changes") or []:
        skill_id = str(change.get("skill_id"))[:200]
        to, frm, source = change.get("to"), change.get("from"), change.get("source")
        if to not in ("not_started", "learning", "demonstrated", "retained"):
            continue
        applied = await _project_skill(session, user_id, pair_id, skill_id, str(to), str(source), at)
        if not applied or source == "diagnostic":
            continue
        reward_kind = None
        if to == "demonstrated" and frm in ("learning", "not_started"):
            reward_kind = "skill_demonstrated"
        elif to == "retained":
            reward_kind = "skill_retained"
        if reward_kind is None or rewarded >= max_per_event:
            continue
        key = f"skill:{user_id}:{skill_id}:{to}"
        ops = await turn.earn(reason=reward_kind, action="skill", amounts=dict(turn.rules.earn[reward_kind]),
                              key=key, source_ref=event_id)
        if not ops and await _already(turn, key):
            continue  # это состояние навыка уже награждалось
        rewarded += 1
        if to == "demonstrated":
            demonstrated += 1
        else:
            retained_new += 1
    if retained_new:
        turn.learner.skills_retained += retained_new
    # в ступень — только навыки, подтверждённые в учёбе (решение владельца: отметка диагностики не считается)
    turn.learner.confirmed_skills = int(await session.scalar(
        select(func.count()).select_from(SkillState).where(
            SkillState.user_id == user_id, SkillState.state.in_(("demonstrated", "retained")),
            SkillState.confirmed.is_(True))) or 0)
    await quests.advance_xp(turn)
    if demonstrated:
        await quests.advance(turn, "skill_confirmed", delta=demonstrated)
    await _stage(turn)
    await badges.check(turn, {"skills", "skill_retained"})
    if turn.effects.empty:
        return
    if turn.session_id is not None:
        await turn.record_session()
    elif evidence is not None:  # урок с этой оценкой ещё не пришёл — итоги ждут его
        await turn.stash_evidence(evidence)


async def _already(turn: Turn, key: str) -> bool:
    found = await turn.session.scalar(select(func.count()).select_from(Ledger).where(
        Ledger.user_id == turn.user_id, Ledger.idempotency_key.in_((f"{key}:xp", f"{key}:til"))))
    return bool(found)


async def _project_skill(session: AsyncSession, user_id: uuid.UUID, pair_id: str, skill_id: str, state: str,
                         source: str, at: datetime) -> bool:
    """Проекция навыка; запоздавшее событие не откатывает более новое. True — состояние применено.
    confirmed: переход в demonstrated/retained из учёбы (lesson | retention) — да; в learning/not_started — нет;
    отметка диагностики подтверждение не даёт и не снимает."""
    held = state in ("demonstrated", "retained")
    by_learning = held and source in ("lesson", "retention")
    confirmed: Any = by_learning if (by_learning or not held) else SkillState.confirmed
    stmt = insert(SkillState).values(user_id=user_id, pair_id=pair_id, skill_id=skill_id, state=state,
                                     confirmed=by_learning, changed_at=at)
    result = await session.execute(stmt.on_conflict_do_update(
        index_elements=["user_id", "pair_id", "skill_id"],
        set_={"state": state, "changed_at": at, "confirmed": confirmed},
        where=SkillState.changed_at <= at).returning(SkillState.skill_id))
    return result.scalar() is not None


async def _stage(turn: Turn) -> None:
    new = stage_of(int(turn.learner.confirmed_skills), turn.rules.stage_thresholds)
    if new <= turn.learner.hero_stage:
        return  # ступень не понижается
    before = int(turn.learner.hero_stage)
    turn.learner.hero_stage = new
    turn.effects.stage_from = before if turn.effects.stage_from is None else turn.effects.stage_from
    turn.effects.stage_to = new
    if turn.learner.hero_code is not None:
        await emit_event(turn.session, STAGE_REACHED, {
            "user_id": str(turn.user_id), "hero_code": turn.learner.hero_code, "stage": new,
            "confirmed_skills": int(turn.learner.confirmed_skills),
            "notify": turn.notify, "reached_at": iso(turn.now)},
            causation_id=turn.event_id)


# ---------------------------------------------------------------- регистрация (identity-consent)


async def on_profile_created(session: AsyncSession, settings: Settings, now: datetime, payload: dict[str, Any],
                             event_id: str) -> None:
    """user.profile.created.v1: строка ученика (вид, возраст, опекун) и бонус регистрации — заморозки, один раз."""
    user_id = _uuid(payload["user_id"])
    kind = "child" if payload.get("kind") == "child" else "account"
    band = payload.get("age_band") if payload.get("age_band") in AGE_BANDS else None
    guardian = payload.get("guardian_user_id")
    account = _uuid(guardian) if kind == "child" and guardian else user_id
    turn = await open_turn(session, settings, now, user_id, event_id=event_id, account_id=account, kind=kind,
                           age_band=band)
    if turn is None:
        return
    if turn.learner.registered_at is None:
        turn.learner.registered_at = parse_ts(payload.get("created_at"), now)
    # бонус регистрации выдаёт open_turn при первом ходе ученика (ключ registration_bonus:<user_id>, без дубля)


# ---------------------------------------------------------------- рефералы (social)


async def on_invite_accepted(session: AsyncSession, now: datetime, payload: dict[str, Any]) -> None:
    """social.invite.accepted.v1 kind referral → referrals pending (без операций). Один приглашённый — один
    пригласивший; самоприглашение и удалённые — игнор."""
    if payload.get("kind") != "referral":
        return
    inviter, invitee = _uuid(payload["inviter_user_id"]), _uuid(payload["invitee_user_id"])
    if inviter == invitee:
        return
    await lock_users(session, inviter, invitee)  # отметка удаления — после блокировки (сага держит её же)
    if await is_deleted(session, inviter) or await is_deleted(session, invitee):
        return
    await session.execute(insert(Referral).values(
        invitee_user_id=invitee, inviter_user_id=inviter, invite_id=_uuid(payload["invite_id"]), status="pending",
        accepted_at=parse_ts(payload.get("accepted_at"), now), updated_at=now,
    ).on_conflict_do_nothing(index_elements=["invitee_user_id"]))


async def _referral_reward(session: AsyncSession, settings: Settings, now: datetime, referral: Referral,
                           event_id: str) -> None:
    """Пригласившему +referral_freeze за первый урок приглашённого; не больше referral_monthly_cap наград за
    календарный месяц пригласившего — сверх лимита `capped` без операции."""
    if referral.status != "pending":
        return
    inviter = await open_turn(session, settings, now, referral.inviter_user_id, event_id=event_id)
    if inviter is None:
        referral.status, referral.updated_at = "void", now
        return
    month_start = inviter.today.replace(day=1)
    tz = zone(inviter.learner.timezone, settings.default_timezone)
    since = datetime.combine(month_start, datetime.min.time(), tzinfo=tz)
    done = int(await session.scalar(select(func.count()).select_from(Referral).where(
        Referral.inviter_user_id == referral.inviter_user_id, Referral.status == "rewarded",
        Referral.rewarded_at >= since)) or 0)
    if done >= inviter.rules.bonuses["referral_monthly_cap"]:
        referral.status, referral.updated_at = "capped", now
        return
    op = None
    bonus = inviter.rules.bonuses["referral_freeze"]
    if bonus > 0:
        op = await inviter.post(currency="freeze", amount=bonus, reason="referral_bonus",
                                key=f"referral_bonus:{referral.invitee_user_id}", source_kind="event",
                                source_ref=event_id, rules_version=inviter.rules.version, use_session=False)
    referral.status, referral.rewarded_at, referral.updated_at = "rewarded", now, now
    referral.op_id = op.op_id if op is not None else None


# ---------------------------------------------------------------- пропуск (learning-plan)


async def on_session_missed(session: AsyncSession, settings: Settings, now: datetime, payload: dict[str, Any],
                            event_id: str) -> None:
    """learning.session.missed.v1: при auto_freeze и запасе ≥ 1 — freeze −1 (ключ freeze:<user>:<day>) →
    game.streak.frozen.v1. Позже freeze_late_hours после конца пропущенного дня заморозка не тратится."""
    user_id = _uuid(payload["user_id"])
    try:
        missed = date.fromisoformat(str(payload["local_date"]))
    except ValueError:
        return
    turn = await open_turn(session, settings, now, user_id, event_id=event_id)
    if turn is None:
        return
    tz_name = payload.get("timezone")
    tz = zone(tz_name if isinstance(tz_name, str) and valid_tz(tz_name) else turn.learner.timezone,
              settings.default_timezone)
    if now > day_end(missed, tz) + timedelta(hours=settings.freeze_late_hours):
        log.info("late missed event: freeze not spent", extra={"late_hours": settings.freeze_late_hours})
        return
    if missed >= local_date(now, tz):
        return  # день ещё не закончился
    if not turn.learner.auto_freeze or turn.wallet.freeze_stock < 1:
        return
    op = await turn.post(currency="freeze", amount=-1, reason="streak_freeze", key=f"freeze:{user_id}:{missed}",
                         source_kind="event", source_ref=event_id, rules_version=turn.rules.version,
                         use_session=False)
    if op is None:
        return  # этот день уже заморожен
    turn.learner.freezes_used += 1
    await emit_event(session, STREAK_FROZEN, {
        "user_id": str(user_id), "local_date": missed.isoformat(), "op_id": str(op.op_id),
        "freeze_left": int(turn.wallet.freeze_stock), "frozen_at": iso(now)}, causation_id=event_id)
    await badges.check(turn, {"freeze"})


# ---------------------------------------------------------------- серия и план (learning-plan)


async def on_activity(session: AsyncSession, settings: Settings, now: datetime, payload: dict[str, Any],
                      event_id: str) -> None:
    """learning.activity.recorded.v1: streak_best = max(streak_best, streak_days) → значки серии."""
    streak = payload.get("streak_days")
    if not isinstance(streak, int) or isinstance(streak, bool) or streak <= 0:
        return
    turn = await open_turn(session, settings, now, _uuid(payload["user_id"]), event_id=event_id,
                           at=parse_ts(payload.get("recorded_at"), now))
    if turn is None or streak <= turn.learner.streak_best:
        return
    turn.learner.streak_best = streak
    await badges.check(turn, {"streak"})


async def on_plan_updated(session: AsyncSession, payload: dict[str, Any], occurred_at: datetime,
                          now: datetime) -> None:
    """learning.plan.updated.v1: часовой пояс ученика (день заданий и лимитов). Запоздавшее событие не откатывает
    более новое."""
    user_id = _uuid(payload["user_id"])
    tz = payload.get("timezone")
    if not (isinstance(tz, str) and tz):
        return
    await lock_user(session, user_id)
    if await is_deleted(session, user_id):
        return
    learner: Learner = await ensure_learner(session, user_id, now)
    if learner.plan_updated_at is not None and occurred_at < learner.plan_updated_at:
        return
    # пояс — только если его знают и Python, и PostgreSQL (tick считает полночь ученика); иначе — по умолчанию
    learner.timezone = tz[:64] if valid_tz(tz) and await pg_zone_known(session, tz) else None
    learner.plan_updated_at = occurred_at
