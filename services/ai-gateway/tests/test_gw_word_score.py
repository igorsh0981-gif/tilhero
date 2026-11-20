"""Сравнение распознанных слов с эталоном (релиз 5.1, `domain/word_score.py`): нормализация как в memory (регистр,
апострофы, пунктуация, сокращения) и числа, выравнивание Левенштейном по словам (совпадение, замена, пропуск,
лишнее), баллы (accuracy, completeness, fluency, pron), confidence, порог вероятности, лимит 40 слов."""

from __future__ import annotations

from typing import Any

import pytest

from tilhero_ai_gateway.domain.speech import interpret
from tilhero_ai_gateway.domain.word_score import align, fluency, number_words, score, similarity, tokenize

REF = "Good morning, I have a reservation."


def said(*words: str | tuple[str, float], step: int = 400, gap: int = 0) -> list[dict[str, Any]]:
    """Слова tts /recognize: по умолчанию вероятность 0,9, по 400 мс подряд."""
    out, t = [], 0
    for w in words:
        word, prob = (w, 0.9) if isinstance(w, str) else w
        out.append({"word": word, "start_ms": t, "end_ms": t + step - 50, "probability": prob})
        t += step + gap
    return out


def words_of(result: dict[str, Any]) -> list[tuple[str, Any, str]]:
    return [(w["Word"], w["AccuracyScore"], w["ErrorType"]) for w in result["NBest"][0]["Words"]]


def test_exact_match() -> None:
    res = score(REF, said(" Good", " morning,", " I", " have", " a", " reservation."))
    best = res["NBest"][0]
    assert res["RecognitionStatus"] == "Success"
    assert words_of(res) == [("Good", 90, "None"), ("morning", 90, "None"), ("I", 90, "None"), ("have", 90, "None"),
                             ("a", 90, "None"), ("reservation", 90, "None")]
    assert (best["AccuracyScore"], best["CompletenessScore"], best["FluencyScore"], best["Confidence"]) == (
        90.0, 100.0, 100.0, 0.9)
    assert best["PronScore"] == pytest.approx(0.6 * 90 + 0.2 * 100 + 0.2 * 100)


def test_omission() -> None:
    res = score(REF, said("Good", "morning", "I", "a", "reservation"))
    assert words_of(res)[3] == ("have", 0, "Omission")
    best = res["NBest"][0]
    assert best["CompletenessScore"] == pytest.approx(round(500 / 6, 1))
    assert best["AccuracyScore"] == pytest.approx(round(90 * 5 / 6, 1))


def test_substitution_is_low_accuracy_mispronunciation() -> None:
    res = score(REF, said("Good", "morning", "I", "have", "a", "revelation"))
    word, accuracy, error = words_of(res)[5]
    assert (word, error) == ("reservation", "Mispronunciation") and 10 <= accuracy <= 50
    near = score("I have a book", said("I", "have", "a", "boot"))
    far = score("I have a book", said("I", "have", "a", "elephant"))
    assert words_of(near)[3][1] > words_of(far)[3][1]  # похожее написание — выше
    assert near["NBest"][0]["CompletenessScore"] == 75.0  # замена — слово эталона не распознано


def test_insertion_in_place() -> None:
    res = score(REF, said("Good", "morning", "I", "really", "have", "a", "reservation"))
    assert words_of(res) == [("Good", 90, "None"), ("morning", 90, "None"), ("I", 90, "None"),
                             ("really", None, "Insertion"), ("have", 90, "None"), ("a", 90, "None"),
                             ("reservation", 90, "None")]
    assert res["NBest"][0]["CompletenessScore"] == 100.0  # лишнее слово полноту не снижает


@pytest.mark.parametrize(("reference", "words"), [
    ("I'm from Tashkent.", ["I", "am", "from", "Tashkent."]),
    ("I am from Tashkent.", ["I'm", "from", "Tashkent"]),
    ("My brother don’t like football.", ["My", "brother", "don't", "like", "football."]),
    ("I can't swim", ["I", "cannot", "swim."]),
    ("It's on the left", ["it", "is", "on", "the", "LEFT!"]),
    ("Fifteen thousand soums a kilo.", ["15,000", "soums", "a", "kilo."]),
    ("It's twenty-five minutes", ["It's", "25", "minutes"]),
    ("Boarding starts at 10:40.", ["Boarding", "starts", "at", "ten", "forty."]),
    ("I'm going to fly home on the 20th.", ["I'm", "going", "to", "fly", "home", "on", "the", "twentieth."]),
    ("«Hello», Emma!", ['"Hello,"', "Emma."]),
])
def test_normalization_apostrophes_contractions_numbers(reference: str, words: list[str]) -> None:
    res = score(reference, said(*words))
    assert all(e == "None" for _, _, e in words_of(res)), words_of(res)
    assert res["NBest"][0]["CompletenessScore"] == 100.0
    ref_display = [t.display for t in tokenize(reference)]
    assert [w for w, _, _ in words_of(res)] == ref_display  # эталон показывается как в тексте


def test_low_probability_match_is_mispronunciation() -> None:
    res = score("I have a reservation", said("I", "have", "a", ("reservation", 0.31)))
    assert words_of(res)[3] == ("reservation", 31, "Mispronunciation")
    assert res["NBest"][0]["CompletenessScore"] == 100.0  # слово узнано, но неуверенно


def test_fluency_pauses_and_tempo() -> None:
    assert fluency([]) == 100.0
    assert fluency(tokenize("Hello")) == 100.0
    steady = score(REF, said("Good", "morning", "I", "have", "a", "reservation"))["NBest"][0]["FluencyScore"]
    paused = score(REF, said("Good", "morning", "I", "have", "a", "reservation", gap=800))["NBest"][0]
    hesitant = score(REF, said("Good", "morning", "I", "have", "a", "reservation", gap=1600))["NBest"][0]
    assert steady == 100.0
    # 5 пауз ≥ 0,7 с — 50; темп: 6 слов за (6×400 + 5×800 − 50) мс ≈ 0,94 сл/с → (1,5 − 0,94) × 40 ≈ 22,5
    assert paused["FluencyScore"] == pytest.approx(100 - 50 - (1.5 - 6 / 6.35) * 40, abs=0.1)
    # паузы ≥ 1,5 с: 5 × 20 → потолок 60; темп 6 слов за 10,35 с ≈ 0,58 сл/с → (1,5 − 0,58) × 40 ≈ 36,8
    assert hesitant["FluencyScore"] == pytest.approx(100 - 60 - (1.5 - 6 / 10.35) * 40, abs=0.1)
    assert paused["PronScore"] < steady


def test_nothing_recognized_or_no_reference_words() -> None:
    assert score(REF, []) == {"RecognitionStatus": "NoMatch"}
    assert score(REF, said("...", "!")) == {"RecognitionStatus": "NoMatch"}
    assert score("?!", said("hello")) == {"RecognitionStatus": "NoMatch"}
    assessment = interpret(score(REF, []))
    assert (assessment.status, assessment.reason) == ("insufficient_evidence", "not_recognized")


@pytest.mark.parametrize(("words", "reason"), [
    ([("Good", 0.3), ("morning", 0.35), ("I", 0.4), ("have", 0.3), ("a", 0.3), ("reservation", 0.3)],
     "low_confidence"),
    (["Good", "evening"], "incomplete"),  # 1 из 6 слов эталона — полнота < 30
])
def test_insufficient_through_common_rules(words: list[Any], reason: str) -> None:
    assessment = interpret(score(REF, said(*words)))
    assert (assessment.status, assessment.reason, assessment.scores) == ("insufficient_evidence", reason, None)


def test_word_limit_drops_insertions_first() -> None:
    reference = " ".join(f"word{i}" for i in range(30))
    noise = [w for i in range(30) for w in (f"word{i}", f"extra{i}")]
    res = score(reference, said(*noise, step=100))
    out = words_of(res)
    assert len(out) == 40 and sum(1 for _, _, e in out if e != "Insertion") == 30


def test_helpers() -> None:
    assert number_words(0) == ["zero"] and number_words(15) == ["fifteen"] and number_words(40) == ["forty"]
    assert number_words(215) == ["two", "hundred", "fifteen"]
    assert number_words(15000) == ["fifteen", "thousand"]
    assert number_words(1_000_001) == ["one", "million", "one"]
    assert [t.parts for t in tokenize("Wi-Fi, 555-0147")] == [["wi", "fi"], ["five", "hundred", "fifty", "five",
                                                                            "one", "hundred", "forty", "seven"]]
    assert similarity("book", "book") == 1.0 and similarity("book", "") == 0.0
    assert align(["a", "b"], ["a", "x", "b"]) == [("match", 0, 0), ("ins", None, 1), ("match", 1, 2)]
    assert align(["a", "b", "c"], ["a", "c"]) == [("match", 0, 0), ("del", 1, None), ("match", 2, 1)]
    assert align(["a", "b"], ["a", "x"]) == [("match", 0, 0), ("sub", 1, 1)]
