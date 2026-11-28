"""Payme Merchant API — контрактные тесты по таблице INTERNAL_API §1.6 (строка таблицы = тест), оба сценария
песочницы (каждый Create/Perform/Cancel дважды — ответы совпадают), гонки, ссылка оплаты, сверка Subscribe API."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from dataclasses import replace
from datetime import timedelta
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from providers.fakes import Clock, FakePaymentPort, fiscal_item, provider_settings
from providers.simulators import PAYME_KEY, PAYME_MERCHANT_ID, PAYME_SUBSCRIBE_KEY, PaymeSim, PaymeSubscribeApi, basic
from tilhero_billing.providers import payme
from tilhero_billing.providers.base import ProviderAdapter
from tilhero_billing.providers.common import CheckoutUnavailable, dt_to_ms
from tilhero_billing.providers.payme import PaymeAdapter

ORDER = 100001
AMOUNT = 4_900_000


def make_env(**settings_kw: Any) -> SimpleNamespace:
    clock = Clock()
    settings = provider_settings(**settings_kw)
    port = FakePaymentPort(clock, enabled=settings.provider_enabled)
    port.add_order(ORDER, amount_tiyin=AMOUNT)
    return SimpleNamespace(clock=clock, settings=settings, port=port, adapter=PaymeAdapter(settings, clock=clock),
                           sim=PaymeSim())


@pytest.fixture
def env() -> SimpleNamespace:
    return make_env()


async def rpc(env: SimpleNamespace, method: str, params: dict[str, Any], **kw: Any) -> dict[str, Any]:
    out = await env.adapter.handle(env.sim.call(method, params, at=env.clock(), **kw), env.port)
    assert out.status_code == 200  # Payme — всегда HTTP 200
    assert out.body["jsonrpc"] == "2.0"
    return dict(out.body)


def err(body: dict[str, Any]) -> int:
    assert "error" in body, body
    message = body["error"]["message"]
    assert set(message) == {"ru", "uz", "en"} and all(message.values())
    return int(body["error"]["code"])


def acc(order_no: int | str = ORDER) -> dict[str, Any]:
    return {"order_id": str(order_no)}


async def create(env: SimpleNamespace, txn_id: str = "6745a1b2c3d4e5f600000001", order_no: int = ORDER,
                 amount: int = AMOUNT) -> dict[str, Any]:
    return await rpc(env, "CreateTransaction", {"id": txn_id, "time": dt_to_ms(env.clock()), "amount": amount,
                                                "account": acc(order_no)})


TXN = "6745a1b2c3d4e5f600000001"


# ---------------------------------------------------------------- протокол и авторизация

def test_adapter_satisfies_protocol(env: SimpleNamespace) -> None:
    assert isinstance(env.adapter, ProviderAdapter) and env.adapter.code == "payme"
    assert env.adapter.enabled()


@pytest.mark.parametrize("method", ["GET", "PUT", "HEAD"])
async def test_not_post_is_32300(env: SimpleNamespace, method: str) -> None:
    call = replace(env.sim.call("CheckPerformTransaction", {"amount": AMOUNT, "account": acc()}), method=method)
    out = await env.adapter.handle(call, env.port)
    assert out.status_code == 200 and out.body["error"]["code"] == -32300 and out.body["id"] is None


async def test_not_json_is_32700(env: SimpleNamespace) -> None:
    for raw in (b"{not json", b"\xff\xfe", b'{"id": 1, "x": NaN}'):
        out = await env.adapter.handle(_with_body(env.sim.call("CheckTransaction", {"id": TXN}), raw), env.port)
        assert out.status_code == 200 and out.body["error"]["code"] == -32700


def _with_body(call: Any, body: bytes) -> Any:
    return replace(call, body=body)


@pytest.mark.parametrize("headers", [
    {},
    {"Authorization": basic("Paycom", "test-wrong-key")},
    {"Authorization": basic("NotPaycom", PAYME_KEY)},
    {"Authorization": "Basic !!!not-base64"},
    {"Authorization": "Bearer " + PAYME_KEY},
])
async def test_auth_failures_are_32504(env: SimpleNamespace, headers: dict[str, str]) -> None:
    body = await rpc(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": acc()}, headers=headers,
                     rpc_id=77)
    assert err(body) == -32504 and body["id"] == 77
    assert PAYME_KEY not in json.dumps(body)
    assert env.port.log == []  # без авторизации к данным не ходим


async def test_empty_key_never_authorizes() -> None:
    env = make_env(payme_key="")
    body = await rpc(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": acc()},
                     headers={"Authorization": basic("Paycom", "")})
    assert err(body) == -32504


@pytest.mark.parametrize("flags", [{"payments_enabled": False}, {"payme_enabled": False}])
async def test_disabled_is_32504(flags: dict[str, bool]) -> None:
    env = make_env(**flags)
    assert err(await rpc(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": acc()})) == -32504
    assert err(await rpc(env, "PerformTransaction", {"id": TXN})) == -32504


async def test_ip_allow_list() -> None:
    env = make_env(payme_allowed_cidrs="185.234.113.0/24, 2001:db8::/32")
    ok = await rpc(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": acc()}, client_ip="185.234.113.7")
    assert ok["result"]["allow"] is True
    for ip in ("8.8.8.8", None, "2001:db9::1"):
        assert err(await rpc(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": acc()},
                             client_ip=ip)) == -32504


@pytest.mark.parametrize("payload", [
    {"id": 1, "params": {}},  # нет method
    {"id": 1, "method": "CheckTransaction"},  # нет params
    {"id": 1, "method": "CheckTransaction", "params": []},  # params не объект
    {"id": 1, "method": "CheckPerformTransaction", "params": {"amount": "4900000", "account": {"order_id": "1"}}},
    {"id": 1, "method": "CheckPerformTransaction", "params": {"amount": 4900000.0, "account": {"order_id": "1"}}},
    {"id": 1, "method": "CheckPerformTransaction", "params": {"amount": True, "account": {"order_id": "1"}}},
    {"id": 1, "method": "CheckPerformTransaction", "params": {"amount": 100, "account": "100001"}},
    {"id": 1, "method": "CreateTransaction", "params": {"id": 5, "time": 1, "amount": 100, "account": {}}},
    {"id": 1, "method": "CancelTransaction", "params": {"id": TXN}},  # нет reason
])
async def test_invalid_request_is_32600(env: SimpleNamespace, payload: dict[str, Any]) -> None:
    call = _with_body(env.sim.call("CheckTransaction", {}), json.dumps(payload).encode())
    out = await env.adapter.handle(call, env.port)
    assert out.status_code == 200 and out.body["error"]["code"] == -32600


@pytest.mark.parametrize("method", ["ChangePassword", "GetStatements", "checkPerformTransaction"])
async def test_unknown_method_is_32601(env: SimpleNamespace, method: str) -> None:
    assert err(await rpc(env, method, {"password": "test-new"})) == -32601


async def test_database_failure_is_32400_with_http_200(env: SimpleNamespace) -> None:
    env.port.fail_on.add("check")
    body = await rpc(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": acc()})
    assert err(body) == -32400


# ---------------------------------------------------------------- CheckPerformTransaction

async def test_check_perform_with_detail() -> None:
    env = make_env()
    env.port.orders[ORDER].fiscal_items = (fiscal_item(AMOUNT),)
    body = await rpc(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": acc()})
    assert body["result"] == {"allow": True, "detail": {"receipt_type": 0, "items": [
        {"title": "TilHero Plus 30", "price": AMOUNT, "count": 1, "code": "10305008002000000",
         "package_code": "1545643", "vat_percent": 12, "units": 1}]}}


async def test_check_perform_without_fiscal_items_has_no_detail(env: SimpleNamespace) -> None:
    body = await rpc(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": acc()})
    assert body["result"] == {"allow": True}


@pytest.mark.parametrize("case", ["missing", "not_number", "not_web", "other_provider", "no_field"])
async def test_check_perform_order_not_found_is_31050(env: SimpleNamespace, case: str) -> None:
    env.port.add_order(200001, channel="miniapp")
    env.port.add_order(200002, provider="click")
    account = {"missing": acc(999999), "not_number": {"order_id": "10OO01"}, "not_web": acc(200001),
               "other_provider": acc(200002), "no_field": {"login": "x"}}[case]
    body = await rpc(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": account})
    assert err(body) == -31050 and body["error"]["data"] == "order_id"


@pytest.mark.parametrize("status,key", [("cancelled", "order_closed"), ("expired", "order_closed"),
                                        ("fulfilled", "order_paid"), ("paid", "order_paid"),
                                        ("refunded", "order_closed")])
async def test_check_perform_closed_or_paid_is_31050(env: SimpleNamespace, status: str, key: str) -> None:
    env.port.orders[ORDER].status = status
    body = await rpc(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": acc()})
    assert err(body) == -31050 and body["error"]["message"] == dict(payme.MESSAGES[key])


async def test_check_perform_after_expiry_is_31050(env: SimpleNamespace) -> None:
    env.clock.advance(days=2)
    assert err(await rpc(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": acc()})) == -31050


@pytest.mark.parametrize("amount", [AMOUNT - 1, AMOUNT + 100, 100])
async def test_check_perform_amount_mismatch_is_31001(env: SimpleNamespace, amount: int) -> None:
    assert err(await rpc(env, "CheckPerformTransaction", {"amount": amount, "account": acc()})) == -31001


async def test_check_perform_busy_order(env: SimpleNamespace) -> None:
    await create(env)
    body = await rpc(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": acc()})
    assert err(body) == payme.E_ORDER_BUSY  # §14 P2: одна константа, сверить в песочнице


# ---------------------------------------------------------------- CreateTransaction

async def test_create_and_repeat_same_answer(env: SimpleNamespace) -> None:
    first = await create(env)
    assert first["result"] == {"create_time": dt_to_ms(env.clock()), "transaction": "1", "state": 1}
    env.clock.advance(seconds=30)
    second = await create(env)
    assert second["result"] == first["result"]
    assert len(env.port.txns) == 1


async def test_create_second_id_while_pending_is_busy(env: SimpleNamespace) -> None:
    await create(env)
    assert err(await create(env, "6745a1b2c3d4e5f600000002")) == payme.E_ORDER_BUSY


async def test_create_existing_timed_out_cancels_with_reason_4(env: SimpleNamespace) -> None:
    await create(env)
    env.clock.advance(milliseconds=payme.TIMEOUT_MS)  # ровно 12 ч — ещё не просрочена
    assert "result" in await create(env)
    env.clock.advance(milliseconds=1)
    assert err(await create(env)) == -31008
    check = await rpc(env, "CheckTransaction", {"id": TXN})
    assert check["result"]["state"] == -1 and check["result"]["reason"] == 4
    assert env.port.txns[("payme", TXN)].cancel_reason == "timeout"


async def test_create_existing_performed_is_31008(env: SimpleNamespace) -> None:
    await create(env)
    await rpc(env, "PerformTransaction", {"id": TXN})
    assert err(await create(env)) == -31008


@pytest.mark.parametrize("order_no,amount,code", [(999999, AMOUNT, -31050), (ORDER, AMOUNT + 1, -31001)])
async def test_create_check_errors(env: SimpleNamespace, order_no: int, amount: int, code: int) -> None:
    assert err(await create(env, order_no=order_no, amount=amount)) == code
    assert env.port.txns == {}


# ---------------------------------------------------------------- PerformTransaction

async def test_perform_not_found_is_31003(env: SimpleNamespace) -> None:
    assert err(await rpc(env, "PerformTransaction", {"id": TXN})) == -31003


async def test_perform_then_repeat_same_answer_and_single_fulfilment(env: SimpleNamespace) -> None:
    await create(env)
    env.clock.advance(seconds=5)
    first = await rpc(env, "PerformTransaction", {"id": TXN})
    assert first["result"] == {"transaction": "1", "perform_time": dt_to_ms(env.clock()), "state": 2}
    env.clock.advance(seconds=5)
    assert await rpc(env, "PerformTransaction", {"id": TXN}) == first | {"id": first["id"] + 1}
    assert env.port.orders[ORDER].status == "fulfilled" and env.port.fulfilments == [ORDER]


async def test_perform_timed_out_cancels_and_is_31008(env: SimpleNamespace) -> None:
    await create(env)
    env.clock.advance(milliseconds=payme.TIMEOUT_MS + 1)
    assert err(await rpc(env, "PerformTransaction", {"id": TXN})) == -31008
    txn = env.port.txns[("payme", TXN)]
    assert txn.state == "cancelled" and txn.provider_reason == 4 and env.port.fulfilments == []


async def test_perform_cancelled_is_31008(env: SimpleNamespace) -> None:
    await create(env)
    await rpc(env, "CancelTransaction", {"id": TXN, "reason": 3})
    assert err(await rpc(env, "PerformTransaction", {"id": TXN})) == -31008


async def test_perform_after_order_expired_but_txn_created_before(env: SimpleNamespace) -> None:
    """Транзакция создана до истечения заказа — Payme может провести её в пределах 12 ч (§1.3)."""
    await create(env)
    env.port.orders[ORDER].status = "expired"
    assert (await rpc(env, "PerformTransaction", {"id": TXN}))["result"]["state"] == 2


async def test_two_concurrent_performs(env: SimpleNamespace) -> None:
    await create(env)
    a, b = await asyncio.gather(rpc(env, "PerformTransaction", {"id": TXN}, rpc_id=1),
                                rpc(env, "PerformTransaction", {"id": TXN}, rpc_id=1))
    assert a == b and a["result"]["state"] == 2
    assert env.port.fulfilments == [ORDER]


# ---------------------------------------------------------------- CancelTransaction

async def test_cancel_not_found_is_31003(env: SimpleNamespace) -> None:
    assert err(await rpc(env, "CancelTransaction", {"id": TXN, "reason": 1})) == -31003


async def test_cancel_created_then_repeat(env: SimpleNamespace) -> None:
    await create(env)
    env.clock.advance(minutes=1)
    first = await rpc(env, "CancelTransaction", {"id": TXN, "reason": 3}, rpc_id=9)
    assert first["result"] == {"transaction": "1", "cancel_time": dt_to_ms(env.clock()), "state": -1}
    env.clock.advance(minutes=1)
    assert await rpc(env, "CancelTransaction", {"id": TXN, "reason": 3}, rpc_id=9) == first
    txn = env.port.txns[("payme", TXN)]
    assert txn.cancel_reason == "execution_error" and txn.provider_reason == 3


async def test_cancel_performed_is_refund_minus_2_never_31007(env: SimpleNamespace) -> None:
    await create(env)
    await rpc(env, "PerformTransaction", {"id": TXN})
    first = await rpc(env, "CancelTransaction", {"id": TXN, "reason": 5}, rpc_id=3)
    assert first["result"]["state"] == -2 and first["result"]["cancel_time"] > 0
    assert await rpc(env, "CancelTransaction", {"id": TXN, "reason": 5}, rpc_id=3) == first
    assert env.port.orders[ORDER].status == "refunded"
    check = await rpc(env, "CheckTransaction", {"id": TXN})
    assert check["result"]["state"] == -2 and check["result"]["reason"] == 5


@pytest.mark.parametrize("reason,mapped", [(1, "receivers_not_found"), (2, "debit_error"), (4, "timeout"),
                                           (10, "unknown"), (42, "unknown")])
async def test_cancel_reason_mapping(env: SimpleNamespace, reason: int, mapped: str) -> None:
    await create(env)
    await rpc(env, "CancelTransaction", {"id": TXN, "reason": reason})
    txn = env.port.txns[("payme", TXN)]
    assert txn.cancel_reason == mapped and txn.provider_reason == reason


# ---------------------------------------------------------------- CheckTransaction и GetStatement

async def test_check_transaction(env: SimpleNamespace) -> None:
    assert err(await rpc(env, "CheckTransaction", {"id": TXN})) == -31003
    await create(env)
    created = dt_to_ms(env.clock())
    body = await rpc(env, "CheckTransaction", {"id": TXN})
    assert body["result"] == {"create_time": created, "perform_time": 0, "cancel_time": 0, "transaction": "1",
                              "state": 1, "reason": None}
    env.clock.advance(seconds=10)
    await rpc(env, "PerformTransaction", {"id": TXN})
    body = await rpc(env, "CheckTransaction", {"id": TXN})
    assert body["result"]["state"] == 2 and body["result"]["perform_time"] == created + 10_000


async def test_check_transaction_reason_for_our_cancellation(env: SimpleNamespace) -> None:
    """Отмена с нашей стороны (сага, `order_closed`) — reason из таблицы REASON_FOR_PAYME."""
    await create(env)
    await env.port.cancel("payme", TXN, "order_closed", None)
    body = await rpc(env, "CheckTransaction", {"id": TXN})
    assert body["result"]["state"] == -1 and body["result"]["reason"] == payme.REASON_FOR_PAYME["order_closed"]


async def test_get_statement(env: SimpleNamespace) -> None:
    env.port.add_order(100002, amount_tiyin=12_900_000)
    start = dt_to_ms(env.clock())
    await create(env, "a" * 24)
    env.clock.advance(minutes=1)
    await create(env, "b" * 24, order_no=100002, amount=12_900_000)
    await rpc(env, "PerformTransaction", {"id": "b" * 24})
    env.clock.advance(minutes=1)
    end = dt_to_ms(env.clock())
    body = await rpc(env, "GetStatement", {"from": start, "to": end})
    rows = body["result"]["transactions"]
    assert [r["id"] for r in rows] == ["a" * 24, "b" * 24]
    assert rows[1] == {"id": "b" * 24, "time": start + 60_000, "amount": 12_900_000, "account": {"order_id": "100002"},
                       "create_time": start + 60_000, "perform_time": start + 60_000, "cancel_time": 0,
                       "transaction": "2", "state": 2, "reason": None, "receivers": None}
    only_first = await rpc(env, "GetStatement", {"from": start, "to": start + 1})
    assert [r["id"] for r in only_first["result"]["transactions"]] == ["a" * 24]
    assert err(await rpc(env, "GetStatement", {"from": end, "to": start})) == -32600


# ---------------------------------------------------------------- SetFiscalData

async def test_set_fiscal_data_perform_and_cancel_are_separate(env: SimpleNamespace) -> None:
    await create(env)
    fiscal = {"receipt_id": 54, "status_code": 0, "message": "accepted", "terminal_id": "EP000000000001",
              "fiscal_sign": "123456789012", "qr_code_url": "https://ofd.soliq.uz/check?t=1", "date": "20261122140000"}
    assert (await rpc(env, "SetFiscalData", {"id": TXN, "type": "PERFORM", "fiscal_data": fiscal}))["result"] == {
        "success": True}
    assert (await rpc(env, "SetFiscalData", {"id": TXN, "type": "CANCEL",
                                             "fiscal_data": {**fiscal, "qr_code_url": "http://insecure"}}))["result"]
    sale = env.port.fiscal[("payme", TXN, "sale")]
    refund = env.port.fiscal[("payme", TXN, "refund")]
    assert sale["receipt_id"] == "54" and sale["qr_code_url"].startswith("https://")
    assert "qr_code_url" not in refund  # только https


@pytest.mark.parametrize("params,code", [
    ({"id": "unknown-txn", "type": "PERFORM", "fiscal_data": {}}, -32001),
    ({"id": TXN, "type": "SALE", "fiscal_data": {}}, -32602),
    ({"id": TXN, "type": "PERFORM", "fiscal_data": "x"}, -32602),
    ({"type": "PERFORM", "fiscal_data": {}}, -32602),
])
async def test_set_fiscal_data_errors(env: SimpleNamespace, params: dict[str, Any], code: int) -> None:
    await create(env)
    assert err(await rpc(env, "SetFiscalData", params)) == code


# ---------------------------------------------------------------- сценарии песочницы (каждый вызов дважды)

async def twice(env: SimpleNamespace, method: str, params: dict[str, Any]) -> dict[str, Any]:
    first = await rpc(env, method, params, rpc_id=500)
    env.clock.advance(seconds=3)
    second = await rpc(env, method, params, rpc_id=500)
    assert first == second, (method, first, second)
    return first


async def test_sandbox_scenario_1_create_perform_cancel(env: SimpleNamespace) -> None:
    """Сценарий 1: проверка → создание → проведение → отмена проведённой (state −2); каждый шаг дважды."""
    assert (await twice(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": acc()}))["result"]["allow"]
    params = {"id": TXN, "time": dt_to_ms(env.clock()), "amount": AMOUNT, "account": acc()}
    assert (await twice(env, "CreateTransaction", params))["result"]["state"] == 1
    assert err(await rpc(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": acc()})) == payme.E_ORDER_BUSY
    assert (await twice(env, "PerformTransaction", {"id": TXN}))["result"]["state"] == 2
    assert (await twice(env, "CancelTransaction", {"id": TXN, "reason": 5}))["result"]["state"] == -2
    assert (await twice(env, "CheckTransaction", {"id": TXN}))["result"]["reason"] == 5
    assert env.port.fulfilments == [ORDER]


async def test_sandbox_scenario_2_create_cancel(env: SimpleNamespace) -> None:
    """Сценарий 2: создание → отмена до проведения (state −1) → проведение отменённой −31008; каждый шаг дважды."""
    params = {"id": TXN, "time": dt_to_ms(env.clock()), "amount": AMOUNT, "account": acc()}
    assert (await twice(env, "CreateTransaction", params))["result"]["state"] == 1
    assert (await twice(env, "CancelTransaction", {"id": TXN, "reason": 3}))["result"]["state"] == -1
    assert err(await rpc(env, "PerformTransaction", {"id": TXN})) == -31008
    assert (await twice(env, "CheckTransaction", {"id": TXN}))["result"] == {
        "create_time": dt_to_ms(env.port.txns[("payme", TXN)].created_at), "perform_time": 0,
        "cancel_time": dt_to_ms(env.port.txns[("payme", TXN)].cancelled_at), "transaction": "1", "state": -1,
        "reason": 3}
    # отменённая не мешает новой попытке: заказ снова можно оплатить
    assert (await rpc(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": acc()}))["result"]["allow"]
    assert env.port.fulfilments == []


# ---------------------------------------------------------------- ссылка, возврат, фискализация

async def test_checkout_link(env: SimpleNamespace) -> None:
    order = env.port.orders[ORDER].view()
    co = await env.adapter.checkout(order, locale="uz", return_url=None)
    assert co.kind == "redirect" and co.url.startswith("https://checkout.paycom.uz/")
    decoded = base64.b64decode(co.url.rsplit("/", 1)[1]).decode()
    assert decoded == (f"m={PAYME_MERCHANT_ID};ac.order_id={ORDER};a={AMOUNT};l=uz;"
                       f"c=https://pay.tilhero.test/orders/{ORDER}")
    co = await env.adapter.checkout(order, locale="en", return_url="https://pay.tilhero.test/orders/x")
    assert base64.b64decode(co.url.rsplit("/", 1)[1]).decode().endswith(";l=ru;c=https://pay.tilhero.test/orders/x")


async def test_checkout_test_environment_url() -> None:
    env = make_env(payme_checkout_url="https://test.paycom.uz")
    co = await env.adapter.checkout(env.port.orders[ORDER].view(), locale="ru", return_url=None)
    assert co.url.startswith("https://test.paycom.uz/")


async def test_checkout_unavailable() -> None:
    env = make_env(payme_merchant_id="")
    with pytest.raises(CheckoutUnavailable):
        await env.adapter.checkout(env.port.orders[ORDER].view(), locale="ru", return_url=None)
    env = make_env()
    env.port.add_order(100009, provider="click")
    with pytest.raises(CheckoutUnavailable):
        await env.adapter.checkout(env.port.orders[100009].view(), locale="ru", return_url=None)
    with pytest.raises(CheckoutUnavailable):
        await env.adapter.checkout(env.port.orders[ORDER].view(), locale="ru", return_url="https://x/a;b")


async def test_refund_is_manual_and_fiscalize_no_op(env: SimpleNamespace) -> None:
    await create(env)
    await rpc(env, "PerformTransaction", {"id": TXN})
    txn = await env.port.get("payme", TXN)
    outcome = await env.adapter.refund(txn, account_id=None)
    assert outcome.kind == "manual"
    assert outcome.instruction == {"provider": "payme", "provider_txn_id": TXN, "amount_tiyin": AMOUNT}
    assert (await env.adapter.fiscalize(txn, env.port.orders[ORDER].view())).kind == "no_op"


# ---------------------------------------------------------------- сверка Subscribe API (необязательна)

async def test_remote_status_none_without_subscribe_key(env: SimpleNamespace) -> None:
    assert await env.adapter.remote_status(env.clock() - timedelta(days=1)) is None


async def test_remote_status_receipts_get_all_paging() -> None:
    api = PaymeSubscribeApi()
    clock = Clock()
    base_ms = dt_to_ms(clock())
    for i in range(60):
        api.receipts.append({"_id": f"r{i:023d}", "create_time": base_ms - 1000 + i, "state": 4 if i % 2 else 50,
                             "amount": 4_900_000, "account": [{"name": "order_id", "value": str(100001 + i)}]})
    settings = provider_settings(payme_subscribe_url="https://checkout.test.paycom.uz/api",
                                 payme_subscribe_key=PAYME_SUBSCRIBE_KEY)
    adapter = PaymeAdapter(settings, transport=api.transport(), clock=clock)
    records = await adapter.remote_status(clock() - timedelta(hours=1))
    assert records is not None and len(records) == 60 and len(api.requests) == 2
    assert api.requests[1]["params"]["offset"] == 50 and api.requests[0]["method"] == "receipts.get_all"
    assert records[1].state == "performed" and records[0].state == "cancelled"
    api.receipts[:] = [{"_id": "r" * 24, "create_time": base_ms, "pay_time": base_ms + 5, "state": 50,
                        "amount": 100, "account": {"order_id": "100001"}}]
    [refunded] = await adapter.remote_status(clock() - timedelta(hours=1)) or []
    assert refunded.state == "refunded" and refunded.order_ref == "100001"  # оплачен и отменён — возврат
    assert records[1].order_ref == "100002" and records[1].amount_tiyin == 4_900_000


async def test_remote_status_failure_is_none() -> None:
    api = PaymeSubscribeApi(fail_5xx=2)
    settings = provider_settings(payme_subscribe_url="https://checkout.test.paycom.uz/api",
                                 payme_subscribe_key=PAYME_SUBSCRIBE_KEY)
    adapter = PaymeAdapter(settings, transport=api.transport(), clock=Clock())
    adapter.http.retry_delay = 0
    assert await adapter.remote_status(Clock()() - timedelta(hours=1)) is None
    assert len(api.requests) == 2  # один повтор на 5xx
    wrong = PaymeAdapter(provider_settings(payme_subscribe_url="https://checkout.test.paycom.uz/api",
                                           payme_subscribe_key="test-wrong"),
                         transport=PaymeSubscribeApi().transport(), clock=Clock())
    assert await wrong.remote_status(Clock()() - timedelta(hours=1)) is None


# ---------------------------------------------------------------- тексты и секреты

def test_messages_three_languages_uzbek_modifier_letter() -> None:
    for key, message in payme.MESSAGES.items():
        assert set(message) == {"ru", "uz", "en"} and all(message.values()), key
        assert not any(ch in message["uz"] for ch in "'‘’`"), key  # oʻ / gʻ — только U+02BB
    assert "ʻ" in payme.MESSAGES["transport"]["uz"]


async def test_secrets_never_logged_or_returned(env: SimpleNamespace, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    env.port.fail_on.add("get")
    bodies = [await rpc(env, "CheckPerformTransaction", {"amount": AMOUNT, "account": acc()}),
              await rpc(env, "CheckTransaction", {"id": TXN}),
              await rpc(env, "CheckTransaction", {"id": TXN}, headers={"Authorization": basic("Paycom", "x")})]
    text = caplog.text + json.dumps(bodies)
    assert PAYME_KEY not in text and basic("Paycom", PAYME_KEY) not in text
    assert "payme handler failed" in caplog.text


def test_unavailable_response_keeps_http_200() -> None:
    out = payme.unavailable_response(json.dumps({"id": 15, "method": "CheckTransaction"}).encode())
    assert out.status_code == 200 and out.body["id"] == 15 and out.body["error"]["code"] == -32400
    assert payme.unavailable_response(b"\xff").body["id"] is None
    assert payme.rpc_method_label(b'{"method": "PerformTransaction"}') == "PerformTransaction"
    assert payme.rpc_method_label(b'{"method": "Evil<script>"}') == "rpc"


def test_transport_type_for_mock() -> None:
    assert isinstance(PaymeSubscribeApi().transport(), httpx.MockTransport)
