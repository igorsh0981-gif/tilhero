"""Чтения админки (admin.ts «Деньги»): заказы и карточка заказа, «Тариф» аккаунта, реестр минут, возвраты, провайдеры.
Только идентификаторы, суммы, статусы; ключи провайдеров — «задан / не задан», без значений; без ПДн и Telegram ID."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing.domain import minutes, periods
from tilhero_billing.domain.common import cursor_int, cursor_time_id, encode_cursor, iso
from tilhero_billing.domain.refunds import refund_view
from tilhero_billing.models import (
    Adjustment,
    FiscalReceipt,
    MinuteHold,
    MinuteLedger,
    Order,
    Period,
    PeriodBalance,
    ProviderCall,
    ProviderTransaction,
    Refund,
    StarsSubscription,
)
from tilhero_billing.providers.base import PROVIDERS
from tilhero_billing.settings import Settings

SUCCESS_CODES = frozenset({"0", "ok", "OK", "CREATED", "CONFIRMED", "REVERSED", "200", "success"})


def order_row(o: Order) -> dict[str, Any]:
    snap = o.product_snapshot or {}
    return {"order_id": str(o.order_id), "order_no": int(o.order_no), "status": o.status, "channel": o.channel,
            "provider": o.provider, "product_code": o.product_code, "product_kind": o.product_kind,
            "product_title": snap.get("title") or {}, "currency": o.currency, "amount_tiyin": o.amount_tiyin,
            "amount_stars": o.amount_stars, "account_id": str(o.account_id) if o.account_id else None,
            "beneficiary_id": str(o.beneficiary_id) if o.beneficiary_id else None, "created_at": iso(o.created_at),
            "expires_at": iso(o.expires_at), "paid_at": iso(o.paid_at), "fulfilled_at": iso(o.fulfilled_at),
            "closed_at": iso(o.closed_at)}


def txn_row(t: ProviderTransaction) -> dict[str, Any]:
    return {"txn_id": str(t.txn_id), "seq": int(t.seq), "provider": t.provider, "provider_txn_id": t.provider_txn_id,
            "state": t.state, "cancel_reason": t.cancel_reason, "provider_reason": t.provider_reason,
            "amount_tiyin": t.amount_tiyin, "amount_stars": t.amount_stars, "provider_time": iso(t.provider_time),
            "created_at": iso(t.created_at), "performed_at": iso(t.performed_at), "cancelled_at": iso(t.cancelled_at)}


def receipt_row(r: FiscalReceipt) -> dict[str, Any]:
    return {"receipt_id": str(r.receipt_id), "txn_id": str(r.txn_id), "kind": r.kind, "source": r.source,
            "status": r.status, "fiscal_receipt_id": r.fiscal_receipt_id, "terminal_id": r.terminal_id,
            "fiscal_sign": r.fiscal_sign, "qr_code_url": r.qr_code_url, "status_code": r.status_code,
            "message": r.message, "attempts": int(r.attempts), "registered_at": iso(r.registered_at),
            "created_at": iso(r.created_at)}


async def stars_row(db: AsyncSession, s: StarsSubscription | None) -> dict[str, Any] | None:
    if s is None:
        return None
    first_no = await db.scalar(select(Order.order_no).where(Order.order_id == s.first_order_id))
    return {"subscription_id": str(s.subscription_id), "product_code": s.product_code, "status": s.status,
            "amount_stars": int(s.amount_stars), "expires_at": iso(s.expires_at), "renewals": int(s.renewals),
            "first_order_no": int(first_no or 0), "created_at": iso(s.created_at), "updated_at": iso(s.updated_at)}


async def orders_page(db: AsyncSession, filters: dict[str, Any], cursor: str | None,
                      limit: int) -> tuple[list[dict[str, Any]], str | None]:
    stmt = select(Order)
    for key in ("status", "channel", "provider", "product_kind", "account_id"):
        if filters.get(key) is not None:
            stmt = stmt.where(getattr(Order, key) == filters[key])
    if filters.get("order_no") is not None:
        stmt = stmt.where(Order.order_no == filters["order_no"])
    if filters.get("from") is not None:
        stmt = stmt.where(Order.created_at >= filters["from"])
    if filters.get("to") is not None:
        stmt = stmt.where(Order.created_at < filters["to"])
    if filters.get("provider_txn_id"):
        stmt = stmt.where(Order.order_id.in_(select(ProviderTransaction.order_id).where(
            ProviderTransaction.provider_txn_id == filters["provider_txn_id"])))
    after = cursor_time_id(cursor)
    if after is not None:
        ts, oid = after
        stmt = stmt.where((Order.created_at < ts) | ((Order.created_at == ts) & (Order.order_id < oid)))
    rows = list((await db.execute(stmt.order_by(Order.created_at.desc(), Order.order_id.desc())
                                  .limit(limit + 1))).scalars().all())
    nxt = encode_cursor(iso(rows[limit - 1].created_at), rows[limit - 1].order_id) if len(rows) > limit else None
    return [order_row(o) for o in rows[:limit]], nxt


async def order_card(db: AsyncSession, order: Order) -> dict[str, Any]:
    txns = (await db.execute(select(ProviderTransaction).where(ProviderTransaction.order_id == order.order_id)
                             .order_by(ProviderTransaction.seq))).scalars().all()
    receipts = (await db.execute(select(FiscalReceipt).where(FiscalReceipt.txn_id.in_([t.txn_id for t in txns]))
                                 .order_by(FiscalReceipt.created_at))).scalars().all() if txns else []
    refunds = (await db.execute(select(Refund).where(Refund.order_id == order.order_id)
                                .order_by(Refund.requested_at))).scalars().all()
    by_txn = {t.txn_id: t for t in txns}
    from tilhero_billing.domain.refunds import stars_subscription_of

    sub = await stars_subscription_of(db, order)
    calls = (await db.execute(select(ProviderCall).where(ProviderCall.order_no == order.order_no)
                              .order_by(ProviderCall.call_id.desc()).limit(50))).scalars().all()
    performed = any(t.state == "performed" for t in txns)
    live_refund = any(r.status in ("awaiting_provider", "completed") for r in refunds)
    return {**order_row(order), "offer_version": order.offer_version, "locale": order.locale,
            "start_mode": order.start_mode, "stars_mode": order.stars_mode,
            "product_snapshot": order.product_snapshot or {}, "transactions": [txn_row(t) for t in txns],
            "receipts": [receipt_row(r) for r in receipts],
            "refunds": [refund_view(r, order, by_txn.get(r.txn_id)) for r in refunds],
            "stars_subscription": await stars_row(db, sub),
            "provider_calls": [{"call_id": int(c.call_id), "provider": c.provider, "direction": c.direction,
                                "method": c.method, "result_code": c.result_code, "latency_ms": int(c.latency_ms),
                                "created_at": iso(c.created_at)} for c in calls],
            "can_refund": order.status in ("paid", "fulfilled") and performed and not live_refund}


def _period_row(p: Period, bal: PeriodBalance | None, order_no: int | None) -> dict[str, Any]:
    return {"period_id": str(p.period_id), "product_code": p.product_code, "source": p.source, "status": p.status,
            "features": sorted(p.features), "minutes_granted": int(p.minutes_granted), "days": int(p.days),
            "starts_at": iso(p.starts_at), "ends_at": iso(p.ends_at), "created_at": iso(p.created_at),
            "closed_at": iso(p.closed_at), "close_reason": p.close_reason, "order_no": order_no,
            "balance": {"granted": int(bal.granted), "spent": int(bal.spent), "removed": int(bal.removed),
                        "held": int(bal.held), "overage": int(bal.overage),
                        "minutes_left": minutes.available(bal)} if bal is not None else None}


async def account_view(db: AsyncSession, account_id: uuid.UUID, now: datetime) -> dict[str, Any]:
    """AdminBillingAccount — вкладка «Тариф» (последние 20 периодов, активные удержания, подписка Stars)."""
    st = await periods.account_state(db, account_id)
    rows = (await db.execute(select(Period, PeriodBalance, Order.order_no)
                             .join(PeriodBalance, PeriodBalance.period_id == Period.period_id, isouter=True)
                             .join(Order, Order.order_id == Period.order_id, isouter=True)
                             .where(Period.account_id == account_id)
                             .order_by(Period.created_at.desc()).limit(20))).all()
    items = [_period_row(p, b, int(no) if no is not None else None) for p, b, no in rows]
    current = next((i for i in items if i["status"] == "active"), None)
    holds = (await db.execute(select(MinuteHold).where(MinuteHold.account_id == account_id,
                                                       MinuteHold.status == "active")
                              .order_by(MinuteHold.created_at))).scalars().all()
    pending = await db.scalar(select(func.count()).select_from(Adjustment).where(
        Adjustment.account_id == account_id, Adjustment.status == "pending"))
    stars = st.stars or await db.scalar(select(StarsSubscription).where(StarsSubscription.account_id == account_id)
                                        .order_by(StarsSubscription.created_at.desc()).limit(1))
    expiring = bool(st.active is not None and st.active.ends_at is not None and not st.scheduled
                    and (st.active.ends_at - now).days < 3)
    return {"account_id": str(account_id), "status": st.status, "tier": "paid" if st.active is not None else "free",
            "features": st.features, "expiring": expiring,
            "minutes_exhausted": st.active is not None and st.minutes_left <= 0, "trial_used": st.trial_used,
            "current_period": current, "periods": items,
            "holds": [{"hold_id": str(h.hold_id), "feature": h.feature, "ref_kind": h.ref_kind,
                       "ref_id": str(h.ref_id), "learner_id": str(h.learner_id) if h.learner_id else None,
                       "minutes": int(h.minutes), "status": h.status, "settled_minutes": h.settled_minutes,
                       "overage": h.overage, "created_at": iso(h.created_at), "expires_at": iso(h.expires_at),
                       "settled_at": iso(h.settled_at)} for h in holds],
            "stars_subscription": await stars_row(db, stars), "pending_adjustments": int(pending or 0)}


async def ledger_page(db: AsyncSession, account_id: uuid.UUID, cursor: str | None,
                      limit: int) -> tuple[list[dict[str, Any]], str | None]:
    stmt = select(MinuteLedger).where(MinuteLedger.account_id == account_id)
    after = cursor_int(cursor)
    if after is not None:
        stmt = stmt.where(MinuteLedger.seq < after)
    rows = list((await db.execute(stmt.order_by(MinuteLedger.seq.desc()).limit(limit + 1))).scalars().all())
    names: dict[str, str | None] = {}
    adj_ids = [uuid.UUID(r.ref_id) for r in rows if r.ref_kind in ("adjustment", "grant") and _is_uuid(r.ref_id)]
    if adj_ids:
        for adj_id, name in (await db.execute(select(Adjustment.adjustment_id, Adjustment.decided_by_name).where(
                Adjustment.adjustment_id.in_(adj_ids)))).all():
            names[str(adj_id)] = name
    items = [{"entry_id": str(r.entry_id), "seq": int(r.seq), "period_id": str(r.period_id), "kind": r.kind,
              "minutes": int(r.minutes), "overage": int(r.overage),
              "learner_id": str(r.learner_id) if r.learner_id else None, "ref_kind": r.ref_kind, "ref_id": r.ref_id,
              "actor": r.actor, "actor_name": "Система" if r.actor == "system" else names.get(r.ref_id),
              "created_at": iso(r.created_at)} for r in rows[:limit]]
    nxt = encode_cursor(rows[limit - 1].seq) if len(rows) > limit else None
    return items, nxt


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


async def refunds_page(db: AsyncSession, status: str | None, cursor: str | None,
                       limit: int) -> tuple[list[dict[str, Any]], str | None]:
    stmt = select(Refund, Order, ProviderTransaction).join(Order, Order.order_id == Refund.order_id).join(
        ProviderTransaction, ProviderTransaction.txn_id == Refund.txn_id)
    if status:
        stmt = stmt.where(Refund.status == status)
    after = cursor_time_id(cursor)
    if after is not None:
        ts, rid = after
        stmt = stmt.where((Refund.requested_at < ts) | ((Refund.requested_at == ts) & (Refund.refund_id < rid)))
    rows = (await db.execute(stmt.order_by(Refund.requested_at.desc(), Refund.refund_id.desc())
                             .limit(limit + 1))).all()
    nxt = encode_cursor(iso(rows[limit - 1][0].requested_at), rows[limit - 1][0].refund_id) \
        if len(rows) > limit else None
    return [refund_view(r, o, t) for r, o, t in rows[:limit]], nxt


def configured(settings: Settings, provider: str) -> bool:
    def has(*names: str) -> bool:
        for name in names:
            value = getattr(settings, name)
            raw = value.get_secret_value() if hasattr(value, "get_secret_value") else str(value)
            if not raw.strip():
                return False
        return True

    return {"telegram_stars": has("botgw_url"), "payme": has("payme_merchant_id", "payme_key"),
            "click": has("click_service_id", "click_merchant_id", "click_secret_key"),
            "uzum": has("uzum_service_id", "uzum_login", "uzum_password")}[provider]


async def providers_view(db: AsyncSession, settings: Settings) -> list[dict[str, Any]]:
    out = []
    for provider in PROVIDERS:
        last_in = await db.scalar(select(ProviderCall).where(ProviderCall.provider == provider,
                                                             ProviderCall.direction == "in")
                                  .order_by(ProviderCall.call_id.desc()).limit(1))
        last_any = await db.scalar(select(ProviderCall).where(ProviderCall.provider == provider)
                                   .order_by(ProviderCall.call_id.desc()).limit(1))
        out.append({"provider": provider, "enabled": settings.provider_enabled(provider),
                    "configured": configured(settings, provider),
                    "last_callback_at": iso(last_in.created_at) if last_in is not None else None,
                    "last_error_code": last_any.result_code if last_any is not None
                    and last_any.result_code not in SUCCESS_CODES else None})
    return out

