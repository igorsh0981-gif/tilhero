"""Оценка чтения (спринт 5, INTERNAL_API §5, AT-57): закрытые вопросы по ключам версии текста из catalog
(single_choice / true_false — индекс; gap_fill — без регистра и концевой пунктуации), критерий comprehension
(встроенная рубрика), practice_only, skill_outcomes = [], событие assessment.completed.v1 kind reading; ИИ не
вызывается; свободный текст и чужие ссылки — 422."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from as_testkit import READINGS, SEED_READINGS, always, lesson_request, reading_request

COFFEE = "r-a1-coffee-shop"


def by_id(kinds: dict[str, str]) -> Any:
    return lambda q: kinds.get(q["question_id"], "correct")


async def test_reading_all_correct(env, user) -> None:
    body = reading_request()
    r = await env.evaluate(user, body)
    assert r["status"] == "ok" and r["passed"] is True and r["practice_only"] is True
    assert r["scores"] == [{"code": "comprehension", "title": {"ru": "Понимание текста", "uz": "Matnni tushunish"},
                            "score": 3}]
    assert r["skill_outcomes"] == [] and r["evaluator"] is None and r["task_completed"] is None
    assert r["rubric_version"] == "reading-comprehension@1" and r["key_errors"] == []
    assert r["requires_human_review"] is False and r["superseded_by"] is None
    assert [(i["item_id"], i["correct"], i["correct_answer"]) for i in r["items"]] == [
        ("rq-coffee-1", True, None), ("rq-coffee-2", True, None), ("rq-coffee-3", True, None)]
    assert env.ai.requests == []  # чтение — только правила
    assert env.catalog.calls == [("reading", COFFEE, 1)]
    [ev] = await env.events("assessment.completed.v1", user)
    p = ev.payload
    assert p["kind"] == "reading" and p["skill_outcomes"] == [] and p["practice_only"] is True
    assert p["passed"] is True and p["evaluation_id"] == r["evaluation_id"] and p["supersedes"] is None
    # повтор по session_id — та же запись, без нового события
    r2 = await env.c.post("/internal/v1/evaluations", json=body, headers=env.lessons(user))
    assert r2.status_code == 200 and r2.headers["Idempotent-Replayed"] == "true"
    assert r2.json()["evaluation_id"] == r["evaluation_id"]
    assert len(await env.events("assessment.completed.v1", user)) == 1
    # practice_only флаг lessons не важен: чтение — всегда тренировка
    r3 = await env.evaluate(user, reading_request(practice_only=False))
    assert r3["practice_only"] is True and r3["skill_outcomes"] == []


async def test_reading_keys_comparison(env, user) -> None:
    body = reading_request(policy=by_id({"rq-coffee-2": "wrong"}))
    body["answers"][2]["answer"] = "  PAID!"  # gap_fill: без регистра, пробелов и концевой пунктуации; 2-й вариант
    r = await env.evaluate(user, body)
    assert [(i["item_id"], i["correct"]) for i in r["items"]] == [
        ("rq-coffee-1", True), ("rq-coffee-2", False), ("rq-coffee-3", True)]
    wrong = r["items"][1]
    assert wrong["your_answer"] == "True" and wrong["correct_answer"] == "False"
    assert r["scores"][0]["score"] == 2 and r["passed"] is True  # 2/3 ≥ 0,6
    assert [(e["turn_id"], e["error_code"], e["evidence"], e["correction"]) for e in r["key_errors"]] == [
        ("rq-coffee-2", "wrong_choice", "True", "False")]
    # одна верная из трёх; «не знаю» и пропуск — неверно (оцениваются все вопросы версии)
    body = reading_request(policy=by_id({"rq-coffee-1": "dont_know", "rq-coffee-2": "skip"}))
    r = await env.evaluate(user, body)
    assert [i["correct"] for i in r["items"]] == [False, False, True]
    assert r["scores"][0]["score"] == 1 and r["passed"] is False and r["status"] == "ok"
    # текст варианта вместо индекса — только точное совпадение
    body = reading_request()
    body["answers"][0]["answer"] = "A latte"
    body["answers"][1]["answer"] = "false"
    r = await env.evaluate(user, body)
    assert [i["correct"] for i in r["items"]] == [True, False, True]
    # все неверно
    r = await env.evaluate(user, reading_request(policy=always("wrong")))
    assert r["scores"][0]["score"] == 0 and r["passed"] is False and len(r["key_errors"]) == 3


async def test_reading_refs_and_request_validation(env, user) -> None:
    async def bad(body: dict[str, Any], code: str, status: int = 422) -> dict[str, Any]:
        r = await env.c.post("/internal/v1/evaluations", json=body, headers=env.lessons(user))
        assert r.status_code == status and r.json()["code"] == code, r.text
        return r.json()

    rubric = {"key": "r-media", "version": 1}
    await bad(reading_request(content_refs={"reading": {"key": COFFEE, "version": 1}, "rubric": rubric}),
              "CONTENT_REFS_INVALID")
    await bad(reading_request(content_refs={"lesson": {"key": "l-01-greetings", "version": 1}, "rubric": rubric}),
              "CONTENT_REFS_INVALID")
    # урок со ссылкой на текст — тоже не та форма
    lesson_body = lesson_request("l-01-greetings")
    lesson_body["content_refs"].append({"kind": "reading", "key": COFFEE, "version": 1})
    await bad(lesson_body, "CONTENT_REFS_INVALID")
    await bad(reading_request(content_refs={"reading": {"key": COFFEE, "version": 7}}), "CONTENT_REF_INVALID")
    body = reading_request()
    body["answers"].append({"item_id": "rq-unknown", "answer": 0})
    out = await bad(body, "ANSWERS_INVALID")
    assert out["details"] == {"reason": "unknown_item", "item_id": "rq-unknown"}
    await bad(reading_request(open_answer={"text": "I think Anna likes coffee"}), "TURNS_INVALID")
    await bad(reading_request(turns=[{"turn_id": "T1", "speaker": "learner", "text": "hi", "mode": "text"}]),
              "TURNS_INVALID")
    await bad(reading_request(roleplay={"outcome": None, "hints": 0}), "TURNS_INVALID")
    body = reading_request()
    body["answers"][0]["correct"] = True  # правильность от lessons не принимается
    await bad(body, "VALIDATION_ERROR")
    # черновик текста — ключей нет
    env.catalog.extra[("reading", COFFEE, 2)] = READINGS[COFFEE]
    env.catalog.statuses[("reading", COFFEE, 2)] = "draft"
    await bad(reading_request(content_refs={"reading": {"key": COFFEE, "version": 2}}), "CONTENT_REF_INVALID")
    # версия без вопросов или с неизвестным типом — ошибка данных catalog
    env.catalog.extra[("reading", COFFEE, 3)] = {**READINGS[COFFEE], "questions": [
        {**READINGS[COFFEE]["questions"][0], "type": "essay"}]}
    await bad(reading_request(content_refs={"reading": {"key": COFFEE, "version": 3}}), "CATALOG_INVALID_RESPONSE",
              503)
    env.catalog.down = True  # версия 1 уже в кеше (неизменяема) — недоступность видна на новой версии
    await bad(reading_request(content_refs={"reading": {"key": COFFEE, "version": 4}}), "CATALOG_UNAVAILABLE", 503)
    assert env.ai.requests == [] and await env.events("assessment.completed.v1") == []


async def test_reading_kids_learner_view_appeal_and_card(env, user) -> None:
    kid = uuid.uuid4()
    r = await env.evaluate(kid, reading_request(audience="kids", policy=by_id({"rq-coffee-1": "wrong"})))
    assert r["practice_only"] is True and env.ai.requests == []
    view = await env.view(kid, r["evaluation_id"])
    assert view["items"][0]["correct"] is False and view["items"][0]["correct_answer"] == "A latte"
    assert view["items"][1]["correct_answer"] is None
    await env.view(user, r["evaluation_id"], expect=404)  # чужая
    r2 = await env.c.post(f"/internal/v1/evaluations/{r['evaluation_id']}/appeal", json={"reason": "Проверьте"},
                          headers={**env.learner(kid), "Idempotency-Key": "ap-reading-1"})
    assert r2.status_code == 409 and r2.json()["code"] == "APPEAL_NOT_ALLOWED"
    card = (await env.c.get(f"/admin/v1/evaluations/{r['evaluation_id']}", headers=env.staff("qa.read"))).json()
    assert card["kind"] == "reading" and card["rubric"] == {"rubric_id": "reading-comprehension", "version": 1}
    assert card["skill_outcomes"] == [] and card["items"][0]["skill_id"] == "read-a1-short-texts"


async def test_reading_reevaluation(env, user) -> None:
    """Переоценка чтения — по встроенной рубрике (один критерий), без исходов навыков (practice_only)."""
    r = await env.evaluate(user, reading_request())
    h = {**env.staff("qa.review"), "Idempotency-Key": "re-read-01"}
    body = {"scores": {"comprehension": 1}, "skill_outcomes": [], "confirmed_errors": [],
            "reason": "Ответы угаданы, проверено вручную", "appeal_id": None}
    out = await env.c.post(f"/admin/v1/evaluations/{r['evaluation_id']}/reevaluate", json=body, headers=h)
    assert out.status_code == 201, out.text
    new = out.json()
    assert new["status"] == "ok" and new["passed"] is False and new["weighted"] == 1.0
    assert new["kind"] == "reading" and new["practice_only"] is True and new["skill_outcomes"] == []
    bad = {**body, "scores": {"task": 2}}
    out = await env.c.post(f"/admin/v1/evaluations/{new['evaluation_id']}/reevaluate", json=bad,
                           headers=env.staff("qa.review"))
    assert out.status_code == 422 and out.json()["code"] == "SCORES_INVALID"
    [ev] = await env.events("assessment.reevaluated.v1", user)
    assert ev.payload["skill_outcomes"] == [] and ev.payload["passed"] is False


async def test_seed_readings_are_gradable(env, user) -> None:
    """Сид текстов catalog (если уже есть): все вопросы каждого текста оцениваются правилами; верные ответы —
    comprehension 3, неверные — 0; детские тексты — тоже без ИИ."""
    if not SEED_READINGS:
        pytest.skip("сид текстов catalog спринта 5 ещё не добавлен")
    for rid, payload in SEED_READINGS.items():
        audience = "kids" if payload["audience"] == ["kids"] else "adults"
        good = await env.evaluate(user, reading_request(rid, audience=audience))
        assert good["scores"][0]["score"] == 3 and good["passed"] is True, rid
        assert len(good["items"]) == len(payload["questions"]), rid
        bad = await env.evaluate(user, reading_request(rid, audience=audience, policy=always("wrong")))
        assert bad["scores"][0]["score"] == 0 and not any(i["correct"] for i in bad["items"]), rid
    assert env.ai.requests == []
