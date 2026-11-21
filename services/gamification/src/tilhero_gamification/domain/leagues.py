"""Лиги недели (INTERNAL_API спринта 7 §2.2, APP-SOC-08/09, ADM-GAME-02).

- Лига друзей и семейная — на лету: XP недели (ledger.league_week) участников, без призов. Скрытый игровой профиль и
  заблокированные (в любую сторону) другим не видны; себя ученик видит всегда. Ребёнку — только семья.
- Общая лига (teens, adults; по желанию — `league_opt_in`; ник обязателен; санкция social_ban запрещает): группы
  (неделя, пара, полоса уровня) по group_size [20, 30]. В начале недели tick распределяет включивших участие поровну
  по группам; включивший в середине недели — в самую малую группу с местом или в новую. Выключение — доигрывает
  неделю без строки в рейтинге (left_at), со следующей недели группа не назначается.
- Закрытие (tick после конца недели): отметка недели closing (weeks.mark_closing), затем по транзакции на группу —
  блокировка группы и её учеников, итоги версии 1 (неизменяемы), призы `league_prize` (тилы, ключ
  `league:<week>:<group>:<user>`) или удержание при аномалии, событие game.league.closed.v1. Повтор ничего не меняет.
- Переоценка (league.manage + step-up): версия + 1 (прежняя хранится), разница призов — обратными записями и новыми
  операциями; снятие удержания — версия + 1 с выдачей призов.

Порядок блокировок: (группа или «корзина» недели-пары-полосы) → ученики — только для прошедших недель; вступление в
группу текущей недели: ученик → корзина. Взаимных блокировок нет: прошедшие и текущая неделя не пересекаются.
"""

from __future__ import annotations

import statistics
import uuid
from datetime import UTC, date, datetime
from typing import Any, Final

from sqlalchemy import and_, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.errors import unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_gamification.domain import members, weeks
from tilhero_gamification.domain.common import (
    LEAGUE_CLOSED,
    decode_week_cursor,
    emit_audit,
    emit_event,
    encode_cursor,
    friends_not_allowed,
    group_not_found,
    iso,
    kids_not_allowed,
    lock_users,
    nickname_required,
    result_state,
    social_restricted,
    staff_ref,
)
from tilhero_gamification.domain.engine import Turn, learner_audience, open_turn
from tilhero_gamification.domain.rules import Rules, active_rules
from tilhero_gamification.models import (
    Community,
    DeletedUser,
    LeagueGroup,
    LeagueMember,
    LeagueResult,
    LeagueWeek,
    Learner,
    LearnerLevel,
    Ledger,
    Sanction,
)
from tilhero_gamification.settings import Settings

ROWS_LIMIT: Final = 50
FAR: Final = datetime.max.replace(tzinfo=UTC)
_BUCKET_LOCK: Final = "gam:league:"


# ---------------------------------------------------------------- XP недели и рейтинг


async def week_xp(session: AsyncSession, week: date, ids: list[uuid.UUID]) -> dict[uuid.UUID, tuple[int, datetime]]:
    """{user: (XP недели, когда набран — последняя операция)}; без XP — (0, FAR)."""
    out: dict[uuid.UUID, tuple[int, datetime]] = {u: (0, FAR) for u in ids}
    if not ids:
        return out
    rows = (await session.execute(select(Ledger.user_id, func.sum(Ledger.amount), func.max(Ledger.created_at)).where(
        Ledger.league_week == week, Ledger.user_id.in_(ids), Ledger.currency == "xp", Ledger.status == "confirmed")
        .group_by(Ledger.user_id))).all()
    for uid, total, last in rows:
        xp = max(0, int(total or 0))
        out[uid] = (xp, last if xp > 0 and last is not None else FAR)
    return out


def ranked(ids: list[uuid.UUID], xp: dict[uuid.UUID, tuple[int, datetime]]) -> list[uuid.UUID]:
    """По XP недели, при равенстве — кто раньше набрал; дальше — детерминированно."""
    return sorted(set(ids), key=lambda u: (-xp[u][0], xp[u][1], str(u)))


async def standings(session: AsyncSession, settings: Settings, week: date, ids: list[uuid.UUID],
                    me: uuid.UUID) -> dict[str, Any]:
    """Standings (bff.ts): ≤ 50 строк + моя строка, если не вошла; участники; XP всех вместе."""
    xp = await week_xp(session, week, ids)
    order = ranked(ids, xp)
    top = order[:ROWS_LIMIT]
    show = [*top, me] if me in xp and me not in top else top
    cards = await members.member_cards(session, settings, show)

    def row(uid: uuid.UUID) -> dict[str, Any]:
        c = cards[uid]
        return {"member_id": c["member_id"], "nickname": c["nickname"], "hero": c["hero"], "xp": xp[uid][0],
                "place": order.index(uid) + 1, "badges": c["badges"], "me": uid == me}

    return {"rows": [row(u) for u in top], "me_row": row(me) if me in xp and me not in top else None,
            "participants": len(order), "total_xp": sum(xp[u][0] for u in order)}


def compute(ids: list[uuid.UUID], xp: dict[uuid.UUID, tuple[int, datetime]], rules: Rules,
            excluded: set[uuid.UUID]) -> list[dict[str, Any]]:
    """Итоги группы: места, XP, призы (только при XP > 0), аномалия — XP > factor × медиана и > min_xp."""
    order = ranked([u for u in ids if u not in excluded], xp)
    values = [xp[u][0] for u in order]
    median = statistics.median(values) if values else 0
    factor, min_xp = rules.league_anomaly
    prizes = rules.league_prizes
    out = []
    for i, uid in enumerate(order):
        value = xp[uid][0]
        out.append({"user_id": str(uid), "place": i + 1, "xp": value,
                    "prize_til": int(prizes[i]) if i < len(prizes) and value > 0 else 0,
                    "anomaly": value > factor * median and value > min_xp})
    return out


# ---------------------------------------------------------------- доступность общей лиги

# возраст допускает общую лигу: не детский профиль, 14+ с известным возрастом, 14–17 — с согласием родителя
_AGE_ALLOWED: Final = (Learner.kind != "child", Learner.age_band.in_(("14-17", "18+")),
                       or_(Learner.age_band == "18+", Learner.guardian_consent == "granted"))


async def unavailable_reason(session: AsyncSession, learner: Learner, now: datetime) -> tuple[str | None, Any]:
    """(причина недоступности общей лиги | None, конец санкции). kids (детский профиль, 6–13 или возраст неизвестен —
    fail closed) → guardian_consent (14–17 без согласия родителя, проекция user.profile.updated) → restricted →
    nickname_required → hidden."""
    if learner_audience(learner) == "kids" or learner.age_band is None:
        return "kids", None
    if learner.age_band == "14-17" and learner.guardian_consent != "granted":
        return "guardian_consent", None
    banned, until = await members.active_ban(session, learner.user_id, now)
    if banned:
        return "restricted", until
    prof = await session.get(Community, learner.user_id)
    if prof is None or prof.nickname is None:
        return "nickname_required", None
    if prof.hidden:
        return "hidden", None
    return None, None


async def _bucket_lock(session: AsyncSession, week: date, pair_id: str, band: str) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
                          {"k": f"{_BUCKET_LOCK}{week.isoformat()}:{pair_id}:{band}"})


async def _ensure_week(session: AsyncSession, week: date, now: datetime, *, formed: bool = False) -> None:
    values: dict[str, Any] = {"week": week, "status": "open", "updated_at": now}
    if formed:
        values["formed_at"] = now
    stmt = insert(LeagueWeek).values(**values)
    if formed:
        await session.execute(stmt.on_conflict_do_update(index_elements=["week"],
                                                         set_={"formed_at": now, "updated_at": now},
                                                         where=LeagueWeek.formed_at.is_(None)))
    else:
        await session.execute(stmt.on_conflict_do_nothing(index_elements=["week"]))


async def _assign(session: AsyncSession, rules: Rules, week: date, user_id: uuid.UUID, pair_id: str, band: str,
                  now: datetime) -> LeagueGroup:
    """Самая малая группа корзины с местом (< max) или новая. Вызывать под блокировкой ученика."""
    await _bucket_lock(session, week, pair_id, band)
    sizes = (await session.execute(
        select(LeagueGroup, func.count(LeagueMember.user_id))
        .join(LeagueMember, and_(LeagueMember.group_id == LeagueGroup.group_id, LeagueMember.left_at.is_(None)),
              isouter=True)
        .where(LeagueGroup.week == week, LeagueGroup.pair_id == pair_id, LeagueGroup.level_band == band,
               LeagueGroup.status == "open")
        .group_by(LeagueGroup.group_id).order_by(func.count(LeagueMember.user_id), LeagueGroup.group_no))).all()
    _, hi = rules.league_group_size
    group = next((g for g, n in sizes if int(n) < hi), None)
    if group is None:
        group = await _new_group(session, week, pair_id, band, now)
    session.add(LeagueMember(week=week, user_id=user_id, group_id=group.group_id, joined_at=now, left_at=None))
    await session.flush()
    return group


async def _new_group(session: AsyncSession, week: date, pair_id: str, band: str, now: datetime) -> LeagueGroup:
    no = int(await session.scalar(select(func.coalesce(func.max(LeagueGroup.group_no), 0)).where(
        LeagueGroup.week == week, LeagueGroup.pair_id == pair_id, LeagueGroup.level_band == band)) or 0) + 1
    group = LeagueGroup(group_id=uuid.uuid4(), week=week, pair_id=pair_id, level_band=band, group_no=no,
                        status="open", version=None, anomalies=0, closed_at=None, created_at=now)
    session.add(group)
    await session.flush()
    return group


async def join_current(session: AsyncSession, settings: Settings, turn: Turn, now: datetime) -> None:
    """Вступление в группу текущей недели (под блокировкой ученика хода): уже участник — снова в строке рейтинга."""
    week = weeks.current_week(settings, now)
    mine = await session.get(LeagueMember, (week, turn.user_id), with_for_update=True)
    if mine is not None:
        mine.left_at = None
        return
    await _ensure_week(session, week, now)
    pair = await members.active_pair(session, settings, turn.user_id)
    band = await members.band_of(session, turn.user_id, pair)
    await _assign(session, turn.rules, week, turn.user_id, pair, band, now)


async def set_opt_in(session: AsyncSession, settings: Settings, turn: Turn, value: bool, now: datetime) -> None:
    """PATCH /game/settings {league_opt_in}. Включение: детям (и при неизвестном возрасте) — 403 KIDS_NOT_ALLOWED;
    14–17 без согласия родителя — 403 FRIENDS_NOT_ALLOWED {reason: guardian_consent}; санкция — 403
    SOCIAL_RESTRICTED {until}; без ника — 409 NICKNAME_REQUIRED; скрытый профиль — участие сохраняется, группа не
    назначается, пока профиль скрыт. Выключение — всегда: текущая неделя доигрывается без строки в рейтинге."""
    learner = turn.learner
    if value:
        reason, until = await unavailable_reason(session, learner, now)
        if reason == "kids":
            raise kids_not_allowed()
        if reason == "guardian_consent":
            raise friends_not_allowed("guardian_consent")
        if reason == "restricted":
            raise social_restricted(until)
        if reason == "nickname_required":
            raise nickname_required()
        learner.league_opt_in = True
        if reason is None:
            await join_current(session, settings, turn, now)
    else:
        learner.league_opt_in = False
        week = weeks.current_week(settings, now)
        await session.execute(update(LeagueMember).where(
            LeagueMember.week == week, LeagueMember.user_id == turn.user_id, LeagueMember.left_at.is_(None))
            .values(left_at=now))
    learner.updated_at = now


# ---------------------------------------------------------------- tick: группы недели


async def form_groups(rt: Runtime, settings: Settings, now: datetime) -> int:
    """Распределить включивших участие (подходящих по проекциям) по группам текущей недели: сначала создаются группы
    корзины на всех (ceil(N / max)), затем каждый ученик — своей транзакцией (блокировка ученика, проверка удаления и
    условий) — в самую малую группу. Повтор безопасен; поздно включившие подхватываются следующим tick."""
    week = weeks.current_week(settings, now)
    assigned = 0
    async with rt.transaction() as db:
        await _ensure_week(db, week, now, formed=True)
        rules = await active_rules(db)
        # предфильтр по проекциям (окончательно — под блокировкой ученика в _form_one): 14+ с известным возрастом
        # (14–17 — с согласием родителя; отзыв убирает из текущей группы сразу — _participants), ник есть, профиль
        # не скрыт, нет действующей санкции, группы на неделю ещё нет
        rows = (await db.execute(select(Learner.user_id).join(Community, Community.user_id == Learner.user_id).where(
            Learner.league_opt_in.is_(True), *_AGE_ALLOWED, Community.nickname.is_not(None),
            Community.hidden.is_(False),
            ~select(LeagueMember.user_id).where(LeagueMember.week == week, LeagueMember.user_id == Learner.user_id)
            .exists(),
            ~select(Sanction.sanction_id).where(
                Sanction.user_id == Learner.user_id, Sanction.kind == "social_ban", Sanction.active.is_(True),
                or_(Sanction.until.is_(None), Sanction.until > now)).exists())
            .order_by(Learner.user_id))).scalars().all()
        candidates = list(rows)
        levels: dict[uuid.UUID, tuple[str, str]] = {}  # активная пара — последней диагностики
        for i in range(0, len(candidates), settings.tick_batch_size):
            chunk = candidates[i:i + settings.tick_batch_size]
            for uid, pair, band in (await db.execute(
                    select(LearnerLevel.user_id, LearnerLevel.pair_id, LearnerLevel.level_band)
                    .where(LearnerLevel.user_id.in_(chunk)).order_by(LearnerLevel.completed_at))).all():
                levels[uid] = (pair, band)
        buckets: dict[tuple[str, str], list[uuid.UUID]] = {}
        for uid in candidates:
            buckets.setdefault(levels.get(uid, (settings.default_pair_id, members.DEFAULT_BAND)), []).append(uid)
    _, hi = rules.league_group_size
    for (pair, band), users in buckets.items():
        async with rt.transaction() as db:
            await _bucket_lock(db, week, pair, band)
            existing = (await db.execute(select(LeagueGroup.group_id).where(
                LeagueGroup.week == week, LeagueGroup.pair_id == pair, LeagueGroup.level_band == band))).all()
            seated = int(await db.scalar(select(func.count()).select_from(LeagueMember).join(
                LeagueGroup, LeagueGroup.group_id == LeagueMember.group_id).where(
                LeagueGroup.week == week, LeagueGroup.pair_id == pair, LeagueGroup.level_band == band)) or 0)
            need = -(-(seated + len(users)) // hi) - len(existing)
            for _ in range(max(0, need)):
                await _new_group(db, week, pair, band, now)
        for i in range(0, len(users), settings.tick_batch_size):
            for uid in users[i:i + settings.tick_batch_size]:
                async with rt.transaction() as db:
                    assigned += await _form_one(db, settings, uid, week, now)
    return assigned


async def _form_one(db: AsyncSession, settings: Settings, uid: uuid.UUID, week: date, now: datetime) -> int:
    turn = await open_turn(db, settings, now, uid)
    if turn is None or not turn.learner.league_opt_in:
        return 0
    if await db.get(LeagueMember, (week, uid)) is not None:
        return 0
    reason, _ = await unavailable_reason(db, turn.learner, now)
    if reason is not None:
        return 0
    pair = await members.active_pair(db, settings, uid)
    await _assign(db, turn.rules, week, uid, pair, await members.band_of(db, uid, pair), now)
    return 1


# ---------------------------------------------------------------- закрытие недели


async def close_weeks(rt: Runtime, settings: Settings, now: datetime) -> dict[str, int]:
    """Прошлая неделя → closing (всегда: запоздавший XP после отметки идёт в текущую), затем открытые группы
    прошедших недель закрываются по одной; неделя без открытых групп → closed."""
    current = weeks.current_week(settings, now)
    previous = current - weeks.WEEK
    async with rt.transaction() as db:
        status = await weeks.status_of(db, previous)
        pending = sorted(set((await db.execute(select(LeagueGroup.week).where(
            LeagueGroup.status == "open", LeagueGroup.week < current))).scalars().all()))
    if status not in ("closing", "closed"):
        async with rt.transaction() as db:
            await weeks.mark_closing(db, previous, now)
    closed = held = 0
    for week in pending:
        if week != previous:
            async with rt.transaction() as db:
                await weeks.mark_closing(db, week, now)
        async with rt.transaction() as db:
            ids = (await db.execute(select(LeagueGroup.group_id).where(
                LeagueGroup.week == week, LeagueGroup.status == "open").order_by(LeagueGroup.group_id)
            )).scalars().all()
        for gid in ids:
            async with rt.transaction() as db:
                out = await close_group(db, settings, gid, now)
            if out == "closed":
                closed += 1
            elif out == "held":
                held += 1
    async with rt.transaction() as db:
        await db.execute(update(LeagueWeek).where(
            LeagueWeek.status == "closing", LeagueWeek.week < current,
            ~select(LeagueGroup.group_id).where(LeagueGroup.week == LeagueWeek.week, LeagueGroup.status == "open")
            .exists()).values(status="closed", closed_at=now, updated_at=now))
    return {"groups_closed": closed, "groups_held": held}


async def _participants(db: AsyncSession, group: LeagueGroup, now: datetime) -> list[uuid.UUID]:
    """Участники рейтинга и итогов: в группе, не выключили участие, не удалены, профиль не скрыт, нет действующей
    санкции social_ban (запрещает участие в общей лиге), возраст по-прежнему допускает общую лигу (14–17 — с
    согласием родителя: отзыв посреди недели сразу убирает из рейтинга для других и из призов). При закрытии — под
    блокировками учеников."""
    rows = (await db.execute(select(LeagueMember.user_id).where(
        LeagueMember.group_id == group.group_id, LeagueMember.left_at.is_(None)))).scalars().all()
    ids = list(rows)
    if not ids:
        return []
    deleted = set((await db.execute(select(DeletedUser.user_id).where(DeletedUser.user_id.in_(ids)))).scalars().all())
    banned = await members.banned_among(db, ids, now)
    profiles = await members.community(db, ids)
    allowed = set((await db.execute(select(Learner.user_id).where(
        Learner.user_id.in_(ids), *_AGE_ALLOWED))).scalars().all())
    return [u for u in ids if u not in deleted and u not in banned and u in allowed
            and not (profiles.get(u) is not None and profiles[u].hidden)]


async def close_group(db: AsyncSession, settings: Settings, group_id: uuid.UUID, now: datetime) -> str | None:
    """Одна транзакция на группу: итоги версии 1, призы или удержание, событие. Уже закрыта — None."""
    group = (await db.execute(select(LeagueGroup).where(LeagueGroup.group_id == group_id).with_for_update()
                              .execution_options(populate_existing=True))).scalar_one_or_none()
    if group is None or group.status != "open":
        return None
    everyone = list((await db.execute(select(LeagueMember.user_id).where(LeagueMember.group_id == group_id)))
                    .scalars().all())
    await lock_users(db, *everyone)
    ids = await _participants(db, group, now)
    rules = await active_rules(db)
    rows = compute(ids, await week_xp(db, group.week, ids), rules, set())
    held = any(r["anomaly"] for r in rows)
    await _record(db, settings, group, rules, rows, version=1, held=held, excluded=[], now=now, actor=None,
                  reason=None, paid={})
    return group.status


async def _record(db: AsyncSession, settings: Settings, group: LeagueGroup, rules: Rules,
                  rows: list[dict[str, Any]], *, version: int, held: bool, excluded: list[str], now: datetime,
                  actor: Actor | None, reason: str | None, paid: dict[str, int]) -> None:
    """Итоги версии version (неизменяемы), призы: выплаченное (paid) приводится к новым призам обратными записями и
    новыми операциями; удержание — без выплат. Событие game.league.closed.v1."""
    by = f"staff:{actor.id}"[:80] if actor is not None else "system"
    db.add(LeagueResult(group_id=group.group_id, version=version, week=group.week, standings=rows,
                        prizes_held=held, excluded_user_ids=excluded, closed_at=now, closed_by=by,
                        closed_by_name=(actor.name or "")[:120] if actor is not None else None, reason=reason))
    await db.flush()
    target = {} if held else {r["user_id"]: int(r["prize_til"]) for r in rows if r["user_id"] and r["prize_til"]}
    for uid in sorted(set(paid) | set(target)):
        old, new = int(paid.get(uid, 0)), int(target.get(uid, 0))
        if old == new:
            continue
        turn = await open_turn(db, settings, now, uuid.UUID(uid))
        if turn is None:
            continue
        src = f"league:{group.group_id}"
        kind = "staff" if actor is not None else "command"
        if old:
            await _reverse_prize(db, turn, src, actor, reason)
        if new:
            key = f"league:{group.week.isoformat()}:{group.group_id}:{uid}" + (f":v{version}" if version > 1 else "")
            await turn.post(currency="til", amount=new, reason="league_prize", key=key, source_kind=kind,
                            source_ref=src, rules_version=rules.version, actor=by, use_session=False)
    group.status = "held" if held else "closed"
    group.version = version
    group.anomalies = sum(1 for r in rows if r["anomaly"])
    group.closed_at = group.closed_at or now
    await emit_event(db, LEAGUE_CLOSED, {
        "week": group.week.isoformat(), "group_id": str(group.group_id), "version": version,
        "pair_id": group.pair_id, "level_band": group.level_band, "prizes_held": held,
        "standings": [{"user_id": r["user_id"], "place": r["place"], "xp": r["xp"],
                       "prize_til": 0 if held else r["prize_til"]} for r in rows if r["user_id"]][:ROWS_LIMIT],
        "closed_at": iso(now)})


async def _reverse_prize(db: AsyncSession, turn: Turn, source_ref: str, actor: Actor | None,
                         reason: str | None) -> None:
    ops = (await db.execute(select(Ledger).where(
        Ledger.user_id == turn.user_id, Ledger.reason == "league_prize", Ledger.source_ref == source_ref,
        Ledger.status == "confirmed").with_for_update())).scalars().all()
    for op in ops:
        rev = await turn.post(currency=op.currency, amount=-op.amount, reason="reversal", key=f"reversal:{op.op_id}",
                              source_kind="staff", source_ref=str(op.op_id),
                              actor=f"staff:{actor.id}"[:80] if actor is not None else "system",
                              comment=(reason or "")[:300] or None, reversal_of=op.op_id, use_session=False)
        if rev is not None:
            op.status, op.reversed_by = "reversed", rev.op_id


# ---------------------------------------------------------------- переоценка и снятие удержания (админ)


async def _locked_group(db: AsyncSession, group_id: uuid.UUID) -> tuple[LeagueGroup, LeagueResult]:
    group = (await db.execute(select(LeagueGroup).where(LeagueGroup.group_id == group_id).with_for_update()
                              .execution_options(populate_existing=True))).scalar_one_or_none()
    if group is None:
        raise group_not_found()
    if group.status == "open" or group.version is None:
        raise result_state(group.status)
    latest = await db.get(LeagueResult, (group.group_id, group.version))
    if latest is None:  # невозможно: версия группы пишется вместе с итогами
        raise result_state(group.status)
    return group, latest


def _paid(latest: LeagueResult) -> dict[str, int]:
    if latest.prizes_held:
        return {}
    return {str(r["user_id"]): int(r["prize_til"]) for r in latest.standings if r.get("user_id") and r["prize_til"]}


async def reevaluate(db: AsyncSession, settings: Settings, actor: Actor, group_id: uuid.UUID,
                     exclude: list[uuid.UUID], reason: str, now: datetime) -> dict[str, Any]:
    """Версия + 1: исключения накапливаются (прежние + новые), XP пересчитывается из реестра (обратные записи
    учитываются), призы исправляются обратными записями и новыми операциями. Удержание остаётся, пока в группе есть
    аномалия. 409 RESULT_STATE — группа ещё не закрыта; 409 BALANCE_NEGATIVE — приз уже потрачен."""
    group, latest = await _locked_group(db, group_id)
    everyone = list((await db.execute(select(LeagueMember.user_id).where(LeagueMember.group_id == group_id)))
                    .scalars().all())
    unknown = [str(u) for u in exclude if u not in everyone]
    if unknown:
        raise unprocessable("VALIDATION_ERROR", "Исключать можно только участников группы", {"user_ids": unknown})
    await lock_users(db, *everyone)
    excluded = sorted({*latest.excluded_user_ids, *(str(u) for u in exclude)})
    base = [uuid.UUID(str(r["user_id"])) for r in latest.standings if r.get("user_id")]
    base += [uuid.UUID(u) for u in latest.excluded_user_ids]
    deleted = set((await db.execute(select(DeletedUser.user_id).where(DeletedUser.user_id.in_(base))))
                  .scalars().all()) if base else set()
    ids = [u for u in dict.fromkeys(base) if u not in deleted]
    rules = await active_rules(db)
    rows = compute(ids, await week_xp(db, group.week, ids), rules, {uuid.UUID(u) for u in excluded})
    held = group.status == "held" and any(r["anomaly"] for r in rows)
    before = {"version": group.version, "status": group.status}
    await _record(db, settings, group, rules, rows, version=int(group.version or 1) + 1, held=held,
                  excluded=excluded, now=now, actor=actor, reason=reason, paid=_paid(latest))
    await emit_audit(db, actor, "game.league.reevaluated", "league_group", str(group_id), before=before,
                     after={"version": group.version, "status": group.status, "excluded": len(excluded)},
                     reason=reason)
    return await admin_group(db, settings, group_id, now)


async def release_prizes(db: AsyncSession, settings: Settings, actor: Actor, group_id: uuid.UUID, reason: str,
                         now: datetime) -> dict[str, Any]:
    """Снятие удержания (только held): версия + 1 с теми же местами, призы выдаются."""
    group, latest = await _locked_group(db, group_id)
    if group.status != "held":
        raise result_state(group.status)
    everyone = list((await db.execute(select(LeagueMember.user_id).where(LeagueMember.group_id == group_id)))
                    .scalars().all())
    await lock_users(db, *everyone)
    rules = await active_rules(db)
    before = {"version": group.version, "status": group.status}
    await _record(db, settings, group, rules, [dict(r) for r in latest.standings], version=int(group.version or 1) + 1,
                  held=False, excluded=list(latest.excluded_user_ids), now=now, actor=actor, reason=reason, paid={})
    await emit_audit(db, actor, "game.league.prizes_released", "league_group", str(group_id), before=before,
                     after={"version": group.version, "status": group.status}, reason=reason)
    return await admin_group(db, settings, group_id, now)


# ---------------------------------------------------------------- API ученика


async def _visible(session: AsyncSession, me: uuid.UUID, others: list[uuid.UUID]) -> list[uuid.UUID]:
    """Другие без скрытых и заблокированных (в любую сторону); я — всегда первым."""
    others = [u for u in dict.fromkeys(others) if u != me]
    blocked = await members.blocked_with(session, me, others)
    profiles = await members.community(session, others)
    return [me, *[u for u in others if u not in blocked and not (profiles.get(u) is not None and profiles[u].hidden)]]


async def learner_view(session: AsyncSession, settings: Settings, turn: Turn, now: datetime) -> dict[str, Any]:
    """LeaguesView (bff.ts): друзья (ребёнку — null), семья (нет семьи — null), общая лига."""
    tz = weeks.tz_of(settings)
    week = weeks.week_of(now, tz)
    me = turn.user_id
    kids = turn.audience == "kids"
    friends = None
    if not kids:
        friends = await standings(session, settings, week,
                                  await _visible(session, me, await members.friends_of(session, me)), me)
    fam = await members.family_of(session, me)
    family = await standings(session, settings, week, await _visible(session, me, fam), me) if fam else None
    return {"week": week.isoformat(), "ends_at": iso(weeks.week_end(week, tz)), "friends": friends,
            "family": family, "general": await general_view(session, settings, turn, now, week)}


async def general_view(session: AsyncSession, settings: Settings, turn: Turn, now: datetime,
                       week: date) -> dict[str, Any]:
    learner = turn.learner
    reason, _ = await unavailable_reason(session, learner, now)
    opt_in = bool(learner.league_opt_in) and reason != "kids"
    pair_id: str | None = None
    band: str | None = None
    group = None
    if reason != "kids":
        mine = await session.get(LeagueMember, (week, turn.user_id))
        g = await session.get(LeagueGroup, mine.group_id) if mine is not None and mine.left_at is None else None
        if g is not None and reason not in ("hidden", "restricted", "guardian_consent"):
            pair_id, band = g.pair_id, g.level_band
            ids = await _participants(session, g, now)
            group = await standings(session, settings, week, ids, turn.user_id)
        else:
            pair_id = await members.active_pair(session, settings, turn.user_id)
            band = await members.band_of(session, turn.user_id, pair_id)
    return {"opt_in": opt_in, "available": reason is None, "unavailable_reason": reason, "pair_id": pair_id,
            "level_band": band, "group": group, "prizes": turn.rules.league_prizes}


async def history(session: AsyncSession, user_id: uuid.UUID, cursor: str | None, limit: int) -> dict[str, Any]:
    """Page<LeagueResult>: мои итоги общей лиги (последняя версия группы), новые сверху. Курсор — неделя."""
    stmt = (select(LeagueMember.week, LeagueGroup).join(LeagueGroup, LeagueGroup.group_id == LeagueMember.group_id)
            .where(LeagueMember.user_id == user_id, LeagueGroup.status != "open", LeagueGroup.version.is_not(None))
            .order_by(LeagueMember.week.desc()))
    after = decode_week_cursor(cursor)
    if after is not None:
        stmt = stmt.where(LeagueMember.week < after)
    rows = (await session.execute(stmt.limit(limit + 1))).all()
    items = []
    for week, group in rows[:limit]:
        res = await session.get(LeagueResult, (group.group_id, group.version))
        mine = next((r for r in (res.standings if res else []) if r.get("user_id") == str(user_id)), None)
        if res is None or mine is None:
            continue
        items.append({"week": week.isoformat(), "pair_id": group.pair_id, "level_band": group.level_band,
                      "place": int(mine["place"]), "participants": len(res.standings), "xp": int(mine["xp"]),
                      "prize_til": 0 if res.prizes_held else int(mine["prize_til"]),
                      "prize_held": bool(res.prizes_held), "version": res.version, "closed_at": iso(res.closed_at)})
    nxt = encode_cursor(rows[limit - 1][0].isoformat()) if len(rows) > limit else None
    return {"items": items, "next_cursor": nxt}


# ---------------------------------------------------------------- админка


def _group_row(g: LeagueGroup, size: int) -> dict[str, Any]:
    return {"group_id": str(g.group_id), "week": g.week.isoformat(), "pair_id": g.pair_id,
            "level_band": g.level_band, "group_no": g.group_no, "size": size, "status": g.status,
            "version": g.version, "anomalies": int(g.anomalies), "closed_at": iso(g.closed_at)}


async def _sizes(session: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not ids:
        return {}
    return {gid: int(n) for gid, n in (await session.execute(
        select(LeagueMember.group_id, func.count()).where(LeagueMember.group_id.in_(ids),
                                                          LeagueMember.left_at.is_(None))
        .group_by(LeagueMember.group_id))).all()}


async def admin_week(session: AsyncSession, settings: Settings, week: date | None, now: datetime) -> dict[str, Any]:
    """AdminLeagueWeek: группы, размеры, статус закрытия, аномалии, выданные призы."""
    tz = weeks.tz_of(settings)
    week = week or weeks.week_of(now, tz)
    groups = list((await session.execute(select(LeagueGroup).where(LeagueGroup.week == week).order_by(
        LeagueGroup.pair_id, LeagueGroup.level_band, LeagueGroup.group_no))).scalars().all())
    sizes = await _sizes(session, [g.group_id for g in groups])
    status = await weeks.status_of(session, week)
    latest = (await session.execute(select(LeagueResult.standings).join(
        LeagueGroup, and_(LeagueGroup.group_id == LeagueResult.group_id, LeagueGroup.version == LeagueResult.version))
        .where(LeagueGroup.week == week, LeagueResult.prizes_held.is_(False)))).scalars().all()
    prizes = sum(int(r["prize_til"]) for standings in latest for r in standings)
    return {"week": week.isoformat(), "starts_at": iso(weeks.week_start(week, tz)),
            "ends_at": iso(weeks.week_end(week, tz)), "status": "closed" if status == "closed" else "open",
            "participants": sum(sizes.values()), "prizes_til": prizes,
            "groups": [_group_row(g, sizes.get(g.group_id, 0)) for g in groups]}


def _result_view(r: LeagueResult) -> dict[str, Any]:
    closed_by = None if r.closed_by == "system" else staff_ref(r.closed_by.removeprefix("staff:"), r.closed_by_name)
    return {"version": r.version,
            "standings": [{"user_id": s.get("user_id"), "place": int(s["place"]), "xp": int(s["xp"]),
                           "prize_til": int(s["prize_til"])} for s in r.standings],
            "prizes_held": bool(r.prizes_held), "excluded_user_ids": list(r.excluded_user_ids),
            "closed_at": iso(r.closed_at), "closed_by": closed_by, "reason": r.reason}


async def admin_group(session: AsyncSession, settings: Settings, group_id: uuid.UUID,
                      now: datetime) -> dict[str, Any]:
    """AdminLeagueGroup: участники (XP, место, приз, аномалия, исключение) и все версии итогов (новые сверху).
    Открытая группа — места и аномалии на сейчас, призов нет."""
    g = await session.get(LeagueGroup, group_id)
    if g is None:
        raise group_not_found()
    rows = list((await session.execute(select(LeagueMember).where(LeagueMember.group_id == group_id)
                                       .order_by(LeagueMember.joined_at, LeagueMember.user_id))).scalars().all())
    results = list((await session.execute(select(LeagueResult).where(LeagueResult.group_id == group_id)
                                          .order_by(LeagueResult.version.desc()))).scalars().all())
    ids = [m.user_id for m in rows]
    xp_now = await week_xp(session, g.week, ids)
    excluded: set[str] = set()
    if results:
        latest = results[0]
        by_user = {str(s["user_id"]): s for s in latest.standings if s.get("user_id")}
        excluded = set(latest.excluded_user_ids)
    else:
        rules = await active_rules(session)
        live = await _participants(session, g, now)
        by_user = {r["user_id"]: {**r, "prize_til": 0} for r in compute(live, xp_now, rules, set())}
    profiles = await members.community(session, ids)
    out_members = []
    for m in rows:
        uid = str(m.user_id)
        s = by_user.get(uid)
        prof = profiles.get(m.user_id)
        out_members.append({
            "user_id": uid, "member_id": prof.member_id if prof else members.member_of(settings, m.user_id),
            "nickname": prof.nickname if prof else None,
            "xp": int(s["xp"]) if s else xp_now.get(m.user_id, (0, FAR))[0],
            "place": int(s["place"]) if s else None, "prize_til": int(s["prize_til"]) if s else 0,
            "anomaly": bool(s.get("anomaly")) if s else False, "excluded": uid in excluded,
            "joined_at": iso(m.joined_at)})
    size = sum(1 for m in rows if m.left_at is None)
    return {**_group_row(g, size), "members": out_members, "results": [_result_view(r) for r in results]}


MAX_EXCLUDE: Final = 30
__all__ = ["MAX_EXCLUDE", "admin_group", "admin_week", "close_group", "close_weeks", "form_groups", "history",
           "learner_view", "reevaluate", "release_prizes", "set_opt_in"]
