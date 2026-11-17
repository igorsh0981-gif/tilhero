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
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit


class MockState:
    def __init__(self, token: str, store: Path | None) -> None:
        self.token = token
        self.store = store
        self.lock = threading.Lock()
        self.calls: list[dict[str, Any]] = []
        self.seq = 0
        self.message_id = 1000
        self.blocked: set[int] = set()
        self.flood: dict[int, tuple[int, int]] = {}  # chat_id → (осталось отказов, retry_after)
        if store:
            store.parent.mkdir(parents=True, exist_ok=True)
            store.write_text("")

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
                for key in ("reply_markup", "commands", "menu_button", "allowed_updates"):
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


def main() -> None:
    ap = argparse.ArgumentParser(description="Mock Telegram Bot API")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8190)
    ap.add_argument("--token", required=True)
    ap.add_argument("--store", type=Path, default=None)
    args = ap.parse_args()
    state = MockState(args.token, args.store)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(state))
    print(f"mock telegram listening on {args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
