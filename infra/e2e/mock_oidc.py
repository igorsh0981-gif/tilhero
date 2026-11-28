"""Локальный мок «Log In with Telegram» (OpenID Connect) для e2e-стенда спринта 8 (внешний интернет закрыт).

    uv run python infra/e2e/mock_oidc.py --port 8192 --client-id 123456789 --client-secret-env E2E_OIDC_CLIENT_SECRET

telegram-bff на стенде: `TELEGRAM_OIDC_BASE=http://127.0.0.1:8192` (подмена — только dev/test). Как oauth.telegram.org
(https://core.telegram.org/widgets/login; образец — services/telegram-bff/test/web/mockOidc.ts):
  * GET  /.well-known/jwks.json — открытые ключи (RS256, kid);
  * GET  /auth?client_id&redirect_uri&response_type=code&scope&state&code_challenge&code_challenge_method=S256 —
    «страница входа»: проверяет параметры; пользователь «подтверждает вход» служебным параметром `e2e_tg_id=<Telegram ID>`
    (у настоящего Telegram — кнопка на странице) → 302 на redirect_uri?code=…&state=…; без него — 200 с HTML;
  * POST /token (x-www-form-urlencoded, Basic client_id:client_secret) — grant_type=authorization_code, code
    (одноразовый), redirect_uri, client_id, code_verifier (PKCE S256) → {access_token, token_type, expires_in, id_token};
    id_token: iss = базовый адрес мока (= TELEGRAM_OIDC_BASE), aud = client_id (ID бота), sub, iat, exp, claim `id` —
    Telegram ID (§14 L1: со scope `profile`), имя и username — заведомо тестовые ПДн (BFF их не сохраняет).

Служебные эндпоинты:
  POST /_mock/forge {"mode": "bad_signature" | "bad_aud" | "bad_iss" | "expired" | "no_id"} — следующий выданный id_token
       будет подделан так (один раз);
  GET  /_mock/calls  → {"auth": [...], "token": [...]} — что пришло (без секрета клиента, code и code_verifier — только
       признаки: basic_ok, pkce_ok, scope, параметры адреса авторизации);
  GET  /health → {"ok": true}.
Секрет клиента передаётся именем переменной окружения (`--client-secret-env`), а не значением в командной строке.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

CODE_TTL_SECONDS = 120


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _int_b64(n: int) -> str:
    return b64u(n.to_bytes((n.bit_length() + 7) // 8, "big"))


class Key:
    def __init__(self) -> None:
        self.private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.kid = "e2e-" + secrets.token_hex(4)
        nums = self.private.public_key().public_numbers()
        self.jwk = {"kty": "RSA", "kid": self.kid, "alg": "RS256", "use": "sig", "n": _int_b64(nums.n),
                    "e": _int_b64(nums.e)}
        self.pem = self.private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                              serialization.NoEncryption())


class OidcState:
    def __init__(self, base: str, client_id: str, client_secret: str) -> None:
        self.base = base.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self.key = Key()
        self.foreign = Key()  # «чужой» ключ с тем же kid — подпись не из JWKS
        self.lock = threading.Lock()
        self.codes: dict[str, dict[str, Any]] = {}
        self.auth_calls: list[dict[str, Any]] = []
        self.token_calls: list[dict[str, Any]] = []
        self.forge: str | None = None

    def id_token(self, telegram_id: int) -> str:
        now = int(time.time())
        claims: dict[str, Any] = {"iss": self.base, "aud": self.client_id, "sub": f"e2e-sub-{telegram_id}",
                                  "iat": now, "exp": now + 3600, "id": telegram_id,
                                  "name": "E2E Test Person", "preferred_username": "e2e_hidden_username"}
        with self.lock:
            mode, self.forge = self.forge, None
        key = self.key
        if mode == "bad_signature":
            key = self.foreign
        elif mode == "bad_aud":
            claims["aud"] = "999999999"
        elif mode == "bad_iss":
            claims["iss"] = "https://oauth.telegram.example.invalid"
        elif mode == "expired":
            claims.update(iat=now - 7200, exp=now - 3600)
        elif mode == "no_id":
            claims.pop("id")
        return jwt.encode(claims, key.pem, algorithm="RS256", headers={"kid": self.key.kid, "typ": "JWT"})


def make_handler(state: OidcState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "MockTelegramOIDC/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:  # без code/state в логах
            pass

        def _send(self, status: int, body: Any, ctype: str = "application/json",
                  headers: dict[str, str] | None = None) -> None:
            data = body.encode() if isinstance(body, str) else json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(data)))
            self.send_header("cache-control", "no-store")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            url = urlsplit(self.path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            if url.path == "/health":
                return self._send(200, {"ok": True})
            if url.path == "/.well-known/jwks.json":
                return self._send(200, {"keys": [state.key.jwk]})
            if url.path == "/_mock/calls":
                with state.lock:
                    return self._send(200, {"auth": list(state.auth_calls), "token": list(state.token_calls)})
            if url.path == "/auth":
                return self._auth(q)
            return self._send(404, {"error": "not_found"})

        def _auth(self, q: dict[str, str]) -> None:
            problems = []
            if q.get("client_id") != state.client_id:
                problems.append("client_id")
            if q.get("response_type") != "code":
                problems.append("response_type")
            if q.get("code_challenge_method") != "S256" or len(q.get("code_challenge", "")) != 43:
                problems.append("pkce")
            if "openid" not in (q.get("scope") or "").split():
                problems.append("scope")
            redirect = q.get("redirect_uri") or ""
            if not redirect.startswith(("http://", "https://")):
                problems.append("redirect_uri")
            call = {"at": time.time(), "params": sorted(k for k in q if k != "e2e_tg_id"), "scope": q.get("scope"),
                    "redirect_uri": redirect, "has_state": bool(q.get("state")), "problems": problems}
            with state.lock:
                state.auth_calls.append(call)
            if problems:
                return self._send(400, f"<html><body>bad request: {', '.join(problems)}</body></html>", "text/html")
            tg = q.get("e2e_tg_id")
            if not tg or not tg.isdigit():  # пользователь ещё не подтвердил вход
                return self._send(200, "<html><body>Log in to TilHero (mock)</body></html>", "text/html")
            code = secrets.token_urlsafe(24)
            with state.lock:
                state.codes[code] = {"telegram_id": int(tg), "challenge": q["code_challenge"],
                                     "redirect_uri": redirect, "used": False, "at": time.time()}
            parts = urlsplit(redirect)
            extra = {"code": code, **({"state": q["state"]} if q.get("state") else {})}
            query = f"{parts.query}&{urlencode(extra)}" if parts.query else urlencode(extra)
            return self._send(302, "", "text/plain",
                              {"location": urlunsplit((parts.scheme, parts.netloc, parts.path, query, ""))})

        def do_POST(self) -> None:
            url = urlsplit(self.path)
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b""
            if url.path == "/_mock/forge":
                try:
                    mode = json.loads(raw or b"{}").get("mode")
                except ValueError:
                    mode = None
                if mode not in ("bad_signature", "bad_aud", "bad_iss", "expired", "no_id", None):
                    return self._send(400, {"error": "bad mode"})
                with state.lock:
                    state.forge = mode
                return self._send(200, {"ok": True, "mode": mode})
            if url.path != "/token":
                return self._send(404, {"error": "not_found"})
            form = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
            expected = "Basic " + base64.b64encode(f"{state.client_id}:{state.client_secret}".encode()).decode()
            basic_ok = hmac.compare_digest((self.headers.get("authorization") or "").encode(), expected.encode())
            ctype_ok = (self.headers.get("content-type") or "").startswith("application/x-www-form-urlencoded")
            with state.lock:
                issued = state.codes.get(form.get("code", ""))
                pkce_ok = bool(issued) and b64u(hashlib.sha256((form.get("code_verifier") or "").encode()).digest()) \
                    == issued["challenge"]  # type: ignore[index]
                call = {"at": time.time(), "basic_ok": basic_ok, "form_ok": ctype_ok, "pkce_ok": pkce_ok,
                        "grant_type": form.get("grant_type"), "client_id_ok": form.get("client_id") == state.client_id,
                        "code_known": issued is not None, "code_reused": bool(issued and issued["used"])}
                state.token_calls.append(call)
                if not basic_ok:
                    return self._send(401, {"error": "invalid_client"})
                if (form.get("grant_type") != "authorization_code" or form.get("client_id") != state.client_id
                        or not issued or issued["used"] or issued["redirect_uri"] != form.get("redirect_uri")
                        or not pkce_ok or time.time() - issued["at"] > CODE_TTL_SECONDS):
                    return self._send(400, {"error": "invalid_grant"})
                issued["used"] = True
                telegram_id = int(issued["telegram_id"])
            return self._send(200, {"access_token": "e2e-" + secrets.token_hex(8), "token_type": "Bearer",
                                    "expires_in": 3600, "id_token": state.id_token(telegram_id)})

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(description="Mock Log In with Telegram (OIDC)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8192)
    ap.add_argument("--base", default=None, help="iss и базовый адрес (по умолчанию http://<host>:<port>)")
    ap.add_argument("--client-id", required=True)
    ap.add_argument("--client-secret-env", default="E2E_OIDC_CLIENT_SECRET",
                    help="имя переменной окружения с секретом клиента")
    a = ap.parse_args()
    secret = os.environ.get(a.client_secret_env, "")
    if len(secret) < 16:
        raise SystemExit(f"{a.client_secret_env}: секрет клиента не задан (≥ 16 символов)")
    state = OidcState(a.base or f"http://{a.host}:{a.port}", a.client_id, secret)
    server = ThreadingHTTPServer((a.host, a.port), make_handler(state))
    print(f"mock oidc listening on {a.host}:{a.port} (iss {state.base})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
