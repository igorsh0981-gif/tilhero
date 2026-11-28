"""Реализация `PaymentPort` (domain/ports.py, INTERNAL_API §1.4–1.5) — единственный путь адаптеров к данным.

Каждая операция — одна транзакция БД под advisory-блокировками аккаунта, затем заказа; «удалён?» — после блокировки;
идемпотентна по `(provider, provider_txn_id)` (Stars — telegram_payment_charge_id): повтор — тот же `TxnView`.
Проведение подписки и выдача периода с минутами — в той же транзакции; пакет тилов — заказ `paid` и событие
`billing.order.paid.v1` (gamification подтверждает `game.til_pack.credited.v1` → `fulfilled`).

Ошибки, которые ядро возвращает ПОСЛЕ фиксации записи (транзакция закоммичена, затем исключение):
- `perform`/`create` Payme старше 12 ч → отмена timeout (reason 4) и `TxnTimedOut`;
- `perform` по заказу, уже оплаченному другой попыткой (Click) → попытка `cancelled (order_closed)` и `AlreadyPaid`;
- `paid` (Stars), деньги уже получены: заказ не найден → пункт `unmatched_settlement` и `OrderNotFound`; второй платёж
  по оплаченному заказу → пункт `duplicate_payment` и `AlreadyPaid`; продление без подписки → пункт и
  `SubscriptionNotFound`. Для bot-gateway это «зафиксировано» (2xx): Telegram повторять не должен.
- `stars_subscription_state` без подписки → пункт `stars_subscription_desync` и `SubscriptionNotFound`;
- `store_fiscal` без транзакции → пункт `fiscal_missing` и `ReceiptTxnNotFound`.
Несоответствия платежа Stars (сумма, плательщик, удалённый аккаунт) не отвергаются: транзакция записывается, заказ не
выдаётся, пункт сверки (`unmatched_settlement`, `payer_mismatch`, `paid_after_deletion`) → возврат сотрудником.

Сверх протокола (для api/callbacks.py и api/stars.py потоков B и G): `record_call` (журнал provider_calls),
`recall_pre_checkout` / `remember_pre_checkout` (повтор query_id — тот же ответ).
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime, timedelta
from typing import Any, TypeVar, cast

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing.domain import learners, periods, refunds
from tilhero_billing.domain.common import (
    ORDER_PAID,
    PAYME_TIMEOUT,
    STARS_SUB_CHANGED,
    emit_event,
    is_deleted,
    iso,
    iso_req,
    lock_account,
    lock_order,
    now_of,
    recon_item,
    strip_meta,
)
from tilhero_billing.domain.orders import fiscal_items, order_view
from tilhero_billing.domain.ports import (
    AlreadyPaid,
    AmountMismatch,
    CheckOk,
    FiscalKind,
    InvalidState,
    OrderBusy,
    OrderClosed,
    OrderNotFound,
    PayerMismatch,
    PaymentError,
    PaymentsDisabled,
    ReceiptTxnNotFound,
    StarsRecurrence,
    SubscriptionExists,
    SubscriptionNotFound,
    TxnNotFound,
    TxnTimedOut,
)
from tilhero_billing.models import (
    FiscalReceipt,
    Order,
    ProviderCall,
    ProviderTransaction,
    StarsPreCheckout,
    StarsSubscription,
)
from tilhero_billing.providers.base import CancelReason, ProviderCode, StarsSubscriptionState, TxnView
from tilhero_billing.settings import Settings
from tilhero_common.app import Runtime

log = logging.getLogger("tilhero.billing.payments")

T = TypeVar("T")
STARS = "telegram_stars"
PAYLOAD_RE = re.compile(r"^o:([0-9a-fA-F-]{36})$")
ORDER_NO_RE = re.compile(r"^[0-9]{1,18}$")
STARS_DEFAULT_PERIOD = timedelta(seconds=2_592_000)


class _Deferred(Exception):
    """Ошибка порта, которую нужно поднять ПОСЛЕ фиксации транзакции (запись сохранена)."""

    def __init__(self, error: PaymentError) -> None:
        super().__init__(error.code)
        self.error = error


def txn_view(txn: ProviderTransaction, order_no: int) -> TxnView:
    return TxnView(txn_id=txn.txn_id, seq=int(txn.seq), provider=cast(ProviderCode, txn.provider),
                   provider_txn_id=txn.provider_txn_id, order_id=txn.order_id, order_no=order_no,
                   amount_tiyin=txn.amount_tiyin, amount_stars=txn.amount_stars, state=txn.state,  # type: ignore[arg-type]
                   cancel_reason=txn.cancel_reason, provider_reason=txn.provider_reason,  # type: ignore[arg-type]
                   provider_time=txn.provider_time, provider_meta=dict(txn.provider_meta or {}),
                   created_at=txn.created_at, performed_at=txn.performed_at, cancelled_at=txn.cancelled_at)


def _amount(order: Order) -> int | None:
    return order.amount_stars if order.currency == "XTR" else order.amount_tiyin


# ---------------------------------------------------------------- выдача оплаченного


async def deliver(db: AsyncSession, order: Order, now: datetime, *, ends_at: datetime | None = None,
                  stars_subscription_id: uuid.UUID | None = None, reason: str = "purchase",
                  starts_at: datetime | None = None, causation_id: str | None = None) -> None:
    """Оплачено → выдача (вызывающий держит блокировки «аккаунт → заказ»): подписка — период и минуты, заказ
    fulfilled; пакет тилов — заказ paid и событие (gamification). Событие billing.order.paid.v1 в обоих случаях."""
    assert order.account_id is not None and order.beneficiary_id is not None
    snap = order.product_snapshot or {}
    # статус и paid_at — вместе до первой записи (CHECK ck_orders_paid; переход pending | expired → fulfilled | paid)
    order.status = "fulfilled" if order.product_kind == "subscription" else "paid"
    order.paid_at = order.paid_at or now
    order.fulfilled_at = now if order.product_kind == "subscription" else None
    order.closed_at = None
    await db.flush()
    period_out: dict[str, Any] | None = None
    if order.product_kind == "subscription":
        if order.stars_mode == "subscription" and order.channel != "renewal":
            mode = "supersede_trial"
        elif order.channel == "renewal":
            mode = "queue"
        else:
            mode = "now" if order.start_mode == "now" else "queue"
        period = await periods.add_period(
            db, order.account_id, source="order", product_code=order.product_code,
            catalog_version=order.catalog_version, days=int(snap.get("days") or 30),
            minutes_granted=int(snap.get("minutes") or 1), features=list(snap.get("features") or []), mode=mode,
            now=now, reason=reason, order_id=order.order_id, stars_subscription_id=stars_subscription_id,
            starts_at=starts_at, ends_at=ends_at, causation_id=causation_id)
        period_out = {"starts_at": iso(period.starts_at), "ends_at": iso(period.ends_at)}
    payload: dict[str, Any] = {
        "order_id": str(order.order_id), "order_no": int(order.order_no), "account_id": str(order.account_id),
        "beneficiary_user_id": str(order.beneficiary_id), "channel": order.channel,
        "product_kind": order.product_kind, "product_code": order.product_code,
        "product_title": {"ru": str((snap.get("title") or {}).get("ru") or order.product_code)[:60],
                          "uz": str((snap.get("title") or {}).get("uz") or order.product_code)[:60]},
        "currency": order.currency, "amount_tiyin": order.amount_tiyin, "amount_stars": order.amount_stars,
        "provider": order.provider, "period": period_out, "paid_at": iso_req(order.paid_at)}
    if order.product_kind == "til_pack":
        payload["til"] = int(snap.get("til") or 0) or None
    await emit_event(db, ORDER_PAID, payload, causation_id=causation_id)


class PaymentService:
    """PaymentPort ядра (structural typing с domain/ports.py)."""

    def __init__(self, rt: Runtime) -> None:
        self.rt = rt

    @property
    def settings(self) -> Settings:
        return cast(Settings, self.rt.settings)

    def _now(self) -> datetime:
        return now_of(self.rt)

    async def _tx(self, fn: Callable[[AsyncSession], Awaitable[T]]) -> T:
        """Одна транзакция; _Deferred — зафиксировать и поднять ошибку порта."""
        deferred: PaymentError | None = None
        result: T | None = None
        async with self.rt.transaction() as db:
            try:
                result = await fn(db)
            except _Deferred as d:
                deferred = d.error
        if deferred is not None:
            raise deferred
        return cast(T, result)

    # ---------------------------------------------------------------- поиск и блокировки

    async def _find(self, db: AsyncSession, provider: str, order_ref: str) -> Order:
        """order_ref: фиатные — номер заказа строкой (заказ канала web); Stars — invoice_payload «o:<order_id>»
        (miniapp или renewal). Чужой канал или провайдер — OrderNotFound."""
        order: Order | None = None
        ref = str(order_ref).strip()
        if provider == STARS:
            m = PAYLOAD_RE.match(ref)
            if m:
                order = await db.get(Order, uuid.UUID(m.group(1)))
            if order is not None and order.channel not in ("miniapp", "renewal"):
                order = None
        elif ORDER_NO_RE.match(ref):
            order = await db.scalar(select(Order).where(Order.order_no == int(ref)))
            if order is not None and order.channel != "web":
                order = None
        if order is None or order.provider != provider:
            raise OrderNotFound()
        return order

    async def _locked(self, db: AsyncSession, order: Order) -> Order:
        """Блокировки «аккаунт → заказ» и свежая строка заказа."""
        if order.account_id is not None:
            await lock_account(db, order.account_id)
        await lock_order(db, order.order_id)
        fresh = await db.get(Order, order.order_id, with_for_update=True, populate_existing=True)
        assert fresh is not None
        return fresh

    async def _txn(self, db: AsyncSession, provider: str, provider_txn_id: str, *,
                   lock: bool = False) -> ProviderTransaction | None:
        stmt = select(ProviderTransaction).where(ProviderTransaction.provider == provider,
                                                 ProviderTransaction.provider_txn_id == provider_txn_id)
        if lock:
            stmt = stmt.with_for_update()
        return await db.scalar(stmt.execution_options(populate_existing=True))

    async def _txn_locked(self, db: AsyncSession, provider: str, provider_txn_id: str
                          ) -> tuple[ProviderTransaction, Order]:
        txn = await self._txn(db, provider, provider_txn_id)
        if txn is None:
            raise TxnNotFound()
        order = await db.get(Order, txn.order_id)
        assert order is not None
        order = await self._locked(db, order)
        txn = await self._txn(db, provider, provider_txn_id, lock=True)
        assert txn is not None
        return txn, order

    async def _payable(self, db: AsyncSession, order: Order, provider: str, amount: int | None,
                       payer_account_id: uuid.UUID | None) -> None:
        now = self._now()
        if order.account_id is None or await is_deleted(db, order.account_id):
            raise OrderClosed()
        if order.status in ("paid", "fulfilled"):
            raise AlreadyPaid()
        if order.status != "pending" or order.expires_at <= now:
            raise OrderClosed()
        if amount is not None and int(amount) != _amount(order):
            raise AmountMismatch()
        if provider == "payme" and await db.scalar(select(ProviderTransaction.txn_id).where(
                ProviderTransaction.order_id == order.order_id, ProviderTransaction.state == "created").limit(1)):
            raise OrderBusy()
        if provider == STARS:
            if payer_account_id is None or payer_account_id != order.account_id \
                    or not await learners.payer_still_allowed(db, order.account_id):
                raise PayerMismatch()
            if order.stars_mode == "subscription" and await periods.live_stars(db, order.account_id) is not None:
                raise SubscriptionExists()

    def _timed_out(self, txn: ProviderTransaction) -> bool:
        started = txn.provider_time or txn.created_at
        return txn.provider == "payme" and self._now() - started > PAYME_TIMEOUT

    async def _cancel_created(self, db: AsyncSession, txn: ProviderTransaction, reason: str,
                              provider_reason: int | None) -> None:
        txn.state, txn.cancel_reason, txn.cancelled_at = "cancelled", reason, self._now()
        if provider_reason is not None:
            txn.provider_reason = provider_reason
        await db.flush()

    # ---------------------------------------------------------------- PaymentPort

    async def check(self, provider: ProviderCode, order_ref: str, amount: int | None, *,
                    payer_account_id: uuid.UUID | None = None) -> CheckOk:
        if provider != STARS and not self.settings.provider_enabled(provider):
            raise PaymentsDisabled()

        async def run(db: AsyncSession) -> CheckOk:
            order = await self._locked(db, await self._find(db, provider, order_ref))
            if provider == STARS:
                # pre-checkout продления (§14 S2): payload первого заказа живой подписки того же плательщика
                sub = await db.scalar(select(StarsSubscription).where(
                    StarsSubscription.first_order_id == order.order_id,
                    StarsSubscription.status.in_(periods.LIVE_STARS)))
                if sub is not None:
                    if payer_account_id is None or payer_account_id != sub.account_id:
                        raise PayerMismatch()
                    if amount is not None and int(amount) != sub.amount_stars:
                        raise AmountMismatch()
                    return CheckOk(order=order_view(order), fiscal_items=())
                if not self.settings.provider_enabled(provider):
                    raise PaymentsDisabled()
            await self._payable(db, order, provider, amount, payer_account_id)
            return CheckOk(order=order_view(order), fiscal_items=fiscal_items(order))

        return await self._tx(run)

    async def create(self, provider: ProviderCode, provider_txn_id: str, order_ref: str, amount: int,
                     provider_time: datetime | None, meta: Mapping[str, Any]) -> TxnView:
        async def run(db: AsyncSession) -> TxnView:
            existing = await self._txn(db, provider, provider_txn_id)
            if existing is None:
                if not self.settings.provider_enabled(provider):
                    raise PaymentsDisabled()
                order = await self._locked(db, await self._find(db, provider, order_ref))
                existing = await self._txn(db, provider, provider_txn_id, lock=True)
                if existing is None:
                    await self._payable(db, order, provider, amount, None)
                    txn = ProviderTransaction(
                        txn_id=uuid.uuid4(), provider=provider, provider_txn_id=provider_txn_id[:128],
                        order_id=order.order_id, amount_tiyin=int(amount), amount_stars=None, state="created",
                        provider_time=provider_time, provider_meta=strip_meta(dict(meta)), created_at=self._now())
                    db.add(txn)
                    await db.flush()
                    await db.refresh(txn, ["seq"])
                    return txn_view(txn, int(order.order_no))
            txn, order = await self._txn_locked(db, provider, provider_txn_id)
            if txn.state == "created" and self._timed_out(txn):
                await self._cancel_created(db, txn, "timeout", 4)
                raise _Deferred(TxnTimedOut())
            return txn_view(txn, int(order.order_no))

        return await self._tx(run)

    async def perform(self, provider: ProviderCode, provider_txn_id: str,
                      meta: Mapping[str, Any] | None = None) -> TxnView:
        extra = strip_meta(dict(meta)) if meta else {}

        async def run(db: AsyncSession) -> TxnView:
            txn, order = await self._txn_locked(db, provider, provider_txn_id)
            if txn.state == "performed":
                return txn_view(txn, int(order.order_no))
            if txn.state != "created":
                raise InvalidState()
            if self._timed_out(txn):
                await self._cancel_created(db, txn, "timeout", 4)
                raise _Deferred(TxnTimedOut())
            if order.status in ("paid", "fulfilled", "refunded"):
                await self._cancel_created(db, txn, "order_closed", None)
                raise _Deferred(AlreadyPaid())
            if order.status == "cancelled" or order.account_id is None or await is_deleted(db, order.account_id):
                await self._cancel_created(db, txn, "order_closed", None)
                raise _Deferred(InvalidState())
            now = self._now()
            txn.state, txn.performed_at = "performed", now
            if extra:
                txn.provider_meta = {**dict(txn.provider_meta or {}), **extra}
            await db.flush()
            await deliver(db, order, now)
            if provider == "click":
                db.add(FiscalReceipt(receipt_id=uuid.uuid4(), txn_id=txn.txn_id, kind="sale", source="click_ofd",
                                     status="pending", attempts=0, next_attempt_at=now, created_at=now,
                                     updated_at=now))
                await db.flush()
            return txn_view(txn, int(order.order_no))

        return await self._tx(run)

    async def paid(self, provider: ProviderCode, provider_txn_id: str, order_ref: str, amount: int, *,
                   payer_account_id: uuid.UUID | None, recurring: StarsRecurrence | None,
                   provider_time: datetime | None, meta: Mapping[str, Any]) -> TxnView:
        first = recurring is None or not recurring.is_recurring or recurring.is_first_recurring
        clean = strip_meta(dict(meta))
        if recurring is not None:
            clean.update(is_recurring=recurring.is_recurring, is_first_recurring=recurring.is_first_recurring)

        async def run(db: AsyncSession) -> TxnView:
            now = self._now()
            existing = await self._txn(db, provider, provider_txn_id)
            if existing is not None:
                order = await db.get(Order, existing.order_id)
                assert order is not None
                return txn_view(existing, int(order.order_no))
            try:
                order = await self._find(db, provider, order_ref)
            except OrderNotFound:
                await recon_item(db, "unmatched_settlement", f"unmatched:{provider}:{provider_txn_id}", at=now,
                                 provider=provider, details={"provider_txn_id": provider_txn_id[:128],
                                                             "amount": int(amount), "reason": "order_not_found"})
                raise _Deferred(OrderNotFound()) from None
            order = await self._locked(db, order)
            existing = await self._txn(db, provider, provider_txn_id, lock=True)
            if existing is not None:
                return txn_view(existing, int(order.order_no))
            if first:
                return await self._first_payment(db, order, provider_txn_id, int(amount), payer_account_id,
                                                 recurring, provider_time, clean, now)
            return await self._renewal(db, order, provider_txn_id, int(amount), payer_account_id, recurring,
                                       provider_time, clean, now)

        return await self._tx(run)

    async def _insert_stars_txn(self, db: AsyncSession, order: Order, charge: str, amount: int,
                                provider_time: datetime | None, meta: dict[str, Any],
                                now: datetime) -> ProviderTransaction:
        txn = ProviderTransaction(txn_id=uuid.uuid4(), provider=STARS, provider_txn_id=charge[:128],
                                  order_id=order.order_id, amount_tiyin=None, amount_stars=amount, state="performed",
                                  provider_time=provider_time, provider_meta=meta, created_at=now, performed_at=now)
        db.add(txn)
        await db.flush()
        await db.refresh(txn, ["seq"])
        return txn

    async def _first_payment(self, db: AsyncSession, order: Order, charge: str, amount: int,
                             payer: uuid.UUID | None, recurring: StarsRecurrence | None,
                             provider_time: datetime | None, meta: dict[str, Any], now: datetime) -> TxnView:
        details = {"provider_txn_id": charge[:128], "amount_stars": amount}
        performed = await db.scalar(select(ProviderTransaction.txn_id).where(
            ProviderTransaction.order_id == order.order_id, ProviderTransaction.state == "performed").limit(1))
        if performed is not None:
            await recon_item(db, "duplicate_payment", f"duplicate:{STARS}:{charge}", at=now, provider=STARS,
                             order_id=order.order_id, details=details)
            raise _Deferred(AlreadyPaid())
        txn = await self._insert_stars_txn(db, order, charge, amount, provider_time, meta, now)
        view = txn_view(txn, int(order.order_no))
        deleted = order.account_id is None or await is_deleted(db, order.account_id)
        if deleted:
            await recon_item(db, "paid_after_deletion", f"paid_after_deletion:{txn.txn_id}", at=now, provider=STARS,
                             order_id=order.order_id, txn_id=txn.txn_id, details=details)
            return view
        if order.status not in ("pending", "expired"):
            kind = "duplicate_payment" if order.status in ("paid", "fulfilled", "refunded") else \
                "unmatched_settlement"
            await recon_item(db, kind, f"{kind}:{txn.txn_id}", at=now, provider=STARS, order_id=order.order_id,
                             txn_id=txn.txn_id, details={**details, "order_status": order.status})
            return view
        mismatch: str | None = None
        if payer is None or payer != order.account_id:
            mismatch = "payer_mismatch"
        elif amount != order.amount_stars:
            mismatch = "unmatched_settlement"
        elif order.stars_mode == "subscription" and await periods.live_stars(db, payer) is not None:
            mismatch = "duplicate_payment"
        if mismatch is not None:
            await recon_item(db, mismatch, f"{mismatch}:{txn.txn_id}", at=now, provider=STARS,
                             order_id=order.order_id, txn_id=txn.txn_id, details=details)
            order.status, order.paid_at, order.closed_at = "paid", now, None  # оплачено, не выдано — возврат
            await db.flush()
            return view
        sub_id: uuid.UUID | None = None
        ends_at: datetime | None = None
        if order.product_kind == "subscription" and order.stars_mode == "subscription":
            expires = recurring.subscription_expiration_date if recurring is not None else None
            if expires is None or expires <= now:
                expires = now + STARS_DEFAULT_PERIOD
            sub = StarsSubscription(subscription_id=uuid.uuid4(), account_id=order.account_id,
                                    product_code=order.product_code, first_order_id=order.order_id,
                                    first_charge_id=charge[:128], last_charge_id=charge[:128], amount_stars=amount,
                                    status="active", expires_at=expires, renewals=0, created_at=now, updated_at=now)
            db.add(sub)
            await db.flush()
            sub_id, ends_at = sub.subscription_id, expires
            await emit_event(db, STARS_SUB_CHANGED, {
                "account_id": str(order.account_id), "subscription_id": str(sub.subscription_id),
                "status": "active", "expires_at": iso_req(expires), "changed_at": iso_req(now)})
        await deliver(db, order, now, ends_at=ends_at, stars_subscription_id=sub_id)
        return view

    async def _renewal(self, db: AsyncSession, first: Order, charge: str, amount: int, payer: uuid.UUID | None,
                       recurring: StarsRecurrence | None, provider_time: datetime | None,
                       meta: dict[str, Any], now: datetime) -> TxnView:
        details = {"provider_txn_id": charge[:128], "amount_stars": amount}
        sub = await db.scalar(select(StarsSubscription).where(StarsSubscription.first_order_id == first.order_id)
                              .with_for_update().execution_options(populate_existing=True))
        if sub is None or not 1 <= amount <= 100_000:
            await recon_item(db, "unmatched_settlement", f"unmatched:{STARS}:{charge}", at=now, provider=STARS,
                             order_id=first.order_id, details={**details, "reason": "subscription_not_found"})
            raise _Deferred(SubscriptionNotFound())
        account = sub.account_id
        deleted = account is None or await is_deleted(db, account)
        mismatch = not deleted and (payer is None or payer != account)
        deliverable = not deleted and not mismatch
        snap = first.product_snapshot or {}
        order = Order(order_id=uuid.uuid4(), account_id=account, beneficiary_id=account, channel="renewal",
                      product_code=first.product_code, product_kind="subscription",
                      catalog_version=first.catalog_version, product_snapshot=snap, provider=STARS, currency="XTR",
                      amount_tiyin=None, amount_stars=amount, stars_mode="subscription",
                      stars_subscription_id=sub.subscription_id, invoice_link=None, start_mode=None,
                      status="paid", offer_version=first.offer_version, locale=first.locale,
                      idempotency_key=f"renewal:{charge}"[:200], expires_at=now, created_at=now, paid_at=now)
        db.add(order)
        await db.flush()
        await db.refresh(order, ["order_no"])
        txn = await self._insert_stars_txn(db, order, charge, amount, provider_time, meta, now)
        view = txn_view(txn, int(order.order_no))
        if not deliverable:
            kind = "paid_after_deletion" if deleted else "payer_mismatch"
            await recon_item(db, kind, f"{kind}:{txn.txn_id}", at=now, provider=STARS, order_id=order.order_id,
                             txn_id=txn.txn_id, details={**details, "renewal": True})
            return view
        assert account is not None
        expires = recurring.subscription_expiration_date if recurring is not None else None
        if expires is None or expires <= now:
            expires = max(sub.expires_at, now) + STARS_DEFAULT_PERIOD
        prev_end = await db.scalar(select(periods.Period.ends_at).where(
            periods.Period.stars_subscription_id == sub.subscription_id)
            .order_by(periods.Period.created_at.desc()).limit(1))
        starts = prev_end if prev_end is not None and now - periods.ACTIVATION_GAP <= prev_end <= now else None
        old_status = sub.status
        if old_status != "active":
            other = await periods.live_stars(db, account)
            if other is not None and other.subscription_id != sub.subscription_id:
                await recon_item(db, "stars_subscription_desync", f"stars_desync:renewal:{txn.txn_id}", at=now,
                                 provider=STARS, order_id=order.order_id, txn_id=txn.txn_id, details=details)
            else:
                sub.status = "active"
        sub.renewals += 1
        sub.last_charge_id, sub.expires_at, sub.updated_at = charge[:128], expires, now
        await db.flush()
        if sub.status != old_status:
            await emit_event(db, STARS_SUB_CHANGED, {
                "account_id": str(account), "subscription_id": str(sub.subscription_id), "status": sub.status,
                "expires_at": iso_req(expires), "changed_at": iso_req(now)})
        await deliver(db, order, now, ends_at=expires, stars_subscription_id=sub.subscription_id,
                      reason="renewal", starts_at=starts)
        return view

    async def cancel(self, provider: ProviderCode, provider_txn_id: str, reason: CancelReason,
                     provider_reason: int | None) -> TxnView:
        async def run(db: AsyncSession) -> TxnView:
            txn, order = await self._txn_locked(db, provider, provider_txn_id)
            if txn.state == "created":
                await self._cancel_created(db, txn, reason, provider_reason)
            elif txn.state == "performed":
                await refunds.provider_refunded(db, txn, order, self._now(), provider_reason=provider_reason)
            return txn_view(txn, int(order.order_no))

        return await self._tx(run)

    async def refunded(self, provider: ProviderCode, provider_txn_id: str) -> TxnView:
        async def run(db: AsyncSession) -> TxnView:
            txn, order = await self._txn_locked(db, provider, provider_txn_id)
            if txn.state == "performed":
                await refunds.provider_refunded(db, txn, order, self._now())
            elif txn.state != "refunded":
                raise InvalidState()
            return txn_view(txn, int(order.order_no))

        return await self._tx(run)

    async def stars_subscription_state(self, order_ref: str, payer_account_id: uuid.UUID | None,
                                       state: StarsSubscriptionState) -> None:
        async def run(db: AsyncSession) -> None:
            now = self._now()
            desync = f"stars_desync:update:{order_ref}:{state}:{now.date().isoformat()}"
            try:
                first = await self._find(db, STARS, order_ref)
            except OrderNotFound:
                first = None
            sub = await db.scalar(select(StarsSubscription).where(
                StarsSubscription.first_order_id == first.order_id)) if first is not None else None
            if first is None or sub is None:
                await recon_item(db, "stars_subscription_desync", desync[:300], at=now, provider=STARS,
                                 order_id=first.order_id if first else None,
                                 details={"state": state, "reason": "subscription_not_found"})
                raise _Deferred(SubscriptionNotFound())
            await self._locked(db, first)
            sub = await db.get(StarsSubscription, sub.subscription_id, with_for_update=True, populate_existing=True)
            assert sub is not None
            if payer_account_id is not None and payer_account_id != sub.account_id:
                await recon_item(db, "stars_subscription_desync", desync[:300], at=now, provider=STARS,
                                 order_id=first.order_id, details={"state": state, "reason": "payer_mismatch"})
                return
            if sub.status in ("refunded", "ended") or sub.status == state:
                return
            sub.status, sub.updated_at = state, now
            await db.flush()
            if sub.account_id is not None and not await is_deleted(db, sub.account_id):
                await emit_event(db, STARS_SUB_CHANGED, {
                    "account_id": str(sub.account_id), "subscription_id": str(sub.subscription_id), "status": state,
                    "expires_at": iso_req(sub.expires_at), "changed_at": iso_req(now)})
                await periods.emit_access(db, sub.account_id, now)

        await self._tx(run)

    async def get(self, provider: ProviderCode, provider_txn_id: str) -> TxnView:
        async with self.rt.transaction() as db:
            txn = await self._txn(db, provider, provider_txn_id)
            if txn is None:
                raise TxnNotFound()
            order_no = await db.scalar(select(Order.order_no).where(Order.order_id == txn.order_id))
            return txn_view(txn, int(order_no or 0))

    async def statement(self, provider: ProviderCode, from_: datetime, to: datetime) -> list[TxnView]:
        async with self.rt.transaction() as db:
            rows = (await db.execute(select(ProviderTransaction, Order.order_no).join(
                Order, Order.order_id == ProviderTransaction.order_id).where(
                ProviderTransaction.provider == provider, ProviderTransaction.provider_time >= from_,
                ProviderTransaction.provider_time <= to).order_by(ProviderTransaction.provider_time,
                                                                  ProviderTransaction.seq))).all()
            return [txn_view(t, int(no)) for t, no in rows]

    async def store_fiscal(self, provider: ProviderCode, provider_receipt_ref: str, kind: FiscalKind,
                           data: Mapping[str, Any]) -> None:
        """Фискальные данные чека (Payme SetFiscalData: PERFORM → sale, CANCEL → refund — отдельные записи). Ключи
        data: receipt_id | fiscal_receipt_id, terminal_id, fiscal_sign, qr_code_url (https), status_code, message.
        Чек ищется по транзакции провайдера с provider_txn_id = provider_receipt_ref (§14 P4)."""
        source = {"payme": "payme_set_fiscal_data", "click": "click_ofd", "uzum": "uzum"}.get(provider)

        async def run(db: AsyncSession) -> None:
            now = self._now()
            txn = await self._txn(db, provider, provider_receipt_ref)
            if txn is None or source is None:
                await recon_item(db, "fiscal_missing", f"fiscal_ref:{provider}:{provider_receipt_ref}:{kind}"[:300],
                                 at=now, provider=provider,
                                 details={"provider_receipt_ref": str(provider_receipt_ref)[:128], "kind": kind,
                                          "reason": "transaction_not_found"})
                raise _Deferred(ReceiptTxnNotFound())
            order = await db.get(Order, txn.order_id)
            assert order is not None
            await self._locked(db, order)
            row = await db.scalar(select(FiscalReceipt).where(FiscalReceipt.txn_id == txn.txn_id,
                                                              FiscalReceipt.kind == kind).with_for_update())
            if row is None:
                row = FiscalReceipt(receipt_id=uuid.uuid4(), txn_id=txn.txn_id, kind=kind, source=source,
                                    status="pending", attempts=0, created_at=now, updated_at=now)
                db.add(row)
            _apply_fiscal(row, data, now, provider_receipt_ref)
            await db.flush()

        await self._tx(run)

    async def update_fiscal_link(self, provider: ProviderCode, provider_txn_id: str, kind: FiscalKind,
                                 qr_code_url: str) -> bool:
        """Ссылка на зарегистрированный чек пришла позже (Click: QR после submit_items). Только https; чека нет —
        False (ничего не создаётся)."""
        if not qr_code_url.startswith("https://"):
            return False
        async with self.rt.transaction() as db:
            txn = await self._txn(db, provider, provider_txn_id)
            if txn is None:
                return False
            row = await db.scalar(select(FiscalReceipt).where(FiscalReceipt.txn_id == txn.txn_id,
                                                              FiscalReceipt.kind == kind).with_for_update())
            if row is None:
                return False
            row.qr_code_url, row.updated_at = qr_code_url[:500], self._now()
            if row.status == "registered":
                row.next_attempt_at = None
            return True

    # ---------------------------------------------------------------- сверх протокола (потоки B и G)

    async def record_call(self, provider: str, direction: str, method: str, result_code: str, latency_ms: int, *,
                          provider_txn_id: str | None = None, order_no: int | None = None,
                          client_ip: str | None = None) -> None:
        """Строка provider_calls — только метаданные (без тел, подписей, учётных данных и Telegram ID)."""
        try:
            async with self.rt.transaction() as db:
                db.add(ProviderCall(provider=provider[:20], direction=direction, method=method[:40],
                                    provider_txn_id=provider_txn_id[:128] if provider_txn_id else None,
                                    order_no=order_no, result_code=str(result_code)[:40],
                                    latency_ms=max(0, int(latency_ms)), client_ip=_ip(client_ip),
                                    created_at=self._now()))
        except Exception as exc:  # журнал не должен ломать ответ провайдеру
            log.warning("provider call not recorded", extra={"error_type": type(exc).__name__})

    async def record_provider_call(self, *, provider: str, direction: str, method: str, result_code: str,
                                   latency_ms: int, provider_txn_id: str | None = None, order_no: int | None = None,
                                   client_ip: str | None = None) -> None:
        """То же, что record_call, — именованными аргументами (api/callbacks.py потока B)."""
        await self.record_call(provider, direction, method, result_code, latency_ms, provider_txn_id=provider_txn_id,
                               order_no=order_no, client_ip=client_ip)

    async def recall_pre_checkout(self, query_id: str) -> tuple[bool, str | None] | None:
        async with self.rt.transaction() as db:
            row = await db.get(StarsPreCheckout, query_id[:128])
            return (row.ok, row.error_code) if row is not None else None

    async def remember_pre_checkout(self, query_id: str, order_ref: str | None, ok: bool,
                                    error_code: str | None) -> tuple[bool, str | None]:
        """Ответ на pre_checkout_query (повтор query_id — первый ответ). → сохранённый ответ."""
        from sqlalchemy.dialects.postgresql import insert

        m = PAYLOAD_RE.match(order_ref or "")
        async with self.rt.transaction() as db:
            await db.execute(insert(StarsPreCheckout).values(
                query_id=query_id[:128], order_id=uuid.UUID(m.group(1)) if m else None, ok=ok,
                error_code=error_code[:40] if error_code else None, answered_at=self._now())
                .on_conflict_do_nothing(index_elements=["query_id"]))
            row = await db.get(StarsPreCheckout, query_id[:128], populate_existing=True)
            assert row is not None
            return row.ok, row.error_code


def _apply_fiscal(row: FiscalReceipt, data: Mapping[str, Any], now: datetime, ref: str) -> None:
    def text(key: str, *alts: str) -> str | None:
        for k in (key, *alts):
            v = data.get(k)
            if v is not None and str(v).strip():
                return str(v)[:128]
        return None

    qr = text("qr_code_url")
    code = data.get("status_code")
    row.provider_receipt_id = row.provider_receipt_id or str(ref)[:128]
    row.fiscal_receipt_id = text("fiscal_receipt_id", "receipt_id") or row.fiscal_receipt_id
    row.terminal_id = text("terminal_id") or row.terminal_id
    row.fiscal_sign = text("fiscal_sign") or row.fiscal_sign
    row.qr_code_url = qr if qr is not None and qr.startswith("https://") else row.qr_code_url
    row.status_code = int(code) if isinstance(code, int) and not isinstance(code, bool) else row.status_code
    message = data.get("message")
    row.message = str(message)[:500] if isinstance(message, str) else row.message
    failed = row.status_code is not None and row.status_code != 0
    row.status = "failed" if failed else "registered"
    row.registered_at = None if failed else (row.registered_at or now)
    row.updated_at = now


def _ip(value: str | None) -> str | None:
    import ipaddress

    if not value:
        return None
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        return None
