"""Платёжные обновления Telegram Stars от telegram-bot-gateway (поток G) — INTERNAL_API спринта 8 §1.5, §1.17.

`POST /internal/v1/stars/pre-checkout | payments | refunds-received | subscription-updates` — **только**
`iss=telegram-bot-gateway` (иначе 403 `CALLER_NOT_ALLOWED`). Тело — уже без Telegram ID: bot-gateway перевёл его в
`account_id` (лишние поля — 422). Маршрут собирает `InboundCall` и отдаёт его адаптеру `telegram_stars`, тот — операциям
`PaymentPort` (единственный путь к данным). Ответ:
- pre-checkout — `{ok: true}` | `{ok: false, error}` не дольше 2,5 с (bot-gateway ждёт 3 с, Telegram — 10 с); дольше —
  503 `STARS_PRE_CHECKOUT_TIMEOUT`, bot-gateway отвечает пользователю «Оплата временно недоступна»;
- платёж, возврат, подписка — 200 только после фиксации; иначе не 2xx: bot-gateway отвечает Telegram 503, Telegram
  повторит обновление (billing идемпотентен по `telegram_payment_charge_id`).

Подключение (поток A, `main.py`): `routers=[…, stars.router]`. Порт — `app.state.payment_port`, иначе (есть БД)
`domain/payments.PaymentService(runtime)` ядра (+ `recall_pre_checkout` / `remember_pre_checkout`, `record_call`).
Адаптер — `app.state.provider_adapters["telegram_stars"]`, иначе реестр ядра `runtime.billing_adapters`, иначе
`providers/telegram_stars.build_adapter(runtime)` (клиент BOTGW).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, cast

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from tilhero_billing.domain.ports import PaymentPort
from tilhero_billing.providers.base import InboundCall, OutboundResponse, ProviderAdapter
from tilhero_billing.providers.telegram_stars import (
    CODE,
    OP_PAYMENT,
    OP_PRE_CHECKOUT,
    OP_REFUND_RECEIVED,
    OP_SUBSCRIPTION_UPDATE,
    PRE_CHECKOUT_BUDGET_SECONDS,
    ProviderCallJournal,
    build_adapter,
)
from tilhero_common.errors import error_body, unavailable
from tilhero_common.internal_auth import HEADER, InternalAuth, Principal

log = logging.getLogger("tilhero.billing.stars.api")
router = APIRouter(prefix="/internal/v1/stars", tags=["stars"])
bot_gateway_only = InternalAuth({"telegram-bot-gateway"})
# заголовки, которые адаптеру не нужны и в InboundCall не передаются
_DROP_HEADERS = frozenset({HEADER, "authorization", "cookie"})


def payment_port(request: Request) -> PaymentPort:
    """Реализация PaymentPort ядра: `app.state.payment_port`, иначе `PaymentService(runtime)` (есть БД); нет —
    503 (bot-gateway → Telegram повторит; pre-checkout → «Оплата временно недоступна»)."""
    port = getattr(request.app.state, "payment_port", None)
    if port is None:
        port = _core_port(request.app.state.runtime)
        if port is not None:
            request.app.state.payment_port = port
    if port is None:
        raise unavailable("BILLING_NOT_READY", "Платёжный контур не готов")
    return cast(PaymentPort, port)


def _core_port(runtime: Any) -> PaymentPort | None:
    if runtime.db is None:
        return None
    try:
        from tilhero_billing.domain.payments import PaymentService
    except ImportError:  # ядро ещё не сдано
        return None
    return cast(PaymentPort, PaymentService(runtime))


def stars_adapter(request: Request) -> ProviderAdapter:
    adapters = getattr(request.app.state, "provider_adapters", None)
    adapter = adapters.get(CODE) if isinstance(adapters, Mapping) else None
    if adapter is None:  # реестр ядра (domain/adapters.py: adapters.of(rt))
        registry = getattr(request.app.state.runtime, "billing_adapters", None)
        adapter = registry.get(CODE) if registry is not None else None
    if adapter is None:
        adapter = getattr(request.app.state, "stars_adapter", None)
    if adapter is None:
        adapter = build_adapter(request.app.state.runtime)
        request.app.state.stars_adapter = adapter
    return cast(ProviderAdapter, adapter)


async def _dispatch(request: Request, operation: str, adapter: ProviderAdapter, payments: PaymentPort, *,
                    budget: float | None = None) -> JSONResponse:
    call = InboundCall(
        provider=CODE,
        operation=operation,
        method=request.method,
        headers={k.lower(): v for k, v in request.headers.items() if k.lower() not in _DROP_HEADERS},
        body=await request.body(),
        content_type=request.headers.get("content-type", ""),
        client_ip=None,  # вызывающий — bot-gateway по приватной сети, IP Telegram здесь не виден
        received_at=datetime.now(UTC),
    )
    started = time.perf_counter()
    out: OutboundResponse
    if budget is None:
        out = await adapter.handle(call, payments)
    else:
        try:
            out = await asyncio.wait_for(adapter.handle(call, payments), budget)
        except TimeoutError:
            log.warning("stars pre-checkout over budget", extra={"budget_ms": int(budget * 1000)})
            out = OutboundResponse(status_code=503, result_code="STARS_PRE_CHECKOUT_TIMEOUT",
                                   body=error_body("STARS_PRE_CHECKOUT_TIMEOUT", "Проверка заказа не успела"))
    latency_ms = int((time.perf_counter() - started) * 1000)
    if isinstance(payments, ProviderCallJournal):
        try:
            await payments.record_call(CODE, "in", operation, out.result_code[:40], latency_ms,
                                       provider_txn_id=out.provider_txn_id, order_no=out.order_no)
        except Exception as exc:  # журнал — только метаданные; ответ bot-gateway от него не зависит
            log.warning("provider call journal failed", extra={"error_type": type(exc).__name__})
    body: dict[str, Any] = dict(out.body)
    return JSONResponse(body, status_code=out.status_code)


@router.post("/pre-checkout")
async def pre_checkout(
    request: Request,
    _: Principal = Depends(bot_gateway_only),
    adapter: ProviderAdapter = Depends(stars_adapter),
    payments: PaymentPort = Depends(payment_port),
) -> JSONResponse:
    """`{query_id, account_id | null, currency, total_amount, invoice_payload}` → `{ok}` | `{ok: false, error}`."""
    return await _dispatch(request, OP_PRE_CHECKOUT, adapter, payments, budget=PRE_CHECKOUT_BUDGET_SECONDS)


@router.post("/payments")
async def payment(
    request: Request,
    _: Principal = Depends(bot_gateway_only),
    adapter: ProviderAdapter = Depends(stars_adapter),
    payments: PaymentPort = Depends(payment_port),
) -> JSONResponse:
    """`successful_payment`: первый платёж или продление подписки (по `is_recurring` / `is_first_recurring`)."""
    return await _dispatch(request, OP_PAYMENT, adapter, payments)


@router.post("/refunds-received")
async def refund_received(
    request: Request,
    _: Principal = Depends(bot_gateway_only),
    adapter: ProviderAdapter = Depends(stars_adapter),
    payments: PaymentPort = Depends(payment_port),
) -> JSONResponse:
    """`refunded_payment`: `{telegram_payment_charge_id, total_amount, invoice_payload}`."""
    return await _dispatch(request, OP_REFUND_RECEIVED, adapter, payments)


@router.post("/subscription-updates")
async def subscription_update(
    request: Request,
    _: Principal = Depends(bot_gateway_only),
    adapter: ProviderAdapter = Depends(stars_adapter),
    payments: PaymentPort = Depends(payment_port),
) -> JSONResponse:
    """`subscription` (BotSubscriptionUpdated): `{account_id | null, invoice_payload, state}`."""
    return await _dispatch(request, OP_SUBSCRIPTION_UPDATE, adapter, payments)
