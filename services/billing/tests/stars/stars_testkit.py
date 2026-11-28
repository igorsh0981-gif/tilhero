"""Помощники тестов Telegram Stars в billing (поток G): фейковый PaymentPort в памяти (до готовности ядра потока A) и
мок внутреннего API telegram-bot-gateway (httpx.MockTransport). Значения — заведомо тестовые."""

from __future__ import annotations

import asyncio
import itertools
import json
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import httpx

from tilhero_billing.domain.ports import (
    AlreadyPaid,
    AmountMismatch,
    CheckOk,
    OrderClosed,
    OrderNotFound,
    PayerMismatch,
    PaymentsDisabled,
    StarsRecurrence,
    SubscriptionExists,
    SubscriptionNotFound,
    TxnNotFound,
)
from tilhero_billing.providers.base import OrderView, StarsMode, TxnView
from tilhero_billing.providers.telegram_stars import order_payload
from tilhero_billing.settings import Settings

ACCOUNT = UUID("6f1c2a52-8d3e-4b7a-9e0f-1a2b3c4d5e6f")
OTHER_ACCOUNT = UUID("0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b")
INVOICE_LINK = "https://t.me/$TEST_invoice_link_abc"
NOW = datetime(2026, 11, 22, 9, 0, tzinfo=UTC)


def make_settings(**kw: Any) -> Settings:
    base: dict[str, Any] = {"env": "test", "internal_jwt_secret": "t" * 40, "scheduler_token": "s" * 40,
                            "payments_edge_token": "test-edge-token-" + "e" * 24, "redis_url": None,
                            "botgw_url": "http://botgw.test:8108", "stars_enabled": True}
    base.update(kw)
    return Settings(**base)


def order_view(*, mode: StarsMode = "one_time", amount: int | None = 250, kind: str | None = None,
               invoice_link: str | None = None, order_id: UUID | None = None, order_no: int = 100_001,
               title: Mapping[str, str] | None = None, stars_title: Mapping[str, str] | None = None,
               description: Mapping[str, str] | None = None, **kw: Any) -> OrderView:
    product_kind = kind or ("subscription" if mode == "subscription" else "til_pack")
    values: dict[str, Any] = {
        "order_id": order_id or uuid4(), "order_no": order_no, "channel": "miniapp", "status": "pending",
        "product_code": "plus_30d" if product_kind == "subscription" else "til_100", "product_kind": product_kind,
        "title": title or {"ru": "TilHero Плюс — 30 дней", "uz": "TilHero Plus — 30 kun"},
        "description": description if description is not None else {"ru": "300 минут уроков с ИИ",
                                                                    "uz": "300 daqiqa SI darslari"},
        "stars_title": stars_title if stars_title is not None else {"ru": "TilHero Плюс", "uz": "TilHero Plus"},
        "provider": "telegram_stars", "currency": "XTR", "amount_tiyin": None, "amount_stars": amount,
        "stars_mode": mode, "invoice_link": invoice_link, "locale": "ru", "expires_at": NOW + timedelta(hours=1),
        "created_at": NOW,
    }
    values.update(kw)
    return OrderView(**values)


def txn_view(charge: str = "stxTEST-charge-0001", *, order: OrderView | None = None, state: str = "performed",
             meta: Mapping[str, Any] | None = None) -> TxnView:
    order = order or order_view()
    return TxnView(txn_id=uuid4(), seq=1, provider="telegram_stars", provider_txn_id=charge, order_id=order.order_id,
                   order_no=order.order_no, amount_tiyin=None, amount_stars=order.amount_stars,
                   state=state,  # type: ignore[arg-type]
                   cancel_reason=None, provider_reason=None, provider_time=NOW, provider_meta=meta or {},
                   created_at=NOW, performed_at=NOW, cancelled_at=None)


# ---------------------------------------------------------------- фейковый PaymentPort (поток A — по контракту §1.4)

@dataclass
class FakeOrder:
    view: OrderView
    account_id: UUID
    expired: bool = False


@dataclass
class FakePort:
    """PaymentPort в памяти по контракту §1.4–§1.5 и поведению ядра `domain/payments.PaymentService` (заказ не найден,
    второй платёж по оплаченному заказу, продление без подписки, обновление подписки без подписки — пункт сверки и
    ошибка ПОСЛЕ фиксации) + журналы `recall_pre_checkout` / `remember_pre_checkout` / `record_call`. Идемпотентность
    по charge id и «одна выдача на заказ» — под asyncio.Lock (у ядра — UNIQUE и advisory-блокировки)."""

    orders: dict[str, FakeOrder] = field(default_factory=dict)
    txns: dict[str, TxnView] = field(default_factory=dict)
    grants: list[tuple[str, str]] = field(default_factory=list)  # (order_ref, charge) — выдачи (период / тилы)
    recon: list[tuple[str, str]] = field(default_factory=list)  # (kind, order_ref) — пункты сверки
    paid_calls: list[dict[str, Any]] = field(default_factory=list)
    subscriptions: dict[str, str] = field(default_factory=dict)  # payload первого заказа → status
    live_subscription_accounts: set[UUID] = field(default_factory=set)
    pre_checkouts: dict[str, tuple[bool, str | None]] = field(default_factory=dict)
    provider_calls: list[dict[str, Any]] = field(default_factory=list)
    disabled: bool = False
    check_delay: float = 0.0
    fail_with: Exception | None = None
    _seq: Any = field(default_factory=lambda: itertools.count(1))
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def add_order(self, view: OrderView | None = None, *, account_id: UUID = ACCOUNT, expired: bool = False) -> str:
        view = view or order_view()
        ref = order_payload(view.order_id)
        self.orders[ref] = FakeOrder(view, account_id, expired)
        return ref

    async def check(self, provider: str, order_ref: str, amount: int, *,
                    payer_account_id: UUID | None = None) -> CheckOk:
        if self.check_delay:
            await asyncio.sleep(self.check_delay)
        if self.disabled:
            raise PaymentsDisabled()
        order = self.orders.get(order_ref)
        if order is None:
            raise OrderNotFound()
        view = order.view
        if view.status in ("paid", "fulfilled"):
            # §14 S2: pre-checkout продления живой подписки того же плательщика — ок
            if self.subscriptions.get(order_ref) in ("active", "failed") and payer_account_id == order.account_id:
                return CheckOk(order=view, fiscal_items=())
            raise AlreadyPaid()
        if view.status != "pending" or order.expired:
            raise OrderClosed()
        if amount != view.amount_stars:
            raise AmountMismatch()
        if payer_account_id != order.account_id:
            raise PayerMismatch()
        if view.stars_mode == "subscription" and order.account_id in self.live_subscription_accounts:
            raise SubscriptionExists()
        return CheckOk(order=view, fiscal_items=())

    async def paid(self, provider: str, provider_txn_id: str, order_ref: str, amount: int, *,
                   payer_account_id: UUID | None, recurring: StarsRecurrence | None,
                   provider_time: datetime | None, meta: Mapping[str, Any]) -> TxnView:
        if self.fail_with is not None:
            raise self.fail_with
        self.paid_calls.append({"charge": provider_txn_id, "order_ref": order_ref, "amount": amount,
                                "payer": payer_account_id, "recurring": recurring, "time": provider_time,
                                "meta": dict(meta)})
        async with self._lock:
            await asyncio.sleep(0)  # окно для гонки параллельных вызовов
            if provider_txn_id in self.txns:
                return self.txns[provider_txn_id]
            order = self.orders.get(order_ref)
            if order is None:  # ядро: пункт сверки, затем OrderNotFound (после фиксации)
                self.recon.append(("unmatched_settlement", order_ref))
                raise OrderNotFound()
            view = order.view
            if view.status in ("paid", "fulfilled") and not (recurring and recurring.is_recurring
                                                              and not recurring.is_first_recurring):
                self.recon.append(("duplicate_payment", order_ref))  # ядро: пункт, затем AlreadyPaid
                raise AlreadyPaid()
            txn = replace(txn_view(provider_txn_id, order=view), seq=next(self._seq), amount_stars=amount,
                          provider_meta=dict(meta))
            self.txns[provider_txn_id] = txn
            if payer_account_id != order.account_id:
                self.recon.append(("payer_mismatch", order_ref))
            elif amount != view.amount_stars and not (recurring and recurring.is_recurring):
                self.recon.append(("unmatched_settlement", order_ref))
            else:
                self.grants.append((order_ref, provider_txn_id))
                order.view = replace(view, status="fulfilled")
                if view.stars_mode == "subscription":
                    self.subscriptions.setdefault(order_ref, "active")
                    self.live_subscription_accounts.add(order.account_id)
            return txn

    async def refunded(self, provider: str, provider_txn_id: str) -> TxnView:
        txn = self.txns.get(provider_txn_id)
        if txn is None:
            raise TxnNotFound()
        txn = replace(txn, state="refunded", cancelled_at=NOW)
        self.txns[provider_txn_id] = txn
        return txn

    async def stars_subscription_state(self, order_ref: str, payer_account_id: UUID | None, state: str) -> None:
        if order_ref not in self.subscriptions:
            self.recon.append(("stars_subscription_desync", order_ref))
            raise SubscriptionNotFound()
        self.subscriptions[order_ref] = state

    # ---- журналы ядра сверх PaymentPort (PreCheckoutJournal, ProviderCallJournal)
    async def recall_pre_checkout(self, query_id: str) -> tuple[bool, str | None] | None:
        return self.pre_checkouts.get(query_id)

    async def remember_pre_checkout(self, query_id: str, order_ref: str | None, ok: bool,
                                    error_code: str | None) -> tuple[bool, str | None]:
        return self.pre_checkouts.setdefault(query_id, (ok, error_code))

    async def record_call(self, provider: str, direction: str, method: str, result_code: str, latency_ms: int, *,
                          provider_txn_id: str | None = None, order_no: int | None = None,
                          client_ip: str | None = None) -> None:
        self.provider_calls.append({"provider": provider, "direction": direction, "method": method,
                                    "result_code": result_code, "latency_ms": latency_ms,
                                    "provider_txn_id": provider_txn_id, "order_no": order_no})

    # ---- прочие операции порта адаптеру Stars не нужны
    async def create(self, *a: Any, **kw: Any) -> TxnView:
        raise NotImplementedError

    async def perform(self, *a: Any, **kw: Any) -> TxnView:
        raise NotImplementedError

    async def cancel(self, *a: Any, **kw: Any) -> TxnView:
        raise NotImplementedError

    async def get(self, *a: Any, **kw: Any) -> TxnView:
        raise NotImplementedError

    async def statement(self, *a: Any, **kw: Any) -> list[TxnView]:
        raise NotImplementedError

    async def store_fiscal(self, *a: Any, **kw: Any) -> None:
        raise NotImplementedError


# ---------------------------------------------------------------- мок внутреннего API bot-gateway

@dataclass
class FakeBotGateway:
    """Внутренний API bot-gateway (§2): запоминает вызовы; ответы — очередь (status, body) | исключение, иначе ok."""

    calls: list[dict[str, Any]] = field(default_factory=list)
    queue: list[Any] = field(default_factory=list)
    statement: list[dict[str, Any]] = field(default_factory=list)

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.calls.append({"method": request.method, "path": request.url.path, "json": body,
                           "params": dict(request.url.params), "headers": dict(request.headers)})
        if self.queue:
            item = self.queue.pop(0)
            if isinstance(item, Exception):
                raise item
            status, payload = item
            return httpx.Response(status, json=payload)
        path = request.url.path
        if path.endswith("/invoice-links"):
            return httpx.Response(200, json={"invoice_link": INVOICE_LINK})
        if path.endswith("/transactions"):
            offset, limit = int(request.url.params["offset"]), int(request.url.params["limit"])
            return httpx.Response(200, json={"items": self.statement[offset:offset + limit]})
        return httpx.Response(200, json={"ok": True})

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


def gw_error(status: int, code: str, **details: Any) -> tuple[int, dict[str, Any]]:
    return status, {"code": code, "message": "x", "trace_id": "t", "details": details}


def statement_item(tx_id: str, *, date: datetime, amount: int = 250, direction: str = "in",
                   partner_type: str | None = "user", transaction_type: str | None = "invoice_payment",
                   payload: str | None = "o:00000000-0000-4000-8000-000000000001") -> dict[str, Any]:
    return {"id": tx_id, "amount": amount, "nanostar_amount": None, "date": int(date.timestamp()),
            "direction": direction, "partner_type": partner_type, "transaction_type": transaction_type,
            "invoice_payload": payload, "subscription_period": None}
