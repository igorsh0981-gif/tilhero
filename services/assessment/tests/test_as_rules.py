"""Правила оценки (чистые функции): сравнение ответов, баллы критериев, правило зачёта, исходы навыков, проверка
ошибок оценщика; настройки сервиса; гонка двух оценок одной сессии."""

from __future__ import annotations

import asyncio
import uuid

import pytest
from as_testkit import lesson, lesson_request

from tilhero_assessment.domain import rules
from tilhero_assessment.settings import Settings

RUBRIC = rules.Rubric("r", 1, (
    rules.Criterion("task", 0.4, {"ru": "т", "uz": "t"}, []),
    rules.Criterion("vocabulary", 0.2, {"ru": "с", "uz": "s"}, []),
    rules.Criterion("grammar", 0.2, {"ru": "г", "uz": "g"}, []),
    rules.Criterion("independence", 0.2, {"ru": "н", "uz": "n"}, []),
), 1.5, 1)


def key(item_type: str, answer, options=()) -> rules.KeyItem:
    return rules.KeyItem("i1", item_type, "s1", "p", tuple(options), answer)


@pytest.mark.parametrize(("value", "expected"), [
    ("  I’M  Fine!! ", "i'm fine"), ("Am.", "am"), ("am…", "am"), ("am ?", "am"), ("a.m.", "a.m"), ("", ""),
    ("don`t", "don't"), ("Café", "café")])
def test_normalize_gap(value, expected) -> None:
    assert rules.normalize_gap(value) == expected


def test_grade_by_type() -> None:
    choice = key("single_choice", 1, ["a", "b", "c"])
    assert rules.grade(choice, 1).correct and not rules.grade(choice, 0).correct
    assert rules.grade(choice, "b").correct and not rules.grade(choice, [1]).correct
    assert rules.grade(choice, 1).your_answer == "b" and rules.grade(choice, 7).your_answer == "7"
    gap = key("gap_fill", ["I'm", "I am"])
    assert rules.grade(gap, "i’m!").correct and rules.grade(gap, "I  AM").correct and rules.grade(gap, ["i am"]).correct
    assert not rules.grade(gap, "Im").correct and not rules.grade(gap, "?").correct
    words = key("order_words", ["My", "name"], ["name", "My"])
    assert rules.grade(words, ["My", "name"]).correct and rules.grade(words, [1, 0]).correct
    assert rules.grade(words, "My  name").correct and not rules.grade(words, ["name", "My"]).correct
    lines = key("order_lines", [2, 0, 1], ["b", "c", "a"])
    assert rules.grade(lines, ["a", "b", "c"]).correct and rules.grade(lines, [2, 0, 1]).correct
    assert not rules.grade(lines, ["b", "c", "a"]).correct
    assert rules.grade(lines, [2, 0, 1]).correct_answer == "a / b / c"
    unanswered = rules.grade(choice, None)
    assert not unanswered.correct and not unanswered.answered and unanswered.correct_answer == "b"
    assert not rules.grade(choice, 1, dont_know=True).correct


def test_malformed_keys_are_content_errors() -> None:
    bad = {"control_items": [{"item_id": "c1", "type": "single_choice", "skill_id": "s", "prompt_en": "p",
                              "options": ["a"], "answer": 3}]}
    with pytest.raises(rules.ContentInvalid):
        rules.lesson_key_items(bad)
    with pytest.raises(rules.ContentInvalid):
        rules.exercise_key_item({"exercise_id": "e", "type": "order_lines", "skill_id": "s", "options": ["a", "b"],
                                 "answer": [0, 0]})
    assert rules.exercise_key_item({"exercise_id": "e", "type": "shadowing", "skill_id": "s", "options": [],
                                    "answer": None}) is None
    keys = rules.lesson_key_items(lesson("l-01-greetings"))
    assert [k.type for k in keys] == ["single_choice", "gap_fill", "order_words", "translate_choice", "single_choice"]


def test_scores_and_verdict() -> None:
    assert [rules.share_score(c, 5) for c in range(6)] == [0, 0, 1, 2, 3, 3]
    assert rules.share_score(0, 0) is None
    assert [rules.hints_score(n) for n in range(5)] == [3, 2, 1, 0, 0]
    assert rules.outcome_score("success", 2) == 3 and rules.outcome_score("fail", 2) == 1
    assert rules.outcome_score(None, 2) == 0 and rules.outcome_score("success", 0) == 0
    # веса нормируются по оценённым критериям
    assert rules.verdict(RUBRIC, {"task": 3, "vocabulary": None, "grammar": None, "independence": 0}) == (2.0, False, 2)
    assert rules.verdict(RUBRIC, {"task": 2, "independence": 1}) == (1.667, True, 2)
    assert rules.verdict(RUBRIC, {"task": 3}) == (None, None, 1)


def test_combine_scores_with_evaluator() -> None:
    rubric = rules.Rubric("r", 1, tuple(rules.Criterion(c, 1 / 7, {"ru": c, "uz": c}, []) for c in rules.CRITERIA),
                          1.5, 0)
    rule = {"task": 1, "vocabulary": None, "grammar": None, "independence": 2, "pronunciation": None,
            "fluency": None, "comprehension": 3}
    ai = {"task": 3, "vocabulary": 2, "grammar": True, "independence": 3, "pronunciation": 3, "fluency": 3,
          "comprehension": 0}
    assert rules.combine_scores(rubric, rule, ai, closed_present=True) == {
        "task": 1, "vocabulary": 2, "grammar": None, "independence": 2, "pronunciation": None, "fluency": None,
        "comprehension": 3}
    assert rules.combine_scores(rubric, {**rule, "comprehension": None, "task": None}, ai,
                                closed_present=False)["comprehension"] == 0


def test_verify_ai_errors() -> None:
    texts = {"T2": "I  has a   question about report.", "OA1": "She go to school."}
    base = {"correction": "fix", "error_code": "verb_form", "severity": "high"}
    errors = [
        {**base, "turn_id": "T2", "evidence": "I has a question"},  # пробелы нормализуются
        {**base, "turn_id": "T2", "evidence": "I has a question"},  # дубль
        {**base, "turn_id": "T2", "evidence": "i has"},  # регистр не тот — не дословно
        {**base, "turn_id": "T3", "evidence": "I has"},  # не реплика ученика
        {**base, "turn_id": "OA1", "evidence": "She go", "severity": "critical"},
        {**base, "turn_id": "OA1", "evidence": "She go", "error_code": "Bad Code"},
        {**base, "turn_id": "OA1", "evidence": "x" * 121},
        {**base, "turn_id": "OA1", "evidence": "She go", "correction": ""},
        {**base, "turn_id": "OA1", "evidence": "She go", "severity": "low"},
        "garbage",
    ]
    assert rules.verify_ai_errors(errors, texts) == [
        {"turn_id": "T2", "evidence": "I has a question", "correction": "fix", "error_code": "verb_form",
         "severity": "high"},
        {"turn_id": "OA1", "evidence": "She go", "correction": "fix", "error_code": "verb_form", "severity": "low"}]
    many = [{**base, "turn_id": "T2", "evidence": w} for w in ("I", "has", "a", "question", "about", "report")]
    assert len(rules.verify_ai_errors(many, texts)) == 5
    assert rules.verify_ai_errors(None, texts) == []
    ranked = rules.rank_errors([{"severity": "low", "n": 1}, {"severity": "high", "n": 2}, {"severity": "medium",
                                                                                              "n": 3}])
    assert [e["n"] for e in ranked] == [2, 3, 1]


def test_skill_outcomes_rule() -> None:
    k = [rules.KeyItem(f"i{n}", "single_choice", "s1", "", ("a", "b"), 0) for n in range(3)]
    graded = [rules.grade(k[0], 0), rules.grade(k[1], 0), rules.grade(k[2], 1)]
    assert rules.skill_outcomes(["s1", "s2"], graded, True) == [
        {"skill_id": "s1", "outcome": "demonstrated", "evidence_refs": ["i0", "i1", "i2"]},
        {"skill_id": "s2", "outcome": "not_assessed", "evidence_refs": []}]
    hinted = [rules.grade(k[0], 0, hinted=True), rules.grade(k[1], 0), rules.grade(k[2], 1)]
    assert rules.skill_outcomes(["s1"], hinted, True)[0]["outcome"] == "learning"
    assert rules.skill_outcomes(["s1"], graded, None)[0]["outcome"] == "learning"


def test_settings_require_urls_in_secure_env() -> None:
    secure = {"env": "prod", "internal_jwt_secret": "s" * 40, "internal_jwt_private_key": "a" * 43}
    with pytest.raises(ValueError, match="CATALOG_URL"):
        Settings(**secure, ai_gateway_url="https://ai.internal")
    with pytest.raises(ValueError, match="AI_GATEWAY_URL"):
        Settings(**secure, catalog_url="https://catalog.internal")
    urls = {"catalog_url": "https://catalog.internal", "ai_gateway_url": "https://ai.internal"}
    # R3-05: SCHEDULER_TOKEN обязателен в stage/prod (от tick зависит стирание текстов апелляций)
    for bad in ({}, {"scheduler_token": "short"}):
        with pytest.raises(ValueError, match="SCHEDULER_TOKEN"):
            Settings(**secure, **urls, **bad)
    s = Settings(**secure, **urls, scheduler_token="t" * 43)
    assert s.port == 8113 and s.db_schema == "assessment"
    with pytest.raises(ValueError, match="http"):
        Settings(env="test", catalog_url="ftp://x")


async def test_concurrent_evaluations_of_one_session(env, user) -> None:
    body = lesson_request("l-01-greetings", session_id=uuid.uuid4())
    responses = await asyncio.gather(*(env.c.post("/internal/v1/evaluations", json=body, headers=env.lessons(user))
                                       for _ in range(4)))
    assert sorted(r.status_code for r in responses) == [200, 200, 200, 201]
    assert len({r.json()["evaluation_id"] for r in responses}) == 1
    assert len(await env.events("assessment.completed.v1", user)) == 1
