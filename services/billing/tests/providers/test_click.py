"""Click SHOP API и Merchant API — контрактные тесты по таблице INTERNAL_API §1.7 (строка таблицы = тест), сценарии
тест-утилиты Click на симуляторе, гонка двух попыток, исходящие вызовы: Auth, возврат, фискализация, сверка, повторы и
circuit breaker."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import timedelta
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from providers.fakes import Clock, FakePaymentPort, fiscal_item, provider_settings
from providers.simulators import (
    CLICK_MERCHANT_ID,
    CLICK_SECRET,
    CLICK_SERVICE_ID,
    ClickMerchantApi,
    ClickSim,
    click_sign,
)
from tilhero_billing.providers import click
from tilhero_billing.providers.base import ProviderAdapter
from tilhero_billing.providers.click import ClickAdapter
from tilhero_billing.providers.common import CheckoutUnavailable, ProviderHttp

ORDER = 100001
AMOUNT = 1_500_000  # 15 000 сум
AMOUNT_STR = "15000.00"


def make_env(api: ClickMerchantApi | None = None, **settings_kw: Any) -> SimpleNamespace:
    clock = Clock()
    settings = provider_settings(**settings_kw)
    port = FakePaymentPort(clock, enabled=settings.provider_enabled)
    port.add_order(ORDER, provider="click", amount_tiyin=AMOUNT, product_kind="til_pack",
                   fiscal_items=(fiscal_item(AMOUNT, title="100 тилов"),))
    api = api or ClickMerchantApi()

    async def statement(f: Any, t: Any) -> Any:
        return await port.statement("click", f, t)

    adapter = ClickAdapter(settings, transport=api.transport(), clock=clock, statement=statement)
    adapter.http.retry_delay = 0
    return SimpleNamespace(clock=clock, settings=settings, port=port, adapter=adapter, sim=ClickSim(), api=api)


@pytest.fixture
def env() -> SimpleNamespace:
    return make_env()


async def send(env: SimpleNamespace, operation: str, form: dict[str, str], **kw: Any) -> dict[str, Any]:
    out = await env.adapter.handle(env.sim.call(operation, form, at=env.clock(), **kw), env.port)
    assert out.status_code == 200
    body = dict(out.body)
    assert body["error_note"] == click.NOTES[body["error"]]
    assert out.result_code == str(body["error"])
    return body


async def prepare(env: SimpleNamespace, trans: str = "2001", amount: str = AMOUNT_STR, order: int | str = ORDER,
                  **over: str) -> dict[str, Any]:
    return await send(env, "prepare", env.sim.prepare_form(trans, order, amount, **over))


async def complete(env: SimpleNamespace, trans: str, prepare_id: int | str, amount: str = AMOUNT_STR,
                   error: str = "0", order: int | str = ORDER, **over: str) -> dict[str, Any]:
    return await send(env, "complete", env.sim.complete_form(trans, order, amount, prepare_id, error, **over))


# ---------------------------------------------------------------- Prepare

def test_adapter_satisfies_protocol(env: SimpleNamespace) -> None:
    assert isinstance(env.adapter, ProviderAdapter) and env.adapter.code == "click" and env.adapter.enabled()


async def test_prepare_success_and_repeat_same_prepare_id(env: SimpleNamespace) -> None:
    first = await prepare(env)
    assert first == {"click_trans_id": 2001, "merchant_trans_id": str(ORDER), "merchant_prepare_id": 1, "error": 0,
                     "error_note": "Success"}
    assert await prepare(env) == first  # повтор Prepare — тот же merchant_prepare_id
    txn = env.port.txns[("click", "2001")]
    assert txn.amount_tiyin == AMOUNT and txn.meta == {"click_paydoc_id": "92001"}
    assert txn.provider_time is not None and txn.provider_time.utcoffset() == timedelta(0)
    assert txn.provider_time.hour == 9  # 14:00 Ташкента (UTC+5) — §14 C4: пояс сверить


@pytest.mark.parametrize("missing", ["click_trans_id", "service_id", "merchant_trans_id", "amount", "action",
                                     "sign_time", "sign_string"])
async def test_prepare_missing_field_is_8(env: SimpleNamespace, missing: str) -> None:
    form = env.sim.prepare_form("2001", ORDER, AMOUNT_STR)
    form.pop(missing)
    assert (await send(env, "prepare", form))["error"] == -8


async def test_prepare_duplicate_field_or_bad_encoding_is_8(env: SimpleNamespace) -> None:
    body = env.sim.encode(env.sim.prepare_form("2001", ORDER, AMOUNT_STR)) + b"&amount=1.00"
    call = env.sim.call("prepare", {})
    from dataclasses import replace
    out = await env.adapter.handle(replace(call, body=body), env.port)
    assert out.body["error"] == -8
    out = await env.adapter.handle(replace(call, body=b"amount=\xff"), env.port)
    assert out.body["error"] == -8


async def test_prepare_bad_signature_is_1(env: SimpleNamespace) -> None:
    assert (await prepare(env, sign_string="0" * 32))["error"] == -1
    # подпись по сумме «как пришла»: 15000.00 и 15000.0 — разные строки
    form = env.sim.prepare_form("2001", ORDER, AMOUNT_STR)
    form["amount"] = "15000.0"
    assert (await send(env, "prepare", form))["error"] == -1
    assert env.port.txns == {}


async def test_prepare_signature_over_amount_as_received(env: SimpleNamespace) -> None:
    """Подпись по строке «как пришла»: `15000.0` с верной подписью принимается, сумма разбирается целочисленно."""
    assert (await prepare(env, amount="15000.0"))["error"] == 0
    assert env.port.txns[("click", "2001")].amount_tiyin == AMOUNT


async def test_prepare_uppercase_signature_accepted(env: SimpleNamespace) -> None:
    form = env.sim.prepare_form("2001", ORDER, AMOUNT_STR)
    form["sign_string"] = form["sign_string"].upper()
    assert (await send(env, "prepare", form))["error"] == 0


async def test_prepare_wrong_service_id_is_1(env: SimpleNamespace) -> None:
    sim = ClickSim(service_id="99999")
    out = await env.adapter.handle(sim.call("prepare", sim.prepare_form("2001", ORDER, AMOUNT_STR)), env.port)
    assert out.body["error"] == -1


async def test_prepare_empty_secret_never_signs() -> None:
    env = make_env(click_secret_key="")
    form = ClickSim(secret="").prepare_form("2001", ORDER, AMOUNT_STR)
    assert (await send(env, "prepare", form))["error"] == -1


async def test_prepare_ip_allow_list() -> None:
    env = make_env(click_allowed_cidrs="213.230.106.112/28")
    assert (await send(env, "prepare", env.sim.prepare_form("2001", ORDER, AMOUNT_STR),
                       client_ip="213.230.106.115"))["error"] == 0
    assert (await send(env, "prepare", env.sim.prepare_form("2002", ORDER, AMOUNT_STR),
                       client_ip="10.0.0.1"))["error"] == -1


@pytest.mark.parametrize("flags", [{"payments_enabled": False}, {"click_enabled": False}])
async def test_prepare_disabled_is_9(flags: dict[str, bool]) -> None:
    env = make_env(**flags)
    assert (await prepare(env))["error"] == -9
    assert env.port.txns == {}


async def test_prepare_action_not_0_is_3(env: SimpleNamespace) -> None:
    assert (await prepare(env, action="1"))["error"] == -3
    assert (await prepare(env, action="x"))["error"] == -3


@pytest.mark.parametrize("case", ["missing", "not_web", "other_provider", "not_number"])
async def test_prepare_order_not_found_is_5(env: SimpleNamespace, case: str) -> None:
    env.port.add_order(200001, provider="click", channel="miniapp")
    env.port.add_order(200002, provider="payme")
    order = {"missing": 999999, "not_web": 200001, "other_provider": 200002, "not_number": "10OO01"}[case]
    assert (await prepare(env, order=order))["error"] == -5


@pytest.mark.parametrize("status,code", [("paid", -4), ("fulfilled", -4), ("cancelled", -9), ("expired", -9),
                                         ("refunded", -9)])
async def test_prepare_order_state(env: SimpleNamespace, status: str, code: int) -> None:
    env.port.orders[ORDER].status = status
    assert (await prepare(env))["error"] == code


@pytest.mark.parametrize("amount", ["15000.01", "14999.99", "15000.001", "1e4", " 15000.00", "15000,00", "-15000",
                                    "١٥٠٠٠", "+15000", "15000.", ".5", "1234567890123"])
async def test_prepare_amount_is_2(env: SimpleNamespace, amount: str) -> None:
    assert (await prepare(env, amount=amount))["error"] == -2
    assert env.port.txns == {}


async def test_prepare_amount_with_kopecks() -> None:
    env = make_env()
    env.port.add_order(100002, provider="click", amount_tiyin=1_500_050)
    assert (await prepare(env, order=100002, amount="15000.5"))["error"] == 0
    assert env.port.txns[("click", "2001")].amount_tiyin == 1_500_050


async def test_prepare_click_trans_id_of_other_order_is_8(env: SimpleNamespace) -> None:
    env.port.add_order(100002, provider="click", amount_tiyin=AMOUNT)
    await prepare(env)
    assert (await prepare(env, order=100002))["error"] == -8


async def test_prepare_database_failure_is_7(env: SimpleNamespace) -> None:
    env.port.fail_on.add("create")
    assert (await prepare(env))["error"] == -7


# ---------------------------------------------------------------- Complete

async def test_complete_success(env: SimpleNamespace) -> None:
    prep = await prepare(env)
    body = await complete(env, "2001", prep["merchant_prepare_id"])
    assert body == {"click_trans_id": 2001, "merchant_trans_id": str(ORDER), "merchant_confirm_id": 1, "error": 0,
                    "error_note": "Success"}
    assert env.port.orders[ORDER].status == "paid" and env.port.fulfilments == [ORDER]


async def test_complete_repeat_is_4(env: SimpleNamespace) -> None:
    prep = await prepare(env)
    await complete(env, "2001", prep["merchant_prepare_id"])
    assert (await complete(env, "2001", prep["merchant_prepare_id"]))["error"] == -4
    assert env.port.fulfilments == [ORDER]


@pytest.mark.parametrize("missing", ["merchant_prepare_id", "error", "sign_string", "amount"])
async def test_complete_missing_field_is_8(env: SimpleNamespace, missing: str) -> None:
    prep = await prepare(env)
    form = env.sim.complete_form("2001", ORDER, AMOUNT_STR, prep["merchant_prepare_id"])
    form.pop(missing)
    assert (await send(env, "complete", form))["error"] == -8


async def test_complete_bad_signature_is_1(env: SimpleNamespace) -> None:
    prep = await prepare(env)
    form = env.sim.complete_form("2001", ORDER, AMOUNT_STR, prep["merchant_prepare_id"])
    form["merchant_prepare_id"] = "2"  # подпись Complete включает merchant_prepare_id
    assert (await send(env, "complete", form))["error"] == -1
    assert env.port.fulfilments == []


async def test_complete_action_not_1_is_3(env: SimpleNamespace) -> None:
    prep = await prepare(env)
    assert (await complete(env, "2001", prep["merchant_prepare_id"], action="0"))["error"] == -3


@pytest.mark.parametrize("case", ["unknown_trans", "wrong_prepare_id", "foreign_prepare_id", "other_order"])
async def test_complete_transaction_not_found_is_6(env: SimpleNamespace, case: str) -> None:
    env.port.add_order(100002, provider="click", amount_tiyin=AMOUNT)
    await prepare(env)  # seq 1
    await prepare(env, trans="2002", order=100002)  # seq 2
    trans, prep, order = {"unknown_trans": ("2999", 1, ORDER), "wrong_prepare_id": ("2001", 77, ORDER),
                          "foreign_prepare_id": ("2001", 2, ORDER), "other_order": ("2001", 1, 100002)}[case]
    assert (await complete(env, trans, prep, order=order))["error"] == -6
    assert env.port.fulfilments == []


async def test_complete_with_click_error_cancels_and_is_9(env: SimpleNamespace) -> None:
    prep = await prepare(env)
    body = await complete(env, "2001", prep["merchant_prepare_id"], error="-5017")
    assert body["error"] == -9
    txn = env.port.txns[("click", "2001")]
    assert txn.state == "cancelled" and txn.cancel_reason == "provider_error"
    # повтор — по-прежнему -9; провести отменённую нельзя
    assert (await complete(env, "2001", prep["merchant_prepare_id"], error="-5017"))["error"] == -9
    assert (await complete(env, "2001", prep["merchant_prepare_id"]))["error"] == -9
    assert env.port.orders[ORDER].status == "pending"  # заказ можно оплатить новой попыткой


async def test_complete_click_error_after_performed_does_not_refund(env: SimpleNamespace) -> None:
    prep = await prepare(env)
    await complete(env, "2001", prep["merchant_prepare_id"])
    assert (await complete(env, "2001", prep["merchant_prepare_id"], error="-1"))["error"] == -4
    assert env.port.txns[("click", "2001")].state == "performed"


async def test_complete_amount_mismatch_is_2(env: SimpleNamespace) -> None:
    prep = await prepare(env)
    assert (await complete(env, "2001", prep["merchant_prepare_id"], amount="14000.00"))["error"] == -2
    assert (await complete(env, "2001", prep["merchant_prepare_id"], amount="15000.00.0"))["error"] == -2
    assert env.port.fulfilments == []


async def test_complete_second_attempt_after_order_paid_is_4(env: SimpleNamespace) -> None:
    a = await prepare(env, trans="2001")
    b = await prepare(env, trans="2002")  # Click: несколько попыток по заказу в created
    assert (a["error"], b["error"]) == (0, 0)
    assert (await complete(env, "2001", a["merchant_prepare_id"]))["error"] == 0
    assert (await complete(env, "2002", b["merchant_prepare_id"]))["error"] == -4
    assert env.port.fulfilments == [ORDER]


async def test_complete_two_attempts_concurrently(env: SimpleNamespace) -> None:
    a = await prepare(env, trans="2001")
    b = await prepare(env, trans="2002")
    results = await asyncio.gather(complete(env, "2001", a["merchant_prepare_id"]),
                                   complete(env, "2002", b["merchant_prepare_id"]))
    assert sorted(r["error"] for r in results) == [-4, 0]
    assert env.port.fulfilments == [ORDER]


async def test_complete_when_disabled_still_processes(env: SimpleNamespace) -> None:
    prep = await prepare(env)
    disabled = make_env(click_enabled=False)
    disabled.port, disabled.clock = env.port, env.clock
    env.port.enabled = lambda provider: False
    assert (await complete(disabled, "2001", prep["merchant_prepare_id"]))["error"] == 0


async def test_complete_database_failure_is_7(env: SimpleNamespace) -> None:
    prep = await prepare(env)
    env.port.fail_on.add("perform")
    assert (await complete(env, "2001", prep["merchant_prepare_id"]))["error"] == -7


async def test_test_utility_scenarios(env: SimpleNamespace) -> None:
    """Сценарии тест-утилиты Click (по документации): успешная оплата, отмена Click, неверная подпись, неверная сумма,
    несуществующий заказ, повтор Complete, Complete несуществующей транзакции."""
    env.port.add_order(100002, provider="click", amount_tiyin=AMOUNT)
    ok = await prepare(env, trans="3001")
    assert (await complete(env, "3001", ok["merchant_prepare_id"]))["error"] == 0
    assert (await complete(env, "3001", ok["merchant_prepare_id"]))["error"] == -4
    cancel = await prepare(env, trans="3002", order=100002)
    assert (await complete(env, "3002", cancel["merchant_prepare_id"], error="-9", order=100002))["error"] == -9
    assert (await prepare(env, trans="3003", order=100002, sign_string="f" * 32))["error"] == -1
    assert (await prepare(env, trans="3004", order=100002, amount="1.00"))["error"] == -2
    assert (await prepare(env, trans="3005", order=424242))["error"] == -5
    assert (await complete(env, "3999", 999))["error"] == -6


def test_unknown_operation_and_unavailable_response() -> None:
    out = click.unavailable_response("complete", ClickSim.encode({"click_trans_id": "5", "merchant_trans_id": "1"}))
    assert out.status_code == 200 and out.body["error"] == -7 and out.body["merchant_confirm_id"] is None
    assert out.body["click_trans_id"] == 5


# ---------------------------------------------------------------- ссылка оплаты

async def test_checkout_button_url(env: SimpleNamespace) -> None:
    co = await env.adapter.checkout(env.port.orders[ORDER].view(), locale="ru", return_url=None)
    parts = urlsplit(co.url)
    assert (parts.scheme, parts.netloc, parts.path) == ("https", "my.click.uz", "/services/pay")
    assert parse_qs(parts.query) == {"service_id": [CLICK_SERVICE_ID], "merchant_id": [CLICK_MERCHANT_ID],
                                     "amount": ["15000.00"], "transaction_param": [str(ORDER)],
                                     "return_url": [f"https://pay.tilhero.test/orders/{ORDER}"]}
    assert "return_url=https%3A%2F%2Fpay.tilhero.test%2Forders%2F100001" in parts.query


async def test_checkout_amount_n_nn_from_integer_tiyin() -> None:
    env = make_env()
    env.port.add_order(100002, provider="click", amount_tiyin=100)
    co = await env.adapter.checkout(env.port.orders[100002].view(), locale="uz", return_url=None)
    assert parse_qs(urlsplit(co.url).query)["amount"] == ["1.00"]


async def test_checkout_unavailable() -> None:
    env = make_env(click_merchant_id="")
    with pytest.raises(CheckoutUnavailable):
        await env.adapter.checkout(env.port.orders[ORDER].view(), locale="ru", return_url=None)


# ---------------------------------------------------------------- Merchant API: возврат

async def performed(env: SimpleNamespace, trans: str = "2001") -> Any:
    prep = await prepare(env, trans=trans)
    await complete(env, trans, prep["merchant_prepare_id"])
    env.api.payments[str(ORDER)] = {"payment_id": "9" + trans, "status": 2}
    return await env.port.get("click", trans)


async def test_refund_reversal_ok_and_auth_header(env: SimpleNamespace) -> None:
    txn = await performed(env)
    outcome = await env.adapter.refund(txn, account_id=None)
    assert outcome.kind == "api_ok"
    method, op, _ = env.api.requests[-1]
    assert (method, op) == ("DELETE", "reversal") and env.api.bad_auth == 0
    assert env.api.payments[str(ORDER)]["status"] == -99


async def test_refund_rejected_is_api_failed(env: SimpleNamespace) -> None:
    txn = await performed(env)
    env.api.reversal_code = -5014
    outcome = await env.adapter.refund(txn, account_id=None)
    assert outcome.kind == "api_failed" and outcome.failure_code == "CLICK_-5014"


async def test_refund_payment_id_lookup_by_status_by_mti(env: SimpleNamespace) -> None:
    txn = await performed(env)
    from dataclasses import replace
    txn = replace(txn, provider_meta={})  # нет click_paydoc_id — ищем payment_id по номеру заказа
    assert (await env.adapter.refund(txn, account_id=None)).kind == "api_ok"
    assert [op for _, op, _ in env.api.requests] == ["status_by_mti", "reversal"]


async def test_refund_not_retried_after_request_was_sent(env: SimpleNamespace) -> None:
    """Неидемпотентная отмена: обрыв после отправки (ReadTimeout) не повторяется; не установленное соединение —
    повторяется один раз."""
    txn = await performed(env)
    env.api.fail_read["reversal"] = 1
    outcome = await env.adapter.refund(txn, account_id=None)
    assert outcome.kind == "api_failed" and outcome.failure_code == "CLICK_UNAVAILABLE_TIMEOUT"
    assert [op for _, op, _ in env.api.requests].count("reversal") == 1
    env.api.fail_network["reversal"] = 1
    assert (await env.adapter.refund(txn, account_id=None)).kind == "api_ok"
    assert [op for _, op, _ in env.api.requests].count("reversal") == 3


async def test_refund_5xx_is_not_retried_for_commands(env: SimpleNamespace) -> None:
    txn = await performed(env)
    env.api.fail_5xx["reversal"] = 1
    outcome = await env.adapter.refund(txn, account_id=None)
    assert outcome.kind == "api_failed" and outcome.failure_code == "CLICK_UNAVAILABLE_HTTP_503"
    assert [op for _, op, _ in env.api.requests].count("reversal") == 1


async def test_refund_not_configured_or_not_performed() -> None:
    env = make_env(click_merchant_user_id="")
    txn = await performed(env)
    assert (await env.adapter.refund(txn, account_id=None)).failure_code == "CLICK_NOT_CONFIGURED"
    env2 = make_env()
    await prepare(env2)
    created = await env2.port.get("click", "2001")
    assert (await env2.adapter.refund(created, account_id=None)).failure_code == "TXN_NOT_PERFORMED"


# ---------------------------------------------------------------- Merchant API: фискализация

async def test_fiscalize_submit_items_and_receipt_link(env: SimpleNamespace) -> None:
    txn = await performed(env)
    outcome = await env.adapter.fiscalize(txn, env.port.orders[ORDER].view())
    assert outcome.kind == "registered" and outcome.qr_code_url == env.api.qr_url
    assert outcome.provider_receipt_id == "92001"
    sent = env.api.submitted["92001"]
    assert sent == {"service_id": int(CLICK_SERVICE_ID), "payment_id": 92001, "received_ecash": 0,
                    "received_cash": 0, "received_card": AMOUNT,
                    "items": [{"Name": "100 тилов", "SPIC": "10305008002000000", "PackageCode": "1545643",
                               "Price": AMOUNT, "Amount": 1, "VAT": 160_714, "VATPercent": 12, "Units": 1,
                               "CommissionInfo": {"TIN": "123456789"}}]}
    # повторный вызов (tick) не отправляет второй чек
    again = await env.adapter.fiscalize(txn, env.port.orders[ORDER].view())
    assert again.kind == "registered"
    assert [op for _, op, _ in env.api.requests].count("submit_items") == 1


async def test_fiscalize_pinfl_commission_and_no_units() -> None:
    env = make_env()
    env.port.orders[ORDER].fiscal_items = (fiscal_item(AMOUNT, tin="12345678901234", units=None, vat_percent=0),)
    txn = await performed(env)
    await env.adapter.fiscalize(txn, env.port.orders[ORDER].view())
    item = env.api.submitted["92001"]["items"][0]
    assert item["CommissionInfo"] == {"PINFL": "12345678901234"} and "Units" not in item and item["VAT"] == 0


async def test_fiscalize_errors_are_pending_for_retry(env: SimpleNamespace) -> None:
    txn = await performed(env)
    env.api.submit_code = -31
    outcome = await env.adapter.fiscalize(txn, env.port.orders[ORDER].view())
    assert outcome.kind == "pending" and outcome.status_code == -31 and outcome.message == "Invalid SPIC"
    env.api.submit_code = 0
    env.api.fail_network["submit_items"] = 2
    outcome = await env.adapter.fiscalize(txn, env.port.orders[ORDER].view())
    assert outcome.kind == "pending" and outcome.message == "CLICK_UNAVAILABLE_NETWORK"


async def test_fiscalize_no_op_cases(env: SimpleNamespace) -> None:
    txn = await performed(env)
    order = env.port.orders[ORDER]
    order.fiscal_items = ()
    assert (await env.adapter.fiscalize(txn, order.view())).kind == "no_op"  # dev/test без реквизитов
    from dataclasses import replace
    assert (await env.adapter.fiscalize(replace(txn, state="refunded"), order.view())).kind == "no_op"  # §14 C4


# ---------------------------------------------------------------- Merchant API: сверка

async def test_remote_status_by_mti(env: SimpleNamespace) -> None:
    env.port.add_order(100002, provider="click", amount_tiyin=AMOUNT)
    since = env.clock()
    await performed(env)
    await prepare(env, trans="2002", order=100002)
    records = await env.adapter.remote_status(since - timedelta(minutes=1))
    assert records is not None
    by_order = {r.order_ref: r for r in records}
    assert by_order[str(ORDER)].state == "performed" and by_order[str(ORDER)].meta["payment_id"] == "92001"
    assert by_order[str(ORDER)].provider_txn_id == "2001"  # ядро сопоставляет по provider_txn_id
    assert by_order["100002"].state == "unknown" and by_order["100002"].meta["error_code"] == -16
    assert by_order["100002"].provider_txn_id == "2002"
    assert all(r.provider == "click" for r in records)
    # после нашего возврата Click отдаёт отрицательный статус — это refunded, а не расхождение
    txn = await env.port.get("click", "2001")
    assert (await env.adapter.refund(txn, account_id=None)).kind == "api_ok"
    await env.port.refunded("click", "2001")
    records = await env.adapter.remote_status(since - timedelta(minutes=1))
    assert records is not None and {r.order_ref: r.state for r in records}[str(ORDER)] == "refunded"


async def test_remote_status_none_without_statement_or_on_failure() -> None:
    env = make_env()
    no_source = ClickAdapter(env.settings, transport=env.api.transport(), clock=env.clock)
    assert await no_source.remote_status(env.clock()) is None
    await prepare(env)
    env.api.fail_5xx["status_by_mti"] = 2
    assert await env.adapter.remote_status(env.clock() - timedelta(hours=1)) is None
    assert [op for _, op, _ in env.api.requests].count("status_by_mti") == 2  # чтение: один повтор на 5xx


async def test_circuit_breaker_opens_after_failures(env: SimpleNamespace) -> None:
    txn = await performed(env)
    env.api.fail_5xx["status_by_mti"] = 100
    from dataclasses import replace
    no_meta = replace(txn, provider_meta={})
    for _ in range(3):
        await env.adapter.refund(no_meta, account_id=None)
    calls = len(env.api.requests)
    outcome = await env.adapter.refund(no_meta, account_id=None)
    assert outcome.failure_code == "CLICK_UNAVAILABLE_CIRCUIT_OPEN"
    assert len(env.api.requests) == calls  # провайдер не вызывается, пока breaker открыт


def test_timeout_is_10_seconds(env: SimpleNamespace) -> None:
    assert isinstance(env.adapter.http, ProviderHttp) and env.adapter.http.timeout == 10.0
    assert env.adapter.http.retries == 1


# ---------------------------------------------------------------- секреты

async def test_secret_never_logged_or_returned(env: SimpleNamespace, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    bodies = [await prepare(env), await prepare(env, trans="2002", sign_string="a" * 32)]
    env.port.fail_on.add("create")
    bodies.append(await prepare(env, trans="2004"))
    text = caplog.text + json.dumps(bodies) + repr(env.adapter.__dict__)
    assert CLICK_SECRET not in text
    sign = click_sign(env.sim.prepare_form("2001", ORDER, AMOUNT_STR), CLICK_SECRET, complete=False)
    assert sign not in caplog.text
