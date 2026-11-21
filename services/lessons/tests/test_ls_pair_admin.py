"""Парные комнаты: админка (room.read / room.manage + step-up, аудит, без текстов), обзор; сага удаления
(обезличивание, отчёт партнёра не трогается), проверка удаления под блокировкой; tick (истечение, «скоро начнётся»,
неактивность, повторная оценка, срок хранения текстов); журнал «Контроля диалогов» без парных комнат."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import timedelta
from typing import Any

from conftest import Env

from tilhero_lessons.domain import users

ADMIN = "/internal/v1/admin/pair-rooms"


async def _finished_room(env: Env, a: uuid.UUID, b: uuid.UUID) -> str:
    rid = await env.started_room(a, b)
    for user, text in ((a, "Two coffees, please."), (b, "I will pay."), (a, "Thanks!"), (b, "Welcome!")):
        st = await env.turn(user, rid, {"text": text})
    assert st["status"] == "finished"
    await env.drain()
    return rid


async def test_admin_list_card_stop_and_stats(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    rid = await env.started_room(a, b)
    await env.turn(a, rid, {"text": "Secret line about my phone"})
    r = await env.c.get(ADMIN, headers=env.staff("qa.read"))
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    r = await env.c.get(ADMIN, headers=env.staff("room.read", actor=False))
    assert r.status_code == 403 and r.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    r = await env.c.get(ADMIN, headers=env.h(a))
    assert r.status_code == 403  # не admin-bff
    page = (await env.c.get(ADMIN, params={"status": "active"}, headers=env.staff("room.read"))).json()
    [row] = page["items"]
    assert row["room_id"] == rid and row["status"] == "in_progress" and row["ai_cost_usd"] == 0.02
    assert {p["user_id"] for p in row["participants"]} == {str(a), str(b)}
    assert {(p["side"], p["role"], p["turns"]) for p in row["participants"]} == {("inviter", "A", 1),
                                                                               ("invitee", "B", 0)}
    card = (await env.c.get(f"{ADMIN}/{rid}", headers=env.staff("room.read"))).json()
    assert [t["kind"] for t in card["timeline"]][:4] == ["joined", "joined", "roles", "coach"]
    assert "Secret" not in json.dumps(card, ensure_ascii=False) and "text" not in card["timeline"][0]
    assert card["stopped_by"] is None
    assert (await env.c.get(f"{ADMIN}/{uuid.uuid4()}", headers=env.staff("room.read"))).json()["code"] == \
        "ROOM_NOT_FOUND"
    body = {"reason": "Жалоба на грубость в комнате"}
    r = await env.c.post(f"{ADMIN}/{rid}/stop", json=body, headers=env.staff("room.read"))
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    r = await env.c.post(f"{ADMIN}/{rid}/stop", json=body, headers=env.staff("room.manage"))
    assert r.status_code == 403 and r.json()["code"] == "STEP_UP_REQUIRED"
    step_up = {**env.staff("room.manage"), "X-Step-Up": "ok"}
    r = await env.c.post(f"{ADMIN}/{rid}/stop", json={"reason": "short"}, headers=step_up)
    assert r.status_code == 422
    r = await env.c.post(f"{ADMIN}/{rid}/stop", json=body, headers=step_up)
    assert r.status_code == 200, r.text
    card = r.json()
    assert card["status"] == "stopped" and card["end_reason"] == "stopped" and card["stop_reason"] == body["reason"]
    assert card["stopped_by"]["staff_id"]
    r = await env.c.post(f"{ADMIN}/{rid}/stop", json=body, headers=step_up)
    assert r.status_code == 409 and r.json()["code"] == "ROOM_NOT_ACTIVE"
    await env.drain()
    [done] = await env.events("lesson.pair.completed.v1")
    assert done.payload["status"] == "stopped" and done.payload["end_reason"] == "stopped"
    [audit] = [e for e in await env.events("admin.audit.recorded.v1") if e.payload["action"] == "pair_room.stopped"]
    assert audit.payload["object_id"] == rid and audit.payload["reason"] == body["reason"]
    st = await env.state(b, rid)
    assert st["status"] == "stopped" and st["events"][-1]["kind"] == "stopped"
    rep = (await env.c.get(f"/internal/v1/me/pair-rooms/{rid}/report", headers=env.h(a))).json()
    assert rep["status"] == "stopped" and rep["me"]["turns"] == 1  # отчёт по сделанному
    stats = await env.c.get(f"{ADMIN}/stats", params={"period": "7d"}, headers=env.staff("dashboard.read"))
    assert stats.json()["pair_rooms_finished"] == 1 and stats.json()["by_status"]["stopped"] == 1
    assert (await env.c.get(f"{ADMIN}/stats", headers=env.staff("qa.read"))).status_code == 403


async def test_lessons_journal_has_no_pair_rooms_and_stats_by_kind_has_duel(env: Env) -> None:
    """Координатор (строгие кодеки admin-bff): в журнале «Контроля диалогов» нет kind pair; by_kind — ровно виды
    SessionKind, включая duel."""
    a, b = uuid.uuid4(), uuid.uuid4()
    await _finished_room(env, a, b)
    ds = await env.duel_set(a, b)
    s = await env.duel_session(a, ds["duel_id"])
    await env.current(a, s["session_id"])
    journal = (await env.c.get("/admin/v1/lesson-sessions", headers=env.staff("qa.read"))).json()["items"]
    assert [x["kind"] for x in journal] == ["duel"]
    stats = (await env.c.get("/admin/v1/lesson-sessions/stats", headers=env.staff("dashboard.read"))).json()
    assert stats["by_kind"] == {"lesson": 0, "scenario": 0, "media": 0, "review": 0, "reading": 0, "duel": 1}
    by_kind = (await env.c.get("/admin/v1/lesson-sessions", params={"kind": "duel"},
                               headers=env.staff("qa.read"))).json()["items"]
    assert len(by_kind) == 1
    r = await env.c.get("/admin/v1/lesson-sessions", params={"kind": "pair"}, headers=env.staff("qa.read"))
    assert r.status_code == 422


async def test_saga_anonymizes_rooms_keeps_partner_report(env: Env) -> None:
    a, b, c, d = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    rid = await _finished_room(env, a, b)
    env.friends(a, c)
    pending = await env.invite(a, c)
    ds = await env.duel_set(a, b)
    sa = await env.duel_session(a, ds["duel_id"])
    sb = await env.duel_session(b, ds["duel_id"])
    await env.nickname(a, "Deleted_me")
    await env.block(a, d)
    await env.ban(a, None)
    request_id = str(uuid.uuid4())
    payload = {"user_id": str(a), "request_id": request_id, "requested_at": env.now.isoformat()}
    await env.publish("user.deletion.requested.v1", payload, "identity-consent")
    rows = await env.sql("SELECT side, user_id, report FROM room_participants WHERE room_id = :r "
                         "ORDER BY side DESC", r=uuid.UUID(rid))
    assert rows[0][1] is None and rows[0][2] is None and rows[1][1] == b and rows[1][2] is not None
    texts = dict(await env.sql("SELECT side, string_agg(coalesce(text, '∅'), '|') FROM room_events "
                               "WHERE room_id = :r AND kind = 'turn' GROUP BY side", r=uuid.UUID(rid)))
    assert texts["inviter"] == "∅|∅" and texts["invitee"] == "I will pay.|Welcome!"
    rep_b = (await env.c.get(f"/internal/v1/me/pair-rooms/{rid}/report", headers=env.h(b))).json()
    assert [x["text"] for x in rep_b["me"]["lines"]] == ["I will pay.", "Welcome!"]
    view_b = (await env.c.get(f"/internal/v1/me/pair-rooms/{rid}", headers=env.h(b))).json()
    assert view_b["partner"]["nickname"] is None and view_b["partner"]["member_id"] != env.mid(a)
    admin = (await env.c.get(f"{ADMIN}/{rid}", headers=env.staff("room.read"))).json()
    assert [p["user_id"] for p in admin["participants"]] == [None, str(b)]
    assert await env.sql("SELECT count(*) FROM pair_rooms WHERE room_id = :r",
                         r=uuid.UUID(pending["room_id"])) == [(0,)]
    sets = await env.sql("SELECT user_a, user_b FROM duel_sets WHERE duel_id = :d", d=uuid.UUID(ds["duel_id"]))
    assert a not in sets[0] and b in sets[0]
    assert await env.sql("SELECT count(*) FROM sessions WHERE session_id = :s",
                         s=uuid.UUID(sa["session_id"])) == [(0,)]
    assert (await env.current(b, sb["session_id"]))["type"] == "item"  # набор остался партнёру
    for table, col in (("community_members", "user_id"), ("social_blocks", "blocker"),
                       ("social_sanctions", "user_id"), ("room_participants", "user_id")):
        assert await env.sql(f"SELECT count(*) FROM {table} WHERE {col} = :u", u=a) == [(0,)], table  # noqa: S608
    acks = await env.events("user.domain.deleted.v1")
    assert [(x.payload["domain"], x.payload["request_id"]) for x in acks] == [("lessons", request_id)]
    r = await env.c.get("/internal/v1/me/pair-rooms", headers=env.h(a))
    assert r.status_code == 410 and r.json()["code"] == "USER_DELETED"
    await env.publish("user.deletion.requested.v1", {**payload, "attempt": 2}, "identity-consent")
    assert len(await env.events("user.domain.deleted.v1")) == 2
    await env.nickname(a, "Back_again")  # проекция не воскрешает удалённого
    assert await env.sql("SELECT count(*) FROM community_members WHERE user_id = :u", u=a) == [(0,)]


async def test_saga_during_live_room_partner_continues_solo(env: Env) -> None:
    c, d = uuid.uuid4(), uuid.uuid4()
    rid = await env.started_room(c, d)
    await env.turn(c, rid, {"text": "Hello!"})
    await env.publish("user.deletion.requested.v1", {"user_id": str(c), "request_id": str(uuid.uuid4()),
                                                     "requested_at": env.now.isoformat()}, "identity-consent")
    st = await env.state(d, rid)
    assert st["status"] == "in_progress" and st["next_speaker"] == "B"
    st = await env.room(d, rid, "leave")
    assert st["status"] == "abandoned"
    await env.drain()
    [done] = await env.events("lesson.pair.completed.v1")
    assert [p["user_id"] for p in done.payload["participants"]] == [str(d)]  # удалённого нет в событии
    assert [r["user_id"] for r in env.assessment.requests] == []  # d молчал; c удалён — не оценивается


async def test_deletion_checked_after_lock_parallel_commands_do_not_resurrect(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    env.friends(a, b)
    waiting = await env.invite(b, a)
    await env.room(a, waiting["room_id"], "accept")
    ds = await env.duel_set(a, b)
    c = uuid.uuid4()
    env.friends(a, c)
    tasks: list[asyncio.Task[Any]] = []
    try:
        async with env.runtime.transaction() as db:
            await users.delete_user_data(db, a, uuid.uuid4(), None, now=env.now, settings=env.settings)
            tasks = [
                asyncio.create_task(env.c.post("/internal/v1/me/pair-rooms", json={
                    "partner_member_id": env.mid(c), "pair_id": "ru-en", "scenario_id": "sc-cafe-coffee",
                    "start": "now"}, headers={**env.h(a), "Idempotency-Key": "race-invite-1"})),
                asyncio.create_task(env.c.post("/internal/v1/me/duel-sessions", json={"duel_id": ds["duel_id"]},
                                               headers={**env.h(a), "Idempotency-Key": "race-duel-01"})),
                asyncio.create_task(env.c.post(f"/internal/v1/me/pair-rooms/{waiting['room_id']}/join",
                                               headers=env.h(a))),
            ]
            await asyncio.sleep(0.6)
            assert not any(t.done() for t in tasks), "должны ждать блокировку саги"
    finally:
        results = await asyncio.gather(*tasks, return_exceptions=True)
    assert [r.status_code for r in results] == [410, 410, 410], [r.text for r in results]
    assert await env.sql("SELECT count(*) FROM room_participants WHERE user_id = :u", u=a) == [(0,)]
    assert await env.sql("SELECT count(*) FROM sessions WHERE user_id = :u", u=a) == [(0,)]


async def test_tick_expiry_starting_inactivity_resend_and_redaction(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    env.friends(a, b)
    room = await env.invite(a, b)
    env.now += timedelta(minutes=16)
    out = await env.tick()
    assert out["pair_rooms_tended"] == 1
    assert (await env.c.get(f"/internal/v1/me/pair-rooms/{room['room_id']}", headers=env.h(b))).json()[
        "status"] == "expired"
    # запланированная: вход раньше чем за 5 минут — нельзя; «скоро начнётся» — один раз обоим
    start = env.now + timedelta(hours=2)
    planned = await env.invite(a, b, start=start.isoformat().replace("+00:00", "Z"))
    assert planned["respond_until"].startswith((start + timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M"))
    await env.room(b, planned["room_id"], "accept")
    r = await env.room(a, planned["room_id"], "join", expect=409)
    assert r["code"] == "ROOM_NOT_ACTIVE" and r["details"]["start_at"]
    env.now = start - timedelta(minutes=4)
    assert (await env.tick())["pair_starting_sent"] == 1
    assert (await env.tick())["pair_starting_sent"] == 0
    [starting] = await env.events("lesson.pair.starting.v1")
    assert sorted(starting.payload["user_ids"]) == sorted([str(a), str(b)])
    await env.room(a, planned["room_id"], "join")
    env.now = start + timedelta(minutes=16)  # второй так и не вошёл
    await env.tick()
    assert (await env.c.get(f"/internal/v1/me/pair-rooms/{planned['room_id']}", headers=env.h(a))).json()[
        "status"] == "expired"
    # неактивность 10 минут (на связи, но без ходов) — завершение
    rid = await env.started_room(a, b)
    await env.turn(a, rid, {"text": "Hello!"})
    for _ in range(33):
        env.now += timedelta(seconds=20)
        r1 = await env.c.post(f"/internal/v1/me/pair-rooms/{rid}/heartbeat", headers=env.h(a))
        if r1.status_code == 409:
            break
        await env.beat(rid, b)
    st = await env.state(a, rid)
    assert st["status"] == "abandoned"
    await env.drain()
    [done] = [e for e in await env.events("lesson.pair.completed.v1") if e.payload["room_id"] == rid]
    assert done.payload["end_reason"] == "inactivity"
    # оценка не дошла (assessment недоступен) — повтор tick-ом
    c, d = uuid.uuid4(), uuid.uuid4()
    env.assessment.mode = "down"
    rid2 = await _finished_room(env, c, d)
    rows = await env.sql("SELECT evaluation_status FROM room_participants WHERE room_id = :r", r=uuid.UUID(rid2))
    assert {x for (x,) in rows} == {"pending"}
    env.assessment.mode = "ok"
    out = await env.tick()
    assert out["pair_evaluations_sent"] == 2
    rep = (await env.c.get(f"/internal/v1/me/pair-rooms/{rid2}/report", headers=env.h(c))).json()
    assert rep["me"]["evaluation_id"]
    # срок хранения текстов: реплики комнаты стираются
    env.now += timedelta(days=91)
    out = await env.tick()
    assert out["redacted_room_texts"] > 0
    rep = (await env.c.get(f"/internal/v1/me/pair-rooms/{rid2}/report", headers=env.h(c))).json()
    assert rep["me"]["lines"] == [] and rep["me"]["turns"] == 2
    assert out["pair_evaluations_given_up"] == 0
