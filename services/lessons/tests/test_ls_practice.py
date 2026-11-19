"""Практика (AT-48, AT-45): медиа (прослушивание → упражнения → оценка по ключам → итоги), нет упражнений → 404,
повтор проблемных заданий (practice_only, без влияния на освоение), дети — только детские материалы;
assessment недоступен → итог без оценки, повторная отправка tick-ом."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from conftest import Env
from ls_testkit import correct_answer, wrong_answer


async def test_media_session(env: Env, user: uuid.UUID) -> None:
    s = await env.start(user, "media/m-own-coffee-order")
    assert s["kind"] == "media" and [x["type"] for x in s["stages"]] == ["listen", "exercises", "summary"]
    sid = s["session_id"]
    listen = await env.current(user, sid)
    assert listen["type"] == "listen" and listen["asset_id"] == "m-own-coffee-order" and listen["can_listen"]
    assert listen["has_audio"] is False and listen["transcript"] and listen["transcript"][0]["gloss"]
    assert set(listen["voices"].values()) <= {"en-GB", "en-US"}
    step = (await env.answer(user, sid, listen, {}))["next"]
    types = []
    while step["type"] == "item":
        assert step["stage"] == "exercises" and step["graded_later"] is True and step["hint_available"] is False
        types.append(step["item"]["item_type"])
        hint = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}/hint", headers=env.h(user))
        assert hint.status_code == 409
        res = await env.answer(user, sid, step, {"answer": correct_answer(step["item"])})
        assert res["feedback"] is None
        step = res["next"]
    assert types == ["comprehension", "gap_fill_media", "phrase_meaning"]
    summary = await env.finish(user, sid)
    assert summary["kind"] == "media" and summary["evaluation"]["passed"] is True
    assert summary["key_words"] and summary["outcome"] is None
    [req] = env.assessment.requests
    assert req["content_refs"]["media_asset"] == {"key": "m-own-coffee-order", "version": 1}
    assert [r["key"] for r in req["content_refs"]["media_exercises"]] == [
        "mx-coffee-order-1", "mx-coffee-order-2", "mx-coffee-order-3"]
    assert req["roleplay"] is None and len(req["answers"]) == 3
    [ev] = await env.events("lesson.session.completed.v1", user)
    assert ev.payload["kind"] == "media" and ev.payload["asset_id"] == "m-own-coffee-order"


async def test_media_order_lines_and_review(env: Env, user: uuid.UUID) -> None:
    s = await env.start(user, "media/m-own-hello-song")
    sid = s["session_id"]
    await env.play(user, sid, items="wrong")
    summary = await env.finish(user, sid)
    assert summary["can_review"] is True and summary["evaluation"]["passed"] is False
    r = await env.c.post(f"/internal/v1/sessions/{sid}/review",
                         headers={**env.h(user), "Idempotency-Key": "review-key-01"})
    assert r.status_code == 201, r.text
    review = r.json()
    assert review["kind"] == "review" and review["asset_id"] == "m-own-hello-song"
    assert [x["type"] for x in review["stages"]] == ["assessment", "summary"]
    rid = review["session_id"]
    shown = await env.play(user, rid)
    items = [x for x in shown if x["type"] == "item"]
    assert {x["item"]["item_type"] for x in items} == {"comprehension", "gap_fill_media", "order_lines"}
    out = await env.finish(user, rid)
    assert out["evaluation"]["practice_only"] is True and out["skills"] == []
    req = env.assessment.requests[-1]
    assert req["kind"] == "review" and req["practice_only"] is True
    order = next(a for a in req["answers"] if a["item_id"] == "mx-hello-song-3")
    assert isinstance(order["answer"], list) and all(isinstance(x, str) for x in order["answer"])
    events = await env.events("lesson.session.completed.v1", user)
    assert [e.payload["practice_only"] for e in events] == [False, True]
    # повтор с тем же ключом — та же сессия
    r = await env.c.post(f"/internal/v1/sessions/{sid}/review",
                         headers={**env.h(user), "Idempotency-Key": "review-key-01"})
    assert r.status_code == 200 and r.json()["session_id"] == rid


async def test_review_lesson_errors_only(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    sid = s["session_id"]
    step = await env.current(user, sid)
    wrong = 0
    while step["type"] != "done":
        if step["stage"] == "assessment" and step["type"] == "item" and wrong < 2:
            body = {"answer": wrong_answer(step["item"])}
            wrong += 1
        else:
            body = env.body_for(step)
        step = (await env.answer(user, sid, step, body))["next"]
    summary = await env.finish(user, sid)
    wrong_ids = [i["item_id"] for i in summary["evaluation"]["items"] if not i["correct"]]
    assert len(wrong_ids) == 2
    r = await env.c.post(f"/internal/v1/sessions/{sid}/review", headers={**env.h(user), "Idempotency-Key": "rv-000001"})
    rid = r.json()["session_id"]
    first = await env.current(user, rid)
    assert first["stage"] == "assessment" and first["stage_total"] == 2
    assert first["item"]["item_id"] == wrong_ids[0]


async def test_nothing_to_review(env: Env, user: uuid.UUID) -> None:
    s, summary = await env.complete_lesson(user)
    assert summary["can_review"] is False
    r = await env.c.post(f"/internal/v1/sessions/{s['session_id']}/review",
                         headers={**env.h(user), "Idempotency-Key": "rv-000002"})
    assert r.status_code == 409 and r.json()["code"] == "NOTHING_TO_REVIEW"
    # чужая сессия — 404
    r = await env.c.post(f"/internal/v1/sessions/{s['session_id']}/review",
                         headers={**env.h(uuid.uuid4()), "Idempotency-Key": "rv-000003"})
    assert r.status_code == 404


async def test_media_not_available_and_no_exercises(env: Env, user: uuid.UUID) -> None:
    await env.start(user, "media/m-unknown", expect=404)
    for key in [k for (kind, k) in env.catalog.versions if kind == "media_exercise" and "weekend" in k]:
        env.catalog.unpublish("media_exercise", key)
    r = await env.c.post("/internal/v1/media/m-own-weekend-plans/sessions",
                         headers={**env.h(user), "Idempotency-Key": "media-0001"})
    assert r.status_code == 404 and r.json()["code"] == "NO_EXERCISES"
    # права истекли — недоступно
    media = dict(env.catalog.payload("media_asset", "m-own-coffee-order"))
    env.catalog.publish("media_asset", "m-own-coffee-order",
                        {**media, "rights": {**media["rights"], "valid_to": "2026-11-10"}})
    await env.start(user, "media/m-own-coffee-order", expect=404)


async def test_kids_only_kids_materials(env: Env, user: uuid.UUID) -> None:
    env.child(user)
    await env.start(user, "media/m-own-hotel-reception", expect=404)
    await env.lesson(user, "l-03-phone-number", expect=404)
    s = await env.start(user, "media/m-own-hello-song")
    assert s["ai_mode"] == "choices"
    await env.post(user, s["session_id"], "cancel")
    lesson = await env.lesson(user)
    assert lesson["ai_mode"] == "choices"
    shown = await env.play(user, lesson["session_id"])
    assert "open_answer" not in [x["type"] for x in shown]  # открытое задание детям не предлагается
    assert all(x["free_text_allowed"] is False for x in shown if x["type"] == "roleplay")
    await env.finish(user, lesson["session_id"])
    assert env.assessment.requests[-1]["audience"] == "kids" and env.assessment.requests[-1]["open_answer"] is None
    assert env.ai.requests == []


@pytest.mark.parametrize("mode", ["down", "timeout", "garbage"])
async def test_assessment_unavailable_then_tick_resends(env: Env, user: uuid.UUID, mode: str) -> None:
    env.assessment.mode = mode
    s = await env.lesson(user)
    sid = s["session_id"]
    await env.play(user, sid, items="wrong")
    summary = await env.finish(user, sid)
    assert summary["status"] == "completed" and summary["evaluation"] is None and summary["can_review"] is False
    [ev] = await env.events("lesson.session.completed.v1", user)
    assert ev.payload["evaluation_id"] is None and ev.payload["passed"] is None
    again = await env.finish(user, sid)  # повтор — тот же итог, без новых событий и без повторной отправки
    assert again["evaluation"] is None and len(env.assessment.requests) == 1
    env.assessment.mode = "ok"
    env.now += timedelta(minutes=15)
    out = await env.tick()
    assert out["evaluations_sent"] == 1
    later = (await env.c.get(f"/internal/v1/sessions/{sid}/summary", headers=env.h(user))).json()
    assert later["evaluation"] is not None and later["can_review"] is True
    assert len(await env.events("lesson.session.completed.v1", user)) == 1
    assert (await env.tick())["evaluations_sent"] == 0
    # ошибки проверки — в очереди повторения
    rows = await env.sql("SELECT count(*) FROM review_items WHERE user_id = :u", u=user)
    assert rows[0][0] == 5


async def test_evaluation_retry_gives_up(env: Env, user: uuid.UUID) -> None:
    env.assessment.mode = "down"
    s, _ = await env.complete_lesson(user)
    env.now += timedelta(days=8)
    out = await env.tick()
    assert out["evaluations_given_up"] == 1 and out["evaluations_sent"] == 0
    row = await env.sql("SELECT evaluation_status FROM sessions WHERE session_id = :s", s=uuid.UUID(s["session_id"]))
    assert row[0][0] == "failed"


async def test_summary_shows_current_evaluation_after_reevaluation(env: Env, user: uuid.UUID) -> None:
    s, summary = await env.complete_lesson(user, items="wrong")
    sid = s["session_id"]
    assert summary["evaluation"]["passed"] is False
    new_id = str(uuid.uuid4())
    env.assessment.reevaluated[sid] = {"evaluation_id": new_id, "passed": True, "superseded_by": None}
    later = (await env.c.get(f"/internal/v1/sessions/{sid}/summary", headers=env.h(user))).json()
    assert later["evaluation"]["evaluation_id"] == new_id and later["evaluation"]["passed"] is True
    assert env.assessment.requests[-1]["session_id"] == sid  # повторный POST идемпотентен по session_id
    # assessment недоступен — сохранённая копия
    env.assessment.mode = "down"
    again = (await env.c.get(f"/internal/v1/sessions/{sid}/summary", headers=env.h(user))).json()
    assert again["evaluation"]["evaluation_id"] == new_id
    assert len(await env.events("lesson.session.completed.v1", user)) == 1


async def test_assessment_token_subject_is_learner(env: Env, user: uuid.UUID) -> None:
    account = uuid.uuid4()
    s = await env.lesson(user, account=account)
    step = await env.current(user, s["session_id"], account=account)
    while step["type"] != "done":
        step = (await env.answer(user, s["session_id"], step, env.body_for(step), account=account))["next"]
    await env.post(user, s["session_id"], "finish", account=account)
    assert env.assessment.subjects == [str(user)] and env.assessment.requests[0]["user_id"] == str(user)
    assert env.assessment.requests[0]["audience"] == "kids"


async def test_evaluation_request_matches_assessment_contract(env: Env, user: uuid.UUID) -> None:
    """Контрактный тест: EvaluationRequest lessons принимает модель входа assessment (extra=forbid)."""
    schemas = pytest.importorskip("tilhero_assessment.schemas")
    await env.complete_lesson(user, open_text="Hello! I'm Aziz.")
    s = await env.start(user, "scenarios/sc-meet-phone-number")
    step = await env.current(user, s["session_id"])
    step = (await env.answer(user, s["session_id"], step, {"text": "Yes, sure!"}))["next"]
    while step["type"] == "roleplay":
        step = (await env.answer(user, s["session_id"], step,
                                 {"choice_id": env.choice_to(step, "success", "sc-meet-phone-number")}))["next"]
    await env.answer(user, s["session_id"], step, {})
    await env.finish(user, s["session_id"])
    m = await env.start(user, "media/m-own-hello-song")
    await env.play(user, m["session_id"], items="wrong")
    await env.finish(user, m["session_id"])
    r = await env.c.post(f"/internal/v1/sessions/{m['session_id']}/review",
                         headers={**env.h(user), "Idempotency-Key": "rv-contract-1"})
    await env.play(user, r.json()["session_id"])
    await env.finish(user, r.json()["session_id"])
    assert [req["kind"] for req in env.assessment.requests] == ["lesson", "scenario", "media", "review"]
    for req in env.assessment.requests:
        parsed = schemas.EvaluationRequestIn.model_validate(req)
        assert parsed.content_refs and str(parsed.user_id) == str(user)


async def test_tick_resend_stops_after_time_budget(env: Env, user: uuid.UUID) -> None:
    """Повторная отправка оценок за один tick ограничена по времени (n8n ждёт 120 с): после бюджета новые не
    начинаются, оставшиеся уходят следующим tick."""
    env.assessment.mode = "down"
    await env.complete_lesson(user)
    await env.complete_lesson(uuid.uuid4())
    env.assessment.mode = "ok"
    env.now += timedelta(minutes=15)
    env.settings.tick_resend_budget_seconds = 0.000001  # бюджет исчерпан после первой отправки
    out = await env.tick()
    assert out["evaluations_sent"] == 1
    env.settings.tick_resend_budget_seconds = 75.0
    assert (await env.tick())["evaluations_sent"] == 1
