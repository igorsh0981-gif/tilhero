"""Нормализация и сравнение ответов (INTERNAL_API §1.6) — правила, не ИИ; ввод ученика никуда не уходит.

- `normalize` — ключ карточки и формы словаря курса: NFC, нижний регистр, обрезка, схлопывание пробелов, апострофы
  ’ ‘ ` → ', без концевых . ! ? … и кавычек по краям;
- `canonical` — форма для сравнения ввода: normalize + без пунктуации внутри (регистр и пунктуация не важны, PLAN) +
  раскрытие сокращений (`i'm` = `i am`, `can't` = `cannot` = `can not`, …);
- `compare` → correct | almost | incorrect: «почти» — одно слово длиной ≥ 5 букв отличается на одну правку
  (Левенштейн 1), остальные совпадают; заготовка «…» в допустимом ответе («My name is …») — от 0 до 3 слов;
- `check_*` — сравнение контрольных заданий по правилам assessment: индекс; gap_fill — без регистра, лишних пробелов
  и концевой пунктуации; order_words — точный порядок.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Sequence
from typing import Final, Literal

Result = Literal["correct", "almost", "incorrect"]

_APOSTROPHES: Final = str.maketrans({"’": "'", "‘": "'", "`": "'", "ʼ": "'"})
_TRAILING: Final = ".!?…"
_QUOTES: Final = "\"«»“”„‟‹›"
_PLACEHOLDER = re.compile(r"…|\.\.\.")
# пунктуация внутри фразы (для сравнения ввода): точки, запятые, двоеточия, скобки, кавычки, многоточие, тире
_INNER_PUNCT = re.compile(r"[.,;:!?…\"«»“”„‟‹›()\[\]{}/]|(?<!\w)['\-–—]+|['\-–—]+(?!\w)")

CONTRACTIONS: Final[dict[str, str]] = {
    "i'm": "i am", "you're": "you are", "he's": "he is", "she's": "she is", "it's": "it is", "we're": "we are",
    "they're": "they are", "don't": "do not", "doesn't": "does not", "didn't": "did not", "can't": "cannot",
    "won't": "will not", "isn't": "is not", "aren't": "are not", "i've": "i have", "i'll": "i will",
    "let's": "let us", "what's": "what is", "that's": "that is", "there's": "there is",
}
ALMOST_MIN_LEN: Final = 5


def _base(value: str) -> str:
    s = unicodedata.normalize("NFC", value).translate(_APOSTROPHES).lower()
    return " ".join(s.split())


def normalize(value: str) -> str:
    """Ключ карточки / форма словаря курса (§1.6)."""
    s = _base(value)
    while True:
        prev = s
        s = s.strip()
        while s and s[-1] in _TRAILING:
            s = s[:-1].rstrip()
        if len(s) >= 1 and s[0] in _QUOTES:
            s = s[1:]
        if len(s) >= 1 and s[-1] in _QUOTES:
            s = s[:-1]
        if s == prev:
            return s


def _expand(tokens: Iterable[str]) -> list[str]:
    out: list[str] = []
    for t in tokens:
        out.extend(CONTRACTIONS.get(t, t).split())
    return out


def canonical_tokens(value: str) -> list[str]:
    s = _INNER_PUNCT.sub(" ", normalize(value))
    tokens = _expand(s.split())
    joined = " ".join(tokens).replace("can not", "cannot")
    return joined.split()


def canonical(value: str) -> str:
    return " ".join(canonical_tokens(value))


def levenshtein(a: str, b: str, limit: int = 2) -> int:
    """Расстояние правки (с ранним выходом: больше limit — возвращается limit + 1)."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        best = cur[0]
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
            best = min(best, cur[j])
        if best > limit:
            return limit + 1
        prev = cur
    return prev[-1]


def _template(answer: str) -> re.Pattern[str] | None:
    """«My name is …» → шаблон: на месте «…» — от 0 до 3 слов."""
    if not _PLACEHOLDER.search(answer):
        return None
    parts = [canonical(p) for p in _PLACEHOLDER.split(answer)]
    slot = r"(?:\s*\S+(?:\s+\S+){0,2})?\s*"
    body = slot.join(re.escape(p) for p in parts)
    return re.compile(rf"^\s*{body}\s*$")


def _almost(expected: Sequence[str], given: Sequence[str]) -> bool:
    if len(expected) != len(given) or not expected:
        return False
    diffs = [i for i, (e, g) in enumerate(zip(expected, given, strict=True)) if e != g]
    if len(diffs) != 1:
        return False
    e, g = expected[diffs[0]], given[diffs[0]]
    return sum(ch.isalpha() for ch in e) >= ALMOST_MIN_LEN and levenshtein(e, g, 1) == 1


def compare(given: str, answers: Iterable[str]) -> Result:
    g_tokens = canonical_tokens(given)
    if not g_tokens:
        return "incorrect"
    g = " ".join(g_tokens)
    answers = [a for a in answers if a and a.strip()]
    for a in answers:
        if canonical(a) == g:
            return "correct"
        tpl = _template(a)
        if tpl is not None and tpl.match(g):
            return "correct"
    for a in answers:
        if _almost(canonical_tokens(a), g_tokens):
            return "almost"
    return "incorrect"


def word_count(value: str) -> int:
    return len(canonical_tokens(value))


def split_alternatives(text_en: str) -> list[str]:
    """«Goodbye! / Bye!» → ["Goodbye!", "Bye!"] — варианты ключевого слова как допустимые ответы."""
    parts = [p.strip() for p in re.split(r"\s+/\s+", text_en) if p.strip()]
    return parts or [text_en]


def letters_of(value: str) -> list[str]:
    """Буквы слова для сборки (без пунктуации, нижний регистр)."""
    return [ch for ch in normalize(value) if ch.isalpha() or ch == "'"]


def find_in_sentence(sentence: str, candidates: Iterable[str]) -> str | None:
    """Первая из форм, встречающаяся в предложении по границам слов (без регистра) → фрагмент как в предложении."""
    base = unicodedata.normalize("NFC", sentence).translate(_APOSTROPHES)
    for cand in candidates:
        c = normalize(cand)
        c = _PLACEHOLDER.sub("", c).strip()
        if not c:
            continue
        m = re.search(rf"(?<![\w']){re.escape(c)}(?![\w'])", base, flags=re.IGNORECASE)
        if m:
            return m.group(0)
    return None


# ---------------------------------------------------------------- контрольные задания (правила assessment)


def normalize_gap(value: str) -> str:
    """gap_fill: NFC, типографские апострофы → ', пробелы схлопнуты, без регистра, без концевой пунктуации."""
    s = unicodedata.normalize("NFC", value).translate(_APOSTROPHES)
    s = " ".join(s.split()).casefold()
    while s and (s[-1] in ".!?…,;:" or s[-1].isspace()):
        s = s[:-1]
    return s.strip()


def ws(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split())


def check_gap(given: str, answers: Iterable[str]) -> bool:
    g = normalize_gap(given)
    return bool(g) and any(normalize_gap(a) == g for a in answers)


def check_order(given: Sequence[str], expected: Sequence[str]) -> bool:
    return len(given) == len(expected) and all(ws(a) == ws(b) for a, b in zip(given, expected, strict=True))
