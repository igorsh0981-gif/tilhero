"""Заготовленные снимки курса (контракт CourseSnapshot, bff.ts) и фейковый catalog для тестов траектории.

Курс `en-core` (пара ru-en), порядок модулей m1 → m2 → m3:
  m1 (A0): greet, be, numbers                         — core, все аудитории
  m2 (A1): family, present, routine*, animals(kids), listen; cafe (optional), song (optional, kids)
  m3 (A2): past*, travel*, hotel*; interview (optional, adults), office (optional)
  * — только teens/adults. Предпосылки навыков: family, present ← be; routine, past ← present; travel ← numbers;
    hotel ← travel, past. У урока routine ещё и своя предпосылка present (дубль — проверка без повторов).
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from typing import Any

import httpx
import jwt

COURSE = "en-core"
SNAPSHOT_PATH = f"/internal/v1/courses/{COURSE}/snapshot"
ALL = ["kids", "teens", "adults"]
OLDER = ["teens", "adults"]
STAGES = [{"type": "retrieval", "minutes": 3}, {"type": "explanation", "minutes": 4},
          {"type": "roleplay", "minutes": 7}, {"type": "assessment", "minutes": 4}, {"type": "summary", "minutes": 2}]


def loc(text: str) -> dict[str, str]:
    return {"ru": f"{text} (ru)", "uz": f"{text} (uz)"}


def skill(skill_id: str, area: str, level: str, prerequisites: list[str] | None = None) -> dict[str, Any]:
    return {"skill_id": skill_id, "area": area, "title": loc(skill_id), "level": level,
            "prerequisites": prerequisites or [], "diagnostic_tags": [skill_id.split(".", 1)[-1]]}


def lesson(lesson_id: str, module_id: str, primary: str, level: str, *, kind: str = "core",
           audience: list[str] | None = None, goals: list[str] | None = None, topics: list[str] | None = None,
           prereqs: list[str] | None = None, scenario: str | None = None) -> dict[str, Any]:
    return {
        "lesson_id": lesson_id, "module_id": module_id, "title": loc(lesson_id), "goal": loc(f"goal {lesson_id}"),
        "level": level, "kind": kind, "duration_min": 20, "primary_skill_id": primary, "scenario_id": scenario,
        "stages": STAGES, "audience": audience or ALL, "goals": goals or [], "topics": topics or [],
        "secondary_skill_ids": [], "prerequisite_skill_ids": prereqs or [],
        "control_item_types": ["single_choice", "gap_fill", "order_words"],
    }


def course(version: str = "snap-1") -> dict[str, Any]:
    lessons = [
        lesson("l-greet", "m1", "s.greet", "A0", topics=["small_talk"]),
        lesson("l-be", "m1", "s.be", "A0"),
        lesson("l-numbers", "m1", "s.numbers", "A0", topics=["shopping"]),
        lesson("l-family", "m2", "s.family", "A1", topics=["home"]),
        lesson("l-present", "m2", "s.present", "A1"),
        lesson("l-routine", "m2", "s.routine", "A1", audience=OLDER, prereqs=["s.present"]),
        lesson("l-animals", "m2", "s.animals", "A1", audience=["kids"], topics=["hobbies"]),
        lesson("l-listen", "m2", "s.listen", "A1"),
        lesson("l-cafe", "m2", "s.cafe", "A1", kind="optional", goals=["travel", "daily"], topics=["food"]),
        lesson("l-song", "m2", "s.song", "A1", kind="optional", audience=["kids"], topics=["movies"]),
        lesson("l-past", "m3", "s.past", "A2", audience=OLDER),
        lesson("l-travel", "m3", "s.travel", "A2", audience=OLDER, goals=["travel"], topics=["travel"],
               scenario="sc-travel-airport"),
        lesson("l-hotel", "m3", "s.hotel", "A2", audience=OLDER, goals=["travel"], topics=["travel"]),
        lesson("l-interview", "m3", "s.job", "A2", kind="optional", audience=["adults"], goals=["career", "work"],
               topics=["interview", "work"]),
        lesson("l-office", "m3", "s.office", "A2", kind="optional", audience=OLDER, goals=["work"], topics=["work"]),
    ]
    modules = [
        {"module_id": "m1", "title": loc("m1"), "goal": loc("goal m1"), "theme": "small_talk",
         "lesson_ids": ["l-greet", "l-be", "l-numbers"]},
        {"module_id": "m2", "title": loc("m2"), "goal": loc("goal m2"), "theme": "home",
         "lesson_ids": ["l-family", "l-present", "l-routine", "l-animals", "l-listen", "l-cafe", "l-song"]},
        {"module_id": "m3", "title": loc("m3"), "goal": loc("goal m3"), "theme": "travel",
         "lesson_ids": ["l-past", "l-travel", "l-hotel", "l-interview", "l-office"]},
    ]
    skills = [
        skill("s.greet", "function", "A0"), skill("s.be", "grammar", "A0"), skill("s.numbers", "vocabulary", "A0"),
        skill("s.family", "vocabulary", "A1", ["s.be"]), skill("s.present", "grammar", "A1", ["s.be"]),
        skill("s.routine", "function", "A1", ["s.present"]), skill("s.animals", "vocabulary", "A1"),
        skill("s.listen", "listening", "A1"), skill("s.cafe", "function", "A1"), skill("s.song", "vocabulary", "A1"),
        skill("s.past", "grammar", "A2", ["s.present"]), skill("s.travel", "vocabulary", "A2", ["s.numbers"]),
        skill("s.hotel", "function", "A2", ["s.travel", "s.past"]), skill("s.job", "vocabulary", "A2"),
        skill("s.office", "vocabulary", "A2"),
    ]
    return {
        "course_id": COURSE, "pair_id": "ru-en", "snapshot_version": version, "title": loc("English core"),
        "level_start": "A0", "level_end": "A2", "modules": modules, "skills": skills, "lessons": lessons,
    }


ADULT_CORE = ["l-greet", "l-be", "l-numbers", "l-family", "l-present", "l-routine", "l-listen", "l-past",
              "l-travel", "l-hotel"]
KIDS_CORE = ["l-greet", "l-be", "l-numbers", "l-family", "l-present", "l-animals", "l-listen"]


def areas(vocabulary: str | None = "A1", grammar: str | None = "A1", reading: str | None = "A1",
          listening: str | None = "A1") -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for area, band in (("vocabulary", vocabulary), ("grammar", grammar), ("reading", reading),
                       ("listening", listening)):
        out[area] = ({"status": "assessed", "band": band, "confidence": 0.7} if band
                     else {"status": "not_assessed", "band": None, "confidence": None})
    out["speaking"] = {"status": "not_assessed", "band": None, "confidence": None}
    out["writing"] = {"status": "not_assessed", "band": None, "confidence": None}
    return out


@dataclass
class FakeCatalog:
    """catalog `GET /internal/v1/courses/{id}/snapshot` по контракту: ETag, If-None-Match → 304, 404 — курс не
    опубликован; `down` — 503 на каждый запрос, `broken` — ответ не по контракту."""

    snapshot: dict[str, Any] | None = field(default_factory=course)
    down: bool = False
    broken: bool = False
    calls: list[dict[str, Any]] = field(default_factory=list)

    @property
    def etag(self) -> str:
        assert self.snapshot is not None
        return f'W/"{self.snapshot["snapshot_version"]}"'

    def publish(self, snapshot: dict[str, Any]) -> None:
        self.snapshot = copy.deepcopy(snapshot)

    def handler(self, request: httpx.Request) -> httpx.Response:
        claims = jwt.decode(request.headers["x-internal-token"], options={"verify_signature": False})
        self.calls.append({"path": request.url.path, "if_none_match": request.headers.get("if-none-match"),
                           "iss": claims["iss"], "aud": claims["aud"], "sub": claims.get("sub")})
        if self.down:
            return httpx.Response(503, json={"code": "UNAVAILABLE", "message": "x", "trace_id": "t", "details": {}})
        if request.url.path != SNAPSHOT_PATH or self.snapshot is None:
            return httpx.Response(404, json={"code": "COURSE_NOT_FOUND", "message": "x", "trace_id": "t",
                                             "details": {}})
        if self.broken:
            return httpx.Response(200, json={"course_id": COURSE, "lessons": "nope"})
        if request.headers.get("if-none-match") == self.etag:
            return httpx.Response(304, headers={"ETag": self.etag})
        return httpx.Response(200, content=json.dumps(self.snapshot).encode(),
                              headers={"ETag": self.etag, "content-type": "application/json"})
