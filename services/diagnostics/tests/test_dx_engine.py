"""Правила диагностики без БД (INTERNAL_API §2.2–2.4): лестница, выбор по sha256, нехватка заданий, оценка по
формулам на заготовленных профилях, медиана, слабые стороны, карта навыков, рекомендация старта, формат теста."""

from __future__ import annotations

import copy
import json
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest
from dx_testkit import LESSONS, course_snapshot, seed_snapshot

from tilhero_diagnostics import engine
from tilhero_diagnostics.engine import Answered
from tilhero_diagnostics.testdef import TestInvalid, validate

SEED_DIR = Path(__file__).resolve().parents[1] / "migrations" / "seed"
AREAS = ("vocabulary", "grammar", "reading", "listening")
BANDS = ("A0", "A1", "A2", "B1", "B2")


def seed_test(name: str) -> dict[str, Any]:
    return json.loads((SEED_DIR / name).read_text(encoding="utf-8"))


ADULT = validate(seed_test("dx-en-adult.v1.json"))
KIDS = validate(seed_test("dx-en-kids.v1.json"))


def mini_test(cells: dict[str, dict[str, int]] | None = None, **config: Any) -> dict[str, Any]:
    """Маленький валидный тест: в каждой клетке область × полоса по 4 коротких задания (или как в cells)."""
    cells = cells or {a: dict.fromkeys(BANDS, 4) for a in AREAS}
    items = []
    for area, bands in cells.items():
        for band, n in bands.items():
            for k in range(n):
                item: dict[str, Any] = {
                    "item_id": f"{area[0]}-{band.lower()}-{k}", "area": area, "band": band, "tags": [f"t.{area}"],
                    "skill_ids": [f"en.{area}.{band.lower()}"],
                    "type": {"reading": "read_choice", "listening": "listen_choice"}.get(area, "gap_choice"),
                    "instruction": {"ru": "Выберите ответ.", "uz": "Javobni tanlang."},
                    "prompt_en": f"Pick {k} ___", "passage_en": "Short text." if area == "reading" else None,
                    "audio_text_en": "Short audio." if area == "listening" else None,
                    "options": ["a", "b", "c"], "answer": k % 3,
                }
                items.append(item)
    cfg = {"areas": list(cells), "items_per_area": 6, "start_band": "A1", "min_items_assessed": 3,
           "min_correct_per_band": 2, "followup_items": 3, "retest_days": 14, "time_limit_min": 15}
    cfg.update(config)
    return {"test_id": "dx-mini", "version": 1, "pair_id": "ru-en", "audience": "adults", "config": cfg,
            "items": items}


def simulate(test, seed: str, correct, *, listening: bool = True) -> list[Answered]:
    history: list[Answered] = []
    quotas = {a: test.config.items_per_area for a in test.config.areas}
    while (item := engine.next_item(test, seed, history, session_answers=history, quotas=quotas,
                                    listening_available=listening)) is not None:
        history.append(Answered(item.item_id, item.area, item.band, correct(item)))
    return history


def ans(*spec: str, area: str = "vocabulary") -> list[Answered]:
    """«A1+», «B1-», «A0?» (не знаю) → ответы области."""
    out = []
    for k, s in enumerate(spec):
        out.append(Answered(f"i{k}", area, s[:2], s[2] == "+", s[2] == "?"))
    return out


# ---------------------------------------------------------------- подбор


def test_selection_is_reproducible_and_seed_dependent() -> None:
    def policy(item):
        return item.band_index <= 2

    first = [a.item_id for a in simulate(ADULT, "seed-a", policy)]
    assert first == [a.item_id for a in simulate(ADULT, "seed-a", policy)]
    firsts = {simulate(ADULT, f"seed-{k}", policy)[0].item_id for k in range(40)}
    assert len(firsts) > 1  # внутри полосы порядок задаёт sha256(seed + item_id)
    item = engine.pick_in_area(ADULT, "seed-a", [], "vocabulary")
    expected = min((i for i in ADULT.items if i.area == "vocabulary" and i.band == "A1"),
                   key=lambda i: engine.item_rank("seed-a", i.item_id))
    assert item == expected


def test_ladder_up_and_down_from_shown_band() -> None:
    always = simulate(ADULT, "s", lambda i: True)
    never = simulate(ADULT, "s", lambda i: False)
    path_up = [a.band for a in always if a.area == "vocabulary"]
    path_down = [a.band for a in never if a.area == "vocabulary"]
    assert path_up == ["A1", "A2", "B1", "B2", "B2", "B2"]
    assert path_down == ["A1", "A0", "A0", "A0", "A0", "A0"]
    mixed = simulate(ADULT, "s", lambda i: i.band_index <= 2)
    assert [a.band for a in mixed if a.area == "grammar"] == ["A1", "A2", "B1", "A2", "B1", "A2"]
    assert [a.area for a in always[:8]] == list(AREAS) * 2
    assert len(always) == 24


def test_nearest_band_when_cell_is_empty_or_exhausted() -> None:
    cells = {"vocabulary": {"A0": 2, "A1": 4, "A2": 0, "B1": 4, "B2": 0}}
    test = validate(mini_test(cells, items_per_area=4, followup_items=1))
    history = [Answered("v-a1-0", "vocabulary", "A1", True)]
    # нужна A2, её нет; A1 и B1 на равном расстоянии → более низкая (A1)
    assert engine.pick_in_area(test, "s", history, "vocabulary").band == "A1"
    # A0 исчерпана после двух неверных → ближайшая доступная выше
    history = [Answered("v-a0-0", "vocabulary", "A0", False), Answered("v-a0-1", "vocabulary", "A0", False)]
    assert engine.target_band(test, history, "vocabulary") == 0
    assert engine.pick_in_area(test, "s", history, "vocabulary").band == "A1"
    # задания области кончились → None, сессия идёт по другим областям / завершается
    seen = [Answered(i.item_id, i.area, i.band, True) for i in test.items]
    assert engine.pick_in_area(test, "s", seen, "vocabulary") is None


def test_listening_unavailable_and_quotas() -> None:
    history = simulate(ADULT, "s", lambda i: True, listening=False)
    assert len(history) == 18 and {a.area for a in history} == {"vocabulary", "grammar", "reading"}
    follow = engine.next_item(ADULT, "s", history, session_answers=[], quotas={"grammar": 3},
                              listening_available=False)
    assert follow is not None and follow.area == "grammar" and follow.item_id not in {a.item_id for a in history}


def test_tester_profiles_adult_and_kids() -> None:
    """Сверка с симуляцией тестолога (check_diagnostics.py): уровни по профилям ответов."""
    def level(test, upto: int) -> str | None:
        hist = simulate(test, "seed-0001", lambda i: i.band_index <= upto)
        return engine.profile(test, hist, listening_available=True).provisional_level

    assert [level(ADULT, k) for k in (4, -1, 2, 1, 0, 3)] == ["B2", "A0", "A2", "A1", "A0", "B1"]
    assert [level(KIDS, k) for k in (4, -1, 2, 1, 0)] == ["A2", "A0", "A2", "A1", "A0"]


# ---------------------------------------------------------------- оценка


def test_band_rule_within_band_and_fallback_below_start() -> None:
    assert engine.area_band(ADULT, ans("A1+", "A2+", "B1-", "A2+", "B1-", "A2+")) == 2  # A2 3/3
    # по одному верному в каждой полосе (взрослые: нужно 2) → на ступень ниже старта A1 = A0
    assert engine.area_band(ADULT, ans("A1+", "A2+", "B1+", "B2-", "B1-", "A2-")) == 0
    # A1: 2 верных из 4 = 0,5 < 0,6 → не засчитана
    assert engine.area_band(ADULT, ans("A1+", "A1-", "A1+", "A1-", "A0+", "A0+")) == 0
    # дети: достаточно одного верного в полосе
    assert engine.area_band(KIDS, ans("A0+", "A1+", "A2-")) == 1
    assert engine.area_band(KIDS, ans("A0-", "A0-")) == 0


def test_confidence_formula_on_prepared_profiles() -> None:
    # чистый профиль A2: n=6, согласованность 1, скачков нет → clamp(0,2+0,6+0,4) = 1
    clean = ans("A1+", "A2+", "B1-", "A2+", "B1-", "A2+")
    assert engine.consistency(clean, 2) == 1 and engine.jumps(clean) == 0
    assert engine.confidence(clean, 2) == 1
    # провал A1, затем верно до B2 → полоса A0 (ни в одной полосе двух верных), неровный профиль
    erratic = ans("A1-", "A0+", "A1+", "A2+", "B1+", "B2+")
    band = engine.area_band(ADULT, erratic)
    assert band == 0
    assert engine.consistency(erratic, band) == Fraction(2, 6)  # согласны: A1-(выше A0, неверно), A0+
    assert engine.jumps(erratic) == 3  # верные выше самой низкой ошибки (A1): A2, B1, B2
    score = engine.score_area(ADULT, "vocabulary", erratic, listening_available=True)
    expected = Fraction(1, 5) + Fraction(6, 10) + Fraction(2, 5) * Fraction(2, 6) - Fraction(1, 5) * 3
    assert score.exact_confidence == expected == Fraction(1, 3)
    assert (score.confidence, score.needs_followup, score.status, score.band) == (0.33, True, "assessed", "A0")
    # «не знаю» считается неверным, но не угадыванием; n=3 — минимум для оценки
    dk = ans("A1?", "A0+", "A1+")
    s = engine.score_area(ADULT, "vocabulary", dk, listening_available=True)
    assert s.band == "A0" and engine.jumps(dk) == 0
    assert s.exact_confidence == Fraction(1, 5) + Fraction(3, 10) + Fraction(2, 5) * Fraction(2, 3)
    assert not s.needs_followup
    # нижняя граница clamp: много скачков → 0
    assert engine.confidence(ans("A0-", "A1+", "A2+", "B1+", "B2+", "B2+"), 0) == 0


def test_jumps_are_correct_answers_above_lowest_wrong_band() -> None:
    assert engine.jumps(ans("A1-", "A0+", "A1+", "A2+")) == 1  # только A2+ выше A1
    assert engine.jumps(ans("B1-", "A2+", "B1+", "B2+")) == 1
    assert engine.jumps(ans("A1+", "A2+")) == 0
    assert engine.jumps(ans("A0-", "A1+", "A2+", "A0+")) == 2


def test_not_assessed_reasons() -> None:
    few = engine.score_area(ADULT, "grammar", ans("A1+", "A2+", area="grammar"), listening_available=True)
    assert (few.status, few.reason, few.band, few.confidence) == ("not_assessed", "too_few_items", None, None)
    assert few.evidence == []  # not_assessed — без оснований
    ok = engine.score_area(ADULT, "grammar", ans("A1+", "A2+", "B1-", "A2+", "B1-", "A2?", area="grammar"),
                           listening_available=True)
    assert ok.evidence == [{"band": "A1", "answered": 1, "correct": 1}, {"band": "A2", "answered": 3, "correct": 2},
                           {"band": "B1", "answered": 2, "correct": 0}]
    assert "item_id" not in str(ok.public())
    voice = engine.score_area(ADULT, "listening", ans(*["A1+"] * 6, area="listening"), listening_available=False)
    assert (voice.status, voice.reason) == ("not_assessed", "no_speech_voice")
    for area in ("speaking", "writing"):
        s = engine.score_area(ADULT, area, [], listening_available=True)
        assert (s.status, s.reason, s.needs_followup) == ("not_assessed", "not_in_test_yet", False)


def test_median_and_weak_areas() -> None:
    assert engine.median_band(["A1"]) is None
    assert engine.median_band([]) is None
    assert engine.median_band(["A0", "B1", "A2"]) == "A2"
    assert engine.median_band(["A0", "A1", "B1", "B2"]) == "A1"  # чётное число — нижняя из двух средних
    assert engine.median_band(["B2", "A2"]) == "A2"
    answers = [*ans("A1+", "A2+", "B1+", "B2+", "B2+", "B2+", area="vocabulary"),
               *ans("A1-", "A0+", "A1-", "A0+", "A1-", "A0+", area="grammar"),
               *ans("A1+", "A2+", "B1-", "A2+", "B1-", "A2+", area="reading"),
               *ans("A1+", area="listening")]
    prof = engine.profile(ADULT, answers, listening_available=True)
    bands = {a.area: a.band for a in prof.areas}
    assert bands == {"vocabulary": "B2", "grammar": "A0", "reading": "A2", "listening": None, "speaking": None,
                     "writing": None}
    assert prof.provisional_level == "A2"
    assert prof.weak_areas == ["grammar", "listening"]  # ниже медианы, затем области теста без оценки


# ---------------------------------------------------------------- карта навыков


def test_skill_outcomes_and_transitions() -> None:
    answers = [Answered("x1", "grammar", "A1", True), Answered("x2", "grammar", "B1", False),
               Answered("y1", "grammar", "A1", True), Answered("y2", "grammar", "A0", False),
               Answered("z1", "vocabulary", "A2", False)]
    skills_of = {"x1": {"s.x"}, "x2": {"s.x"}, "y1": {"s.y"}, "y2": {"s.y"}, "z1": {"s.z"}}
    out = {o.skill_id: o for o in engine.skill_outcomes(answers, skills_of)}
    assert (out["s.x"].outcome, out["s.x"].band) == ("positive", "A1")  # неверный только выше верного
    assert (out["s.y"].outcome, out["s.y"].band) == ("negative", "A0")  # неверный ниже верного
    assert (out["s.z"].outcome, out["s.z"].confidence) == ("negative", 1.0)
    assert engine.transition("not_started", "positive", None) == "demonstrated"
    assert engine.transition("learning", "positive", "negative") == "demonstrated"
    assert engine.transition("not_started", "negative", None) == "learning"
    assert engine.transition("demonstrated", "negative", "positive") == "demonstrated"  # одно — не понижает
    assert engine.transition("demonstrated", "negative", "negative") == "learning"  # два подряд
    assert engine.transition("retained", "positive", None) == "retained"


def test_item_skills_by_tags_and_ids() -> None:
    item = next(i for i in ADULT.items if i.item_id == "v-a0-01")
    tags = {"voc.numbers": {"en.voc.numbers"}, "voc.family": {"en.voc.family"}}
    assert engine.item_skills(item, tags, {"en.voc.numbers"}) == {"en.voc.numbers"}
    assert engine.item_skills(item, None, None) == set(item.skill_ids)
    assert engine.item_skills(item, tags, set()) == set()  # только навыки курса


# ---------------------------------------------------------------- рекомендация старта


def test_recommend_start() -> None:
    snap = course_snapshot()

    def rec(states, bands, level, segment="adults"):
        r = engine.recommend_start(snap, states, bands, level, segment)
        return r["lesson_id"] if r else None

    # ничего не известно — первый урок курса
    assert rec({}, {}, None) == "l-01-greetings"
    first = engine.recommend_start(snap, {}, {}, None, "adults")
    assert first == {"lesson_id": "l-01-greetings", "title": snap["lessons"][0]["title"], "level": "A0"}
    # A0, ничего не подтверждено — первый урок
    assert rec({}, {"vocabulary": "A0", "grammar": "A0"}, "A0") == "l-01-greetings"
    # A1: урок A0 пропущен (навык ниже полосы), A1-урок с предпосылками A0 (ниже A1) — рекомендация
    assert rec({}, {"vocabulary": "A1", "grammar": "A1"}, "A1") == "l-02-where-from"
    # A2: уроки A0/A1 строго ниже уровня пропущены; урок A2 — его предпосылки уровня A2 (past-simple, voc.travel)
    # не выше полос своих областей и засчитаны без подтверждения
    a2 = {"vocabulary": "A2", "grammar": "A2"}
    assert rec({}, a2, "A2") == "l-13-flight-check-in"
    # предпосылка выше полосы своей области блокирует урок: грамматика A1 < past-simple (A2) → None
    a1_done = {ls[2]: "demonstrated" for ls in LESSONS if ls[3] in ("A0", "A1")}
    assert rec(a1_done, {"vocabulary": "A2", "grammar": "A1"}, "A1") is None
    assert rec(a1_done, {"vocabulary": "A2", "grammar": "A2"}, "A1") == "l-13-flight-check-in"
    # предпосылка того же уровня, что полоса, засчитана: present-simple (A1) при грамматике A1
    met = {s: "demonstrated" for s in ("en.func.greet", "en.func.where-from", "en.func.numbers-phone",
                                       "en.func.talk-family")}
    assert rec(met, {"grammar": "A1"}, "A1") == "l-05-jobs"
    assert rec(met, {"grammar": "A0"}, "A1") == "l-07-coffee"
    # B2: все core-уроки ниже уровня → первый не освоенный урок самого высокого уровня курса (A2)
    b2 = {"vocabulary": "B2", "grammar": "B2", "reading": "B2", "listening": "B2"}
    assert rec({}, b2, "B2") == "l-13-flight-check-in"
    assert rec({"en.func.check-in-flight": "demonstrated"}, b2, "B2") is None
    # дети — только audience kids: высший уровень детских core-уроков — A1
    assert rec({}, b2, "B2", "kids") == "l-02-where-from"
    assert rec({"en.func.where-from": "retained"}, b2, "B2", "kids") == "l-04-family"
    assert rec({}, {}, None, "kids") == "l-01-greetings"
    assert rec({"en.func.greet": "demonstrated", "en.func.introduce": "demonstrated", "en.voc.numbers":
                "demonstrated"}, {}, "A0", "kids") == "l-02-where-from"
    # уровня нет (< 2 оценённых областей): пропуск и предпосылки — только по полосам оценённых областей;
    # функции без уровня не «ниже» — l-02/l-03/l-04 ждут предпосылок, l-05 (present-simple A1 < грамматики A2) — да
    assert rec({}, {"grammar": "A2"}, None) == "l-01-greetings"
    assert rec({"en.func.greet": "demonstrated"}, {"grammar": "A2"}, None) == "l-05-jobs"
    # всё освоено — None
    done = {ls["primary_skill_id"]: "demonstrated" for ls in snap["lessons"]}
    assert rec(done, {}, "A0") is None and rec(done, b2, "B2") is None and rec(done, {}, None, "kids") is None
    # основной навык подтверждён — урок пропускается, следующий по порядку
    assert rec({"en.func.greet": "demonstrated", "en.func.introduce": "demonstrated"}, {}, "A0") == "l-02-where-from"


def _seed_recommendation(snap, test, upto: int, seed: str, segment: str) -> tuple[str | None, str | None]:
    from tilhero_diagnostics.domain.skills import course_index

    tags, course = course_index(snap)
    hist = simulate(test, seed, lambda i: i.band_index <= upto)
    prof = engine.profile(test, hist, listening_available=True)
    skills_of = {a.item_id: engine.item_skills(test.item(a.item_id), tags, course) for a in hist}
    states = {o.skill_id: engine.transition("not_started", o.outcome, None)
              for o in engine.skill_outcomes(hist, skills_of)}
    bands = {a.area: a.band for a in prof.areas if a.status == "assessed"}
    r = engine.recommend_start(snap, states, bands, prof.provisional_level, segment)
    return prof.provisional_level, (r["lesson_id"] if r else None)


def test_recommend_start_on_real_course_seed() -> None:
    """Снимок курса из сида catalog + банки тестолога (seed-0000): какие уроки получают типовые ученики."""
    snap = seed_snapshot()
    if snap is None:
        pytest.skip("нет сида catalog")
    levels = {ls["lesson_id"]: ls["level"] for ls in snap["lessons"]}
    kids_lessons = {ls["lesson_id"] for ls in snap["lessons"] if "kids" in ls["audience"]}
    # всегда неверно → A0, ничего не подтверждено → первый урок курса
    assert _seed_recommendation(snap, ADULT, -1, "seed-0000", "adults") == ("A0", "l-01-greetings")
    # «верно до A2» → A2: урок уровня A2 (уроки A0/A1 строго ниже уровня не рекомендуются)
    level, lesson = _seed_recommendation(snap, ADULT, 2, "seed-0000", "adults")
    assert (level, lesson) == ("A2", "l-13-flight-check-in") and levels[lesson] == "A2"
    # B2 → первый не освоенный core-урок самого высокого уровня курса (A2)
    assert _seed_recommendation(snap, ADULT, 4, "seed-0000", "adults") == ("B2", "l-13-flight-check-in")
    # дети: только детские уроки (высший уровень детских core-уроков в курсе — A1)
    for upto in (0, 1, 2):
        _, lesson = _seed_recommendation(snap, KIDS, upto, "seed-0000", "kids")
        assert lesson in kids_lessons
    assert _seed_recommendation(snap, KIDS, 2, "seed-0000", "kids") == ("A2", "l-02-where-from")


def test_a2_learner_never_gets_null_or_lesson_below_a2() -> None:
    """100 seed: ученик «верно до A2» всегда получает рекомендацию, и это урок уровня не ниже A2."""
    snap = seed_snapshot()
    if snap is None:
        pytest.skip("нет сида catalog")
    levels = {ls["lesson_id"]: ls["level"] for ls in snap["lessons"]}
    got = []
    for k in range(100):
        level, lesson = _seed_recommendation(snap, ADULT, 2, f"seed-{k:04d}", "adults")
        assert level == "A2" and lesson is not None, f"seed-{k:04d}"
        assert BANDS.index(levels[lesson]) >= BANDS.index("A2"), (f"seed-{k:04d}", lesson)
        got.append(lesson)
    assert len(set(got)) > 1  # урок зависит от того, какие навыки A2 подтверждены в показанных заданиях


# ---------------------------------------------------------------- формат теста


def test_seed_tests_are_valid() -> None:
    assert ADULT.ref == "dx-en-adult@1" and ADULT.audience == "adults" and len(ADULT.items) >= 80
    assert KIDS.ref == "dx-en-kids@1" and KIDS.audience == "kids" and KIDS.config.min_correct_per_band == 1
    assert KIDS.config.items_per_area < ADULT.config.items_per_area  # детский тест короче
    text = json.dumps(seed_test("dx-en-kids.v1.json"), ensure_ascii=False).lower()
    for word in ("http", "www.", "быстрее", "провал", "tezroq"):  # детям — без ссылок и давления
        assert word not in text


@pytest.mark.parametrize(("mutate", "code"), [
    (lambda t: t["items"][0].update(prompt_en="See https://example.com ___"), "EXTERNAL_LINK"),
    (lambda t: t["items"][0]["instruction"].update(uz="Выберите"), "LOCALE_SCRIPT"),
    (lambda t: t["items"][0].update(answer=7), "ANSWER_INVALID"),
    (lambda t: t["items"][0].update(type="listen_choice"), "TYPE_AREA_MISMATCH"),
    (lambda t: t["items"][0].update(extra=1), "UNKNOWN_FIELD"),
    (lambda t: t["items"][1].update(item_id=t["items"][0]["item_id"]), "ID_DUPLICATE"),
    (lambda t: t["config"].update(areas=["grammar", "vocabulary"]), "AREAS_ORDER"),
    (lambda t: t["config"].update(start_band="C1"), "BAND_INVALID"),
    (lambda t: t.update(items=[i for i in t["items"] if i["area"] != "grammar" or i["band"] != "A0"][:-60]),
     "COVERAGE_LOW"),
    (lambda t: t["items"][0].update(passage_en="Text"), "PASSAGE_UNEXPECTED"),
])
def test_invalid_tests_are_rejected(mutate, code) -> None:
    raw = copy.deepcopy(mini_test())
    mutate(raw)
    with pytest.raises(TestInvalid) as exc:
        validate(raw)
    assert code in {e["code"] for e in exc.value.errors}, exc.value.errors


def test_order_words_and_kids_rules() -> None:
    raw = seed_test("dx-en-kids.v1.json")
    item = next(i for i in raw["items"] if i["type"] == "order_words")
    item["options"] = list(item["answer"])
    with pytest.raises(TestInvalid) as exc:
        validate(raw)
    assert {e["code"] for e in exc.value.errors} == {"ANSWER_SHOWN"}
    raw = seed_test("dx-en-kids.v1.json")
    raw["items"][0]["instruction"]["ru"] = "Отвечай быстрее!"
    with pytest.raises(TestInvalid) as exc:
        validate(raw)
    assert {e["code"] for e in exc.value.errors} == {"KIDS_PRESSURE"}
    parsed = validate(seed_test("dx-en-kids.v1.json"))
    ow = next(i for i in parsed.items if i.type == "order_words")
    assert ow.is_correct(list(ow.answer)) and not ow.is_correct(list(ow.options))
    assert ow.answer_shape_ok(list(ow.options)) and not ow.answer_shape_ok(["x"]) and not ow.answer_shape_ok(0)


def test_seed_migration_fails_on_invalid_file(tmp_path) -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "seed_migration", Path(__file__).resolve().parents[1] / "migrations" / "versions" / "0002_seed_tests.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert [t["test_id"] for t in module.load_seed()] == ["dx-en-adult", "dx-en-kids"]
    with pytest.raises(RuntimeError, match="no"):
        module.load_seed(tmp_path)
    bad = mini_test()
    bad["items"][0]["answer"] = 9
    (tmp_path / "dx-mini.v1.json").write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(RuntimeError, match="ANSWER_INVALID"):
        module.load_seed(tmp_path)
    (tmp_path / "dx-mini.v1.json").write_text(json.dumps(mini_test()), encoding="utf-8")
    assert len(module.load_seed(tmp_path)) == 1
    (tmp_path / "dx-mini2.v1.json").write_text(json.dumps(mini_test() | {"test_id": "dx-mini2"}), encoding="utf-8")
    with pytest.raises(RuntimeError, match="second test"):
        module.load_seed(tmp_path)
    (tmp_path / "broken.json").write_text("{", encoding="utf-8")
    with pytest.raises(RuntimeError, match="not a JSON"):
        module.load_seed(tmp_path)


def test_catalog_url_required_in_stage_and_prod(monkeypatch) -> None:
    from pydantic import ValidationError

    from tilhero_diagnostics.settings import Settings

    monkeypatch.delenv("CATALOG_URL", raising=False)
    secure = {"internal_jwt_secret": "s" * 40, "internal_jwt_private_key": "A" * 43, "_env_file": None}
    for env_name in ("stage", "prod"):
        with pytest.raises(ValidationError, match="CATALOG_URL is required"):
            Settings(env=env_name, **secure)
        with pytest.raises(ValidationError, match="CATALOG_URL is required"):
            Settings(env=env_name, catalog_url=" ", **secure)
        assert Settings(env=env_name, catalog_url="http://catalog.railway.internal:8110", **secure).catalog_url
    with pytest.raises(ValidationError, match="http"):
        Settings(env="prod", catalog_url="catalog:8110", **secure)
    monkeypatch.setenv("CATALOG_URL", "http://catalog.railway.internal:8110")
    assert Settings(env="prod", **secure).catalog_url == "http://catalog.railway.internal:8110"
    # dev/test — значение по умолчанию (локальный стенд)
    monkeypatch.delenv("CATALOG_URL")
    assert Settings(env="test", _env_file=None).catalog_url == "http://127.0.0.1:8110"
