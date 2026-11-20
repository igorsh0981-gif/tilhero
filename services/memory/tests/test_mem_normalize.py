"""Нормализация и сравнение ответов (INTERNAL_API §1.6)."""

from __future__ import annotations

import pytest

from tilhero_memory.domain.normalize import (
    canonical,
    check_gap,
    check_order,
    compare,
    find_in_sentence,
    levenshtein,
    normalize,
    split_alternatives,
)


@pytest.mark.parametrize(("raw", "key"), [
    ("  Hello!  ", "hello"), ("“Nice to meet you.”", "nice to meet you"), ("I’m fine…", "i'm fine"),
    ("What`s   UP?!", "what's up"), ("«Привет»", "привет"), ("My name is …", "my name is"),
])
def test_normalize(raw: str, key: str) -> None:
    assert normalize(raw) == key


@pytest.mark.parametrize(("a", "b"), [
    ("I'm fine, thanks.", "i am fine thanks"), ("You're late", "you are late"), ("He's here", "he is here"),
    ("don't go", "do not go"), ("She doesn't", "she does not"), ("didn't", "did not"), ("can't", "cannot"),
    ("can't", "can not"), ("won't", "will not"), ("isn't", "is not"), ("aren't", "are not"), ("I've", "i have"),
    ("I'll", "i will"), ("Let's go!", "let us go"), ("What's that?", "what is that"), ("That's it", "that is it"),
    ("There's a cat", "there is a cat"), ("it's", "it is"), ("we're", "we are"), ("they're", "they are"),
])
def test_contractions_both_forms(a: str, b: str) -> None:
    assert canonical(a) == canonical(b)
    assert compare(b, [a]) == "correct" and compare(a, [b]) == "correct"


def test_compare_results() -> None:
    assert compare("hello", ["Hello!"]) == "correct"
    assert compare("  HELLO  ", ["Hello!"]) == "correct"
    assert compare("Helo", ["Hello!"]) == "almost"  # 5 букв, одна правка
    assert compare("Hi", ["Hey"]) == "incorrect"  # короткое слово — не «почти»
    assert compare("restaurnt", ["restaurant"]) == "almost"
    assert compare("beautifl dy", ["beautiful day"]) == "incorrect"  # два слова отличаются
    assert compare("I am fine thank", ["I'm fine, thanks."]) == "almost"
    assert compare("", ["x"]) == "incorrect" and compare("   ", ["x"]) == "incorrect"
    assert compare("Goodbye", split_alternatives("Goodbye! / Bye!")) == "correct"
    assert compare("bye", split_alternatives("Goodbye! / Bye!")) == "correct"
    assert compare("My name is Aziz", ["My name is …"]) == "correct"
    assert compare("my name is", ["My name is …"]) == "correct"
    assert compare("my name", ["My name is …"]) == "incorrect"
    assert levenshtein("kitten", "sitting") == 3 and levenshtein("abc", "abd", 1) == 1


def test_cloze_fragment_and_check_items() -> None:
    assert find_in_sentence("Hi! I'm Emma. What's your name?", ["What's your name?"]) == "What's your name"
    assert find_in_sentence("Hello there", ["hell"]) is None  # по границам слов
    assert check_gap(" AM. ", ["am"]) and not check_gap("is", ["am"]) and not check_gap("", ["am"])
    assert check_order(["My", "name", "is", "Aziz."], ["My", "name", "is", "Aziz."])
    assert not check_order(["name", "My", "is", "Aziz."], ["My", "name", "is", "Aziz."])
