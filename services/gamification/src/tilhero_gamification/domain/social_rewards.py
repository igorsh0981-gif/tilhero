"""Реферальные награды и совместные достижения (INTERNAL_API спринта 7 §2.4).

Рефералы. Квалификацию, антифрод и лимит кампании решает social и присылает social.referral.qualified.v1 (только
social): пригласившему inviter_reward (reason referral_bonus), приглашённому invitee_reward (reason
referral_welcome), ключ `referral:<id>:<role>:<валюта>` → ack game.referral.rewarded.v1 с исходом (outcome) и
фактически выданным пригласившему (inviter_reward) — повтор события без второй награды, ack с тем же исходом и
суммами; social идемпотентен. Удалённому награда не начисляется, его id не сохраняется.

Переход со спринта 6 (решение оркестратора: никто не получает дважды и никто не теряет обещанное):
- pending спринта 6 «доживают» по прежнему правилу: первый завершённый урок приглашённого в течение
  LEGACY_REFERRAL_DAYS (90, как REFERRAL_VOID_DAYS спринта 6) дней с принятия → bonuses.referral_freeze заморозок
  пригласившему, ключ `referral_bonus:<приглашённый>`; позже — тихо expired (tick). Новых pending нет;
- приглашённый уже rewarded / capped по правилу спринта 6 → по кампании пригласившему награды нет, исход legacy
  (приветственная награда приглашённого — новая, спринтом 6 не выдавалась — начисляется); ack — как обычно;
- реферал спринта 6 ещё pending, пришла квалификация → награда по кампании, строка спринта 6 → void (урок потом
  второй награды не даст); обратный порядок — урок наградил по спринту 6 (rewarded), квалификация → legacy;
- месячный лимит пригласившего считает награды обоих правил за календарный месяц по DEFAULT_TIMEZONE (по
  кампании — по qualified_at, как social; по спринту 6 — по времени награды): для квалификации кампании —
  лимит кампании inviter_monthly_cap из события (исчерпан — пригласившему нет, исход inviter_capped); для
  «доживающих» pending — bonuses.referral_monthly_cap правил (исчерпан — capped).
Пригласивший и приглашённый блокируются в одном порядке во всех путях.

Парные уроки. lesson.pair.completed.v1 (только lessons): XP rules.pair_lesson.xp (reason pair_lesson, ключ
`pair:<room>:<user>`) — только комната finished, вклад (contributed) и не меньше min_turns (1) собственных ходов,
не больше daily_cap (3) награждаемых парных уроков в день ученика. Значок together_1 — комната finished, цель
команды достигнута, у обоих вклад и ≥ 1 ход (TOGETHER_MIN_TURNS, от min_turns не зависит). Учёт — pair_awards
(одна строка на комнату и ученика: повтор события ничего не даёт). Операция привязана к сессии участника
`uuid5(room_id, str(user_id))`. Учёбу это не меняет.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any, Final

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_gamification.domain import badges
from tilhero_gamification.domain.common import (
    REFERRAL_REWARDED,
    emit_event,
    iso,
    local_date,
    lock_users,
    parse_ts,
    zone,
)
from tilhero_gamification.domain.engine import Turn, open_turn
from tilhero_gamification.domain.rules import active_rules
from tilhero_gamification.models import Ledger, PairAward, Referral, ReferralReward
from tilhero_gamification.settings import Settings


def _reward(value: object) -> dict[str, int]:
    v = value if isinstance(value, dict) else {}
    return {c: max(0, int(v.get(c) or 0)) for c in ("freeze", "til")}


TOGETHER_MIN_TURNS: Final = 1  # значок «Вместе»: собственных ходов у каждого из двоих


def month_bounds(settings: Settings, at: datetime) -> tuple[datetime, datetime]:
    """Календарный месяц момента at по DEFAULT_TIMEZONE: [начало, начало следующего)."""
    tz = zone(settings.default_timezone, "Asia/Tashkent")
    first = local_date(at, tz).replace(day=1)
    nxt = first.replace(year=first.year + 1, month=1) if first.month == 12 else first.replace(month=first.month + 1)
    return (datetime.combine(first, datetime.min.time(), tzinfo=tz),
            datetime.combine(nxt, datetime.min.time(), tzinfo=tz))


async def month_rewards(session: AsyncSession, settings: Settings, inviter: uuid.UUID, at: datetime) -> int:
    """Награды пригласившего за календарный месяц момента at — спринта 6 (rewarded, по времени награды) и по кампании
    (outcome rewarded, по qualified_at)."""
    since, until = month_bounds(settings, at)
    legacy = await session.scalar(select(func.count()).select_from(Referral).where(
        Referral.inviter_user_id == inviter, Referral.status == "rewarded", Referral.rewarded_at >= since,
        Referral.rewarded_at < until))
    campaign = await session.scalar(select(func.count()).select_from(ReferralReward).where(
        ReferralReward.inviter_user_id == inviter, ReferralReward.outcome == "rewarded",
        ReferralReward.qualified_at >= since, ReferralReward.qualified_at < until))
    return int(legacy or 0) + int(campaign or 0)


async def on_referral_qualified(session: AsyncSession, settings: Settings, now: datetime, payload: dict[str, Any],
                                event_id: str) -> None:
    referral = uuid.UUID(str(payload["referral_id"]))
    inviter, invitee = uuid.UUID(str(payload["inviter_user_id"])), uuid.UUID(str(payload["invitee_user_id"]))
    await lock_users(session, inviter, invitee)
    row = await session.get(ReferralReward, referral, with_for_update=True)
    if row is None and inviter != invitee:
        row = await _reward_campaign(session, settings, now, referral, inviter, invitee, payload, event_id)
    ack_invitee = row.invitee_user_id if row is not None else invitee
    # outcome — исход для пригласившего; самоприглашение (social его не допускает) ничего не даёт — как legacy
    await emit_event(session, REFERRAL_REWARDED, {
        "referral_id": str(referral), "inviter_user_id": str(inviter),
        "invitee_user_id": str(ack_invitee) if ack_invitee else None,
        "rewarded_at": iso(row.rewarded_at if row is not None else now),
        "outcome": row.outcome if row is not None else "legacy",
        "inviter_reward": await _inviter_given(session, row)}, causation_id=event_id)


async def _inviter_given(session: AsyncSession, row: ReferralReward | None) -> dict[str, int] | None:
    """Фактически выданное пригласившему — по операциям строки (повтор квитанции даёт то же); null — ничего:
    legacy, inviter_capped, пригласивший удалён, самоприглашение."""
    if row is None or row.outcome != "rewarded" or row.inviter_user_id is None:
        return None
    given = {"freeze": 0, "til": 0}
    if row.op_ids:
        sums = await session.execute(
            select(Ledger.currency, func.sum(Ledger.amount))
            .where(Ledger.op_id.in_([uuid.UUID(i) for i in row.op_ids]), Ledger.user_id == row.inviter_user_id,
                   Ledger.reason == "referral_bonus")
            .group_by(Ledger.currency))
        for currency, amount in sums.all():
            given[str(currency)] = int(amount)
    return given


async def _reward_campaign(session: AsyncSession, settings: Settings, now: datetime, referral: uuid.UUID,
                           inviter: uuid.UUID, invitee: uuid.UUID, payload: dict[str, Any],
                           event_id: str) -> ReferralReward:
    """Награды по кампании с учётом перехода со спринта 6 (под блокировками обоих учеников)."""
    version = int(payload.get("campaign_version") or 1)
    outcome = "rewarded"
    legacy = await session.get(Referral, invitee, with_for_update=True, populate_existing=True)
    if legacy is not None and legacy.status in ("rewarded", "capped"):
        outcome = "legacy"  # уже награждён (или упёрся в лимит) по правилу спринта 6 — второй награды нет
    elif legacy is not None and legacy.status == "pending":
        legacy.status, legacy.updated_at = "void", now  # заменён кампанией: урок второй награды не даст
    # лимит кампании (social присылает его в событии) против наград месяца qualified_at по обоим правилам
    qualified_at = parse_ts(payload.get("qualified_at"), now)
    cap = int(payload["inviter_monthly_cap"])
    if outcome == "rewarded" and await month_rewards(session, settings, inviter, qualified_at) >= cap:
        outcome = "inviter_capped"
    op_ids: list[str] = []
    alive: dict[str, uuid.UUID | None] = {"inviter": inviter, "invitee": invitee}
    sides = ((inviter, "inviter", "referral_bonus", _reward(payload.get("inviter_reward"))),
             (invitee, "invitee", "referral_welcome", _reward(payload.get("invitee_reward"))))
    for user, role, reason, amounts in sides:
        turn = await open_turn(session, settings, now, user, event_id=event_id)
        if turn is None:  # удалён: ни награды, ни его id в строке
            alive[role] = None
            continue
        if role == "inviter" and outcome != "rewarded":
            continue
        for currency in ("freeze", "til"):
            op = await turn.post(currency=currency, amount=amounts[currency], reason=reason,
                                 key=f"referral:{referral}:{role}:{currency}", source_kind="event",
                                 source_ref=f"referral:{referral}:v{version}", rules_version=turn.rules.version,
                                 use_session=False)
            if op is not None:
                op_ids.append(str(op.op_id))
    row = ReferralReward(referral_id=referral, inviter_user_id=alive["inviter"], invitee_user_id=alive["invitee"],
                         campaign_version=version, op_ids=op_ids, rewarded_at=now, qualified_at=qualified_at,
                         outcome=outcome)
    session.add(row)
    await session.flush()
    return row


async def legacy_inviter(session: AsyncSession, invitee: uuid.UUID) -> uuid.UUID | None:
    """Пригласивший по pending-рефералу спринта 6 (чтение без блокировки — для порядка блокировок урока)."""
    ref = await session.get(Referral, invitee)
    return ref.inviter_user_id if ref is not None and ref.status == "pending" else None


async def legacy_lesson(session: AsyncSession, settings: Settings, now: datetime, invitee: uuid.UUID,
                        lesson_at: datetime, event_id: str) -> None:
    """Правило спринта 6 для «доживающих» pending (вызывать под блокировками приглашённого и пригласившего)."""
    ref = await session.get(Referral, invitee, with_for_update=True, populate_existing=True)
    if ref is None or ref.status != "pending":
        return
    if lesson_at > ref.accepted_at + timedelta(days=settings.legacy_referral_days):
        ref.status, ref.updated_at = "expired", now  # тихо, без уведомления
        return
    superseded = await session.scalar(select(func.count()).select_from(ReferralReward).where(
        ReferralReward.invitee_user_id == invitee))
    if superseded:  # квалификация кампании пришла раньше урока — награда уже по кампании
        ref.status, ref.updated_at = "void", now
        return
    inviter: Turn | None = await open_turn(session, settings, now, ref.inviter_user_id, event_id=event_id)
    if inviter is None:
        ref.status, ref.updated_at = "void", now
        return
    if await month_rewards(session, settings, ref.inviter_user_id, now) >= \
            inviter.rules.bonuses["referral_monthly_cap"]:
        ref.status, ref.updated_at = "capped", now
        return
    op = None
    bonus = inviter.rules.bonuses["referral_freeze"]
    if bonus > 0:
        op = await inviter.post(currency="freeze", amount=bonus, reason="referral_bonus",
                                key=f"referral_bonus:{invitee}", source_kind="event", source_ref=event_id,
                                rules_version=inviter.rules.version, use_session=False)
    ref.status, ref.rewarded_at, ref.updated_at = "rewarded", now, now
    ref.op_id = op.op_id if op is not None else None


# ---------------------------------------------------------------- парные уроки


def pair_session_id(room_id: uuid.UUID, user_id: uuid.UUID) -> uuid.UUID:
    """Сессия участника парного урока — как в lessons (INTERNAL_API §3.2)."""
    return uuid.uuid5(room_id, str(user_id))


def _turns(p: dict[str, Any]) -> int:
    t = p.get("turns")
    return int(t) if isinstance(t, int) and not isinstance(t, bool) else 0


async def on_pair_completed(session: AsyncSession, settings: Settings, now: datetime, payload: dict[str, Any],
                            event_id: str) -> None:
    room = uuid.UUID(str(payload["room_id"]))
    parts = [p for p in payload.get("participants") or [] if isinstance(p, dict) and p.get("user_id")]
    users = [uuid.UUID(str(p["user_id"])) for p in parts]
    if not users or len(set(users)) != len(users):
        return
    await lock_users(session, *users)
    rule = (await active_rules(session)).pair_lesson
    finished = payload.get("status") == "finished"

    def contributed(p: dict[str, Any], turns: int) -> bool:
        return p.get("contributed") is True and _turns(p) >= turns

    # «Вместе» (AT-77): цель достигнута и вклад каждого — ≥ 1 собственный ход у обоих (порог XP на значок не влияет:
    # сценарии с выбором реплик — 2–8 ходов на двоих); фарм брошенными комнатами закрыт требованием finished
    together = (finished and payload.get("team_goal_reached") is True and len(parts) == 2
                and all(contributed(p, TOGETHER_MIN_TURNS) for p in parts))
    at = parse_ts(payload.get("ended_at"), now)
    for p, user in zip(parts, users, strict=True):
        if p.get("contributed") is not True:
            continue  # молчавший: ни XP, ни значка
        if await session.get(PairAward, (room, user)) is not None:
            continue  # повтор события комнаты
        turn = await open_turn(session, settings, now, user, event_id=event_id, at=at)
        if turn is None:
            continue
        turn.session_id = pair_session_id(room, user)
        xp = 0
        if finished and contributed(p, rule["min_turns"]) and rule["xp"] > 0:
            awarded = int(await session.scalar(select(func.count()).select_from(PairAward).where(
                PairAward.user_id == user, PairAward.local_date == turn.today, PairAward.xp > 0)) or 0)
            if awarded < rule["daily_cap"]:
                op = await turn.post(currency="xp", amount=rule["xp"], reason="pair_lesson",
                                     key=f"pair:{room}:{user}", source_kind="event", source_ref=event_id,
                                     rules_version=turn.rules.version)
                if op is not None:
                    xp = rule["xp"]
                    await turn.check_level()
        if together:
            turn.learner.together_count += 1
            await badges.check(turn, {"together"})
        session.add(PairAward(room_id=room, user_id=user, xp=xp, together=together, local_date=turn.today, at=now))
        await session.flush()
        await turn.record_session()
