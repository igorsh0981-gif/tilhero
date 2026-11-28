"""Локальный мок Telegram Bot API для e2e-стенда (внешний интернет закрыт).

    uv run python infra/e2e/mock_telegram.py --port 8190 --token <BOT_TOKEN> --store .dev/e2e/telegram.jsonl

Принимает `POST /bot<token>/<method>` (JSON или form), как api.telegram.org:
  * неверный токен → 401 {"ok": false, "error_code": 401, "description": "Unauthorized"};
  * sendMessage → {"ok": true, "result": Message}, вызов сохраняется (в памяти и строкой JSONL в --store);
  * chat из списка заблокированных → 403 "Forbidden: bot was blocked by the user";
  * прочие методы (setWebhook, setMyCommands, answerCallbackQuery, …) → {"ok": true, "result": true}, тоже сохраняются.

Служебные эндпоинты для проверок сценария:
  GET    /_mock/calls?method=sendMessage&chat_id=<id>&after=<seq>  → {"items": [...], "last_seq": N}
  DELETE /_mock/calls                                              → очистить
  POST   /_mock/block {"chat_id": N, "blocked": true|false}         → эмуляция блокировки бота пользователем
  POST   /_mock/flood {"chat_id": N, "count": k, "retry_after": s}  → спринт 9 (учения Q7): следующие k sendMessage в чат
                                                                     N → 429 «Too Many Requests: retry after s»
                                                                     (parameters.retry_after), как flood control Telegram
  GET    /health                                                   → {"ok": true}

Спринт 8 — Telegram Stars (INTERNAL_API спринта 8 §1.5, §2; Bot API: createInvoiceLink, refundStarPayment,
editUserStarSubscription, getStarTransactions; обновления pre_checkout_query, message.successful_payment,
message.refunded_payment, subscription):
  * createInvoiceLink — проверка правил Stars (XTR, `provider_token: ""`, ровно одна позиция, title 1..32, description
    1..255, payload ≤ 128 байт, `subscription_period` только 2592000 и цена подписки ≤ 10 000) → `https://t.me/$<id>`;
    нарушение → 400 как Bot API;
  * refundStarPayment — первый раз ok; повтор → 400 «Bad Request: CHARGE_ALREADY_REFUNDED»; чужой user_id или
    неизвестный charge → 400;
  * editUserStarSubscription — ok (is_canceled запоминается у подписки);
  * getStarTransactions {offset, limit} → {"transactions": [...]} в хронологическом порядке: оплаты, отправленные
    сценарием через мок (source — пользователь, invoice_payment), возвраты (receiver) и добавленные вручную.
  Отправка обновлений в webhook bot-gateway (`--webhook`, `--webhook-secret`): мок — «Telegram», сценарий — «пользователь»:
  POST /_mock/stars/checkout {"user": {"id", "language_code"?}, "invoice_link", "total_amount"?, "currency"?,
       "payload"?} → pre_checkout_query → {"status", "elapsed_ms", "answer"} — ответ answerPreCheckoutQuery мок читает
       из ТЕЛА ответа webhook (как Telegram), не дольше 10 с;
  POST /_mock/stars/pay {"user", "invoice_link", "charge_id"?, "total_amount"?, "is_recurring"?, "is_first_recurring"?,
       "expiration"?} → message.successful_payment (подписка: is_recurring и is_first_recurring, дата продления
       now + 30 дней) → {"charge_id", "update_id", "status", "body", "expiration"};
  POST /_mock/stars/renew {"user", "first_charge_id", "charge_id"?} → продление (is_recurring, не первый; дата — прежняя
       + 30 дней);
  POST /_mock/stars/subscription {"user", "invoice_link" | "payload", "state": canceled|active|failed} → `subscription`;
  POST /_mock/stars/refunded {"charge_id"} → message.refunded_payment (как Telegram после возврата);
  POST /_mock/stars/transactions {"transaction": {...}} → лишняя запись выписки (сверка stars_unmatched);
  POST /_mock/updates {"update": {...}} → любое обновление как есть (update_id — свой, если нет);
  POST /_mock/updates/resend {"update_id"} → повторная доставка того же обновления (Telegram повторяет при не-2xx);
  GET  /_mock/stars/state → счета, платежи, подписки (для проверок сценария).
update_id мока начинается со случайного большого числа: bot-gateway помнит update_id 48 ч (Redis), прогоны не мешают
друг другу.
"""

from __future__ import annotations

import argparse
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx

XTR = "XTR"
SUBSCRIPTION_PERIOD = 2_592_000
SUBSCRIPTION_MAX_STARS = 10_000
PRE_CHECKOUT_LIMIT_SECONDS = 10.0


class MockState:
    def __init__(self, token: str, store: Path | None, webhook: str | None = None,
                 webhook_secret: str | None = None) -> None:
        self.token = token
        self.store = store
        self.lock = threading.Lock()
        self.calls: list[dict[str, Any]] = []
        self.seq = 0
        self.message_id = 1000
        self.blocked: set[int] = set()
        self.flood: dict[int, tuple[int, int]] = {}  # chat_id → (осталось отказов, retry_after)
        # спринт 8: Stars
        self.webhook = webhook
        self.webhook_secret = webhook_secret
        self.update_id = 1_000_000_000 + secrets.randbelow(900_000_000)
        self.updates: dict[int, dict[str, Any]] = {}  # update_id → обновление (повторная доставка)
        self.invoices: dict[str, dict[str, Any]] = {}  # invoice_link → параметры createInvoiceLink
        self.charges: dict[str, dict[str, Any]] = {}  # telegram_payment_charge_id → платёж
        self.star_txns: list[dict[str, Any]] = []  # выписка getStarTransactions (хронологически)
        if store:
            store.parent.mkdir(parents=True, exist_ok=True)
            store.write_text("")

    def next_update_id(self) -> int:
        with self.lock:
            self.update_id += 1
            return self.update_id

    def deliver(self, update: dict[str, Any]) -> dict[str, Any]:
        """Обновление → webhook bot-gateway (как Telegram): секрет в заголовке, ответ — тело (метод Bot API)."""
        if "update_id" not in update:
            update = {"update_id": self.next_update_id(), **update}
        with self.lock:
            self.updates[int(update["update_id"])] = update
        if not self.webhook:
            return {"status": 0, "error": "webhook не задан (--webhook)", "update_id": update["update_id"]}
        headers = {"x-telegram-bot-api-secret-token": self.webhook_secret or ""}
        t0 = time.monotonic()
        try:
            r = httpx.post(self.webhook, json=update, headers=headers, timeout=PRE_CHECKOUT_LIMIT_SECONDS + 5)
        except httpx.HTTPError as exc:
            return {"status": 0, "error": type(exc).__name__, "update_id": update["update_id"],
                    "elapsed_ms": round((time.monotonic() - t0) * 1000, 1)}
        elapsed = round((time.monotonic() - t0) * 1000, 1)
        try:
            body: Any = r.json() if r.content else None
        except ValueError:
            body = {"_raw": r.text[:300]}
        self.record("_webhook", {"update_id": update["update_id"], "kinds": sorted(k for k in update if k != "update_id")},
                    {"status": r.status_code, "elapsed_ms": elapsed})
        return {"status": r.status_code, "body": body, "elapsed_ms": elapsed, "update_id": update["update_id"]}

    def add_txn(self, txn: dict[str, Any]) -> None:
        with self.lock:
            self.star_txns.append(txn)

    def record(self, method: str, payload: dict[str, Any], result: Any) -> dict[str, Any]:
        with self.lock:
            self.seq += 1
            item = {"seq": self.seq, "at": time.time(), "method": method, "payload": payload, "result": result}
            self.calls.append(item)
            if self.store:
                with self.store.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(item, ensure_ascii=False) + "\n")
            return item

    def next_message_id(self) -> int:
        with self.lock:
            self.message_id += 1
            return self.message_id


def make_handler(state: MockState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "MockTelegram/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:  # без токена в логах
            pass

        # ---------- helpers ----------
        def _send(self, status: int, body: Any) -> None:
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> dict[str, Any]:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b""
            if not raw:
                return {}
            ctype = (self.headers.get("content-type") or "").split(";")[0].strip()
            if ctype == "application/x-www-form-urlencoded":
                form = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
                for key in ("reply_markup", "commands", "menu_button", "allowed_updates", "prices"):
                    if key in form:
                        try:
                            form[key] = json.loads(form[key])
                        except ValueError:
                            pass
                return form
            try:
                data = json.loads(raw)
            except ValueError:
                return {}
            return data if isinstance(data, dict) else {}

        # ---------- routes ----------
        def do_GET(self) -> None:
            url = urlsplit(self.path)
            if url.path == "/health":
                self._send(200, {"ok": True})
                return
            if url.path == "/_mock/stars/state":
                with state.lock:
                    self._send(200, {"invoices": state.invoices, "charges": state.charges,
                                     "transactions": state.star_txns})
                return
            if url.path == "/_mock/calls":
                q = {k: v[0] for k, v in parse_qs(url.query).items()}
                after = int(q.get("after", "0"))
                with state.lock:
                    items = [c for c in state.calls if c["seq"] > after]
                    last = state.seq
                if q.get("method"):
                    items = [c for c in items if c["method"] == q["method"]]
                if q.get("chat_id"):
                    items = [c for c in items if str(c["payload"].get("chat_id")) == q["chat_id"]]
                self._send(200, {"items": items, "last_seq": last})
                return
            self._send(404, {"ok": False, "error_code": 404, "description": "Not Found"})

        def do_DELETE(self) -> None:
            if urlsplit(self.path).path == "/_mock/calls":
                with state.lock:
                    state.calls.clear()
                self._send(200, {"ok": True})
                return
            self._send(404, {"ok": False})

        def do_POST(self) -> None:
            path = urlsplit(self.path).path
            if path == "/_mock/flood":
                body = self._body()
                chat, count = int(body.get("chat_id", 0)), int(body.get("count", 1))
                with state.lock:
                    if count > 0:
                        state.flood[chat] = (count, max(1, int(body.get("retry_after", 3))))
                    else:
                        state.flood.pop(chat, None)
                self._send(200, {"ok": True})
                return
            if path == "/_mock/block":
                body = self._body()
                chat = int(body.get("chat_id", 0))
                with state.lock:
                    (state.blocked.add if body.get("blocked", True) else state.blocked.discard)(chat)
                self._send(200, {"ok": True})
                return
            if path in STARS_CONTROL:
                try:
                    status, out = STARS_CONTROL[path](state, self._body())
                except (KeyError, TypeError, ValueError) as exc:
                    status, out = 400, {"error": f"{type(exc).__name__}: {exc}"}
                self._send(status, out)
                return
            parts = path.strip("/").split("/")
            if len(parts) != 2 or not parts[0].startswith("bot"):
                self._send(404, {"ok": False, "error_code": 404, "description": "Not Found"})
                return
            token, method = parts[0][3:], parts[1]
            if token != state.token:
                self._send(401, {"ok": False, "error_code": 401, "description": "Unauthorized"})
                return
            payload = self._body()
            if method == "sendMessage":
                chat_id = payload.get("chat_id")
                try:
                    chat_int = int(chat_id)
                except (TypeError, ValueError):
                    self._send(400, {"ok": False, "error_code": 400, "description": "Bad Request: chat not found"})
                    return
                with state.lock:
                    flood = state.flood.get(chat_int)
                    if flood:
                        left, wait = flood
                        if left > 1:
                            state.flood[chat_int] = (left - 1, wait)
                        else:
                            state.flood.pop(chat_int, None)
                if flood:
                    state.record(method, payload, {"error": 429})
                    self._send(429, {"ok": False, "error_code": 429,
                                     "description": f"Too Many Requests: retry after {flood[1]}",
                                     "parameters": {"retry_after": flood[1]}})
                    return
                if chat_int in state.blocked:
                    state.record(method, payload, {"error": 403})
                    self._send(403, {"ok": False, "error_code": 403,
                                     "description": "Forbidden: bot was blocked by the user"})
                    return
                if not payload.get("text"):
                    self._send(400, {"ok": False, "error_code": 400,
                                     "description": "Bad Request: message text is empty"})
                    return
                message = {
                    "message_id": state.next_message_id(),
                    "date": int(time.time()),
                    "chat": {"id": chat_int, "type": "private"},
                    "text": payload.get("text"),
                }
                state.record(method, payload, message)
                self._send(200, {"ok": True, "result": message})
                return
            if method in STARS_METHODS:
                status, out = STARS_METHODS[method](state, payload)
                state.record(method, payload, out if status == 200 else {"error": status, **out})
                self._send(status, {"ok": True, "result": out["result"]} if status == 200 else
                           {"ok": False, "error_code": status, "description": out["description"]})
                return
            if method == "getMe":
                result: Any = {"id": int(state.token.split(":")[0]), "is_bot": True, "first_name": "TilHero (mock)",
                               "username": "TilHeroMockBot"}
            elif method == "getWebhookInfo":
                result = {"url": "", "has_custom_certificate": False, "pending_update_count": 0}
            else:
                result = True
            state.record(method, payload, result)
            self._send(200, {"ok": True, "result": result})

    return Handler


# ============================================================================== спринт 8: Telegram Stars

Result = tuple[int, dict[str, Any]]


def _bad(description: str) -> Result:
    return 400, {"description": f"Bad Request: {description}"}


def _ok(result: Any) -> Result:
    return 200, {"result": result}


def _user(u: Any) -> dict[str, Any]:
    u = u if isinstance(u, dict) else {"id": u}
    return {"id": int(u["id"]), "is_bot": False, "first_name": str(u.get("first_name") or "E2E"),
            "language_code": str(u.get("language_code") or "ru")}


def create_invoice_link(state: MockState, p: dict[str, Any]) -> Result:
    title, desc, payload = p.get("title"), p.get("description"), p.get("payload")
    prices = p.get("prices")
    if p.get("currency") != XTR:
        return _bad("CURRENCY_INVALID")
    if p.get("provider_token") != "":  # Stars: provider_token — пустая строка (передаётся явно)
        return _bad("PROVIDER_TOKEN_INVALID: Stars — пустой provider_token")
    if not isinstance(title, str) or not 1 <= len(title) <= 32:
        return _bad("INVOICE_TITLE_INVALID")
    if not isinstance(desc, str) or not 1 <= len(desc) <= 255:
        return _bad("INVOICE_DESCRIPTION_INVALID")
    if not isinstance(payload, str) or not 1 <= len(payload.encode()) <= 128:
        return _bad("INVOICE_PAYLOAD_INVALID")
    if not isinstance(prices, list) or len(prices) != 1 or not isinstance(prices[0], dict):
        return _bad("Stars: ровно одна позиция prices")
    amount = prices[0].get("amount")
    if not isinstance(amount, int) or isinstance(amount, bool) or amount <= 0:
        return _bad("PRICE_INVALID")
    period = p.get("subscription_period")
    if period is not None and (period != SUBSCRIPTION_PERIOD or amount > SUBSCRIPTION_MAX_STARS):
        return _bad("SUBSCRIPTION_PERIOD_INVALID")
    link = "https://t.me/$" + secrets.token_urlsafe(12)
    with state.lock:
        state.invoices[link] = {"title": title, "description": desc, "payload": payload, "amount": amount,
                                "currency": XTR, "subscription_period": period, "at": time.time()}
    return _ok(link)


def refund_star_payment(state: MockState, p: dict[str, Any]) -> Result:
    charge_id = str(p.get("telegram_payment_charge_id") or "")
    with state.lock:
        ch = state.charges.get(charge_id)
        if ch is None:
            return _bad("CHARGE_NOT_FOUND")
        if int(p.get("user_id") or 0) != ch["user_id"]:
            return _bad("USER_ID_INVALID")
        if ch["refunded"]:
            return _bad("CHARGE_ALREADY_REFUNDED")
        ch["refunded"] = True
        ch["refunded_at"] = int(time.time())
        state.star_txns.append({"id": charge_id, "amount": ch["amount"], "date": int(time.time()),
                                "receiver": {"type": "user", "transaction_type": "invoice_payment",
                                             "user": {"id": ch["user_id"], "is_bot": False, "first_name": "E2E"},
                                             "invoice_payload": ch["payload"]}})
    return _ok(True)


def edit_user_star_subscription(state: MockState, p: dict[str, Any]) -> Result:
    charge_id = str(p.get("telegram_payment_charge_id") or "")
    with state.lock:
        ch = state.charges.get(charge_id)
        if ch is None or not ch.get("subscription"):
            return _bad("CHARGE_ID_INVALID: подписки с таким первым платежом нет")
        if int(p.get("user_id") or 0) != ch["user_id"]:
            return _bad("USER_ID_INVALID")
        if not isinstance(p.get("is_canceled"), bool):
            return _bad("is_canceled: ожидается Boolean")
        ch["canceled"] = p["is_canceled"]
    return _ok(True)


def get_star_transactions(state: MockState, p: dict[str, Any]) -> Result:
    offset, limit = int(p.get("offset") or 0), int(p.get("limit") or 100)
    if not 1 <= limit <= 100:
        return _bad("LIMIT_INVALID")
    with state.lock:
        return _ok({"transactions": state.star_txns[offset:offset + limit]})


STARS_METHODS = {"createInvoiceLink": create_invoice_link, "refundStarPayment": refund_star_payment,
                 "editUserStarSubscription": edit_user_star_subscription, "getStarTransactions": get_star_transactions}


def _invoice(state: MockState, body: dict[str, Any]) -> dict[str, Any]:
    link = body.get("invoice_link")
    with state.lock:
        inv = state.invoices.get(link) if link else None
    if inv is None:
        if "payload" not in body:
            raise KeyError(f"счёт {link!r} мок не выпускал")
        inv = {"payload": body["payload"], "amount": int(body.get("total_amount") or 1), "currency": XTR,
               "subscription_period": body.get("subscription_period")}
    return inv


def ctl_checkout(state: MockState, body: dict[str, Any]) -> Result:
    inv = _invoice(state, body)
    query = {"id": str(body.get("query_id") or secrets.token_hex(8)), "from": _user(body["user"]),
             "currency": body.get("currency", inv["currency"]),
             "total_amount": int(body.get("total_amount", inv["amount"])),
             "invoice_payload": body.get("payload", inv["payload"])}
    res = state.deliver({"pre_checkout_query": query})
    answer = res.get("body") if isinstance(res.get("body"), dict) else None
    # ответ Telegram: метод в теле webhook; позже 10 с — Telegram отменил бы оплату
    in_time = res.get("elapsed_ms", 1e9) < PRE_CHECKOUT_LIMIT_SECONDS * 1000
    if answer and answer.get("method") == "answerPreCheckoutQuery":
        state.record("answerPreCheckoutQuery", answer, {"in_time": in_time})
    return 200, {**res, "answer": answer, "in_time": in_time, "query_id": query["id"]}


def _pay_update(state: MockState, user: dict[str, Any], sp: dict[str, Any]) -> dict[str, Any]:
    return {"message": {"message_id": state.next_message_id(), "date": int(time.time()), "from": user,
                        "chat": {"id": user["id"], "type": "private"}, "successful_payment": sp}}


def ctl_pay(state: MockState, body: dict[str, Any]) -> Result:
    inv = _invoice(state, body)
    user = _user(body["user"])
    sub = inv.get("subscription_period") is not None
    charge_id = str(body.get("charge_id") or f"stxE2E{secrets.token_hex(10)}")
    amount = int(body.get("total_amount", inv["amount"]))
    expiration = int(body.get("expiration") or (int(time.time()) + SUBSCRIPTION_PERIOD)) if sub else None
    sp: dict[str, Any] = {"currency": body.get("currency", XTR), "total_amount": amount,
                          "invoice_payload": inv["payload"], "telegram_payment_charge_id": charge_id,
                          "provider_payment_charge_id": ""}
    if sub:
        sp.update(subscription_expiration_date=expiration, is_recurring=bool(body.get("is_recurring", True)),
                  is_first_recurring=bool(body.get("is_first_recurring", True)))
    with state.lock:
        known = charge_id in state.charges
        if not known:
            state.charges[charge_id] = {"user_id": user["id"], "payload": inv["payload"], "amount": amount,
                                        "refunded": False, "subscription": sub, "expiration": expiration,
                                        "first_charge_id": body.get("first_charge_id") or charge_id,
                                        "canceled": False, "at": int(time.time())}
            partner: dict[str, Any] = {"type": "user", "transaction_type": "invoice_payment",
                                       "user": {"id": user["id"], "is_bot": False, "first_name": "E2E"},
                                       "invoice_payload": inv["payload"]}
            if sub:
                partner["subscription_period"] = SUBSCRIPTION_PERIOD
            state.star_txns.append({"id": charge_id, "amount": amount, "date": int(time.time()), "source": partner})
    res = state.deliver(_pay_update(state, user, sp))
    return 200, {**res, "charge_id": charge_id, "expiration": expiration, "repeat_charge": known}


def ctl_renew(state: MockState, body: dict[str, Any]) -> Result:
    with state.lock:
        first = state.charges[str(body["first_charge_id"])]
        renewals = [c for c in state.charges.values() if c.get("first_charge_id") == body["first_charge_id"]]
        last_exp = max(int(c.get("expiration") or 0) for c in renewals)
        link = next((k for k, v in state.invoices.items() if v["payload"] == first["payload"]), None)
    return ctl_pay(state, {"user": body["user"], "invoice_link": link, "payload": first["payload"],
                           "total_amount": body.get("total_amount", first["amount"]),
                           "subscription_period": SUBSCRIPTION_PERIOD, "charge_id": body.get("charge_id"),
                           "is_recurring": True, "is_first_recurring": False,
                           "expiration": last_exp + SUBSCRIPTION_PERIOD, "first_charge_id": body["first_charge_id"]})


def ctl_subscription(state: MockState, body: dict[str, Any]) -> Result:
    inv = _invoice(state, body)
    if body.get("state") not in ("canceled", "active", "failed"):
        raise ValueError("state: canceled | active | failed")
    upd = {"user": _user(body["user"]), "invoice_payload": inv["payload"], "state": body["state"],
           "date": int(time.time())}
    return 200, state.deliver({"subscription": upd})


def ctl_refunded(state: MockState, body: dict[str, Any]) -> Result:
    with state.lock:
        ch = state.charges[str(body["charge_id"])]
    user = _user({"id": ch["user_id"]})
    rp = {"currency": XTR, "total_amount": ch["amount"], "invoice_payload": ch["payload"],
          "telegram_payment_charge_id": str(body["charge_id"]), "provider_payment_charge_id": ""}
    return 200, state.deliver({"message": {"message_id": state.next_message_id(), "date": int(time.time()),
                                           "from": user, "chat": {"id": user["id"], "type": "private"},
                                           "refunded_payment": rp}})


def ctl_transactions(state: MockState, body: dict[str, Any]) -> Result:
    txn = dict(body["transaction"])
    txn.setdefault("date", int(time.time()))
    state.add_txn(txn)
    return 200, {"ok": True}


def ctl_update(state: MockState, body: dict[str, Any]) -> Result:
    return 200, state.deliver(dict(body["update"]))


def ctl_resend(state: MockState, body: dict[str, Any]) -> Result:
    with state.lock:
        upd = state.updates[int(body["update_id"])]
    return 200, state.deliver(upd)


STARS_CONTROL = {"/_mock/stars/checkout": ctl_checkout, "/_mock/stars/pay": ctl_pay, "/_mock/stars/renew": ctl_renew,
                 "/_mock/stars/subscription": ctl_subscription, "/_mock/stars/refunded": ctl_refunded,
                 "/_mock/stars/transactions": ctl_transactions, "/_mock/updates": ctl_update,
                 "/_mock/updates/resend": ctl_resend}


def main() -> None:
    ap = argparse.ArgumentParser(description="Mock Telegram Bot API")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8190)
    ap.add_argument("--token", required=True)
    ap.add_argument("--store", type=Path, default=None)
    ap.add_argument("--webhook", default=None, help="URL webhook bot-gateway (обновления Stars от «Telegram»)")
    ap.add_argument("--webhook-secret", default=None, help="X-Telegram-Bot-Api-Secret-Token")
    args = ap.parse_args()
    state = MockState(args.token, args.store, args.webhook, args.webhook_secret)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(state))
    print(f"mock telegram listening on {args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
