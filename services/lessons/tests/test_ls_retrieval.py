"""Повторение и объяснение (AT-40): первый урок — notice; предпосылки → задания уроков с этим навыком; ошибки
урока → очередь повторения (+1 день) → задания следующего урока; подсказка отмечается; «объясни проще» с ИИ и без,
позиция не теряется."""

from __future__ import annotations

import copy
import uuid
from datetime import timedelta

from conftest import Env
from ls_testkit import correct_answer, wrong_answer


async def test_first_lesson_without_history_has_notice(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    step = await env.current(user, s["session_id"])
    assert step["type"] == "notice" and step["stage"] == "retrieval" and "нечего" in step["text"]["ru"]
    view = (await env.c.get(f"/internal/v1/sessions/{s['session_id']}", headers=env.h(user))).json()
    assert view["stage"] == "retrieval" and view["stages"][0] == {"type": "retrieval", "status": "current"}
    r = await env.c.post(f"/internal/v1/sessions/{s['session_id']}/steps/{step['step_id']}/hint",
                         headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "HINTS_NOT_ALLOWED"


async def test_prerequisites_give_retrieval_items(env: Env, user: uuid.UUID) -> None:
    env.diagnostics.states = {"en.func.greet": "learning"}
    s = await env.lesson(user, "l-02-where-from")
    sid = s["session_id"]
    step = await env.current(user, sid)
    assert step["type"] == "item" and step["stage"] == "retrieval" and step["graded_later"] is False
    assert step["item"]["item_id"].startswith("l-01-") and step["stage_total"] in (2, 3)
    total = step["stage_total"]
    # подсказка отмечается; ответ с подсказкой → в очередь повторения
    hint = (await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}/hint", headers=env.h(user)))
    assert hint.status_code == 200 and hint.json()["hint"]["ru"]
    res = await env.answer(user, sid, step, {"answer": correct_answer(step["item"])})
    assert res["feedback"] == {"correct": True, "correct_answer": None}
    nxt = res["next"]
    res = await env.answer(user, sid, nxt, {"answer": wrong_answer(nxt["item"])})
    assert res["feedback"]["correct"] is False and res["feedback"]["correct_answer"]
    rows = await env.sql("SELECT item_id, reason, due_at FROM review_items WHERE user_id = :u ORDER BY item_id",
                         u=user)
    assert {r[1] for r in rows} == {"hinted", "wrong"} and all(r[2] == env.now + timedelta(days=1) for r in rows)
    cv = (await env.sql("SELECT content_versions FROM sessions WHERE session_id = :s", s=uuid.UUID(sid)))[0][0]
    assert cv["retrieval"] == [{"key": "l-01-greetings", "version": 1}] and total >= 2


async def test_retrieval_fills_from_same_lesson_when_skill_has_one_item(env: Env, user: uuid.UUID) -> None:
    """У навыка-предпосылки в уроке одно задание — добираем остальными заданиями того же урока (2–3, AT-40)."""
    payload = copy.deepcopy(env.catalog.versions[("lesson", "l-01-greetings")][1])
    items = payload["control_items"]
    assert len(items) >= 3
    for i, c in enumerate(items):
        c["skill_id"] = "en.func.greet" if i == 0 else "en.other.skill"
    env.catalog.publish("lesson", "l-01-greetings", payload)
    s = await env.lesson(user, "l-02-where-from")
    step = await env.current(user, s["session_id"])
    assert step["stage"] == "retrieval" and step["stage_total"] in (2, 3)
    assert step["item"]["item_id"] == items[0]["item_id"]  # задание самого навыка — первым


async def test_lesson_errors_return_in_next_retrieval(env: Env, user: uuid.UUID) -> None:
    _, summary = await env.complete_lesson(user, items="wrong")
    assert summary["can_review"] is True and summary["evaluation"]["passed"] is False
    wrong_ids = {i["item_id"] for i in summary["evaluation"]["items"] if not i["correct"]}
    assert wrong_ids
    # через день — задания с ошибками в повторении следующего урока (сначала очередь, потом предпосылки)
    env.now += timedelta(days=1, minutes=1)
    s = await env.lesson(user, "l-04-family")
    step = await env.current(user, s["session_id"])
    seen = []
    while step["stage"] == "retrieval":
        seen.append(step["item"]["item_id"])
        step = (await env.answer(user, s["session_id"], step, {"answer": correct_answer(step["item"])}))["next"]
    assert len(seen) == 3 and set(seen) <= wrong_ids
    resolved = await env.sql("SELECT count(*) FROM review_items WHERE user_id = :u AND resolved_at IS NOT NULL",
                             u=user)
    assert resolved[0][0] == 3


async def test_review_items_not_due_yet(env: Env, user: uuid.UUID) -> None:
    await env.complete_lesson(user, items="wrong")
    # сроки не наступили; у предпосылок l-04 (introduce, to-be) нет уроков с таким основным навыком → notice
    s = await env.lesson(user, "l-04-family")
    step = await env.current(user, s["session_id"])
    assert step["stage"] == "retrieval" and step["type"] == "notice"


async def test_simpler_with_ai_and_without(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    sid = s["session_id"]
    step = await env.current(user, sid)
    r = await env.c.post(f"/internal/v1/sessions/{sid}/simpler", headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "SIMPLER_NOT_AVAILABLE"
    explanation = (await env.answer(user, sid, step, {}))["next"]
    assert explanation["type"] == "explanation" and explanation["can_simplify"] is True
    assert len(explanation["examples"]) == 4 and len(explanation["key_words"]) == 10
    ai = await env.post(user, sid, "simpler")
    assert ai["source"] == "ai" and ai["explanation"]["ru"] and ai["example_en"] == "Hi! I'm Tom."
    [call] = env.ai.requests
    assert call["agent"] == "teaching_coach" and call["context"]["request"] == "simpler_example"
    assert call["context"]["explain_locale"] == "ru" and "learner_turn" not in call["context"]
    # ?locale=uz — объяснение на узбекском, хотя сессия на русском (интерфейс переключён)
    r = await env.c.post(f"/internal/v1/sessions/{sid}/simpler", params={"locale": "uz"}, headers=env.h(user))
    assert r.status_code == 200 and r.json()["source"] == "ai"
    assert env.ai.requests[-1]["context"]["explain_locale"] == "uz" and env.ai.requests[-1]["locale"] == "uz"
    r = await env.c.post(f"/internal/v1/sessions/{sid}/simpler", params={"locale": "en"}, headers=env.h(user))
    assert r.status_code == 422
    env.ai.requests.pop()
    # ИИ недоступен → следующий пример урока, дальше в этапе ИИ не вызывается
    env.ai.mode["teaching_coach"] = "unavailable"
    lesson = await env.post(user, sid, "simpler")
    assert lesson["source"] == "lesson" and lesson["explanation"] is None and lesson["example_en"]
    second = await env.post(user, sid, "simpler")
    assert second["source"] == "lesson" and second["example_en"] != lesson["example_en"]
    assert len(env.ai.requests) == 2
    # позиция урока не меняется
    assert (await env.current(user, sid))["step_id"] == explanation["step_id"]
    view = (await env.c.get(f"/internal/v1/sessions/{sid}", headers=env.h(user))).json()
    assert view["ai_degraded"] is True


async def test_simpler_for_kids_without_ai(env: Env, user: uuid.UUID) -> None:
    env.child(user)
    s = await env.lesson(user)
    sid = s["session_id"]
    step = await env.current(user, sid)
    await env.answer(user, sid, step, {})
    out = await env.post(user, sid, "simpler")
    assert out["source"] == "lesson" and out["example_en"] == "Hello! My name is Aziz. What's your name?"
    assert env.ai.requests == []
