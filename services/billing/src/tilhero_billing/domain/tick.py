"""`billing-tick` (n8n, каждые 5 мин; INTERNAL_API §1.16). Один tick за раз — сессионная advisory-блокировка на
выделенном соединении (иначе `{skipped: true}`); шаги пачками, каждый аккаунт и заказ — своя короткая транзакция под
блокировками «аккаунт → заказ»; повтор безопасен.

1. истечение заказов (pending → expired);
2. активация и завершение периодов (`ensure_current` по аккаунтам с истёкшим активным или с очередью без активного);
3. конец подписок Stars (`expires_at` прошёл без продления: canceled — сразу, active/failed — после
   STARS_RENEWAL_GRACE_MINUTES) → ended, событие;
4. `billing.subscription.expiring.v1` — за `expiring_days` и в день окончания (Ташкент), если нет следующего периода
   и подписки Stars с автопродлением (пороги, пересечённые с прошлого tick);
5. истечение удержаний (минуты возвращаются, пункт hold_expired) и заявок «четыре глаза» (72 ч);
6. повторы фискализации Click; проверки сверки tick-вида;
7. чистка provider_calls (90 дней), stars_pre_checkouts (30 дней), ключей идемпотентности; начальная загрузка
   проекции, если не завершена.
"""

from __future__ import annotations

import logging
import uuid
import zlib
from datetime import datetime, timedelta
from typing import Any, Final

from sqlalchemy import delete, exists, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncConnection
from sqlalchemy.orm import aliased

from tilhero_billing.domain import adjustments, bootstrap, catalog, fiscal, minutes, orders, periods, reconciliation
from tilhero_billing.domain.common import (
    STARS_SUB_CHANGED,
    SUBSCRIPTION_EXPIRING,
    emit_event,
    is_deleted,
    iso_req,
    local_day_start,
    lock_account,
    recon_item,
    report_zone,
)
from tilhero_billing.models import (
    Idempotency,
    MinuteHold,
    Period,
    ProviderCall,
    StarsPreCheckout,
    StarsSubscription,
    TickState,
)
from tilhero_billing.settings import Settings
from tilhero_common.app import Runtime

log = logging.getLogger("tilhero.billing.tick")

TICK_LOCK_CLASS: Final = 0x42494C54  # 'BILT'
EXPIRING: Final = "expiring"
FIRST_WINDOW: Final = timedelta(minutes=10)


def tick_lock_object(schema: str | None) -> int:
    return int.from_bytes(zlib.crc32((schema or "").encode()).to_bytes(4, "big"), "big", signed=True)


async def period_steps(rt: Runtime, now: datetime, batch: int) -> int:
    """Аккаунты с истёкшим активным периодом или с очередью без активного → ensure_current."""
    active = aliased(Period)
    async with rt.transaction() as db:
        due = set((await db.execute(select(Period.account_id).where(
            Period.status == "active", Period.ends_at <= now).limit(batch))).scalars().all())
        due |= set((await db.execute(select(Period.account_id).where(
            Period.status == "scheduled", ~exists().where(active.account_id == Period.account_id,
                                                          active.status == "active")).limit(batch))).scalars().all())
    for account in due:
        async with rt.transaction() as db:
            await lock_account(db, account)
            if not await is_deleted(db, account):
                await periods.ensure_current(db, account, now)
    return len(due)


async def stars_end(rt: Runtime, settings: Settings, now: datetime, batch: int) -> int:
    grace = timedelta(minutes=settings.stars_renewal_grace_minutes)
    async with rt.transaction() as db:
        rows = (await db.execute(select(StarsSubscription.subscription_id, StarsSubscription.account_id).where(
            ((StarsSubscription.status == "canceled") & (StarsSubscription.expires_at <= now))
            | (StarsSubscription.status.in_(("active", "failed")) & (StarsSubscription.expires_at <= now - grace)))
            .limit(batch))).all()
    ended = 0
    for sub_id, account in rows:
        async with rt.transaction() as db:
            if account is not None:
                await lock_account(db, account)
            sub = await db.get(StarsSubscription, sub_id, with_for_update=True, populate_existing=True)
            if sub is None or sub.status not in periods.LIVE_STARS:
                continue
            limit = now if sub.status == "canceled" else now - grace
            if sub.expires_at > limit:
                continue
            sub.status, sub.updated_at = "ended", now
            ended += 1
            if sub.account_id is not None and not await is_deleted(db, sub.account_id):
                await db.flush()
                await emit_event(db, STARS_SUB_CHANGED, {
                    "account_id": str(sub.account_id), "subscription_id": str(sub.subscription_id),
                    "status": "ended", "expires_at": iso_req(sub.expires_at), "changed_at": iso_req(now)})
                await periods.emit_access(db, sub.account_id, now)
    return ended


async def expiring(rt: Runtime, now: datetime, batch: int) -> int:
    """Пороги «за expiring_days» и «в день окончания» (начало дня по Ташкенту), пересечённые в (last, now]."""
    async with rt.transaction() as db:
        state = await db.get(TickState, EXPIRING, with_for_update=True)
        last = state.last_run_at if state is not None else now - FIRST_WINDOW
        await db.execute(insert(TickState).values(name=EXPIRING, last_run_at=now).on_conflict_do_update(
            index_elements=["name"], set_={"last_run_at": now}))
        cat = await catalog.active_catalog(db)
        days = cat.limits["expiring_days"] if cat is not None else 3
        rows = (await db.execute(select(Period).where(
            Period.status == "active", Period.ends_at > last, Period.ends_at <= now + timedelta(days=days + 1))
            .order_by(Period.ends_at).limit(batch))).scalars().all()
        tz = report_zone()
        candidates: list[tuple[uuid.UUID, int]] = []
        for p in rows:
            assert p.ends_at is not None
            marks = {days: p.ends_at - timedelta(days=days),
                     0: local_day_start(p.ends_at.astimezone(tz).date(), tz)}
            for left, at in marks.items():
                if last < at <= now and at < p.ends_at:
                    candidates.append((p.period_id, left))
    sent = 0
    for period_id, left in candidates:
        async with rt.transaction() as db:
            found = await db.get(Period, period_id)
            if found is None:
                continue
            await lock_account(db, found.account_id)
            p = await db.get(Period, period_id, populate_existing=True)  # type: ignore[assignment]
            if p is None or p.status != "active" or p.ends_at is None or await is_deleted(db, p.account_id):
                continue
            st = await periods.account_state(db, p.account_id)
            if st.scheduled or (st.stars is not None and st.stars.status == "active"):
                continue
            await emit_event(db, SUBSCRIPTION_EXPIRING, {
                "account_id": str(p.account_id), "period_id": str(p.period_id), "ends_at": iso_req(p.ends_at),
                "days_left": left, "minutes_left": st.minutes_left})
            sent += 1
    return sent


async def expire_holds(rt: Runtime, now: datetime, batch: int) -> int:
    async with rt.transaction() as db:
        rows = (await db.execute(select(MinuteHold.hold_id, MinuteHold.account_id).where(
            MinuteHold.status == "active", MinuteHold.expires_at <= now).limit(batch))).all()
    done = 0
    for hold_id, account in rows:
        async with rt.transaction() as db:
            await lock_account(db, account)
            hold = await db.get(MinuteHold, hold_id, with_for_update=True, populate_existing=True)
            if hold is None or hold.status != "active" or hold.expires_at > now:
                continue
            await minutes.release_hold(db, hold, status="expired", at=now)
            await recon_item(db, "hold_expired", f"hold_expired:{hold_id}", at=now, period_id=hold.period_id,
                             details={"hold_id": str(hold_id), "ref_kind": hold.ref_kind, "minutes": int(hold.minutes)})
            done += 1
    return done


async def purge(rt: Runtime, settings: Settings, now: datetime) -> dict[str, int]:
    async with rt.transaction() as db:
        calls = await db.execute(delete(ProviderCall).where(
            ProviderCall.created_at < now - timedelta(days=settings.provider_calls_days)))
        pre = await db.execute(delete(StarsPreCheckout).where(
            StarsPreCheckout.answered_at < now - timedelta(days=settings.pre_checkouts_days)))
        idem = await db.execute(delete(Idempotency).where(
            Idempotency.created_at < now - timedelta(days=settings.idempotency_days)))
    return {"provider_calls_purged": int(getattr(calls, "rowcount", 0) or 0),
            "pre_checkouts_purged": int(getattr(pre, "rowcount", 0) or 0),
            "idempotency_purged": int(getattr(idem, "rowcount", 0) or 0)}


async def run(rt: Runtime, settings: Settings, now: datetime) -> dict[str, Any]:
    assert rt.db is not None
    async with rt.db.engine.connect() as conn:
        got = (await conn.execute(text("SELECT pg_try_advisory_lock(:c, :o)"),
                                  {"c": TICK_LOCK_CLASS, "o": tick_lock_object(rt.db.schema)})).scalar_one()
        await conn.commit()
        if not got:
            return {"skipped": True}
        try:
            batch = settings.tick_batch_size
            out: dict[str, Any] = {"skipped": False}
            out["orders_expired"] = await orders.expire_due(rt, now, batch)
            out["accounts_refreshed"] = await period_steps(rt, now, batch)
            out["stars_subscriptions_ended"] = await stars_end(rt, settings, now, batch)
            out["expiring_sent"] = await expiring(rt, now, batch)
            out["holds_expired"] = await expire_holds(rt, now, batch)
            async with rt.transaction() as db:
                out["adjustments_expired"] = await adjustments.expire_due(db, now, batch)
            out["fiscal_registered"] = await fiscal.retry_due(rt, now, batch)
            out["recon"] = await reconciliation.tick_checks(rt, settings, now, None, batch)
            out.update(await purge(rt, settings, now))
            out["projections_loaded"] = await bootstrap.run_pending(rt, now)
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
