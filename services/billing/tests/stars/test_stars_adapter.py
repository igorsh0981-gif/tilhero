"""Адаптер Telegram Stars (INTERNAL_API §1.5, §2): счёт через bot-gateway (XTR, одна позиция, payload o:<order_id>,
subscription_period только для подписки), возврат (уже возвращён — ок), автопродление, выписка для сверки, no_op
фискализации. bot-gateway — httpx.MockTransport."""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from uuid import UUID, uuid4

import httpx
import pytest
from stars_testkit import (
    ACCOUNT,
    INVOICE_LINK,
    NOW,
    FakeBotGateway,
    gw_error,
    make_settings,
    order_view,
    statement_item,
    txn_view,
)

from tilhero_billing.providers import telegram_stars as stars
from tilhero_billing.providers.base import ProviderAdapter
from tilhero_billing.providers.telegram_stars import (
    StarsGatewayError,
    StarsPayerUnknown,
    TelegramStarsAdapter,
    invoice_request,
    order_payload,
)
from tilhero_common.http_client import ServiceClient
from tilhero_common.internal_auth import verify_token


def adapter_with(gw: FakeBotGateway, **settings_kw) -> TelegramStarsAdapter:
    settings = make_settings(**settings_kw)
    client = ServiceClient(settings, target="telegram-bot-gateway", base_url=settings.botgw_url, retries=0,
                           transport=gw.transport())
    return TelegramStarsAdapter(settings, client)


# ---------------------------------------------------------------- протокол и флаги

def test_adapter_satisfies_protocol_and_flags() -> None:
    gw = FakeBotGateway()
    adapter = adapter_with(gw)
    assert isinstance(adapter, ProviderAdapter) and adapter.code == "telegram_stars"
    assert adapter.enabled() is True
    assert adapter_with(gw, stars_enabled=False).enabled() is False
    assert adapter_with(gw, payments_enabled=False).enabled() is False


# ---------------------------------------------------------------- счёт

def test_invoice_request_one_time_and_subscription() -> None:
    oid = UUID("3f2b8c1e-6a4d-4e0b-9c71-2d5e8f1a7b90")
    one = invoice_request(order_view(mode="one_time", amount=120, order_id=oid,
                                     stars_title={"ru": "100 тилов", "uz": "100 til"},
                                     description={"ru": "Пакет тилов", "uz": "Til toʻplami"}), "uz")
    assert one == {"order_id": str(oid), "title": "100 til", "description": "Til toʻplami",
                   "payload": f"o:{oid}", "amount_stars": 120, "subscription_period": None}
    assert len(one["payload"].encode()) <= 128
    sub = invoice_request(order_view(mode="subscription", amount=10_000), "ru")
    assert sub["subscription_period"] == 2_592_000 and sub["amount_stars"] == 10_000
    assert sub["title"] == "TilHero Плюс" and sub["description"] == "300 минут уроков с ИИ"


def test_invoice_request_limits_and_fallbacks() -> None:
    long_title = {"ru": "Очень длинное название счёта для Telegram Stars", "uz": "x"}
    req = invoice_request(order_view(stars_title=long_title, description={}), "ru")
    assert len(req["title"]) == 32 and req["title"].endswith("…")
    assert req["description"] == "TilHero Плюс — 30 дней"  # нет описания — название товара
    req = invoice_request(order_view(stars_title={"ru": "Только RU"}, description={"ru": "d" * 400}), "uz")
    assert req["title"] == "Только RU" and len(req["description"]) == 255  # нет UZ — RU


@pytest.mark.parametrize("kw", [
    {"provider": "payme", "currency": "UZS", "amount_tiyin": 4_900_000, "amount_stars": None, "stars_mode": None},
    {"mode": "subscription", "amount": 10_001},  # подписка Stars ≤ 10 000 (Bot API)
    {"mode": "subscription", "amount": 300, "kind": "til_pack"},
    {"amount": 0},
    {"amount": 100_001},
    {"amount": None},
    {"amount": True},
    {"title": {"ru": " "}, "stars_title": {}, "description": {}},
])
def test_invoice_request_rejects_bad_orders(kw) -> None:
    with pytest.raises(ValueError):
        invoice_request(order_view(**kw), "ru")


async def test_checkout_calls_bot_gateway_once_per_order() -> None:
    gw = FakeBotGateway()
    adapter = adapter_with(gw)
    order = order_view(mode="subscription", amount=300)
    out = await adapter.checkout(order, locale="ru", return_url=None)
    assert (out.kind, out.url) == ("invoice_link", INVOICE_LINK)
    [call] = gw.calls
    assert (call["method"], call["path"]) == ("POST", "/internal/v1/stars/invoice-links")
    assert call["json"]["payload"] == order_payload(order.order_id) and call["json"]["amount_stars"] == 300
    assert call["json"]["subscription_period"] == 2_592_000
    token = verify_token(call["headers"]["x-internal-token"], "t" * 40, audience="telegram-bot-gateway")
    assert token.issuer == "billing" and token.subject is None
    # ссылка уже в заказе — повторного запроса нет
    again = await adapter.checkout(order_view(invoice_link=INVOICE_LINK), locale="ru", return_url=None)
    assert again.url == INVOICE_LINK and len(gw.calls) == 1


@pytest.mark.parametrize(("reply", "permanent"), [
    (gw_error(502, "TELEGRAM_ERROR", permanent=True, reason="bad_request"), True),
    (gw_error(502, "TELEGRAM_ERROR", permanent=False), False),
    (gw_error(503, "IDEMPOTENCY_UNAVAILABLE"), False),
    (httpx.ConnectError("down"), False),
    ((200, {"invoice_link": "http://evil.example/pay"}), False),
    ((200, {"invoice_link": "https://t.me/ bad"}), False),
    ((200, {"nope": 1}), False),
])
async def test_checkout_errors_are_stars_unavailable(reply, permanent: bool) -> None:
    gw = FakeBotGateway(queue=[reply])
    with pytest.raises(StarsGatewayError) as err:
        await adapter_with(gw).checkout(order_view(), locale="ru", return_url=None)
    assert err.value.status == 503 and err.value.code == "STARS_UNAVAILABLE"
    assert err.value.permanent is permanent and err.value.details == {"permanent": permanent}


# ---------------------------------------------------------------- возврат и подписка

@pytest.mark.parametrize(("reply", "kind", "failure"), [
    ((200, {"ok": True}), "api_ok", None),
    ((200, {"ok": True, "already": True}), "api_ok", None),  # «уже возвращён» — ок
    (gw_error(409, "STARS_PAYER_UNKNOWN"), "api_failed", "STARS_PAYER_UNKNOWN"),
    (gw_error(502, "TELEGRAM_ERROR", permanent=True, reason="bad_request"), "api_failed", "TELEGRAM_ERROR"),
    (gw_error(502, "TELEGRAM_ERROR", permanent=False), "api_failed", "STARS_UNAVAILABLE"),
    (httpx.ReadTimeout("slow"), "api_failed", "STARS_UNAVAILABLE"),
    ((200, {"ok": False}), "api_failed", "STARS_UNAVAILABLE"),
])
async def test_refund_outcomes(reply, kind: str, failure: str | None) -> None:
    gw = FakeBotGateway(queue=[reply])
    txn = txn_view("stxTEST-refund-0001")
    out = await adapter_with(gw).refund(txn, account_id=ACCOUNT)
    assert (out.kind, out.failure_code) == (kind, failure)
    [call] = gw.calls
    assert call["path"] == "/internal/v1/stars/refunds"
    assert call["json"] == {"account_id": str(ACCOUNT), "telegram_payment_charge_id": "stxTEST-refund-0001"}


async def test_refund_without_payer_does_not_call_gateway() -> None:
    gw = FakeBotGateway()
    out = await adapter_with(gw).refund(txn_view(), account_id=None)
    assert (out.kind, out.failure_code) == ("api_failed", "STARS_PAYER_UNKNOWN") and gw.calls == []
    with pytest.raises(ValueError):
        await adapter_with(gw).refund(replace(txn_view(), provider="payme"), account_id=ACCOUNT)
    assert gw.calls == []


async def test_edit_subscription() -> None:
    gw = FakeBotGateway()
    adapter = adapter_with(gw)
    await adapter.edit_subscription(account_id=ACCOUNT, first_charge_id="stxTEST-first", is_canceled=True)
    await adapter.edit_subscription(account_id=ACCOUNT, first_charge_id="stxTEST-first", is_canceled=False)
    assert [c["json"] for c in gw.calls] == [
        {"account_id": str(ACCOUNT), "telegram_payment_charge_id": "stxTEST-first", "is_canceled": True},
        {"account_id": str(ACCOUNT), "telegram_payment_charge_id": "stxTEST-first", "is_canceled": False},
    ]
    assert {c["path"] for c in gw.calls} == {"/internal/v1/stars/subscriptions/edit"}
    gw.queue.append(gw_error(409, "STARS_PAYER_UNKNOWN"))
    with pytest.raises(StarsPayerUnknown) as unknown:
        await adapter.edit_subscription(account_id=ACCOUNT, first_charge_id="stxTEST-first", is_canceled=True)
    assert (unknown.value.status, unknown.value.code) == (409, "STARS_PAYER_UNKNOWN")
    with pytest.raises(StarsPayerUnknown):
        await adapter.edit_subscription(account_id=None, first_charge_id="stxTEST-first", is_canceled=True)
    gw.queue.append(gw_error(502, "TELEGRAM_ERROR", permanent=False))
    with pytest.raises(StarsGatewayError):
        await adapter.edit_subscription(account_id=ACCOUNT, first_charge_id="stxTEST-first", is_canceled=True)


async def test_fiscalize_is_no_op() -> None:
    out = await adapter_with(FakeBotGateway()).fiscalize(txn_view(), order_view())
    assert out.kind == "no_op"


# ---------------------------------------------------------------- выписка (сверка)

async def test_remote_status_pages_filters_and_maps() -> None:
    gw = FakeBotGateway()
    since = NOW - timedelta(days=1)
    old = NOW - timedelta(days=3)
    payload = f"o:{uuid4()}"
    gw.statement = [statement_item(f"stxTEST-{i:04d}", date=old) for i in range(98)]  # старше since
    gw.statement += [
        statement_item("stxTEST-in", date=NOW, amount=300, payload=payload),
        statement_item("stxTEST-in", date=NOW + timedelta(minutes=5), amount=300, direction="out", payload=payload),
        statement_item("fragment-withdrawal", date=NOW, direction="out", partner_type="fragment",
                       transaction_type=None, payload=None),
        statement_item("ads", date=NOW, direction="out", partner_type="telegram_ads", transaction_type=None),
        {"id": 5, "amount": "x"},  # мусор — пропускается
    ]
    adapter = adapter_with(gw)
    records = await adapter.remote_status(since)
    assert [(r.provider_txn_id, r.direction, r.state, r.amount_stars) for r in records] == [
        ("stxTEST-in", "in", "performed", 300), ("stxTEST-in", "out", "refunded", 300)]
    assert all(r.order_ref == payload and r.amount_tiyin is None and r.provider == "telegram_stars" for r in records)
    assert records[0].at == NOW and records[0].meta == {"transaction_type": "invoice_payment"}
    assert [(c["params"]["offset"], c["params"]["limit"]) for c in gw.calls] == [("0", "100"), ("100", "100")]
    # наивная дата since — UTC
    assert len(await adapter.remote_status(since.replace(tzinfo=None))) == 2


async def test_remote_status_stops_early_on_newest_first_statement(monkeypatch) -> None:
    gw = FakeBotGateway()
    gw.statement = [statement_item(f"stxTEST-{i:04d}", date=NOW - timedelta(minutes=i)) for i in range(250)]
    records = await adapter_with(gw).remote_status(NOW - timedelta(minutes=50))
    assert len(records) == 51 and len(gw.calls) == 1  # первая страница уже старше since — дальше не читаем
    monkeypatch.setattr(stars, "STATEMENT_MAX_PAGES", 2)
    gw.statement = [statement_item(f"stxTEST-{i:04d}", date=NOW + timedelta(minutes=i)) for i in range(250)]
    gw.calls.clear()
    assert len(await adapter_with(gw).remote_status(NOW)) == 200 and len(gw.calls) == 2  # предел страниц


@pytest.mark.parametrize("reply", [gw_error(502, "TELEGRAM_ERROR", permanent=False), httpx.ConnectError("x"),
                                   (200, {"items": "nope"})])
async def test_remote_status_gateway_failure_raises(reply) -> None:
    with pytest.raises(StarsGatewayError):
        await adapter_with(FakeBotGateway(queue=[reply])).remote_status(NOW)


async def test_outgoing_calls_journal_and_logs(caplog) -> None:
    calls: list[dict] = []

    class Journal:
        async def record_call(self, provider, direction, method, result_code, latency_ms, *, provider_txn_id=None,
                              order_no=None, client_ip=None) -> None:
            calls.append({"provider": provider, "direction": direction, "method": method,
                          "result_code": result_code, "order_no": order_no, "provider_txn_id": provider_txn_id})

    gw = FakeBotGateway(queue=[(200, {"invoice_link": INVOICE_LINK}),
                               gw_error(502, "TELEGRAM_ERROR", permanent=True)])
    settings = make_settings()
    client = ServiceClient(settings, target="telegram-bot-gateway", base_url=settings.botgw_url, retries=0,
                           transport=gw.transport())
    adapter = TelegramStarsAdapter(settings, lambda: client, journal=Journal())
    order = order_view(order_no=100_777)
    await adapter.checkout(order, locale="ru", return_url=None)
    await adapter.refund(txn_view("stxTEST-secret-charge-777", order=order), account_id=ACCOUNT)
    assert [(c["method"], c["direction"], c["result_code"], c["order_no"]) for c in calls] == [
        ("createInvoiceLink", "out", "ok", 100_777), ("refundStarPayment", "out", "TELEGRAM_ERROR", 100_777)]
    assert calls[1]["provider"] == "telegram_stars" and calls[1]["provider_txn_id"] == "stxTEST-secret-charge-777"
    assert "stxTEST-secret-charge-777" not in caplog.text and str(ACCOUNT) not in caplog.text
