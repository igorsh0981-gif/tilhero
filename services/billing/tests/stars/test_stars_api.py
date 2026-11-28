"""Маршруты billing /internal/v1/stars/* (INTERNAL_API §1.5, §1.17): только iss=telegram-bot-gateway; pre-checkout —
каждая строка проверок, повтор query_id — тот же ответ, бюджет ≤ 2,5 с; платёж — первый и продление, повтор и гонка
одного charge id без второй выдачи, несоответствия — не отказ; возврат; обновления подписки; без Telegram ID и
charge id в логах. PaymentPort — фейк по контракту §1.4 (ядро потока A подключится через app.state.payment_port)."""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import timedelta
from typing import Any
from uuid import uuid4

import httpx
import pytest
from stars_testkit import ACCOUNT, NOW, OTHER_ACCOUNT, FakeBotGateway, FakePort, make_settings, order_view

from tilhero_billing.api import stars as stars_api
from tilhero_billing.clients import BOTGW
from tilhero_billing.domain.ports import InvalidState
from tilhero_billing.main import build_app
from tilhero_common.app import Runtime
from tilhero_common.testing import internal_headers

PATHS = ("/internal/v1/stars/pre-checkout", "/internal/v1/stars/payments", "/internal/v1/stars/refunds-received",
         "/internal/v1/stars/subscription-updates")


class Env:
    def __init__(self, client: httpx.AsyncClient, port: FakePort, settings: Any, app: Any) -> None:
        self.client, self.port, self.settings, self.app = client, port, settings, app

    def headers(self, issuer: str = "telegram-bot-gateway", **kw: Any) -> dict[str, str]:
        return internal_headers(self.settings, issuer=issuer, **kw)

    async def post(self, path: str, body: Any, *, issuer: str = "telegram-bot-gateway") -> httpx.Response:
        return await self.client.post(f"/internal/v1/stars/{path}", json=body, headers=self.headers(issuer))


@asynccontextmanager
async def billing(port: FakePort | None = None, *, wire_port: bool = True, **settings_kw: Any):
    settings = make_settings(**settings_kw)
    app = build_app(settings, Runtime(settings), transports={BOTGW: FakeBotGateway().transport()},
                    routers=[stars_api.router])
    port = port or FakePort()
    if wire_port:
        app.state.payment_port = port  # вместо PaymentService ядра (main.py ставит его всегда)
    elif hasattr(app.state, "payment_port"):
        del app.state.payment_port  # порт не подключён и БД нет — маршрут отвечает 503
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)  # 5xx приложения — ответом
        async with httpx.AsyncClient(transport=transport, base_url="http://billing") as client:
            yield Env(client, port, settings, app)


@pytest.fixture
async def env():
    async with billing() as e:
        yield e


def pre_checkout(ref: str, *, amount: int = 250, account=ACCOUNT, currency: str = "XTR",
                 query_id: str | None = None) -> dict[str, Any]:
    return {"query_id": query_id or f"q-{uuid4().hex}", "account_id": str(account) if account else None,
            "currency": currency, "total_amount": amount, "invoice_payload": ref}


def payment(ref: str, charge: str = "stxTEST-charge-0001", *, amount: int = 250, account=ACCOUNT,
            **kw: Any) -> dict[str, Any]:
    body = {"telegram_payment_charge_id": charge, "account_id": str(account) if account else None,
            "currency": "XTR", "total_amount": amount, "invoice_payload": ref, "is_recurring": False,
            "is_first_recurring": False, "subscription_expiration_date": None, "paid_at": NOW.isoformat()}
    body.update(kw)
    return body


# ---------------------------------------------------------------- доступ

async def test_only_bot_gateway_may_call(env) -> None:
    ref = env.port.add_order()
    for path in PATHS:
        assert (await env.client.post(path, json={})).status_code == 401
        for issuer in ("telegram-bff", "billing", "notifications", "admin-bff", "lessons"):
            r = await env.client.post(path, json={}, headers=env.headers(issuer))
            assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", (path, issuer)
        wrong_aud = env.headers(audience="telegram-bot-gateway")
        assert (await env.client.post(path, json={}, headers=wrong_aud)).status_code == 401
    assert env.port.paid_calls == [] and env.port.pre_checkouts == {}
    ok = await env.post("pre-checkout", pre_checkout(ref))
    assert ok.status_code == 200 and ok.json() == {"ok": True}


async def test_payment_port_not_wired_is_503() -> None:
    async with billing(wire_port=False) as e:
        r = await e.post("payments", payment(f"o:{uuid4()}"))
        assert r.status_code == 503 and r.json()["code"] == "BILLING_NOT_READY"


# ---------------------------------------------------------------- pre-checkout

async def test_pre_checkout_ok_and_every_rejection_row(env) -> None:
    port = env.port
    ok_ref = port.add_order()
    assert (await env.post("pre-checkout", pre_checkout(ok_ref))).json() == {"ok": True}
    closed = port.add_order(expired=True)
    paid_ref = port.add_order(replace(order_view(), status="fulfilled"))
    sub_ref = port.add_order(order_view(mode="subscription", amount=300))
    port.live_subscription_accounts.add(ACCOUNT)
    cases = [
        (pre_checkout(f"o:{uuid4()}"), "order_not_found"),  # заказа нет
        (pre_checkout("o:not-a-uuid"), "order_not_found"),  # payload не наш
        (pre_checkout(closed), "order_closed"),  # истёк / отменён
        (pre_checkout(ok_ref, amount=251), "amount_mismatch"),
        (pre_checkout(ok_ref, currency="USD"), "amount_mismatch"),
        (pre_checkout(ok_ref, account=OTHER_ACCOUNT), "payer_mismatch"),  # чужой заказ
        (pre_checkout(ok_ref, account=None), "payer_mismatch"),  # Telegram-пользователь без аккаунта
        (pre_checkout(paid_ref), "already_paid"),
        (pre_checkout(sub_ref, amount=300), "subscription_exists"),  # вторая подписка при живой
    ]
    for body, error in cases:
        r = await env.post("pre-checkout", body)
        assert r.status_code == 200 and r.json() == {"ok": False, "error": error}, (body, r.text)
    port.disabled = True  # PAYMENTS_ENABLED / STARS_ENABLED выключены — решает PaymentPort.check
    r = await env.post("pre-checkout", pre_checkout(ok_ref))
    assert r.json() == {"ok": False, "error": "payments_disabled"}


async def test_pre_checkout_renewal_of_live_subscription_is_ok(env) -> None:
    """§14 S2: если Telegram пришлёт pre_checkout_query на автопродление — payload первого заказа живой подписки того
    же плательщика → ok (решает PaymentPort.check)."""
    port = env.port
    ref = port.add_order(order_view(mode="subscription", amount=300))
    await env.post("payments", payment(ref, "stxTEST-first", amount=300, is_recurring=True, is_first_recurring=True,
                                       subscription_expiration_date=(NOW + timedelta(days=30)).isoformat()))
    assert (await env.post("pre-checkout", pre_checkout(ref, amount=300))).json() == {"ok": True}
    other = await env.post("pre-checkout", pre_checkout(ref, amount=300, account=OTHER_ACCOUNT))
    assert other.json() == {"ok": False, "error": "already_paid"}


async def test_pre_checkout_repeat_query_id_gives_same_answer(env) -> None:
    port = env.port
    ref = port.add_order()
    body = pre_checkout(ref, query_id="q-repeat-1")
    assert (await env.post("pre-checkout", body)).json() == {"ok": True}
    port.orders[ref].expired = True  # заказ изменился — ответ на тот же query_id прежний
    again = await env.post("pre-checkout", body)
    assert again.json() == {"ok": True, "replayed": True}
    assert (await env.post("pre-checkout", {**body, "query_id": "q-repeat-2"})).json()["error"] == "order_closed"
    assert port.pre_checkouts == {"q-repeat-1": (True, None), "q-repeat-2": (False, "order_closed")}


async def test_pre_checkout_over_budget_is_503(monkeypatch) -> None:
    monkeypatch.setattr(stars_api, "PRE_CHECKOUT_BUDGET_SECONDS", 0.05)
    port = FakePort(check_delay=0.5)
    async with billing(port) as e:
        ref = port.add_order()
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        r = await e.post("pre-checkout", pre_checkout(ref, query_id="q-slow"))
        assert r.status_code == 503 and r.json()["code"] == "STARS_PRE_CHECKOUT_TIMEOUT"
        assert loop.time() - t0 < 0.4
        assert port.pre_checkouts == {}  # ответа не было — журнал пуст


def test_pre_checkout_budget_fits_bot_gateway_timeout() -> None:
    assert stars_api.PRE_CHECKOUT_BUDGET_SECONDS < 3.0  # bot-gateway ждёт billing 3 с, Telegram — 10 с


# ---------------------------------------------------------------- платёж

async def test_one_time_payment_is_recorded_once(env) -> None:
    port = env.port
    ref = port.add_order()
    first = await env.post("payments", payment(ref, "stxTEST-once"))
    assert first.status_code == 200 and first.json() == {"ok": True}
    again = await env.post("payments", payment(ref, "stxTEST-once"))  # повтор обновления
    assert again.status_code == 200
    assert port.grants == [(ref, "stxTEST-once")] and list(port.txns) == ["stxTEST-once"]
    call = port.paid_calls[0]
    assert call["order_ref"] == ref and call["amount"] == 250 and call["payer"] == ACCOUNT
    assert call["time"] == NOW and call["meta"] == {"is_recurring": False, "is_first_recurring": False}
    rec = call["recurring"]
    assert (rec.is_recurring, rec.is_first_recurring, rec.subscription_expiration_date) == (False, False, None)


async def test_concurrent_same_charge_credits_once(env) -> None:
    port = env.port
    ref = port.add_order()
    results = await asyncio.gather(*[env.post("payments", payment(ref, "stxTEST-race")) for _ in range(6)])
    assert {r.status_code for r in results} == {200}
    assert port.grants == [(ref, "stxTEST-race")]


async def test_subscription_first_payment_and_renewal(env) -> None:
    port = env.port
    ref = port.add_order(order_view(mode="subscription", amount=300))
    exp1, exp2 = NOW + timedelta(days=30), NOW + timedelta(days=60)
    first = payment(ref, "stxTEST-sub-1", amount=300, is_recurring=True, is_first_recurring=True,
                    subscription_expiration_date=exp1.isoformat())
    renewal = payment(ref, "stxTEST-sub-2", amount=300, is_recurring=True, is_first_recurring=False,
                      subscription_expiration_date=exp2.isoformat(),
                      paid_at=(NOW + timedelta(days=30)).isoformat())
    assert (await env.post("payments", first)).status_code == 200
    assert (await env.post("payments", renewal)).status_code == 200
    r1, r2 = (c["recurring"] for c in port.paid_calls)
    assert (r1.is_recurring, r1.is_first_recurring, r1.subscription_expiration_date) == (True, True, exp1)
    assert (r2.is_recurring, r2.is_first_recurring, r2.subscription_expiration_date) == (True, False, exp2)
    assert port.paid_calls[1]["meta"] == {"is_recurring": True, "is_first_recurring": False}
    assert set(port.txns) == {"stxTEST-sub-1", "stxTEST-sub-2"}


async def test_payment_mismatches_are_not_rejected(env) -> None:
    """Деньги уже получены: заказ не найден, плательщик пустой или чужой, второй платёж по оплаченному заказу — 200 и
    пункт сверки, не отказ (ядро поднимает OrderNotFound / AlreadyPaid после фиксации — тоже 2xx)."""
    port = env.port
    ref = port.add_order()
    cases = [(payment(f"o:{uuid4()}", "stxTEST-m1"), {"ok": True, "reconciliation": "ORDER_NOT_FOUND"}),
             (payment(ref, "stxTEST-m2", account=None), {"ok": True}),
             (payment(ref, "stxTEST-m3", account=OTHER_ACCOUNT), {"ok": True}),
             (payment("garbage", "stxTEST-m4"), {"ok": True, "reconciliation": "ORDER_NOT_FOUND"}),
             (payment(ref, "stxTEST-m5", currency="USD"), {"ok": True}),
             (payment(ref, "stxTEST-m6"), {"ok": True, "reconciliation": "ALREADY_PAID"})]  # второй платёж
    for body, expected in cases:
        r = await env.post("payments", body)
        assert r.status_code == 200 and r.json() == expected, r.text
    assert set(port.txns) == {"stxTEST-m2", "stxTEST-m3", "stxTEST-m5"}
    assert port.paid_calls[4]["meta"]["currency"] == "USD"
    assert [k for k, _ in port.recon] == ["unmatched_settlement", "payer_mismatch", "payer_mismatch",
                                          "unmatched_settlement", "duplicate_payment"]


async def test_payment_not_recorded_is_not_2xx(env) -> None:
    ref = env.port.add_order()
    env.port.fail_with = InvalidState("order refunded")
    r = await env.post("payments", payment(ref, "stxTEST-fail"))
    assert r.status_code == 409 and r.json()["code"] == "INVALID_STATE"


async def test_payment_storage_failure_is_5xx() -> None:
    port = FakePort(fail_with=RuntimeError("db down"))
    async with billing(port) as e:
        r = await e.post("payments", payment(port.add_order(), "stxTEST-db"))
        assert r.status_code == 500  # bot-gateway → Telegram 503 → повтор


@pytest.mark.parametrize("mutate", [
    lambda b: {**b, "telegram_user_id": 918273645},  # Telegram ID в billing не принимается
    lambda b: {**b, "total_amount": True},
    lambda b: {**b, "total_amount": "250"},
    lambda b: {**b, "invoice_payload": "я" * 65},  # > 128 байт
    lambda b: {**b, "telegram_payment_charge_id": ""},
    lambda b: {**b, "telegram_payment_charge_id": "x" * 129},
    lambda b: {k: v for k, v in b.items() if k != "paid_at"},
    lambda b: {**b, "paid_at": "2026-11-22T09:00:00"},  # без пояса
    lambda b: {k: v for k, v in b.items() if k != "account_id"},
])
async def test_payment_body_validation(env, mutate) -> None:
    ref = env.port.add_order()
    r = await env.post("payments", mutate(payment(ref)))
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"
    assert "918273645" not in r.text
    assert env.port.paid_calls == []


async def test_invalid_json_is_400(env) -> None:
    r = await env.client.post("/internal/v1/stars/payments", content=b"{nope",
                              headers={**env.headers(), "content-type": "application/json"})
    assert r.status_code == 400 and r.json()["code"] == "STARS_BODY_INVALID"


# ---------------------------------------------------------------- возврат и подписка

async def test_refund_received(env) -> None:
    port = env.port
    ref = port.add_order()
    await env.post("payments", payment(ref, "stxTEST-refund"))
    body = {"telegram_payment_charge_id": "stxTEST-refund", "total_amount": 250, "invoice_payload": ref}
    assert (await env.post("refunds-received", body)).json() == {"ok": True}
    assert (await env.post("refunds-received", body)).status_code == 200  # повтор — без изменений
    assert port.txns["stxTEST-refund"].state == "refunded"
    unknown = await env.post("refunds-received", {**body, "telegram_payment_charge_id": "stxTEST-unknown"})
    assert unknown.status_code == 409 and unknown.json()["code"] == "STARS_TXN_NOT_FOUND"  # Telegram повторит


async def test_subscription_updates(env) -> None:
    port = env.port
    ref = port.add_order(order_view(mode="subscription", amount=300))
    await env.post("payments", payment(ref, "stxTEST-sub", amount=300, is_recurring=True, is_first_recurring=True,
                                       subscription_expiration_date=(NOW + timedelta(days=30)).isoformat()))
    for state in ("canceled", "active", "failed"):
        r = await env.post("subscription-updates", {"account_id": str(ACCOUNT), "invoice_payload": ref,
                                                    "state": state})
        assert r.json() == {"ok": True, "matched": True} and port.subscriptions[ref] == state
    unknown = await env.post("subscription-updates", {"account_id": None, "invoice_payload": f"o:{uuid4()}",
                                                      "state": "canceled"})
    assert unknown.status_code == 200 and unknown.json() == {"ok": True, "matched": False}  # пункт сверки — ядро
    bad = await env.post("subscription-updates", {"account_id": None, "invoice_payload": ref, "state": "expired"})
    assert bad.status_code == 422


# ---------------------------------------------------------------- журнал и логи

async def test_provider_calls_journal_and_logs_without_ids(env, caplog) -> None:
    port = env.port
    ref = port.add_order()
    await env.post("pre-checkout", pre_checkout(ref, query_id="q-journal"))
    await env.post("payments", payment(ref, "stxTEST-very-secret-charge"))
    await env.post("refunds-received", {"telegram_payment_charge_id": "stxTEST-nope", "total_amount": 1,
                                        "invoice_payload": ref})
    assert [(c["provider"], c["direction"], c["method"], c["result_code"]) for c in port.provider_calls] == [
        ("telegram_stars", "in", "pre_checkout", "ok"), ("telegram_stars", "in", "payment", "ok"),
        ("telegram_stars", "in", "refund_received", "STARS_TXN_NOT_FOUND")]
    assert port.provider_calls[1]["provider_txn_id"] == "stxTEST-very-secret-charge"  # в БД — можно, в логи — нет
    assert port.provider_calls[1]["order_no"] == 100_001
    text = caplog.text + json.dumps([r.__dict__ for r in caplog.records], default=str)
    assert "stxTEST-very-secret-charge" not in text and "stxTEST-nope" not in text
    assert ref not in text and str(ACCOUNT) not in text
