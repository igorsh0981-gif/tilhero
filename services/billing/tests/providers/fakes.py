"""Фейк `PaymentPort` в памяти — по контракту INTERNAL_API §1.4 (до реализации ядра потоком A и для изолированных
тестов адаптеров). Семантика: заказ ищется по номеру и каналу провайдера (не `web` — OrderNotFound), заказ другого
провайдера — OrderNotFound; проверки — флаги → заказ → статус → сумма → «в ожидании» (Payme), как ядро;
идемпотентность по `(provider, provider_txn_id)`; переходы транзакции и заказа — только §1.4; операции
сериализованы (как advisory-блокировки аккаунта и заказа)."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from tilhero_billing.domain.ports import (
    AlreadyPaid,
    AmountMismatch,
    CheckOk,
    FiscalKind,
    InvalidState,
    OrderBusy,
    OrderClosed,
    OrderNotFound,
    PaymentsDisabled,
    ReceiptTxnNotFound,
    StarsRecurrence,
    SubscriptionNotFound,
    TxnNotFound,
    TxnTimedOut,
)
from tilhero_billing.providers.base import (
    CancelReason,
    FiscalItem,
    OrderView,
    ProviderCode,
    StarsSubscriptionState,
    TxnState,
    TxnView,
)

PAYME_TIMEOUT = timedelta(milliseconds=43_200_000)
T0 = datetime(2026, 11, 22, 9, 0, tzinfo=UTC)


class Clock:
    """Внедряемые часы: тесты двигают время (таймаут Payme 12 ч и т. п.)."""

    def __init__(self, now: datetime = T0) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **kw: float) -> datetime:
        self.now = self.now + timedelta(**kw)
        return self.now


def fiscal_item(price: int = 4_900_000, **kw: Any) -> FiscalItem:
    base: dict[str, Any] = {"title": "TilHero Plus 30", "price_tiyin": price, "count": 1, "ikpu": "10305008002000000",
                            "package_code": "1545643", "vat_percent": 12, "units": 1, "tin": "123456789"}
    base.update(kw)
    return FiscalItem(**base)


@dataclass
class FakeOrder:
    order_no: int
    provider: ProviderCode = "payme"
    channel: str = "web"
    status: str = "pending"
    amount_tiyin: int = 4_900_000
    product_kind: str = "subscription"
    expires_at: datetime = T0 + timedelta(days=1)
    created_at: datetime = T0
    fiscal_items: tuple[FiscalItem, ...] = ()
    order_id: UUID = field(default_factory=uuid4)
    locale: str = "ru"

    def view(self) -> OrderView:
        return OrderView(order_id=self.order_id, order_no=self.order_no, channel=self.channel,  # type: ignore[arg-type]
                         status=self.status,  # type: ignore[arg-type]
                         product_code="plus_30d" if self.product_kind == "subscription" else "til_100",
                         product_kind=self.product_kind,  # type: ignore[arg-type]
                         title={"ru": "TilHero Плюс — 30 дней", "uz": "TilHero Plus — 30 kun"}, description=None,
                         stars_title=None, provider=self.provider, currency="UZS", amount_tiyin=self.amount_tiyin,
                         amount_stars=None, stars_mode=None, invoice_link=None, locale=self.locale,  # type: ignore[arg-type]
                         expires_at=self.expires_at, created_at=self.created_at, fiscal_items=self.fiscal_items)


@dataclass
class FakeTxn:
    seq: int
    provider: ProviderCode
    provider_txn_id: str
    order: FakeOrder
    amount_tiyin: int
    provider_time: datetime | None
    meta: dict[str, Any]
    created_at: datetime
    state: TxnState = "created"
    cancel_reason: CancelReason | None = None
    provider_reason: int | None = None
    performed_at: datetime | None = None
    cancelled_at: datetime | None = None
    txn_id: UUID = field(default_factory=uuid4)

    def view(self) -> TxnView:
        return TxnView(txn_id=self.txn_id, seq=self.seq, provider=self.provider, provider_txn_id=self.provider_txn_id,
                       order_id=self.order.order_id, order_no=self.order.order_no, amount_tiyin=self.amount_tiyin,
                       amount_stars=None, state=self.state, cancel_reason=self.cancel_reason,
                       provider_reason=self.provider_reason, provider_time=self.provider_time,
                       provider_meta=dict(self.meta), created_at=self.created_at, performed_at=self.performed_at,
                       cancelled_at=self.cancelled_at)


class FakePaymentPort:
    def __init__(self, clock: Callable[[], datetime] | None = None, *,
                 enabled: Callable[[str], bool] = lambda provider: True) -> None:
        self.clock = clock or Clock()
        self.enabled = enabled
        self.orders: dict[int, FakeOrder] = {}
        self.txns: dict[tuple[str, str], FakeTxn] = {}
        self.fiscal: dict[tuple[str, str, str], dict[str, Any]] = {}
        self.log: list[tuple[str, ...]] = []
        self.fail_on: set[str] = set()  # имена операций, которые «падают» (сбой БД)
        self.fulfilments: list[int] = []  # номера заказов, по которым выдан товар (ровно один раз)
        self._seq = 0
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------ данные теста
    def add_order(self, order_no: int = 100001, **kw: Any) -> FakeOrder:
        order = FakeOrder(order_no=order_no, **kw)
        self.orders[order_no] = order
        return order

    def _maybe_fail(self, op: str) -> None:
        self.log.append((op,))
        if op in self.fail_on:
            raise RuntimeError("database is unavailable")

    def _order(self, provider: ProviderCode, order_ref: str) -> FakeOrder:
        if not order_ref.isascii() or not order_ref.isdigit():
            raise OrderNotFound(order_ref)
        order = self.orders.get(int(order_ref))
        if order is None or order.channel != "web" or order.provider != provider:
            raise OrderNotFound(order_ref)
        return order

    def _check(self, provider: ProviderCode, order_ref: str, amount: int | None) -> FakeOrder:
        if not self.enabled(provider):
            raise PaymentsDisabled(provider)
        order = self._order(provider, order_ref)
        if order.status in ("paid", "fulfilled"):
            raise AlreadyPaid(order_ref)
        if order.status in ("cancelled", "refunded", "expired") or order.expires_at <= self.clock():
            raise OrderClosed(order_ref)
        if amount is not None and amount != order.amount_tiyin:  # как ядро: сумма (если пришла) — до «заказ занят»
            raise AmountMismatch(order_ref)
        if provider == "payme" and any(t.order is order and t.state == "created" and t.provider == "payme"
                                       for t in self.txns.values()):
            raise OrderBusy(order_ref)
        return order

    def _txn(self, provider: ProviderCode, provider_txn_id: str) -> FakeTxn:
        txn = self.txns.get((provider, provider_txn_id))
        if txn is None:
            raise TxnNotFound(provider_txn_id)
        return txn

    # ------------------------------------------------------------ PaymentPort
    async def check(self, provider: ProviderCode, order_ref: str, amount: int | None, *,
                    payer_account_id: UUID | None = None) -> CheckOk:
        async with self._lock:
            self._maybe_fail("check")
            order = self._check(provider, order_ref, amount)
            return CheckOk(order=order.view(), fiscal_items=order.fiscal_items)

    async def create(self, provider: ProviderCode, provider_txn_id: str, order_ref: str, amount: int,
                     provider_time: datetime | None, meta: Mapping[str, Any]) -> TxnView:
        async with self._lock:
            self._maybe_fail("create")
            existing = self.txns.get((provider, provider_txn_id))
            if existing is not None:
                return existing.view()
            order = self._check(provider, order_ref, amount)
            self._seq += 1
            txn = FakeTxn(seq=self._seq, provider=provider, provider_txn_id=provider_txn_id, order=order,
                          amount_tiyin=amount, provider_time=provider_time, meta=dict(meta), created_at=self.clock())
            self.txns[(provider, provider_txn_id)] = txn
            return txn.view()

    async def perform(self, provider: ProviderCode, provider_txn_id: str,
                      meta: Mapping[str, Any] | None = None) -> TxnView:
        async with self._lock:
            self._maybe_fail("perform")
            txn = self._txn(provider, provider_txn_id)
            if meta and txn.state == "created":
                txn.meta.update(meta)
            if txn.state == "performed":
                return txn.view()
            if txn.state != "created":
                raise InvalidState(txn.state)
            started = txn.provider_time or txn.created_at
            if provider == "payme" and self.clock() - started > PAYME_TIMEOUT:
                self._cancel(txn, "timeout", 4)
                raise TxnTimedOut(provider_txn_id)
            order = txn.order
            if any(t.order is order and t.state == "performed" for t in self.txns.values()):
                raise AlreadyPaid(str(order.order_no))
            if order.status in ("cancelled", "refunded"):
                raise InvalidState(order.status)
            await asyncio.sleep(0)  # точка переключения: гонки двух Perform проверяются под блокировкой
            txn.state, txn.performed_at = "performed", self.clock()
            order.status = "fulfilled" if order.product_kind == "subscription" else "paid"
            self.fulfilments.append(order.order_no)
            if provider == "click":  # прочие попытки по оплаченному заказу закрываются (§1.4)
                for other in self.txns.values():
                    if other.order is order and other is not txn and other.state == "created":
                        self._cancel(other, "order_closed", None)
            return txn.view()

    def _cancel(self, txn: FakeTxn, reason: CancelReason, provider_reason: int | None) -> None:
        if txn.state == "created":
            txn.state, txn.cancelled_at = "cancelled", self.clock()
        elif txn.state == "performed":
            txn.state, txn.cancelled_at = "refunded", self.clock()
            txn.order.status = "refunded"
        txn.cancel_reason, txn.provider_reason = reason, provider_reason

    async def paid(self, provider: ProviderCode, provider_txn_id: str, order_ref: str, amount: int, *,
                   payer_account_id: UUID | None, recurring: StarsRecurrence | None,
                   provider_time: datetime | None, meta: Mapping[str, Any]) -> TxnView:
        raise NotImplementedError("Stars — поток G")

    async def cancel(self, provider: ProviderCode, provider_txn_id: str, reason: CancelReason,
                     provider_reason: int | None) -> TxnView:
        async with self._lock:
            self._maybe_fail("cancel")
            txn = self._txn(provider, provider_txn_id)
            if txn.state in ("created", "performed"):
                self._cancel(txn, "refund" if txn.state == "performed" else reason, provider_reason)
            return txn.view()

    async def refunded(self, provider: ProviderCode, provider_txn_id: str) -> TxnView:
        async with self._lock:
            txn = self._txn(provider, provider_txn_id)
            if txn.state == "performed":
                self._cancel(txn, "refund", None)
            return txn.view()

    async def stars_subscription_state(self, order_ref: str, payer_account_id: UUID | None,
                                       state: StarsSubscriptionState) -> None:
        raise SubscriptionNotFound(order_ref)

    async def get(self, provider: ProviderCode, provider_txn_id: str) -> TxnView:
        async with self._lock:
            self._maybe_fail("get")
            return self._txn(provider, provider_txn_id).view()

    async def statement(self, provider: ProviderCode, from_: datetime, to: datetime) -> list[TxnView]:
        async with self._lock:
            self._maybe_fail("statement")
            rows = [t for t in self.txns.values()
                    if t.provider == provider and from_ <= (t.provider_time or t.created_at) <= to]
            rows.sort(key=lambda t: (t.provider_time or t.created_at, t.seq))
            return [t.view() for t in rows]

    async def store_fiscal(self, provider: ProviderCode, provider_receipt_ref: str, kind: FiscalKind,
                           data: Mapping[str, Any]) -> None:
        async with self._lock:
            if (provider, provider_receipt_ref) not in self.txns:
                raise ReceiptTxnNotFound(provider_receipt_ref)
            self.fiscal[(provider, provider_receipt_ref, kind)] = dict(data)


def provider_settings(**kw: Any) -> Any:
    """Настройки billing для тестов адаптеров: все фиатные провайдеры включены, ключи — заведомо тестовые."""
    from conftest import make_settings

    from providers.simulators import (
        CLICK_MERCHANT_ID,
        CLICK_MERCHANT_USER_ID,
        CLICK_SECRET,
        CLICK_SERVICE_ID,
        PAYME_KEY,
        PAYME_MERCHANT_ID,
        UZUM_LOGIN,
        UZUM_PASSWORD,
        UZUM_SERVICE_ID,
    )

    base: dict[str, Any] = {
        "payme_enabled": True, "click_enabled": True, "uzum_enabled": True,
        "payme_merchant_id": PAYME_MERCHANT_ID, "payme_key": PAYME_KEY,
        "click_service_id": CLICK_SERVICE_ID, "click_merchant_id": CLICK_MERCHANT_ID,
        "click_merchant_user_id": CLICK_MERCHANT_USER_ID, "click_secret_key": CLICK_SECRET,
        "click_api_url": "https://api.click.test/v2/merchant",
        "uzum_service_id": UZUM_SERVICE_ID, "uzum_login": UZUM_LOGIN, "uzum_password": UZUM_PASSWORD,
        "uzum_checkout_url_template": "https://checkout.uzum.test/pay?s={service_id}&o={order_no}&a={amount_tiyin}"
                                      "&l={locale}&r={return_url}",
        "web_pay_origin": "https://pay.tilhero.test",
    }
    base.update(kw)
    return make_settings(**base)
