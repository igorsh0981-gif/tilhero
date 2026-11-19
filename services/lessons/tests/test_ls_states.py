"""Машина состояний (AT-41, AT-42): переходы только на сервере (409 SESSION_STATE), история статусов, пауза и
продолжение, авто-пауза после 10 мин бездействия (не в active_seconds), отмена, истечение (72 ч / 24 ч) — лениво
и tick-ом; сессия по снятому с публикации уроку доигрывается; исчезнувшая версия → failed."""

from __future__ import annotations

import uuid
from datetime import timedelta

from conftest import T0, Env


async def _history(env: Env, sid: str) -> list[tuple[str | None, str, str]]:
    rows = await env.sql("SELECT from_status, to_status, reason FROM status_history WHERE session_id = :s "
                         "ORDER BY seq", s=uuid.UUID(sid))
    return [tuple(r) for r in rows]


async def test_transitions_and_invalid_409(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    sid = s["session_id"]
    for action in ("pause", "resume", "finish"):
        r = await env.c.post(f"/internal/v1/sessions/{sid}/{action}", headers=env.h(user))
        assert r.status_code == 409 and r.json()["code"] in ("SESSION_STATE", "STEP_NOT_CURRENT"), (action, r.text)
    assert (await env.c.post(f"/internal/v1/sessions/{sid}/pause", headers=env.h(user))).json()["details"] == {
        "status": "ready"}
    await env.current(user, sid)  # ready → in_progress
    await env.post(user, sid, "resume", expect=409)
    env.now += timedelta(minutes=2)
    paused = await env.post(user, sid, "pause")
    assert paused["status"] == "paused" and paused["paused_at"] == "2026-11-19T07:02:00Z"
    assert paused["expires_at"] == "2026-11-22T07:02:00Z" and paused["minutes"] == 2
    await env.post(user, sid, "pause", expect=409)
    resumed = await env.post(user, sid, "resume")
    assert resumed["status"] == "in_progress" and resumed["paused_at"] is None and resumed["expires_at"] is None
    await env.post(user, sid, "cancel")
    for action in ("pause", "resume", "cancel", "finish", "current"):
        method = env.c.get if action == "current" else env.c.post
        r = await method(f"/internal/v1/sessions/{sid}/{action}", headers=env.h(user))
        assert r.status_code == 409 and r.json()["code"] == "SESSION_STATE" and r.json()["details"]["status"] == \
            "cancelled", action
    assert await _history(env, sid) == [
        (None, "ready", "started"), ("ready", "in_progress", "started"), ("in_progress", "paused", "pause"),
        ("paused", "in_progress", "resume"), ("in_progress", "cancelled", "cancel")]
    # история статусов неизменяема (триггер)
    try:
        await env.sql("UPDATE status_history SET reason = 'fail' WHERE session_id = :s", s=uuid.UUID(sid))
        raise AssertionError("status_history must be append-only")
    except Exception as exc:
        assert "append-only" in str(exc)


async def test_auto_pause_not_counted_and_continue_same_step(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    sid = s["session_id"]
    step = await env.current(user, sid)
    env.now += timedelta(minutes=3)
    step = (await env.answer(user, sid, step, {}))["next"]  # 3 мин активности
    env.now += timedelta(minutes=45)  # бездействие → авто-пауза с момента последнего действия
    view = (await env.c.get(f"/internal/v1/sessions/{sid}", headers=env.h(user))).json()
    assert view["status"] == "paused" and view["paused_at"] == "2026-11-19T07:03:00Z" and view["minutes"] == 3
    again = await env.current(user, sid)  # повторный вход — тот же шаг, авто-продолжение
    assert again["step_id"] == step["step_id"]
    env.now += timedelta(minutes=1)
    await env.answer(user, sid, again, {})
    view = (await env.c.get(f"/internal/v1/sessions/{sid}", headers=env.h(user))).json()
    assert view["status"] == "in_progress" and view["minutes"] == 4
    reasons = [r[2] for r in await _history(env, sid)]
    assert reasons == ["started", "started", "auto_pause", "resume"]
    # явная пауза после долгого бездействия — успешна (уже на паузе с момента последнего действия)
    env.now += timedelta(minutes=30)
    paused = await env.post(user, sid, "pause")
    assert paused["status"] == "paused" and paused["paused_at"] == "2026-11-19T07:49:00Z"


async def test_answer_on_paused_session_resumes(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    sid = s["session_id"]
    step = await env.current(user, sid)
    await env.post(user, sid, "pause")
    res = await env.answer(user, sid, step, {})
    assert res["accepted"] is True
    assert (await env.c.get(f"/internal/v1/sessions/{sid}", headers=env.h(user))).json()["status"] == "in_progress"


async def test_expiry_lazy_and_tick(env: Env, user: uuid.UUID) -> None:
    # пауза > 72 ч → cancelled при следующем запросе
    s = await env.lesson(user)
    await env.current(user, s["session_id"])
    await env.post(user, s["session_id"], "pause")
    env.now += timedelta(hours=73)
    r = await env.c.get(f"/internal/v1/sessions/{s['session_id']}/current", headers=env.h(user))
    assert r.status_code == 409 and r.json()["details"]["status"] == "cancelled"
    [ev] = await env.events("lesson.session.completed.v1", user)
    assert ev.payload["status"] == "cancelled" and ev.payload["minutes"] == 0
    # ready > 24 ч и брошенная in_progress → tick
    other, third = uuid.uuid4(), uuid.uuid4()
    a = await env.lesson(other)
    b = await env.lesson(third)
    await env.current(third, b["session_id"])
    env.now += timedelta(minutes=20)
    out = await env.tick()
    assert out["auto_paused"] == 1 and out["expired"] == 0
    env.now += timedelta(hours=24)
    out = await env.tick()
    assert out["expired"] == 1  # ready > 24 ч
    env.now += timedelta(hours=49)
    out = await env.tick()
    assert out["expired"] == 1  # пауза > 72 ч (с момента последнего действия)
    assert (await env.tick())["expired"] == 0  # повтор безопасен
    for u, sid in ((other, a["session_id"]), (third, b["session_id"])):
        view = (await env.c.get(f"/internal/v1/sessions/{sid}", headers=env.h(u))).json()
        assert view["status"] == "cancelled"
        assert [x.payload["status"] for x in await env.events("lesson.session.completed.v1", u)] == ["cancelled"]
    # ученик может начать новое занятие
    await env.lesson(other)


async def test_unpublished_lesson_plays_on_fixed_version(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    sid = s["session_id"]
    await env.current(user, sid)
    payload = dict(env.catalog.payload("lesson", "l-01-greetings"))
    env.catalog.publish("lesson", "l-01-greetings", {**payload, "duration_min": 30})
    env.catalog.unpublish("lesson", "l-01-greetings")
    await env.play(user, sid)
    summary = await env.finish(user, sid)
    assert summary["status"] == "completed"
    assert env.assessment.requests[0]["content_refs"]["lesson"]["version"] == 1
    # новые старты — недоступны
    await env.lesson(user, expect=404)


async def test_missing_version_fails_session(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    env.catalog.drop_version("lesson", "l-01-greetings", 1)
    env.app.state.catalog._versions.clear()
    r = await env.c.get(f"/internal/v1/sessions/{s['session_id']}/current", headers=env.h(user))
    assert r.status_code == 409 and r.json()["details"] == {"status": "failed", "reason": "content_unavailable"}
    [ev] = await env.events("lesson.session.completed.v1", user)
    assert ev.payload["status"] == "failed"
    reasons = [x[2] for x in await _history(env, s["session_id"])]
    assert reasons[-1] == "content_unpublished"


async def test_catalog_down_mid_session_is_retryable(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    env.app.state.catalog._versions.clear()
    env.catalog.down = True
    r = await env.c.get(f"/internal/v1/sessions/{s['session_id']}/current", headers=env.h(user))
    assert r.status_code == 503 and r.json()["code"] == "CATALOG_UNAVAILABLE"
    env.catalog.down = False
    assert (await env.current(user, s["session_id"]))["type"] == "notice"


async def test_minutes_capped_by_double_duration(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    sid = s["session_id"]
    env.step_seconds = 9 * 60  # каждый шаг почти 10 минут
    await env.play(user, sid)
    summary = await env.finish(user, sid)
    assert summary["minutes"] == 40
    assert T0 < env.now
