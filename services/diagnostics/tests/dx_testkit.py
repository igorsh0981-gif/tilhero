"""Тестовый набор diagnostics: снимок курса en-core (по карте сид-контента спринта 3), заглушка catalog
(httpx.MockTransport: пары, снимок с ETag/304, «недоступен»), ответы «ученика» по ключу из БД."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

# (skill_id, area, level, prerequisites) — подмножество карты навыков CONTENT_MAP (тег диагностики = id без «en.»)
SKILLS: list[tuple[str, str, str, list[str]]] = [
    ("en.func.greet", "function", "A0", []),
    ("en.func.introduce", "function", "A0", ["en.func.greet"]),
    ("en.func.where-from", "function", "A1", ["en.func.introduce"]),
    ("en.func.numbers-phone", "function", "A1", ["en.voc.numbers"]),
    ("en.func.talk-family", "function", "A1", ["en.voc.family"]),
    ("en.func.talk-job", "function", "A1", []),
    ("en.func.free-time", "function", "A1", []),
    ("en.func.order-drink", "function", "A1", ["en.voc.food-drink"]),
    ("en.func.ask-price", "function", "A1", ["en.voc.numbers"]),
    ("en.func.ask-way", "function", "A1", ["en.voc.city-places"]),
    ("en.func.check-in-flight", "function", "A2", ["en.voc.travel"]),
    ("en.gram.to-be", "grammar", "A0", []),
    ("en.gram.pronouns-possessives", "grammar", "A0", []),
    ("en.gram.present-simple", "grammar", "A1", ["en.gram.to-be"]),
    ("en.gram.past-simple", "grammar", "A2", ["en.gram.present-simple"]),
    ("en.voc.numbers", "vocabulary", "A0", []),
    ("en.voc.family", "vocabulary", "A0", []),
    ("en.voc.food-drink", "vocabulary", "A1", []),
    ("en.voc.city-places", "vocabulary", "A1", []),
    ("en.voc.travel", "vocabulary", "A2", []),
    ("en.read.signs-menus", "reading", "A1", []),
    ("en.listen.numbers-times", "listening", "A1", []),
]

# (lesson_id, module_id, primary_skill, level, kind, audience, prerequisite_skill_ids)
LESSONS: list[tuple[str, str, str, str, str, list[str], list[str]]] = [
    ("l-01-greetings", "m1-meet", "en.func.greet", "A0", "core", ["kids", "teens", "adults"], []),
    ("l-02-where-from", "m1-meet", "en.func.where-from", "A1", "core", ["kids", "teens", "adults"],
     ["en.func.greet"]),
    ("l-03-phone-number", "m1-meet", "en.func.numbers-phone", "A1", "core", ["teens", "adults"], []),
    ("l-04-family", "m1-meet", "en.func.talk-family", "A1", "core", ["kids", "teens", "adults"], []),
    ("l-05-jobs", "m1-meet", "en.func.talk-job", "A1", "core", ["teens", "adults"], ["en.gram.present-simple"]),
    ("l-06-free-time", "m1-meet", "en.func.free-time", "A1", "optional", ["kids", "teens", "adults"], []),
    ("l-07-coffee", "m2-city", "en.func.order-drink", "A1", "core", ["kids", "teens", "adults"], []),
    ("l-10-market", "m2-city", "en.func.ask-price", "A1", "core", ["kids", "teens", "adults"], []),
    ("l-11-directions", "m2-city", "en.func.ask-way", "A1", "core", ["kids", "teens", "adults"], []),
    ("l-13-flight-check-in", "m3-travel", "en.func.check-in-flight", "A2", "core", ["teens", "adults"],
     ["en.gram.past-simple"]),
]
MODULES = ["m1-meet", "m2-city", "m3-travel"]


def localized(text: str) -> dict[str, str]:
    return {"ru": f"{text} (ru)", "uz": f"{text} (uz)"}


def course_snapshot(version: str = "snap-1") -> dict[str, Any]:
    return {
        "course_id": "en-core", "pair_id": "ru-en", "snapshot_version": version,
        "title": localized("English core"), "level_start": "A0", "level_end": "A2",
        "modules": [{"module_id": m, "title": localized(m), "goal": localized(m), "theme": "travel",
                     "lesson_ids": [ls[0] for ls in LESSONS if ls[1] == m]} for m in MODULES],
        "skills": [{"skill_id": sid, "area": area, "title": localized(sid), "level": level, "prerequisites": pre,
                    "diagnostic_tags": [sid[3:]]} for sid, area, level, pre in SKILLS],
        "lessons": [{
            "lesson_id": lid, "module_id": mid, "title": localized(lid), "goal": localized(lid), "level": level,
            "kind": kind, "duration_min": 20, "primary_skill_id": primary, "scenario_id": None, "stages": [],
            "audience": audience, "goals": [], "topics": [], "secondary_skill_ids": [],
            "prerequisite_skill_ids": prereq, "control_item_types": [],
        } for lid, mid, primary, level, kind, audience, prereq in LESSONS],
    }


PAIRS = [
    {"pair_id": "ru-en", "source": "ru", "target": "en", "explanation_locales": ["ru"], "ui_locales": ["ru", "uz"],
     "title": localized("Английский"), "status": "published", "release_at": None, "course_id": "en-core"},
    {"pair_id": "ru-uz", "source": "ru", "target": "uz", "explanation_locales": ["ru"], "ui_locales": ["ru", "uz"],
     "title": localized("Узбекский"), "status": "planned", "release_at": None, "course_id": None},
]


class FakeCatalog:
    """catalog: GET /internal/v1/pairs, GET /internal/v1/courses/en-core/snapshot (ETag, If-None-Match → 304)."""

    def __init__(self) -> None:
        self.down = False
        self.snapshot: dict[str, Any] | None = course_snapshot()
        self.etag = '"snap-1"'
        self.pairs = [dict(p) for p in PAIRS]
        self.calls: list[tuple[str, str | None]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append((request.url.path, request.headers.get("if-none-match")))
        assert request.headers.get("x-internal-token"), "internal JWT is required"
        if self.down:
            return httpx.Response(503, json={"code": "UNAVAILABLE", "message": "down", "trace_id": "t",
                                             "details": {}})
        if request.url.path == "/internal/v1/pairs":
            return httpx.Response(200, json={"items": self.pairs})
        if request.url.path == "/internal/v1/courses/en-core/snapshot" and self.snapshot is not None:
            if request.headers.get("if-none-match") == self.etag:
                return httpx.Response(304, headers={"etag": self.etag})
            return httpx.Response(200, content=json.dumps(self.snapshot), headers={
                "etag": self.etag, "content-type": "application/json"})
        return httpx.Response(404, json={"code": "NOT_FOUND", "message": "nf", "trace_id": "t", "details": {}})


# ---------------------------------------------------------------- ответы «ученика»

Policy = Callable[[dict[str, Any]], str]  # задание с ключом → "correct" | "wrong" | "dont_know"


def correct_answer(item: dict[str, Any]) -> Any:
    return item["answer"]


def wrong_answer(item: dict[str, Any]) -> Any:
    if item["type"] == "order_words":
        return list(item["options"])  # показанный порядок ≠ ключу (проверка сида)
    return (item["answer"] + 1) % len(item["options"])


def always(kind: str) -> Policy:
    return lambda item: kind


def up_to(band: str) -> Policy:
    order = ["A0", "A1", "A2", "B1", "B2"]
    return lambda item: "correct" if order.index(item["band"]) <= order.index(band) else "wrong"


# ---------------------------------------------------------------- реальный снимок курса из сида catalog

CATALOG_SEED = Path(__file__).resolve().parents[2] / "catalog" / "migrations" / "seed"
BAND_ORDER = ["A0", "A1", "A2", "B1", "B2"]


def seed_snapshot() -> dict[str, Any] | None:
    """CourseSnapshot en-core из `services/catalog/migrations/seed/` — тем же отображением, что
    catalog.domain.learner.course_snapshot (порядок модулей курса и уроков модуля, навыки по уровню и id).
    None — сида catalog нет (тест пропускается)."""
    try:
        def load(name: str) -> Any:
            return json.loads((CATALOG_SEED / name).read_text(encoding="utf-8"))

        course = load("course.json")
        modules = {m["module_id"]: m for m in load("modules.json")}
        lessons = {ls["lesson_id"]: ls for ls in load("lessons.json")}
        skills = load("skills.json")
    except (OSError, ValueError):
        return None
    out_modules, out_lessons = [], []
    for mid in course["module_ids"]:
        m = modules.get(mid)
        if m is None:
            continue
        out_modules.append({"module_id": mid, "title": m["title"], "goal": m["goal"], "theme": m["theme"],
                            "lesson_ids": [lid for lid in m["lesson_ids"] if lid in lessons]})
        for lid in m["lesson_ids"]:
            p = lessons.get(lid)
            if p is None:
                continue
            out_lessons.append({
                "lesson_id": lid, "module_id": p["module_id"], "title": p["title"], "goal": p["goal"],
                "level": p["level"], "kind": p["kind"], "duration_min": p["duration_min"],
                "primary_skill_id": p["primary_skill_id"], "scenario_id": p.get("scenario_id"),
                "stages": [{"type": s["type"], "minutes": s["minutes"]} for s in p["stages"]],
                "audience": p["audience"], "goals": p["goals"], "topics": p["topics"],
                "secondary_skill_ids": p["secondary_skill_ids"], "prerequisite_skill_ids": p["prerequisite_skill_ids"],
                "control_item_types": [item["type"] for item in p.get("control_items", [])],
            })
    skills = [s for s in skills if s.get("course_id") == course["course_id"]]
    skills.sort(key=lambda s: (BAND_ORDER.index(s["level"]), s["skill_id"]))
    return {
        "course_id": course["course_id"], "pair_id": course["pair_id"], "snapshot_version": "catalog-seed",
        "title": course["title"], "level_start": course["level_start"], "level_end": course["level_end"],
        "modules": out_modules, "lessons": out_lessons,
        "skills": [{"skill_id": s["skill_id"], "area": s["area"], "title": s["title"], "level": s["level"],
                    "prerequisites": s["prerequisites"], "diagnostic_tags": s["diagnostic_tags"]} for s in skills],
    }
