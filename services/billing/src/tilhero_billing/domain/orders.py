"""Заказы и каналы (INTERNAL_API §1.3, §0.2): пара «канал — провайдер», каталог по каналу, правила подписки Stars,
сумма — только из каталога (снимок в заказе), истечение tick'ом. Канал — claim `chn` внутреннего токена telegram-bff:
miniapp — только telegram_stars и цены в Stars; web — только payme | click | uzum и цены в сумах (тийины). Канал
miniapp видит свои заказы и продления (renewal), web — только заказы сайта (анти-стиринг)."""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing.domain import adapters, catalog, learners, periods
from tilhero_billing.domain.adapters import AdapterUnavailable
from tilhero_billing.domain.common import (
    active_period_exists,
    cursor_time_id,
    days_left,
    encode_cursor,
    forfeit_confirmation_required,
    idempotency_reused,
    is_deleted,
    iso,
    lock_account,
    lock_order,
    now_of,
    offer_version_mismatch,
    order_not_found,
    order_state,
    orders_limit,
    payments_disabled,
    product_not_available,
    product_not_found,
    provider_not_allowed,
    provider_not_available,
    stars_subscription_exists,
    user_deleted,
)
from tilhero_billing.domain.learners import Caller
from tilhero_billing.models import FiscalReceipt, Order, ProviderTransaction, Refund
from tilhero_billing.providers.base import CHANNEL_PROVIDERS, FiscalItem, OrderView
from tilhero_billing.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, unprocessable

log = logging.getLogger("tilhero.billing.orders")

CHANNEL_SEES = {"miniapp": ("miniapp", "renewal"), "web": ("web",)}


@dataclass(frozen=True)
class OrderRequest:
    product_code: str
    provider: str
    start_mode: str | None
    confirm_forfeit: bool
    beneficiary_id: uuid.UUID | None
    offer_version: str
    locale: str

    def fingerprint(self) -> tuple[Any, ...]:
        return (self.product_code, self.provider, self.start_mode, self.beneficiary_id)


# ---------------------------------------------------------------- вид заказа для адаптера


def fiscal_items(order: Order) -> tuple[FiscalItem, ...]:
    """Позиция чека сайта из снимка (§1.9); реквизиты неполны (dev) или Stars — пусто."""
    snap = order.product_snapshot or {}
    fiscal = snap.get("fiscal")
    tin = snap.get("merchant_tin")
    if order.amount_tiyin is None or not catalog.fiscal_complete(fiscal) or not isinstance(tin, str):
        return ()
    assert isinstance(fiscal, dict)
    return (FiscalItem(title=str(fiscal["receipt_title"]), price_tiyin=int(order.amount_tiyin), count=1,
                       ikpu=str(fiscal["ikpu"]), package_code=str(fiscal["package_code"]),
                       vat_percent=int(fiscal["vat_percent"]),
                       units=int(fiscal["units"]) if isinstance(fiscal.get("units"), int) else None, tin=tin),)


def order_view(order: Order) -> OrderView:
    snap = order.product_snapshot or {}
    return OrderView(order_id=order.order_id, order_no=int(order.order_no), channel=order.channel,  # type: ignore[arg-type]
                     status=order.status, product_code=order.product_code,  # type: ignore[arg-type]
                     product_kind=order.product_kind, title=dict(snap.get("title") or {}),  # type: ignore[arg-type]
                     description=dict(snap["description"]) if isinstance(snap.get("description"), dict) else None,
                     stars_title=dict(snap["stars_title"]) if isinstance(snap.get("stars_title"), dict)
                     and order.currency == "XTR" else None,
                     provider=order.provider, currency=order.currency,  # type: ignore[arg-type]
                     amount_tiyin=order.amount_tiyin, amount_stars=order.amount_stars,
                     stars_mode=order.stars_mode, invoice_link=order.invoice_link,  # type: ignore[arg-type]
                     locale=order.locale, expires_at=order.expires_at,  # type: ignore[arg-type]
                     created_at=order.created_at, fiscal_items=fiscal_items(order))


def return_url(settings: Settings, order: Order) -> str | None:
    if order.channel != "web":
        return None
    return f"{settings.web_pay_origin.rstrip('/')}/orders/{order.order_no}"


# ---------------------------------------------------------------- ответы ученику (bff.ts StarsOrder, web.ts WebOrder)


def _product(order: Order) -> dict[str, Any]:
    snap = order.product_snapshot or {}
    return {"code": order.product_code, "kind": order.product_kind, "title": snap.get("title") or {}}


def _shown_status(order: Order, now: datetime) -> str:
    return "expired" if order.status == "pending" and order.expires_at <= now else order.status


async def _refund_of(db: AsyncSession, order: Order) -> Refund | None:
    return await db.scalar(select(Refund).where(Refund.order_id == order.order_id)
                           .order_by(Refund.requested_at.desc()).limit(1))


async def _receipt_url(db: AsyncSession, order: Order, kind: str) -> str | None:
    return await db.scalar(select(FiscalReceipt.qr_code_url).join(
        ProviderTransaction, ProviderTransaction.txn_id == FiscalReceipt.txn_id).where(
        ProviderTransaction.order_id == order.order_id, FiscalReceipt.kind == kind,
        FiscalReceipt.status == "registered").limit(1))


async def learner_view(db: AsyncSession, order: Order, now: datetime, *, checkout_url: str | None = None
                       ) -> dict[str, Any]:
    status = _shown_status(order, now)
    refund = await _refund_of(db, order)
    common = {"order_no": int(order.order_no), "status": status, "product": _product(order),
              "provider": order.provider, "expires_at": iso(order.expires_at), "created_at": iso(order.created_at),
              "paid_at": iso(order.paid_at)}
    if order.channel in ("miniapp", "renewal"):
        return {**common, "channel": order.channel, "currency": "XTR", "amount_stars": order.amount_stars,
                "invoice_link": order.invoice_link if status == "pending" else None,
                "refund": {"status": refund.status} if refund is not None else None}
    return {**common, "currency": "UZS", "amount_tiyin": order.amount_tiyin,
            "checkout_url": checkout_url if status == "pending" else None,
            "receipt_url": await _receipt_url(db, order, "sale"),
            "refund": {"status": refund.status, "receipt_url": await _receipt_url(db, order, "refund")}
            if refund is not None else None}


async def web_checkout(rt: Runtime, order: Order) -> str | None:
    """Ссылка на страницу провайдера для pending-заказа сайта (строит адаптер при чтении; сбой — null)."""
    if order.channel != "web" or order.status != "pending" or order.expires_at <= now_of(rt):
        return None
    try:
        out = await adapters.of(rt).get(order.provider).checkout(
            order_view(order), locale=order.locale, return_url=return_url(rt.settings, order))  # type: ignore[arg-type]
    except Exception as exc:
        log.warning("checkout url unavailable", extra={"provider": order.provider, "error_type": type(exc).__name__})
        return None
    return out.url if out.url.startswith("https://") else None


async def ensure_invoice_link(rt: Runtime, order: Order) -> str | None:
    """Stars: ссылка на счёт через адаптер (bot-gateway createInvoiceLink) — вне транзакции БД; сохраняется в заказ.
    → ссылка или None (bot-gateway недоступен — заказ остаётся pending, повтор при следующем чтении)."""
    if order.provider != "telegram_stars" or order.invoice_link or order.status != "pending":
        return order.invoice_link
    if order.expires_at <= now_of(rt):
        return None
    try:
        out = await adapters.of(rt).get("telegram_stars").checkout(order_view(order), locale=order.locale,
                                                                    return_url=None)
    except (AdapterUnavailable, Exception) as exc:
        log.warning("stars invoice link unavailable", extra={"error_type": type(exc).__name__})
        return None
    if not out.url.startswith("https://t.me/"):
        log.warning("stars invoice link rejected", extra={"code": "INVOICE_LINK_INVALID"})
        return None
    async with rt.transaction() as db:
        row = await db.get(Order, order.order_id, with_for_update=True, populate_existing=True)
        if row is not None and row.invoice_link is None and row.status == "pending":
            row.invoice_link = out.url[:500]
    order.invoice_link = out.url[:500]
    return order.invoice_link


# ---------------------------------------------------------------- создание (§1.3)


def _channel_rules(settings: Settings, channel: str, provider: str) -> None:
    if not settings.payments_enabled:
        raise payments_disabled()
    if provider not in CHANNEL_PROVIDERS.get(channel, ()):
        raise provider_not_allowed(provider, channel)
    if not settings.provider_enabled(provider):
        raise provider_not_available(provider)


async def create(rt: Runtime, caller: Caller, req: OrderRequest, idempotency_key: str) -> tuple[Order, bool]:
    """→ (заказ, создан сейчас). Повтор Idempotency-Key — тот же заказ (другие данные — 422); тот же незавершённый
    заказ без живой транзакции — он же (200)."""
    settings: Settings = rt.settings  # type: ignore[assignment]
    now = now_of(rt)
    async with rt.transaction() as db:
        await lock_account(db, caller.account_id)
        if await is_deleted(db, caller.account_id):
            raise user_deleted()
        prior = await db.scalar(select(Order).where(Order.account_id == caller.account_id,
                                                    Order.idempotency_key == idempotency_key))
        if prior is not None:
            receiver_req = req.beneficiary_id or caller.account_id
            if (prior.product_code, prior.provider, prior.beneficiary_id) != (
                    req.product_code, req.provider, receiver_req) \
                    or (prior.start_mode is not None and prior.start_mode != req.start_mode):
                raise idempotency_reused()
            return prior, False
        _channel_rules(settings, caller.channel, req.provider)
        learners.require_payer(await learners.payer_info(db, caller))
        cat = await catalog.active_catalog(db)
        product = cat.product(req.product_code) if cat is not None else None
        if cat is None or product is None:
            raise product_not_found()
        price = catalog.channel_price(product, caller.channel)
        if product.get("status") != "on_sale" or price is None:
            raise product_not_available()
        if caller.channel == "web" and req.provider not in (product.get("providers") or []):
            raise product_not_available()
        kind = str(product["kind"])
        receiver, child = await learners.beneficiary(db, caller, req.beneficiary_id, kind)
        receiver_row = await db.get(learners.Learner, receiver)
        band = await learners.effective_band(db, caller) if not child else (
            receiver_row.age_band if receiver_row else None)
        if catalog.audience_of(band, child) not in (product.get("audiences") or []):
            raise product_not_available()
        offer = cat.offer
        if req.offer_version != offer["version"]:
            raise offer_version_mismatch(offer["version"])
        stars_mode = str(product.get("stars_mode") or "one_time") if req.provider == "telegram_stars" else None
        start_mode: str | None = None
        if kind == "subscription":
            active = await periods.ensure_current(db, caller.account_id, now)
            bal = await db.get(periods.PeriodBalance, active.period_id) if active is not None else None
            if stars_mode == "subscription":
                if await periods.live_stars(db, caller.account_id) is not None:
                    raise stars_subscription_exists()
                if active is not None and active.source != "trial":
                    raise active_period_exists(active.ends_at)
                if active is not None and not req.confirm_forfeit:
                    raise forfeit_confirmation_required(periods.minutes.available(bal), days_left(active.ends_at, now))
            else:
                if req.start_mode not in ("after_current", "now"):
                    raise unprocessable("VALIDATION_ERROR", "Нужен start_mode: after_current или now",
                                        {"errors": [{"loc": ["body", "start_mode"], "msg": "required",
                                                     "type": "missing"}]})
                start_mode = req.start_mode
                if start_mode == "now" and active is not None and not req.confirm_forfeit:
                    raise forfeit_confirmation_required(periods.minutes.available(bal), days_left(active.ends_at, now))
        pending = (await db.execute(select(Order).where(
            Order.account_id == caller.account_id, Order.status == "pending", Order.expires_at > now)
            .order_by(Order.created_at))).scalars().all()
        for p in pending:
            if (p.product_code, p.provider, p.beneficiary_id, p.start_mode, p.channel) == (
                    req.product_code, req.provider, receiver, start_mode, caller.channel) \
                    and not await _live_txn(db, p.order_id):
                return p, False
        limits = cat.limits
        if len(pending) >= limits["pending_orders_max"]:
            raise orders_limit()
        ttl = limits["stars_order_ttl_minutes"] if req.provider == "telegram_stars" else limits["order_ttl_minutes"]
        order = Order(order_id=uuid.uuid4(), account_id=caller.account_id, beneficiary_id=receiver,
                      channel=caller.channel, product_code=req.product_code, product_kind=kind,
                      catalog_version=cat.version, product_snapshot=catalog.snapshot(product, cat),
                      provider=req.provider, currency="XTR" if req.provider == "telegram_stars" else "UZS",
                      amount_tiyin=price if caller.channel == "web" else None,
                      amount_stars=price if caller.channel != "web" else None, stars_mode=stars_mode,
                      invoice_link=None, start_mode=start_mode, status="pending", offer_version=offer["version"],
                      locale=req.locale, idempotency_key=idempotency_key, expires_at=now + timedelta(minutes=ttl),
                      created_at=now)
        db.add(order)
        await db.flush()
        await db.refresh(order, ["order_no"])
    return order, True


async def _live_txn(db: AsyncSession, order_id: uuid.UUID) -> bool:
    return (await db.scalar(select(ProviderTransaction.txn_id).where(
        ProviderTransaction.order_id == order_id, ProviderTransaction.state.in_(("created", "performed")))
        .limit(1))) is not None


# ---------------------------------------------------------------- чтение и отмена


async def find(db: AsyncSession, caller: Caller, order_no: int) -> Order:
    """Свой заказ своего канала; чужой или другого канала — 404 (не раскрывать существование)."""
    order = await db.scalar(select(Order).where(Order.order_no == order_no)
                            .execution_options(populate_existing=True))
    if order is None or order.account_id != caller.account_id or order.channel not in CHANNEL_SEES[caller.channel]:
        raise order_not_found()
    return order


async def page(db: AsyncSession, caller: Caller, cursor: str | None, limit: int) -> tuple[list[Order], str | None]:
    stmt = select(Order).where(Order.account_id == caller.account_id,
                               Order.channel.in_(CHANNEL_SEES[caller.channel]))
    after = cursor_time_id(cursor)
    if after is not None:
        ts, oid = after
        stmt = stmt.where((Order.created_at < ts) | ((Order.created_at == ts) & (Order.order_id < oid)))
    rows = list((await db.execute(stmt.order_by(Order.created_at.desc(), Order.order_id.desc())
                                  .limit(limit + 1))).scalars().all())
    nxt = encode_cursor(iso(rows[limit - 1].created_at), rows[limit - 1].order_id) if len(rows) > limit else None
    return rows[:limit], nxt


async def cancel(rt: Runtime, caller: Caller, order_no: int) -> Order:
    """Только pending без живой транзакции → cancelled; иначе 409 ORDER_STATE {status}."""
    now = now_of(rt)
    async with rt.transaction() as db:
        order = await find(db, caller, order_no)
        await lock_account(db, caller.account_id)
        await lock_order(db, order.order_id)
        order = await find(db, caller, order_no)
        if order.status != "pending" or await _live_txn(db, order.order_id):
            raise order_state(order.status)
        order.status, order.closed_at = "cancelled", now
    return order


async def expire_due(rt: Runtime, now: datetime, batch: int) -> int:
    """tick: pending с истёкшим сроком → expired (каждый заказ — своя короткая транзакция под блокировками
    «аккаунт → заказ»). Уже созданную у Payme/Click транзакцию провайдер может провести в пределах своего таймаута
    (expired → paid | fulfilled)."""
    async with rt.transaction() as db:
        ids = (await db.execute(select(Order.order_id, Order.account_id).where(
            Order.status == "pending", Order.expires_at <= now).order_by(Order.expires_at).limit(batch))).all()
    done = 0
    for order_id, account_id in ids:
        async with rt.transaction() as db:
            if account_id is not None:
                await lock_account(db, account_id)
            await lock_order(db, order_id)
            row = await db.get(Order, order_id, with_for_update=True, populate_existing=True)
            if row is not None and row.status == "pending" and row.expires_at <= now:
                row.status, row.closed_at = "expired", now
                done += 1
    return done


def order_ref_error() -> ApiError:
    return order_not_found()


async def count_pending(db: AsyncSession, account_id: uuid.UUID, now: datetime) -> int:
    return int(await db.scalar(select(func.count()).select_from(Order).where(
        Order.account_id == account_id, Order.status == "pending", Order.expires_at > now)) or 0)
