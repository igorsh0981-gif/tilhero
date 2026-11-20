"""FSRS-5 (INTERNAL_API §1.4): эталоны считаются той же формулой независимо в тесте; правила оценки — по таблице."""

from __future__ import annotations

import itertools
import math
from datetime import UTC, datetime, timedelta

import pytest

from tilhero_memory.domain import fsrs
from tilhero_memory.domain.tasks import CHOICE_TASKS, grade_for

W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11,
     0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621]
T = datetime(2026, 11, 20, 10, 0, tzinfo=UTC)


def ref_r(t: float, s: float) -> float:
    return (1 + 19 / 81 * t / s) ** -0.5


def ref_d0(g: int) -> float:
    return min(10.0, max(1.0, W[4] - math.exp(W[5] * (g - 1)) + 1))


def ref_d(d: float, g: int) -> float:
    d1 = d + (-W[6] * (g - 3)) * (10 - d) / 9
    return min(10.0, max(1.0, W[7] * ref_d0(4) + (1 - W[7]) * d1))


def test_constants_and_version() -> None:
    assert list(fsrs.W) == W and len(fsrs.W) == 19
    assert fsrs.ALGORITHM == "fsrs-5" and fsrs.PARAMS_VERSION == "fsrs5-default-1"
    assert fsrs.DECAY == -0.5 and fsrs.FACTOR == 19 / 81 and fsrs.TARGET_RETENTION == 0.9


def test_reference_values() -> None:
    assert fsrs.init_stability(1) == 0.40255 and fsrs.init_stability(3) == 3.173
    assert fsrs.init_difficulty(3) == pytest.approx(7.1949 - math.e ** 1.069 + 1, abs=1e-9)
    assert fsrs.init_difficulty(3) == pytest.approx(5.2824, abs=1e-4)
    # INTERNAL_API приводит R(3; 3.173) ≈ 0,9019; по формуле §1.4 (1 + 19/81 · 3/3.173)^−0.5 = 0,9047 — тест
    # проверяет формулу (эталон в документе приблизителен)
    assert fsrs.retrievability(3, 3.173) == pytest.approx(ref_r(3, 3.173), rel=1e-12)
    assert fsrs.retrievability(3, 3.173) == pytest.approx(0.9047, abs=1e-4)
    assert fsrs.retrievability(0, 5) == 1.0


def test_first_rating_good_then_good_after_3_days() -> None:
    first = fsrs.review(fsrs.new_memory(), "good", T)
    m = first.memory
    assert (m.state, m.reps, m.lapses) == ("learning", 1, 0)
    assert m.stability == 3.173 and m.difficulty == pytest.approx(ref_d0(3))
    assert first.interval_days == 3 and m.due_at == T + timedelta(days=3)
    second = fsrs.review(m, "good", T + timedelta(days=3))
    s, d = 3.173, ref_d0(3)
    r = ref_r(3, s)
    expected = s * (math.exp(W[8]) * (11 - d) * s ** -W[9] * (math.exp(W[10] * (1 - r)) - 1) + 1)
    assert second.memory.stability == pytest.approx(expected, rel=1e-12)
    assert second.memory.stability == pytest.approx(10.8, abs=0.1)
    assert second.memory.difficulty == pytest.approx(ref_d(d, 3), rel=1e-12)
    assert second.memory.state == "review" and second.memory.reps == 2
    assert second.retrievability == pytest.approx(r, rel=1e-12)
    assert second.interval_days == round(expected) and second.elapsed_days == pytest.approx(3.0)


def test_hard_success_uses_w15() -> None:
    m = fsrs.review(fsrs.new_memory(), "good", T).memory
    out = fsrs.review(m, "hard", T + timedelta(days=4))
    s, d, r = 3.173, ref_d0(3), ref_r(4, 3.173)
    expected = s * (math.exp(W[8]) * (11 - d) * s ** -W[9] * (math.exp(W[10] * (1 - r)) - 1) * W[15] + 1)
    assert out.memory.stability == pytest.approx(expected, rel=1e-12)


def test_failure_in_review_increments_lapses_and_returns_to_learning() -> None:
    m = fsrs.Memory("review", 20.0, 5.0, 5, 0, T - timedelta(days=25), T)
    out = fsrs.review(m, "again", T)
    r = ref_r(25, 20.0)
    expected = min(20.0, W[11] * 5.0 ** -W[12] * ((20.0 + 1) ** W[13] - 1) * math.exp(W[14] * (1 - r)))
    assert out.memory.stability == pytest.approx(expected, rel=1e-12)
    assert out.memory.lapses == 1 and out.memory.state == "learning"
    assert out.memory.difficulty == pytest.approx(ref_d(5.0, 1))
    assert out.interval_days >= 1


def test_same_day_short_term_formula() -> None:
    m = fsrs.review(fsrs.new_memory(), "again", T).memory
    assert m.stability == 0.40255 and m.state == "learning"
    out = fsrs.review(m, "hard", T + timedelta(minutes=5))
    assert out.short_term
    assert out.memory.stability == pytest.approx(0.40255 * math.exp(W[17] * (2 - 3 + W[18])), rel=1e-12)
    assert out.memory.state == "learning"  # S < 1 дня — остаётся в изучении
    assert out.interval_days == 1


def test_learning_to_review_requires_success_and_stability_ge_1() -> None:
    m = fsrs.review(fsrs.new_memory(), "hard", T).memory  # S0 = 1.18385
    assert m.state == "learning"
    out = fsrs.review(m, "good", T + timedelta(days=1))
    assert out.memory.state == "review" and out.memory.stability >= 1


@pytest.mark.parametrize(("s", "expected"), [(0.1, 1), (1.4, 1), (2.5, 3), (10.0, 10), (364.6, 365), (5000.0, 365)])
def test_interval_bounds(s: float, expected: int) -> None:
    assert fsrs.interval_days(s) == expected


def test_grading_table_never_easy() -> None:
    types = ["meaning_choice", "listen_choice", "typed", "cloze", "assemble", "error_fix"]
    for typ, result, hints in itertools.product(types, ["correct", "almost", "incorrect"],
                                                [[], ["first_letter"], ["reveal"], ["first_letter", "reveal"]]):
        g = grade_for(typ, result, hints)
        assert g in ("again", "hard", "good")
        if result == "incorrect" or "reveal" in hints:
            assert g == "again"
        elif typ in CHOICE_TASKS:
            assert g == "hard"  # выбор готового ответа — не выше hard
        elif result == "almost" or "first_letter" in hints:
            assert g == "hard"
        else:
            assert g == "good"
