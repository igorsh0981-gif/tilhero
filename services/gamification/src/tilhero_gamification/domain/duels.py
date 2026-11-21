"""Дуэли (INTERNAL_API спринта 7 §2.3, APP-SOC-07, ADM-GAME-02; навык duel_host — код).

challenged (24 ч на ответ) → accepted (набор заданий lessons, 48 ч на прохождение) → finished | cancelled;
declined, expired. Только друзья 14+ или одна семья (дети — только семья); блокировка и санкция social_ban
запрещают новые вызовы и принятие (уже принятая дуэль доигрывается). Не больше 3 активных вызовов от ученика и одной
активной дуэли на пару; полосы уровня различаются не больше чем на одну (набор — по нижней).

Счёт — только серверный: lesson.session.completed.v1 kind duel от lessons (повтор — без изменений). Победитель —
больше верных, равенство — ничья; сыграл один — техническая победа; никто — cancelled. XP по rules.duel (reason
duel, ключ `duel:<id>:<user>`) — не больше daily_cap наградных дуэлей в день на ученика (сверх — 0). Время ответа на
результат не влияет. Переоценка сотрудником — result_version + 1, прежняя версия — в duel_results_history, награды
исправляются обратными записями и новыми операциями (`duel:<id>:<user>:v<n>`).

Блокировки: ученики дуэли (в одном порядке) → строка дуэли FOR UPDATE. Вызовы social и lessons — вне транзакций.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from typing import Any, Final

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_gamification.clients import Relations
from tilhero_gamification.domain import members
from tilhero_gamification.domain.common import (
    DUEL_CHALLENGED,
    DUEL_FINISHED,
    blocked,
    cursor_time_id,
    duel_not_found,
    duel_state,
    emit_audit,
    emit_event,
    encode_cursor,
    friends_not_allowed,
    idempotency_reused,
    iso,
    local_date,
    lock_users,
    member_not_found,
    partner_not_allowed,
    result_state,
    social_restricted,
    staff_ref,
    user_deleted,
    zone,
)
from tilhero_gamification.domain.engine import Turn, is_deleted, open_turn
from tilhero_gamification.domain.rules import active_rules
from tilhero_gamification.models import Community, Duel, DuelResultHistory, Ledger, SessionReward
from tilhero_gamification.settings import Settings

ACTIVE: Final = ("challenged", "accepted")
ROLES: Final = ("challenger", "opponent")
ACCEPT_WINDOW: Final = timedelta(hours=24)
PLAY_WINDOW: Final = timedelta(hours=48)
MAX_ACTIVE_CHALLENGES: Final = 3
PAGE: Final = 20


def levels_incompatible() -> ApiError:
    return conflict("LEVELS_INCOMPATIBLE", "Уровни слишком разные для честной дуэли")


def duels_limit() -> ApiError:
    return conflict("DUELS_LIMIT", "Слишком много активных вызовов", {"limit": MAX_ACTIVE_CHALLENGES})


def duel_exists(duel_id: uuid.UUID) -> ApiError:
    return conflict("DUEL_EXISTS", "С этим участником уже идёт дуэль", {"duel_id": str(duel_id)})


def role_of(d: Duel, user_id: uuid.UUID) -> str | None:
    if d.challenger == user_id:
        return "challenger"
    if d.opponent == user_id:
        return "opponent"
    return None


def other(role: str) -> str:
    return "opponent" if role == "challenger" else "challenger"


def user_of(d: Duel, role: str) -> uuid.UUID | None:
    return d.challenger if role == "challenger" else d.opponent


async def locked(session: AsyncSession, duel_id: uuid.UUID) -> Duel | None:
    """Строка дуэли под блокировками её учеников (в одном порядке) и FOR UPDATE."""
    d = await session.get(Duel, duel_id)
    if d is None:
        return None
    await lock_users(session, *[u for u in (d.challenger, d.opponent) if u is not None])
    return (await session.execute(select(Duel).where(Duel.duel_id == duel_id).with_for_update()
                                  .execution_options(populate_existing=True))).scalar_one_or_none()


# ---------------------------------------------------------------- вызов


async def replay(session: AsyncSession, challenger: uuid.UUID, key: str, body_hash: str) -> Duel | None:
    """Повтор Idempotency-Key вызова: та же дуэль (200) или 422 IDEMPOTENCY_KEY_REUSED."""
    d = (await session.execute(select(Duel).where(Duel.challenger == challenger, Duel.idempotency_key == key)))\
        .scalar_one_or_none()
    if d is not None and d.request_hash != body_hash:
        raise idempotency_reused()
    return d


async def challenge(session: AsyncSession, settings: Settings, turn: Turn, opponent: uuid.UUID, rel: Relations,
                    pair_id: str | None, key: str, body_hash: str, now: datetime) -> tuple[Duel, bool]:
    """Новый вызов (под блокировками обоих учеников). → (дуэль, создана)."""
    me = turn.user_id
    prior = await replay(session, me, key, body_hash)
    if prior is not None:
        return prior, False
    if await is_deleted(session, opponent):
        raise member_not_found()
    if rel.blocked_any or await members.blocked_with(session, me, [opponent]):
        raise blocked()
    banned, until = await members.active_ban(session, me, now)
    if rel.a_restricted or banned:
        raise social_restricted(rel.a_restricted_until if rel.a_restricted else until)
    kids = "kids" in (rel.a_audience, rel.b_audience)
    if not rel.same_family:
        # не семья: детям — только семья; 14–17 без согласия родителя (или без цели social) — друзья недоступны
        if rel.a_audience != "kids" and not rel.a_social_allowed:
            raise friends_not_allowed("guardian_consent" if rel.a_audience == "teens" else "consent")
        if not (rel.friends and not kids) or not rel.b_social_allowed:
            raise partner_not_allowed()
    if rel.b_restricted:
        raise partner_not_allowed()
    # пара — активная пара вызывающего (последняя диагностика), не из запроса: полосы уровня нельзя обойти чужой парой
    pair = await members.active_pair(session, settings, me)
    if pair_id is not None and pair_id != pair:
        raise unprocessable("VALIDATION_ERROR", "Дуэль — только по активной паре", {"pair_id": pair})
    mine, theirs = await members.band_of(session, me, pair), await members.band_of(session, opponent, pair)
    if abs(members.band_index(mine) - members.band_index(theirs)) > 1:
        raise levels_incompatible()
    band = min(mine, theirs, key=members.band_index)
    active = int(await session.scalar(select(func.count()).select_from(Duel).where(
        Duel.challenger == me, Duel.status.in_(ACTIVE))) or 0)
    if active >= MAX_ACTIVE_CHALLENGES:
        raise duels_limit()
    key_pair = members.pair_key(me, opponent)
    existing = (await session.execute(select(Duel.duel_id).where(Duel.pair_key == key_pair,
                                                                 Duel.status.in_(ACTIVE)))).scalar()
    if existing is not None:
        raise duel_exists(existing)
    d = Duel(duel_id=uuid.uuid4(), challenger=me, opponent=opponent, pair_key=key_pair, pair_id=pair,
             level_band=band, status="challenged", set_id=None, accept_deadline=now + ACCEPT_WINDOW,
             play_deadline=None, scores={}, result=None, technical=False, result_version=0, rewards=[],
             eligible={}, idempotency_key=key, request_hash=body_hash, created_at=now, accepted_at=None,
             finished_at=None, updated_at=now)
    session.add(d)
    await session.flush()
    prof = await session.get(Community, me)
    await emit_event(session, DUEL_CHALLENGED, {
        "duel_id": str(d.duel_id), "challenger_user_id": str(me), "opponent_user_id": str(opponent),
        "challenger_nickname": prof.nickname if prof is not None else None, "pair_id": pair, "level_band": band,
        "accept_deadline": iso(d.accept_deadline), "created_at": iso(now)})
    return d, True


# ---------------------------------------------------------------- ответ на вызов


def check_accept(d: Duel | None, me: uuid.UUID, now: datetime) -> str:
    """Предпроверка без блокировок: 'accepted' — уже принята (повтор), 'go' — можно звать lessons, 'expire' —
    срок ответа прошёл. Чужая дуэль — 404, другой статус — 409 DUEL_STATE."""
    if d is None or d.opponent != me:
        raise duel_not_found()
    if d.status == "accepted":
        return "accepted"
    if d.status != "challenged":
        raise duel_state(d.status)
    return "expire" if now >= d.accept_deadline else "go"


async def expire_one(session: AsyncSession, duel_id: uuid.UUID, now: datetime) -> None:
    await session.execute(update(Duel).where(Duel.duel_id == duel_id, Duel.status == "challenged",
                                             Duel.accept_deadline <= now)
                          .values(status="expired", pair_key=None, updated_at=now))


async def accept(session: AsyncSession, me: uuid.UUID, duel_id: uuid.UUID, set_id: uuid.UUID,
                 now: datetime) -> Duel:
    """Принятие после выдачи набора (lessons идемпотентен по duel_id: параллельное принятие получило тот же набор).
    Под блокировками: уже accepted — повтор (200); иначе только challenged до дедлайна (прошёл — status expired
    фиксируется, вызывающий отвечает 409 DUEL_STATE после коммита); блокировка или санкция."""
    d = await locked(session, duel_id)
    if d is None or d.opponent != me:
        raise duel_not_found()
    if await is_deleted(session, me):
        raise user_deleted()
    if d.status == "accepted":
        return d
    if d.status != "challenged":
        raise duel_state(d.status)
    if now >= d.accept_deadline:
        d.status, d.pair_key, d.updated_at = "expired", None, now
        return d
    assert d.challenger is not None
    if await members.blocked_with(session, me, [d.challenger]):
        raise blocked()
    banned, until = await members.active_ban(session, me, now)
    if banned:
        raise social_restricted(until)
    if (await members.active_ban(session, d.challenger, now))[0]:
        # санкция вызвавшего после вызова: вызов отменяется (фиксируется, вызывающий отвечает 409 DUEL_STATE)
        d.status, d.pair_key, d.updated_at = "cancelled", None, now
        return d
    d.status, d.set_id, d.accepted_at = "accepted", set_id, now
    d.play_deadline = now + PLAY_WINDOW
    d.updated_at = now
    return d


async def precheck_accept(session: AsyncSession, me: uuid.UUID, d: Duel, now: datetime) -> bool:
    """До вызова lessons: блокировка и санкция принимающего (без раскрытия, кто заблокировал). False — у вызвавшего
    действует санкция: вызов отменить, набор не запрашивать."""
    if d.challenger is not None and await members.blocked_with(session, me, [d.challenger]):
        raise blocked()
    banned, until = await members.active_ban(session, me, now)
    if banned:
        raise social_restricted(until)
    return d.challenger is None or not (await members.active_ban(session, d.challenger, now))[0]


async def cancel_one(session: AsyncSession, duel_id: uuid.UUID, now: datetime) -> None:
    await session.execute(update(Duel).where(Duel.duel_id == duel_id, Duel.status == "challenged")
                          .values(status="cancelled", pair_key=None, updated_at=now))


async def decline(session: AsyncSession, me: uuid.UUID, duel_id: uuid.UUID, now: datetime) -> Duel:
    d = await locked(session, duel_id)
    if d is None or d.opponent != me:
        raise duel_not_found()
    if await is_deleted(session, me):
        raise user_deleted()
    if d.status == "declined":
        return d
    if d.status != "challenged":
        raise duel_state(d.status)
    d.status, d.pair_key, d.updated_at = "declined", None, now
    return d


# ---------------------------------------------------------------- счёт и завершение


def _score(value: object) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    c, t = value.get("correct"), value.get("total")
    if not (isinstance(c, int) and isinstance(t, int)) or isinstance(c, bool) or isinstance(t, bool):
        return None
    if not (1 <= t <= 50 and 0 <= c <= t):
        return None
    return {"correct": c, "total": t}


async def on_score(session: AsyncSession, settings: Settings, now: datetime, payload: dict[str, Any],
                   event_id: str) -> None:
    """lesson.session.completed.v1 kind duel: счёт участника (один раз); оба сыграли — завершение."""
    try:
        duel_id = uuid.UUID(str(payload.get("duel_id")))
        user = uuid.UUID(str(payload["user_id"]))
    except ValueError:
        return
    score = _score(payload.get("score"))
    if payload.get("status") != "completed" or score is None:
        return
    d = await locked(session, duel_id)
    if d is None:
        return
    role = role_of(d, user)
    if role is None or d.status != "accepted" or d.scores.get(role) or await is_deleted(session, user):
        return
    d.scores = {**d.scores, role: {**score, "session_id": str(payload.get("session_id") or ""),
                                   "finished_at": str(payload.get("finished_at") or iso(now))}}
    d.updated_at = now
    if all(d.scores.get(r) for r in ROLES):
        await finish(session, settings, d, now, event_id=event_id)
    await _session_rewards(session, user, payload.get("session_id"), d, role, now)


async def _session_rewards(session: AsyncSession, user: uuid.UUID, sid: object, d: Duel, role: str,
                           now: datetime) -> None:
    """Итоги занятия сессии дуэли (экран наград не ждёт вечно): ready — дуэль завершилась этим ходом и у ученика
    есть XP, иначе none (награда придёт при завершении дуэли — в DuelView)."""
    try:
        session_id = uuid.UUID(str(sid))
    except ValueError:
        return
    ops = [r["op_id"] for r in d.rewards if r["role"] == role and r.get("status") == "confirmed"]
    await session.execute(insert(SessionReward).values(
        user_id=user, session_id=session_id, evaluation_id=None, op_ids=ops, badges=[], quests=[], created_at=now,
        updated_at=now).on_conflict_do_nothing(index_elements=["user_id", "session_id"]))


def amount_for(role: str, result: str, played: dict[str, bool], rule: dict[str, int]) -> int:
    """XP роли: не сыграл — 0; ничья — draw; победитель — win; проигравший — participation."""
    if not played.get(role):
        return 0
    if result == "draw":
        return int(rule["draw"])
    return int(rule["win"]) if result == role else int(rule["participation"])


async def _rewarded_today(turn: Turn) -> int:
    """Наградных дуэлей сегодня (день ученика): разные дуэли с положительной операцией duel, без переоценок."""
    return int(await turn.session.scalar(select(func.count(func.distinct(Ledger.source_ref))).where(
        Ledger.user_id == turn.user_id, Ledger.reason == "duel", Ledger.amount > 0, Ledger.local_date == turn.today,
        Ledger.source_kind != "staff")) or 0)


async def finish(session: AsyncSession, settings: Settings, d: Duel, now: datetime, *,
                 event_id: str | None = None) -> None:
    """Завершение (под блокировками): результат версии 1, история, XP в пределах дневного лимита, событие."""
    played = {r: bool(d.scores.get(r)) for r in ROLES}
    d.finished_at, d.updated_at, d.pair_key = now, now, None
    d.result_version = 1
    if d.challenger is None or d.opponent is None or not any(played.values()):
        d.status, d.result, d.technical = "cancelled", "none", False
    else:
        d.status = "finished"
        if all(played.values()):
            c, o = int(d.scores["challenger"]["correct"]), int(d.scores["opponent"]["correct"])
            d.result = "challenger" if c > o else "opponent" if o > c else "draw"
            d.technical = False
        else:
            d.result = "challenger" if played["challenger"] else "opponent"
            d.technical = True
    session.add(DuelResultHistory(duel_id=d.duel_id, version=1, result=d.result or "none", technical=d.technical,
                                  reason=None, decided_by=None, decided_by_name=None, at=now))
    if d.status == "finished":
        rule = (await active_rules(session)).duel
        eligible: dict[str, bool] = {}
        rewards: list[dict[str, Any]] = []
        for role in ROLES:
            uid = user_of(d, role)
            turn = await open_turn(session, settings, now, uid, event_id=event_id) if uid is not None else None
            if turn is None:
                eligible[role] = False
                continue
            eligible[role] = played[role] and await _rewarded_today(turn) < int(rule["daily_cap"])
            amount = amount_for(role, str(d.result), played, rule) if eligible[role] else 0
            if amount > 0:
                op = await turn.post(currency="xp", amount=amount, reason="duel", key=f"duel:{d.duel_id}:{uid}",
                                     source_kind="event" if event_id else "command", source_ref=f"duel:{d.duel_id}",
                                     rules_version=turn.rules.version, use_session=False)
                if op is not None:
                    rewards.append({"role": role, "op_id": str(op.op_id), "amount": amount, "version": 1,
                                    "status": "confirmed"})
                    await turn.check_level()
        d.eligible, d.rewards = eligible, rewards
    if d.challenger is not None and d.opponent is not None:
        await _emit_finished(session, d, now)


async def _emit_finished(session: AsyncSession, d: Duel, now: datetime) -> None:
    def sc(role: str) -> dict[str, int] | None:
        s = d.scores.get(role)
        return {"correct": int(s["correct"]), "total": int(s["total"])} if s else None

    await emit_event(session, DUEL_FINISHED, {
        "duel_id": str(d.duel_id), "challenger_user_id": str(d.challenger), "opponent_user_id": str(d.opponent),
        "status": d.status, "result": d.result or "none", "technical": bool(d.technical),
        "result_version": int(d.result_version), "scores": {"challenger": sc("challenger"), "opponent": sc("opponent")},
        "finished_at": iso(now)})


# ---------------------------------------------------------------- tick


async def expire_challenges(session: AsyncSession, now: datetime, limit: int) -> int:
    ids = (await session.execute(select(Duel.duel_id).where(Duel.status == "challenged", Duel.accept_deadline <= now)
                                 .limit(limit))).scalars().all()
    if ids:
        await session.execute(update(Duel).where(Duel.duel_id.in_(ids), Duel.status == "challenged")
                              .values(status="expired", pair_key=None, updated_at=now))
    return len(ids)


async def due_for_finish(session: AsyncSession, settings: Settings, now: datetime, limit: int) -> list[uuid.UUID]:
    cutoff = now - timedelta(minutes=settings.duel_finish_grace_minutes)
    return list((await session.execute(select(Duel.duel_id).where(
        Duel.status == "accepted", Duel.play_deadline <= cutoff).order_by(Duel.play_deadline).limit(limit)))
        .scalars().all())


async def finish_by_deadline(session: AsyncSession, settings: Settings, duel_id: uuid.UUID, now: datetime) -> bool:
    d = await locked(session, duel_id)
    if d is None or d.status != "accepted":
        return False
    await finish(session, settings, d, now)
    return True


# ---------------------------------------------------------------- переоценка (админ)


def _current_rewards(d: Duel, role: str) -> list[dict[str, Any]]:
    return [r for r in d.rewards if r["role"] == role and r["amount"] > 0 and r.get("status") == "confirmed"]


async def reevaluate(session: AsyncSession, settings: Settings, actor: Actor, duel_id: uuid.UUID, result: str,
                     reason: str, now: datetime) -> dict[str, Any]:
    """Только finished (иначе 409 RESULT_STATE): result_version + 1, прежняя — в истории; XP приводится к новому
    результату обратными записями и новыми операциями (дневной лимит — как при завершении); событие с новой версией."""
    d = await locked(session, duel_id)
    if d is None:
        raise duel_not_found()
    if d.status != "finished":
        raise result_state(d.status)
    played = {r: bool(d.scores.get(r)) for r in ROLES}
    rule = (await active_rules(session)).duel
    version = int(d.result_version) + 1
    before = {"result": d.result, "result_version": d.result_version}
    rewards = [dict(r) for r in d.rewards]
    by = f"staff:{actor.id}"[:80]
    for role in ROLES:
        uid = user_of(d, role)
        if uid is None:
            continue
        new = amount_for(role, result, played, rule) if d.eligible.get(role) else 0
        current = [r for r in rewards if r["role"] == role and r["amount"] > 0 and r.get("status") == "confirmed"]
        if sum(int(r["amount"]) for r in current) == new:
            continue
        turn = await open_turn(session, settings, now, uid)
        if turn is None:
            continue
        for r in current:
            op = (await session.execute(select(Ledger).where(Ledger.op_id == uuid.UUID(r["op_id"]),
                                                             Ledger.user_id == uid).with_for_update())).scalar_one()
            rev = await turn.post(currency="xp", amount=-op.amount, reason="reversal", key=f"reversal:{op.op_id}",
                                  source_kind="staff", source_ref=f"duel:{d.duel_id}", actor=by, comment=reason[:300],
                                  reversal_of=op.op_id, use_session=False)
            if rev is not None:
                op.status, op.reversed_by = "reversed", rev.op_id
                r["status"] = "reversed"
                rewards.append({"role": role, "op_id": str(rev.op_id), "amount": -op.amount, "version": version,
                                "status": "confirmed"})
        if new > 0:
            op2 = await turn.post(currency="xp", amount=new, reason="duel", key=f"duel:{d.duel_id}:{uid}:v{version}",
                                  source_kind="staff", source_ref=f"duel:{d.duel_id}", actor=by,
                                  rules_version=turn.rules.version, use_session=False)
            if op2 is not None:
                rewards.append({"role": role, "op_id": str(op2.op_id), "amount": new, "version": version,
                                "status": "confirmed"})
                await turn.check_level()
    d.rewards = rewards
    d.result, d.result_version = result, version
    d.technical = not all(played.values())
    d.updated_at = now
    session.add(DuelResultHistory(duel_id=d.duel_id, version=version, result=result, technical=d.technical,
                                  reason=reason, decided_by=by, decided_by_name=(actor.name or "")[:120], at=now))
    await session.flush()
    if d.challenger is not None and d.opponent is not None:
        await _emit_finished(session, d, now)
    await emit_audit(session, actor, "game.duel.reevaluated", "duel", str(duel_id), before=before,
                     after={"result": result, "result_version": version}, reason=reason)
    return await admin_view(session, d)


# ---------------------------------------------------------------- API ученика


def _placeholder(settings: Settings, d: Duel) -> str:
    """member_id обезличенного соперника — непрозрачный, ни к кому не ведёт."""
    return members.member_of(settings, uuid.uuid5(d.duel_id, "deleted"))


async def learner_views(session: AsyncSession, settings: Settings, me: uuid.UUID, rows: list[Duel],
                        now: datetime) -> list[dict[str, Any]]:
    others = [u for d in rows for u in (d.challenger, d.opponent) if u is not None and u != me]
    cards = await members.member_cards(session, settings, others)
    out = []
    for d in rows:
        role = role_of(d, me) or "challenger"
        opp_role = other(role)
        opp = user_of(d, opp_role)
        card = cards.get(opp) if opp is not None else None
        mine, theirs = d.scores.get(role), d.scores.get(opp_role)
        result = None
        if d.status == "finished" and d.result:
            outcome = "draw" if d.result == "draw" else "win" if d.result == role else "loss"
            result = {"outcome": outcome, "technical": bool(d.technical),
                      "my_score": {"correct": mine["correct"], "total": mine["total"]} if mine else None,
                      "opponent_score": {"correct": theirs["correct"], "total": theirs["total"]} if theirs else None,
                      "xp": sum(int(r["amount"]) for r in _current_rewards(d, role)),
                      "version": int(d.result_version)}
        out.append({
            "duel_id": str(d.duel_id), "status": d.status, "role": role,
            "opponent": {"member_id": card["member_id"] if card else _placeholder(settings, d),
                         "nickname": card["nickname"] if card else None, "hero": card["hero"] if card else None},
            "pair_id": d.pair_id, "level_band": d.level_band, "created_at": iso(d.created_at),
            "accept_deadline": iso(d.accept_deadline), "play_deadline": iso(d.play_deadline),
            "my_session": ({"session_id": mine["session_id"], "status": "completed"}
                           if mine and mine.get("session_id") else None),
            "my_played": bool(mine), "opponent_played": bool(theirs),
            "can_accept": role == "opponent" and d.status == "challenged" and now < d.accept_deadline,
            "can_play": (d.status == "accepted" and not mine and d.play_deadline is not None
                         and now < d.play_deadline),
            "result": result, "finished_at": iso(d.finished_at)})
    return out


async def learner_get(session: AsyncSession, settings: Settings, me: uuid.UUID, duel_id: uuid.UUID,
                      now: datetime) -> dict[str, Any]:
    d = await session.get(Duel, duel_id)
    if d is None or role_of(d, me) is None:
        raise duel_not_found()
    return (await learner_views(session, settings, me, [d], now))[0]


async def learner_list(session: AsyncSession, settings: Settings, me: uuid.UUID, status: str, cursor: str | None,
                       now: datetime) -> dict[str, Any]:
    """Page<DuelView>: active — challenged и accepted; finished — остальные. Новые сверху."""
    stmt = select(Duel).where(or_(Duel.challenger == me, Duel.opponent == me),
                              Duel.status.in_(ACTIVE) if status == "active" else Duel.status.not_in(ACTIVE))
    return await _page(session, stmt, cursor, lambda rows: learner_views(session, settings, me, rows, now))


async def _page(session: AsyncSession, stmt: Any, cursor: str | None, render: Any) -> dict[str, Any]:
    after = cursor_time_id(cursor)
    if after is not None:
        at, did = after
        stmt = stmt.where(or_(Duel.created_at < at, and_(Duel.created_at == at, Duel.duel_id < did)))
    rows = list((await session.execute(stmt.order_by(Duel.created_at.desc(), Duel.duel_id.desc()).limit(PAGE + 1)))
                .scalars().all())
    nxt = None
    if len(rows) > PAGE:
        rows = rows[:PAGE]
        nxt = encode_cursor(rows[-1].created_at.isoformat(), str(rows[-1].duel_id))
    return {"items": await render(rows), "next_cursor": nxt}


# ---------------------------------------------------------------- админка


def _scores(d: Duel) -> dict[str, Any]:
    return {r: ({"correct": int(d.scores[r]["correct"]), "total": int(d.scores[r]["total"])}
                if d.scores.get(r) else None) for r in ROLES}


def admin_row(d: Duel) -> dict[str, Any]:
    return {"duel_id": str(d.duel_id), "status": d.status,
            "challenger_user_id": str(d.challenger) if d.challenger else None,
            "opponent_user_id": str(d.opponent) if d.opponent else None, "pair_id": d.pair_id,
            "level_band": d.level_band, "scores": _scores(d), "result": d.result, "technical": bool(d.technical),
            "result_version": int(d.result_version), "created_at": iso(d.created_at), "finished_at": iso(d.finished_at)}


async def admin_view(session: AsyncSession, d: Duel) -> dict[str, Any]:
    history = (await session.execute(select(DuelResultHistory).where(DuelResultHistory.duel_id == d.duel_id)
                                     .order_by(DuelResultHistory.version.desc()))).scalars().all()
    rewards = []
    for r in d.rewards:
        uid = user_of(d, r["role"])
        rewards.append({"user_id": str(uid) if uid else None, "op_id": r["op_id"], "amount": int(r["amount"]),
                        "status": r.get("status", "confirmed"), "result_version": int(r["version"])})
    return {**admin_row(d), "set_id": str(d.set_id) if d.set_id else None, "accept_deadline": iso(d.accept_deadline),
            "play_deadline": iso(d.play_deadline), "rewards": rewards,
            "history": [{"version": h.version, "result": h.result, "reason": h.reason,
                         "by": staff_ref(h.decided_by.removeprefix("staff:"), h.decided_by_name)
                         if h.decided_by else None, "at": iso(h.at)} for h in history]}


async def admin_get(session: AsyncSession, duel_id: uuid.UUID) -> dict[str, Any]:
    d = await session.get(Duel, duel_id)
    if d is None:
        raise duel_not_found()
    return await admin_view(session, d)


async def admin_list(session: AsyncSession, status: str | None, cursor: str | None) -> dict[str, Any]:
    stmt = select(Duel)
    if status is not None:
        stmt = stmt.where(Duel.status == status)

    async def render(rows: list[Duel]) -> list[dict[str, Any]]:
        return [admin_row(d) for d in rows]

    return await _page(session, stmt, cursor, render)


async def stats(session: AsyncSession, settings: Settings, period: str, now: datetime) -> dict[str, Any]:
    """Дуэлей завершено за период (дни по STATS_TIMEZONE) — для Dashboard.social."""
    tz = zone(settings.stats_timezone, settings.default_timezone)
    today: date = local_date(now, tz)
    days = {"today": 1, "7d": 7, "30d": 30}[period]
    since = datetime.combine(today - timedelta(days=days - 1), datetime.min.time(), tzinfo=tz)
    n = await session.scalar(select(func.count()).select_from(Duel).where(
        Duel.status == "finished", Duel.finished_at >= since))
    return {"period": period, "duels_finished": int(n or 0)}
