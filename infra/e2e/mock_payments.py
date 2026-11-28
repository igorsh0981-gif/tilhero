"""Мок провайдеров сайта оплаты (Payme, Click, Uzum) для e2e-стенда спринта 8 — две роли:

1. **Клиент колбэков** (импортируется сценарием `scenario_money.py`): запросы провайдера в billing — через Caddy
   payments-edge (`/pay/payme`, `/pay/click/prepare|complete`, `/pay/uzum/<op>`; edge сам подставляет `X-Edge-Token`)
   или напрямую в billing (`/provider/v1/*` с `X-Edge-Token`), если edge на стенде не поднят. Подписи, Basic и поля —
   симуляторами потока B (`services/billing/tests/providers/simulators.py`: PaymeSim, ClickSim, UzumSim) — один источник
   правил с контрактными тестами billing.
2. **Сервер исходящих API провайдера** (`--port 8191`): billing на стенде ходит сюда как в Click Merchant API
   (`CLICK_API_URL=http://127.0.0.1:8191/click/v2/merchant`: `status_by_mti`, `reversal`, `ofd_data/submit_items`,
   `ofd_data`) — ответы и проверка заголовка `Auth` — `simulators.ClickMerchantApi`.

    uv run python infra/e2e/mock_payments.py --port 8191 --store .dev/e2e/payments.jsonl

Служебные эндпоинты сервера:
  POST /_mock/click/payments {"merchant_trans_id", "payment_id", "status"} — платёж «есть у Click» (после Complete);
  POST /_mock/click/config {"reversal_code"?, "submit_code"?, "fail_5xx"?: {op: n}} — сценарии ответов;
  GET  /_mock/calls?op=<op>&after=<seq> → {"items": [{seq, method, op, body}], "last_seq", "bad_auth"};
  GET  /health → {"ok": true}.
Ключи — заведомо тестовые строки стенда (E2E_* из run_local.sh, по умолчанию — как в simulators.py).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "billing" / "tests" / "providers"))
import simulators as sim  # noqa: E402 — симуляторы потока B (Payme, Click, Uzum; Click Merchant API)

EDGE_URL = os.environ.get("E2E_PAYMENTS_EDGE", "http://127.0.0.1:8193")
BILLING_URL = os.environ.get("E2E_BILLING", "http://127.0.0.1:8118")
EDGE_TOKEN = os.environ.get("E2E_PAYMENTS_EDGE_TOKEN", "e2e-payments-edge-token-0123456789abcdef-local")
PAYME_KEY = os.environ.get("E2E_PAYME_KEY", sim.PAYME_KEY)
CLICK_SECRET = os.environ.get("E2E_CLICK_SECRET_KEY", sim.CLICK_SECRET)
CLICK_SERVICE_ID = os.environ.get("E2E_CLICK_SERVICE_ID", sim.CLICK_SERVICE_ID)
CLICK_MERCHANT_USER_ID = os.environ.get("E2E_CLICK_MERCHANT_USER_ID", sim.CLICK_MERCHANT_USER_ID)
UZUM_LOGIN = os.environ.get("E2E_UZUM_LOGIN", sim.UZUM_LOGIN)
UZUM_PASSWORD = os.environ.get("E2E_UZUM_PASSWORD", sim.UZUM_PASSWORD)
UZUM_SERVICE_ID = os.environ.get("E2E_UZUM_SERVICE_ID", sim.UZUM_SERVICE_ID)

# пути edge (публичные) → пути billing (приватные)
EDGE_PATHS = {"payme": "/pay/payme", "click": "/pay/click/{op}", "uzum": "/pay/uzum/{op}"}
BILLING_PATHS = {"payme": "/provider/v1/payme", "click": "/provider/v1/click/{op}", "uzum": "/provider/v1/uzum/{op}"}


# ============================================================================== клиент колбэков (для сценария)

@dataclass
class Reply:
    status: int
    body: dict[str, Any]
    elapsed_ms: float

    @property
    def error(self) -> Any:
        """Payme — error.code; Click — error; Uzum — errorCode (или status)."""
        if "jsonrpc" in self.body:
            return (self.body.get("error") or {}).get("code")
        if "error" in self.body and isinstance(self.body["error"], int):
            return self.body["error"]
        return self.body.get("errorCode", self.body.get("status"))


@dataclass
class Provider:
    """Колбэки провайдеров в billing: через payments-edge (`via_edge`) или напрямую с X-Edge-Token."""

    via_edge: bool = True
    edge: str = EDGE_URL
    billing: str = BILLING_URL
    edge_token: str = EDGE_TOKEN
    client_ip: str = "185.8.212.10"  # «адрес провайдера» в X-Forwarded-For (CIDR на стенде выключены)
    payme_sim: sim.PaymeSim = field(default_factory=lambda: sim.PaymeSim(key=PAYME_KEY))
    click_sim: sim.ClickSim = field(default_factory=lambda: sim.ClickSim(secret=CLICK_SECRET,
                                                                           service_id=CLICK_SERVICE_ID))
    uzum_sim: sim.UzumSim = field(default_factory=lambda: sim.UzumSim(login=UZUM_LOGIN, password=UZUM_PASSWORD,
                                                                        service_id=UZUM_SERVICE_ID))
    journal: list[dict[str, Any]] = field(default_factory=list)

    def url(self, provider: str, op: str = "") -> str:
        if self.via_edge:
            return self.edge + EDGE_PATHS[provider].format(op=op)
        return self.billing + BILLING_PATHS[provider].format(op=op)

    def send(self, provider: str, op: str, content: bytes, headers: Mapping[str, str], *,
             method: str = "POST", edge_token: str | None = None) -> Reply:
        h = dict(headers)
        # Railway edge дописывает адрес клиента; Caddy payments-edge — свой (глубина 2 справа — в billing)
        h["x-forwarded-for"] = self.client_ip
        if not self.via_edge:
            h["x-edge-token"] = self.edge_token if edge_token is None else edge_token
            h["x-forwarded-for"] = f"{self.client_ip}, 127.0.0.1"
        elif edge_token is not None:  # клиент подсовывает свой токен — edge обязан его заменить
            h["x-edge-token"] = edge_token
        t0 = time.monotonic()
        r = httpx.request(method, self.url(provider, op), content=content, headers=h, timeout=15)
        dt = (time.monotonic() - t0) * 1000
        try:
            body = r.json() if r.content else {}
        except ValueError:
            body = {"_raw": r.text[:300]}
        self.journal.append({"provider": provider, "op": op, "status": r.status_code, "ms": round(dt, 1)})
        return Reply(r.status_code, body if isinstance(body, dict) else {"_list": body}, dt)

    # ---------------------------------------------------------------- Payme Merchant API (JSON-RPC 2.0)
    def payme(self, method: str, params: Mapping[str, Any], *, key: str | None = None, login: str | None = None,
              http_method: str = "POST", raw: bytes | None = None) -> Reply:
        body = raw if raw is not None else self.payme_sim.body(method, params)
        return self.send("payme", "", body, self.payme_sim.headers(login=login, key=key), method=http_method)

    # ---------------------------------------------------------------- Click SHOP API (form-urlencoded)
    def click_prepare(self, click_trans_id: str, order_no: int | str, amount: str, **over: str) -> Reply:
        form = self.click_sim.prepare_form(click_trans_id, order_no, amount, **over)
        return self.send("click", "prepare", self.click_sim.encode(form),
                         {"content-type": "application/x-www-form-urlencoded"})

    def click_complete(self, click_trans_id: str, order_no: int | str, amount: str, merchant_prepare_id: int | str,
                       error: str = "0", **over: str) -> Reply:
        form = self.click_sim.complete_form(click_trans_id, order_no, amount, merchant_prepare_id, error, **over)
        return self.send("click", "complete", self.click_sim.encode(form),
                         {"content-type": "application/x-www-form-urlencoded"})

    # ---------------------------------------------------------------- Uzum (JSON, Basic)
    def uzum(self, op: str, *, password: str | None = None, **kw: Any) -> Reply:
        return self.send("uzum", op, self.uzum_sim.body(op, **kw), self.uzum_sim.headers(password=password))


def click_paydoc_id(click_trans_id: str) -> str:
    """click_paydoc_id, который ClickSim кладёт в форму (Merchant API: payment_id ↔ click_paydoc_id, §14 C2)."""
    return "9" + click_trans_id


# ============================================================================== сервер исходящих API провайдеров

class MerchantState:
    def __init__(self, store: Path | None) -> None:
        self.lock = threading.Lock()
        self.click = sim.ClickMerchantApi(secret=CLICK_SECRET, user_id=CLICK_MERCHANT_USER_ID,
                                          service_id=CLICK_SERVICE_ID)
        self.calls: list[dict[str, Any]] = []
        self.seq = 0
        self.store = store
        if store:
            store.parent.mkdir(parents=True, exist_ok=True)
            store.write_text("")

    def record(self, method: str, op: str, body: Any, status: int) -> None:
        with self.lock:
            self.seq += 1
            item = {"seq": self.seq, "at": time.time(), "method": method, "op": op, "body": body, "status": status}
            self.calls.append(item)
            if self.store:
                with self.store.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(item, ensure_ascii=False) + "\n")


def make_handler(state: MerchantState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "MockPayments/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:  # заголовок Auth в логах не нужен
            pass

        def _send(self, status: int, body: Any) -> None:
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _raw(self) -> bytes:
            length = int(self.headers.get("content-length") or 0)
            return self.rfile.read(length) if length else b""

        def _merchant(self, method: str) -> None:
            url = urlsplit(self.path)
            raw = self._raw()
            req = httpx.Request(method, f"http://mock{url.path}", headers=dict(self.headers.items()), content=raw)
            with state.lock:
                try:
                    resp = state.click.handle(req)
                except httpx.HTTPError:  # сценарий «обрыв сети» симулятора — закрываем соединение без ответа
                    self.close_connection = True
                    return
                op = state.click.requests[-1][1] if state.click.requests else "?"
            try:
                body = json.loads(raw) if raw else None
            except ValueError:
                body = None
            state.record(method, op, body, resp.status_code)
            self.send_response(resp.status_code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(resp.content)))
            self.end_headers()
            self.wfile.write(resp.content)

        def do_GET(self) -> None:
            url = urlsplit(self.path)
            if url.path == "/health":
                return self._send(200, {"ok": True})
            if url.path == "/_mock/calls":
                q = {k: v[0] for k, v in parse_qs(url.query).items()}
                after = int(q.get("after", "0"))
                with state.lock:
                    items = [c for c in state.calls if c["seq"] > after and (not q.get("op") or c["op"] == q["op"])]
                    return self._send(200, {"items": items, "last_seq": state.seq, "bad_auth": state.click.bad_auth})
            if url.path.startswith("/click/"):
                return self._merchant("GET")
            return self._send(404, {"error": "not_found"})

        def do_DELETE(self) -> None:
            if urlsplit(self.path).path.startswith("/click/"):
                return self._merchant("DELETE")
            return self._send(404, {"error": "not_found"})

        def do_POST(self) -> None:
            path = urlsplit(self.path).path
            if path.startswith("/click/"):
                return self._merchant("POST")
            try:
                body = json.loads(self._raw() or b"{}")
            except ValueError:
                return self._send(400, {"error": "bad json"})
            if path == "/_mock/click/payments":
                with state.lock:
                    state.click.payments[str(body["merchant_trans_id"])] = {
                        "payment_id": str(body["payment_id"]), "status": int(body.get("status", 2))}
                return self._send(200, {"ok": True})
            if path == "/_mock/click/config":
                with state.lock:
                    for k in ("reversal_code", "submit_code"):
                        if k in body:
                            setattr(state.click, k, int(body[k]))
                    for op, n in (body.get("fail_5xx") or {}).items():
                        state.click.fail_5xx[str(op)] = int(n)
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "not_found"})

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(description="Mock payment providers (Click Merchant API) for the e2e stand")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8191)
    ap.add_argument("--store", type=Path, default=None)
    a = ap.parse_args()
    state = MerchantState(a.store)
    server = ThreadingHTTPServer((a.host, a.port), make_handler(state))
    print(f"mock payments listening on {a.host}:{a.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
