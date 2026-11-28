"""Внутренний API Stars для billing (INTERNAL_API спринта 8 §2): createInvoiceLink (XTR, одна позиция, пустой
provider_token, subscription_period только для подписки, идемпотентность по order_id), refundStarPayment (уже
возвращён — ок), editUserStarSubscription, getStarTransactions без данных пользователя; только iss=billing и только
внутренний порт; тестовая среда Telegram; токен бота и Telegram ID вне ответов и логов."""

from __future__ import annotations

import asyncio
import io
import logging
import uuid
from typing import Any

import httpx
import pytest
from botgw_testkit import ACCOUNT_ID, TG_USER, TOKEN, FakeIdentity, FakeTelegram, make_settings

from tilhero_botgw.main import build_apps
from tilhero_common.app import Runtime
from tilhero_common.logging import JsonFormatter
from tilhero_common.testing import internal_headers

ORDER_ID = "3f2b8c1e-6a4d-4e0b-9c71-2d5e8f1a7b90"


def invoice(**kw: Any) -> dict[str, Any]:
    body = {"order_id": ORDER_ID, "title": "TilHero Плюс", "description": "300 минут уроков с ИИ",
            "payload": f"o:{ORDER_ID}", "amount_stars": 300, "subscription_period": None}
    body.update(kw)
    return body


def auth(gw, issuer: str = "billing") -> dict[str, str]:
    return internal_headers(gw.settings, issuer=issuer)


def tg_error(code: int, description: str) -> tuple[int, dict[str, Any]]:
    return code, {"ok": False, "error_code": code, "description": description}


# ---------------------------------------------------------------- createInvoiceLink

async def test_invoice_link_one_time(gw) -> None:
    r = await gw.internal.post("/internal/v1/stars/invoice-links", json=invoice(), headers=auth(gw))
    assert r.status_code == 200 and r.json()["invoice_link"].startswith("https://t.me/")
    [(method, sent)] = gw.telegram.calls
    assert method == "createInvoiceLink"
    assert sent == {"title": "TilHero Плюс", "description": "300 минут уроков с ИИ", "payload": f"o:{ORDER_ID}",
                    "provider_token": "", "currency": "XTR", "prices": [{"label": "TilHero Плюс", "amount": 300}]}
    assert gw.telegram.tokens_seen == {TOKEN}


async def test_invoice_link_subscription(gw) -> None:
    body = invoice(subscription_period=2_592_000, amount_stars=10_000)
    r = await gw.internal.post("/internal/v1/stars/invoice-links", json=body, headers=auth(gw))
    assert r.status_code == 200
    sent = gw.telegram.sent("createInvoiceLink")[0]
    assert sent["subscription_period"] == 2_592_000 and sent["currency"] == "XTR" and len(sent["prices"]) == 1


async def test_invoice_link_idempotent_by_order(gw) -> None:
    first = await gw.internal.post("/internal/v1/stars/invoice-links", json=invoice(), headers=auth(gw))
    again = await gw.internal.post("/internal/v1/stars/invoice-links", json=invoice(), headers=auth(gw))
    assert first.json() == again.json() and again.headers["Idempotent-Replayed"] == "true"
    assert len(gw.telegram.sent("createInvoiceLink")) == 1
    other = await gw.internal.post("/internal/v1/stars/invoice-links", json=invoice(amount_stars=301),
                                   headers=auth(gw))
    assert other.status_code == 422 and other.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    body = invoice(order_id=str(uuid.uuid4()))
    results = await asyncio.gather(*[gw.internal.post("/internal/v1/stars/invoice-links", json=body,
                                                      headers=auth(gw)) for _ in range(4)])
    assert len(gw.telegram.sent("createInvoiceLink")) == 2 and {r.status_code for r in results} <= {200, 409}


@pytest.mark.parametrize("bad", [
    {"title": "x" * 33},
    {"title": ""},
    {"description": "d" * 256},
    {"payload": "я" * 65},  # > 128 байт
    {"amount_stars": 0},
    {"amount_stars": 100_001},
    {"amount_stars": True},
    {"amount_stars": "300"},
    {"subscription_period": 2_592_001},
    {"subscription_period": 2_592_000, "amount_stars": 10_001},  # подписка ≤ 10 000 Stars
    {"provider_token": "real-provider-token"},  # лишние поля не принимаются
    {"currency": "USD"},
    {"order_id": "not-a-uuid"},
])
async def test_invoice_link_validation(gw, bad: dict[str, Any]) -> None:
    r = await gw.internal.post("/internal/v1/stars/invoice-links", json=invoice(**bad), headers=auth(gw))
    assert r.status_code == 422, bad
    assert gw.telegram.calls == []


@pytest.mark.parametrize(("reply", "permanent"), [
    (tg_error(400, "Bad Request: STARS_INVOICE_INVALID"), True),
    (tg_error(500, "Internal Server Error"), False),
    ((429, {"ok": False, "error_code": 429, "description": "Too Many Requests", "parameters": {"retry_after": 3}}),
     False),
    (httpx.ConnectError("down"), False),
    ((200, {"ok": True, "result": "http://evil.example/invoice"}), False),
])
async def test_invoice_link_telegram_errors(gw, reply, permanent: bool) -> None:
    gw.telegram.queue.append(reply)
    r = await gw.internal.post("/internal/v1/stars/invoice-links", json=invoice(), headers=auth(gw))
    assert r.status_code == 502 and r.json()["code"] == "TELEGRAM_ERROR"
    assert r.json()["details"]["permanent"] is permanent
    retry = await gw.internal.post("/internal/v1/stars/invoice-links", json=invoice(), headers=auth(gw))
    assert retry.status_code == 200  # ключ идемпотентности освобождён


# ---------------------------------------------------------------- доступ

async def test_only_billing_on_internal_port(gw) -> None:
    calls = [("POST", "/internal/v1/stars/invoice-links", invoice()),
             ("POST", "/internal/v1/stars/refunds", {"account_id": ACCOUNT_ID, "telegram_payment_charge_id": "c"}),
             ("POST", "/internal/v1/stars/subscriptions/edit",
              {"account_id": ACCOUNT_ID, "telegram_payment_charge_id": "c", "is_canceled": True}),
             ("GET", "/internal/v1/stars/transactions", None)]
    for method, path, body in calls:
        assert (await gw.internal.request(method, path, json=body)).status_code == 401
        for issuer in ("notifications", "telegram-bff", "admin-bff", "telegram-bot-gateway"):
            r = await gw.internal.request(method, path, json=body, headers=auth(gw, issuer))
            assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", (path, issuer)
        public = await gw.client.request(method, path, json=body, headers=auth(gw))
        assert public.status_code == 404  # публичного внутреннего API нет
    msg = {"telegram_user_id": 1, "text": "x", "idempotency_key": "k" * 16}
    r = await gw.internal.post("/internal/v1/messages", json=msg, headers=auth(gw))
    assert r.status_code == 403  # billing сообщения не шлёт
    assert gw.telegram.calls == []


# ---------------------------------------------------------------- refundStarPayment и editUserStarSubscription

async def test_refund(gw) -> None:
    body = {"account_id": ACCOUNT_ID, "telegram_payment_charge_id": "stxTEST-charge-1"}
    r = await gw.internal.post("/internal/v1/stars/refunds", json=body, headers=auth(gw))
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert gw.identity.lookups == [f"/internal/v1/accounts/{ACCOUNT_ID}/telegram-user"]
    assert gw.telegram.sent("refundStarPayment") == [{"user_id": TG_USER,
                                                      "telegram_payment_charge_id": "stxTEST-charge-1"}]
    assert str(TG_USER) not in r.text


async def test_refund_already_refunded_is_ok(gw) -> None:
    gw.telegram.queue.append(tg_error(400, "Bad Request: CHARGE_ALREADY_REFUNDED"))
    body = {"account_id": ACCOUNT_ID, "telegram_payment_charge_id": "stxTEST-charge-1"}
    r = await gw.internal.post("/internal/v1/stars/refunds", json=body, headers=auth(gw))
    assert r.status_code == 200 and r.json() == {"ok": True, "already": True}


@pytest.mark.parametrize(("setup", "status", "code"), [
    ("payer_unknown", 409, "STARS_PAYER_UNKNOWN"),
    ("identity_down", 503, "UPSTREAM_UNAVAILABLE"),
    ("tg_400", 502, "TELEGRAM_ERROR"),
    ("tg_500", 502, "TELEGRAM_ERROR"),
])
async def test_refund_errors(gw, setup: str, status: int, code: str) -> None:
    account = ACCOUNT_ID
    if setup == "payer_unknown":
        account = str(uuid.uuid4())  # аккаунт удалён — Telegram ID неизвестен
    elif setup == "identity_down":
        gw.identity.lookup_statuses = [503, 503, 503]
    elif setup == "tg_400":
        gw.telegram.queue.append(tg_error(400, "Bad Request: CHARGE_NOT_FOUND"))
    else:
        gw.telegram.queue.append(tg_error(500, "Internal"))
    body = {"account_id": account, "telegram_payment_charge_id": "stxTEST-charge-1"}
    r = await gw.internal.post("/internal/v1/stars/refunds", json=body, headers=auth(gw))
    assert r.status_code == status and r.json()["code"] == code
    if setup in ("payer_unknown", "identity_down"):
        assert gw.telegram.calls == []
    if setup == "tg_400":
        assert r.json()["details"]["permanent"] is True
    if setup == "tg_500":
        assert r.json()["details"]["permanent"] is False


async def test_edit_subscription(gw) -> None:
    for canceled in (True, False):
        body = {"account_id": ACCOUNT_ID, "telegram_payment_charge_id": "stxTEST-first", "is_canceled": canceled}
        r = await gw.internal.post("/internal/v1/stars/subscriptions/edit", json=body, headers=auth(gw))
        assert r.status_code == 200 and r.json() == {"ok": True}
    assert gw.telegram.sent("editUserStarSubscription") == [
        {"user_id": TG_USER, "telegram_payment_charge_id": "stxTEST-first", "is_canceled": True},
        {"user_id": TG_USER, "telegram_payment_charge_id": "stxTEST-first", "is_canceled": False}]
    unknown = {"account_id": str(uuid.uuid4()), "telegram_payment_charge_id": "stxTEST-first", "is_canceled": True}
    r = await gw.internal.post("/internal/v1/stars/subscriptions/edit", json=unknown, headers=auth(gw))
    assert r.status_code == 409 and r.json()["code"] == "STARS_PAYER_UNKNOWN"
    bad = {"account_id": ACCOUNT_ID, "telegram_payment_charge_id": "stxTEST-first", "is_canceled": "yes"}
    assert (await gw.internal.post("/internal/v1/stars/subscriptions/edit", json=bad,
                                   headers=auth(gw))).status_code == 422


# ---------------------------------------------------------------- getStarTransactions

async def test_transactions_without_user_data(gw) -> None:
    tg_user = {"id": TG_USER, "is_bot": False, "first_name": "Игорь", "username": "igor_secret"}
    gw.telegram.queue.append((200, {"ok": True, "result": {"transactions": [
        {"id": "stxTEST-in", "amount": 300, "date": 1_763_802_000,
         "source": {"type": "user", "transaction_type": "invoice_payment", "user": tg_user,
                    "invoice_payload": f"o:{ORDER_ID}", "subscription_period": 2_592_000,
                    "affiliate": {"commission_per_mille": 100}}},
        {"id": "stxTEST-in", "amount": 300, "nanostar_amount": 5, "date": 1_763_900_000,
         "receiver": {"type": "user", "transaction_type": "invoice_payment", "user": tg_user,
                      "invoice_payload": f"o:{ORDER_ID}"}},
        {"id": "wd-1", "amount": 1000, "date": 1_763_950_000,
         "receiver": {"type": "fragment", "withdrawal_state": {"type": "succeeded", "date": 1, "url": "https://x"}}},
        {"id": 5, "amount": "bad"},
    ]}}))
    r = await gw.internal.get("/internal/v1/stars/transactions", params={"offset": 0, "limit": 100},
                              headers=auth(gw))
    assert r.status_code == 200
    assert r.json() == {"count": 4, "items": [
        {"id": "stxTEST-in", "amount": 300, "nanostar_amount": None, "date": 1_763_802_000, "direction": "in",
         "partner_type": "user", "transaction_type": "invoice_payment", "invoice_payload": f"o:{ORDER_ID}",
         "subscription_period": 2_592_000},
        {"id": "stxTEST-in", "amount": 300, "nanostar_amount": 5, "date": 1_763_900_000, "direction": "out",
         "partner_type": "user", "transaction_type": "invoice_payment", "invoice_payload": f"o:{ORDER_ID}",
         "subscription_period": None},
        {"id": "wd-1", "amount": 1000, "nanostar_amount": None, "date": 1_763_950_000, "direction": "out",
         "partner_type": "fragment", "transaction_type": None, "invoice_payload": None, "subscription_period": None},
    ]}
    for leaked in (str(TG_USER), "igor_secret", "Игорь", "commission", "withdrawal"):
        assert leaked not in r.text
    assert gw.telegram.sent("getStarTransactions") == [{"offset": 0, "limit": 100}]


async def test_transactions_params_and_errors(gw) -> None:
    for params in ({"limit": 0}, {"limit": 101}, {"offset": -1}):
        r = await gw.internal.get("/internal/v1/stars/transactions", params=params, headers=auth(gw))
        assert r.status_code == 422
    gw.telegram.queue.append(tg_error(500, "x"))
    r = await gw.internal.get("/internal/v1/stars/transactions", headers=auth(gw))
    assert r.status_code == 502 and r.json()["details"]["permanent"] is False
    gw.telegram.queue.append((200, {"ok": True, "result": {"nope": []}}))
    assert (await gw.internal.get("/internal/v1/stars/transactions", headers=auth(gw))).status_code == 502


# ---------------------------------------------------------------- тестовая среда, токен и логи

async def test_telegram_test_environment_paths() -> None:
    paths: list[str] = []
    telegram = FakeTelegram()

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        return telegram.handler(request)

    prefix = "t_botgw_testenv_" + uuid.uuid4().hex[:8]
    settings = make_settings(prefix, telegram_test_env=True)
    runtime = Runtime(settings)
    app, internal_app = build_apps(settings, runtime, telegram_transport=httpx.MockTransport(handler),
                                   identity_transport=httpx.MockTransport(FakeIdentity().handler))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=internal_app), base_url="http://botgw") as c:
            r = await c.post("/internal/v1/stars/invoice-links", json=invoice(),
                             headers=internal_headers(settings, issuer="billing"))
            assert r.status_code == 200
        assert runtime.redis is not None
        keys = [k async for k in runtime.redis.scan_iter(match=f"*{prefix}*")]
        if keys:
            await runtime.redis.delete(*keys)
    assert paths == [f"/bot{TOKEN}/test/createInvoiceLink"]


async def test_token_and_ids_not_in_logs_or_responses(gw) -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter("telegram-bot-gateway"))
    root = logging.getLogger()
    root.addHandler(handler)
    old = root.level
    root.setLevel(logging.DEBUG)
    responses: list[str] = []
    try:
        gw.telegram.queue.append(tg_error(400, f"Bad Request: bot{TOKEN} CHARGE_NOT_FOUND"))
        body = {"account_id": ACCOUNT_ID, "telegram_payment_charge_id": "stxTEST-secret-charge"}
        responses.append((await gw.internal.post("/internal/v1/stars/refunds", json=body, headers=auth(gw))).text)
        responses.append((await gw.internal.post("/internal/v1/stars/refunds", json=body, headers=auth(gw))).text)
        gw.telegram.queue.append(httpx.ConnectError(f"https://tg.test/bot{TOKEN}/createInvoiceLink"))
        responses.append((await gw.internal.post("/internal/v1/stars/invoice-links", json=invoice(),
                                                 headers=auth(gw))).text)
    finally:
        root.removeHandler(handler)
        root.setLevel(old)
    logs = stream.getvalue()
    assert "stars refund done" in logs
    for secret in (TOKEN, TOKEN.split(":")[1], str(TG_USER), "stxTEST-secret-charge"):
        assert secret not in logs, secret
        assert all(secret not in text for text in responses), secret
