"""Сверка (INTERNAL_API §1.14, ADM-MONEY-04, AT-97): пункты `reconciliation_items` с `dedup_key` (повтор не создаёт
второй). Проверки tick-вида (каждые 5 мин, без сети) и суточные (`billing:reconcile`, ручной прогон): выписки
провайдеров через `adapter.remote_status` (вне транзакции БД), сверка остатков периодов с реестром. Денежные
последствия — только возвратом или корректировкой; разбор — `resolve` (billing.manage, заметка, аудит)."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing.domain import adapters
from tilhero_billing.domain.common import (
    cursor_time_id,
    emit_audit,
    encode_cursor,
    iso,
    lock_account,
    now_of,
    recon_item,
    staff_ref,
)
from tilhero_billing.models import (
    FiscalReceipt,
    MinuteHold,
    MinuteLedger,
    Order,
    PeriodBalance,
    ProviderTransaction,
    ReconciliationItem,
    ReconciliationRun,
    Refund,
)
from tilhero_billing.providers.base import PROVIDERS, RemoteRecord
from tilhero_billing.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, conflict, not_found
from tilhero_common.internal_auth import Actor

log = logging.getLogger("tilhero.billing.recon")

PAID_NOT_FULFILLED_AFTER = timedelta(minutes=15)
PAYME_STALE = timedelta(hours=12, minutes=15)
REFUND_STUCK_AFTER = timedelta(days=3)
FISCAL_AFTER = timedelta(hours=24)
FISCAL_LOOKBACK = timedelta(days=30)
REMOTE_WINDOW = timedelta(days=2)
STARS_LOCAL_GRACE = timedelta(hours=1)


def item_not_found() -> ApiError:
    return not_found("RECON_ITEM_NOT_FOUND", "Пункт сверки не найден")


def item_state(status: str) -> ApiError:
    del status
    return conflict("RECON_ITEM_STATE", "Пункт уже разобран")


async def tick_checks(rt: Runtime, settings: Settings, now: datetime, run_id: uuid.UUID | None = None,
                      batch: int = 500) -> dict[str, int]:
    """Быстрые проверки (без сети): оплачено, но не выполнено; зависшие транзакции; зависшие возвраты; нет чека."""
    found = {"paid_not_fulfilled": 0, "stale_created": 0, "refund_stuck": 0, "fiscal_missing": 0}
    async with rt.transaction() as db:
        for order_id, provider in (await db.execute(select(Order.order_id, Order.provider).where(
                Order.status == "paid", Order.product_kind == "til_pack",
                Order.paid_at < now - PAID_NOT_FULFILLED_AFTER).limit(batch))).all():
            found["paid_not_fulfilled"] += await recon_item(
                db, "paid_not_fulfilled", f"paid_not_fulfilled:{order_id}", at=now, provider=provider,
                order_id=order_id, run_id=run_id)
        click_after = timedelta(minutes=settings.stale_click_minutes)
        for txn_id, order_id, provider, created in (await db.execute(select(
                ProviderTransaction.txn_id, ProviderTransaction.order_id, ProviderTransaction.provider,
                ProviderTransaction.created_at).where(ProviderTransaction.state == "created").limit(batch))).all():
            limit = PAYME_STALE if provider == "payme" else click_after
            if now - created > limit:
                found["stale_created"] += await recon_item(
                    db, "stale_created", f"stale_created:{txn_id}", at=now, provider=provider, order_id=order_id,
                    txn_id=txn_id, run_id=run_id, details={"age_minutes": int((now - created).total_seconds() // 60)})
        for refund_id, order_id, txn_id in (await db.execute(select(Refund.refund_id, Refund.order_id, Refund.txn_id)
                                                             .where(Refund.status == "awaiting_provider",
                                                                    Refund.requested_at < now - REFUND_STUCK_AFTER)
                                                             .limit(batch))).all():
            found["refund_stuck"] += await recon_item(db, "refund_stuck", f"refund_stuck:{refund_id}", at=now,
                                                      order_id=order_id, txn_id=txn_id, run_id=run_id,
                                                      details={"refund_id": str(refund_id)})
        registered = exists().where(and_(FiscalReceipt.txn_id == ProviderTransaction.txn_id,
                                         FiscalReceipt.kind == "sale", FiscalReceipt.status == "registered"))
        for order_id, txn_id, provider in (await db.execute(select(
                Order.order_id, ProviderTransaction.txn_id, Order.provider).join(
                ProviderTransaction, and_(ProviderTransaction.order_id == Order.order_id,
                                          ProviderTransaction.state == "performed")).where(
                Order.channel == "web", Order.status.in_(("paid", "fulfilled")),
                Order.paid_at < now - FISCAL_AFTER, Order.paid_at > now - FISCAL_LOOKBACK, ~registered)
                .limit(batch))).all():
            found["fiscal_missing"] += await recon_item(db, "fiscal_missing", f"fiscal_missing:{txn_id}", at=now,
                                                        provider=provider, order_id=order_id, txn_id=txn_id,
                                                        run_id=run_id)
    return found


async def balance_drift(rt: Runtime, now: datetime, run_id: uuid.UUID | None, batch: int) -> int:
    """Остатки периодов ≠ суммам реестра (granted, spent, removed) или held ≠ активным удержаниям → пересчёт и пункт."""
    fixed = 0
    last: uuid.UUID | None = None
    while True:
        async with rt.transaction() as db:
            stmt = select(PeriodBalance.period_id, PeriodBalance.account_id).order_by(PeriodBalance.period_id)
            if last is not None:
                stmt = stmt.where(PeriodBalance.period_id > last)
            rows = (await db.execute(stmt.limit(batch))).all()
        if not rows:
            return fixed
        last = rows[-1][0]
        for period_id, account_id in rows:
            async with rt.transaction() as db:
                await lock_account(db, account_id)
                bal = await db.get(PeriodBalance, period_id, with_for_update=True, populate_existing=True)
                if bal is None:
                    continue
                expected = await _expected(db, period_id)
                actual = (bal.granted, bal.spent, bal.removed, bal.held)
                if expected == actual:
                    continue
                g, s, r, h = expected
                if g - s - r < 0 or h > g - s - r:
                    log.error("balance drift cannot be repaired", extra={"code": "BALANCE_DRIFT_INVALID"})
                    h = max(0, min(h, g - s - r))
                bal.granted, bal.spent, bal.removed, bal.held, bal.updated_at = g, s, r, h, now
                await recon_item(db, "balance_drift", f"balance_drift:{period_id}:{now.date().isoformat()}", at=now,
                                 period_id=period_id, run_id=run_id,
                                 details={"was": list(actual), "now": [g, s, r, h]})
                fixed += 1
        if len(rows) < batch:
            return fixed


async def _expected(db: AsyncSession, period_id: uuid.UUID) -> tuple[int, int, int, int]:
    m = MinuteLedger.minutes
    row = (await db.execute(select(
        func.coalesce(func.sum(m).filter((MinuteLedger.kind == "grant") | ((MinuteLedger.kind == "adjust") & (m > 0))),
                      0),
        func.coalesce(func.sum(-m).filter(MinuteLedger.kind == "debit"), 0),
        func.coalesce(func.sum(-m).filter(MinuteLedger.kind.in_(("expire", "revoke"))
                                          | ((MinuteLedger.kind == "adjust") & (m < 0))), 0),
    ).where(MinuteLedger.period_id == period_id))).one()
    held = await db.scalar(select(func.coalesce(func.sum(MinuteHold.minutes), 0)).where(
        MinuteHold.period_id == period_id, MinuteHold.status == "active"))
    return int(row[0]), int(row[1]), int(row[2]), int(held or 0)


async def remote(rt: Runtime, now: datetime, run_id: uuid.UUID | None) -> dict[str, int]:
    """Выписки провайдеров (адаптер; None — не умеет): Stars ↔ наши транзакции в обе стороны (stars_unmatched),
    фиатные — состояние у провайдера ≠ нашему (provider_mismatch)."""
    since = now - REMOTE_WINDOW
    out = {"stars_unmatched": 0, "provider_mismatch": 0}
    for provider in PROVIDERS:
        adapter = adapters.of(rt).get(provider)
        try:
            records = await adapter.remote_status(since)
        except Exception as exc:
            log.warning("remote status failed", extra={"provider": provider, "error_type": type(exc).__name__})
            continue
        if records is None:
            continue
        async with rt.transaction() as db:
            if provider == "telegram_stars":
                out["stars_unmatched"] += await _stars(db, records, since, now, run_id)
            else:
                out["provider_mismatch"] += await _fiat(db, provider, records, now, run_id)
    return out


async def _stars(db: AsyncSession, records: list[RemoteRecord], since: datetime, now: datetime,
                 run_id: uuid.UUID | None) -> int:
    found = 0
    seen: set[str] = set()
    for rec in records:
        if not rec.provider_txn_id:
            continue
        seen.add(rec.provider_txn_id)
        txn = await db.scalar(select(ProviderTransaction).where(
            ProviderTransaction.provider == "telegram_stars",
            ProviderTransaction.provider_txn_id == rec.provider_txn_id))
        ok = txn is not None and (rec.direction == "in" or txn.state == "refunded")
        if not ok:
            found += await recon_item(db, "stars_unmatched", f"stars_unmatched:remote:{rec.direction}:"
                                      f"{rec.provider_txn_id}", at=now, provider="telegram_stars", run_id=run_id,
                                      txn_id=txn.txn_id if txn else None,
                                      details={"side": "telegram", "direction": rec.direction,
                                               "provider_txn_id": rec.provider_txn_id[:128],
                                               "amount_stars": rec.amount_stars})
    local = (await db.execute(select(ProviderTransaction).where(
        ProviderTransaction.provider == "telegram_stars", ProviderTransaction.performed_at >= since,
        ProviderTransaction.performed_at < now - STARS_LOCAL_GRACE))).scalars().all()
    for txn in local:
        if txn.provider_txn_id not in seen:
            found += await recon_item(db, "stars_unmatched", f"stars_unmatched:local:{txn.txn_id}", at=now,
                                      provider="telegram_stars", order_id=txn.order_id, txn_id=txn.txn_id,
                                      run_id=run_id, details={"side": "billing", "amount_stars": txn.amount_stars})
    return found


async def _fiat(db: AsyncSession, provider: str, records: list[RemoteRecord], now: datetime,
                run_id: uuid.UUID | None) -> int:
    found = 0
    for rec in records:
        if not rec.provider_txn_id:
            continue
        txn = await db.scalar(select(ProviderTransaction).where(
            ProviderTransaction.provider == provider, ProviderTransaction.provider_txn_id == rec.provider_txn_id))
        if rec.state == "unknown":
            # у провайдера «платёж не найден»: расхождение, только если у нас он проведён (или возвращён)
            if txn is None or txn.state not in ("performed", "refunded"):
                continue
        if txn is None or txn.state != rec.state:
            found += await recon_item(
                db, "provider_mismatch", f"provider_mismatch:{provider}:{rec.provider_txn_id}:{rec.state}", at=now,
                provider=provider, run_id=run_id, txn_id=txn.txn_id if txn else None,
                order_id=txn.order_id if txn else None,
                details={"remote_state": rec.state, "local_state": txn.state if txn else None,
                         "provider_txn_id": rec.provider_txn_id[:128]})
    return found


async def run(rt: Runtime, kind: str) -> ReconciliationRun:
    """Полный прогон (daily / manual): быстрые проверки, выписки провайдеров, остатки периодов."""
    settings: Settings = rt.settings  # type: ignore[assignment]
    now = now_of(rt)
    run_id = uuid.uuid4()
    async with rt.transaction() as db:
        db.add(ReconciliationRun(run_id=run_id, kind=kind, started_at=now, checked=0, found=0))
    found = checked = 0
    error: str | None = None
    try:
        quick = await tick_checks(rt, settings, now, run_id, settings.tick_batch_size)
        far = await remote(rt, now, run_id)
        drift = await balance_drift(rt, now, run_id, settings.tick_batch_size)
        found = sum(quick.values()) + sum(far.values()) + drift
        checked = len(quick) + len(far) + 1
    except Exception as exc:
        error = type(exc).__name__[:64]
        log.error("reconciliation failed", extra={"error_type": error})
    async with rt.transaction() as db:
        row = await db.get(ReconciliationRun, run_id, with_for_update=True)
        assert row is not None
        row.finished_at, row.checked, row.found, row.error = now_of(rt), checked, found, error
        await db.flush()
        return row


def run_view(r: ReconciliationRun) -> dict[str, Any]:
    return {"run_id": str(r.run_id), "kind": r.kind, "started_at": iso(r.started_at),
            "finished_at": iso(r.finished_at), "checked": int(r.checked), "found": int(r.found), "error": r.error}


def item_view(i: ReconciliationItem, order_no: int | None) -> dict[str, Any]:
    return {"item_id": str(i.item_id), "run_id": str(i.run_id) if i.run_id else None, "kind": i.kind,
            "provider": i.provider, "order_id": str(i.order_id) if i.order_id else None, "order_no": order_no,
            "txn_id": str(i.txn_id) if i.txn_id else None, "period_id": str(i.period_id) if i.period_id else None,
            "details": i.details or {}, "status": i.status, "created_at": iso(i.created_at),
            "resolved_by": staff_ref(i.resolved_by, i.resolved_by_name), "resolved_at": iso(i.resolved_at),
            "note": i.note}


async def items_page(db: AsyncSession, status: str | None, kind: str | None, cursor: str | None,
                     limit: int) -> tuple[list[dict[str, Any]], str | None]:
    stmt = select(ReconciliationItem, Order.order_no).join(Order, Order.order_id == ReconciliationItem.order_id,
                                                           isouter=True)
    if status:
        stmt = stmt.where(ReconciliationItem.status == status)
    if kind:
        stmt = stmt.where(ReconciliationItem.kind == kind)
    after = cursor_time_id(cursor)
    if after is not None:
        ts, iid = after
        stmt = stmt.where((ReconciliationItem.created_at < ts)
                          | ((ReconciliationItem.created_at == ts) & (ReconciliationItem.item_id < iid)))
    rows = (await db.execute(stmt.order_by(ReconciliationItem.created_at.desc(), ReconciliationItem.item_id.desc())
                             .limit(limit + 1))).all()
    items = [item_view(i, int(no) if no is not None else None) for i, no in rows[:limit]]
    nxt = encode_cursor(iso(rows[limit - 1][0].created_at), rows[limit - 1][0].item_id) if len(rows) > limit else None
    return items, nxt


async def resolve(db: AsyncSession, actor: Actor, item_id: uuid.UUID, status: str, note: str,
                  now: datetime) -> dict[str, Any]:
    item = await db.get(ReconciliationItem, item_id, with_for_update=True, populate_existing=True)
    if item is None:
        raise item_not_found()
    if item.status != "open":
        raise item_state(item.status)
    item.status, item.note, item.resolved_by, item.resolved_at = status, note, actor.id[:80], now
    item.resolved_by_name = (actor.name or "")[:120] or None
    await db.flush()
    await emit_audit(db, actor, "billing.recon_resolved", "billing_recon_item", str(item_id),
                     before={"status": "open", "kind": item.kind}, after={"status": status}, reason=note, at=now)
    order_no = await db.scalar(select(Order.order_no).where(Order.order_id == item.order_id)) \
        if item.order_id else None
    return item_view(item, int(order_no) if order_no is not None else None)


async def open_count(db: AsyncSession) -> int:
    return int(await db.scalar(select(func.count()).select_from(ReconciliationItem)
                               .where(ReconciliationItem.status == "open")) or 0)
