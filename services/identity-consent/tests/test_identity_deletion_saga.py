"""Сага удаления (спринт 9, ADR-009, INTERNAL_API §1.2–1.3) на реальном PG: первичная рассылка, повторы по расписанию,
STUCK, ACK по доменам со временем, гонки (два повтора, ACK во время повтора, дубли), идемпотентность, PII."""

from __future__ import annotations

import asyncio
import io
import logging
import uuid
from datetime import timedelta

from deletion_kit import (
    ACK_CONSUMER,
    DOMAINS,
    ack,
    ack_all,
    acks,
    attempts,
    load,
    request_deletion,
    requested_events,
    sweep_at,
    user,
)
from sqlalchemy import func, select

from tilhero_common.app import Runtime
from tilhero_common.logging import JsonFormatter
from tilhero_common.messaging import InMemoryBus, make_envelope, outbox_table
from tilhero_common.testing import assert_event_conforms
from tilhero_identity.deletion.models import DeletionDomainAck
from tilhero_identity.deletion.sweeper import sweep_loop, sweep_once
from tilhero_identity.main import build_app


def _spec(env):
    return next(s for s in env.bus.specs if s.durable == ACK_CONSUMER)


# ---------------------------------------------------------------- первичная рассылка и расписание

async def test_initial_request_is_attempt_one_with_schedule(env) -> None:
    uid, rid = await request_deletion(env)
    req = await load(env, rid)
    assert (req.status, req.attempts, req.stuck_at, req.last_retry_by) == ("REQUESTED", 1, None, None)
    assert req.last_sent_at == req.requested_at
    assert req.next_retry_at == req.requested_at + timedelta(minutes=15)
    [first] = await requested_events(env, rid)
    assert first.payload == {"user_id": uid, "request_id": rid, "requested_at": first.payload["requested_at"],
                             "attempt": 1}
    [hist] = await attempts(env, rid)
    assert (hist.attempt, hist.sent_by, str(hist.event_id)) == (1, "user", first.event_id)
    # повторный запрос пользователя — тот же request_id, без новой рассылки
    again = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"confirm_word": "DELETE"})
    assert again.json()["request_id"] == rid
    assert len(await requested_events(env, rid)) == 1 and len(await attempts(env, rid)) == 1


async def test_retries_follow_schedule_with_new_event_id(env) -> None:
    uid, rid = await request_deletion(env)
    await ack_all(env, uid, rid, ["preferences", "support"])
    assert (await sweep_at(env, rid, minutes=14)).retried == 0  # рано
    assert len(await requested_events(env, rid)) == 1

    result = await sweep_at(env, rid, minutes=15)
    assert (result.leader, result.retried, result.stuck) == (True, 1, 0)
    first, second = await requested_events(env, rid)
    assert second.event_id != first.event_id
    assert second.payload == {**first.payload, "attempt": 2}  # тот же request_id, user_id и requested_at
    assert_event_conforms(second)
    req = await load(env, rid)
    assert (req.attempts, req.last_retry_by) == (2, "system")
    assert req.last_sent_at == req.requested_at + timedelta(minutes=15)
    assert req.next_retry_at == req.requested_at + timedelta(minutes=60)

    # тот же момент ещё раз — повтора нет (точка расписания уже отработана)
    assert (await sweep_at(env, rid, minutes=15)).retried == 0
    assert (await sweep_at(env, rid, minutes=59)).retried == 0
    # таймер простоял 5 часов: один повтор, а не пачка пропущенных
    assert (await sweep_at(env, rid, minutes=300)).retried == 1
    req = await load(env, rid)
    assert req.attempts == 3 and req.next_retry_at == req.requested_at + timedelta(minutes=720)
    history = await attempts(env, rid)
    assert [(a.attempt, a.sent_by) for a in history] == [(1, "user"), (2, "system"), (3, "system")]
    assert [str(a.event_id) for a in history] == [e.event_id for e in await requested_events(env, rid)]
    # ACK уже ответивших доменов при повторе не меняют их время
    before = {d: a.acked_at for d, a in (await acks(env, rid)).items()}
    await ack_all(env, uid, rid, ["preferences"])
    assert {d: a.acked_at for d, a in (await acks(env, rid)).items()} == before


async def test_retry_acks_complete_deletion_and_stop_timer(env) -> None:
    uid, rid = await request_deletion(env, telegram_user_id=7_100_200_300)
    await ack_all(env, uid, rid, DOMAINS[:5])
    await sweep_at(env, rid, minutes=15)
    # домены отвечают на повтор: ответившие ранее — повторно (отбрасывается), остальные — впервые
    await ack_all(env, uid, rid)
    req = await load(env, rid)
    assert (req.status, req.next_retry_at) == ("COMPLETED", None) and req.completed_at is not None
    assert (await user(env, uid)).telegram_user_id is None
    rows = await acks(env, rid)
    assert sorted(rows) == sorted(DOMAINS) and all(a.acked_at is not None and a.mode == "deleted"
                                                    for a in rows.values())
    # после завершения таймер ничего не шлёт
    assert (await sweep_at(env, rid, hours=48)).retried == 0
    assert len(await requested_events(env, rid)) == 2
    own = [e for e in await env.events("user.domain.deleted.v1", uid) if e.producer == "identity-consent"]
    assert len(own) == 1


# ---------------------------------------------------------------- STUCK

async def test_stuck_after_24h_then_completes_on_late_acks(env) -> None:
    uid, rid = await request_deletion(env)
    await ack_all(env, uid, rid, [d for d in DOMAINS if d not in ("watch", "news")])
    for minutes in (15, 60, 240, 720):
        assert (await sweep_at(env, rid, minutes=minutes)).retried == 1
    assert (await load(env, rid)).status == "REQUESTED"
    assert (await sweep_at(env, rid, hours=23, minutes=59)).stuck == 0

    result = await sweep_at(env, rid, hours=24)  # и STUCK, и повтор 1440 в одном тике
    assert (result.stuck, result.retried) == (1, 1)
    req = await load(env, rid)
    assert req.status == "STUCK" and req.stuck_at == req.requested_at + timedelta(hours=24)
    assert req.attempts == 6
    [stuck] = await env.events("user.deletion.stuck.v1")
    assert stuck.producer == "identity-consent"
    assert stuck.payload == {
        "request_id": rid, "user_id": uid, "requested_at": stuck.payload["requested_at"],
        "stuck_at": stuck.payload["stuck_at"], "pending_domains": ["watch", "news"], "attempts": 5,
    }
    assert stuck.payload["stuck_at"].endswith("Z")
    # повторы продолжаются раз в сутки, второго события STUCK нет
    assert (await sweep_at(env, rid, hours=30)).retried == 0
    assert (await sweep_at(env, rid, hours=48)).retried == 1
    assert len(await env.events("user.deletion.stuck.v1")) == 1
    # запрос пользователя повторно — тот же request_id (STUCK — тоже открытый запрос)
    again = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"confirm_word": "DELETE"})
    assert again.status_code == 202 and again.json()["request_id"] == rid
    # «Повторить запрос» никого не обезличивает — только ACK
    await ack_all(env, uid, rid, ["watch"])
    assert (await load(env, rid)).status == "STUCK" and (await user(env, uid)).status == "DELETION_REQUESTED"
    await ack_all(env, uid, rid, ["news"])
    req = await load(env, rid)
    assert req.status == "COMPLETED" and req.stuck_at is not None and req.next_retry_at is None
    assert (await user(env, uid)).status == "DELETED"


# ---------------------------------------------------------------- гонки и дубли

async def test_concurrent_sweeps_send_one_retry(env) -> None:
    """Два тика одновременно (две реплики или наложение тиков): одна точка расписания — один повтор."""
    _, rid = await request_deletion(env)
    req = await load(env, rid)
    now = req.requested_at + timedelta(minutes=16)
    # события первичной рассылки уже в шине env: relay второй «реплики» не может перехватить их и исказить подсчёт
    # (в CI он забирал user.status.changed.v1 — сумма по двум шинам без фильтра давала 3 при одном повторе)
    await env.flush()
    other = Runtime(env.settings, bus=InMemoryBus())  # вторая «реплика» с отдельным пулом соединений
    await other.start()
    try:
        results = await asyncio.gather(*[sweep_once(rt, now=now) for rt in (env.runtime, other) * 3])
    finally:
        await other.stop()
    assert sum(r.retried for r in results) == 1
    req = await load(env, rid)
    assert req.attempts == 2 and len(await attempts(env, rid)) == 2
    # источник истины — outbox: ровно две записи user.deletion.requested.v1 этого запроса (первичная + один повтор)
    async with env.runtime.transaction() as s:
        rows = (await s.execute(
            select(outbox_table.c.envelope).where(outbox_table.c.event_type == "user.deletion.requested.v1")
        )).scalars().all()
    mine = [r for r in rows if r["payload"]["request_id"] == rid]
    assert len(mine) == 2
    # и в шинах обеих реплик — те же два события (по event_id). Relay — «как минимум один раз»: остановка второй
    # реплики между publish и commit оставляет строку неотмеченной, и первая публикует её ещё раз с тем же event_id
    # (CI PR #34: 3 публикации, 2 события) — потребители отсекают такой дубль inbox'ом, второго повтора саги нет.
    await env.flush()
    published = [e for e in [*env.bus.published, *other.bus.published]  # type: ignore[union-attr]
                 if e.event_type == "user.deletion.requested.v1" and e.payload["request_id"] == rid]
    assert {e.event_id for e in published} == {r["event_id"] for r in mine}


async def test_ack_during_retry(env) -> None:
    """ACK последнего домена параллельно с тиком: профиль обезличен ровно один раз, повтор (если ушёл) безвреден."""
    for _ in range(5):
        uid, rid = await request_deletion(env)
        await ack_all(env, uid, rid, DOMAINS[:-1])
        req = await load(env, rid)
        last = ack(uid, rid, DOMAINS[-1])
        await asyncio.gather(sweep_once(env.runtime, now=req.requested_at + timedelta(minutes=15)),
                             _spec(env).handler(last))
        req = await load(env, rid)
        assert req.status == "COMPLETED" and req.next_retry_at is None
        assert req.attempts in (1, 2)  # повтор успел до ACK — или ACK закрыл запрос раньше
        # домен отвечает на повтор ещё раз — отбрасывается
        await _spec(env).handler(ack(uid, rid, DOMAINS[-1]))
        own = [e for e in await env.events("user.domain.deleted.v1", uid) if e.producer == "identity-consent"]
        assert len(own) == 1 and (await user(env, uid)).status == "DELETED"
    assert env.bus.dlq == []


async def test_duplicate_acks_keep_first_time(env) -> None:
    uid, rid = await request_deletion(env)
    first = ack(uid, rid, "support", "anonymized")
    await _spec(env).handler(first)
    [row] = (await acks(env, rid)).values()
    assert (row.domain, row.mode, str(row.event_id)) == ("support", "anonymized", first.event_id)
    # повторная доставка того же события, повторный ACK на повтор запроса (новый event_id), параллельно
    await asyncio.gather(*[_spec(env).handler(e) for e in (first, first, ack(uid, rid, "support"),
                                                           ack(uid, rid, "support"))])
    [again] = (await acks(env, rid)).values()
    assert (again.acked_at, again.mode, again.event_id) == (row.acked_at, "anonymized", row.event_id)
    req = await load(env, rid)
    assert req.acked_domains == ["support"]
    # чужие и лишние ACK не попадают в таблицу ACK
    forged = make_envelope("user.domain.deleted.v1",
                           {"user_id": uid, "request_id": rid, "domain": "watch", "mode": "deleted"},
                           producer="news")
    for env_ in (forged, ack(uid, rid, "discovery"), ack(uid, str(uuid.uuid4()), "watch"),
                 ack(str(uuid.uuid4()), rid, "watch")):
        await _spec(env).handler(env_)
    assert list(await acks(env, rid)) == ["support"]
    async with env.runtime.transaction() as s:
        assert (await s.execute(select(func.count()).select_from(DeletionDomainAck))).scalar_one() == 1


async def test_ack_with_unknown_mode_is_stored_without_mode(env) -> None:
    uid, rid = await request_deletion(env)
    weird = make_envelope("user.domain.deleted.v1", {"user_id": uid, "request_id": rid, "domain": "news",
                                                     "mode": "purged"}, producer="news")
    await _spec(env).handler(weird)
    row = (await acks(env, rid))["news"]
    assert row.mode is None and row.acked_at is not None


async def test_sweep_batches_many_requests(env) -> None:
    rids = [(await request_deletion(env))[1] for _ in range(4)]
    reqs = [await load(env, r) for r in rids]
    now = max(r.requested_at for r in reqs) + timedelta(minutes=15)
    assert (await sweep_once(env.runtime, now=now)).retried == 4
    assert [(await load(env, r)).attempts for r in rids] == [2, 2, 2, 2]


# ---------------------------------------------------------------- таймер приложения

async def test_sweeper_loop_runs_in_app() -> None:
    """build_app заводит таймер (DELETION_SWEEP_SECONDS > 0): повтор уходит сам, в логе — «deletion sweep ok»."""
    from conftest import SERVICE_DIR, make_settings

    from tilhero_common.testing import create_schema, drop_schema, migrate, unique_schema

    schema = unique_schema("idsweep")
    await create_schema(schema)
    settings = make_settings(schema, deletion_sweep_seconds=0.05, deletion_retry_schedule_minutes="1")
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    app = build_app(settings, runtime)
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter("identity-consent"))
    logging.getLogger().addHandler(handler)
    try:
        async with app.router.lifespan_context(app):
            assert any(t.get_name() == "deletion-sweeper" for t in runtime._background)
            import httpx

            from tilhero_common.testing import internal_headers

            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://id") as c:
                login = await c.post("/internal/v1/users/telegram-login",
                                     json={"telegram_user_id": 5_123_456_789, "first_name": "Тест"},
                                     headers=internal_headers(settings))
                uid = login.json()["user"]["user_id"]
                r = await c.post("/internal/v1/me/deletion-request", json={"confirm_word": "DELETE"},
                                 headers=internal_headers(settings, subject=uid))
                rid = r.json()["request_id"]
            async with runtime.transaction() as s:  # первая точка расписания уже прошла
                from sqlalchemy import text

                await s.execute(text("UPDATE deletion_requests SET next_retry_at = now() - interval '1 second', "
                                     "requested_at = requested_at - interval '2 minutes'"))
            for _ in range(100):
                await asyncio.sleep(0.05)
                assert runtime.relay is not None
                await runtime.relay.flush_once()
                if len([e for e in bus.of_type("user.deletion.requested.v1")
                        if e.payload["request_id"] == rid]) == 2:
                    break
            sent = [e for e in bus.of_type("user.deletion.requested.v1") if e.payload["request_id"] == rid]
            assert [e.payload["attempt"] for e in sent] == [1, 2]
    finally:
        logging.getLogger().removeHandler(handler)
        await drop_schema(schema)
    logs = stream.getvalue()
    assert "deletion sweep ok" in logs and "deletion request resent" in logs
    assert uid not in logs and "5123456789" not in logs


async def test_sweeper_loop_survives_errors(env, monkeypatch) -> None:
    from tilhero_identity.deletion import sweeper

    calls = 0

    async def boom(rt, now=None):
        nonlocal calls
        calls += 1
        raise RuntimeError("db down")

    monkeypatch.setattr(sweeper, "sweep_once", boom)
    task = asyncio.create_task(sweep_loop(env.runtime, 0.01))
    await asyncio.sleep(0.1)
    task.cancel()
    assert calls >= 2  # сбой тика не останавливает таймер


# ---------------------------------------------------------------- PII

async def test_no_pii_in_saga_events_and_logs(env) -> None:
    tg = 6_606_606_606
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter("identity-consent"))
    logging.getLogger().addHandler(handler)
    try:
        uid = await env.new_user(telegram_user_id=tg, username="pii_canary_user", first_name="Канарейка",
                                 last_name="Секретная")
        r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"confirm_word": "DELETE"})
        rid = r.json()["request_id"]
        await ack_all(env, uid, rid, DOMAINS[:3])
        await sweep_at(env, rid, minutes=15)
        await sweep_at(env, rid, hours=24)
        await ack_all(env, uid, rid)
    finally:
        logging.getLogger().removeHandler(handler)
    canaries = (str(tg), "pii_canary_user", "Канарейка", "Секретная")
    saga_events = [*await env.events("user.deletion.requested.v1"), *await env.events("user.deletion.stuck.v1")]
    assert len(saga_events) == 4
    for e in saga_events:
        assert set(e.payload) <= {"user_id", "request_id", "requested_at", "attempt", "stuck_at",
                                  "pending_domains", "attempts"}
        assert not any(c in e.to_json() for c in canaries)
    dump = await env.outbox_dump()
    assert not any(c in dump for c in canaries)
    logs = stream.getvalue()
    assert "deletion request resent" in logs and "deletion request stuck" in logs
    assert not any(c in logs for c in canaries)
    assert uid not in logs  # логи саги — только request_id, счётчики и домены
