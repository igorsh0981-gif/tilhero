"""`game-tick` (n8n, каждые 15 минут; §1.13). Повтор безопасен, шаги — пачками по TICK_BATCH_SIZE.

Один tick за раз: сессионная advisory-блокировка на выделенном соединении (`pg_try_advisory_lock`); запуск, пока идёт
предыдущий, сразу отвечает `skipped`. Шаги:
1. задания: active за дни, закончившиеся у ученика (полночь — в Python по его поясу) → expired, без штрафов;
2. события недели: published → finished после ends_at;
3. лиги (спринт 7): прошлая неделя → closing, открытые группы прошедших недель закрываются (итоги, призы или
   удержание); включившие общую лигу распределяются по группам текущей недели;
4. дуэли (спринт 7): вызовы без ответа 24 ч → expired; принятые после play_deadline + DUEL_FINISH_GRACE_MINUTES →
   завершение (техническая победа, ничья или cancelled);
5. раз в RECONCILE_HOURS: сверка wallets с суммой реестра — расхождение → лог WALLET_DRIFT и пересчёт;
6. ключи идемпотентности команд сотрудников старше IDEMPOTENCY_DAYS — удаляются.
7. рефералы спринта 6: pending старше LEGACY_REFERRAL_DAYS (90) → expired (тихо);
8. разовая загрузка проекций (семьи, дружбы, полосы уровня), если не завершена — повтор после сбоя источника.
"""

from __future__ import annotations

import logging
import uuid
import zlib
from datetime import date, datetime, timedelta
from typing import Any, Final

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncConnection

from tilhero_common.app import Runtime
from tilhero_gamification.domain import bootstrap, duels, leagues
from tilhero_gamification.domain.common import local_date, lock_user, zone
from tilhero_gamification.models import (
    EvidenceReward,
    GameEvent,
    Idempotency,
    Learner,
    Ledger,
    Quest,
    Referral,
    TickState,
    Wallet,
)
from tilhero_gamification.settings import Settings

log = logging.getLogger("tilhero.gamification.tick")

TICK_LOCK_CLASS: Final = 0x47414D54  # 'GAMT'
RECONCILE: Final = "reconcile"

def _rowcount(result: Any) -> int:
    return int(getattr(result, "rowcount", 0) or 0)


def tick_lock_object(schema: str | None) -> int:
    return int.from_bytes(zlib.crc32((schema or "").encode()).to_bytes(4, "big"), "big", signed=True)


async def expire_quests(rt: Runtime, settings: Settings, now: datetime) -> int:
    """Задания закончившихся дней ученика → expired. Местная полночь считается в Python по поясу ученика (пояс,
    неизвестный PostgreSQL, не роняет tick; неизвестный и Python — пояс по умолчанию). Кандидаты — ученики с
    активными заданиями на дни раньше самого «позднего» сегодня на Земле (UTC+14), пачками по ученикам."""
    horizon = (now + timedelta(hours=14)).date()
    total = 0
    last: uuid.UUID | None = None
    while True:
        async with rt.transaction() as db:
            stmt = (select(Quest.user_id, Learner.timezone).distinct()
                    .join(Learner, Learner.user_id == Quest.user_id, isouter=True)
                    .where(Quest.status == "active", Quest.local_date < horizon)
                    .order_by(Quest.user_id).limit(settings.tick_batch_size))
            if last is not None:
                stmt = stmt.where(Quest.user_id > last)
            rows = (await db.execute(stmt)).all()
            if not rows:
                return total
            last = rows[-1][0]
            by_day: dict[date, list[uuid.UUID]] = {}
            for user_id, tz in rows:
                by_day.setdefault(local_date(now, zone(tz, settings.default_timezone)), []).append(user_id)
            for today, users in by_day.items():
                total += _rowcount(await db.execute(update(Quest).where(
                    Quest.user_id.in_(users), Quest.status == "active", Quest.local_date < today)
                    .values(status="expired")))
        if len(rows) < settings.tick_batch_size:
            return total


async def finish_events(rt: Runtime, now: datetime) -> int:
    async with rt.transaction() as db:
        return _rowcount(await db.execute(update(GameEvent).where(
            GameEvent.status == "published", GameEvent.ends_at <= now).values(status="finished", updated_at=now)))


async def expire_legacy_referrals(rt: Runtime, settings: Settings, now: datetime) -> int:
    """Рефералы спринта 6 в pending старше LEGACY_REFERRAL_DAYS с принятия → expired (тихо, без уведомления)."""
    cutoff = now - timedelta(days=settings.legacy_referral_days)
    total = 0
    while True:
        async with rt.transaction() as db:
            ids = (await db.execute(select(Referral.invitee_user_id).where(
                Referral.status == "pending", Referral.accepted_at < cutoff).limit(settings.tick_batch_size))
                   ).scalars().all()
            if ids:
                await db.execute(update(Referral).where(Referral.invitee_user_id.in_(ids),
                                                        Referral.status == "pending")
                                 .values(status="expired", updated_at=now))
        total += len(ids)
        if len(ids) < settings.tick_batch_size:
            return total


async def duel_steps(rt: Runtime, settings: Settings, now: datetime) -> dict[str, int]:
    """Истечение вызовов (пачками) и завершение дуэлей по дедлайну (по одной транзакции на дуэль)."""
    expired = 0
    while True:
        async with rt.transaction() as db:
            n = await duels.expire_challenges(db, now, settings.tick_batch_size)
        expired += n
        if n < settings.tick_batch_size:
            break
    finished = 0
    while True:
        async with rt.transaction() as db:
            ids = await duels.due_for_finish(db, settings, now, settings.tick_batch_size)
        for duel_id in ids:
            async with rt.transaction() as db:
                finished += int(await duels.finish_by_deadline(db, settings, duel_id, now))
        if len(ids) < settings.tick_batch_size:
            return {"duels_expired": expired, "duels_finished": finished}


async def reconcile(rt: Runtime, settings: Settings, now: datetime, *, force: bool = False) -> int | None:
    """Сверка кошельков с реестром; None — ещё не время (раз в RECONCILE_HOURS)."""
    async with rt.transaction() as db:
        state = await db.get(TickState, RECONCILE, with_for_update=True)
        if not force and state is not None and now - state.last_run_at < timedelta(hours=settings.reconcile_hours):
            return None
        await db.execute(insert(TickState).values(name=RECONCILE, last_run_at=now).on_conflict_do_update(
            index_elements=["name"], set_={"last_run_at": now}))
    fixed = 0
    last: uuid.UUID | None = None
    while True:
        async with rt.transaction() as db:
            stmt = select(Wallet.user_id).order_by(Wallet.user_id).limit(settings.tick_batch_size)
            if last is not None:
                stmt = stmt.where(Wallet.user_id > last)
            ids = list((await db.execute(stmt)).scalars().all())
            if not ids:
                return fixed
            last = ids[-1]
            sums = {r.user_id: r for r in (await db.execute(select(
                Ledger.user_id,
                func.coalesce(func.sum(Ledger.amount).filter(Ledger.currency == "xp"), 0).label("xp"),
                func.coalesce(func.sum(Ledger.amount).filter(Ledger.currency == "til"), 0).label("til"),
                func.coalesce(func.sum(Ledger.amount).filter(Ledger.currency == "freeze"), 0).label("freeze"),
            ).where(Ledger.user_id.in_(ids)).group_by(Ledger.user_id))).all()}
            wallets = {w.user_id: w for w in (await db.execute(select(Wallet).where(Wallet.user_id.in_(ids))))
                       .scalars().all()}
            drift = [u for u in ids if _expected(sums.get(u)) != (wallets[u].xp_total, wallets[u].til_balance,
                                                                  wallets[u].freeze_stock)]
        for user_id in drift:
            async with rt.transaction() as db:
                await lock_user(db, user_id)
                w = await db.get(Wallet, user_id, with_for_update=True, populate_existing=True)
                row = (await db.execute(select(
                    func.coalesce(func.sum(Ledger.amount).filter(Ledger.currency == "xp"), 0),
                    func.coalesce(func.sum(Ledger.amount).filter(Ledger.currency == "til"), 0),
                    func.coalesce(func.sum(Ledger.amount).filter(Ledger.currency == "freeze"), 0),
                ).where(Ledger.user_id == user_id))).one()
                xp, til, freeze = (int(x) for x in row)
                if w is None or (w.xp_total, w.til_balance, w.freeze_stock) == (xp, til, freeze):
                    continue
                log.warning("WALLET_DRIFT", extra={"code": "WALLET_DRIFT", "xp_delta": xp - w.xp_total,
                                                   "til_delta": til - w.til_balance,
                                                   "freeze_delta": freeze - w.freeze_stock})
                w.xp_total, w.til_balance, w.freeze_stock = max(xp, 0), max(til, 0), max(freeze, 0)
                w.updated_at = now
                fixed += 1
        if len(ids) < settings.tick_batch_size:
            return fixed


def _expected(row: Any) -> tuple[int, int, int]:
    if row is None:
        return 0, 0, 0
    return int(row.xp), int(row.til), int(row.freeze)


async def purge_idempotency(rt: Runtime, settings: Settings, now: datetime) -> int:
    """Ключи идемпотентности сотрудников и несвязанные с уроком итоги навыков старше IDEMPOTENCY_DAYS."""
    cutoff = now - timedelta(days=settings.idempotency_days)
    async with rt.transaction() as db:
        await db.execute(delete(EvidenceReward).where(EvidenceReward.created_at < cutoff))
        return _rowcount(await db.execute(delete(Idempotency).where(Idempotency.created_at < cutoff)))


async def run(rt: Runtime, settings: Settings, now: datetime) -> dict[str, Any]:
    assert rt.db is not None
    async with rt.db.engine.connect() as conn:
        got = (await conn.execute(text("SELECT pg_try_advisory_lock(:c, :o)"),
                                  {"c": TICK_LOCK_CLASS, "o": tick_lock_object(rt.db.schema)})).scalar_one()
        await conn.commit()
        if not got:
            return {"skipped": True}
        try:
            out: dict[str, Any] = {"skipped": False}
            out["quests_expired"] = await expire_quests(rt, settings, now)
            out["events_finished"] = await finish_events(rt, now)
            closed = await leagues.close_weeks(rt, settings, now)
            out["league_groups_closed"] = closed["groups_closed"]
            out["league_groups_held"] = closed["groups_held"]
            out["league_members_assigned"] = await leagues.form_groups(rt, settings, now)
            out.update(await duel_steps(rt, settings, now))
            out["legacy_referrals_expired"] = await expire_legacy_referrals(rt, settings, now)
            out["projections_loaded"] = await bootstrap.run_pending(rt, now)
            fixed = await reconcile(rt, settings, now)
            out["reconciled"] = fixed is not None
            out["wallets_fixed"] = fixed or 0
            out["idempotency_purged"] = await purge_idempotency(rt, settings, now)
            return out
        finally:
            await _release(conn)


async def _release(conn: AsyncConnection) -> None:
    try:
        if conn.in_transaction():
            await conn.rollback()
        await conn.execute(text("SELECT pg_advisory_unlock_all()"))
        await conn.commit()
    except BaseException:
        await conn.invalidate()
        raise
