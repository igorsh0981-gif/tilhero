"""Справочник объяснений кодов ошибок (INTERNAL_API §1.3 error_fix, журнал ошибок, аналитика забывания).

Каждый код закрытого списка оценщика (`independent_evaluator`, rules v1/v2: «error_code — one of: …») имеет своё
объяснение RU/UZ: иначе ошибка ученика сохранялась бы как `other` («Другая ошибка») — терялись бы объяснение в задании
«исправьте фразу», подпись в журнале и группировка повторных ошибок в аналитике (дефект, найден сквозным e2e
спринта 5: «he have» → third_person_s → other).
"""

from __future__ import annotations

import re

import pytest

from tilhero_memory.domain import explanations

# rules independent_evaluator v1/v2 (services/ai-gateway/migrations/seed/agents, …/0003/agents)
EVALUATOR_CODES = ("missing_be", "third_person_s", "wrong_tense", "verb_form", "article", "preposition", "plural",
                   "word_order", "question_form", "pronoun", "vocabulary", "other")
CYRILLIC = re.compile(r"[А-Яа-яЁё]")


@pytest.mark.parametrize("code", EVALUATOR_CODES)
def test_evaluator_codes_have_own_explanation(code: str) -> None:
    assert explanations.known_code(code) == code
    label, text = explanations.label(code), explanations.explanation(code)
    assert label["ru"] and label["uz"] and text["ru"] and text["uz"]
    if code != "other":
        assert label != explanations.label("other") and text != explanations.explanation("other")


def test_unknown_code_falls_back_to_other() -> None:
    assert explanations.known_code("missing_to") == "other"
    assert explanations.known_code(None) == "other"
    assert explanations.label("no_such_code") == explanations.label("other")


@pytest.mark.parametrize("code", sorted(explanations.ERROR_CODES))
def test_uz_is_latin_and_no_pressure(code: str) -> None:
    entry = explanations.ERROR_CODES[code]
    for part in ("label", "explanation"):
        assert not CYRILLIC.search(entry[part]["uz"]), f"{code}.{part}.uz — кириллица"
        assert "провал" not in entry[part]["ru"].lower()
