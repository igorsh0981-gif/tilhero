"""Алгоритм траектории (INTERNAL_API §3, навык curriculum_planner без LLM) на заготовленных снимках: без диагностики,
старт после диагностики, вставка предпосылок, освоенные навыки пропускаются, цель/темы → дополнительные, дети и
подростки, слабая область, детерминизм, объяснения RU/UZ."""

from __future__ import annotations

import re
from typing import Any

import pytest
from lp_course import ADULT_CORE, KIDS_CORE, areas, course

from tilhero_learning_plan.domain.curriculum import (
    REASON_CODES,
    AreaResult,
    Diagnostic,
    Learner,
    TrajectoryPlan,
    course_order,
    explain,
    plan_trajectory,
)
from tilhero_learning_plan.domain.snapshot import CourseSnapshot

SNAP = CourseSnapshot.model_validate(course())
CYRILLIC = re.compile(r"[А-Яа-яЁё]")
# Детям — без давления и сравнения (CONVENTIONS §8); взрослым — без «провала»
KID_FORBIDDEN = re.compile(r"слаб|отста|хуже|провал|ошиб|zaif|ortda|yomon|xato", re.IGNORECASE)


def diag(start: str | None = "l-present", level: str | None = "A1", **bands: str | None) -> Diagnostic:
    raw = areas(**bands)
    return Diagnostic(
        result_id="11111111-1111-4111-8111-111111111111", revision=1, provisional_level=level,
        areas={k: AreaResult(v["status"], v["band"]) for k, v in raw.items()}, recommended_start_lesson_id=start,
    )


def ids(items: Any) -> list[str]:
    return [p.lesson.lesson_id for p in items]


def codes(plan: TrajectoryPlan) -> dict[str, tuple[str, ...]]:
    return {p.lesson.lesson_id: p.reason_codes for p in (*plan.mandatory, *plan.optional)}


def test_course_order_follows_modules() -> None:
    order = [lesson.lesson_id for lesson in course_order(SNAP)]
    assert order[:4] == ["l-greet", "l-be", "l-numbers", "l-family"] and order[-1] == "l-office"
    assert len(order) == len(set(order)) == 15


def test_without_diagnostic_from_course_start() -> None:
    plan = plan_trajectory(SNAP, Learner(audience="adults"))
    assert ids(plan.mandatory) == ADULT_CORE
    assert plan.next is not None and plan.next.lesson.lesson_id == "l-greet"
    assert plan.next.reason_codes == ("no_diagnostic",)
    assert all(p.reason_codes == ("next_in_course",) for p in plan.mandatory[1:])
    assert plan.optional == ()  # ни цели, ни тем — дополнительных нет
    assert all(p.lesson.kind == "core" for p in plan.mandatory)


def test_start_after_diagnostic_skips_earlier_lessons() -> None:
    """Старт — рекомендованный урок; уроки до него не входят; предпосылки ниже оценённой полосы закрыты."""
    plan = plan_trajectory(SNAP, Learner(audience="adults", diagnostic=diag("l-present")))
    assert ids(plan.mandatory) == ["l-present", "l-routine", "l-listen", "l-past", "l-travel", "l-hotel"]
    assert plan.mandatory[0].reason_codes == ("start_after_diagnostic",)
    assert "prerequisite_missing" not in {c for p in plan.mandatory for c in p.reason_codes}


def test_prerequisites_inserted_before_lesson() -> None:
    """Старт на routine, области не оценены и уровня нет: предпосылки закрываются только освоением — present (A1)
    и be (A0) вставлены перед ним (рекурсивно, в порядке зависимостей); numbers — перед travel; без повторов."""
    plan = plan_trajectory(SNAP, Learner(audience="adults", diagnostic=diag(
        "l-routine", level=None, vocabulary=None, grammar=None, reading=None, listening=None)))
    assert ids(plan.mandatory) == ["l-be", "l-present", "l-routine", "l-listen", "l-past", "l-numbers",
                                   "l-travel", "l-hotel"]
    c = codes(plan)
    assert c["l-be"] == c["l-present"] == c["l-numbers"] == ("prerequisite_missing",)
    assert c["l-routine"] == ("start_after_diagnostic",) and c["l-past"] == ("next_in_course",)
    assert plan.next is not None and plan.next.lesson.lesson_id == "l-be"


def test_prerequisite_closed_by_mastered_skill() -> None:
    learner = Learner(audience="adults", diagnostic=diag("l-routine", level=None, vocabulary=None, grammar=None,
                                                         reading=None, listening=None),
                      skills={"s.be": "demonstrated", "s.present": "retained", "s.numbers": "learning"})
    plan = plan_trajectory(SNAP, learner)
    assert ids(plan.mandatory) == ["l-routine", "l-listen", "l-past", "l-numbers", "l-travel", "l-hotel"]


def test_prerequisite_closed_by_level_inclusive() -> None:
    """Правило diagnostics (ревью): предпосылка закрыта, если её уровень не выше полосы своей области; функции
    и неоценённые области — не выше предварительного уровня; уровня нет — только оценённые области."""
    # все области A0: be и numbers (A0) закрыты уровнем, present (A1) — нет
    plan = plan_trajectory(SNAP, Learner(audience="adults", diagnostic=diag(
        "l-routine", level="A0", vocabulary="A0", grammar="A0", reading="A0", listening="A0")))
    assert ids(plan.mandatory) == ["l-present", "l-routine", "l-listen", "l-past", "l-travel", "l-hotel"]
    # грамматика A1 закрывает present (A1 ≤ A1) — план начинается ровно с рекомендованного урока
    plan = plan_trajectory(SNAP, Learner(audience="adults", diagnostic=diag(
        "l-routine", level="A1", vocabulary="A0", grammar="A1", reading="A1", listening="A1")))
    assert plan.next is not None and plan.next.lesson.lesson_id == "l-routine"
    assert plan.next.reason_codes[0] == "start_after_diagnostic"
    # hotel ← travel (словарь A2), past (грамматика): грамматика не оценена — по предварительному уровню A2
    plan = plan_trajectory(SNAP, Learner(audience="adults", diagnostic=diag(
        "l-hotel", level="A2", vocabulary="A2", grammar=None, reading="A2", listening="A2")))
    assert plan.next is not None and plan.next.lesson.lesson_id == "l-hotel"
    # уровня нет, грамматика не оценена — past не закрыт и вставлен перед hotel вместе со своей цепочкой
    # (past ← present ← be); travel закрыт словарём A2
    plan = plan_trajectory(SNAP, Learner(audience="adults", diagnostic=diag(
        "l-hotel", level=None, vocabulary="A2", grammar=None, reading=None, listening=None)))
    assert ids(plan.mandatory)[:4] == ["l-be", "l-present", "l-past", "l-hotel"]


def test_demonstrated_skills_are_skipped() -> None:
    learner = Learner(audience="adults", skills={"s.greet": "demonstrated", "s.be": "retained",
                                                 "s.family": "learning", "s.listen": "not_started"})
    plan = plan_trajectory(SNAP, learner)
    assert ids(plan.mandatory) == [x for x in ADULT_CORE if x not in ("l-greet", "l-be")]
    assert plan.next is not None and plan.next.reason_codes == ("no_diagnostic",)
    assert plan.next.lesson.lesson_id == "l-numbers"


def test_mastered_recommended_start_is_skipped() -> None:
    learner = Learner(audience="adults", diagnostic=diag("l-present"), skills={"s.present": "demonstrated"})
    plan = plan_trajectory(SNAP, learner)
    assert ids(plan.mandatory)[0] == "l-routine"
    assert plan.mandatory[0].reason_codes == ("start_after_diagnostic",)


def test_goal_and_topics_select_optional_lessons() -> None:
    plan = plan_trajectory(SNAP, Learner(audience="adults", goal="work", topics=("interview",)))
    assert ids(plan.optional) == ["l-interview", "l-office"]  # два совпадения раньше одного
    assert codes(plan)["l-interview"] == ("goal_match", "topic_match")
    assert codes(plan)["l-office"] == ("goal_match",)
    travel = plan_trajectory(SNAP, Learner(audience="adults", goal="travel", topics=("food",)))
    assert ids(travel.optional) == ["l-cafe"] and codes(travel)["l-cafe"] == ("goal_match", "topic_match")
    # совпадение цели и тем отмечается и у обязательных
    assert codes(travel)["l-travel"] == ("next_in_course", "goal_match")
    assert codes(travel)["l-greet"] == ("no_diagnostic",)
    small = plan_trajectory(SNAP, Learner(audience="adults", topics=("small_talk",)))
    assert codes(small)["l-greet"] == ("no_diagnostic", "topic_match")


def test_optional_limit_and_mastered_excluded() -> None:
    learner = Learner(audience="adults", goal="work", topics=("interview", "work", "food"))
    assert ids(plan_trajectory(SNAP, learner, optional_max=1).optional) == ["l-interview"]
    assert plan_trajectory(SNAP, learner, optional_max=0).optional == ()
    mastered = Learner(audience="adults", goal="work", skills={"s.job": "demonstrated"})
    assert ids(plan_trajectory(SNAP, mastered).optional) == ["l-office"]


def test_kids_get_only_kids_lessons() -> None:
    plan = plan_trajectory(SNAP, Learner(audience="kids", goal="work", topics=("movies", "interview", "travel")))
    assert ids(plan.mandatory) == KIDS_CORE
    assert ids(plan.optional) == ["l-song"]  # взрослое interview и не-детское cafe — нет
    raw = {lesson["lesson_id"]: lesson["audience"] for lesson in course()["lessons"]}
    assert all("kids" in raw[x] for x in ids(plan.mandatory) + ids(plan.optional))


def test_kids_recommended_adult_lesson_falls_back() -> None:
    """Рекомендация не для детей (или неизвестный урок) — старт по правилу diagnostics среди детских уроков."""
    plan = plan_trajectory(SNAP, Learner(audience="kids", diagnostic=diag("l-routine", level="A0",
                                                                          grammar="A0", vocabulary="A0")))
    assert ids(plan.mandatory)[0] == "l-greet"
    unknown = plan_trajectory(SNAP, Learner(audience="adults", diagnostic=diag("l-nope"),
                                            skills={"s.greet": "demonstrated"}))
    # правило diagnostics: be и numbers (A0) строго ниже полос A1 — не стартовые; family (A1) — не освоен, не ниже
    # уровня, предпосылка be (A0 ≤ грамматики A1) закрыта
    assert ids(unknown.mandatory)[0] == "l-family"
    # все core-уроки ниже уровня ученика (B2) — первый не освоенный урок высшего уровня курса (A2)
    above = plan_trajectory(SNAP, Learner(audience="adults", diagnostic=diag(
        None, level="B2", vocabulary="B2", grammar="B2", reading="B2", listening="B2")))
    assert ids(above.mandatory)[0] == "l-past"
    done = {s: "demonstrated" for s in ("s.past", "s.travel", "s.hotel")}
    top_done = plan_trajectory(SNAP, Learner(audience="adults", skills=done, diagnostic=diag(
        None, level="B2", vocabulary="B2", grammar="B2", reading="B2", listening="B2")))
    assert top_done.mandatory == ()


def test_teens_audience() -> None:
    plan = plan_trajectory(SNAP, Learner(audience="teens", goal="career"))
    assert ids(plan.mandatory) == ADULT_CORE
    assert ids(plan.optional) == []  # interview — только взрослым
    plan = plan_trajectory(SNAP, Learner(audience="teens", goal="work"))
    assert ids(plan.optional) == ["l-office"]


def test_weak_area_reason() -> None:
    plan = plan_trajectory(SNAP, Learner(audience="adults", diagnostic=diag(
        "l-family", level="A1", vocabulary="A2", grammar="A1", reading="A2", listening="A0")))
    assert codes(plan)["l-listen"] == ("next_in_course", "weak_area")
    assert "weak_area" not in codes(plan)["l-present"]
    no_level = plan_trajectory(SNAP, Learner(audience="adults", diagnostic=diag("l-family", level=None,
                                                                                listening="A0")))
    assert all("weak_area" not in p.reason_codes for p in no_level.mandatory)


def test_everything_mastered() -> None:
    all_skills = {s["skill_id"]: "demonstrated" for s in course()["skills"]}
    plan = plan_trajectory(SNAP, Learner(audience="adults", goal="work", skills=all_skills))
    assert plan.mandatory == () and plan.optional == () and plan.next is None
    some = {k: v for k, v in all_skills.items() if k != "s.office"}
    plan = plan_trajectory(SNAP, Learner(audience="adults", goal="work", skills=some))
    assert plan.mandatory == () and plan.next is not None and plan.next.lesson.lesson_id == "l-office"


def test_prerequisite_cycle_and_unknown_skills_do_not_hang() -> None:
    raw = course()
    for s in raw["skills"]:
        if s["skill_id"] == "s.be":
            s["prerequisites"] = ["s.present", "s.missing"]  # цикл be ↔ present и навык, которого нет
    snap = CourseSnapshot.model_validate(raw)
    plan = plan_trajectory(snap, Learner(audience="adults", diagnostic=diag(
        "l-routine", level="A0", vocabulary="A0", grammar="A0", reading="A0", listening="A0")))
    mandatory = ids(plan.mandatory)
    assert len(mandatory) == len(set(mandatory)) and mandatory.index("l-present") < mandatory.index("l-routine")


def test_deterministic() -> None:
    learner = Learner(audience="adults", goal="travel", topics=("food", "travel"),
                      diagnostic=diag("l-routine", level="A1", grammar="A0"), skills={"s.listen": "demonstrated"})
    first = plan_trajectory(SNAP, learner)
    for _ in range(3):
        again = plan_trajectory(CourseSnapshot.model_validate(course()), learner)
        assert codes(again) == codes(first) and ids(again.mandatory) == ids(first.mandatory)


# ---------------------------------------------------------------- объяснения


@pytest.mark.parametrize("code", REASON_CODES)
@pytest.mark.parametrize("kids", [False, True])
def test_every_code_explained_in_ru_and_uz(code: str, kids: bool) -> None:
    text = explain([code], goal="travel", kids=kids)
    assert set(text) == {"ru", "uz"} and text["ru"] and text["uz"]
    assert CYRILLIC.search(text["ru"]) and not CYRILLIC.search(text["uz"])
    assert "'" not in text["uz"] and "’" not in text["uz"]  # узбекская латиница — oʻ/gʻ через U+02BB
    if kids:
        assert not KID_FORBIDDEN.search(text["ru"] + " " + text["uz"]), text


def test_explanation_combines_codes_and_names_goal() -> None:
    text = explain(["start_after_diagnostic", "weak_area", "goal_match", "goal_match"], goal="travel", kids=False)
    assert text["ru"] == ("По итогам диагностики начать лучше с этого урока. Тренирует область, которая по "
                          "диагностике пока отстаёт от остальных. Подходит под вашу цель «Путешествия».")
    assert text["uz"].startswith("Diagnostika natijalariga koʻra") and text["uz"].endswith(
        "«Sayohat» maqsadingizga mos keladi.")
    assert explain(["goal_match"], goal=None, kids=False)["ru"] == "Подходит под выбранную цель."
    assert explain([], goal=None, kids=True)["ru"] == "Следующий шаг по курсу."
    kid = explain(["no_diagnostic"], goal=None, kids=True)
    assert kid == {"ru": "Начнём с самого начала — шаг за шагом.", "uz": "Eng boshidan, qadamma-qadam boshlaymiz."}


# ---------------------------------------------------------------- спринт 4: пройденные уроки


def test_passed_lessons_skipped_failed_repeat() -> None:
    learner = Learner(audience="adults", goal="travel", topics=("food",),
                      lessons={"l-greet": True, "l-be": False, "l-numbers": None, "l-cafe": True})
    plan = plan_trajectory(SNAP, learner)
    assert ids(plan.mandatory) == ADULT_CORE[1:]
    assert plan.next is not None and plan.next.lesson.lesson_id == "l-be" and plan.next.repeat is True
    assert plan.next.reason_codes == ("no_diagnostic", "repeat")
    assert codes(plan)["l-numbers"] == ("next_in_course", "repeat")
    assert [p.repeat for p in plan.mandatory[:3]] == [True, True, False]
    assert "l-cafe" not in ids(plan.optional)  # пройденный дополнительный урок не предлагается снова


def test_passed_teacher_lesson_not_inserted_and_kids_no_substitute_code() -> None:
    learner = Learner(audience="adults", diagnostic=diag("l-routine", level="A0", grammar="A0"),
                      lessons={"l-present": True})
    assert ids(plan_trajectory(SNAP, learner).mandatory)[0] == "l-routine"
    kids = plan_trajectory(SNAP, Learner(audience="kids", lessons={"l-greet": False}))
    # спринт 4: код repeat (bff.ts) — мягкий, ставится и детям
    assert kids.next is not None and kids.next.repeat and kids.next.reason_codes == ("no_diagnostic", "repeat")


@pytest.mark.parametrize("kids", [False, True])
def test_repeat_explanation(kids: bool) -> None:
    text = explain(["next_in_course", "repeat"], goal=None, kids=kids, repeat=True)
    assert CYRILLIC.search(text["ru"]) and not CYRILLIC.search(text["uz"])
    assert "'" not in text["uz"] and "’" not in text["uz"]
    if kids:
        assert text["ru"] == "Пройдём этот урок ещё раз — так дальше будет легче. Следующий шаг по курсу."
        assert not KID_FORBIDDEN.search(text["ru"] + " " + text["uz"]), text
    else:
        # код repeat второй раз фразу не добавляет
        assert text["ru"] == ("Повторим этот урок — в прошлый раз зачёт не получен. "
                              "Следующий шаг по программе курса.")
