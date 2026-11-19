"""Ролевая ситуация и свободный текст (AT-44): выбор реплик — критерии без текста null, task по исходу,
independence по подсказкам; свободный текст — independent_evaluator (контекст строго ai.ts; ошибки только с
дословной цитатой; сертификат и произношение игнорируются; task не выше исхода графа); insufficient_evidence;
unavailable → partial / pending_review с ручной проверкой; дети — без ИИ; правило зачёта; исходы навыков."""

from __future__ import annotations

import uuid

import pytest
from as_testkit import (
    always,
    answers_for,
    choice_turns,
    evaluator_output,
    lesson,
    lesson_request,
    scenario_request,
    text_turns,
)

from tilhero_assessment.evaluator import request_id_for


def scores_of(r: dict) -> dict:
    return {s["code"]: s["score"] for s in r["scores"]}


def outcomes_of(r: dict) -> dict:
    return {o["skill_id"]: o["outcome"] for o in r["skill_outcomes"]}


@pytest.mark.parametrize(("outcome", "task"), [("success", 3), ("alt_success", 2), ("fail", 1), (None, 0)])
async def test_choices_task_by_outcome_and_text_criteria_null(env, user, outcome, task) -> None:
    r = await env.evaluate(user, lesson_request("l-03-phone-number", outcome=outcome))
    # r-lesson-core: task, vocabulary, grammar, independence — без текста vocabulary/grammar не оценивались
    assert scores_of(r) == {"task": task, "vocabulary": None, "grammar": None, "independence": 3}
    assert r["task_completed"] is (outcome in ("success", "alt_success"))
    assert r["evaluator"] is None and env.ai.requests == []


async def test_choices_without_learner_turns_is_refusal(env, user) -> None:
    turns = [t for t in choice_turns("sc-meet-phone-number") if t["speaker"] == "character"]
    r = await env.evaluate(user, lesson_request("l-03-phone-number", outcome="fail", turns=turns))
    assert scores_of(r)["task"] == 0


@pytest.mark.parametrize(("roleplay_hints", "hinted_turns", "hinted_items", "independence"), [
    (0, (), (), 3), (1, (), (), 2), (0, (0, 1), (), 1), (2, (0,), (), 1), (1, (), ("l-03-c2", "l-03-c3"), 0),
    (5, (), (), 0)])
async def test_independence_by_hints(env, user, roleplay_hints, hinted_turns, hinted_items, independence) -> None:
    body = lesson_request("l-03-phone-number", roleplay_hints=roleplay_hints,
                          turns=choice_turns("sc-meet-phone-number", hinted=hinted_turns),
                          policy=lambda i: "hinted" if i["item_id"] in hinted_items else "correct")
    r = await env.evaluate(user, body)
    assert scores_of(r)["independence"] == independence
    assert r["requires_human_review"] is False


async def test_scenario_practice_choices(env, user) -> None:
    r = await env.evaluate(user, scenario_request("sc-meet-phone-number", outcome="alt_success", hints=1))
    # r-roleplay: comprehension без закрытых заданий и fluency — null
    assert scores_of(r) == {"task": 2, "comprehension": None, "fluency": None, "independence": 2}
    assert r["passed"] is True and r["items"] == []
    # навыки сценария без заданий — not_assessed (без влияния на карту)
    assert set(outcomes_of(r).values()) == {"not_assessed"}
    r = await env.evaluate(user, scenario_request("sc-meet-phone-number", outcome="success", hints=0))
    assert r["status"] == "ok" and r["passed"] is True


async def test_outcome_must_exist_in_scenario_graph(env, user) -> None:
    sc = env.catalog.content["scenario"]["sc-meet-phone-number"]
    for node in sc["nodes"].values():
        if node["end"] and node["end"]["outcome"] == "alt_success":
            node["end"]["outcome"] = "fail"
    r = await env.c.post("/internal/v1/evaluations", json=scenario_request("sc-meet-phone-number",
                                                                           outcome="alt_success"),
                         headers=env.lessons(user))
    assert r.status_code == 422 and r.json()["code"] == "OUTCOME_INVALID"


async def test_text_evaluator_ok_with_verified_errors(env, user) -> None:
    learner_lines = ("Sure, i can helps you with report.", "My number is five five five, zero one three nine.")
    env.ai.output = evaluator_output(
        scores={"task": 3, "vocabulary": 2, "grammar": 1, "independence": 3, "pronunciation": 3, "fluency": 3},
        task_completed=True, support_used=False, confidence=0.85, cefr_certificate=True, pronunciation_score=2,
        confirmed_errors=[
            {"turn_id": "T2", "evidence": "i can helps you", "correction": "I can help you", "error_code": "verb_form",
             "severity": "high"},
            {"turn_id": "T2", "evidence": "I can helps you", "correction": "I can help you",  # регистр не тот
             "error_code": "verb_form", "severity": "high"},
            {"turn_id": "T4", "evidence": "my number is 555", "correction": "…", "error_code": "vocabulary",
             "severity": "high"},  # выдуманная цитата
            {"turn_id": "T9", "evidence": "report", "correction": "the report", "error_code": "article",
             "severity": "medium"},  # нет такой реплики
            {"turn_id": "T2", "evidence": "with report", "correction": "with the report", "error_code": "article",
             "severity": "low"},
            {"turn_id": "OA1", "evidence": "I wants", "correction": "I want", "error_code": "verb_form",
             "severity": "medium"},
        ])
    body = lesson_request("l-03-phone-number", turns=text_turns(*learner_lines), outcome="success",
                          open_answer="I wants to call my friend and ask her number.")
    r = await env.evaluate(user, body)
    # pronunciation/fluency не в рубрике урока; независимость — по правилам; vocabulary/grammar — оценщик
    assert scores_of(r) == {"task": 3, "vocabulary": 2, "grammar": 1, "independence": 3}
    assert r["status"] == "ok" and r["evaluator"] == {"model_id": "fake", "prompt_version": "independent_evaluator@3"}
    assert "cefr_certificate" not in r and "pronunciation_score" not in r
    assert [(e["turn_id"], e["evidence"]) for e in r["key_errors"]] == [
        ("T2", "i can helps you"), ("OA1", "I wants"), ("T2", "with report")]
    # контекст оценщика — строго поля ai.ts и только нужные данные
    [req] = env.ai.requests
    assert set(req) == {"request_id", "session_id", "session_kind", "user_id", "audience", "locale", "context",
                        "deadline_ms"}
    assert req["deadline_ms"] == 25_000  # таймаут к шлюзу 26 с − 1 с (ревью R1-03)
    assert req["request_id"] == request_id_for(uuid.UUID(body["session_id"])) and req["session_kind"] == "lesson"
    assert req["user_id"] == str(user) and req["audience"] == "adults" and req["locale"] == "ru"
    ctx = req["context"]
    assert set(ctx) == {"rubric", "task", "turns", "hint_usage", "cefr_target"}
    assert ctx["cefr_target"] == lesson("l-03-phone-number")["level"]
    assert ctx["task"]["outcome"] == "success" and ctx["task"]["goal_en"] == lesson("l-03-phone-number")["goal"]["ru"]
    assert [c["code"] for c in ctx["rubric"]["criteria"]] == ["task", "vocabulary", "grammar", "independence"]
    assert set(ctx["rubric"]["criteria"][0]) == {"code", "weight", "bands"}
    assert ctx["hint_usage"] == {"count": 0, "turn_ids": []}
    assert [(t["turn_id"], t["speaker"]) for t in ctx["turns"]] == [
        ("T1", "character"), ("T2", "learner"), ("T3", "character"), ("T4", "learner"), ("Q1", "task"),
        ("OA1", "learner")]
    text = str(req)
    assert "control_items" not in text and "answer" not in ctx and "l-03-c1" not in text  # ключи и ответы — нет


async def test_descriptive_context_fields_in_russian_for_any_locale(env, user) -> None:
    rubric = env.catalog.content["rubric"]["r-roleplay"]
    sc = env.catalog.content["scenario"]["sc-meet-phone-number"]
    await env.evaluate(user, {**scenario_request("sc-meet-phone-number",
                                                 turns=text_turns("I can help you with the report.")),
                              "locale": "uz"})
    [req] = env.ai.requests
    ctx = req["context"]
    assert req["locale"] == "uz"
    assert ctx["task"]["goal_en"] == sc["task"]["ru"]
    assert ctx["task"]["completion_criteria_en"] == sc["completion"]["criteria"]["ru"]
    assert [b["descriptor_en"] for b in ctx["rubric"]["criteria"][0]["bands"]] == [
        b["descriptor"]["ru"] for b in rubric["criteria"][0]["bands"]]
    assert ctx["turns"][1] == {"turn_id": "T2", "speaker": "learner", "text": "I can help you with the report."}


async def test_text_task_not_above_graph_outcome(env, user) -> None:
    env.ai.output = evaluator_output(scores={"task": 3, "vocabulary": 3, "grammar": 3, "independence": 3})
    r = await env.evaluate(user, lesson_request("l-03-phone-number", outcome="fail",
                                                turns=text_turns("Please give me the number now!")))
    assert scores_of(r)["task"] == 1 and r["task_completed"] is False


async def test_errors_only_from_free_text_turns(env, user) -> None:
    turns = choice_turns("sc-meet-phone-number")
    learner_choice = next(t for t in turns if t["speaker"] == "learner")
    turns.append({"turn_id": "T99", "speaker": "learner", "text": "I has a question.", "mode": "text"})
    env.ai.output = evaluator_output(scores={"vocabulary": 2, "grammar": 2}, confirmed_errors=[
        {"turn_id": learner_choice["turn_id"], "evidence": learner_choice["text"][:20], "correction": "x",
         "error_code": "vocabulary", "severity": "high"},  # выбранный вариант — текст контента, не ошибка
        {"turn_id": "T99", "evidence": "I has", "correction": "I have", "error_code": "verb_form",
         "severity": "medium"}])
    r = await env.evaluate(user, lesson_request("l-03-phone-number", turns=turns))
    assert [e["turn_id"] for e in r["key_errors"]] == ["T99"]


async def test_evaluator_without_confidence_and_flagged_review(env, user) -> None:
    env.ai.output = evaluator_output(scores={"vocabulary": 3, "grammar": 3}, confidence=None,
                                     requires_human_review=True)
    r = await env.evaluate(user, lesson_request("l-03-phone-number", turns=text_turns("I can help you.")))
    assert r["status"] == "ok" and r["passed"] is True and r["requires_human_review"] is True


def lesson_with_three_items(env, lesson_id: str = "l-03-phone-number") -> dict:
    """Версия 2 урока с тремя контрольными заданиями одного навыка (каталог-фейк)."""
    payload = {**env.catalog.content["lesson"][lesson_id]}
    payload["control_items"] = payload["control_items"][:3]
    env.catalog.extra[("lesson", lesson_id, 2)] = payload
    return payload


async def test_evaluator_insufficient_evidence_keeps_rule_verdict(env, user) -> None:
    """Ревью R1-01: оценщик вернул insufficient_evidence, но правила оценили ≥ 2 критериев (3/3 закрытых верно,
    успешный сценарий, без подсказок) → partial, вердикт и навыки по правилам, критерии оценщика null; ручная
    проверка — как решил оценщик (здесь — низкая уверенность)."""
    payload = lesson_with_three_items(env)
    env.ai.output = evaluator_output(status="insufficient_evidence", scores={}, task_completed=None, confidence=0.2)
    body = lesson_request("l-03-phone-number", turns=text_turns("ok"), outcome="success",
                          answers=answers_for(payload["control_items"], always("correct")))
    body["content_refs"][0]["version"] = 2
    r = await env.evaluate(user, body)
    assert r["status"] == "partial" and r["passed"] is True
    assert scores_of(r) == {"task": 3, "vocabulary": None, "grammar": None, "independence": 3}
    assert outcomes_of(r)["en.func.numbers-phone"] == "demonstrated"
    assert r["evaluator"] is not None and r["requires_human_review"] is True  # низкая уверенность
    assert all(i["correct"] for i in r["items"]) and len(r["items"]) == 3
    [row] = await env.sql("SELECT status, weighted, ai_status FROM evaluations WHERE evaluation_id = :e",
                          e=uuid.UUID(r["evaluation_id"]))
    assert (row[0], row[1], row[2]) == ("partial", 3.0, "ok")
    [event] = await env.events("assessment.completed.v1", user)
    assert event.payload["passed"] is True


async def test_evaluator_insufficient_evidence_review_as_evaluator_decided(env, user) -> None:
    env.ai.output = evaluator_output(status="insufficient_evidence", scores={}, task_completed=None, confidence=0.9)
    r = await env.evaluate(user, lesson_request("l-03-phone-number", turns=text_turns("ok"), outcome="fail"))
    # правила: task 1 (fail), independence 3, закрытые верно → вердикт по правилам, без ручной проверки
    assert r["status"] == "partial" and r["passed"] is True and r["requires_human_review"] is False
    assert scores_of(r)["task"] == 1 and scores_of(r)["vocabulary"] is None
    env.ai.output = evaluator_output(status="insufficient_evidence", scores={}, task_completed=None, confidence=0.9,
                                     requires_human_review=True)
    r = await env.evaluate(uuid.uuid4(), lesson_request("l-03-phone-number", turns=text_turns("ok")))
    assert r["status"] == "partial" and r["requires_human_review"] is True  # флаг оценщика


async def test_evaluator_insufficient_evidence_without_rule_evidence(env, user) -> None:
    """Оценённых критериев < 2 (рубрика только из критериев оценщика) → insufficient_evidence, без вердикта."""
    rubric = {**env.catalog.content["rubric"]["r-lesson-core"]}
    rubric["criteria"] = [c for c in rubric["criteria"] if c["code"] in ("vocabulary", "grammar")]
    for c in rubric["criteria"]:
        c["weight"] = 0.5
    env.catalog.extra[("rubric", "r-lesson-core", 2)] = rubric
    env.ai.output = evaluator_output(status="insufficient_evidence", scores={}, task_completed=None, confidence=0.2)
    body = lesson_request("l-03-phone-number", turns=text_turns("ok"))
    body["content_refs"][1]["version"] = 2
    r = await env.evaluate(user, body)
    assert r["status"] == "insufficient_evidence" and r["passed"] is None
    assert "demonstrated" not in outcomes_of(r).values()
    assert r["evaluator"] is not None and r["requires_human_review"] is True


async def test_evaluator_busy_is_503_without_record(env, user) -> None:
    """Ревью R1-04: 409 IDEMPOTENCY_IN_PROGRESS шлюза — вызов оценщика этой сессии ещё идёт в другом запросе: не «ИИ
    недоступен» — 503 EVALUATION_IN_PROGRESS, partial не записывается, событий нет; повтор — обычная оценка."""
    env.ai.mode = "busy"
    body = lesson_request("l-03-phone-number", turns=text_turns("I can help you."))
    r = await env.c.post("/internal/v1/evaluations", json=body, headers=env.lessons(user))
    assert r.status_code == 503 and r.json()["code"] == "EVALUATION_IN_PROGRESS"
    assert await env.sql("SELECT count(*) FROM evaluations") == [(0,)]
    assert await env.events("assessment.completed.v1", user) == []
    env.ai.mode = "ok"
    r = await env.evaluate(user, body)
    assert r["status"] == "ok" and r["evaluator"] is not None
    assert len({req["request_id"] for req in env.ai.requests}) == 1  # тот же request_id — сохранённый результат шлюза


@pytest.mark.parametrize("mode", ["unavailable", "refused", "http500", "timeout", "garbage"])
async def test_evaluator_unavailable_partial_with_human_review(env, user, mode) -> None:
    env.ai.mode = mode
    r = await env.evaluate(user, lesson_request("l-03-phone-number", turns=text_turns("I can help you."),
                                                open_answer="I call my friend."))
    assert r["status"] == "partial" and r["requires_human_review"] is True and r["evaluator"] is None
    assert scores_of(r) == {"task": 3, "vocabulary": None, "grammar": None, "independence": 3}
    assert r["passed"] is True  # закрытые задания и исход по графу оценены правилами
    assert all(e["turn_id"].startswith("l-03-") for e in r["key_errors"])
    [(ai_status,)] = await env.sql("SELECT ai_status FROM evaluations WHERE evaluation_id = :e",
                                   e=uuid.UUID(r["evaluation_id"]))
    assert ai_status == ("refused" if mode == "refused" else "unavailable")


async def test_evaluator_unavailable_without_rule_evidence_is_pending_review(env, user) -> None:
    rubric = {**env.catalog.content["rubric"]["r-lesson-core"]}
    rubric["criteria"] = [c for c in rubric["criteria"] if c["code"] in ("vocabulary", "grammar")]
    for c in rubric["criteria"]:
        c["weight"] = 0.5
    env.catalog.extra[("rubric", "r-lesson-core", 2)] = rubric
    env.ai.mode = "unavailable"
    body = lesson_request("l-03-phone-number", turns=text_turns("I can help you."))
    body["content_refs"][1]["version"] = 2
    r = await env.evaluate(user, body)
    assert r["status"] == "pending_review" and r["passed"] is None and r["requires_human_review"] is True
    # тот же урок без текста — insufficient_evidence (оценённых критериев < 2), без ручной проверки
    env.ai.mode = "ok"
    body = lesson_request("l-03-phone-number")
    body["content_refs"][1]["version"] = 2
    r = await env.evaluate(user, body)
    assert r["status"] == "insufficient_evidence" and r["passed"] is None and r["requires_human_review"] is False


async def test_kids_free_text_never_sent_to_ai(env, user) -> None:
    body = lesson_request("l-01-greetings", audience="kids",
                          turns=text_turns("Hi I am Aziz", scenario_id="sc-meet-greetings"),
                          open_answer="I like cats.")
    r = await env.evaluate(user, body)
    assert env.ai.requests == [] and r["evaluator"] is None and r["status"] == "ok"
    assert scores_of(r)["vocabulary"] is None


async def test_pass_rule_by_evaluated_criteria(env, user) -> None:
    # r-lesson-core: min_weighted 1.5, min_per_criterion 1 — success и 3+ подсказки: weighted 2.0, но independence 0
    r = await env.evaluate(user, lesson_request("l-03-phone-number", roleplay_hints=3))
    assert scores_of(r)["independence"] == 0 and r["passed"] is False
    # r-kids: min_weighted 1.0, min_per_criterion 0 — тот же случай зачтён
    r = await env.evaluate(user, lesson_request("l-01-greetings", roleplay_hints=3))
    assert r["passed"] is True
    r = await env.evaluate(user, lesson_request("l-03-phone-number", outcome="fail"))
    # (0.4·1 + 0.2·3) / 0.6 = 1.67 ≥ 1.5, все ≥ 1 — зачтено по оценённым критериям
    assert r["passed"] is True
    r = await env.evaluate(user, lesson_request("l-03-phone-number", outcome=None))
    assert r["passed"] is False  # task 0 < min_per_criterion


async def test_skill_outcomes_rules(env, user) -> None:
    # подсказанный верный ответ не даёт demonstrated; навык урока без заданий — not_assessed
    body = lesson_request("l-03-phone-number", policy=lambda i: "hinted" if i["item_id"] == "l-03-c5" else "correct")
    r = await env.evaluate(user, body)
    assert outcomes_of(r) == {"en.func.numbers-phone": "demonstrated", "en.voc.numbers": "not_assessed",
                              "en.listen.numbers-times": "learning"}
    assert next(i for i in r["items"] if i["item_id"] == "l-03-c5")["hinted"] is True
    # < 2/3 заданий навыка без подсказок верно → learning
    r = await env.evaluate(user, lesson_request(
        "l-03-phone-number", policy=lambda i: "wrong" if i["item_id"] in ("l-03-c1", "l-03-c2") else "correct"))
    assert outcomes_of(r)["en.func.numbers-phone"] == "learning"  # 2 из 4
    # ровно 3 из 4 (≥ 2/3) → demonstrated
    r = await env.evaluate(user, lesson_request(
        "l-03-phone-number", policy=lambda i: "wrong" if i["item_id"] == "l-03-c1" else "correct"))
    assert outcomes_of(r)["en.func.numbers-phone"] == "demonstrated"
    # рубрика не зачтена → все задания верны, но demonstrated нет
    r = await env.evaluate(user, lesson_request("l-03-phone-number", policy=always("correct"), outcome=None))
    assert r["passed"] is False and "demonstrated" not in outcomes_of(r).values()
