"""Следующий урок плана после диагностики = рекомендованный старт diagnostics (решение по независимому ревью).

Реальный снимок курса (сид catalog `services/catalog/migrations/seed/`, отображение как в
catalog.domain.learner.course_snapshot), банки диагностики (`services/diagnostics/migrations/seed/`) и правила
diagnostics (`tilhero_diagnostics.engine`): ученик «знает всё до полосы X» проходит диагностику на N seed — карта
навыков и результат передаются в планировщик так же, как через события diagnostics.completed.v1 и
skills.state.changed.v1. Нет файлов сида или пакета diagnostics — тест пропускается.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tilhero_learning_plan.domain.curriculum import AreaResult, Diagnostic, Learner, plan_trajectory
from tilhero_learning_plan.domain.snapshot import CourseSnapshot

SERVICES = Path(__file__).resolve().parents[2]
CATALOG_SEED = SERVICES / "catalog" / "migrations" / "seed"
DIAGNOSTICS_SEED = SERVICES / "diagnostics" / "migrations" / "seed"
BANDS = ["A0", "A1", "A2", "B1", "B2"]
SEEDS = [f"seed-{k:04d}" for k in range(20)]


def catalog_snapshot() -> dict[str, Any]:
    def load(name: str) -> Any:
        return json.loads((CATALOG_SEED / name).read_text(encoding="utf-8"))

    course, skills = load("course.json"), load("skills.json")
    modules = {m["module_id"]: m for m in load("modules.json")}
    lessons = {ls["lesson_id"]: ls for ls in load("lessons.json")}
    out_modules, out_lessons = [], []
    for mid in course["module_ids"]:
        m = modules[mid]
        out_modules.append({"module_id": mid, "title": m["title"], "goal": m["goal"], "theme": m["theme"],
                            "lesson_ids": [lid for lid in m["lesson_ids"] if lid in lessons]})
        for lid in m["lesson_ids"]:
            p = lessons[lid]
            out_lessons.append({
                "lesson_id": lid, "module_id": p["module_id"], "title": p["title"], "goal": p["goal"],
                "level": p["level"], "kind": p["kind"], "duration_min": p["duration_min"],
                "primary_skill_id": p["primary_skill_id"], "scenario_id": p.get("scenario_id"),
                "stages": [{"type": s["type"], "minutes": s["minutes"]} for s in p["stages"]],
                "audience": p["audience"], "goals": p["goals"], "topics": p["topics"],
                "secondary_skill_ids": p["secondary_skill_ids"], "prerequisite_skill_ids": p["prerequisite_skill_ids"],
                "control_item_types": [c["type"] for c in p.get("control_items", [])],
            })
    course_skills = sorted((s for s in skills if s.get("course_id") == course["course_id"]),
                           key=lambda s: (BANDS.index(s["level"]), s["skill_id"]))
    return {
        "course_id": course["course_id"], "pair_id": course["pair_id"], "snapshot_version": "catalog-seed",
        "title": course["title"], "level_start": course["level_start"], "level_end": course["level_end"],
        "modules": out_modules, "lessons": out_lessons,
        "skills": [{"skill_id": s["skill_id"], "area": s["area"], "title": s["title"], "level": s["level"],
                    "prerequisites": s["prerequisites"], "diagnostic_tags": s["diagnostic_tags"]}
                   for s in course_skills],
    }


@pytest.fixture(scope="module")
def world() -> tuple[Any, dict[str, Any], CourseSnapshot]:
    engine = pytest.importorskip("tilhero_diagnostics.engine")
    if not (CATALOG_SEED / "lessons.json").exists() or not list(DIAGNOSTICS_SEED.glob("*.json")):
        pytest.skip("нет сида catalog или банков diagnostics")
    snapshot = catalog_snapshot()
    return engine, snapshot, CourseSnapshot.model_validate(snapshot)


@pytest.mark.parametrize(("bank", "segment", "true_bands"), [
    ("dx-en-adult.v1.json", "adults", ["A0", "A1", "A2", "B1", "B2"]),
    ("dx-en-adult.v1.json", "teens", ["A0", "A1", "A2", "B1"]),
    ("dx-en-kids.v1.json", "kids", ["A0", "A1", "A2"]),
])
def test_plan_next_equals_diagnostic_recommendation(world, bank: str, segment: str, true_bands: list[str]) -> None:
    engine, snapshot, snap = world
    from tilhero_diagnostics.testdef import validate

    test = validate(json.loads((DIAGNOSTICS_SEED / bank).read_text(encoding="utf-8")))
    tag_index: dict[str, set[str]] = {}
    for s in snapshot["skills"]:
        for tag in s["diagnostic_tags"]:
            tag_index.setdefault(tag, set()).add(s["skill_id"])
    course_skills = {s["skill_id"] for s in snapshot["skills"]}
    levels = {ls["lesson_id"]: ls["level"] for ls in snapshot["lessons"]}
    mismatches: list[str] = []
    none_cases: list[str] = []
    runs = 0
    for true_band in true_bands:
        for seed in SEEDS:
            history: list[Any] = []
            quotas = {a: test.config.items_per_area for a in test.config.areas}
            while (item := engine.next_item(test, seed, history, session_answers=history, quotas=quotas,
                                            listening_available=True)) is not None:
                history.append(engine.Answered(item.item_id, item.area, item.band,
                                               BANDS.index(item.band) <= BANDS.index(true_band)))
            prof = engine.profile(test, history, listening_available=True)
            skills_of = {a.item_id: engine.item_skills(test.item(a.item_id), tag_index, course_skills)
                         for a in history}
            states = {o.skill_id: engine.transition("not_started", o.outcome, None)
                      for o in engine.skill_outcomes(history, skills_of)}
            bands = {a.area: a.band for a in prof.areas if a.status == "assessed"}
            rec = engine.recommend_start(snapshot, states, bands, prof.provisional_level, segment)
            diagnostic = Diagnostic(result_id="r", revision=1, provisional_level=prof.provisional_level,
                                    areas={a.area: AreaResult(a.status, a.band) for a in prof.areas},
                                    recommended_start_lesson_id=rec["lesson_id"] if rec else None)
            plan = plan_trajectory(snap, Learner(audience=segment, diagnostic=diagnostic, skills=states))
            runs += 1
            nxt = plan.next
            if rec is None:
                # ученик освоил все core-уроки высшего уровня своего сегмента: обязательных нет, и уж точно нет
                # уроков ниже его уровня (не «A2 начинает с A0»)
                none_cases.append(f"{true_band}/{seed}")
                assert plan.mandatory == (), (true_band, seed, [p.lesson.lesson_id for p in plan.mandatory])
                continue
            if nxt is None or nxt.lesson.lesson_id != rec["lesson_id"]:
                mismatches.append(f"{true_band}/{seed}: diagnostics {rec['lesson_id']} ({levels[rec['lesson_id']]}) "
                                  f"plan {nxt.lesson.lesson_id if nxt else None} {nxt.reason_codes if nxt else ''}")
            else:
                assert nxt.reason_codes[0] == "start_after_diagnostic"
    assert runs == len(true_bands) * len(SEEDS)
    assert mismatches == [], "\n".join(mismatches)
    assert len(none_cases) <= len(SEEDS) // 10, none_cases  # рекомендация почти всегда есть
