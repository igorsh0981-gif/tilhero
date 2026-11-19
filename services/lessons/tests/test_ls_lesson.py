"""Урок целиком (AT-39, AT-40, AT-42, AT-45): старт → повторение → объяснение («проще», проверка понимания) →
ролевая ситуация → проверка без подсказок (+ открытое задание) → итоги; события; идемпотентность шагов и finish."""

from __future__ import annotations

import uuid
from datetime import timedelta

from conftest import Env
from ls_testkit import correct_answer, wrong_answer


async def test_full_lesson_from_start_to_summary(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    assert s["status"] == "ready" and s["kind"] == "lesson" and s["stage"] is None
    assert [x["type"] for x in s["stages"]] == ["retrieval", "explanation", "roleplay", "assessment", "summary"]
    assert s["ai_mode"] == "full" and s["ai_degraded"] is False
    assert s["expires_at"] == "2026-11-20T07:00:00Z"
    sid = s["session_id"]
    shown = await env.play(user, sid)
    types = [(x["stage"], x["type"]) for x in shown]
    # первый урок: повторять нечего (notice), объяснение + проверка понимания, ролевая ситуация, 5 заданий + открытое
    assert types[0] == ("retrieval", "notice")
    assert types[1] == ("explanation", "explanation") and types[2] == ("explanation", "item")
    assert shown[2]["item"]["item_type"] == "meaning_check" and shown[2]["hint_available"] is True
    assert any(t == ("roleplay", "roleplay") for t in types) and ("roleplay", "roleplay_end") in types
    assessment = [x for x in shown if x["stage"] == "assessment"]
    assert [x["type"] for x in assessment] == ["item"] * 5 + ["open_answer"]
    assert all(x["graded_later"] is True and x["hint_available"] is False for x in assessment[:5])
    assert assessment[0]["position"] == 1 and assessment[0]["stage_total"] == 6
    assert assessment[-1]["prompt"]["ru"] == ("Напишите 2–3 предложения по задаче урока: «Поздороваться, назвать "
                                              "своё имя и спросить имя собеседника»")
    assert assessment[-1]["prompt"]["uz"].startswith("Dars vazifasi bo\u02bbyicha 2–3 ta gap yozing: «")
    assert assessment[-1]["max_length"] == 300
    assert shown[-1]["type"] == "done" and shown[-1]["stage"] == "summary"
    started = await env.events("lesson.session.started.v1", user)
    assert len(started) == 1 and started[0].payload["ai_mode"] == "full"

    env.now += timedelta(seconds=40)
    summary = await env.finish(user, sid)
    assert summary["status"] == "completed" and summary["outcome"] == "success"
    ev = summary["evaluation"]
    assert ev is not None and ev["status"] == "ok" and ev["passed"] is True
    assert len(ev["items"]) == 5 and all(i["correct"] for i in ev["items"])
    assert summary["can_review"] is False and summary["key_words"][0]["en"] == "Hello!"
    assert summary["next_lesson"]["lesson_id"] == "l-02-where-from"
    assert {x["skill_id"] for x in summary["skills"]} >= {"en.func.greet"}
    assert all(x["from"] == "not_started" and x["to"] == "demonstrated" for x in summary["skills"])
    # EvaluationRequest: ссылки на версии, ответы проверки, реплики, исход, открытый ответ
    [req] = env.assessment.requests
    assert req["content_refs"]["lesson"] == {"key": "l-01-greetings", "version": 1}
    assert req["content_refs"]["rubric"] == {"key": "r-kids", "version": 1}
    assert req["content_refs"]["scenario"] == {"key": "sc-meet-greetings", "version": 1}
    assert [a["item_id"] for a in req["answers"]] == [f"l-01-c{i}" for i in range(1, 6)]
    assert req["roleplay"] == {"outcome": "success", "hints": 0}
    assert req["open_answer"] == {"text": "Hello! My name is Aziz. Nice to meet you.",
                                  "prompt": assessment[-1]["prompt"]["ru"]}
    assert req["locale"] == "ru" and env.assessment.subjects == [str(user)]
    assert req["practice_only"] is False and req["audience"] == "adults"
    assert req["turns"][0]["speaker"] == "character" and any(t["speaker"] == "learner" for t in req["turns"])
    [done] = await env.events("lesson.session.completed.v1", user)
    p = done.payload
    assert p["status"] == "completed" and p["outcome"] == "success" and p["lesson_id"] == "l-01-greetings"
    assert p["evaluation_id"] == ev["evaluation_id"] and p["passed"] is True and p["practice_only"] is False
    assert p["minutes"] == summary["minutes"] == -(-((len(shown) - 1) * 30 + 40) // 60)
    assert p["local_date"] is None
    view = (await env.c.get(f"/internal/v1/sessions/{sid}", headers=env.h(user))).json()
    assert view["status"] == "completed" and all(x["status"] in ("done", "skipped") for x in view["stages"])
    assert view["stages"][0]["status"] == "skipped"


async def test_finish_is_idempotent_single_event(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    await env.play(user, s["session_id"])
    first = await env.finish(user, s["session_id"])
    second = await env.finish(user, s["session_id"])
    assert first["evaluation"] == second["evaluation"] and second["status"] == "completed"
    assert len(env.assessment.requests) == 1
    assert len(await env.events("lesson.session.completed.v1", user)) == 1


async def test_finish_before_done_and_answers_idempotent(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    sid = s["session_id"]
    step = await env.current(user, sid)
    await env.finish(user, sid, expect=409)
    res = await env.answer(user, sid, step, {})
    again = await env.answer(user, sid, step, {})
    assert again == res  # тот же ответ → тот же StepResult
    # будущий шаг → 409 STEP_NOT_CURRENT {current_step_id}
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/s99", json={}, headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "STEP_NOT_CURRENT"
    assert r.json()["details"]["current_step_id"] == res["next"]["step_id"]
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/s3", json={}, headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "STEP_NOT_CURRENT"
    # проверка понимания: обратная связь сразу, повтор — та же
    explanation = res["next"]
    meaning = (await env.answer(user, sid, explanation, {}))["next"]
    assert meaning["item"]["item_type"] == "meaning_check"
    wrong = await env.answer(user, sid, meaning, {"answer": wrong_answer(meaning["item"])})
    assert wrong["feedback"]["correct"] is False
    assert wrong["feedback"]["correct_answer"] == meaning["item"]["options"][correct_answer(meaning["item"])]
    assert (await env.answer(user, sid, meaning, {"answer": wrong_answer(meaning["item"])})) == wrong
    # другой ответ на уже пройденный шаг → 409 STEP_NOT_CURRENT
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{meaning['step_id']}",
                         json={"answer": correct_answer(meaning["item"])}, headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "STEP_NOT_CURRENT"
    assert r.json()["details"]["current_step_id"] == wrong["next"]["step_id"]


async def test_assessment_hidden_correctness_and_no_hints(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    sid = s["session_id"]
    shown = await env.play(user, sid, until="item")  # первое задание — проверка понимания
    step = shown[-1]
    while step["stage"] != "assessment":
        step = (await env.answer(user, sid, step, env.body_for(step)))["next"]
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}/hint", headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "HINTS_NOT_ALLOWED"
    res = await env.answer(user, sid, step, {"answer": wrong_answer(step["item"])})
    assert res["feedback"] is None and res["reply"] is None
    # варианты ответа — без ключа; неверный формат → 422
    nxt = res["next"]
    bad = {"answer": "x"} if nxt["item"]["item_type"] in ("single_choice", "translate_choice") else {"answer": 99}
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{nxt['step_id']}", json=bad, headers=env.h(user))
    assert r.status_code == 422 and r.json()["code"] == "ANSWER_INVALID"


async def test_one_active_session_and_cancel(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    r = await env.c.post("/internal/v1/lessons/l-02-where-from/sessions",
                         headers={**env.h(user), "Idempotency-Key": "key-other-1"})
    assert r.status_code == 409 and r.json()["code"] == "SESSION_ACTIVE"
    assert r.json()["details"]["session_id"] == s["session_id"] and r.json()["details"]["kind"] == "lesson"
    active = (await env.c.get("/internal/v1/sessions/active", headers=env.h(user))).json()
    assert active["session"]["session_id"] == s["session_id"]
    cancelled = await env.post(user, s["session_id"], "cancel")
    assert cancelled["status"] == "cancelled"
    await env.post(user, s["session_id"], "cancel", expect=409)
    assert (await env.c.get("/internal/v1/sessions/active", headers=env.h(user))).json() == {"session": None}
    [ev] = await env.events("lesson.session.completed.v1", user)
    assert ev.payload["status"] == "cancelled" and ev.payload["outcome"] is None
    await env.lesson(user, "l-02-where-from")


async def test_start_idempotency_key(env: Env, user: uuid.UUID) -> None:
    first = await env.lesson(user, key="key-same-0001")
    r = await env.c.post("/internal/v1/lessons/l-01-greetings/sessions",
                         headers={**env.h(user), "Idempotency-Key": "key-same-0001"})
    assert r.status_code == 200 and r.headers["Idempotent-Replayed"] == "true"
    assert r.json()["session_id"] == first["session_id"]
    r = await env.c.post("/internal/v1/lessons/l-02-where-from/sessions",
                         headers={**env.h(user), "Idempotency-Key": "key-same-0001"})
    assert r.status_code == 422 and r.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    r = await env.c.post("/internal/v1/lessons/l-01-greetings/sessions", headers=env.h(user))
    assert r.status_code == 400 and r.json()["code"] == "IDEMPOTENCY_KEY_REQUIRED"
