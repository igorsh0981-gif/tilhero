"""Uzum Merchant API (симулятор по публичным описаниям, за флагом) — контрактные тесты по таблице INTERNAL_API §1.8:
check → create → confirm → оплачено; reverse; status; Basic и `serviceId`; повторы без дублей. Боевое включение —
после сверки спецификации (§14 U1)."""

from __future__ import annotations

import json
import logging
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

import pytest

from providers.fakes import Clock, FakePaymentPort, provider_settings
from providers.simulators import UZUM_PASSWORD, UZUM_SERVICE_ID, UzumSim, basic
from tilhero_billing.providers import uzum
from tilhero_billing.providers.base import ProviderAdapter
from tilhero_billing.providers.common import CheckoutUnavailable, dt_to_ms
from tilhero_billing.providers.uzum import UzumAdapter

ORDER = 100001
AMOUNT = 12_900_000
TRANS = "uz-7f3a9c1e"


def make_env(*, wrap_value: bool = False, **settings_kw: Any) -> SimpleNamespace:
    clock = Clock()
    settings = provider_settings(**settings_kw)
    port = FakePaymentPort(clock, enabled=settings.provider_enabled)
    port.add_order(ORDER, provider="uzum", amount_tiyin=AMOUNT)
    return SimpleNamespace(clock=clock, settings=settings, port=port, adapter=UzumAdapter(settings, clock=clock),
                           sim=UzumSim(wrap_value=wrap_value))


@pytest.fixture
def env() -> SimpleNamespace:
    return make_env()


async def send(env: SimpleNamespace, op: str, **kw: Any) -> tuple[int, dict[str, Any]]:
    kw.setdefault("timestamp", dt_to_ms(env.clock()))
    out = await env.adapter.handle(env.sim.call(op, at=env.clock(), **kw), env.port)
    body = dict(out.body)
    assert body["serviceId"] == int(UZUM_SERVICE_ID)
    if out.status_code != 200:
        assert out.status_code == uzum.ERROR_HTTP_STATUS and body["status"] == "FAILED"
        assert body["errorNote"] == uzum.NOTES[body["errorCode"]] and out.result_code == f"FAILED:{body['errorCode']}"
    return out.status_code, body


def code(result: tuple[int, dict[str, Any]]) -> int:
    status, body = result
    assert status == uzum.ERROR_HTTP_STATUS, body
    return int(body["errorCode"])


async def created(env: SimpleNamespace, trans: str = TRANS) -> dict[str, Any]:
    status, body = await send(env, "create", trans_id=trans, order_no=ORDER, amount=AMOUNT)
    assert status == 200, body
    return body


# ---------------------------------------------------------------- доступ и общие ошибки

def test_adapter_satisfies_protocol_and_is_behind_flag() -> None:
    env = make_env()
    assert isinstance(env.adapter, ProviderAdapter) and env.adapter.code == "uzum" and env.adapter.enabled()
    assert not UzumAdapter(provider_settings(uzum_enabled=False)).enabled()
    assert not UzumAdapter(provider_settings(payments_enabled=False)).enabled()


@pytest.mark.parametrize("headers", [{}, {"Authorization": basic("test-uzum-login", "test-wrong")},
                                     {"Authorization": basic("other", UZUM_PASSWORD)}, {"Authorization": "Basic %%"}])
async def test_access_denied_10001(env: SimpleNamespace, headers: dict[str, str]) -> None:
    assert code(await send(env, "check", order_no=ORDER, headers=headers)) == 10001
    assert env.port.log == []


async def test_empty_password_never_authorizes() -> None:
    env = make_env(uzum_password="")
    assert code(await send(env, "check", order_no=ORDER, headers={"Authorization": basic("test-uzum-login", "")})) \
        == 10001


async def test_ip_allow_list() -> None:
    env = make_env(uzum_allowed_cidrs="91.212.0.0/16")
    assert (await send(env, "check", order_no=ORDER, client_ip="91.212.10.10"))[0] == 200
    assert code(await send(env, "check", order_no=ORDER, client_ip="1.1.1.1")) == 10001


async def test_json_error_10002(env: SimpleNamespace) -> None:
    from dataclasses import replace
    for raw in (b"{oops", b"[1, 2]", b'{"amount": Infinity}'):
        out = await env.adapter.handle(replace(env.sim.call("check", order_no=ORDER), body=raw), env.port)
        assert out.body["errorCode"] == 10002


async def test_unknown_operation_10003(env: SimpleNamespace) -> None:
    assert code(await send(env, "refund", order_no=ORDER)) == 10003


@pytest.mark.parametrize("drop", ["serviceId", "timestamp", "params"])
async def test_missing_params_10005(env: SimpleNamespace, drop: str) -> None:
    from dataclasses import replace
    call = env.sim.call("check", order_no=ORDER)
    req = json.loads(call.body)
    req.pop(drop)
    out = await env.adapter.handle(replace(call, body=json.dumps(req).encode()), env.port)
    assert out.body["errorCode"] == 10005


async def test_wrong_service_id_10006(env: SimpleNamespace) -> None:
    sim = UzumSim(service_id="111")
    out = await env.adapter.handle(sim.call("check", order_no=ORDER), env.port)
    assert out.body["errorCode"] == 10006


@pytest.mark.parametrize("flags", [{"payments_enabled": False}, {"uzum_enabled": False}])
async def test_disabled_check_and_create_are_99999(flags: dict[str, bool]) -> None:
    env = make_env(**flags)
    assert code(await send(env, "check", order_no=ORDER)) == 99999
    assert code(await send(env, "create", trans_id=TRANS, order_no=ORDER, amount=AMOUNT)) == 99999
    assert env.port.txns == {}


async def test_disabled_confirm_of_existing_transaction_still_processes(env: SimpleNamespace) -> None:
    await created(env)
    off = make_env(uzum_enabled=False)
    off.port, off.clock = env.port, env.clock
    env.port.enabled = lambda provider: False
    status, body = await send(off, "confirm", trans_id=TRANS)
    assert status == 200 and body["status"] == "CONFIRMED"


async def test_database_failure_is_99999(env: SimpleNamespace) -> None:
    env.port.fail_on.add("create")
    assert code(await send(env, "create", trans_id=TRANS, order_no=ORDER, amount=AMOUNT)) == 99999


# ---------------------------------------------------------------- check

@pytest.mark.parametrize("wrap", [False, True])
async def test_check_ok(wrap: bool) -> None:
    env = make_env(wrap_value=wrap)
    status, body = await send(env, "check", order_no=ORDER)
    assert status == 200 and body["status"] == "OK" and body["data"] == {"account": {"value": str(ORDER)}}
    assert body["timestamp"] == dt_to_ms(env.clock())


@pytest.mark.parametrize("case,expected", [("missing", 10007), ("not_number", 10007), ("not_web", 10007),
                                           ("other_provider", 10007)])
async def test_check_order_not_found(env: SimpleNamespace, case: str, expected: int) -> None:
    env.port.add_order(200001, provider="uzum", channel="miniapp")
    env.port.add_order(200002, provider="payme")
    order = {"missing": 999999, "not_number": "abc", "not_web": 200001, "other_provider": 200002}[case]
    assert code(await send(env, "check", order_no=order)) == expected


@pytest.mark.parametrize("status,expected", [("fulfilled", 10008), ("paid", 10008), ("cancelled", 10009),
                                             ("expired", 10009)])
async def test_check_order_state(env: SimpleNamespace, status: str, expected: int) -> None:
    env.port.orders[ORDER].status = status
    assert code(await send(env, "check", order_no=ORDER)) == expected


async def test_check_with_amount_compares_it(env: SimpleNamespace) -> None:
    assert code(await send(env, "check", order_no=ORDER, amount=AMOUNT - 100)) == 10011
    assert (await send(env, "check", order_no=ORDER, amount=AMOUNT))[0] == 200


# ---------------------------------------------------------------- create

async def test_create_ok(env: SimpleNamespace) -> None:
    body = await created(env)
    assert body == {"serviceId": int(UZUM_SERVICE_ID), "transId": TRANS, "status": "CREATED",
                    "transTime": dt_to_ms(env.clock()), "data": {"account": {"value": str(ORDER)}}, "amount": AMOUNT}
    assert env.port.txns[("uzum", TRANS)].provider_time == env.clock()


async def test_create_repeat_is_10010_without_duplicate(env: SimpleNamespace) -> None:
    await created(env)
    assert code(await send(env, "create", trans_id=TRANS, order_no=ORDER, amount=AMOUNT)) == 10010
    assert len(env.port.txns) == 1


@pytest.mark.parametrize("amount,expected", [(AMOUNT + 1, 10011), (99, 10012), (100_000_000_001, 10013)])
async def test_create_amount_errors(env: SimpleNamespace, amount: int, expected: int) -> None:
    assert code(await send(env, "create", trans_id=TRANS, order_no=ORDER, amount=amount)) == expected
    assert env.port.txns == {}


async def test_create_missing_trans_or_amount_10005(env: SimpleNamespace) -> None:
    assert code(await send(env, "create", order_no=ORDER, amount=AMOUNT)) == 10005
    assert code(await send(env, "create", trans_id=TRANS, order_no=ORDER)) == 10005
    assert code(await send(env, "create", trans_id=TRANS, order_no=ORDER, amount="12900000")) == 10005


async def test_create_for_unknown_order_10007(env: SimpleNamespace) -> None:
    assert code(await send(env, "create", trans_id=TRANS, order_no=424242, amount=AMOUNT)) == 10007


# ---------------------------------------------------------------- confirm

async def test_confirm_ok_then_repeat_10016(env: SimpleNamespace) -> None:
    await created(env)
    env.clock.advance(seconds=4)
    status, body = await send(env, "confirm", trans_id=TRANS, paymentSource="UZCARD", phone="998901234567")
    assert status == 200 and body == {"serviceId": int(UZUM_SERVICE_ID), "transId": TRANS, "status": "CONFIRMED",
                                      "confirmTime": dt_to_ms(env.clock()),
                                      "data": {"account": {"value": str(ORDER)}}, "amount": AMOUNT}
    assert env.port.orders[ORDER].status == "fulfilled"
    assert code(await send(env, "confirm", trans_id=TRANS)) == 10016
    assert env.port.fulfilments == [ORDER]


async def test_confirm_not_found_10014_and_cancelled_10015(env: SimpleNamespace) -> None:
    assert code(await send(env, "confirm", trans_id="nope")) == 10014
    await created(env)
    await send(env, "reverse", trans_id=TRANS)
    assert code(await send(env, "confirm", trans_id=TRANS)) == 10015
    assert env.port.fulfilments == []


# ---------------------------------------------------------------- reverse и status

async def test_reverse_before_confirm(env: SimpleNamespace) -> None:
    await created(env)
    status, body = await send(env, "reverse", trans_id=TRANS)
    assert status == 200 and body["status"] == "REVERSED" and body["reverseTime"] == dt_to_ms(env.clock())
    txn = env.port.txns[("uzum", TRANS)]
    assert txn.state == "cancelled" and txn.cancel_reason == "provider_error"
    assert code(await send(env, "reverse", trans_id=TRANS)) == 10018


async def test_reverse_after_confirm_is_refund(env: SimpleNamespace) -> None:
    await created(env)
    await send(env, "confirm", trans_id=TRANS)
    status, body = await send(env, "reverse", trans_id=TRANS)
    assert status == 200 and body["status"] == "REVERSED"
    assert env.port.txns[("uzum", TRANS)].state == "refunded" and env.port.orders[ORDER].status == "refunded"
    assert code(await send(env, "reverse", trans_id=TRANS)) == 10018


async def test_reverse_not_found_10014(env: SimpleNamespace) -> None:
    assert code(await send(env, "reverse", trans_id="nope")) == 10014


async def test_status_for_each_state(env: SimpleNamespace) -> None:
    assert code(await send(env, "status", trans_id=TRANS)) == 10014
    await created(env)
    t0 = dt_to_ms(env.clock())
    _, body = await send(env, "status", trans_id=TRANS)
    assert body == {"serviceId": int(UZUM_SERVICE_ID), "transId": TRANS, "status": "CREATED", "transTime": t0,
                    "confirmTime": None, "reverseTime": None, "data": {"account": {"value": str(ORDER)}},
                    "amount": AMOUNT}
    env.clock.advance(seconds=2)
    await send(env, "confirm", trans_id=TRANS)
    _, body = await send(env, "status", trans_id=TRANS)
    assert body["status"] == "CONFIRMED" and body["confirmTime"] == t0 + 2000
    await send(env, "reverse", trans_id=TRANS)
    _, body = await send(env, "status", trans_id=TRANS)
    assert body["status"] == "REVERSED" and body["reverseTime"] == t0 + 2000


async def test_full_flow_check_create_confirm(env: SimpleNamespace) -> None:
    """AT-89: check → create → confirm → оплачено; повторы не дублируют выдачу."""
    assert (await send(env, "check", order_no=ORDER))[1]["status"] == "OK"
    await created(env)
    assert code(await send(env, "create", trans_id=TRANS, order_no=ORDER, amount=AMOUNT)) == 10010
    assert (await send(env, "confirm", trans_id=TRANS))[1]["status"] == "CONFIRMED"
    assert code(await send(env, "confirm", trans_id=TRANS)) == 10016
    assert code(await send(env, "check", order_no=ORDER)) == 10008
    assert env.port.fulfilments == [ORDER]


# ---------------------------------------------------------------- ссылка, возврат, фискализация, сверка

async def test_checkout_template(env: SimpleNamespace) -> None:
    co = await env.adapter.checkout(env.port.orders[ORDER].view(), locale="uz", return_url=None)
    q = parse_qs(urlsplit(co.url).query)
    assert co.kind == "redirect" and co.url.startswith("https://checkout.uzum.test/pay?")
    assert q == {"s": [UZUM_SERVICE_ID], "o": [str(ORDER)], "a": [str(AMOUNT)], "l": ["uz"],
                 "r": [f"https://pay.tilhero.test/orders/{ORDER}"]}
    assert unquote(co.url.split("&r=")[1]) == f"https://pay.tilhero.test/orders/{ORDER}"


async def test_checkout_unavailable() -> None:
    env = make_env(uzum_checkout_url_template="")
    with pytest.raises(CheckoutUnavailable):
        await env.adapter.checkout(env.port.orders[ORDER].view(), locale="ru", return_url=None)
    env = make_env(uzum_checkout_url_template="javascript:alert({order_no})")
    with pytest.raises(CheckoutUnavailable):
        await env.adapter.checkout(env.port.orders[ORDER].view(), locale="ru", return_url=None)


async def test_refund_manual_fiscal_no_op_no_remote(env: SimpleNamespace) -> None:
    await created(env)
    await send(env, "confirm", trans_id=TRANS)
    txn = await env.port.get("uzum", TRANS)
    outcome = await env.adapter.refund(txn, account_id=None)
    assert outcome.kind == "manual"
    assert outcome.instruction == {"provider": "uzum", "provider_txn_id": TRANS, "amount_tiyin": AMOUNT}
    assert (await env.adapter.fiscalize(txn, env.port.orders[ORDER].view())).kind == "no_op"
    assert await env.adapter.remote_status(env.clock()) is None


async def test_password_never_logged_or_returned(env: SimpleNamespace, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    env.port.fail_on.add("create")
    bodies = [(await send(env, "check", order_no=ORDER))[1],
              (await send(env, "create", trans_id=TRANS, order_no=ORDER, amount=AMOUNT))[1],
              (await send(env, "check", order_no=ORDER, headers={"Authorization": basic("x", "y")}))[1]]
    text = caplog.text + json.dumps(bodies)
    assert UZUM_PASSWORD not in text and "uzum handler failed" in caplog.text


def test_unavailable_response() -> None:
    out = uzum.unavailable_response(provider_settings())
    assert out.status_code == uzum.ERROR_HTTP_STATUS and out.body["errorCode"] == 99999
