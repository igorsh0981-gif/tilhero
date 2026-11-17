"""Тесты каркаса на реальном стенде (PostgreSQL, Redis, NATS из infra/dev/stack.sh)."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid

import httpx
import pytest
from fastapi import APIRouter, Depends, Request
from redis.asyncio import Redis
from sqlalchemy import Column, MetaData, String, Table, select

from tilhero_common import context
from tilhero_common.app import Runtime, create_app
from tilhero_common.db import Database
from tilhero_common.errors import ApiError, not_found
from tilhero_common.http_client import CircuitBreaker, ServiceClient, UpstreamError
from tilhero_common.internal_auth import Actor, InternalAuth, Principal, issue_token, verify_token
from tilhero_common.logging import JsonFormatter, redact
from tilhero_common.messaging import (
    ConsumerSpec,
    Envelope,
    InMemoryBus,
    NatsBus,
    OutboxRelay,
    emit,
    make_envelope,
    messaging_metadata,
    outbox_table,
    run_with_inbox,
)
from tilhero_common.redis_tools import AttemptLimiter, IdempotencyStore, fingerprint, rate_limit
from tilhero_common.settings import ServiceSettings, to_async_url
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    TEST_NATS_URL,
    TEST_REDIS_URL,
    create_schema,
    create_tables,
    drop_schema,
    internal_headers,
    unique_schema,
)

SECRET = "test-secret-" + "x" * 32


def settings(**kw) -> ServiceSettings:
    base = {"service_name": "svc-a", "env": "test", "internal_jwt_secret": SECRET}
    base.update(kw)
    return ServiceSettings(**base)


# ---------- settings / envelope ----------

def test_async_url_and_prod_guard() -> None:
    assert to_async_url("postgresql://u:p@h:5432/db") == "postgresql+asyncpg://u:p@h:5432/db"
    assert to_async_url("postgres://u@h/db") == "postgresql+asyncpg://u@h/db"
    with pytest.raises(ValueError):
        ServiceSettings(service_name="x", env="prod")
    with pytest.raises(ValueError):  # без личного ключа в prod/stage нельзя
        ServiceSettings(service_name="x", env="stage", internal_jwt_secret="y" * 40)
    ServiceSettings(service_name="x", env="prod", internal_jwt_secret="y" * 40,
                    internal_jwt_private_key="A" * 43)


def test_envelope_validation_and_context() -> None:
    context.bind(trace_id="t1", correlation_id="c1")
    env = make_envelope("support.ticket.created.v1", {"ticket_id": "TCK-1"}, producer="support")
    assert env.correlation_id == "c1"
    assert env.subject == "tilhero.support.ticket.created.v1"
    with pytest.raises(ValueError):
        make_envelope("BadType", {}, producer="x")


# ---------- logging ----------

def test_logging_redacts_pii() -> None:
    assert redact({"pin": "1234", "nested": {"initData": "abc", "ok": 1}}) == {
        "pin": "[redacted]",
        "nested": {"initData": "[redacted]", "ok": 1},
    }
    record = logging.LogRecord("x", logging.INFO, __file__, 1, "hello", None, None)
    record.token = "secret"
    record.user_status = "ACTIVE"
    out = json.loads(JsonFormatter("svc").format(record))
    assert out["token"] == "[redacted]" and out["user_status"] == "ACTIVE" and out["service"] == "svc"


# ---------- internal auth ----------

def test_internal_token_roundtrip_and_checks() -> None:
    actor = Actor(id="staff-1", role="support", permissions=frozenset({"support.reply"}))
    token = issue_token(SECRET, issuer="admin-bff", audience="support", subject="u1", actor=actor)
    p = verify_token(token, SECRET, audience="support", allowed_issuers={"admin-bff"})
    assert p.user_id == "u1" and p.actor and p.actor.role == "support"
    assert p.require_permission("support.reply").id == "staff-1"
    with pytest.raises(ApiError) as e:
        p.require_permission("billing.refund")
    assert e.value.status == 403 and e.value.code == "PERMISSION_DENIED"
    with pytest.raises(ApiError) as e:
        verify_token(token, SECRET, audience="identity-consent")
    assert e.value.status == 401
    with pytest.raises(ApiError) as e:
        verify_token(token, SECRET, audience="support", allowed_issuers={"telegram-bff"})
    assert e.value.status == 403
    expired = issue_token(SECRET, issuer="a", audience="support", ttl_seconds=-5)
    with pytest.raises(ApiError) as e:
        verify_token(expired, SECRET, audience="support")
    assert e.value.code == "INTERNAL_TOKEN_EXPIRED"


def test_internal_token_ttl_limits_sec9_01() -> None:
    """SEC9-01: обязательные iat и exp; exp − iat ≤ 120 с; iat из будущего не дальше 30 с; выпуск — 60 с."""
    import time

    import jwt as pyjwt

    from tilhero_common.internal_auth import KeyRing
    from tilhero_common.settings import ServiceSettings

    now = int(time.time())

    def tok(**claims: int) -> str:
        return issue_token(SECRET, issuer="telegram-bff", audience="support", extra=claims)

    for ttl in (121, 3600, 86_400):
        with pytest.raises(ApiError) as e:
            verify_token(tok(iat=now, exp=now + ttl), SECRET, audience="support")
        assert (e.value.status, e.value.code) == (401, "INTERNAL_TOKEN_INVALID"), ttl
    assert verify_token(tok(iat=now, exp=now + 120), SECRET, audience="support").issuer == "telegram-bff"
    # запас от границ 30 с: смена секунды между выпуском и проверкой не меняет исход
    assert verify_token(tok(iat=now + 20, exp=now + 80), SECRET, audience="support").issuer == "telegram-bff"
    with pytest.raises(ApiError) as e:
        verify_token(tok(iat=now + 35, exp=now + 90), SECRET, audience="support")
    assert e.value.code == "INTERNAL_TOKEN_INVALID"
    with pytest.raises(ApiError) as e:  # выпуск по умолчанию — 60 с, но предел настраивается
        verify_token(issue_token(SECRET, issuer="telegram-bff", audience="support"), SECRET, audience="support",
                     max_ttl_seconds=30)
    assert e.value.code == "INTERNAL_TOKEN_INVALID"
    ring = KeyRing.derived(SECRET, "telegram-bff")
    no_iat = pyjwt.encode({"iss": "telegram-bff", "aud": "support", "exp": now + 60}, ring.private_key,
                          algorithm="EdDSA", headers={"kid": "telegram-bff"})
    with pytest.raises(ApiError) as e:
        verify_token(no_iat, SECRET, audience="support")
    assert e.value.code == "INTERNAL_TOKEN_INVALID"
    for bad in ({"iat": float("nan"), "exp": now + 60}, {"iat": now, "exp": float("inf")}):  # не конечные числа
        with pytest.raises(ApiError) as e:
            verify_token(tok(**bad), SECRET, audience="support")  # type: ignore[arg-type]
        assert e.value.status == 401
    # издатели py-common не могут быть настроены на срок больше 60 с
    with pytest.raises(ValueError):
        ServiceSettings(service_name="x", internal_jwt_ttl_seconds=61)
    assert ServiceSettings(service_name="x").internal_jwt_ttl_seconds == 60


# ---------- app: health, errors, auth dependency ----------

def build_app(runtime: Runtime | None = None):
    router = APIRouter()

    @router.get("/v1/me")
    async def me(p: Principal = Depends(InternalAuth({"telegram-bff"}))) -> dict:
        return {"user_id": p.user_id}

    @router.get("/v1/missing")
    async def missing() -> dict:
        raise not_found("THING_NOT_FOUND", "Не найдено")

    s = settings()
    return s, create_app(s, routers=[router], runtime=runtime or Runtime(s))


async def test_app_health_errors_and_auth() -> None:
    s, app = build_app()
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            assert (await c.get("/health/live")).json() == {"status": "ok"}
            ready = await c.get("/health/ready")
            assert ready.status_code == 200 and ready.json()["status"] == "ok"

            r = await c.get("/v1/missing", headers={"x-trace-id": "abc"})
            assert r.status_code == 404
            body = r.json()
            assert body["code"] == "THING_NOT_FOUND" and body["trace_id"] == "abc"
            assert r.headers["x-trace-id"] == "abc"

            assert (await c.get("/v1/me")).json()["code"] == "INTERNAL_TOKEN_MISSING"
            ok = await c.get("/v1/me", headers=internal_headers(s, subject="user-42"))
            assert ok.status_code == 200 and ok.json() == {"user_id": "user-42"}
            bad = await c.get("/v1/me", headers=internal_headers(s, issuer="admin-bff", subject="u"))
            assert bad.status_code == 403 and bad.json()["code"] == "CALLER_NOT_ALLOWED"


async def test_readiness_reports_down_dependencies(capfd) -> None:
    from tilhero_common import app as app_module

    app_module._last_degraded_log = 0.0
    s = settings(redis_url="redis://:secretpw@127.0.0.1:1/0")
    app = create_app(s, runtime=Runtime(s))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/health/ready")
            assert r.status_code == 503 and r.json()["checks"]["redis"] == "down"
    # причина — в логе (для healthcheck платформы), без адреса и пароля
    out = "".join(capfd.readouterr())
    assert "readiness degraded" in out and "'redis': 'ConnectionError'" in out
    assert "secretpw" not in out and "127.0.0.1" not in out


# ---------- outbox / inbox on real PostgreSQL ----------

items_md = MetaData()
items = Table("items", items_md, Column("id", String, primary_key=True))


@pytest.fixture
async def db():
    schema = unique_schema("common")
    await create_schema(schema)
    await create_tables(schema, [items_md, messaging_metadata])
    database = Database(TEST_ADMIN_URL, schema)
    yield database
    await database.dispose()
    await drop_schema(schema)


async def test_outbox_is_transactional_and_relayed(db: Database) -> None:
    bus = InMemoryBus()
    await bus.connect()
    received: list[Envelope] = []

    async def handler(env: Envelope) -> None:
        received.append(env)

    await bus.subscribe(ConsumerSpec("t.items", ["item.created.v1"], handler))

    # откат транзакции не оставляет события
    with pytest.raises(RuntimeError):
        async with db.session() as s:
            await s.execute(items.insert().values(id="a"))
            await emit(s, "item.created.v1", {"id": "a"}, producer="svc-a")
            raise RuntimeError("boom")
    async with db.session() as s:
        assert (await s.execute(select(outbox_table))).all() == []

    async with db.session() as s:
        await s.execute(items.insert().values(id="b"))
        await emit(s, "item.created.v1", {"id": "b"}, producer="svc-a")

    relay = OutboxRelay(db, bus)
    assert await relay.flush_once() == 1
    assert await relay.flush_once() == 0
    assert [e.payload["id"] for e in received] == ["b"]


async def test_outbox_retries_on_publish_failure(db: Database) -> None:
    class FailingBus(InMemoryBus):
        async def publish(self, envelope: Envelope) -> None:
            raise ConnectionError("nats down")

    bus = FailingBus()
    await bus.connect()
    async with db.session() as s:
        await emit(s, "item.created.v1", {"id": "c"}, producer="svc-a")
    assert await OutboxRelay(db, bus).flush_once() == 0
    async with db.session() as s:
        row = (await s.execute(select(outbox_table))).one()
        # в last_error только тип ошибки (текст исключения может нести данные события)
        assert row.attempts == 1 and row.published_at is None and row.last_error == "ConnectionError"


async def test_inbox_deduplicates(db: Database) -> None:
    env = make_envelope("item.created.v1", {"id": "d"}, producer="svc-a")
    calls = 0

    async def handler(session, envelope) -> None:
        nonlocal calls
        calls += 1
        await session.execute(items.insert().values(id=envelope.payload["id"]))

    assert await run_with_inbox(db, "t.consumer", env, handler) is True
    assert await run_with_inbox(db, "t.consumer", env, handler) is False
    assert calls == 1


async def test_inbox_rolls_back_with_failed_handler(db: Database) -> None:
    env = make_envelope("item.created.v1", {"id": "e"}, producer="svc-a")

    async def failing(session, envelope) -> None:
        raise ValueError("handler bug")

    with pytest.raises(ValueError):
        await run_with_inbox(db, "t.consumer", env, failing)

    async def ok(session, envelope) -> None:
        return None

    assert await run_with_inbox(db, "t.consumer", env, ok) is True  # отметка inbox откатилась вместе с ошибкой


# ---------- NATS JetStream end-to-end ----------

async def test_nats_publish_subscribe_dedup_and_dlq() -> None:
    bus = NatsBus(TEST_NATS_URL, client_name="test")  # общий поток TILHERO, уникальные subjects
    await bus.connect()
    got: list[str] = []
    failures = 0

    async def handler(env: Envelope) -> None:
        got.append(env.event_id)

    async def always_fails(env: Envelope) -> None:
        nonlocal failures
        failures += 1
        raise RuntimeError("bad")

    try:
        suffix = uuid.uuid4().hex[:6]
        await bus.subscribe(ConsumerSpec(f"test.ok_{suffix}", [f"test{suffix}.ok.v1"], handler))
        await bus.subscribe(ConsumerSpec(f"test.bad_{suffix}", [f"test{suffix}.bad.v1"], always_fails,
                                         max_deliver=2, ack_wait_seconds=1.0))
        env = make_envelope(f"test{suffix}.ok.v1", {"n": 1}, producer="test")
        await bus.publish(env)
        await bus.publish(env)  # дубль отбрасывает JetStream (Nats-Msg-Id)
        await bus.publish(make_envelope(f"test{suffix}.bad.v1", {}, producer="test"))
        for _ in range(60):
            if got and failures >= 2:
                break
            await asyncio.sleep(0.1)
        await asyncio.sleep(0.5)
        assert got == [env.event_id]
        assert failures == 2  # max_deliver соблюдён, затем DLQ
    finally:
        import contextlib
        for durable in (f"test_ok_{suffix}", f"test_bad_{suffix}"):
            with contextlib.suppress(Exception):
                await bus._js.delete_consumer(bus.stream, durable)
        await bus.close()


# ---------- Redis tools ----------

@pytest.fixture
async def redis():
    r = Redis.from_url(TEST_REDIS_URL, decode_responses=True)
    yield r
    await r.aclose()


async def test_rate_limit(redis: Redis) -> None:
    key = f"t:{uuid.uuid4().hex}"
    results = [await rate_limit(redis, key, 3, 60) for _ in range(4)]
    assert [r.allowed for r in results] == [True, True, True, False]


async def test_idempotency_store(redis: Redis) -> None:
    store = IdempotencyStore(redis, f"t{uuid.uuid4().hex[:6]}")
    fp = fingerprint({"a": 1})
    assert await store.begin("u1", "k1", fp) is None
    with pytest.raises(ApiError) as e:
        await store.begin("u1", "k1", fp)
    assert e.value.code == "IDEMPOTENCY_IN_PROGRESS"
    await store.complete("u1", "k1", fp, {"id": "x"})
    assert await store.begin("u1", "k1", fp) == {"id": "x"}
    with pytest.raises(ApiError) as e:
        await store.begin("u1", "k1", fingerprint({"a": 2}))
    assert e.value.code == "IDEMPOTENCY_KEY_REUSED"


async def test_attempt_limiter_locks_after_five(redis: Redis) -> None:
    lim = AttemptLimiter(redis, f"pin{uuid.uuid4().hex[:6]}", max_attempts=5, lock_seconds=300)
    states = [await lim.fail("u1") for _ in range(5)]
    assert [s.remaining for s in states[:4]] == [4, 3, 2, 1]
    assert states[4].locked and (await lim.state("u1")).locked
    await lim.reset("u1")
    assert (await lim.state("u1")).remaining == 5


class _PausedAfterFirstCommand:
    """Клиент Redis, который после первой команды ждёт gate: запрос «застрял» между чтением и записью."""

    def __init__(self, redis: Redis, gate: asyncio.Event) -> None:
        self._redis, self._gate, self._first = redis, gate, True

    def __getattr__(self, name: str):
        attr = getattr(self._redis, name)
        if not callable(attr):
            return attr

        async def call(*args, **kw):
            result = await attr(*args, **kw)
            if self._first:
                self._first = False
                await self._gate.wait()
            return result
        return call


async def test_attempt_limiter_reservation_same_as_fail_for_single_request(redis: Redis) -> None:
    """Спринт 9: резервирование (reserve → неудача → failed) даёт тот же remaining и блокировку на 5-й неудаче, что и
    прежний fail(); успех после резервирования (reset) обнуляет счётчик."""
    lim = AttemptLimiter(redis, f"pin{uuid.uuid4().hex[:6]}", max_attempts=5, lock_seconds=300)
    seen = []
    for _ in range(5):
        r = await lim.reserve("u1")
        assert not r.locked
        seen.append(await lim.failed("u1", r))
    assert [s.remaining for s in seen[:4]] == [4, 3, 2, 1] and seen[4].locked and seen[4].retry_after == 300
    assert (await lim.reserve("u1")).locked and (await lim.state("u1")).locked
    await lim.reset("u1")
    ok = await lim.reserve("u1")  # верный секрет: попытка занята и тут же сброшена
    assert (ok.locked, ok.remaining) == (False, 4)
    await lim.reset("u1")
    assert (await lim.state("u1")).remaining == 5
    # fail() при стоящей блокировке счётчик не трогает
    for _ in range(5):
        await lim.fail("u2")
    assert (await lim.fail("u2")).locked and await redis.get(f"{lim.ns}:fail:u2") is None


async def test_attempt_limiter_burst_cannot_exceed_limit(redis: Redis) -> None:
    lim = AttemptLimiter(redis, f"pin{uuid.uuid4().hex[:6]}", max_attempts=5, lock_seconds=300)
    states = await asyncio.gather(*(lim.reserve("u") for _ in range(12)))
    assert sum(not s.locked for s in states) == 5  # из «залпа» проверяется не больше max_attempts вариантов


async def test_attempt_reservation_started_before_lock_cannot_pass_after_it(redis: Redis) -> None:
    """Запрос начал резервирование до блокировки соседом и «застрял»; сосед исчерпал лимит (блокировка + удаление
    счётчика). Прежний код (state(), затем INCR отдельно) давал застрявшему попытку с полным запасом; атомарное
    резервирование — блокировку. То же — для fail() без резервирования."""
    ns, gate = f"pin{uuid.uuid4().hex[:6]}", asyncio.Event()
    first = AttemptLimiter(redis, ns, 5, 300)
    for left in (4, 3, 2, 1, 0):
        assert (await first.reserve("s")).remaining == left
    late = AttemptLimiter(_PausedAfterFirstCommand(redis, gate), ns, 5, 300)  # type: ignore[arg-type]
    pending = asyncio.create_task(late.reserve("s"))
    await asyncio.sleep(0.05)
    assert (await first.reserve("s")).locked
    gate.set()
    assert (await pending).locked
    assert await redis.get(f"{ns}:fail:s") is None  # застрявший не завёл новый счётчик

    ns2, gate2 = f"pin{uuid.uuid4().hex[:6]}", asyncio.Event()
    a = AttemptLimiter(redis, ns2, 5, 300)
    for _ in range(4):
        await a.fail("s")
    late2 = AttemptLimiter(_PausedAfterFirstCommand(redis, gate2), ns2, 5, 300)  # type: ignore[arg-type]
    pending2 = asyncio.create_task(late2.fail("s"))
    await asyncio.sleep(0.05)
    assert (await a.fail("s")).locked
    gate2.set()
    assert (await pending2).locked and await redis.get(f"{ns2}:fail:s") is None


# ---------- service client ----------

async def test_service_client_errors_retries_and_breaker() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        assert request.headers["x-internal-token"]
        if request.url.path == "/flaky" and calls["n"] < 3:
            return httpx.Response(503)
        if request.url.path == "/missing":
            return httpx.Response(404, json={"code": "X_NOT_FOUND", "message": "nope", "details": {}})
        return httpx.Response(200, json={"ok": True})

    s = settings()
    client = ServiceClient(s, target="svc-b", base_url="http://b", transport=httpx.MockTransport(handler),
                           breaker=CircuitBreaker(threshold=2, cooldown=60))
    assert await client.get("/flaky") == {"ok": True}
    with pytest.raises(UpstreamError) as e:
        await client.get("/missing")
    assert e.value.status == 404 and e.value.code == "X_NOT_FOUND"
    calls["n"] = 0

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    broken = ServiceClient(s, target="svc-c", base_url="http://c", transport=httpx.MockTransport(down),
                           retries=0, breaker=CircuitBreaker(threshold=2, cooldown=60))
    for _ in range(2):
        with pytest.raises(UpstreamError):
            await broken.post("/x", json={})
    with pytest.raises(UpstreamError) as e:
        await broken.post("/x", json={})
    assert e.value.code == "UPSTREAM_UNAVAILABLE" and type(e.value).__name__ == "CircuitOpen"
    await client.aclose()
    await broken.aclose()



# ---------- ревью спринта 1: подпись издателем, actor только от admin-bff, ENV обязателен ----------

def _explicit_ring(name: str, publics: dict[str, bytes], seed: bytes):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    from tilhero_common.internal_auth import KeyRing, private_from_seed

    keys = {k: Ed25519PublicKey.from_public_bytes(v) for k, v in publics.items()}
    return KeyRing(name, private_from_seed(seed), keys)


def test_service_cannot_impersonate_another_issuer() -> None:
    import os

    from tilhero_common.internal_auth import private_from_seed, public_raw

    seeds = {n: os.urandom(32) for n in ("admin-bff", "telegram-bot-gateway", "support")}
    publics = {n: public_raw(private_from_seed(s)) for n, s in seeds.items()}
    support = _explicit_ring("support", publics, seeds["support"])
    botgw = _explicit_ring("telegram-bot-gateway", publics, seeds["telegram-bot-gateway"])
    admin = _explicit_ring("admin-bff", publics, seeds["admin-bff"])
    staff = Actor(id="s1", role="super_admin", permissions=frozenset({"support.reply"}), name="Алина")

    ok = verify_token(issue_token(admin, issuer="admin-bff", audience="support", actor=staff), support,
                      audience="support")
    assert ok.actor and ok.actor.name == "Алина"
    with pytest.raises(ValueError):  # свой ключ не подписывает чужим именем
        issue_token(botgw, issuer="admin-bff", audience="support", actor=staff)
    # подделка: подпись ключом bot-gateway с kid/iss = admin-bff
    import jwt as pyjwt

    forged = pyjwt.encode({"iss": "admin-bff", "aud": "support", "exp": 9_999_999_999,
                           "actor": {"id": "x", "role": "super_admin", "permissions": ["support.reply"]}},
                          botgw.private_key, algorithm="EdDSA", headers={"kid": "admin-bff"})
    with pytest.raises(ApiError) as e:
        verify_token(forged, support, audience="support")
    assert e.value.code == "INTERNAL_TOKEN_INVALID"
    # actor от не-admin-bff отклоняется
    with pytest.raises(ApiError) as e:
        verify_token(issue_token(botgw, issuer="telegram-bot-gateway", audience="support", actor=staff), support,
                     audience="support")
    assert e.value.code == "ACTOR_NOT_ALLOWED"
    # HS256 и alg=none не принимаются
    hs = pyjwt.encode({"iss": "admin-bff", "aud": "support", "exp": 9_999_999_999}, "secret", algorithm="HS256",
                      headers={"kid": "admin-bff"})
    with pytest.raises(ApiError):
        verify_token(hs, support, audience="support")


async def test_runtime_requires_explicit_env(monkeypatch) -> None:
    monkeypatch.delenv("ENV", raising=False)
    s = ServiceSettings(service_name="svc-x")
    with pytest.raises(RuntimeError, match="ENV must be set"):
        await Runtime(s).start()


async def test_body_size_limit_and_trace_header_sanitized() -> None:
    _, app = build_app()
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            r = await c.post("/v1/missing", content=b"x" * (300 * 1024))
            assert r.status_code == 413 and r.json()["code"] == "PAYLOAD_TOO_LARGE"
            r = await c.get("/v1/missing", headers={"x-trace-id": "bad trace id with spaces" * 10})
            assert r.json()["trace_id"] != "bad trace id with spaces" * 10


async def test_body_limit_counts_streamed_bytes_sec9_03() -> None:
    """SEC9-03: chunked без Content-Length (и заниженный Content-Length) — лимит по прочитанным байтам → 413."""
    from fastapi import Body

    router = APIRouter()
    reads: list[int] = []

    @router.post("/v1/echo")
    async def echo(b: dict = Body(...)) -> dict:
        reads.append(len(b["text"]))
        return {"n": len(b["text"])}

    @router.post("/v1/raw")
    async def raw(request: Request) -> dict:
        try:
            data = await request.body()
        except Exception:  # обработчик, проглатывающий ошибку чтения, ответ не подменит
            return {"swallowed": True}
        return {"n": len(data)}

    s = settings()
    app = create_app(s, routers=[router], runtime=Runtime(s))

    def chunked(total: int):
        async def gen():
            yield b'{"text": "'
            for _ in range(total // 65_536):
                yield b"x" * 65_536
            yield b'"}'
        return gen()

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            for path in ("/v1/echo", "/v1/raw"):
                r = await c.post(path, content=chunked(2 * 1024 * 1024), headers={"content-type": "application/json"})
                assert r.status_code == 413 and r.json()["code"] == "PAYLOAD_TOO_LARGE", (path, r.text)
                assert r.headers["x-trace-id"]
            assert reads == []  # обработчик до тела сверх лимита не дошёл
            ok = await c.post("/v1/echo", content=chunked(128 * 1024), headers={"content-type": "application/json"})
            assert ok.status_code == 200 and ok.json() == {"n": 128 * 1024}, ok.text



# ---------- ревью спринта 1: сбои шины, retention outbox, супервизия потребителя, роли БД ----------

async def test_outbox_survives_bus_outage_and_hanging_publish(db: Database) -> None:
    """P7: шина падает при публикации → записи остаются в outbox с backoff и публикуются после восстановления;
    зависшая публикация ограничена таймаутом, пачка не держит блокировки на каждую запись."""
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import update

    class FlakyBus(InMemoryBus):
        def __init__(self) -> None:
            super().__init__()
            self.mode = "down"
            self.attempts = 0

        async def publish(self, envelope: Envelope) -> None:
            self.attempts += 1
            if self.mode == "down":
                raise ConnectionError("nats down")
            if self.mode == "hang":
                await asyncio.sleep(30)
            await super().publish(envelope)

    bus = FlakyBus()
    await bus.connect()
    async with db.session() as s:
        for i in range(3):
            await emit(s, "item.created.v1", {"id": f"o{i}"}, producer="svc-a")
    relay = OutboxRelay(db, bus, publish_timeout=0.2)
    assert await relay.flush_once() == 0
    assert bus.attempts == 1  # после первой неудачи пачка прерывается — шина недоступна
    async with db.session() as s:
        rows = (await s.execute(select(outbox_table).order_by(outbox_table.c.created_at))).all()
    assert sorted(r.attempts for r in rows) == [0, 0, 1] and all(r.published_at is None for r in rows)
    assert max(r.next_attempt_at for r in rows) > datetime.now(UTC)  # backoff у неудачной записи

    bus.mode = "hang"
    started = asyncio.get_running_loop().time()
    assert await relay.flush_once() == 0
    assert asyncio.get_running_loop().time() - started < 2  # таймаут публикации, а не 30 с
    async with db.session() as s:  # «время прошло»: backoff истёк
        await s.execute(update(outbox_table).values(next_attempt_at=datetime.now(UTC) - timedelta(seconds=1)))

    bus.mode = "up"
    assert await relay.flush_once() == 3
    assert sorted(e.payload["id"] for e in bus.published) == ["o0", "o1", "o2"]
    assert await relay.flush_once() == 0
    # повторная публикация того же event_id (например, после сбоя между publish и commit) — дубль отбрасывается
    await bus.publish(bus.published[0])
    assert len(bus.published) == 3


async def test_outbox_retention_purges_only_old_published(db: Database) -> None:
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import update

    bus = InMemoryBus()
    await bus.connect()
    async with db.session() as s:
        for i in range(3):
            await emit(s, "item.created.v1", {"id": f"r{i}"}, producer="svc-a")
    relay = OutboxRelay(db, bus, retention=timedelta(hours=72))
    assert await relay.flush_once() == 3
    async with db.session() as s:
        await emit(s, "item.created.v1", {"id": "pending"}, producer="svc-a")  # не опубликована
        ids = [r.id for r in (await s.execute(select(outbox_table.c.id).order_by(outbox_table.c.created_at))).all()]
        await s.execute(update(outbox_table).where(outbox_table.c.id == ids[0])
                        .values(published_at=datetime.now(UTC) - timedelta(hours=73)))
        await s.execute(update(outbox_table).where(outbox_table.c.id == ids[3])
                        .values(created_at=datetime.now(UTC) - timedelta(days=30)))
    assert await relay.purge_published() == 1
    async with db.session() as s:
        left = {r.id for r in (await s.execute(select(outbox_table.c.id))).all()}
    assert left == set(ids[1:])  # свежие опубликованные и неопубликованная (даже старая) остаются
    assert ServiceSettings(service_name="x", env="test").outbox_retention_hours == 72


async def test_consumer_loop_survives_ack_and_dlq_failures() -> None:
    """Сбой ack/DLQ (переподключение NATS) не останавливает pull-loop: сообщение будет доставлено повторно."""
    from types import SimpleNamespace

    import nats.errors

    bus = NatsBus("nats://unused")
    handled: list[str] = []

    async def handler(env: Envelope) -> None:
        handled.append(env.event_id)

    spec = ConsumerSpec("t.loop", ["item.created.v1"], handler)
    env1 = make_envelope("item.created.v1", {"id": 1}, producer="svc-a")
    acks = {"n": 0}

    class Msg:
        def __init__(self, env: Envelope) -> None:
            self.data = env.to_json().encode()
            self.subject = env.subject
            self.metadata = SimpleNamespace(num_delivered=1)

        async def ack(self) -> None:
            acks["n"] += 1
            if acks["n"] == 1:
                raise ConnectionError("reconnecting")

        async def nak(self, delay: float = 0) -> None:
            return None

    batches = [[Msg(env1)], [Msg(env1)]]

    class PSub:
        async def fetch(self, batch: int, timeout: float):  # noqa: ASYNC109 - сигнатура nats psub.fetch
            if batches:
                return batches.pop(0)
            bus._closing.set()
            raise nats.errors.TimeoutError

    await asyncio.wait_for(bus._pull_loop(spec, PSub()), 5)
    assert handled == [env1.event_id, env1.event_id] and acks["n"] == 2
    assert bus.stale_consumers(max_age=60) == []


def test_secure_logs_hide_exception_text() -> None:
    tg, name = 918273645, "ivan_secret"
    try:
        raise ValueError(f"telegram_user_id={tg} username={name}")
    except ValueError:
        import sys

        record = logging.LogRecord("x", logging.ERROR, __file__, 1, "failed", None, sys.exc_info())
    safe = json.loads(JsonFormatter("svc", safe_exceptions=True).format(record))
    assert "918273645" not in safe["exc"] and "ValueError" in safe["exc"]
    full = json.loads(JsonFormatter("svc").format(record))
    assert "918273645" in full["exc"]  # dev/test: полный текст для отладки


async def test_half_open_breaker_lets_one_probe() -> None:
    breaker = CircuitBreaker(threshold=1, cooldown=0.05)
    breaker.failure()
    assert breaker.allow() is False
    await asyncio.sleep(0.06)
    assert breaker.allow() is True and breaker.allow() is False  # одна проба, остальные ждут её исхода
    breaker.success()
    assert breaker.allow() is True and breaker.allow() is True


def test_migrations_use_owner_url_when_set() -> None:
    from tilhero_common.migrations import migration_url

    assert migration_url(settings(database_url="postgresql://svc@h/db")) == "postgresql://svc@h/db"
    assert migration_url(settings(database_url="postgresql://svc@h/db",
                                  migration_database_url="postgresql://svc_owner@h/db")) == "postgresql://svc_owner@h/db"
    with pytest.raises(RuntimeError):
        migration_url(settings())


async def test_secondary_app_shares_runtime_without_managing_it() -> None:
    s = settings()
    runtime = Runtime(s)
    main_app = create_app(s, runtime=runtime)
    side_app = create_app(s, runtime=runtime, manage_runtime=False)
    async with side_app.router.lifespan_context(side_app):
        assert runtime.started is False
    async with main_app.router.lifespan_context(main_app):
        assert runtime.started is True
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=side_app), base_url="http://t") as c:
            assert (await c.get("/health/ready")).status_code == 200


async def test_transient_error_never_goes_to_dlq() -> None:
    """TransientError (зависимость недоступна) → nak без DLQ даже после max_deliver; обычная ошибка → DLQ."""
    from types import SimpleNamespace

    from tilhero_common.errors import TransientError

    bus = NatsBus("nats://unused")
    published: list[str] = []

    async def publish_raw(subject: str, data: bytes, headers: dict | None = None) -> None:
        published.append(subject)

    bus.publish_raw = publish_raw  # type: ignore[method-assign]
    mode = {"exc": TransientError("registry down")}

    async def handler(env: Envelope) -> None:
        raise mode["exc"]

    spec = ConsumerSpec("t.transient", ["item.created.v1"], handler, max_deliver=3)
    env1 = make_envelope("item.created.v1", {"id": 1}, producer="svc-a")
    events: list[tuple[str, float]] = []

    class Msg:
        def __init__(self, attempt: int) -> None:
            self.data = env1.to_json().encode()
            self.subject = env1.subject
            self.metadata = SimpleNamespace(num_delivered=attempt)

        async def ack(self) -> None:
            events.append(("ack", 0))

        async def nak(self, delay: float = 0) -> None:
            events.append(("nak", delay))

    await bus._handle(spec, Msg(50))  # далеко за пределом max_deliver
    assert events == [("nak", 300.0)] and published == []
    events.clear()
    await bus._handle(spec, Msg(288))  # ~сутки временных ошибок → DLQ (не копим вечно)
    assert events == [("ack", 0)] and len(published) == 1
    published.clear()
    mode["exc"] = ValueError("bad data")
    events.clear()
    await bus._handle(spec, Msg(3))
    assert events == [("ack", 0)] and len(published) == 1  # DLQ


async def test_consumer_spec_default_max_deliver_from_settings() -> None:
    spec = ConsumerSpec("t.default", ["item.created.v1"], lambda env: None)  # type: ignore[arg-type,return-value]
    assert spec.max_deliver is None
    mem = InMemoryBus()
    calls = {"n": 0}

    async def failing(env: Envelope) -> None:
        calls["n"] += 1
        raise ValueError("x")

    await mem.subscribe(ConsumerSpec("t.mem", ["item.created.v1"], failing))
    await mem.publish(make_envelope("item.created.v1", {"id": 2}, producer="svc-a"))
    assert calls["n"] == 10 and len(mem.dlq) == 1
