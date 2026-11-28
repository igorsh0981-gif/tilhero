"""apps/payments-edge (INTERNAL_API §4): Caddyfile, Dockerfile и живой прогон Caddy перед заглушкой billing.

Живая часть нужна бинарь `caddy` (PATH или `CADDY_BIN`; в CI — образ `caddy:2.10.2-alpine`, в Dockerfile сборки —
`caddy validate`); без него — пропуск со строкой причины. Проверяется: только `/pay/*` → `/provider/v1/*`, прочее —
404; свой `X-Edge-Token` вместо клиентского; служебные заголовки клиента вырезаются; тело ≤ 64 КиБ (больше — 413 и
до billing не доходит); `X-Forwarded-For` — Caddy дописывает адрес соседа, billing берёт второй справа; без `Server`."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx
import pytest

from tilhero_billing.providers.common import MAX_CALLBACK_BODY_BYTES, client_ip_from_forwarded

ROOT = Path(__file__).resolve().parents[4]
EDGE = ROOT / "apps" / "payments-edge"
CADDYFILE = EDGE / "Caddyfile"
TOKEN = "test-edge-token-" + "z" * 32
CADDY = os.environ.get("CADDY_BIN") or shutil.which("caddy")
needs_caddy = pytest.mark.skipif(not CADDY, reason="нет бинаря caddy (PATH или CADDY_BIN)")


# ---------------------------------------------------------------- статические проверки

def test_caddyfile_routes_and_limits() -> None:
    text = CADDYFILE.read_text(encoding="utf-8")
    assert "max_size 64KiB" in text  # 64KB у Caddy — 64 000 байт, нужно 64 КиБ
    assert "header_up X-Edge-Token {env.PAYMENTS_EDGE_TOKEN}" in text  # не запекается в конфигурацию
    assert "{$PAYMENTS_EDGE_TOKEN}" not in text
    for header in ("X-Internal-Token", "X-Trace-Id", "X-Correlation-Id", "X-Causation-Id", "Idempotency-Key",
                   "Cookie"):
        assert f"header_up -{header}" in text
    assert "path_regexp click ^/pay/click/(prepare|complete)$" in text
    assert "path_regexp uzum ^/pay/uzum/(check|create|confirm|reverse|status)$" in text
    assert "rewrite * /provider/v1/payme" in text and "response_header_timeout 10s" in text
    assert "admin off" in text and "auto_https off" in text
    assert not any(line.strip().startswith("log") for line in text.splitlines())  # access-лог выключен


def test_dockerfile_and_context_whitelist() -> None:
    docker = (EDGE / "Dockerfile").read_text(encoding="utf-8")
    assert "ARG CADDY_IMAGE=caddy:2.10.2-alpine" in docker
    assert "RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile" in docker
    assert "USER edge" in docker and "EXPOSE 8080" in docker and "/healthz" in docker
    ignore = [ln.strip() for ln in (EDGE / "Dockerfile.dockerignore").read_text().splitlines()
              if ln.strip() and not ln.startswith("#")]
    assert ignore == ["*", "!apps/payments-edge/Caddyfile"]
    assert (EDGE / "README.md").exists()


# ---------------------------------------------------------------- caddy validate / adapt

def _env(tmp: Path, port: int, upstream: str, token: str = TOKEN) -> dict[str, str]:
    return {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp), "XDG_CONFIG_HOME": str(tmp / "cfg"),
            "XDG_DATA_HOME": str(tmp / "data"), "PORT": str(port), "BILLING_URL": upstream,
            "PAYMENTS_EDGE_TOKEN": token}


@needs_caddy
def test_caddy_validate_and_secret_not_in_config(tmp_path: Path) -> None:
    assert CADDY is not None
    env = _env(tmp_path, 18080, "http://127.0.0.1:1")
    # бинарь caddy — из PATH/CADDY_BIN, аргументы постоянные
    out = subprocess.run([CADDY, "validate", "--config", str(CADDYFILE), "--adapter", "caddyfile"], env=env,  # noqa: S603
                         capture_output=True, text=True, timeout=60, check=False)
    assert out.returncode == 0, out.stderr[-2000:]
    adapted = subprocess.run([CADDY, "adapt", "--config", str(CADDYFILE), "--adapter", "caddyfile"],  # noqa: S603
                             env=env,
                             capture_output=True, text=True, timeout=60, check=True).stdout
    assert TOKEN not in adapted and "{env.PAYMENTS_EDGE_TOKEN}" in adapted
    assert '"max_size":65536' in adapted.replace(" ", "")
    fmt = subprocess.run([CADDY, "fmt", str(CADDYFILE)], env=env, capture_output=True, text=True,  # noqa: S603
                         timeout=60, check=True).stdout
    assert fmt == CADDYFILE.read_text(encoding="utf-8"), "caddy fmt: Caddyfile не отформатирован"


# ---------------------------------------------------------------- живой прогон

class Upstream:
    """Заглушка billing: запоминает метод, путь, заголовки и длину тела; отвечает JSON с заголовком Server."""

    def __init__(self) -> None:
        self.seen: list[dict[str, Any]] = []
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            def _any(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length) if length else b""
                upstream.seen.append({"method": self.command, "path": self.path,
                                      "headers": {k.lower(): v for k, v in self.headers.items()}, "size": len(body)})
                payload = json.dumps({"ok": True}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(payload)

            do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = _any

            def log_message(self, *args: Any) -> None:
                return None

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        # обрыв Caddy на chunked-теле > 64 КиБ — ожидаем; трассировку заглушки в вывод не печатаем
        self.server.handle_error = lambda request, client_address: None  # type: ignore[method-assign]
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture(scope="module")
def edge(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[httpx.Client, Upstream]]:
    if not CADDY:
        pytest.skip("нет бинаря caddy (PATH или CADDY_BIN)")
    upstream = Upstream()
    port = _free_port()
    tmp = tmp_path_factory.mktemp("edge")
    proc = subprocess.Popen([CADDY, "run", "--config", str(CADDYFILE), "--adapter", "caddyfile"],  # noqa: S603
                            env=_env(tmp, port, upstream.url), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 20
        while True:
            try:
                if httpx.get(f"{base}/healthz", timeout=1).status_code == 200:
                    break
            except httpx.TransportError:
                pass
            if time.monotonic() > deadline or proc.poll() is not None:
                proc.kill()
                output = proc.stdout.read().decode()[-3000:] if proc.stdout else ""
                pytest.fail(f"caddy не поднялся: {output}")
            time.sleep(0.1)
        with httpx.Client(base_url=base, timeout=15) as client:
            yield client, upstream
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        upstream.close()


def test_healthz(edge: tuple[httpx.Client, Upstream]) -> None:
    client, _ = edge
    r = client.get("/healthz")
    assert r.status_code == 200 and r.text == "ok" and "server" not in r.headers
    assert r.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("path,method,target", [
    ("/pay/payme", "POST", "/provider/v1/payme"),
    ("/pay/payme", "GET", "/provider/v1/payme"),  # любой метод — billing ответит -32300
    ("/pay/click/prepare", "POST", "/provider/v1/click/prepare"),
    ("/pay/click/complete", "POST", "/provider/v1/click/complete"),
    *[(f"/pay/uzum/{op}", "POST", f"/provider/v1/uzum/{op}") for op in ("check", "create", "confirm", "reverse",
                                                                        "status")],
])
def test_routes_forwarded_with_own_token(edge: tuple[httpx.Client, Upstream], path: str, method: str,
                                         target: str) -> None:
    client, upstream = edge
    before = len(upstream.seen)
    r = client.request(method, path, content=b'{"id": 1}' if method == "POST" else None,
                       headers={"X-Edge-Token": "test-attacker-token", "X-Internal-Token": "test-forged-jwt",
                                "X-Trace-Id": "forged", "Idempotency-Key": "forged", "Cookie": "a=b",
                                "Authorization": "Basic dGVzdDp0ZXN0", "X-Forwarded-For": "6.6.6.6, 9.9.9.9"})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert "server" not in r.headers and r.headers["cache-control"] == "no-store"
    [seen] = upstream.seen[before:]
    h = seen["headers"]
    assert seen["method"] == method and seen["path"] == target
    assert h["x-edge-token"] == TOKEN  # клиентский заменён своим
    for dropped in ("x-internal-token", "x-trace-id", "idempotency-key", "cookie"):
        assert dropped not in h, dropped
    assert h["authorization"] == "Basic dGVzdDp0ZXN0"  # учётные данные провайдера доходят до billing
    # Railway edge → «…, клиент»; Caddy дописывает адрес соседа → billing берёт второй справа
    assert h["x-forwarded-for"] == "6.6.6.6, 9.9.9.9, 127.0.0.1"
    assert client_ip_from_forwarded(h["x-forwarded-for"]) == "9.9.9.9"


@pytest.mark.parametrize("path,method", [
    ("/provider/v1/payme", "POST"), ("/pay/payme/extra", "POST"), ("/pay/click/prepare", "GET"),
    ("/pay/click/refund", "POST"), ("/pay/uzum/pay", "POST"), ("/pay/uzum/check", "GET"), ("/", "GET"),
    ("/internal/v1/stars/payments", "POST"), ("/health/ready", "GET"), ("/pay/click/prepare/", "POST"),
])
def test_everything_else_is_404_and_not_forwarded(edge: tuple[httpx.Client, Upstream], path: str,
                                                  method: str) -> None:
    client, upstream = edge
    before = len(upstream.seen)
    r = client.request(method, path, content=b"{}" if method == "POST" else None)
    assert r.status_code == 404 and "server" not in r.headers
    assert len(upstream.seen) == before


def test_body_limit_64_kib(edge: tuple[httpx.Client, Upstream]) -> None:
    client, upstream = edge
    before = len(upstream.seen)
    ok = client.post("/pay/payme", content=b"x" * MAX_CALLBACK_BODY_BYTES)
    assert ok.status_code == 200 and upstream.seen[-1]["size"] == 65_536
    too_big = client.post("/pay/payme", content=b"x" * (MAX_CALLBACK_BODY_BYTES + 1))
    assert too_big.status_code == 413
    assert len(upstream.seen) == before + 1  # слишком большое тело до billing не дошло


def _raw(port: int, head: bytes, body: bytes) -> bytes:
    with socket.create_connection(("127.0.0.1", port), timeout=10) as s:
        s.sendall(head + body)
        chunks = []
        while True:
            try:
                data = s.recv(65536)
            except (ConnectionResetError, TimeoutError):
                break
            if not data:
                break
            chunks.append(data)
            if b"\r\n\r\n" in b"".join(chunks):
                break
        return b"".join(chunks)


def test_body_limit_leading_zeros_and_chunked(edge: tuple[httpx.Client, Upstream]) -> None:
    client, upstream = edge
    port = int(str(client.base_url).rsplit(":", 1)[1].strip("/"))
    before = len(upstream.seen)
    head = (b"POST /pay/payme HTTP/1.1\r\nHost: edge\r\nContent-Type: application/json\r\n"
            b"Content-Length: 0065537\r\nConnection: close\r\n\r\n")
    assert _raw(port, head, b"x" * 65_537).startswith(b"HTTP/1.1 413")
    assert len(upstream.seen) == before
    # chunked без длины: ответ клиенту — 413 (тело в billing доходит обрезанным, billing его не обработает)
    chunk = b"x" * 70_000
    head = b"POST /pay/payme HTTP/1.1\r\nHost: edge\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    reply = _raw(port, head, hex(len(chunk))[2:].encode() + b"\r\n" + chunk + b"\r\n0\r\n\r\n")
    assert reply.startswith(b"HTTP/1.1 413")
