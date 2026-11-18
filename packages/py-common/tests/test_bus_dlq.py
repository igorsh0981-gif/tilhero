"""Спринт 8 (INTERNAL_API §3.1) на настоящем NATS JetStream стенда: стрим TILHERO_DLQ и заголовки DLQ, адресный повтор
`tilhero.replay.<durable>`, дедупликация inbox при повторе, смена фильтра существующего durable и честная деградация,
роутер `/internal/v1/ops/outbox`.

Каждый тест — свои subjects и durable (суффикс), консьюмеры удаляются, сообщения DLQ теста вычищаются."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import Column, MetaData, String, Table, func, select, update

from tilhero_common.app import Runtime, create_app
from tilhero_common.db import Database
from tilhero_common.errors import TransientError
from tilhero_common.messaging import (
    DLQ_STREAM,
    ConsumerSpec,
    Envelope,
    InMemoryBus,
    NatsBus,
    dlq_subject,
    durable_token,
    emit,
    make_envelope,
    messaging_metadata,
    outbox_table,
    replay_subject,
    run_with_inbox,
)
from tilhero_common.messaging.bus import dlq_reason, legacy_dlq_subject, transient_delay
from tilhero_common.settings import ServiceSettings
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    TEST_NATS_URL,
    create_schema,
    create_tables,
    drop_schema,
    internal_headers,
    unique_schema,
)

SECRET = "test-secret-" + "x" * 32

seen_md = MetaData()
seen = Table("seen", seen_md, Column("id", String, primary_key=True))


async def until(check: Callable[[], Awaitable[Any]], seconds: float = 15.0) -> Any:
    for _ in range(int(seconds / 0.05)):
        value = await check()
        if value:
            return value
        await asyncio.sleep(0.05)
    raise AssertionError("timeout")


@pytest.fixture
async def db():
    schema = unique_schema("busdlq")
    await create_schema(schema)
    await create_tables(schema, [seen_md, messaging_metadata])
    database = Database(TEST_ADMIN_URL, schema)
    yield database
    await database.dispose()
    await drop_schema(schema)


@pytest.fixture
async def bus():
    b = NatsBus(TEST_NATS_URL, client_name="test-dlq")
    await b.connect()
    created: list[str] = []
    b.test_created = created  # type: ignore[attr-defined]
    yield b
    for durable in created:
        with contextlib.suppress(Exception):
            await b._js.delete_consumer(b.stream, durable_token(durable))
        with contextlib.suppress(Exception):
            await b._js.purge_stream(DLQ_STREAM, subject=dlq_subject(durable))
    await b.close()


async def subscribe(bus: NatsBus, spec: ConsumerSpec) -> None:
    bus.test_created.append(spec.durable)  # type: ignore[attr-defined]
    await bus.subscribe(spec)


async def last_dlq(bus: NatsBus, durable: str) -> Any:
    try:
        return await bus._js.get_last_msg(DLQ_STREAM, dlq_subject(durable))
    except Exception:
        return None


# ---------------------------------------------------------------- чистые функции

def test_subjects_and_reason_classes() -> None:
    assert dlq_subject("offers.user_deletion") == "tilherodlq.offers_user_deletion"
    assert legacy_dlq_subject("offers.user_deletion") == "tilhero.dlq.offers_user_deletion"
    assert replay_subject("offers.user_deletion") == "tilhero.replay.offers_user_deletion"
    assert dlq_reason(ValueError("секрет в тексте")) == "handler_error:ValueError"
    assert dlq_reason(transient=True) == "transient_exhausted" and dlq_reason(bad_envelope=True) == "bad_envelope"
    assert ServiceSettings(service_name="x", env="test").nats_dlq_max_age_days == 30


def test_transient_retry_after_delays_redelivery() -> None:
    """TransientError(retry_after=…) (429 Telegram у оповещений): повтор не раньше срока, не позже часа."""
    assert transient_delay(1, TransientError("x")) == 1.0
    assert transient_delay(1, TransientError("x", retry_after=7)) == 7.0
    assert transient_delay(12, TransientError("x", retry_after=7)) == 300.0  # backoff больше
    assert transient_delay(1, TransientError("x", retry_after=86_400)) == 3600.0
    assert str(TransientError("RATE_LIMITED", retry_after=7)) == "RATE_LIMITED"


# ---------------------------------------------------------------- DLQ

async def test_dlq_stream_headers_and_original_bytes(bus: NatsBus) -> None:
    """Стрим TILHERO_DLQ: 30 дней, 200 000 сообщений, discard old. Упавшее сообщение — тело байт в байт, причина —
    класс без текста, число доставок, Nats-Msg-Id dlq:<durable>:<event_id>:0; битый конверт — bad_envelope."""
    info = await bus._js.stream_info(DLQ_STREAM)
    assert info.config.subjects == ["tilherodlq.>"]
    assert info.config.max_age == 30 * 86_400 and info.config.max_msgs == 200_000
    assert str(info.config.discard).lower().endswith("old")
    sfx = uuid.uuid4().hex[:6]
    durable = f"test.dlq_{sfx}"
    failures = 0

    async def always_fails(env: Envelope) -> None:
        nonlocal failures
        failures += 1
        raise KeyError("payload-secret-value")

    await subscribe(bus, ConsumerSpec(durable, [f"test{sfx}.bad.v1"], always_fails, max_deliver=2,
                                      ack_wait_seconds=1.0))
    assert bus.replay_enabled[durable] is True
    env = make_envelope(f"test{sfx}.bad.v1", {"n": 1}, producer="test")
    await bus.publish(env)
    msg = await until(lambda: last_dlq(bus, durable))
    assert failures == 2
    assert msg.data == env.to_json().encode()  # исходный конверт байт в байт — его же отправит повтор
    h = msg.headers
    assert h["x-dlq-consumer"] == durable and h["x-event-id"] == env.event_id
    assert h["x-event-type"] == env.event_type and h["x-original-subject"] == env.subject
    assert h["x-dlq-reason"] == "handler_error:KeyError" and "secret" not in str(h)
    assert h["x-dlq-deliveries"] == "2" and h["x-dlq-replays"] == "0" and h["x-dlq-at"].endswith("Z")
    assert h["Nats-Msg-Id"] == f"dlq:{durable_token(durable)}:{env.event_id}:0"
    # битый конверт — тоже в DLQ, с причиной bad_envelope
    await bus.publish_raw(f"tilhero.test{sfx}.bad.v1", b"{not-json")
    poison = await until(lambda: _changed(bus, durable, msg.seq))
    assert poison.data == b"{not-json" and poison.headers["x-dlq-reason"] == "bad_envelope"
    assert poison.headers["x-event-id"] == ""


async def test_transient_retry_after_on_real_nats(bus: NatsBus) -> None:
    """TransientError(retry_after=2): JetStream доставляет повторно не раньше чем через 2 с (а не через 1 с backoff)."""
    sfx = uuid.uuid4().hex[:6]
    durable = f"test.retry_after_{sfx}"
    times: list[float] = []

    async def limited(env: Envelope) -> None:
        times.append(asyncio.get_running_loop().time())
        if len(times) == 1:
            raise TransientError("RATE_LIMITED", retry_after=2)

    await subscribe(bus, ConsumerSpec(durable, [f"test{sfx}.ra.v1"], limited, ack_wait_seconds=10.0))
    await bus.publish(make_envelope(f"test{sfx}.ra.v1", {"n": 1}, producer="test"))

    async def twice() -> bool:
        return len(times) >= 2

    await until(twice)
    assert times[1] - times[0] >= 1.9 and await last_dlq(bus, durable) is None


async def _changed(bus: NatsBus, durable: str, seq: int) -> Any:
    m = await last_dlq(bus, durable)
    return m if m is not None and m.seq != seq else None


async def test_dlq_publish_is_deduplicated_by_msg_id(bus: NatsBus) -> None:
    """Повторная отправка того же сообщения в DLQ (ack не дошёл, доставка повторилась) дубля не создаёт."""
    sfx = uuid.uuid4().hex[:6]
    durable = f"test.dedup_{sfx}"
    env = make_envelope(f"test{sfx}.x.v1", {}, producer="test")
    spec = ConsumerSpec(durable, [f"test{sfx}.x.v1"], lambda e: None)  # type: ignore[arg-type,return-value]
    bus.test_created.append(durable)  # type: ignore[attr-defined]

    class Msg:
        data = env.to_json().encode()
        subject = env.subject
        headers = None

    for _ in range(2):
        await bus._to_dlq(spec, Msg(), env, "handler_error:ValueError", 10)
    info = await bus._js.stream_info(DLQ_STREAM, subjects_filter=dlq_subject(durable))
    assert info.state.subjects == {dlq_subject(durable): 1}


# ---------------------------------------------------------------- адресный повтор

async def test_replay_reaches_only_the_failed_consumer_and_inbox_deduplicates(bus: NatsBus, db: Database) -> None:
    """Два консьюмера одного события. A падает → DLQ; повтор в tilhero.replay.<A> (тот же конверт) обрабатывается
    только A — B его не получает; повтор уже обработанного отбрасывает inbox; упавший повтор возвращается в DLQ
    с x-dlq-replays, перенесённым из сообщения повтора."""
    sfx = uuid.uuid4().hex[:6]
    a, b = f"test.ra_{sfx}", f"test.rb_{sfx}"
    etype = f"test{sfx}.item.v1"
    mode = {"fail": True}
    deliveries = {a: 0, b: 0}
    handled = {a: 0, b: 0}

    def make(durable: str) -> Callable[[Envelope], Awaitable[None]]:
        async def handler(session, env: Envelope) -> None:
            if durable == a and mode["fail"]:
                raise RuntimeError("bug")
            handled[durable] += 1
            await session.execute(seen.insert().values(id=f"{durable}:{env.event_id}"))

        async def wrapped(env: Envelope) -> None:
            deliveries[durable] += 1
            await run_with_inbox(db, durable, env, handler)

        return wrapped

    await subscribe(bus, ConsumerSpec(a, [etype], make(a), max_deliver=1, ack_wait_seconds=1.0))
    await subscribe(bus, ConsumerSpec(b, [etype], make(b), max_deliver=1, ack_wait_seconds=1.0))
    env = make_envelope(etype, {"id": 1}, producer="test")
    await bus.publish(env)
    dead = await until(lambda: last_dlq(bus, a))
    await until(lambda: asyncio.sleep(0, result=handled[b] == 1))
    assert handled == {a: 0, b: 1}

    async def replay(data: bytes, replays: int, key: str) -> None:
        await bus.publish_raw(replay_subject(a), data, headers={"Nats-Msg-Id": key, "x-dlq-replays": str(replays)})

    # 1) повтор, который снова падает → обратно в DLQ с replays = 1 (новая запись: другой Nats-Msg-Id)
    await replay(dead.data, 1, f"replay:{sfx}:1")
    again = await until(lambda: _changed(bus, a, dead.seq))
    assert again.data == env.to_json().encode() and again.headers["x-dlq-replays"] == "1"
    assert again.headers["Nats-Msg-Id"] == f"dlq:{durable_token(a)}:{env.event_id}:1"
    assert again.headers["x-original-subject"] == env.subject  # исходный subject, а не replay
    # 2) обработчик починили — повтор обработан ровно один раз, только консьюмером A
    mode["fail"] = False
    await replay(again.data, 2, f"replay:{sfx}:2")
    await until(lambda: asyncio.sleep(0, result=handled[a] == 1))
    # 3) повтор уже обработанного (двойной клик с новым ключом) — доставлен, но inbox его отбросил
    before = deliveries[a]
    await replay(again.data, 2, f"replay:{sfx}:3")
    await until(lambda: asyncio.sleep(0, result=deliveries[a] == before + 1))
    # 4) тот же Nats-Msg-Id повтора — JetStream отбрасывает дубль (двойной клик с тем же ключом)
    await replay(again.data, 2, f"replay:{sfx}:3")
    await asyncio.sleep(1.0)
    assert deliveries[a] == before + 1 and handled == {a: 1, b: 1}
    assert deliveries[b] == 1  # B повторов не видел
    async with db.session() as s:
        rows = (await s.execute(select(func.count()).select_from(seen))).scalar_one()
    assert rows == 2


async def test_existing_durable_gets_replay_subject(bus: NatsBus) -> None:
    """Durable до спринта 8 (без replay-subject) после подписки получает адресный subject — на месте, с позицией."""
    from nats.js.api import AckPolicy, ConsumerConfig, DeliverPolicy

    sfx = uuid.uuid4().hex[:6]
    durable = f"test.old_{sfx}"
    bus.test_created.append(durable)  # type: ignore[attr-defined]
    await bus._js.add_consumer(bus.stream, ConsumerConfig(
        durable_name=durable_token(durable), ack_policy=AckPolicy.EXPLICIT, deliver_policy=DeliverPolicy.ALL,
        ack_wait=30.0, max_deliver=-1, filter_subjects=[f"tilhero.test{sfx}.old.v1"]))
    got: list[str] = []

    async def handler(env: Envelope) -> None:
        got.append(env.event_id)

    await bus.subscribe(ConsumerSpec(durable, [f"test{sfx}.old.v1"], handler))
    info = await bus._js.consumer_info(bus.stream, durable_token(durable))
    assert info.config.filter_subjects == [f"tilhero.test{sfx}.old.v1", replay_subject(durable)]
    assert bus.replay_enabled[durable] is True
    env = make_envelope(f"test{sfx}.old.v1", {}, producer="test")
    await bus.publish(env)
    await until(lambda: asyncio.sleep(0, result=got == [env.event_id]))


async def test_replay_subject_unavailable_degrades_honestly(bus: NatsBus, caplog) -> None:
    """NATS не принял новый фильтр (старый сервер) → WARNING replay_subject_unavailable, replay_enabled = False,
    консьюмер работает с прежними subjects."""
    sfx = uuid.uuid4().hex[:6]
    durable = f"test.noreplay_{sfx}"
    real_add = bus._js.add_consumer

    async def old_server_add(stream: str, config: Any = None, **kw: Any) -> Any:
        if config is not None and len(config.filter_subjects or []) > 1:
            raise RuntimeError("filter_subjects not supported")
        return await real_add(stream, config, **kw)

    bus._js.add_consumer = old_server_add  # type: ignore[method-assign]
    got: list[str] = []

    async def handler(env: Envelope) -> None:
        got.append(env.event_id)

    logger = logging.getLogger("tilhero.bus")
    logger.addHandler(caplog.handler)
    try:
        await subscribe(bus, ConsumerSpec(durable, [f"test{sfx}.n.v1"], handler))
    finally:
        logger.removeHandler(caplog.handler)
        bus._js.add_consumer = real_add  # type: ignore[method-assign]
    assert bus.replay_enabled[durable] is False
    assert any(r.getMessage() == "replay_subject_unavailable" for r in caplog.records)
    env = make_envelope(f"test{sfx}.n.v1", {}, producer="test")
    await bus.publish(env)
    await until(lambda: asyncio.sleep(0, result=got == [env.event_id]))


async def test_runtime_replay_of_processed_event_emits_nothing_new(db: Database) -> None:
    """Через Runtime (inbox и outbox в одной транзакции): повтор уже обработанного события не выполняет обработчик и
    не публикует последствий второй раз — relay.drain() дожидается outbox, гонки нет."""
    sfx = uuid.uuid4().hex[:6]
    durable = f"test.rt_{sfx}"
    s = ServiceSettings(service_name="svc-rt", env="test", internal_jwt_secret=SECRET,
                        database_url=TEST_ADMIN_URL, db_schema=db.schema, nats_url=TEST_NATS_URL,
                        outbox_poll_interval_ms=50)
    runtime = Runtime(s, db=db)
    calls = 0

    async def handler(session, env: Envelope) -> None:
        nonlocal calls
        calls += 1
        await emit(session, f"test{sfx}.done.v1", {"source": env.event_id}, producer="svc-rt")

    runtime.add_consumer(durable, [f"test{sfx}.in.v1"], handler, max_deliver=1)
    await runtime.start()
    try:
        assert isinstance(runtime.bus, NatsBus) and runtime.bus.replay_enabled[durable] is True
        env = make_envelope(f"test{sfx}.in.v1", {"n": 1}, producer="test")
        await runtime.bus.publish(env)
        await until(lambda: asyncio.sleep(0, result=calls == 1))
        await runtime.bus.publish_raw(replay_subject(durable), env.to_json().encode(),
                                      headers={"Nats-Msg-Id": f"replay:{sfx}"})
        await asyncio.sleep(1.0)
        assert runtime.relay is not None
        await runtime.relay.drain()
        async with db.session() as session:
            out = (await session.execute(select(outbox_table.c.event_type, outbox_table.c.published_at))).all()
        assert calls == 1 and len(out) == 1 and out[0].published_at is not None
    finally:
        with contextlib.suppress(Exception):
            await runtime.bus._js.delete_consumer(runtime.bus.stream, durable_token(durable))  # type: ignore[union-attr]
        await runtime.stop()


# ---------------------------------------------------------------- /internal/v1/ops/outbox

async def test_ops_outbox_router(db: Database) -> None:
    s = ServiceSettings(service_name="svc-ops", env="test", internal_jwt_secret=SECRET,
                        database_url=TEST_ADMIN_URL, db_schema=db.schema)
    runtime = Runtime(s, db=db, bus=InMemoryBus())

    async def noop(session, env) -> None:
        return None

    runtime.add_consumer("svc-ops.things", ["thing.created.v1"], noop)
    app = create_app(s, runtime=runtime)
    async with db.session() as session:
        for i in range(3):
            await emit(session, "thing.created.v1", {"i": i}, producer="svc-ops")
    now = datetime.now(UTC)
    async with db.session() as session:
        ids = [r[0] for r in (await session.execute(select(outbox_table.c.id).order_by(outbox_table.c.created_at)))]
        await session.execute(update(outbox_table).where(outbox_table.c.id == ids[0]).values(published_at=now))
        await session.execute(update(outbox_table).where(outbox_table.c.id == ids[1]).values(
            attempts=3, last_error="ConnectionError", next_attempt_at=now + timedelta(seconds=30)))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://svc") as c:
        r = await c.get("/internal/v1/ops/outbox", headers=internal_headers(s, issuer="ops-monitor"))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["service"] == "svc-ops" and body["pending"] == 2 and body["failing"] == 1
        assert body["max_attempts"] == 3 and body["last_error_class"] == "ConnectionError"
        assert body["published_24h"] == 1 and body["oldest_pending_at"].endswith("Z")
        assert body["consumers"] == [{"durable": "svc-ops.things", "stale": False}]
        assert (await c.get("/internal/v1/ops/outbox",
                            headers=internal_headers(s, issuer="admin-bff"))).status_code == 403
        assert (await c.get("/internal/v1/ops/outbox")).status_code == 401
    # текст ошибки (если бы он туда попал) наружу не отдаётся — только имя класса
    async with db.session() as session:
        await session.execute(update(outbox_table).where(outbox_table.c.id == ids[1]).values(
            last_error="boom: user@example.com"))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://svc") as c:
        body = (await c.get("/internal/v1/ops/outbox", headers=internal_headers(s, issuer="ops-monitor"))).json()
        assert body["last_error_class"] is None
    # сервис без БД — роутера нет
    bare = create_app(ServiceSettings(service_name="svc-bare", env="test", internal_jwt_secret=SECRET))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=bare), base_url="http://svc") as c:
        assert (await c.get("/internal/v1/ops/outbox",
                            headers=internal_headers(s, issuer="ops-monitor"))).status_code == 404


# ---------------------------------------------------------------- схемы событий спринта 8
