"""Симуляторы провайдеров по таблицам INTERNAL_API §1.6–§1.8 (до доступов к песочнице Payme и тест-утилите Click):

- `PaymeSim`, `ClickSim`, `UzumSim` — запросы провайдера в billing (InboundCall для адаптера или тело/заголовки для
  HTTP), с подписью и учётными данными; ими же пользуется e2e (`infra/e2e/mock_payments.py` — поток I);
- `ClickMerchantApi`, `PaymeSubscribeApi` — исходящие API провайдера для `httpx.MockTransport`: проверка заголовка
  `Auth`/`X-Auth`, ответы и сбои по сценарию (5xx, обрыв сети), журнал запросов.

Все ключи — заведомо тестовые строки `test-…`."""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

import httpx

from tilhero_billing.providers.base import InboundCall, ProviderCode

PAYME_LOGIN = "Paycom"
PAYME_KEY = "test-payme-key-0123456789"
CLICK_SECRET = "test-click-secret-0123456789"
CLICK_SERVICE_ID = "12345"
CLICK_MERCHANT_ID = "67890"
CLICK_MERCHANT_USER_ID = "4321"
UZUM_LOGIN = "test-uzum-login"
UZUM_PASSWORD = "test-uzum-password-0123456789"
UZUM_SERVICE_ID = "498614"
PAYME_SUBSCRIBE_KEY = "test-payme-subscribe-key"
PAYME_MERCHANT_ID = "5e730e8e0b852a417aa49ceb"


def basic(login: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{login}:{password}".encode()).decode()


def inbound(provider: ProviderCode, operation: str, body: bytes, *, headers: Mapping[str, str] | None = None,
            method: str = "POST", client_ip: str | None = None, at: datetime | None = None,
            content_type: str = "application/json") -> InboundCall:
    return InboundCall(provider=provider, operation=operation, method=method,
                       headers={k.lower(): v for k, v in (headers or {}).items()}, body=body,
                       content_type=content_type, client_ip=client_ip, received_at=at or datetime.now(UTC))


# ---------------------------------------------------------------- Payme Merchant API (входящие)

@dataclass
class PaymeSim:
    login: str = PAYME_LOGIN
    key: str = PAYME_KEY
    next_id: int = 1

    def body(self, method: str, params: Mapping[str, Any], rpc_id: int | None = None) -> bytes:
        if rpc_id is None:
            rpc_id, self.next_id = self.next_id, self.next_id + 1
        return json.dumps({"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": dict(params)}).encode()

    def headers(self, *, login: str | None = None, key: str | None = None) -> dict[str, str]:
        return {"Authorization": basic(login or self.login, key if key is not None else self.key),
                "Content-Type": "application/json"}

    def call(self, method: str, params: Mapping[str, Any], *, at: datetime | None = None, rpc_id: int | None = None,
             headers: Mapping[str, str] | None = None, client_ip: str | None = None) -> InboundCall:
        return inbound("payme", "rpc", self.body(method, params, rpc_id),
                       headers=self.headers() if headers is None else headers, at=at, client_ip=client_ip)


# ---------------------------------------------------------------- Click SHOP API (входящие)

def click_sign(fields: Mapping[str, str], secret: str, *, complete: bool) -> str:
    parts = [fields["click_trans_id"], fields["service_id"], secret, fields["merchant_trans_id"]]
    if complete:
        parts.append(fields["merchant_prepare_id"])
    parts += [fields["amount"], fields["action"], fields["sign_time"]]
    return hashlib.md5("".join(parts).encode(), usedforsecurity=False).hexdigest()


@dataclass
class ClickSim:
    secret: str = CLICK_SECRET
    service_id: str = CLICK_SERVICE_ID
    sign_time: str = "2026-11-22 14:00:00"

    def prepare_form(self, click_trans_id: str, order_no: int | str, amount: str, **over: str) -> dict[str, str]:
        f = {"click_trans_id": click_trans_id, "service_id": self.service_id, "click_paydoc_id": "9" + click_trans_id,
             "merchant_trans_id": str(order_no), "amount": amount, "action": "0", "error": "0",
             "error_note": "Success", "sign_time": self.sign_time}
        f.update({k: v for k, v in over.items() if k != "sign_string"})
        f["sign_string"] = over.get("sign_string") or click_sign(f, self.secret, complete=False)
        return f

    def complete_form(self, click_trans_id: str, order_no: int | str, amount: str, merchant_prepare_id: int | str,
                      error: str = "0", **over: str) -> dict[str, str]:
        f = {"click_trans_id": click_trans_id, "service_id": self.service_id, "click_paydoc_id": "9" + click_trans_id,
             "merchant_trans_id": str(order_no), "merchant_prepare_id": str(merchant_prepare_id), "amount": amount,
             "action": "1", "error": error, "error_note": "Success" if error == "0" else "Error",
             "sign_time": self.sign_time}
        f.update({k: v for k, v in over.items() if k != "sign_string"})
        f["sign_string"] = over.get("sign_string") or click_sign(f, self.secret, complete=True)
        return f

    @staticmethod
    def encode(form: Mapping[str, str]) -> bytes:
        return urlencode(dict(form)).encode()

    def call(self, operation: str, form: Mapping[str, str], *, at: datetime | None = None,
             client_ip: str | None = None) -> InboundCall:
        return inbound("click", operation, self.encode(form), at=at, client_ip=client_ip,
                       content_type="application/x-www-form-urlencoded")


# ---------------------------------------------------------------- Uzum (входящие, по сторонним описаниям)

@dataclass
class UzumSim:
    login: str = UZUM_LOGIN
    password: str = UZUM_PASSWORD
    service_id: str = UZUM_SERVICE_ID
    account_field: str = "order_id"
    wrap_value: bool = False  # params.order_id = {"value": …} (Go-пакет) или скаляр (пример вебхуков)

    def body(self, op: str, *, trans_id: str | None = None, order_no: int | str | None = None,
             amount: int | None = None, timestamp: int = 1_795_000_000_000, **extra: Any) -> bytes:
        req: dict[str, Any] = {"serviceId": int(self.service_id), "timestamp": timestamp}
        if order_no is not None:
            value: Any = str(order_no)
            req["params"] = {self.account_field: {"value": value} if self.wrap_value else value}
        if trans_id is not None:
            req["transId"] = trans_id
        if amount is not None:
            req["amount"] = amount
        req.update(extra)
        return json.dumps(req).encode()

    def headers(self, *, password: str | None = None) -> dict[str, str]:
        return {"Authorization": basic(self.login, self.password if password is None else password),
                "Content-Type": "application/json"}

    def call(self, op: str, *, at: datetime | None = None, headers: Mapping[str, str] | None = None,
             client_ip: str | None = None, **kw: Any) -> InboundCall:
        return inbound("uzum", op, self.body(op, **kw), headers=self.headers() if headers is None else headers,
                       at=at, client_ip=client_ip)


# ---------------------------------------------------------------- Click Merchant API (исходящие)

@dataclass
class ClickMerchantApi:
    """MockTransport Click Merchant API: Auth `{user}:{sha1(ts+secret)}:{ts}`; сценарии сбоев по операции."""

    secret: str = CLICK_SECRET
    user_id: str = CLICK_MERCHANT_USER_ID
    service_id: str = CLICK_SERVICE_ID
    requests: list[tuple[str, str, Any]] = field(default_factory=list)
    payments: dict[str, dict[str, Any]] = field(default_factory=dict)  # merchant_trans_id → {payment_id, status}
    fail_5xx: dict[str, int] = field(default_factory=dict)  # op → сколько раз ответить 503
    fail_network: dict[str, int] = field(default_factory=dict)  # op → сколько раз оборвать (ConnectError)
    fail_read: dict[str, int] = field(default_factory=dict)  # op → сколько раз ReadTimeout (запрос ушёл)
    reversal_code: int = 0
    submit_code: int = 0
    qr_url: str | None = "https://ofd.soliq.uz/check?t=EP000000000001&r=1&c=20261122140000&s=123456789012"
    submitted: dict[str, Any] = field(default_factory=dict)  # payment_id → тело submit_items
    bad_auth: int = 0

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def _auth_ok(self, header: str | None) -> bool:
        if not header or header.count(":") != 2:
            return False
        user, digest, ts = header.split(":")
        expected = hashlib.sha1((ts + self.secret).encode(), usedforsecurity=False).hexdigest()
        return user == self.user_id and digest == expected and ts.isdigit() and len(ts) == 10

    def _fail(self, op: str, request: httpx.Request) -> httpx.Response | None:
        if self.fail_network.get(op, 0) > 0:
            self.fail_network[op] -= 1
            raise httpx.ConnectError("connection refused", request=request)
        if self.fail_read.get(op, 0) > 0:
            self.fail_read[op] -= 1
            raise httpx.ReadTimeout("read timeout", request=request)
        if self.fail_5xx.get(op, 0) > 0:
            self.fail_5xx[op] -= 1
            return httpx.Response(503, json={"error_code": -500, "error_note": "Service unavailable"})
        return None

    def handle(self, request: httpx.Request) -> httpx.Response:
        parts = request.url.path.split("/payment/", 1)[-1].split("/")
        op = parts[0] if parts[0] != "ofd_data" else ("submit_items" if parts[1] == "submit_items" else "ofd_data")
        body = json.loads(request.content) if request.content else None
        self.requests.append((request.method, op, body))
        if not self._auth_ok(request.headers.get("auth")):
            self.bad_auth += 1
            return httpx.Response(401, json={"error_code": -401, "error_note": "Unauthorized"})
        failed = self._fail(op, request)
        if failed is not None:
            return failed
        if op == "status_by_mti" and request.method == "GET":
            mti = parts[2]
            p = self.payments.get(mti)
            if p is None:
                return httpx.Response(200, json={"error_code": -16, "error_note": "Payment not found"})
            return httpx.Response(200, json={"error_code": 0, "error_note": "Success",
                                             "payment_id": int(p["payment_id"]), "payment_status": p["status"],
                                             "merchant_trans_id": mti})
        if op == "reversal" and request.method == "DELETE":
            if self.reversal_code == 0:
                for p in self.payments.values():
                    if str(p["payment_id"]) == parts[2]:
                        p["status"] = -99
            return httpx.Response(200, json={"error_code": self.reversal_code, "error_note": "Success"
                                             if self.reversal_code == 0 else "Reversal rejected",
                                             "payment_id": int(parts[2])})
        if op == "submit_items" and request.method == "POST":
            if self.submit_code == 0:
                self.submitted[str(body["payment_id"])] = body
            return httpx.Response(200, json={"error_code": self.submit_code,
                                             "error_note": "Success" if self.submit_code == 0 else "Invalid SPIC"})
        if op == "ofd_data" and request.method == "GET":
            if parts[2] in self.submitted and self.qr_url:
                return httpx.Response(200, json={"paymentId": int(parts[2]), "qrCodeURL": self.qr_url})
            return httpx.Response(200, json={"error_code": -17, "error_note": "Fiscal data not found"})
        return httpx.Response(404, json={"error_code": -404, "error_note": "Not found"})


# ---------------------------------------------------------------- Payme Subscribe API (исходящие, только сверка)

@dataclass
class PaymeSubscribeApi:
    merchant_id: str = PAYME_MERCHANT_ID
    key: str = PAYME_SUBSCRIBE_KEY
    receipts: list[dict[str, Any]] = field(default_factory=list)
    requests: list[dict[str, Any]] = field(default_factory=list)
    fail_5xx: int = 0

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        if request.headers.get("x-auth") != f"{self.merchant_id}:{self.key}":
            return httpx.Response(200, json={"id": body.get("id"), "error": {"code": -32504, "message": "auth"}})
        if self.fail_5xx > 0:
            self.fail_5xx -= 1
            return httpx.Response(502, text="bad gateway")
        p = body["params"]
        rows = [r for r in self.receipts if p["from"] <= r["create_time"] <= p["to"]]
        page = rows[p["offset"]:p["offset"] + p["count"]]
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": page})
