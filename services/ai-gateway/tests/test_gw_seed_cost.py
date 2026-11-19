"""Ревью R1-02: параметры independent_evaluator v2 (сид 0003) — контекст оценки самого длинного сид-урока помещается в
лимит версии и урока. Контекст собирается как в assessment (`_evaluator_context`) из сида catalog: урок l-19-first-day
со сценарием sc-work-first-day (самый длинный путь графа), 2 уточнения (реплика ученика + уточнение персонажа ≤ 240),
вопрос открытого задания и открытый ответ 300 символов; описательные поля — русская локализация (INTERNAL_API §9)."""

from __future__ import annotations

import json
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from conftest import SERVICE_DIR, make_env
from gw_kit import ScriptedProvider

from tilhero_ai_gateway.contracts import validate_context
from tilhero_ai_gateway.domain.budget import estimate_cost
from tilhero_ai_gateway.domain.messages import build_prompt, sanitize_context
from tilhero_ai_gateway.models import ModelRow

CATALOG = Path(SERVICE_DIR).parents[0] / "catalog" / "migrations" / "seed"
SEED = Path(SERVICE_DIR) / "migrations" / "seed"
SONNET = ModelRow(model_id="claude-sonnet-5-5", provider="anthropic", input_usd_per_mtok=Decimal("2.00"),
                  output_usd_per_mtok=Decimal("10.00"), active=True)
HAIKU = ModelRow(model_id="claude-haiku-5-5", provider="anthropic", input_usd_per_mtok=Decimal("0.10"),
                 output_usd_per_mtok=Decimal("0.50"), active=True)
LESSON = "l-19-first-day"


def _load(name: str) -> dict[str, dict[str, Any]]:
    items = json.loads((CATALOG / f"{name}.json").read_text(encoding="utf-8"))
    key = {"scenarios": "scenario_id", "lessons": "lesson_id", "rubrics": "rubric_id"}[name]
    return {i[key]: i for i in items}


def longest_path(scenario: dict[str, Any]) -> list[str]:
    """Самый длинный (по тексту реплик персонажа) путь от start_node до конца сценария."""
    nodes = scenario["nodes"]
    best: tuple[int, list[str]] = (-1, [])

    def walk(node_id: str, path: list[str]) -> None:
        nonlocal best
        path = [*path, node_id]
        node = nodes[node_id]
        if node.get("end"):
            size = sum(len(nodes[n]["line_en"]) for n in path)
            best = max(best, (size, path))
            return
        for t in node["transitions"]:
            if t["to"] not in path:
                walk(t["to"], path)

    walk(scenario["start_node"], [])
    return best[1]


def lesson_context(lesson_id: str, *, learner_len: int | None = None, clarifications: int = 2,
                   open_answer: int = 300) -> dict[str, Any]:
    lesson = _load("lessons")[lesson_id]
    scenario = _load("scenarios")[lesson["scenario_id"]]
    rubric = _load("rubrics")[lesson["rubric_id"]]
    path = longest_path(scenario)
    turns: list[dict[str, str]] = []

    def add(speaker: str, text: str) -> None:
        turns.append({"turn_id": f"T{len(turns) + 1}", "speaker": speaker, "text": text[:500]})

    for i, node_id in enumerate(path):
        node = scenario["nodes"][node_id]
        add("character", node["line_en"])
        if node.get("end"):
            break
        transition = next(t for t in node["transitions"] if t["to"] == path[i + 1])
        if i < clarifications:  # непонятая реплика ученика и уточняющий вопрос персонажа (ответ ИИ ≤ 240)
            add("learner", "I am not sure what I need to say here, sorry, can you repeat the question please?")
            add("character", ("Sorry, I didn't quite catch that. " * 8)[:240])
        example = max(transition["examples_en"], key=len)
        add("learner", example if learner_len is None else ((example + " ") * 30)[:learner_len])
    goal = lesson["goal"]["ru"]
    turns.append({"turn_id": "Q1", "speaker": "task",
                  "text": f"Напишите 2–3 предложения по задаче урока: «{goal}»"[:300]})
    turns.append({"turn_id": "OA1", "speaker": "learner",
                  "text": ("I am Aziz, the new designer. I am going to work on the delivery app. " * 6)[:open_answer]})
    assert len(turns[-1]["text"]) == open_answer
    return {
        "rubric": {"rubric_id": rubric["rubric_id"], "version": 1,
                   "criteria": [{"code": c["code"], "weight": c["weight"],
                                 "bands": [{"score": b["score"], "descriptor_en": b["descriptor"]["ru"]}
                                           for b in c["bands"]]} for c in rubric["criteria"]],
                   "pass_rule": rubric["pass_rule"]},
        "task": {"goal_en": goal, "completion_criteria_en": scenario["completion"]["criteria"]["ru"],
                 "outcome": "success"},
        "turns": turns,
        "hint_usage": {"count": 0, "turn_ids": []},
        "cefr_target": lesson["level"],
    }


def version(path: str) -> dict[str, Any]:
    return dict(json.loads((SEED / path).read_text(encoding="utf-8")))


def worst_case(body: dict[str, Any], context: dict[str, Any], model: ModelRow) -> Decimal:
    norm, errors = validate_context("independent_evaluator", context)
    assert norm is not None, errors
    prompt = build_prompt(instructions=body["instructions"], rules=body["rules"], output_schema=body["output_schema"],
                          schema_version=body["schema_version"], locale="ru",
                          context=sanitize_context("independent_evaluator", norm))
    return estimate_cost(model, input_chars=len(prompt.system) + len(prompt.user),
                         max_output_tokens=body["max_output_tokens"])


def test_longest_seed_lesson_is_first_day() -> None:
    """l-19-first-day (sc-work-first-day) — самый длинный контекст оценщика среди сид-уроков со сценарием."""
    v2 = version("0003/agents/independent_evaluator.v2.json")
    sizes = {lid: worst_case(v2, lesson_context(lid), SONNET) for lid, lesson in _load("lessons").items()
             if lesson.get("scenario_id") and {"teens", "adults"} & set(lesson["audience"])}
    assert max(sizes, key=lambda k: sizes[k]) == LESSON
    assert _load("lessons")[LESSON]["scenario_id"] == "sc-work-first-day"


def test_v2_fits_version_limit_v1_did_not() -> None:
    v1, v2 = version("agents/independent_evaluator.v1.json"), version("0003/agents/independent_evaluator.v2.json")
    assert (v2["max_output_tokens"], v2["max_cost_usd"], v2["timeout_ms"]) == (600, 0.03, 12000)
    assert (v2["instructions"], v2["rules"], v2["output_schema"]) == (v1["instructions"], v1["rules"],
                                                                      v1["output_schema"])
    ctx = lesson_context(LESSON)
    assert len(ctx["turns"]) >= 20  # 11 реплик персонажа, 9 ответов, 2 уточнения, вопрос и ответ
    first = worst_case(v2, ctx, SONNET)
    assert first <= Decimal("0.0175") < Decimal(str(v2["max_cost_usd"]))  # 0.0169 на 19.11.2026
    # и при репликах ученика по 500 символов (предел шлюза) — помещается
    assert worst_case(v2, lesson_context(LESSON, learner_len=500), SONNET) <= Decimal("0.03")
    # v1: 900 токенов вывода при лимите 0.02 — впритык (повтор не помещался), с длинными репликами — нет вовсе
    assert Decimal("0.019") < worst_case(v1, ctx, SONNET) <= Decimal(str(v1["max_cost_usd"]))
    assert worst_case(v1, lesson_context(LESSON, learner_len=500), SONNET) > Decimal(str(v1["max_cost_usd"]))
    # повтор на sonnet после оплаченной попытки не помещается в лимит версии → резервная haiku помещается
    assert first * 2 > Decimal("0.03") and first + worst_case(v2, ctx, HAIKU) <= Decimal("0.03")


@pytest.fixture
async def real_seed():
    provider = ScriptedProvider()
    async for e in make_env(provider=provider, seed_dir=None):  # сид migrations/seed (0002 + 0003)
        e.provider = provider
        yield e


async def test_gateway_invokes_primary_model_for_longest_lesson(real_seed) -> None:
    """Через шлюз на реальном сиде: v2 опубликована, оценщик вызывается на основной модели даже после реплик
    партнёра в том же уроке (лимит урока 0.03); таймаут попытки — min(12 с, дедлайн assessment 25 с − 0,5 с)."""
    gw = real_seed
    output = {"status": "ok", "scores": {"task": 3, "vocabulary": 2, "grammar": 2, "independence": 3},
              "task_completed": True, "confirmed_errors": [], "support_used": False, "confidence": 0.9,
              "pronunciation_score": None, "cefr_certificate": False, "requires_human_review": False}
    gw.provider.responses = [(json.dumps(output), 6000, 200)]
    session, learner = uuid.uuid4(), uuid.uuid4()
    for _ in range(10):  # 10 реплик conversation_partner в этом уроке (~0.0004 каждая)
        await gw.sql("INSERT INTO usage (call_id, request_id, caller, agent_id, provider, status, cost_usd, user_id, "
                     "session_id, session_kind, created_at, finished_at) VALUES ($1, $2, 'lessons', "
                     "'conversation_partner', 'anthropic', 'ok', 0.0004, $3, $4, 'lesson', $5, $5)",
                     uuid.uuid4(), uuid.uuid4(), learner, session, gw.now)
    body = gw.body("independent_evaluator", lesson_context(LESSON), user_id=learner, session_id=session)
    body["deadline_ms"] = 25_000
    r = await gw.c.post("/internal/v1/agents/independent_evaluator/invoke", json=body,
                        headers=gw.svc("assessment", str(learner)))
    res = r.json()
    assert (res["status"], res["agent_version"], res["model_id"]) == ("ok", 2, "claude-sonnet-5-5"), res
    [call] = gw.provider.calls
    assert call.max_tokens == 600 and call.timeout_s == 12.0
