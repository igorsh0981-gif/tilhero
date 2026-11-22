"""Практика «Чтение» (спринт 5, INTERNAL_API §4, AT-57): текст → вопросы на понимание (закрытые, без подсказок,
правильность — только в итогах) → оценка assessment по ключам версии текста (practice_only, навыки не меняются) →
итоги и событие kind reading. Дети — только детские тексты; версия фиксируется при старте; общие правила сессии."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

import pytest
from conftest import Env
from ls_testkit import READINGS, SEED_READINGS, assert_no_keys, correct_answer, wrong_answer

COFFEE = "r-a1-coffee-shop"
CAT = "r-a0-my-cat"


async def _start(env: Env, user: uuid.UUID, reading_id: str = COFFEE, **kw: Any) -> dict[str, Any]:
    return await env.start(user, f"readings/{reading_id}", **kw)


async def _to_questions(env: Env, user: uuid.UUID, sid: str) -> dict[str, Any]:
    step = await env.current(user, sid)
    assert step["type"] == "reading"
    env.now += timedelta(minutes=2)
    res = await env.answer(user, sid, step, {})
    assert res["feedback"] is None and res["reply"] is None
    return res["next"]


async def _complete(env: Env, user: uuid.UUID, reading_id: str = COFFEE, *, wrong: set[str] | None = None,
                    **hk: Any) -> tuple[str, dict[str, Any]]:
    s = await _start(env, user, reading_id, **hk)
    sid = s["session_id"]
    step = await env.current(user, sid, **hk)
    while step["type"] != "done":
        env.now += timedelta(seconds=40)
        if step["type"] == "item":
            item = step["item"]
            body = {"answer": wrong_answer(item) if item["item_id"] in (wrong or set()) else correct_answer(item)}
        else:
            body = {}
        step = (await env.answer(user, sid, step, body, **hk))["next"]
    return sid, await env.post(user, sid, "finish", **hk)


async def test_reading_flow_events_and_summary(env: Env, user: uuid.UUID) -> None:
    s = await _start(env, user)
    assert s["kind"] == "reading" and s["status"] == "ready" and s["ai_mode"] == "choices"
    assert s["ai_degraded"] is False and s["lesson_id"] is None and s["asset_id"] is None
    assert s["title"] == READINGS[COFFEE]["title"]
    assert [x["type"] for x in s["stages"]] == ["reading", "questions", "summary"]
    sid = s["session_id"]
    step = await env.current(user, sid)
    assert step["type"] == "reading" and step["stage"] == "reading" and step["position"] == 1
    view = step["reading"]
    assert view["reading_id"] == COFFEE and view["version"] == 1 and view["level"] == "A1"
    assert view["voice"] == "en-GB" and view["est_minutes"] == 5
    assert [p["p_id"] for p in view["paragraphs"]] == ["p1", "p2"]
    assert view["paragraphs"][0]["sentences"][0] == {
        "s_id": "s1", "text_en": "Anna works near a small coffee shop.",
        "gloss": {"ru": "Анна работает рядом с маленькой кофейней.", "uz": "Анна работает рядом с маленькой кофейней."}}
    assert [g["en"] for g in view["glossary"]] == ["orders", "barista", "pays for"]
    assert all(g["in_dictionary"] is None for g in view["glossary"])
    assert view["questions_count"] == 3 and view["question_types"] == ["single_choice", "true_false", "gap_fill"]
    assert "questions" not in view  # вопросы — отдельными шагами, без ключей
    # подсказок и «проще» у текста нет
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}/hint", headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "HINTS_NOT_ALLOWED"
    r = await env.c.post(f"/internal/v1/sessions/{sid}/simpler", headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "SIMPLER_NOT_AVAILABLE"
    env.now += timedelta(minutes=3)
    step = (await env.answer(user, sid, step, {}))["next"]
    shown = []
    while step["type"] == "item":
        assert step["stage"] == "questions" and step["graded_later"] is True and step["hint_available"] is False
        assert step["stage_total"] == 3
        shown.append(step["item"])
        r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}/hint", headers=env.h(user))
        assert r.status_code == 409 and r.json()["code"] == "HINTS_NOT_ALLOWED"
        env.now += timedelta(seconds=40)
        body = {"answer": wrong_answer(step["item"]) if step["item"]["item_id"] == "rq-coffee-2"
                else correct_answer(step["item"])}
        res = await env.answer(user, sid, step, body)
        assert res["feedback"] is None  # правильность — только в итогах
        step = res["next"]
    assert [i["item_id"] for i in shown] == ["rq-coffee-1", "rq-coffee-2", "rq-coffee-3"]
    # true_false — выбор из двух вариантов (в StepItemType нет true_false); gap_fill — без вариантов
    assert [i["item_type"] for i in shown] == ["single_choice", "single_choice", "gap_fill"]
    assert shown[1]["options"] == ["True", "False"] and shown[2]["options"] == []
    assert step["type"] == "done" and step["stage"] == "summary"
    summary = await env.finish(user, sid)
    assert summary["kind"] == "reading" and summary["status"] == "completed" and summary["outcome"] is None
    ev = summary["evaluation"]
    assert ev["practice_only"] is True and summary["skills"] == [] and summary["can_review"] is False
    assert [(i["item_id"], i["correct"]) for i in ev["items"]] == [
        ("rq-coffee-1", True), ("rq-coffee-2", False), ("rq-coffee-3", True)]
    wrong = next(i for i in ev["items"] if not i["correct"])
    assert wrong["correct_answer"] is not None  # верный ответ — для ошибок, после завершения
    assert [k["en"] for k in summary["key_words"]] == ["orders", "barista", "pays for"]
    assert 1 <= summary["minutes"] <= 2 * env.settings.practice_duration_min
    [req] = env.assessment.requests
    assert req["kind"] == "reading" and req["practice_only"] is True and req["roleplay"] is None
    assert req["content_refs"]["reading"] == {"key": COFFEE, "version": 1}
    assert req["content_refs"]["lesson"] is None and req["content_refs"]["rubric"] is None
    assert [(a["item_id"], a["answer"], a["hinted"]) for a in req["answers"]] == [
        ("rq-coffee-1", 1, False), ("rq-coffee-2", 0, False), ("rq-coffee-3", "pays", False)]
    assert env.ai.requests == []  # ИИ в чтении не участвует
    [started] = await env.events("lesson.session.started.v1", user)
    assert started.payload["kind"] == "reading" and started.payload["ai_mode"] == "choices"
    [done] = await env.events("lesson.session.completed.v1", user)
    p = done.payload
    assert p["kind"] == "reading" and p["status"] == "completed" and p["practice_only"] is True
    assert p["evaluation_id"] == ev["evaluation_id"] and p["minutes"] == summary["minutes"]
    assert p["lesson_id"] is None and p["scenario_id"] is None and p["asset_id"] is None
    # finish идемпотентен: тот же итог, без новой оценки и событий
    again = await env.finish(user, sid)
    assert again == summary and len(env.assessment.requests) == 1
    assert len(await env.events("lesson.session.completed.v1", user)) == 1
    # итоги и история
    assert (await env.c.get(f"/internal/v1/sessions/{sid}/summary", headers=env.h(user))).json()["kind"] == "reading"
    page = (await env.c.get("/internal/v1/sessions", params={"kind": "reading"}, headers=env.h(user))).json()
    assert [x["session_id"] for x in page["items"]] == [sid] and page["items"][0]["kind"] == "reading"
    # ничего повторять не нужно — повтор у чтения не предусмотрен
    r = await env.c.post(f"/internal/v1/sessions/{sid}/review", headers={**env.h(user), "Idempotency-Key": "rv-read-1"})
    assert r.status_code == 409 and r.json()["code"] == "NOTHING_TO_REVIEW"


async def test_keys_never_leak_before_summary(env: Env, user: uuid.UUID) -> None:
    """Ключей вопросов нет ни в шаге текста, ни в шагах вопросов, ни в ответах на них (assert_no_keys в Env)."""
    s = await _start(env, user)
    sid = s["session_id"]
    step = await _to_questions(env, user, sid)
    text = str(step)
    assert "pays" not in text and "'answer'" not in text
    res = await env.answer(user, sid, step, {"answer": 0})
    assert res["feedback"] is None
    # повтор того же ответа — тот же результат; другой ответ на отвеченный шаг — 409
    again = await env.answer(user, sid, step, {"answer": 0})
    assert again == res
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}", json={"answer": 1},
                         headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "STEP_NOT_CURRENT"
    view = (await env.c.get(f"/internal/v1/sessions/{sid}", headers=env.h(user))).json()
    assert_no_keys(view)


async def test_answers_validation_and_finish_guard(env: Env, user: uuid.UUID) -> None:
    s = await _start(env, user)
    sid = s["session_id"]
    step = await env.current(user, sid)
    # текст — только «Дальше»
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}", json={"choice_id": "c1"},
                         headers=env.h(user))
    assert r.status_code == 422 and r.json()["code"] == "ANSWER_INVALID"
    r = await env.c.post(f"/internal/v1/sessions/{sid}/finish", headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "STEP_NOT_CURRENT"
    step = await _to_questions(env, user, sid)
    for bad in ({"answer": 7}, {"answer": "latte"}, {"answer": ["a"]}, {"text": "free text"}):
        r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}", json=bad, headers=env.h(user))
        assert r.status_code == 422, bad
    # «не знаю» — допустимо (неверно в оценке)
    step = (await env.answer(user, sid, step, {"dont_know": True}))["next"]
    step = (await env.answer(user, sid, step, {"answer": 1}))["next"]
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}", json={"answer": "   "},
                         headers=env.h(user))
    assert r.status_code == 422
    r = await env.c.post(f"/internal/v1/sessions/{sid}/roleplay/retry", headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "RETRY_NOT_AVAILABLE"
    step = (await env.answer(user, sid, step, {"answer": "Pays."}))["next"]
    assert step["type"] == "done"
    await env.finish(user, sid)
    req = env.assessment.requests[-1]
    assert req["answers"][0] == {"item_id": "rq-coffee-1", "answer": None, "hinted": False, "dont_know": True}


async def test_start_idempotency_and_single_active_session(env: Env, user: uuid.UUID) -> None:
    r = await env.c.post(f"/internal/v1/readings/{COFFEE}/sessions", headers=env.h(user))
    assert r.status_code == 400 and r.json()["code"] == "IDEMPOTENCY_KEY_REQUIRED"
    s = await _start(env, user, key="read-key-0001")
    r = await env.c.post(f"/internal/v1/readings/{COFFEE}/sessions",
                         headers={**env.h(user), "Idempotency-Key": "read-key-0001"})
    assert r.status_code == 200 and r.headers["Idempotent-Replayed"] == "true"
    assert r.json()["session_id"] == s["session_id"]
    # тот же ключ с другим текстом — 422
    r = await env.c.post("/internal/v1/readings/r-a0-my-cat/sessions",
                         headers={**env.h(user), "Idempotency-Key": "read-key-0001"})
    assert r.status_code == 422 and r.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    # одна незавершённая сессия: урок и другой текст — 409 SESSION_ACTIVE
    r = await env.c.post("/internal/v1/lessons/l-01-greetings/sessions",
                         headers={**env.h(user), "Idempotency-Key": "lesson-key-01"})
    assert r.status_code == 409 and r.json()["code"] == "SESSION_ACTIVE"
    assert r.json()["details"] == {"session_id": s["session_id"], "kind": "reading",
                                   "title": READINGS[COFFEE]["title"]}
    await env.post(user, s["session_id"], "cancel")
    lesson = await env.lesson(user)
    r = await env.c.post(f"/internal/v1/readings/{COFFEE}/sessions",
                         headers={**env.h(user), "Idempotency-Key": "read-key-0002"})
    assert r.status_code == 409 and r.json()["details"]["session_id"] == lesson["session_id"]


async def test_not_available_audience_and_kids(env: Env, user: uuid.UUID) -> None:
    for rid in ("r-unknown-text", "r-a0-my-cat"):  # нет такого; детский текст взрослому
        r = await env.c.post(f"/internal/v1/readings/{rid}/sessions",
                             headers={**env.h(user), "Idempotency-Key": f"k-{rid}"})
        assert r.status_code == 404 and r.json()["code"] == "READING_NOT_AVAILABLE", rid
    env.catalog.unpublish("reading", COFFEE)
    await _start(env, user, expect=404)
    # ребёнок: только детские тексты — взрослый недоступен, даже если catalog не проверил аудиторию
    kid = uuid.uuid4()
    env.child(kid)
    env.catalog.published[("reading", COFFEE)] = 1
    env.catalog.reading_ignores_audience = True
    r = await env.c.post(f"/internal/v1/readings/{COFFEE}/sessions",
                         headers={**env.h(kid), "Idempotency-Key": "kid-key-01"})
    assert r.status_code == 404 and r.json()["code"] == "READING_NOT_AVAILABLE"
    # детский профиль с подсказкой BFF «adults» не повышается
    r = await env.c.post(f"/internal/v1/readings/{COFFEE}/sessions", params={"audience": "adults"},
                         headers={**env.h(kid), "Idempotency-Key": "kid-key-02"})
    assert r.status_code == 404
    env.catalog.reading_ignores_audience = False
    _, summary = await _complete(env, kid, CAT)
    assert summary["kind"] == "reading" and summary["evaluation"]["practice_only"] is True
    req = env.assessment.requests[-1]
    assert req["audience"] == "kids" and req["content_refs"]["reading"] == {"key": CAT, "version": 1}
    # ребёнку свободный текст — 403 и на шагах чтения
    s = await _start(env, kid, CAT)
    step = await env.current(kid, s["session_id"])
    r = await env.c.post(f"/internal/v1/sessions/{s['session_id']}/steps/{step['step_id']}", json={"text": "hi"},
                         headers=env.h(kid))
    assert r.status_code == 403 and r.json()["code"] == "KIDS_NOT_ALLOWED"
    # подросток — текст для teens доступен; пара не опубликована — 409
    teen = uuid.uuid4()
    env.age[str(teen)] = "14-17"
    await _start(env, teen)
    r = await env.c.post(f"/internal/v1/readings/{COFFEE}/sessions", params={"pair_id": "ru-uz"},
                         headers={**env.h(uuid.uuid4()), "Idempotency-Key": "pair-key-01"})
    assert r.status_code == 409 and r.json()["code"] == "PAIR_NOT_AVAILABLE"
    assert env.ai.requests == []


async def test_version_fixed_at_start(env: Env, user: uuid.UUID) -> None:
    """Версия фиксируется при старте: новая публикация или снятие текста с публикации не меняют идущую сессию."""
    s = await _start(env, user)
    sid = s["session_id"]
    step = await _to_questions(env, user, sid)
    changed = {**READINGS[COFFEE], "questions": [
        {**READINGS[COFFEE]["questions"][0], "question_id": "rq-coffee-new", "answer": 0}]}
    assert env.catalog.publish("reading", COFFEE, changed) == 2
    env.catalog.unpublish("reading", COFFEE)
    ids = []
    while step["type"] == "item":
        ids.append(step["item"]["item_id"])
        step = (await env.answer(user, sid, step, {"answer": correct_answer(step["item"])}))["next"]
    assert ids == ["rq-coffee-1", "rq-coffee-2", "rq-coffee-3"]
    summary = await env.finish(user, sid)
    assert summary["status"] == "completed" and all(i["correct"] for i in summary["evaluation"]["items"])
    assert env.assessment.requests[-1]["content_refs"]["reading"] == {"key": COFFEE, "version": 1}
    # новая сессия — по новой опубликованной версии; без номера версии в ответе catalog — по versions/reading/{key}
    env.catalog.published[("reading", COFFEE)] = 2
    env.catalog.reading_without_version = True
    s2 = await _start(env, user)
    step = await _to_questions(env, user, s2["session_id"])
    assert step["item"]["item_id"] == "rq-coffee-new" and step["stage_total"] == 1
    await env.answer(user, s2["session_id"], step, {"answer": 0})
    await env.finish(user, s2["session_id"])
    assert env.assessment.requests[-1]["content_refs"]["reading"] == {"key": COFFEE, "version": 2}


async def test_pause_cancel_expire_and_minutes(env: Env, user: uuid.UUID) -> None:
    s = await _start(env, user)
    sid = s["session_id"]
    await _to_questions(env, user, sid)
    paused = await env.post(user, sid, "pause")
    assert paused["status"] == "paused" and paused["expires_at"] is not None
    resumed = await env.post(user, sid, "resume")
    assert resumed["status"] == "in_progress"
    # бездействие > 10 мин — авто-пауза, время не идёт в минуты
    env.now += timedelta(minutes=30)
    view = (await env.c.get(f"/internal/v1/sessions/{sid}", headers=env.h(user))).json()
    assert view["status"] == "paused"
    cancelled = await env.post(user, sid, "cancel")
    assert cancelled["status"] == "cancelled" and cancelled["minutes"] <= 3
    [ev] = await env.events("lesson.session.completed.v1", user)
    assert ev.payload["kind"] == "reading" and ev.payload["status"] == "cancelled"
    assert ev.payload["evaluation_id"] is None and ev.payload["practice_only"] is True
    # ready > 24 ч — истекает tick-ом
    other = uuid.uuid4()
    s2 = await _start(env, other)
    env.now += timedelta(hours=25)
    out = await env.tick()
    assert out["expired"] == 1
    view = (await env.c.get(f"/internal/v1/sessions/{s2['session_id']}", headers=env.h(other))).json()
    assert view["status"] == "cancelled"
    # минуты — как у медиа: ceil(активные секунды / 60), не больше 2× длительности практики
    third = uuid.uuid4()
    env.step_seconds = 9 * 60
    s3 = await _start(env, third)
    await env.play(third, s3["session_id"])
    summary = await env.finish(third, s3["session_id"])
    assert summary["minutes"] == 2 * env.settings.practice_duration_min


async def test_isolation_and_auth(env: Env, user: uuid.UUID) -> None:
    r = await env.c.post(f"/internal/v1/readings/{COFFEE}/sessions", headers={"Idempotency-Key": "noauth-0001"})
    assert r.status_code == 401
    r = await env.c.post(f"/internal/v1/readings/{COFFEE}/sessions",
                         headers={**env.h(user, issuer="admin-bff"), "Idempotency-Key": "wrong-caller-1"})
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    r = await env.c.post("/internal/v1/readings/BAD_ID/sessions",
                         headers={**env.h(user), "Idempotency-Key": "bad-id-0001"})
    assert r.status_code == 422
    s = await _start(env, user)
    other = uuid.uuid4()
    for path in ("", "/current", "/summary"):
        r = await env.c.get(f"/internal/v1/sessions/{s['session_id']}{path}", headers=env.h(other))
        assert r.status_code == 404, path
    r = await env.c.post(f"/internal/v1/sessions/{s['session_id']}/cancel", headers=env.h(other))
    assert r.status_code == 404
    assert (await env.c.get("/internal/v1/sessions", params={"kind": "reading"},
                            headers=env.h(other))).json()["items"] == []


async def test_reading_results(env: Env, user: uuid.UUID) -> None:
    """ReadingCard.last_result: последний завершённый результат чтения ученика по текстам — только свой."""
    path = "/internal/v1/reading-results"
    r = await env.c.get(path, params={"ids": COFFEE})
    assert r.status_code == 401
    r = await env.c.get(path, params={"ids": COFFEE}, headers=env.staff("qa.read"))
    assert r.status_code == 403
    for bad in ("", "BAD", ",".join(f"r-{i:02d}" for i in range(51))):
        assert (await env.c.get(path, params={"ids": bad}, headers=env.h(user))).status_code == 422, bad
    assert (await env.c.get(path, params={"ids": COFFEE}, headers=env.h(user))).json() == {"items": []}
    await _complete(env, user, wrong={"rq-coffee-1", "rq-coffee-3"})
    env.now += timedelta(hours=1)
    sid, _ = await _complete(env, user, wrong={"rq-coffee-2"})
    s = await _start(env, user)  # незавершённая — не результат
    await env.post(user, s["session_id"], "cancel")
    out = (await env.c.get(path, params={"ids": f"{COFFEE},{CAT},{COFFEE}"}, headers=env.h(user))).json()
    finished = (await env.sql("SELECT finished_at FROM sessions WHERE session_id = :s", s=uuid.UUID(sid)))[0][0]
    assert out == {"items": [{"reading_id": COFFEE, "correct": 2, "total": 3,
                              "finished_at": finished.isoformat().replace("+00:00", "Z")}]}
    assert (await env.c.get(path, params={"ids": COFFEE}, headers=env.h(uuid.uuid4()))).json() == {"items": []}


async def test_admin_journal_card_and_stats(env: Env, user: uuid.UUID) -> None:
    sid, _ = await _complete(env, user)
    env.now += timedelta(seconds=1)
    await env.lesson(uuid.uuid4())
    rows = (await env.c.get("/admin/v1/lesson-sessions", params={"kind": "reading"},
                            headers=env.staff("qa.read"))).json()["items"]
    assert [x["session_id"] for x in rows] == [sid]
    row = rows[0]
    assert row["kind"] == "reading" and row["reading_id"] == COFFEE and row["level"] == "A1"
    assert row["ai_mode"] == "choices" and row["flags"] == [] and row["passed"] is True
    card = (await env.c.get(f"/admin/v1/lesson-sessions/{sid}", headers=env.staff("qa.read"))).json()
    assert card["content_versions"] == {f"reading:{COFFEE}": 1}
    assert [x["type"] for x in card["steps"]] == ["reading", "item", "item", "item", "done"]
    assert {x["stage"] for x in card["steps"]} == {"reading", "questions", "summary"}
    tr = (await env.c.post(f"/admin/v1/lesson-sessions/{sid}/transcript", json={"reason": "Проверка чтения ученика"},
                           headers=env.staff("qa.transcripts"))).json()
    assert [a["item_id"] for a in tr["answers"]] == ["rq-coffee-1", "rq-coffee-2", "rq-coffee-3"]
    stats = (await env.c.get("/admin/v1/lesson-sessions/stats", headers=env.staff("dashboard.read"))).json()
    assert stats["by_kind"] == {"lesson": 0, "scenario": 0, "media": 0, "review": 0, "reading": 1, "duel": 0}
    assert stats["ai_degraded_pct"] == 0.0


async def test_assessment_down_then_tick_resend(env: Env, user: uuid.UUID) -> None:
    env.assessment.mode = "down"
    sid, summary = await _complete(env, user)
    assert summary["status"] == "completed" and summary["evaluation"] is None
    [ev] = await env.events("lesson.session.completed.v1", user)
    assert ev.payload["kind"] == "reading" and ev.payload["evaluation_id"] is None
    env.assessment.mode = "ok"
    env.now += timedelta(minutes=15)
    out = await env.tick()
    assert out["evaluations_sent"] == 1
    later = (await env.c.get(f"/internal/v1/sessions/{sid}/summary", headers=env.h(user))).json()
    assert later["evaluation"]["practice_only"] is True and later["skills"] == []


async def test_evaluation_request_matches_assessment_contract(env: Env, user: uuid.UUID) -> None:
    """Контрактный тест: EvaluationRequest чтения принимает модель входа assessment (extra=forbid)."""
    schemas = pytest.importorskip("tilhero_assessment.schemas")
    await _complete(env, user)
    [req] = env.assessment.requests
    parsed = schemas.EvaluationRequestIn.model_validate(req)
    assert parsed.kind == "reading" and [(r.kind, r.key, r.version) for r in parsed.content_refs] == [
        ("reading", COFFEE, 1)]


async def test_reading_without_gradable_questions_not_available(env: Env, user: uuid.UUID) -> None:
    """Версия без вопросов или с вопросом, который assessment не оценит, — не практика: 404 READING_NOT_AVAILABLE."""
    base = READINGS[COFFEE]
    env.catalog.publish("reading", COFFEE, {**base, "questions": [*base["questions"],
                                                                  {**base["questions"][0], "question_id": "rq-x",
                                                                   "type": "essay"}]})
    r = await env.c.post(f"/internal/v1/readings/{COFFEE}/sessions",
                         headers={**env.h(user), "Idempotency-Key": "grade-key-01"})
    assert r.status_code == 404 and r.json()["code"] == "READING_NOT_AVAILABLE"
    env.catalog.publish("reading", COFFEE, {**base, "questions": []})
    r = await env.c.post(f"/internal/v1/readings/{COFFEE}/sessions",
                         headers={**env.h(user), "Idempotency-Key": "grade-key-02"})
    assert r.status_code == 404
    # catalog вернул чужой текст под этим id — тоже недоступен
    env.catalog.publish("reading", COFFEE, {**base, "reading_id": "r-other"})
    r = await env.c.post(f"/internal/v1/readings/{COFFEE}/sessions",
                         headers={**env.h(user), "Idempotency-Key": "grade-key-03"})
    assert r.status_code == 404
    env.catalog.down = True
    r = await env.c.post(f"/internal/v1/readings/{COFFEE}/sessions",
                         headers={**env.h(user), "Idempotency-Key": "grade-key-04"})
    assert r.status_code == 503 and r.json()["code"] == "CATALOG_UNAVAILABLE"


async def test_seed_readings_play_through(env: Env) -> None:
    """Сид текстов catalog (если уже есть): каждый текст проходится до итогов по аудитории, ключи не утекают,
    все вопросы показываются шагами и уходят в оценку с верными ответами."""
    if not SEED_READINGS:
        pytest.skip("сид текстов catalog спринта 5 ещё не добавлен")
    for rid, payload in SEED_READINGS.items():
        user = uuid.uuid4()
        if payload["audience"] == ["kids"]:
            env.child(user)
        s = await _start(env, user, rid)
        sid = s["session_id"]
        step = await env.current(user, sid)
        assert step["type"] == "reading" and step["reading"]["questions_count"] == len(payload["questions"])
        step = (await env.answer(user, sid, step, {}))["next"]
        questions = {q["question_id"]: q for q in payload["questions"]}
        while step["type"] == "item":
            q = questions[step["item"]["item_id"]]
            answer = q["answer"][0] if q["type"] == "gap_fill" else q["answer"]
            step = (await env.answer(user, sid, step, {"answer": answer}))["next"]
        summary = await env.finish(user, sid)
        assert [i["item_id"] for i in summary["evaluation"]["items"]] == list(questions), rid
        assert all(i["correct"] for i in summary["evaluation"]["items"]), rid
