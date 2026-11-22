"""Задания дуэли (INTERNAL_API спринта 7 §3.1, duel_host): набор на двоих, одна сессия на участника, оценка по ключу,
повтор ответа — один результат, DUEL_CLOSED после срока, ключи и разбор — только после game.duel.finished.v1."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from conftest import Env
from ls_testkit import SEED_DATA, correct_answer, wrong_answer

from tilhero_common.testing import internal_headers
from tilhero_lessons.domain import duels


async def _publish_finished(env: Env, duel_id: str, a: uuid.UUID, b: uuid.UUID, *, version: int = 1,
                            producer: str = "gamification") -> None:
    await env.publish("game.duel.finished.v1", {
        "duel_id": duel_id, "challenger_user_id": str(a), "opponent_user_id": str(b), "status": "finished",
        "result": "challenger", "technical": False, "result_version": version,
        "scores": {"challenger": {"correct": 10, "total": 10}, "opponent": None},
        "finished_at": env.now.isoformat()}, producer)


async def _play(env: Env, user: uuid.UUID, sid: str, *, wrong: int = 0, stop_after: int | None = None
                ) -> list[dict[str, Any]]:
    """Отвечает на задания (первые `wrong` — неверно) до done или stop_after ответов; → показанные шаги."""
    step = await env.current(user, sid)
    shown = [step]
    answered = 0
    while step["type"] == "item" and (stop_after is None or answered < stop_after):
        assert step["hint_available"] is False and step["graded_later"] is True
        body = {"answer": wrong_answer(step["item"]) if answered < wrong else correct_answer(step["item"])}
        env.now += timedelta(seconds=20)
        res = await env.answer(user, sid, step, body)
        assert res["feedback"] is None
        answered += 1
        step = res["next"]
        shown.append(step)
    return shown


async def test_one_set_for_both_one_session_each_and_server_scoring(env: Env) -> None:
    a, b, stranger = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    duel_id = uuid.uuid4()
    ds = await env.duel_set(a, b, duel_id=duel_id)
    assert ds["items_total"] == 10 and set(ds) == {"set_id", "duel_id", "pair_id", "level_band", "items_total",
                                                   "play_deadline"}
    # повтор — тот же набор; другие участники — конфликт; вызывающий — только gamification
    again = await env.duel_set(b, a, duel_id=duel_id, expect=200)
    assert again["set_id"] == ds["set_id"]
    conflict = await env.duel_set(a, stranger, duel_id=duel_id, expect=409)
    assert conflict["code"] == "DUEL_SET_CONFLICT"
    denied = await env.duel_set(a, b, issuer="telegram-bff", expect=403)
    assert denied["code"] == "CALLER_NOT_ALLOWED"
    r = await env.c.post("/internal/v1/duel-sets", json={"duel_id": str(uuid.uuid4())})
    assert r.status_code == 401
    bad = await env.duel_set(a, a, expect=422)
    assert bad["code"] == "VALIDATION_ERROR"

    sa = await env.duel_session(a, str(duel_id), key="duel-key-a-1")
    assert sa["kind"] == "duel" and sa["status"] == "ready" and sa["expires_at"] is None
    assert (await env.duel_session(a, str(duel_id), key="duel-key-a-2", expect=200))["session_id"] == sa["session_id"]
    assert (await env.duel_session(a, str(duel_id), key="duel-key-a-1", expect=200))["session_id"] == sa["session_id"]
    nf = await env.duel_session(stranger, str(duel_id), expect=404)
    assert nf["code"] == "DUEL_NOT_FOUND"
    sb = await env.duel_session(b, str(duel_id))
    assert sb["session_id"] != sa["session_id"]

    # сессия дуэли вне правила одной активной сессии: урок стартует, active и история дуэль не показывают
    lesson = await env.lesson(a)
    active = (await env.c.get("/internal/v1/sessions/active", headers=env.h(a))).json()["session"]
    assert active["session_id"] == lesson["session_id"]
    history = (await env.c.get("/internal/v1/sessions", headers=env.h(a))).json()["items"]
    assert [h["kind"] for h in history] == ["lesson"]

    shown_a = await _play(env, a, sa["session_id"], wrong=3)
    shown_b = await _play(env, b, sb["session_id"], stop_after=4)
    # одинаковые задания и одинаковый порядок вариантов у обоих участников
    items_a = [s["item"] for s in shown_a if s["type"] == "item"]
    items_b = [s["item"] for s in shown_b if s["type"] == "item"]
    assert len(items_a) == 10 and items_a[:5] == items_b[:5]
    # подсказок нет
    r = await env.c.post(f"/internal/v1/sessions/{sb['session_id']}/steps/{shown_b[-1]['step_id']}/hint",
                         headers=env.h(b))
    assert r.status_code == 409 and r.json()["code"] == "HINTS_NOT_ALLOWED"
    # повтор ответа — тот же результат; другой ответ на отвеченный шаг — 409
    first = shown_a[0]
    replay = await env.answer(a, sa["session_id"], first, {"answer": wrong_answer(first["item"])})
    assert replay["next"]["step_id"] == shown_a[1]["step_id"]
    r = await env.c.post(f"/internal/v1/sessions/{sa['session_id']}/steps/{first['step_id']}",
                         json={"answer": correct_answer(first["item"])}, headers=env.h(a))
    assert r.status_code == 409 and r.json()["code"] == "STEP_NOT_CURRENT"
    # отмена дуэли — нельзя
    r = await env.c.post(f"/internal/v1/sessions/{sa['session_id']}/cancel", headers=env.h(a))
    assert r.status_code == 409 and r.json()["code"] == "SESSION_STATE"

    summary = await env.finish(a, sa["session_id"])
    assert summary["evaluation"] is None and summary["skills"] == [] and summary["can_review"] is False
    assert summary["next_lesson"] is None
    assert (await env.finish(a, sa["session_id"]))["session_id"] == sa["session_id"]  # повтор — тот же итог
    assert not [x for x in env.assessment.requests if x["session_id"] in (sa["session_id"], sb["session_id"])]

    [started] = [e for e in await env.events("lesson.session.started.v1", a) if e.payload["kind"] == "duel"]
    assert started.payload["duel_id"] == str(duel_id)
    [done] = [e for e in await env.events("lesson.session.completed.v1", a) if e.payload["kind"] == "duel"]
    assert done.payload["score"] == {"correct": 7, "total": 10} and done.payload["practice_only"] is True
    assert done.payload["duel_id"] == str(duel_id) and done.payload["evaluation_id"] is None

    # разбор — только после завершения дуэли; ключей в сессии нет
    r = await env.c.get(f"/internal/v1/me/duel-sessions/{sa['session_id']}/review", headers=env.h(a))
    assert r.status_code == 409 and r.json()["code"] == "DUEL_NOT_FINISHED"
    r = await env.c.get(f"/internal/v1/me/duel-sessions/{sa['session_id']}/review", headers=env.h(b))
    assert r.status_code == 404  # чужая сессия
    await _publish_finished(env, str(duel_id), a, b, producer="social")  # чужой издатель — игнор
    r = await env.c.get(f"/internal/v1/me/duel-sessions/{sa['session_id']}/review", headers=env.h(a))
    assert r.status_code == 409
    await _publish_finished(env, str(duel_id), a, b)
    review = (await env.c.get(f"/internal/v1/me/duel-sessions/{sa['session_id']}/review", headers=env.h(a))).json()
    assert review["score"] == {"correct": 7, "total": 10} and len(review["items"]) == 10
    assert sum(1 for i in review["items"] if not i["correct"]) == 3
    assert all(i["correct_answer"] for i in review["items"])
    # незаконченная сессия b закрыта итогом дуэли: неотвеченные — неверные
    [done_b] = [e for e in await env.events("lesson.session.completed.v1", b) if e.payload["kind"] == "duel"]
    assert done_b.payload["score"] == {"correct": 4, "total": 10} and done_b.payload["status"] == "completed"
    review_b = (await env.c.get(f"/internal/v1/me/duel-sessions/{sb['session_id']}/review", headers=env.h(b))).json()
    assert [i["your_answer"] is None for i in review_b["items"]].count(True) == 6
    # повтор события и переоценка не создают новых событий сессий
    await _publish_finished(env, str(duel_id), a, b, version=2)
    assert len([e for e in await env.events("lesson.session.completed.v1") if e.payload["kind"] == "duel"]) == 2


async def test_duel_closed_after_deadline_and_tick(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    deadline = env.now + timedelta(hours=1)
    ds = await env.duel_set(a, b, play_deadline=deadline.isoformat())
    assert ds["play_deadline"].startswith(deadline.strftime("%Y-%m-%dT%H:%M"))
    sa = await env.duel_session(a, ds["duel_id"])
    await env.duel_session(b, ds["duel_id"])  # не открывал до срока (ready)
    shown = await _play(env, a, sa["session_id"], stop_after=2)
    env.now = deadline + timedelta(minutes=1)
    r = await env.c.post(f"/internal/v1/sessions/{sa['session_id']}/steps/{shown[-1]['step_id']}",
                         json={"answer": correct_answer(shown[-1]["item"])}, headers=env.h(a))
    assert r.status_code == 409 and r.json()["code"] == "DUEL_CLOSED"
    r = await env.c.get(f"/internal/v1/sessions/{sa['session_id']}/current", headers=env.h(a))
    assert r.status_code == 409 and r.json()["code"] == "DUEL_CLOSED"
    [done] = [e for e in await env.events("lesson.session.completed.v1", a) if e.payload["kind"] == "duel"]
    assert done.payload["score"] == {"correct": 2, "total": 10}
    c = uuid.uuid4()
    ds2 = await env.duel_set(a, c, play_deadline=(env.now - timedelta(seconds=1)).isoformat())
    late = await env.duel_session(c, ds2["duel_id"], expect=409)
    assert late["code"] == "DUEL_CLOSED"
    out = await env.tick()
    assert out["duel_sets_closed"] == 2 and out["duel_sessions_closed"] == 1
    [done_b] = [e for e in await env.events("lesson.session.completed.v1", b) if e.payload["kind"] == "duel"]
    assert done_b.payload["score"] == {"correct": 0, "total": 10}
    assert (await env.tick())["duel_sets_closed"] == 0  # повтор безопасен
    # finish после срока — итог закрытой сессии
    assert (await env.finish(a, sa["session_id"]))["status"] == "completed"


async def test_duel_set_is_deterministic_balanced_and_age_safe(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    pool = [{"lesson_id": f"l{i}", "version": 1, "skill_id": f"s{i % 4}",
             "item": {"item_id": f"i{i}", "type": "single_choice"}} for i in range(40)]
    seed = "x" * 64
    first = duels.pick(seed, pool, 10)
    assert first == duels.pick(seed, list(reversed(pool)), 10)
    counts: dict[str, int] = {}
    for p in first:
        counts[p["skill_id"]] = counts.get(p["skill_id"], 0) + 1
    assert sorted(counts.values()) == [2, 2, 3, 3]  # по навыкам — поровну (± 1)
    # ребёнок (по проекции) — только задания детских уроков; взрослые — уроки для обоих
    await env.publish("user.profile.created.v1", {"user_id": str(a), "kind": "child", "age_band": "6-9",
                                                  "created_at": env.now.isoformat()}, "identity-consent")
    ds = await env.duel_set(a, b)
    rows = await env.sql("SELECT audience, items FROM duel_sets WHERE set_id = :s", s=uuid.UUID(ds["set_id"]))
    audience, items = rows[0]
    assert audience == "kids"
    kids_lessons = {k for k, v in SEED_DATA["lesson"].items() if "kids" in v["audience"]}
    assert {i["lesson_id"] for i in items} <= kids_lessons
    assert all(i["item"]["type"] in duels.GRADABLE for i in items)
    # каталог недоступен — 503 DUEL_SET_UNAVAILABLE (gamification оставит дуэль challenged)
    env.catalog.down = True
    env.catalog.pairs.append({"pair_id": "ru-xx", "status": "published", "course_id": "xx"})
    r = await env.c.post("/internal/v1/duel-sets", json={
        "duel_id": str(uuid.uuid4()), "pair_id": "ru-uz", "level_band": "A2", "user_ids": [str(a), str(b)]},
        headers=internal_headers(env.settings, issuer="gamification", audience="lessons"))
    assert r.status_code == 503 and r.json()["code"] == "DUEL_SET_UNAVAILABLE"
