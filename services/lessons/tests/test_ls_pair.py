"""Парный урок (INTERNAL_API спринта 7 §3.2, AT-76): приглашение → оба в комнате → коуч даёт роли, ходы по очереди →
у каждого свои секунды речи, доказательства и отчёт; молчавший без оценки; переподключение без второй сессии;
long-poll; повтор хода; гонки."""

from __future__ import annotations

import asyncio
import time
import uuid
from datetime import timedelta
from typing import Any

from conftest import Env


async def _room_row(env: Env, room_id: str, side: str) -> dict[str, Any]:
    rows = await env.sql("SELECT user_id, role, turns, speaking_seconds, active_seconds, minutes, contributed, "
                         "evaluation_status, evaluation_id, session_id FROM room_participants "
                         "WHERE room_id = :r AND side = :s", r=uuid.UUID(room_id), s=side)
    keys = ("user_id", "role", "turns", "speaking_seconds", "active_seconds", "minutes", "contributed",
            "evaluation_status", "evaluation_id", "session_id")
    return dict(zip(keys, rows[0], strict=True))


async def test_two_participants_take_turns_with_ai_coach(env: Env) -> None:
    a, b, stranger = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    env.friends(a, b)
    await env.nickname(a, "Aziz_01")
    room = await env.invite(a, b, key="invite-key-0001")
    rid = room["room_id"]
    assert room["status"] == "invited" and room["side"] == "inviter" and room["mode"] == "free"
    assert room["partner"] == {"member_id": env.mid(b), "nickname": None, "hero": None}
    assert room["can_accept"] is False and room["respond_until"] is not None
    assert (await env.invite(a, b, key="invite-key-0001", expect=200))["room_id"] == rid  # повтор ключа
    reused = await env.invite(a, b, key="invite-key-0001", scenario="sc-market-prices", expect=422)
    assert reused["code"] == "IDEMPOTENCY_KEY_REUSED"
    limit = await env.invite(a, b, expect=409)  # ≤ 1 активной комнаты
    assert limit["code"] == "ROOM_LIMIT" and limit["details"]["room_id"] == rid
    [invited] = await env.events("lesson.pair.invited.v1")
    assert invited.payload["inviter_nickname"] == "Aziz_01" and invited.payload["invitee_user_id"] == str(b)
    listed = (await env.c.get("/internal/v1/me/pair-rooms", headers=env.h(b))).json()["items"]
    assert [x["room_id"] for x in listed] == [rid] and listed[0]["can_accept"] is True
    assert listed[0]["partner"]["nickname"] == "Aziz_01" and listed[0]["side"] == "invitee"
    # чужой — 404; принять может только приглашённый
    for path in ("", "/state", "/report"):
        r = await env.c.get(f"/internal/v1/me/pair-rooms/{rid}{path}", headers=env.h(stranger))
        assert r.status_code == 404 and r.json()["code"] == "ROOM_NOT_FOUND", path
    await env.room(stranger, rid, "join", expect=404)
    assert (await env.room(a, rid, "accept", expect=409))["code"] == "ROOM_STATE"
    await env.room(a, rid, "join", expect=409)  # до принятия — нет
    assert (await env.room(b, rid, "accept"))["status"] == "waiting"
    assert (await env.room(b, rid, "accept"))["status"] == "waiting"  # повтор — тот же исход

    st_a = await env.room(a, rid, "join")
    assert st_a["status"] == "waiting" and env.ai.coach_calls() == []
    st_b = await env.room(b, rid, "join")
    assert st_b["status"] == "in_progress" and st_b["my_role"] == "B" and st_b["next_speaker"] == "A"
    assert st_b["my_role_brief"] == "You are a friend who pays." and st_b["team_goal"]
    assert [e["kind"] for e in st_b["events"]] == ["joined", "joined", "roles", "coach"]
    [start] = env.ai.coach_calls()
    assert start["context"]["trigger"] == "start" and start["session_kind"] == "pair"
    assert start["session_id"] == rid and start["audience"] == "adults"
    # коуч не видит user_id, ников и member_id
    flat = str(start["context"])
    assert str(a) not in flat and str(b) not in flat and "Aziz" not in flat and env.mid(a) not in flat

    nyt = await env.turn(b, rid, {"text": "Hi!"}, expect=409)
    assert nyt["code"] == "NOT_YOUR_TURN"
    env.now += timedelta(seconds=12)
    st = await env.turn(a, rid, {"text": "Two coffees, please."}, key="turn-key-a-0001")
    assert st["next_speaker"] == "B" and st["my_speaking_seconds"] == 12
    assert [e["kind"] for e in st["events"]] == ["turn", "coach"] and st["events"][0]["role"] == "A"
    # повтор с тем же ключом — тот же ответ, без второго хода; тот же ключ с другим текстом — 422
    again = await env.turn(a, rid, {"text": "Two coffees, please."}, key="turn-key-a-0001")
    assert again["events"] == st["events"] and (await _room_row(env, rid, "inviter"))["turns"] == 1
    assert (await env.turn(a, rid, {"text": "Other"}, key="turn-key-a-0001", expect=422))["code"] == \
        "IDEMPOTENCY_KEY_REUSED"
    assert (await env.turn(a, rid, {"text": "Again"}, expect=409))["code"] == "NOT_YOUR_TURN"
    bad = await env.c.post(f"/internal/v1/me/pair-rooms/{rid}/turns", json={"text": "x", "choice_id": "c1"},
                           headers={**env.h(b), "Idempotency-Key": "turn-key-b-bad1"})
    assert bad.status_code == 422
    no_key = await env.c.post(f"/internal/v1/me/pair-rooms/{rid}/turns", json={"text": "x"}, headers=env.h(b))
    assert no_key.status_code == 400 and no_key.json()["code"] == "IDEMPOTENCY_KEY_REQUIRED"

    env.now += timedelta(seconds=90)
    await env.beat(rid, a)  # b без heartbeat 90 с — но его ход сам по себе — признак присутствия
    st = await env.turn(b, rid, {"text": "I will pay for you."})
    assert st["next_speaker"] == "A" and st["my_speaking_seconds"] == 60  # ≤ 60 с на ход без голоса
    await env.turn(a, rid, {"text": "Thank you very much!"})
    st = await env.turn(b, rid, {"text": "You are welcome."})
    assert st["status"] == "finished" and st["next_speaker"] is None
    await env.drain()

    [done] = await env.events("lesson.pair.completed.v1")
    p = done.payload
    assert p["status"] == "finished" and p["end_reason"] == "completed" and p["team_goal_reached"] is True
    assert sorted((x["role"], x["contributed"], x["turns"]) for x in p["participants"]) == [("A", True, 2),
                                                                                         ("B", True, 2)]
    sessions = [e.payload for e in await env.events("lesson.session.completed.v1") if e.payload["kind"] == "pair"]
    assert {(s["user_id"], s["session_id"]) for s in sessions} == {
        (str(a), str(uuid.uuid5(uuid.UUID(rid), str(a)))), (str(b), str(uuid.uuid5(uuid.UUID(rid), str(b))))}
    assert all(s["room_id"] == rid and s["practice_only"] is False for s in sessions)
    # независимая оценка — у каждого своя: свои реплики и реплики коуча, чужих нет
    reqs = {r["user_id"]: r for r in env.assessment.requests}
    assert set(reqs) == {str(a), str(b)}
    for user, other_text in ((a, "I will pay for you."), (b, "Two coffees, please.")):
        req = reqs[str(user)]
        assert req["kind"] == "scenario" and req["session_id"] == str(uuid.uuid5(uuid.UUID(rid), str(user)))
        texts = [t["text"] for t in req["turns"]]
        assert other_text not in texts and any(t["speaker"] == "learner" for t in req["turns"])
        assert req["content_refs"]["scenario"]["key"] == "sc-cafe-coffee" and req["content_refs"]["rubric"]
    assert set(env.assessment.subjects[-2:]) == {str(a), str(b)}

    rep_a = (await env.c.get(f"/internal/v1/me/pair-rooms/{rid}/report", headers=env.h(a))).json()
    assert [x["text"] for x in rep_a["me"]["lines"]] == ["Two coffees, please.", "Thank you very much!"]
    assert rep_a["me"]["role"] == "A" and rep_a["me"]["contributed"] is True and rep_a["me"]["evaluation_id"]
    assert rep_a["me"]["tips"] == [{"ru": "Подсказка для A", "uz": "A uchun maslahat"}]
    assert rep_a["team"]["goal_reached"] is True and rep_a["team"]["summary"]["ru"]
    assert [s["skill_id"] for s in rep_a["me"]["skills"]] == ["en.func.order-food"]
    view = (await env.c.get(f"/internal/v1/me/pair-rooms/{rid}", headers=env.h(a))).json()
    assert view["report_available"] is True and view["minutes"] >= 1
    assert (await env.c.get("/internal/v1/me/pair-rooms", params={"status": "finished"},
                            headers=env.h(a))).json()["items"][0]["room_id"] == rid
    # после завершения — новая комната возможна (слот освобождён)
    await env.invite(a, b)


async def test_silent_participant_gets_no_evaluation_and_partner_finishes_solo(env: Env) -> None:
    """Молчавший (turns = 0) — без оценки, отчёт «не участвовал»; чужая реплика не засчитывается молчащему; вышел и
    не вернулся за 3 минуты — оставшийся доигрывает соло (abandoned, participant_left)."""
    a, b = uuid.uuid4(), uuid.uuid4()
    rid = await env.started_room(a, b)
    env.ai.mode["cooperative_lesson_coach"] = "steal_evidence"  # коуч приписал реплику A роли B
    st = await env.turn(a, rid, {"text": "Hello, two teas please."})
    assert st["next_speaker"] == "B"
    assert (await _room_row(env, rid, "invitee"))["turns"] == 0
    rows = await env.sql("SELECT evidence FROM room_participants WHERE room_id = :r", r=uuid.UUID(rid))
    assert all(ev == [] for (ev,) in rows)  # чужое доказательство отброшено
    env.ai.mode["cooperative_lesson_coach"] = "ok"
    left = await env.room(b, rid, "leave")
    assert left["status"] == "paused"  # ушёл в свой ход
    env.now += timedelta(minutes=2)
    await env.beat(rid, a)
    st = await env.state(a, rid)
    assert st["status"] == "paused"  # 3 минуты ещё не прошли
    env.now += timedelta(minutes=2)
    await env.beat(rid, a)
    st = await env.state(a, rid)
    assert st["status"] == "in_progress" and st["next_speaker"] == "A"  # соло
    assert (await env.room(b, rid, "join", expect=409))["details"]["status"] == "abandoned"
    for text in ("Thank you!", "Bye!", "See you!"):
        st = await env.turn(a, rid, {"text": text})
        if st["status"] != "in_progress":
            break
        assert st["next_speaker"] == "A"
    assert st["status"] == "abandoned"
    await env.drain()
    [done] = await env.events("lesson.pair.completed.v1")
    assert done.payload["end_reason"] == "participant_left"
    roles = {x["role"]: x for x in done.payload["participants"]}
    assert roles["B"]["contributed"] is False and roles["B"]["turns"] == 0 and roles["A"]["contributed"] is True
    assert [r["user_id"] for r in env.assessment.requests] == [str(a)]  # молчавший не оценивается
    rep_b = (await env.c.get(f"/internal/v1/me/pair-rooms/{rid}/report", headers=env.h(b))).json()
    assert rep_b["me"]["contributed"] is False and rep_b["me"]["lines"] == [] and rep_b["me"]["tips"] == []
    assert rep_b["me"]["evaluation_id"] is None and rep_b["me"]["skills"] == []
    assert (await _room_row(env, rid, "invitee"))["evaluation_status"] == "none"


async def test_reconnect_keeps_session_and_does_not_double_minutes(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    rid = await env.started_room(a, b)
    t0 = env.now
    await env.pass_time(rid, 60, a, b)  # heartbeat каждые 20 с
    assert (await env.room(a, rid, "leave"))["status"] == "paused"  # ход A
    await env.pass_time(rid, 60, b)
    st = await env.room(a, rid, "join")
    assert st["status"] == "in_progress" and st["my_role"] == "A"
    await env.room(a, rid, "join")  # повторный вход — ничего не удваивает
    joined = [e for e in st["events"] if e["kind"] == "joined" and e["role"] is None]
    assert len(joined) == 2  # «joined» — только первый вход каждого
    await env.pass_time(rid, 60, a, b)
    assert env.now == t0 + timedelta(seconds=180)
    # оба пропали: offline с последнего heartbeat, через 3 минуты — завершение
    env.now = t0 + timedelta(seconds=480)
    st = await env.state(b, rid)
    assert st["status"] == "abandoned"
    for side in ("inviter", "invitee"):
        row = await _room_row(env, rid, side)
        assert row["active_seconds"] == 120 and row["minutes"] == 2, (side, row)
    sessions = [e.payload for e in await env.events("lesson.session.completed.v1") if e.payload["kind"] == "pair"]
    assert sorted(s["user_id"] for s in sessions) == sorted([str(a), str(b)])  # одна сессия на участника
    assert {s["minutes"] for s in sessions} == {2}


async def test_long_poll_returns_events_after_seq(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    rid = await env.started_room(a, b)
    first = await env.state(a, rid)
    seq = first["seq"]
    assert [e["seq"] for e in first["events"]] == list(range(1, seq + 1))
    assert [e["seq"] for e in (await env.state(a, rid, after=seq - 1))["events"]] == [seq]
    started = time.monotonic()
    idle = await env.state(a, rid, after=seq)
    assert idle["events"] == [] and idle["seq"] == seq and time.monotonic() - started >= 0.5  # ждали
    env.settings.pair_poll_seconds = 5.0
    poll = asyncio.create_task(env.state(b, rid, after=seq))
    await asyncio.sleep(0.2)
    assert not poll.done()
    started = time.monotonic()
    await env.turn(a, rid, {"text": "Hello!"})
    got = await asyncio.wait_for(poll, timeout=3)
    assert time.monotonic() - started < 3
    assert got["events"] and all(e["seq"] > seq for e in got["events"])
    assert got["events"][0]["kind"] == "turn" and got["events"][0]["text"] == "Hello!"
    assert got["seq"] >= got["events"][-1]["seq"]


async def test_races_parallel_turns_and_joins(env: Env) -> None:
    """Два одновременных хода — один принят (второй NOT_YOUR_TURN); повтор с тем же ключом одновременно — один ход;
    одновременный вход обоих — один старт коуча."""
    a, b = uuid.uuid4(), uuid.uuid4()
    env.friends(a, b)
    room = await env.invite(a, b)
    rid = room["room_id"]
    await env.room(b, rid, "accept")
    results = await asyncio.gather(env.room(a, rid, "join"), env.room(b, rid, "join"))
    assert {r["status"] for r in results} <= {"waiting", "in_progress"}
    assert len([c for c in env.ai.coach_calls() if c["context"]["trigger"] == "start"]) == 1
    assert (await env.state(a, rid))["next_speaker"] == "A"
    responses = await asyncio.gather(*(env.c.post(
        f"/internal/v1/me/pair-rooms/{rid}/turns", json={"text": f"Hello {i}"},
        headers={**env.h(a), "Idempotency-Key": f"race-key-{i:04d}"}) for i in range(2)))
    codes = sorted(r.status_code for r in responses)
    assert codes == [200, 409] and [r.json()["code"] for r in responses if r.status_code == 409] == ["NOT_YOUR_TURN"]
    same = await asyncio.gather(*(env.c.post(
        f"/internal/v1/me/pair-rooms/{rid}/turns", json={"text": "Same"},
        headers={**env.h(b), "Idempotency-Key": "race-same-key-1"}) for _ in range(2)))
    assert [r.status_code for r in same] == [200, 200]
    assert (await _room_row(env, rid, "invitee"))["turns"] == 1


async def test_time_limit_wrap_up_and_silence(env: Env) -> None:
    """20 минут в in_progress: за 2 минуты — trigger wrap_up, по истечении — completed с текущим прогрессом
    (цель не достигнута); молчание дольше 60 с в свой ход — коуч (trigger silence), один раз за ход."""
    env.ai.coach_step = 0.1
    a, b = uuid.uuid4(), uuid.uuid4()
    rid = await env.started_room(a, b)
    await env.pass_time(rid, 70, a, b)
    await env.state(b, rid)
    await env.drain()  # напоминание коуча при молчании — фоновая задача
    silence = [c for c in env.ai.coach_calls() if c["context"]["trigger"] == "silence"]
    assert len(silence) == 1 and silence[0]["user_id"] == str(a)
    await env.state(b, rid)
    assert len([c for c in env.ai.coach_calls() if c["context"]["trigger"] == "silence"]) == 1
    for minute in range(1, 18):
        await env.pass_time(rid, 60, a, b)
        if minute % 5 == 0:
            st = await env.state(a, rid)
            await env.turn(a if st["next_speaker"] == "A" else b, rid, {"text": f"Line {minute}"})
    await env.pass_time(rid, 50, a, b)
    st = await env.state(a, rid)
    await env.turn(a if st["next_speaker"] in ("A", "both") else b, rid, {"text": "Almost done"})
    assert [c["context"]["trigger"] for c in env.ai.coach_calls()][-1] == "wrap_up"
    assert env.ai.coach_calls()[-1]["context"]["remaining_minutes"] <= 2
    for _ in range(10):  # heartbeat до конца времени комнаты (после — 409 ROOM_NOT_ACTIVE)
        env.now += timedelta(seconds=20)
        r = await env.c.post(f"/internal/v1/me/pair-rooms/{rid}/heartbeat", headers=env.h(a))
        if r.status_code == 409:
            break
        await env.beat(rid, b)
    st = await env.state(a, rid)
    assert st["status"] == "finished"
    [done] = await env.events("lesson.pair.completed.v1")
    assert done.payload["end_reason"] == "completed" and done.payload["team_goal_reached"] is False
    rep = (await env.c.get(f"/internal/v1/me/pair-rooms/{rid}/report", headers=env.h(a))).json()
    assert 0 < rep["team"]["progress"] < 1 and rep["team"]["goal_reached"] is False


async def test_escalation_pauses_and_join_resumes(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    rid = await env.started_room(a, b)
    env.ai.mode["cooperative_lesson_coach"] = "escalate"
    st = await env.turn(a, rid, {"text": "You are stupid"})
    assert st["status"] == "paused"
    assert (await env.turn(b, rid, {"text": "Hey"}, expect=409))["code"] == "ROOM_NOT_ACTIVE"
    env.ai.mode["cooperative_lesson_coach"] = "ok"
    st = await env.room(b, rid, "join")
    assert st["status"] == "in_progress" and st["next_speaker"] == "B"
