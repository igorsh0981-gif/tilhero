"""Колбэки фиатных провайдеров через payments-edge — `/provider/v1/*` (поток B; INTERNAL_API спринта 8 §1.6–§1.8,
§1.17, §4).

`POST /provider/v1/payme` (любой метод — Payme ответ -32300 на не-POST), `POST /provider/v1/click/prepare | complete`,
`POST /provider/v1/uzum/{check | create | confirm | reverse | status}`. Без JWT: только с `X-Edge-Token =
PAYMENTS_EDGE_TOKEN` (постоянное время), иначе — **404, неотличимый от несуществующего маршрута** (у billing нет
публичного домена; снаружи сюда попадают только через payments-edge, который подставляет свой токен вместо
клиентского). Адрес клиента — второй справа в `X-Forwarded-For` (Railway edge + Caddy payments-edge).

Порядок: токен → лимит `pay.callback_ip` (псевдоним IP с суточной солью; отказ — в формате провайдера: Payme -32400
с HTTP 200, Click -7, Uzum 99999) → адаптер (`ProviderAdapter.handle` → `PaymentPort`) → строка `provider_calls`
(метод, код результата, время ответа, IP, номер заказа, id транзакции — без тел, подписей и учётных данных).
Непредвиденный сбой адаптера — тот же «временный отказ» в формате провайдера (Payme всегда получает HTTP 200).

Подключение (ядро A, `main.py`: модуль найден → `router` подключается сам). Порт — `app.state.payment_port`, иначе
`PaymentService(runtime)` ядра (как `api/stars.py`); нет — «временный отказ» в формате провайдера. Адаптеры —
`app.state.provider_adapters[code]` (тесты), иначе реестр ядра `runtime.billing_adapters` (фабрики `build_adapter(rt)`
модулей payme / click / uzum), иначе свои по настройкам. Журнал — `app.state.provider_call_sink`, иначе `record_call`
ядра (или `record_provider_call`, как у Stars), иначе запись в `provider_calls` напрямую. Часы — `runtime.clock`.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import cast

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from tilhero_billing.domain.ports import PaymentPort
from tilhero_billing.providers import click, payme, uzum
from tilhero_billing.providers.base import InboundCall, OutboundResponse, ProviderAdapter
from tilhero_billing.providers.common import (
    MAX_CALLBACK_BODY_BYTES,
    DbProviderCallSink,
    ProviderCallRecord,
    ProviderCallSink,
    build_fiat_adapters,
    client_ip_from_forwarded,
    core_port,
    ip_subject,
    journal_sink,
    runtime_parts,
    secret_equals,
)
from tilhero_billing.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError
from tilhero_common.internal_auth import HEADER

log = logging.getLogger("tilhero.billing.callbacks")

router = APIRouter(prefix="/provider/v1", tags=["provider-callbacks"], include_in_schema=False)

EDGE_HEADER = "x-edge-token"
RATE_POLICY = "pay.callback_ip"
ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
# заголовки, которые адаптеру не нужны и в InboundCall не передаются (токен edge уже проверен здесь)
_DROP_HEADERS = frozenset({EDGE_HEADER, HEADER, "cookie"})


def _not_found() -> StarletteHTTPException:
    # тот же ответ, что у несуществующего маршрута (обработчик ошибок tilhero_common: NOT_FOUND)
    return StarletteHTTPException(status_code=404, detail="Not Found")


def _runtime(request: Request) -> Runtime:
    return cast(Runtime, request.app.state.runtime)


def _now(rt: Runtime) -> datetime:
    clock = getattr(rt, "clock", None)
    return clock() if callable(clock) else datetime.now(UTC)


def _adapter(request: Request, provider: str) -> ProviderAdapter | None:
    """`app.state.provider_adapters` (тесты) → реестр ядра `runtime.billing_adapters` (domain/adapters.py, фабрики
    `build_adapter(rt)` этих модулей) → свои адаптеры по настройкам."""
    adapters = getattr(request.app.state, "provider_adapters", None)
    if isinstance(adapters, Mapping) and provider in adapters:
        return cast(ProviderAdapter, adapters[provider])
    rt = _runtime(request)
    registry = getattr(rt, "billing_adapters", None)
    if registry is not None:
        adapter = registry.get(provider)
        if adapter is not None and adapter.code == provider and callable(getattr(adapter, "handle", None)) \
                and adapter.__class__.__name__ != "UnavailableAdapter":
            return cast(ProviderAdapter, adapter)
    fiat = getattr(request.app.state, "fiat_adapters", None)
    if fiat is None:
        settings, sink, clock, _ = runtime_parts(rt)
        fiat = build_fiat_adapters(settings, sink=sink, clock=clock)
        request.app.state.fiat_adapters = fiat
    return cast(Mapping[str, ProviderAdapter], fiat).get(provider)


def _payment_port(request: Request) -> PaymentPort | None:
    """`app.state.payment_port` (как `api/stars.py`), иначе `PaymentService(runtime)` ядра (есть БД)."""
    port = getattr(request.app.state, "payment_port", None)
    if port is None:
        port = core_port(_runtime(request))
        if port is not None:
            request.app.state.payment_port = port
    return cast(PaymentPort | None, port)


def _sink(request: Request, payments: PaymentPort | None) -> ProviderCallSink:
    """`app.state.provider_call_sink` (тесты) → журнал порта (`record_call` ядра / `record_provider_call`) → прямая
    запись в `provider_calls`."""
    sink = getattr(request.app.state, "provider_call_sink", None)
    if sink is not None:
        return cast(ProviderCallSink, sink)
    return journal_sink(payments) or DbProviderCallSink(_runtime(request))


def _unavailable(provider: str, operation: str, body: bytes, settings: Settings) -> OutboundResponse:
    if provider == "payme":
        return payme.unavailable_response(body)
    if provider == "click":
        return click.unavailable_response(operation, body)
    return uzum.unavailable_response(settings)


def _method_label(provider: str, operation: str, body: bytes) -> str:
    return payme.rpc_method_label(body) if provider == "payme" else operation


async def _within_limit(rt: Runtime, client_ip: str | None, now: datetime) -> bool:
    """`pay.callback_ip` (600/60 с, fail open): Redis недоступен — пропускаем."""
    limiter, redis = rt.ratelimiter, rt.redis
    if limiter is None or redis is None:
        return True
    try:
        subject = await ip_subject(redis, client_ip, now=now, prefix=limiter.prefix)
    except Exception as exc:
        log.warning("callback rate limit subject unavailable", extra={"error_type": type(exc).__name__})
        return True
    try:
        await limiter.enforce(RATE_POLICY, subject)
    except ApiError as exc:
        if exc.status == 429:
            return False
    return True


async def _dispatch(request: Request, provider: str, operation: str,
                    allowed_ops: tuple[str, ...] | None = None) -> JSONResponse:
    rt = _runtime(request)
    settings = cast(Settings, rt.settings)
    if not secret_equals(request.headers.get(EDGE_HEADER), settings.payments_edge_token.get_secret_value()):
        log.warning("provider callback rejected", extra={"provider": provider, "reason": "EDGE_TOKEN_INVALID"})
        raise _not_found()
    if allowed_ops is not None and (operation not in allowed_ops or request.method != "POST"):
        raise _not_found()
    adapter = _adapter(request, provider)
    if adapter is None:
        raise _not_found()
    body = await request.body()
    if len(body) > MAX_CALLBACK_BODY_BYTES:
        raise ApiError(413, "PAYLOAD_TOO_LARGE", "Слишком большой запрос")
    started = time.perf_counter()
    now = _now(rt)
    client_ip = client_ip_from_forwarded(request.headers.get("x-forwarded-for"))
    payments = _payment_port(request)
    out: OutboundResponse
    if payments is None:
        log.error("provider callback: payment port is not wired", extra={"provider": provider})
        out = _unavailable(provider, operation, body, settings)
    elif not await _within_limit(rt, client_ip, now):
        log.warning("provider callback rate limited", extra={"provider": provider, "policy": RATE_POLICY})
        out = _unavailable(provider, operation, body, settings)
    else:
        call = InboundCall(
            provider=adapter.code,
            operation=operation,
            method=request.method,
            headers={k.lower(): v for k, v in request.headers.items() if k.lower() not in _DROP_HEADERS},
            body=body,
            content_type=request.headers.get("content-type", ""),
            client_ip=client_ip,
            received_at=now,
        )
        try:
            out = await adapter.handle(call, payments)
        except Exception as exc:  # адаптер сам переводит ошибки в коды провайдера; сюда — только непредвиденное
            log.error("provider callback failed", extra={"provider": provider, "error_type": type(exc).__name__})
            out = _unavailable(provider, operation, body, settings)
    latency_ms = max(0, int((time.perf_counter() - started) * 1000))
    method = _method_label(provider, operation, body)
    try:
        await _sink(request, payments).record(ProviderCallRecord(
            provider=provider, direction="in", method=method, result_code=out.result_code[:40], latency_ms=latency_ms,
            provider_txn_id=out.provider_txn_id, order_no=out.order_no, client_ip=client_ip))
    except Exception as exc:  # журнал — только метаданные; ответ провайдеру от него не зависит
        log.warning("provider call journal failed", extra={"provider": provider, "error_type": type(exc).__name__})
    log.info("provider callback", extra={"provider": provider, "rpc_method": method, "result_code": out.result_code,
                                         "duration_ms": latency_ms})
    return JSONResponse(dict(out.body), status_code=out.status_code, headers={"Cache-Control": "no-store"})




@router.api_route("/payme", methods=ALL_METHODS)
async def payme_callback(request: Request) -> JSONResponse:
    """Payme Merchant API (JSON-RPC 2.0, ответ всегда HTTP 200)."""
    return await _dispatch(request, "payme", "rpc")


@router.api_route("/click/{op}", methods=ALL_METHODS)
async def click_callback(op: str, request: Request) -> JSONResponse:
    """Click SHOP API: `prepare` | `complete` (form-urlencoded → JSON, HTTP 200)."""
    return await _dispatch(request, "click", op, click.OPERATIONS)


@router.api_route("/uzum/{op}", methods=ALL_METHODS)
async def uzum_callback(op: str, request: Request) -> JSONResponse:
    """Uzum Merchant API (за флагом `UZUM_ENABLED`): `check` | `create` | `confirm` | `reverse` | `status`."""
    return await _dispatch(request, "uzum", op, uzum.OPERATIONS)
