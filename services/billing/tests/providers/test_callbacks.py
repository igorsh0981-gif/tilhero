"""Маршруты колбэков `/provider/v1/*` (api/callbacks.py): X-Edge-Token (иначе 404, как несуществующий маршрут), адрес
клиента из X-Forwarded-For, лимит `pay.callback_ip`, строка `provider_calls`, отказ в формате провайдера (Payme — всегда
HTTP 200), подключение к ядру через `app.state` (как `api/stars.py`)."""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from conftest import EDGE_TOKEN
from fastapi import FastAPI

from providers.fakes import Clock, FakePaymentPort, provider_settings
from providers.simulators import ClickSim, PaymeSim, UzumSim
from tilhero_billing.api import callbacks
from tilhero_billing.providers.base import InboundCall, OutboundResponse
from tilhero_billing.providers.click import ClickAdapter
from tilhero_billing.providers.common import ProviderCallRecord, build_fiat_adapters
from tilhero_billing.providers.payme import PaymeAdapter
from tilhero_billing.providers.uzum import UzumAdapter
from tilhero_common.app import Runtime, create_app
from tilhero_common.ratelimit import Policy, RateLimiter
from tilhero_common.testing import TEST_REDIS_URL

ORDER = 100001
XFF = "6.6.6.6, 185.234.113.7, 100.64.0.9"  # клиент подделал левый; второй справа — от Railway edge


class ListSink:
    def __init__(self) -> None:
        self.records: list[ProviderCallRecord] = []

    async def record(self, rec: ProviderCallRecord) -> None:
        self.records.append(rec)


@asynccontextmanager
async def client(*, redis: bool = False, wire_port: bool = True, wire_adapters: bool = True,
                 sink: Any = None, **settings_kw: Any) -> AsyncIterator[SimpleNamespace]:
    settings = provider_settings(redis_url=TEST_REDIS_URL if redis else None, **settings_kw)
    clock = Clock()
    rt = Runtime(settings)
    rt.clock = clock  # type: ignore[attr-defined]  # часы сервиса, как у ядра (domain/common.now_of)
    app: FastAPI = create_app(settings, routers=[callbacks.router], runtime=rt)
    port = FakePaymentPort(clock, enabled=settings.provider_enabled)
    port.add_order(ORDER, amount_tiyin=4_900_000)
    port.add_order(100002, provider="click", amount_tiyin=1_500_000)
    port.add_order(100003, provider="uzum", amount_tiyin=12_900_000)
    sink = ListSink() if sink is None else sink
    if wire_port:
        app.state.payment_port = port
    if wire_adapters:
        app.state.provider_adapters = {"payme": PaymeAdapter(settings, clock=clock),
                                       "click": ClickAdapter(settings, clock=clock),
                                       "uzum": UzumAdapter(settings, clock=clock)}
    if sink is not False:
        app.state.provider_call_sink = sink
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://billing") as c:
            yield SimpleNamespace(c=c, app=app, rt=rt, port=port, sink=sink, clock=clock, settings=settings)


def edge(extra: dict[str, str] | None = None, *, token: str = EDGE_TOKEN) -> dict[str, str]:
    return {"X-Edge-Token": token, "X-Forwarded-For": XFF, **(extra or {})}


def payme_req(method: str = "CheckPerformTransaction", params: dict[str, Any] | None = None) -> tuple[bytes,
                                                                                                    dict[str, str]]:
    sim = PaymeSim()
    params = params if params is not None else {"amount": 4_900_000, "account": {"order_id": str(ORDER)}}
    return sim.body(method, params, rpc_id=1), sim.headers()


# ---------------------------------------------------------------- X-Edge-Token

@pytest.mark.parametrize("path", ["/provider/v1/payme", "/provider/v1/click/prepare", "/provider/v1/click/complete",
                                  "/provider/v1/uzum/check", "/provider/v1/uzum/status"])
@pytest.mark.parametrize("token", [None, "", "test-wrong-token-" + "e" * 24, EDGE_TOKEN[:-1]])
async def test_without_valid_edge_token_404_like_unknown_route(path: str, token: str | None) -> None:
    async with client() as env:
        headers = {} if token is None else {"X-Edge-Token": token}
        r = await env.c.post(path, content=b"{}", headers=headers)
        unknown = await env.c.post("/provider/v1/nope", content=b"{}")
        assert r.status_code == 404 and unknown.status_code == 404
        strip = lambda b: {k: v for k, v in b.items() if k != "trace_id"}  # noqa: E731
        assert strip(r.json()) == strip(unknown.json())
        assert env.port.log == [] and env.sink.records == []


async def test_empty_configured_token_disables_callbacks() -> None:
    async with client(payments_edge_token="") as env:
        r = await env.c.post("/provider/v1/payme", content=b"{}", headers={"X-Edge-Token": ""})
        assert r.status_code == 404


@pytest.mark.parametrize("path,method", [("/provider/v1/click/refund", "POST"), ("/provider/v1/uzum/pay", "POST"),
                                         ("/provider/v1/click/prepare", "GET"), ("/provider/v1/uzum/check", "PUT")])
async def test_unknown_operation_or_method_is_404(path: str, method: str) -> None:
    async with client() as env:
        r = await env.c.request(method, path, content=b"{}", headers=edge())
        assert r.status_code == 404 and env.sink.records == []


# ---------------------------------------------------------------- Payme через маршрут

async def test_payme_happy_path_and_provider_call_row() -> None:
    async with client() as env:
        body, headers = payme_req()
        r = await env.c.post("/provider/v1/payme", content=body, headers=edge(headers))
        assert r.status_code == 200 and r.json()["result"] == {"allow": True}
        assert r.headers["cache-control"] == "no-store"
        [rec] = env.sink.records
        assert rec == ProviderCallRecord(provider="payme", direction="in", method="CheckPerformTransaction",
                                         result_code="0", latency_ms=rec.latency_ms, provider_txn_id=None,
                                         order_no=ORDER, client_ip="185.234.113.7")


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE"])
async def test_payme_any_method_routed_and_answers_32300(method: str) -> None:
    async with client() as env:
        r = await env.c.request(method, "/provider/v1/payme", headers=edge())
        assert r.status_code == 200 and r.json()["error"]["code"] == -32300


async def test_payme_errors_are_http_200() -> None:
    async with client() as env:
        body, _ = payme_req()
        r = await env.c.post("/provider/v1/payme", content=body, headers=edge())  # без Basic
        assert r.status_code == 200 and r.json()["error"]["code"] == -32504
        assert env.sink.records[-1].result_code == "-32504"


async def test_ip_check_uses_second_from_right() -> None:
    async with client(payme_allowed_cidrs="185.234.113.0/24") as env:
        body, headers = payme_req()
        ok = await env.c.post("/provider/v1/payme", content=body, headers=edge(headers))
        assert "result" in ok.json()
        spoof = await env.c.post("/provider/v1/payme", content=body,
                                 headers=edge(headers) | {"X-Forwarded-For": "185.234.113.7, 8.8.8.8, 100.64.0.9"})
        assert spoof.json()["error"]["code"] == -32504
        none = await env.c.post("/provider/v1/payme", content=body,
                                headers=edge(headers) | {"X-Forwarded-For": "185.234.113.7"})
        assert none.json()["error"]["code"] == -32504


# ---------------------------------------------------------------- Click и Uzum через маршрут

async def test_click_prepare_complete_via_routes() -> None:
    async with client() as env:
        sim = ClickSim()
        prep = await env.c.post("/provider/v1/click/prepare", content=sim.encode(sim.prepare_form("7001", 100002,
                                                                                                  "15000.00")),
                                headers=edge({"Content-Type": "application/x-www-form-urlencoded"}))
        assert prep.status_code == 200 and prep.json()["error"] == 0
        comp = await env.c.post("/provider/v1/click/complete",
                                content=sim.encode(sim.complete_form("7001", 100002, "15000.00",
                                                                     prep.json()["merchant_prepare_id"])),
                                headers=edge({"Content-Type": "application/x-www-form-urlencoded"}))
        assert comp.json()["error"] == 0
        assert [(r.method, r.result_code, r.provider_txn_id, r.order_no) for r in env.sink.records] == [
            ("prepare", "0", "7001", 100002), ("complete", "0", "7001", 100002)]


async def test_uzum_via_routes() -> None:
    async with client() as env:
        sim = UzumSim()
        r = await env.c.post("/provider/v1/uzum/check", content=sim.body("check", order_no=100003),
                             headers=edge(sim.headers()))
        assert r.status_code == 200 and r.json()["status"] == "OK"
        bad = await env.c.post("/provider/v1/uzum/check", content=sim.body("check", order_no=100003),
                               headers=edge(sim.headers(password="test-wrong")))
        assert bad.status_code == 400 and bad.json()["errorCode"] == 10001
        assert [r.result_code for r in env.sink.records] == ["OK", "FAILED:10001"]


# ---------------------------------------------------------------- отказы в формате провайдера

async def test_port_not_wired_answers_in_provider_format() -> None:
    async with client(wire_port=False) as env:
        body, headers = payme_req()
        r = await env.c.post("/provider/v1/payme", content=body, headers=edge(headers))
        assert r.status_code == 200 and r.json()["error"]["code"] == -32400 and r.json()["id"] == 1
        sim = ClickSim()
        r = await env.c.post("/provider/v1/click/prepare", content=sim.encode(sim.prepare_form("1", 1, "1.00")),
                             headers=edge())
        assert r.status_code == 200 and r.json()["error"] == -7
        r = await env.c.post("/provider/v1/uzum/check", content=b"{}", headers=edge())
        assert r.status_code == 400 and r.json()["errorCode"] == 99999


@dataclass
class ExplodingAdapter:
    code: str = "payme"

    def enabled(self) -> bool:
        return True

    async def handle(self, call: InboundCall, payments: Any) -> OutboundResponse:
        raise RuntimeError("boom")


async def test_unexpected_adapter_failure_is_provider_format() -> None:
    async with client() as env:
        env.app.state.provider_adapters = {"payme": ExplodingAdapter()}
        body, headers = payme_req()
        r = await env.c.post("/provider/v1/payme", content=body, headers=edge(headers))
        assert r.status_code == 200 and r.json()["error"]["code"] == -32400


async def test_body_over_64_kib_is_413() -> None:
    async with client() as env:
        r = await env.c.post("/provider/v1/payme", content=b" " * (64 * 1024 + 1), headers=edge())
        assert r.status_code == 413 and r.json()["code"] == "PAYLOAD_TOO_LARGE"
        body, headers = payme_req()
        padded = body + b" " * (64 * 1024 - len(body))
        assert (await env.c.post("/provider/v1/payme", content=padded, headers=edge(headers))).status_code == 200


# ---------------------------------------------------------------- что видит адаптер

@dataclass
class SpyAdapter:
    code: str = "payme"
    calls: list[InboundCall] | None = None

    def enabled(self) -> bool:
        return True

    async def handle(self, call: InboundCall, payments: Any) -> OutboundResponse:
        assert self.calls is not None
        self.calls.append(call)
        return OutboundResponse(status_code=200, body={"jsonrpc": "2.0", "id": 1, "result": {}}, result_code="0")


async def test_inbound_call_without_edge_token_and_internal_headers() -> None:
    async with client() as env:
        spy = SpyAdapter(calls=[])
        env.app.state.provider_adapters = {"payme": spy}
        body, headers = payme_req()
        await env.c.post("/provider/v1/payme", content=body,
                         headers=edge(headers | {"X-Internal-Token": "test-jwt", "Cookie": "a=b"}))
        [call] = spy.calls or []
        assert "x-edge-token" not in call.headers and "x-internal-token" not in call.headers
        assert "cookie" not in call.headers and call.headers["authorization"].startswith("Basic ")
        assert call.client_ip == "185.234.113.7" and call.method == "POST" and call.body == body
        assert call.received_at == env.clock() and call.operation == "rpc"


# ---------------------------------------------------------------- журнал

class FailingSink:
    async def record(self, rec: ProviderCallRecord) -> None:
        raise RuntimeError("db down")


async def test_journal_failure_does_not_break_answer() -> None:
    async with client(sink=FailingSink()) as env:
        body, headers = payme_req()
        r = await env.c.post("/provider/v1/payme", content=body, headers=edge(headers))
        assert r.status_code == 200 and "result" in r.json()


class JournalPort(FakePaymentPort):
    def __init__(self, *a: Any, **kw: Any) -> None:
        super().__init__(*a, **kw)
        self.journal: list[dict[str, Any]] = []

    async def record_provider_call(self, **kw: Any) -> None:
        self.journal.append(kw)


async def test_journal_via_payment_port_like_stars() -> None:
    async with client(sink=False) as env:
        port = JournalPort(env.clock, enabled=env.settings.provider_enabled)
        port.orders = env.port.orders
        env.app.state.payment_port = port
        body, headers = payme_req()
        await env.c.post("/provider/v1/payme", content=body, headers=edge(headers))
        [row] = port.journal
        assert row | {"latency_ms": 0} == {"provider": "payme", "direction": "in", "method": "CheckPerformTransaction",
                                           "provider_txn_id": None, "order_no": ORDER, "result_code": "0",
                                           "latency_ms": 0, "client_ip": "185.234.113.7"}


async def test_default_adapters_built_from_settings() -> None:
    async with client(wire_adapters=False) as env:
        body, headers = payme_req()
        r = await env.c.post("/provider/v1/payme", content=body, headers=edge(headers))
        assert r.json()["result"] == {"allow": True}
        assert set(env.app.state.fiat_adapters) == {"payme", "click", "uzum"}
    adapters = build_fiat_adapters(provider_settings())
    assert [a.code for a in adapters.values()] == ["payme", "click", "uzum"]


async def test_factories_by_core_convention() -> None:
    """Соглашение ядра (domain/adapters.py): модуль провайдера экспортирует `build_adapter(rt)`."""
    from tilhero_billing.providers import click as click_mod
    from tilhero_billing.providers import payme as payme_mod
    from tilhero_billing.providers import uzum as uzum_mod

    settings = provider_settings(redis_url=None)
    rt = Runtime(settings)
    clock = Clock()
    rt.clock = clock  # type: ignore[attr-defined]
    for mod, cls in ((payme_mod, PaymeAdapter), (click_mod, ClickAdapter), (uzum_mod, UzumAdapter)):
        adapter = mod.build_adapter(rt)
        assert isinstance(adapter, cls) and adapter.clock() == clock()
    assert click_mod.build_adapter(rt).statement is None  # без БД ядра нет выписки — сверки Click нет


# ---------------------------------------------------------------- лимит pay.callback_ip

async def test_rate_limit_per_client_ip() -> None:
    async with client(redis=True) as env:
        assert env.rt.ratelimiter is not None and env.rt.redis is not None
        prefix = f"t:{uuid.uuid4().hex[:8]}:"
        policy = Policy("pay.callback_ip", "billing", "ip", 2, 60, None, "open")
        env.rt.ratelimiter = RateLimiter(env.rt.redis, service="billing", policies={"pay.callback_ip": policy},
                                         key_prefix=prefix)
        try:
            body, headers = payme_req()
            codes = []
            for _ in range(3):
                r = await env.c.post("/provider/v1/payme", content=body, headers=edge(headers))
                assert r.status_code == 200  # Payme — всегда HTTP 200, даже при лимите
                codes.append(r.json().get("error", {}).get("code", 0))
            assert codes == [0, 0, -32400]
            other = await env.c.post("/provider/v1/payme", content=body,
                                     headers=edge(headers) | {"X-Forwarded-For": "185.234.113.8, 100.64.0.9"})
            assert "result" in other.json()
            keys = [k async for k in env.rt.redis.scan_iter(f"{prefix}rl:pay.callback_ip:*")]
            assert keys and not any("185.234.113" in k for k in keys)  # IP в ключе — только псевдоним
        finally:
            keys = [k async for k in env.rt.redis.scan_iter(f"{prefix}*")]
            if keys:
                await env.rt.redis.delete(*keys)


async def test_rate_limit_redis_down_fails_open() -> None:
    async with client(redis=True) as env:
        assert env.rt.redis is not None

        class Broken:
            async def set(self, *a: Any, **kw: Any) -> None:
                raise ConnectionError("down")

        env.rt.redis = Broken()  # type: ignore[assignment]
        body, headers = payme_req()
        r = await env.c.post("/provider/v1/payme", content=body, headers=edge(headers))
        assert "result" in r.json()


# ---------------------------------------------------------------- секреты

async def test_edge_token_and_credentials_not_logged(capsys: pytest.CaptureFixture[str]) -> None:
    """create_app ставит JSON-логи в stdout (configure_logging) — проверяем именно их."""
    async with client() as env:
        logging.getLogger().setLevel(logging.DEBUG)
        body, headers = payme_req()
        await env.c.post("/provider/v1/payme", content=body, headers=edge(headers))
        await env.c.post("/provider/v1/payme", content=body, headers=edge(headers, token="test-bad"))
        env.port.fail_on.add("check")
        await env.c.post("/provider/v1/payme", content=body, headers=edge(headers))
        logs = capsys.readouterr().out
        text = logs + repr(env.sink.records)
        assert EDGE_TOKEN not in text and headers["Authorization"] not in text and body.decode() not in text
        assert "EDGE_TOKEN_INVALID" in logs and "payme handler failed" in logs
        for line in logs.splitlines():
            json.loads(line)  # только структурные строки
