"""Сборка FastAPI-сервиса: Runtime (БД, Redis, шина, outbox, потребители, клиенты), middleware контекста,
обработчики ошибок, /health/live и /health/ready.

Пример:
    runtime = Runtime(settings)
    runtime.add_consumer("preferences.user_deleted", ["user.deletion.requested.v1"], on_deleted)
    app = create_app(settings, routers=[api.router], runtime=runtime)
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.db import Database
from tilhero_common.errors import install_error_handlers
from tilhero_common.http_client import ServiceClient
from tilhero_common.logging import configure_logging
from tilhero_common.messaging.bus import ConsumerSpec, EventBus, NatsBus
from tilhero_common.messaging.envelope import Envelope
from tilhero_common.messaging.store import OutboxRelay, run_with_inbox
from tilhero_common.ratelimit import RateLimiter
from tilhero_common.settings import ServiceSettings

log = logging.getLogger("tilhero.runtime")

SessionHandler = Callable[[AsyncSession, Envelope], Awaitable[None]]
EnvelopeHandler = Callable[[Envelope], Awaitable[None]]
Hook = Callable[["Runtime"], Awaitable[None]]


class Runtime:
    def __init__(
        self,
        settings: ServiceSettings,
        *,
        db: Database | None = None,
        redis: Redis | None = None,
        bus: EventBus | None = None,
    ) -> None:
        self.settings = settings
        self.db = db
        self.redis = redis
        self.bus = bus
        self.relay: OutboxRelay | None = None
        self.clients: dict[str, ServiceClient] = {}
        self._client_specs: dict[str, tuple[str, dict[str, Any]]] = {}
        self._consumers: list[ConsumerSpec] = []
        self._startup: list[Hook] = []
        self._shutdown: list[Hook] = []
        self._background: list[asyncio.Task] = []
        self.started = False
        # спринт 9: единый лимитер (int.caller во внутренних маршрутах, политики сервиса) — есть только с Redis
        self.ratelimiter: RateLimiter | None = None

    # ---------- регистрация ----------
    def add_consumer(self, durable: str, event_types: list[str], handler: SessionHandler, **kw: Any) -> None:
        """Обработчик получает сессию; inbox-дедупликация и outbox-события — в одной транзакции."""

        async def _wrapped(envelope: Envelope) -> None:
            assert self.db is not None, "consumer with session requires DATABASE_URL"
            await run_with_inbox(self.db, durable, envelope, handler)
            if self.relay:
                self.relay.wake()

        self._consumers.append(ConsumerSpec(durable=durable, event_types=event_types, handler=_wrapped, **kw))

    def add_raw_consumer(self, durable: str, event_types: list[str], handler: EnvelopeHandler, **kw: Any) -> None:
        """Для сервисов без БД: дедупликацию делает сам обработчик (например, через Redis)."""
        self._consumers.append(ConsumerSpec(durable=durable, event_types=event_types, handler=handler, **kw))

    def register_client(self, name: str, base_url: str, **kw: Any) -> None:
        self._client_specs[name] = (base_url, kw)

    def on_startup(self, hook: Hook) -> None:
        self._startup.append(hook)

    def on_shutdown(self, hook: Hook) -> None:
        self._shutdown.append(hook)

    def spawn(self, coro: Awaitable[None], name: str) -> None:
        self._background.append(asyncio.create_task(coro, name=name))  # type: ignore[arg-type]

    # ---------- транзакции ----------
    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[AsyncSession]:
        if self.db is None:
            raise RuntimeError("DATABASE_URL is not configured")
        async with self.db.session() as session:
            yield session
        if self.relay:
            self.relay.wake()

    def client(self, name: str) -> ServiceClient:
        return self.clients[name]

    # ---------- жизненный цикл ----------
    async def start(self) -> None:
        s = self.settings
        if "env" not in s.model_fields_set:
            # Отсутствие ENV в окружении не должно молча включать dev-режим (ревью спринта 1, 🔴)
            raise RuntimeError("ENV must be set explicitly: dev | test | stage | prod")
        if self.db is None and s.database_url:
            self.db = Database(s.database_url, s.db_schema, s.db_pool_size, s.db_max_overflow)
        if self.redis is None and s.redis_url:
            self.redis = Redis.from_url(s.redis_url, decode_responses=True)
        if self.redis is not None and self.ratelimiter is None:
            self.ratelimiter = RateLimiter(self.redis, service=s.service_name, enabled=s.rate_limits_enabled,
                                           override_refresh_seconds=s.rate_limit_override_refresh_seconds)
        for name, (url, kw) in self._client_specs.items():
            self.clients[name] = ServiceClient(s, target=name, base_url=url, **kw)
        if self.bus is None and s.nats_url:
            self.bus = NatsBus(s.nats_url, stream=s.nats_stream, client_name=s.service_name,
                               dlq_max_age_days=s.nats_dlq_max_age_days)
        if self.bus is not None:
            try:
                await self.bus.connect()
                await self._subscribe_all()
            except Exception:
                log.error("event bus unavailable at startup, retrying in background", exc_info=True)
                self.spawn(self._connect_bus_later(), "bus-reconnect")
        if self.db is not None and self.bus is not None:
            self.relay = OutboxRelay(
                self.db,
                self.bus,
                interval_ms=s.outbox_poll_interval_ms,
                batch=s.outbox_batch_size,
                publish_timeout=s.outbox_publish_timeout_seconds,
                retention=timedelta(hours=s.outbox_retention_hours),
                cleanup_interval=s.outbox_cleanup_interval_seconds,
            )
            self.relay.start()
        for hook in self._startup:
            await hook(self)
        self.started = True

    async def _subscribe_all(self) -> None:
        assert self.bus is not None
        for spec in self._consumers:
            spec.max_deliver = spec.max_deliver or self.settings.nats_max_deliver
            await self.bus.subscribe(spec)

    async def _connect_bus_later(self) -> None:
        assert self.bus is not None
        delay = 1.0
        while True:
            await asyncio.sleep(delay)
            try:
                await self.bus.connect()
                await self._subscribe_all()
                log.info("event bus connected")
                return
            except Exception:
                delay = min(delay * 2, 30.0)

    async def stop(self) -> None:
        for hook in reversed(self._shutdown):
            with contextlib.suppress(Exception):
                await hook(self)
        for task in self._background:
            task.cancel()
        if self.relay:
            await self.relay.stop()
        if self.bus is not None:
            with contextlib.suppress(Exception):
                await self.bus.close()
        for client in self.clients.values():
            await client.aclose()
        if self.redis is not None:
            with contextlib.suppress(Exception):
                await self.redis.aclose()
        if self.db is not None:
            await self.db.dispose()

    async def readiness(self) -> dict[str, str]:
        checks: dict[str, str] = {}
        self._readiness_errors: dict[str, str] = {}
        if self.db is not None:
            try:
                await asyncio.wait_for(self.db.ping(), 2.0)
                checks["db"] = "ok"
            except Exception as exc:
                checks["db"] = "down"
                self._readiness_errors["db"] = type(exc).__name__
        if self.redis is not None:
            try:
                await asyncio.wait_for(self.redis.ping(), 2.0)
                checks["redis"] = "ok"
            except Exception as exc:
                checks["redis"] = "down"
                self._readiness_errors["redis"] = type(exc).__name__
        if self.bus is not None:
            checks["nats"] = "ok" if self.bus.is_connected else "down"
            stale: list[str] = getattr(self.bus, "stale_consumers", lambda: [])()
            if self._consumers:
                checks["consumers"] = "down" if stale else "ok"
        return checks


MAX_BODY_BYTES = 256 * 1024
_TRACE_RE = __import__("re").compile(r"^[A-Za-z0-9_-]{1,64}$")


class _BodyTooLarge(Exception):
    """Тело запроса больше MAX_BODY_BYTES (обнаружено при чтении потока)."""


class RequestContextMiddleware:
    """Чистый ASGI middleware: trace/correlation id из заголовков (или новые), access-лог, заголовки ответа,
    ограничение размера тела запроса."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}

        def _clean(v: str | None) -> str | None:
            return v if v and _TRACE_RE.match(v) else None

        context.bind(
            trace_id=_clean(headers.get(context.TRACE_HEADER)),
            correlation_id=_clean(headers.get(context.CORRELATION_HEADER)),
            causation_id=_clean(headers.get(context.CAUSATION_HEADER)),
        )
        def too_large_body() -> bytes:
            import json as _json

            return _json.dumps({"code": "PAYLOAD_TOO_LARGE", "message": "Слишком большой запрос",
                                "trace_id": context.get_trace_id(), "details": {}}, ensure_ascii=False).encode()

        length = headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
            await send({"type": "http.response.start", "status": 413,
                        "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": too_large_body()})
            return
        context.user_pid_var.set(None)
        started = time.perf_counter()
        status_holder = {"status": 500}
        # SEC9-03: лимит по фактически прочитанным байтам (chunked без Content-Length или неверный Content-Length):
        # чтение сверх лимита прерывается, ответ — 413, как бы обработчик ни обернул ошибку чтения тела
        body_state = {"read": 0, "too_large": False, "started": False, "replaced": False}

        async def limited_receive() -> dict:
            message = await receive()
            if message.get("type") == "http.request":
                body_state["read"] += len(message.get("body", b""))
                if body_state["read"] > MAX_BODY_BYTES:
                    body_state["too_large"] = True
                    raise _BodyTooLarge
            return message

        async def send_wrapper(message: dict) -> None:
            if body_state["too_large"]:
                if message["type"] == "http.response.start" and not body_state["started"]:
                    body_state["started"] = body_state["replaced"] = True
                    status_holder["status"] = 413
                    await send({"type": "http.response.start", "status": 413,
                                "headers": [(b"content-type", b"application/json"),
                                            (b"x-trace-id", context.get_trace_id().encode()),
                                            (b"x-correlation-id", context.get_correlation_id().encode())]})
                    await send({"type": "http.response.body", "body": too_large_body()})
                return
            if message["type"] == "http.response.start":
                body_state["started"] = True
                status_holder["status"] = message["status"]
                message.setdefault("headers", [])
                message["headers"] = [
                    *message["headers"],
                    (b"x-trace-id", context.get_trace_id().encode()),
                    (b"x-correlation-id", context.get_correlation_id().encode()),
                ]
            await send(message)

        try:
            try:
                await self.app(scope, limited_receive, send_wrapper)
            except Exception as exc:
                # чтение сверх лимита — 413 при любой обёртке исключения обработчиком (иначе — как было)
                if not (isinstance(exc, _BodyTooLarge) or body_state["too_large"]):
                    raise
                if not body_state["started"]:
                    await send_wrapper({"type": "http.response.start", "status": 413, "headers": []})
        finally:
            # В лог пишем шаблон маршрута, а не фактический путь: в пути могут быть ID (в т.ч. Telegram ID — PII)
            route = scope.get("route")
            path = getattr(route, "path", None) or ("<unmatched>" if scope.get("path") else "")
            if not scope.get("path", "").startswith("/health"):
                status = status_holder["status"]
                log.info(
                    "request",
                    extra={
                        "method": scope.get("method"),
                        "path": path,
                        "status": status,
                        "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                        "outcome": "success" if status < 400 else ("client_error" if status < 500 else "error"),
                    },
                )


health_router = APIRouter(tags=["health"])


@health_router.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "ok"}


_last_degraded_log = 0.0


def _log_degraded(runtime: Runtime, checks: dict[str, str]) -> None:
    """Почему сервис не готов — в лог (не чаще раза в 15 с): без этого healthcheck платформы падает «молча».
    Только имена проверок и классы исключений — без адресов и секретов."""
    global _last_degraded_log
    now = time.monotonic()
    if now - _last_degraded_log < 15:
        return
    _last_degraded_log = now
    down = {k: v for k, v in checks.items() if v != "ok"}
    errors = getattr(runtime, "_readiness_errors", {})
    log.warning(
        "readiness degraded: started=%s down=%s errors=%s", runtime.started, sorted(down), errors
    )


@health_router.get("/health/ready")
async def ready(request: Request) -> JSONResponse:
    runtime: Runtime = request.app.state.runtime
    checks = await runtime.readiness()
    ok = runtime.started and all(v == "ok" for v in checks.values())
    if not ok:
        _log_degraded(runtime, checks)
    return JSONResponse({"status": "ok" if ok else "degraded", "checks": checks}, status_code=200 if ok else 503)


def create_app(
    settings: ServiceSettings,
    *,
    routers: Iterable[APIRouter] = (),
    runtime: Runtime | None = None,
    configure: Callable[[Runtime], None] | None = None,
    title: str | None = None,
    manage_runtime: bool = True,
) -> FastAPI:
    """manage_runtime=False — приложение разделяет Runtime с другим приложением того же процесса (например,
    внутренний порт bot-gateway): жизненным циклом Runtime управляет основное приложение."""
    configure_logging(settings.service_name, settings.log_level, safe_exceptions=settings.is_secure_env)
    runtime = runtime or Runtime(settings)
    if configure:
        configure(runtime)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if not manage_runtime:
            yield
            return
        await runtime.start()
        try:
            yield
        finally:
            await runtime.stop()

    app = FastAPI(
        title=title or settings.service_name,
        version=settings.service_version,
        lifespan=lifespan,
        docs_url=None if settings.is_secure_env else "/docs",
        openapi_url=None if settings.is_secure_env else "/openapi.json",
        redoc_url=None,
    )
    app.state.runtime = runtime
    app.add_middleware(RequestContextMiddleware)
    install_error_handlers(app)
    app.include_router(health_router)
    if settings.database_url:
        # спринт 8: состояние outbox и консьюмеров сервиса для ops-monitor (вызывающий — только он)
        from tilhero_common.ops import router as ops_router

        app.include_router(ops_router)
    for router in routers:
        app.include_router(router)
    return app


def get_runtime(request: Request) -> Runtime:
    return request.app.state.runtime
