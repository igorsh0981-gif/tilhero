"""Исправления по независимому ревью бэкенда спринта 7 (lessons) — по тесту на пункт."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import timedelta
from typing import Any

import pytest
from conftest import Env

from tilhero_lessons.domain import pair, users
from tilhero_lessons.domain.pair import RoomHub


async def _social_rows(env: Env, user: uuid.UUID) -> dict[str, int]:
    out = {}
    for table, cond in (("community_members", "user_id = :u"), ("social_blocks", "blocker = :u OR blocked = :u"),
                        ("social_sanctions", "user_id = :u"), ("learner_profiles", "user_id = :u")):
        out[table] = (await env.sql(f"SELECT count(*) FROM {table} WHERE {cond}", u=user))[0][0]  # noqa: S608
    return out


async def test_r1_social_events_after_saga_do_not_resurrect(env: Env) -> None:
    """🔴1: сага удалила A → social.block.changed.v1 (A→B), social.sanction.changed.v1 (A), social.profile.updated.v1
    (A) и профиль identity — строк с A нет. Событие во время саги ждёт её блокировку и тоже ничего не создаёт."""
    a, b = uuid.uuid4(), uuid.uuid4()
    await env.publish("user.deletion.requested.v1", {"user_id": str(a), "request_id": str(uuid.uuid4()),
                                                     "requested_at": env.now.isoformat()}, "identity-consent")
    await env.block(a, b)
    await env.block(b, a)
    await env.ban(a, None)
    await env.nickname(a, "Ghost_01")
    await env.publish("user.profile.updated.v1", {"user_id": str(a), "changed_fields": ["age_band"],
                                                  "age_band": "18+"}, "identity-consent")
    assert await _social_rows(env, a) == {"community_members": 0, "social_blocks": 0, "social_sanctions": 0,
                                          "learner_profiles": 0}
    # гонка: событие приходит, пока сага держит блокировку ученика
    c = uuid.uuid4()
    task: asyncio.Task[Any] | None = None
    try:
        async with env.runtime.transaction() as db:
            await users.delete_user_data(db, c, uuid.uuid4(), None, now=env.now, settings=env.settings)
            task = asyncio.create_task(env.block(c, b))
            await asyncio.sleep(0.4)
            assert not task.done(), "событие должно ждать блокировку саги"
    finally:
        if task is not None:
            await task
    assert await _social_rows(env, c) == {"community_members": 0, "social_blocks": 0, "social_sanctions": 0,
                                          "learner_profiles": 0}
    assert env.bus.dlq == []


async def test_r3_accept_checks_relations_synchronously(env: Env) -> None:
    """🔴3: проекций с историей до спринта 7 в lessons нет — блокировка и санкция при принятии проверяются ещё и
    синхронно через relations social (проекция могла не получить событие)."""
    a, b = uuid.uuid4(), uuid.uuid4()
    env.friends(a, b)
    room = await env.invite(a, b)
    env.social.blocks.add((a, b))  # события ещё нет — только social знает
    assert (await env.room(b, room["room_id"], "accept", expect=403))["code"] == "BLOCKED"
    env.social.blocks.clear()
    env.social.restricted[b] = None
    r = await env.room(b, room["room_id"], "accept", expect=403)
    assert r["code"] == "SOCIAL_RESTRICTED" and r["details"]["until"] is None
    env.social.restricted.clear()
    assert (await env.room(b, room["room_id"], "accept"))["status"] == "waiting"


async def _stop(env: Env, room_id: str) -> None:
    r = await env.c.post(f"/internal/v1/admin/pair-rooms/{room_id}/stop", json={"reason": "Завершение для теста"},
                         headers={**env.staff("room.manage"), "X-Step-Up": "ok"})
    assert r.status_code == 200, r.text


async def test_r8_daily_coach_limit_room_without_coach(env: Env) -> None:
    """🟡8: сверх PAIR_AI_ROOMS_PER_DAY комнат с коучем в сутки — комната без коуча (сценарий с выбором реплик)."""
    env.settings.pair_ai_rooms_per_day = 1
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    rid1 = await env.started_room(a, b)
    assert (await env.state(a, rid1))["mode"] == "free"
    await _stop(env, rid1)
    starts = len(env.ai.coach_calls())
    rid2 = await env.started_room(c, a)  # у a лимит исчерпан (у c — нет)
    st = await env.state(c, rid2)
    assert st["mode"] == "choices" and st["ai_degraded"] is True and st["options"]
    assert "mode_changed" in [e["kind"] for e in st["events"]] and len(env.ai.coach_calls()) == starts
    await _stop(env, rid2)
    env.now += timedelta(days=1)  # новые сутки (Asia/Tashkent)
    rid3 = await env.started_room(a, c)
    assert (await env.state(a, rid3))["mode"] == "free" and len(env.ai.coach_calls()) == starts + 1
    rows = await env.sql("SELECT room_id::text, coach_used FROM pair_rooms")
    assert dict(rows) == {rid1: True, rid2: False, rid3: True}
    env.settings.pair_ai_rooms_per_day = 0  # коуч в комнатах выключен
    await _stop(env, rid3)
    d, e = uuid.uuid4(), uuid.uuid4()
    rid4 = await env.started_room(d, e)
    assert (await env.state(d, rid4))["mode"] == "choices"


async def test_r10_poll_and_heartbeat_do_not_wait_for_coach(env: Env) -> None:
    """🟡10: напоминание при молчании и повтор неполученного ответа коуча — фоном: heartbeat и long-poll отвечают
    сразу, ответ коуча приходит в ленту позже."""
    a, b = uuid.uuid4(), uuid.uuid4()
    rid = await env.started_room(a, b)
    env.ai.coach_delay = 1.5
    env.now += timedelta(seconds=25)
    await env.beat(rid, a, b)
    env.now += timedelta(seconds=40)  # A молчит 65 с
    started = time.monotonic()
    await env.beat(rid, b)  # обслуживание нашло молчание — коуч в фоне
    await env.beat(rid, a)
    seq = (await env.state(b, rid))["seq"]
    assert time.monotonic() - started < 1.0
    poll = asyncio.create_task(env.state(b, rid, after=seq))
    env.settings.pair_poll_seconds = 5.0
    got = await asyncio.wait_for(poll, timeout=4)
    await env.drain()
    assert [c["context"]["trigger"] for c in env.ai.coach_calls()][-1] == "silence"
    st = await env.state(b, rid, after=seq)
    assert [e["kind"] for e in st["events"]] == ["coach"] or [e["kind"] for e in got["events"]] == ["coach"]


async def test_r10_room_hub_wait_has_no_leftovers() -> None:
    hub = RoomHub()
    room, other = uuid.uuid4(), uuid.uuid4()
    await hub.wait(room, 0.01)
    assert hub.waiting_rooms == 0  # по таймауту запись удалена
    waiters = [asyncio.create_task(hub.wait(room, 2)) for _ in range(3)]
    lone = asyncio.create_task(hub.wait(other, 0.05))
    await asyncio.sleep(0.02)
    assert hub.waiting_rooms == 2
    started = time.monotonic()
    hub.notify(room)
    await asyncio.gather(*waiters, lone)
    assert time.monotonic() - started < 1 and hub.waiting_rooms == 0


async def test_r13_tick_takes_only_due_rooms_and_limit_tends_old_room(env: Env,
                                                                     monkeypatch: pytest.MonkeyPatch) -> None:
    """🟢13: планировщик берёт только комнаты со сроком обслуживания; просроченное старое приглашение не даёт
    ROOM_LIMIT — сначала истекает."""
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    env.friends(a, b)
    env.friends(a, c)
    old = await env.invite(a, b)
    rows = await env.sql("SELECT due_at, respond_until FROM pair_rooms WHERE room_id = :r",
                         r=uuid.UUID(old["room_id"]))
    assert rows[0][0] == rows[0][1]
    calls: list[uuid.UUID] = []
    real = pair.refresh

    async def counting(rt: Any, room_id: uuid.UUID, *args: Any, **kw: Any) -> Any:
        calls.append(room_id)
        return await real(rt, room_id, *args, **kw)

    monkeypatch.setattr(pair, "refresh", counting)
    await env.tick()
    assert calls == []  # срок ещё не наступил — комнату не трогаем
    env.now += timedelta(minutes=16)
    fresh = await env.invite(a, c)  # старое приглашение истекло при проверке лимита
    assert fresh["status"] == "invited"
    assert (await env.c.get(f"/internal/v1/me/pair-rooms/{old['room_id']}", headers=env.h(a))).json()[
        "status"] == "expired"
    calls.clear()
    await env.tick()
    assert calls == []  # и у новой комнаты срок впереди
    rid = await env.started_room(b, c)
    due = (await env.sql("SELECT due_at FROM pair_rooms WHERE room_id = :r", r=uuid.UUID(rid)))[0][0]
    assert due is not None and due <= env.now + timedelta(seconds=env.settings.pair_offline_seconds)


async def test_r19_saga_removes_coach_lines_and_hints_for_deleted(env: Env) -> None:
    """🟢19: сага убирает реплики коуча, отвечающие удалённому или цитирующие его, подсказку его роли, описание роли
    и подсказки отчёта для неё; реплики и отчёт партнёра не трогаются."""
    env.ai.coach_quote = True
    c, d = uuid.uuid4(), uuid.uuid4()
    rid = await env.started_room(c, d)
    await env.turn(c, rid, {"text": "My name is Charlie Brown"})
    await env.turn(d, rid, {"text": "Nice to meet you!"})  # следующий ход — роль A (удаляемого)
    await env.publish("user.deletion.requested.v1", {"user_id": str(c), "request_id": str(uuid.uuid4()),
                                                     "requested_at": env.now.isoformat()}, "identity-consent")
    events = await env.sql("SELECT kind, side, text FROM room_events WHERE room_id = :r AND kind IN ('turn', 'coach') "
                           "ORDER BY seq", r=uuid.UUID(rid))
    texts = [t for _, _, t in events if t]
    assert not any("Charlie" in t for t in texts)
    assert ("turn", "invitee", "Nice to meet you!") in events
    assert any(k == "coach" and t and "Nice to meet you" in t for k, _, t in events)  # ответ партнёру остался
    state = (await env.sql("SELECT state FROM pair_rooms WHERE room_id = :r", r=uuid.UUID(rid)))[0][0]
    assert state.get("prompt") is None and "A" not in (state.get("roles") or {})
    assert "Charlie" not in json.dumps(state)
    st = await env.state(d, rid)
    assert st["my_role_brief"] and "Charlie" not in json.dumps(st)


async def test_r21_duel_finished_and_saga_in_parallel_no_deadlock(env: Env) -> None:
    """🟢21: итог дуэли (ученики → набор) и сага (ученик → набор) параллельно — без взаимной блокировки."""
    for _ in range(3):
        a, b = uuid.uuid4(), uuid.uuid4()
        ds = await env.duel_set(a, b)
        await env.duel_session(a, ds["duel_id"])
        await env.duel_session(b, ds["duel_id"])
        finished = {"duel_id": ds["duel_id"], "challenger_user_id": str(a), "opponent_user_id": str(b),
                    "status": "finished", "result": "draw", "technical": False, "result_version": 1,
                    "scores": {"challenger": None, "opponent": None}, "finished_at": env.now.isoformat()}
        await asyncio.wait_for(asyncio.gather(
            env.publish("game.duel.finished.v1", finished, "gamification"),
            env.publish("user.deletion.requested.v1", {"user_id": str(a), "request_id": str(uuid.uuid4()),
                                                       "requested_at": env.now.isoformat()}, "identity-consent")),
            timeout=10)
        rows = await env.sql("SELECT user_a, user_b, status FROM duel_sets WHERE duel_id = :d",
                             d=uuid.UUID(ds["duel_id"]))
        assert a not in rows[0][:2] and b in rows[0][:2] and rows[0][2] == "finished"
    assert env.bus.dlq == []


async def test_rr_sanction_recorded_when_invite_partner_deleted(env: Env) -> None:
    """Повторное ревью 🟢: санкция ученика пишется в проекцию, даже если партнёр по его приглашению удалён;
    удалённый пропускается, приглашения с живыми партнёрами отменяются."""
    a, gone, alive_partner = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    env.friends(a, gone)
    env.friends(alive_partner, a)
    await env.invite(a, gone)
    incoming = await env.invite(alive_partner, a)
    # приглашение к удалённому осталось «invited» (гонка с сагой) — партнёр в списке, но удалён
    await env.sql("INSERT INTO deleted_users (user_id, request_id) VALUES (:u, :r)", u=gone, r=uuid.uuid4())
    await env.ban(a, None)
    rows = await env.sql("SELECT kind, active FROM social_sanctions WHERE user_id = :u", u=a)
    assert rows == [("social_ban", True)]
    assert (await env.c.get(f"/internal/v1/me/pair-rooms/{incoming['room_id']}", headers=env.h(a))).json()[
        "status"] == "cancelled"
    assert env.bus.dlq == []
