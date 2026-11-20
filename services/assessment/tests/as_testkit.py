"""Тестовый набор assessment: заглушки catalog и ai-gateway (httpx.MockTransport) на реальном сид-контенте
catalog (`services/catalog/migrations/seed/*.json`), ответы «ученика» по ключу и построители EvaluationRequest."""

from __future__ import annotations

import copy
import json
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import jwt

SEED = Path(__file__).resolve().parents[2] / "catalog" / "migrations" / "seed"
ID_FIELD = {"lesson": "lesson_id", "scenario": "scenario_id", "rubric": "rubric_id", "media_asset": "asset_id",
            "media_exercise": "exercise_id"}
SEED_FILES = {"lesson": "lessons.json", "scenario": "scenarios.json", "rubric": "rubrics.json",
              "media_asset": "media.json", "media_exercise": "media_exercises.json"}
CHOICE = {"single_choice", "translate_choice", "comprehension", "phrase_meaning", "true_false"}


def load_seed() -> dict[str, dict[str, dict[str, Any]]]:
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for kind, name in SEED_FILES.items():
        items = json.loads((SEED / name).read_text())
        out[kind] = {i[ID_FIELD[kind]]: i for i in items}
    return out


SEED_CONTENT = load_seed()


def load_seed_readings() -> dict[str, dict[str, Any]]:
    """Сид текстов catalog спринта 5 (исполнитель B), если уже есть — проверка, что все вопросы оцениваются."""
    path = SEED / "readings.json"
    if not path.exists():
        return {}
    return {str(x["reading_id"]): x for x in json.loads(path.read_text())}


SEED_READINGS = load_seed_readings()


def _loc(ru: str, uz: str) -> dict[str, str]:
    return {"ru": ru, "uz": uz}


# Текст для чтения (ReadingPayload, content.ts спринта 5) — сид catalog делает исполнитель B; здесь — свой.
READINGS: dict[str, dict[str, Any]] = {
    "r-a1-coffee-shop": {
        "reading_id": "r-a1-coffee-shop", "title": _loc("В кофейне", "Qahvaxonada"), "level": "A1",
        "audience": ["teens", "adults"], "topics": ["food"], "skill_ids": ["read-a1-short-texts"],
        "paragraphs": [{"p_id": "p1", "sentences": [
            {"s_id": "s1", "text_en": "Every morning Anna orders a latte.", "gloss": _loc("…", "…")},
            {"s_id": "s2", "text_en": "On Fridays she pays for her friend too.", "gloss": _loc("…", "…")}]}],
        "glossary": [{"en": "orders", "gloss": _loc("заказывает", "buyurtma qiladi"), "note": None},
                     {"en": "pays for", "gloss": _loc("платит за", "toʻlaydi"), "note": None},
                     {"en": "latte", "gloss": _loc("латте", "latte"), "note": None}],
        "questions": [
            {"question_id": "rq-coffee-1", "type": "single_choice", "instruction": _loc("Выберите", "Tanlang"),
             "prompt_en": "What does Anna order?", "options": ["Tea", "A latte", "Juice"], "answer": 1},
            {"question_id": "rq-coffee-2", "type": "true_false", "instruction": _loc("Верно?", "Toʻgʻrimi?"),
             "prompt_en": "Anna pays for her friend on Mondays.", "options": ["True", "False"], "answer": 1},
            {"question_id": "rq-coffee-3", "type": "gap_fill", "instruction": _loc("Вставьте", "Qoʻying"),
             "prompt_en": "On Fridays she ___ for her friend.", "options": [], "answer": ["pays", "paid"]},
        ],
        "voice": "en-GB", "est_minutes": 4,
    },
}


def lesson(lesson_id: str) -> dict[str, Any]:
    return SEED_CONTENT["lesson"][lesson_id]


def scenario(scenario_id: str) -> dict[str, Any]:
    return SEED_CONTENT["scenario"][scenario_id]


def exercises_of(asset_id: str) -> list[dict[str, Any]]:
    return [e for e in SEED_CONTENT["media_exercise"].values() if e["asset_id"] == asset_id]


def _token_claims(request: httpx.Request) -> dict[str, Any]:
    token = request.headers.get("x-internal-token", "")
    return jwt.decode(token, options={"verify_signature": False})


class FakeCatalog:
    """`GET /internal/v1/versions/{kind}/{key}/{version}`: сид — версия 1 (published); extra — другие версии;
    drafts — версии-черновики (catalog отвечает 404); down — 503."""

    def __init__(self) -> None:
        self.content = copy.deepcopy(SEED_CONTENT)
        self.content["reading"] = copy.deepcopy({**SEED_READINGS, **READINGS})
        self.extra: dict[tuple[str, str, int], dict[str, Any]] = {}
        self.statuses: dict[tuple[str, str, int], str] = {}
        self.down = False
        self.calls: list[tuple[str, str, int]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        claims = _token_claims(request)
        assert claims["aud"] == "catalog" and claims["iss"] == "assessment", claims
        parts = request.url.path.split("/")
        if self.down:
            return httpx.Response(503, json={"code": "UNAVAILABLE", "message": "down", "trace_id": "t", "details": {}})
        if len(parts) != 7 or parts[1:4] != ["internal", "v1", "versions"]:
            return httpx.Response(404, json={"code": "NOT_FOUND", "message": "", "trace_id": "t", "details": {}})
        kind, key, version = parts[4], parts[5], int(parts[6])
        self.calls.append((kind, key, version))
        payload = self.extra.get((kind, key, version))
        if payload is None and version == 1:
            payload = self.content.get(kind, {}).get(key)
        if payload is None:
            return httpx.Response(404, json={"code": "VERSION_NOT_FOUND", "message": "", "trace_id": "t",
                                             "details": {}})
        status = self.statuses.get((kind, key, version), "published")
        return httpx.Response(200, json={"kind": kind, "key": key, "version": version, "status": status,
                                         "payload": payload, "payload_hash": "h"})


def evaluator_output(**kw: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"status": "ok", "scores": {}, "task_completed": True, "confirmed_errors": [],
                           "support_used": False, "confidence": 0.9, "pronunciation_score": None,
                           "cefr_certificate": False, "requires_human_review": False}
    out.update(kw)
    return out


class FakeAi:
    """`POST /internal/v1/agents/independent_evaluator/invoke`. mode: ok | unavailable | refused | http500 | timeout |
    garbage | busy (409 IDEMPOTENCY_IN_PROGRESS — тот же вызов ещё идёт). output — вывод оценщика при ok (по умолчанию
    — все критерии 3)."""

    def __init__(self) -> None:
        self.mode = "ok"
        self.reason = "ai_disabled"
        self.output: dict[str, Any] | Callable[[dict[str, Any]], dict[str, Any]] | None = None
        self.requests: list[dict[str, Any]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        claims = _token_claims(request)
        assert claims["aud"] == "ai-gateway" and claims["iss"] == "assessment", claims
        assert request.url.path == "/internal/v1/agents/independent_evaluator/invoke", request.url.path
        body = json.loads(request.content)
        self.requests.append(body)
        if self.mode == "timeout":
            raise httpx.ReadTimeout("timeout", request=request)
        if self.mode == "busy":
            return httpx.Response(409, json={"code": "IDEMPOTENCY_IN_PROGRESS", "message": "", "trace_id": "t",
                                             "details": {}})
        if self.mode == "http500":
            return httpx.Response(500, json={"code": "INTERNAL_ERROR", "message": "", "trace_id": "t", "details": {}})
        if self.mode == "garbage":
            return httpx.Response(200, json={"status": "ok", "output": {"status": "great", "scores": "all"}})
        base = {"agent_id": "independent_evaluator", "agent_version": 3, "prompt_version": "independent_evaluator@3",
                "schema_version": "independent_evaluator.v1", "model_id": "fake", "canary": False, "cost_usd": 0,
                "latency_ms": 5, "warnings": []}
        if self.mode in ("unavailable", "refused"):
            return httpx.Response(200, json={**base, "status": self.mode, "reason": self.reason, "output": None,
                                             "agent_version": None, "prompt_version": None, "schema_version": None,
                                             "model_id": None})
        output = self.output(body) if callable(self.output) else (self.output or evaluator_output(
            scores={c["code"]: 3 for c in body["context"]["rubric"]["criteria"]}))
        return httpx.Response(200, json={**base, "status": "ok", "reason": None, "output": output})


# ---------------------------------------------------------------- ответы ученика


def correct_answer(item: dict[str, Any], *, styled: bool = False) -> Any:
    t = item["type"]
    if t in CHOICE:
        return item["answer"]
    if t == "gap_fill":
        a = item["answer"][0]
        return f"  {a.upper()}!" if styled else a
    if t == "order_words":
        return list(item["answer"])
    return [item["options"][i] for i in item["answer"]]  # order_lines — реплики по порядку


def wrong_answer(item: dict[str, Any]) -> Any:
    t = item["type"]
    if t in CHOICE:
        return (item["answer"] + 1) % len(item["options"])
    if t == "gap_fill":
        return "zzz"
    if t == "order_words":
        return list(reversed(item["answer"]))
    return [item["options"][i] for i in reversed(item["answer"])]


Policy = Callable[[dict[str, Any]], str]  # item → correct | wrong | skip | dont_know | hinted


def always(kind: str) -> Policy:
    return lambda _item: kind


def answers_for(items: list[dict[str, Any]], policy: Policy, id_field: str = "item_id") -> list[dict[str, Any]]:
    out = []
    for item in items:
        kind = policy(item)
        if kind == "skip":
            continue
        entry: dict[str, Any] = {"item_id": item[id_field]}
        if kind == "dont_know":
            entry.update(answer=None, dont_know=True)
        elif kind == "wrong":
            entry["answer"] = wrong_answer(item)
        else:
            entry["answer"] = correct_answer(item)
            if kind == "hinted":
                entry["hinted"] = True
        out.append(entry)
    return out


def choice_turns(scenario_id: str, *, steps: int = 3, hinted: tuple[int, ...] = ()) -> list[dict[str, Any]]:
    """Реплики сцены выбором вариантов: персонаж (line_en узла) и ученик (examples_en[0] первого перехода)."""
    sc = scenario(scenario_id)
    node_id, turns, n = sc["start_node"], [], 1
    for step in range(steps):
        node = sc["nodes"][node_id]
        if not node["transitions"]:
            break
        turns.append({"turn_id": f"T{n}", "speaker": "character", "text": node["line_en"], "node_id": node_id})
        tr = node["transitions"][0]
        turns.append({"turn_id": f"T{n + 1}", "speaker": "learner", "text": tr["examples_en"][0], "mode": "choice",
                      "hinted": step in hinted, "node_id": node_id})
        n += 2
        node_id = tr["to"]
    return turns


def lesson_request(lesson_id: str, *, session_id: uuid.UUID | None = None, policy: Policy = always("correct"),
                   audience: str = "adults", outcome: str | None = "success", roleplay_hints: int = 0,
                   turns: list[dict[str, Any]] | None = None, open_answer: str | None = None,
                   **kw: Any) -> dict[str, Any]:
    ls = lesson(lesson_id)
    refs = [{"kind": "lesson", "key": lesson_id, "version": 1},
            {"kind": "rubric", "key": ls["rubric_id"], "version": 1}]
    if ls["scenario_id"]:
        refs.append({"kind": "scenario", "key": ls["scenario_id"], "version": 1})
    body: dict[str, Any] = {
        "session_id": str(session_id or uuid.uuid4()), "kind": "lesson", "pair_id": "ru-en", "audience": audience,
        "content_refs": refs, "answers": answers_for(ls["control_items"], policy),
        "turns": turns if turns is not None else (choice_turns(ls["scenario_id"]) if ls["scenario_id"] else []),
        "roleplay": {"outcome": outcome, "hints": roleplay_hints} if ls["scenario_id"] else None,
        "open_answer": {"text": open_answer} if open_answer is not None else None,
    }
    body.update(kw)
    return body


def scenario_request(scenario_id: str, *, outcome: str | None = "success", hints: int = 0,
                     turns: list[dict[str, Any]] | None = None, audience: str = "adults", **kw: Any) -> dict[str, Any]:
    sc = scenario(scenario_id)
    body: dict[str, Any] = {
        "session_id": str(uuid.uuid4()), "kind": "scenario", "pair_id": "ru-en", "audience": audience,
        "content_refs": [{"kind": "scenario", "key": scenario_id, "version": 1},
                         {"kind": "rubric", "key": sc["rubric_id"], "version": 1}],
        "turns": turns if turns is not None else choice_turns(scenario_id),
        "roleplay": {"outcome": outcome, "hints": hints},
    }
    body.update(kw)
    return body


def media_request(asset_id: str, *, policy: Policy = always("correct"), audience: str = "adults",
                  **kw: Any) -> dict[str, Any]:
    exercises = exercises_of(asset_id)
    rubric = next(e["rubric_id"] for e in exercises if e["rubric_id"])
    body: dict[str, Any] = {
        "session_id": str(uuid.uuid4()), "kind": "media", "pair_id": "ru-en", "audience": audience,
        "content_refs": [{"kind": "media_asset", "key": asset_id, "version": 1},
                         *({"kind": "media_exercise", "key": e["exercise_id"], "version": 1} for e in exercises),
                         {"kind": "rubric", "key": rubric, "version": 1}],
        "answers": answers_for(exercises, policy, id_field="exercise_id"),
    }
    body.update(kw)
    return body


def reading_request(reading_id: str = "r-a1-coffee-shop", *, policy: Policy = always("correct"),
                    audience: str = "adults", **kw: Any) -> dict[str, Any]:
    """EvaluationRequest чтения (lessons, спринт 5): только ссылка на версию текста, ответы на вопросы."""
    body: dict[str, Any] = {
        "session_id": str(uuid.uuid4()), "kind": "reading", "pair_id": "ru-en", "audience": audience,
        "content_refs": {"reading": {"key": reading_id, "version": 1}},
        "answers": answers_for({**SEED_READINGS, **READINGS}[reading_id]["questions"], policy,
                               id_field="question_id"),
        "turns": [], "roleplay": None, "open_answer": None, "practice_only": True,
    }
    body.update(kw)
    return body


def text_turns(*learner: str, scenario_id: str = "sc-meet-phone-number") -> list[dict[str, Any]]:
    """Ролевая ситуация свободным текстом: реплика персонажа и ответ ученика по очереди."""
    sc = scenario(scenario_id)
    line = sc["nodes"][sc["start_node"]]["line_en"]
    turns: list[dict[str, Any]] = []
    for i, text in enumerate(learner):
        turns.append({"turn_id": f"T{2 * i + 1}", "speaker": "character", "text": line})
        turns.append({"turn_id": f"T{2 * i + 2}", "speaker": "learner", "text": text, "mode": "text"})
    return turns
