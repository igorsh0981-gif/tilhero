"""Нормализация и токены английского текста контента (INTERNAL_API §1.6, §2.2, §2.3). Чистые функции.

- `normalize` — как сравнение ответа в memory (§1.6): NFC, нижний регистр, апострофы ’ ‘ ` → ', схлопнутые пробелы,
  без концевых . ! ? … и кавычек по краям.
- `normalize_form` — форма статьи словаря (content.ts GlossaryEntry.forms): то же + без концевой пунктуации
  (, ; : тоже) и без многоточия-«места для слова» («My name is …» → «my name is»).
- `tokens` — слова по границам (буквы и цифры, внутренний апостроф: i'm, don't, o'clock); `form_key` — токены через
  пробел: ключ уникальности формы в паре и поиска («Excuse me, where…» и «excuse me where» — одна форма).
- `forms_of` — формы элемента контента: варианты через « / » («Goodbye! / Bye!» → goodbye, bye).
- `contains` — есть ли последовательность токенов запроса в тексте подряд (дефис разделяет: check-in / check).
"""

from __future__ import annotations

import re
import unicodedata
from typing import Final

APOSTROPHES: Final = str.maketrans({"’": "'", "‘": "'", "`": "'", "ʼ": "'"})
_SPACES: Final = re.compile(r"\s+")
_EDGE_QUOTES: Final = "\"'«»“”„"
_TRAILING: Final = ".!?…"
_FORM_TRAILING: Final = ".!?…,;:"
_ELLIPSIS: Final = re.compile(r"…|\.{3,}")
_TOKEN: Final = re.compile(r"[^\W_]+(?:'[^\W_]+)*")
_HYPHEN_TOKEN: Final = re.compile(r"[^\W_]+(?:['-][^\W_]+)*")
MAX_FORMS: Final = 8
MAX_FORM_LEN: Final = 120


def _base(text: str) -> str:
    out = unicodedata.normalize("NFC", text).translate(APOSTROPHES).lower()
    return _SPACES.sub(" ", out).strip()


def _strip_edges(text: str, trailing: str) -> str:
    prev = None
    while prev != text:
        prev = text
        text = text.strip()
        if text and text[-1] in trailing:
            text = text[:-1]
        if len(text) >= 1 and text[0] in _EDGE_QUOTES:
            text = text[1:]
        if len(text) >= 1 and text[-1] in _EDGE_QUOTES:
            text = text[:-1]
    return text


def normalize(text: str) -> str:
    """§1.6: NFC, нижний регистр, апострофы, пробелы, без концевых . ! ? … и кавычек по краям."""
    return _strip_edges(_base(text), _TRAILING)


def normalize_form(text: str) -> str:
    """Форма статьи: §1.6 + без многоточия-места и концевой пунктуации , ; :."""
    out = _ELLIPSIS.sub(" ", _base(text))
    return _strip_edges(_SPACES.sub(" ", out).strip(), _FORM_TRAILING)


def tokens(text: str) -> list[str]:
    """Слова по границам: дефис разделяет (check-in → check, in)."""
    return _TOKEN.findall(_base(text))


def hyphen_tokens(text: str) -> list[str]:
    """Слова с дефисом как одно слово (check-in)."""
    return _HYPHEN_TOKEN.findall(_base(text))


def form_key(text: str) -> str:
    return " ".join(tokens(text))


def word_count(text: str) -> int:
    """Число слов предложения (дефисное слово — одно: well-known)."""
    return len(hyphen_tokens(text))


def split_alternatives(text: str) -> list[str]:
    """«Goodbye! / Bye!» → ["Goodbye!", "Bye!"]; «his / her» → ["his", "her"]."""
    return [p.strip() for p in re.split(r"\s+/\s+", text) if p.strip()]


def forms_of(text: str) -> list[str]:
    """Нормализованные формы элемента контента (варианты через « / »), без повторов по ключу, не больше 8."""
    out: list[str] = []
    keys: set[str] = set()
    for alt in split_alternatives(text):
        form = normalize_form(alt)
        key = form_key(form)
        if not key or key in keys or len(form) > MAX_FORM_LEN:
            continue
        keys.add(key)
        out.append(form)
        if len(out) == MAX_FORMS:
            break
    return out


def clean_lemma(text: str) -> str:
    """Лемма для показа: варианты без концевой . ! ? , через « / », пробелы схлопнуты, регистр сохранён."""
    parts = []
    for alt in split_alternatives(text):
        alt = _SPACES.sub(" ", unicodedata.normalize("NFC", alt).translate(APOSTROPHES)).strip()
        while alt and alt[-1] in ".!?,;:":
            alt = alt[:-1].rstrip()
        if alt:
            parts.append(alt)
    return " / ".join(parts)


def _contains_seq(hay: list[str], needle: list[str]) -> bool:
    n = len(needle)
    if n == 0 or n > len(hay):
        return False
    first = needle[0]
    return any(hay[i] == first and hay[i:i + n] == needle for i in range(len(hay) - n + 1))


def contains(text: str, query: str) -> bool:
    """Запрос встречается в тексте подряд по границам слов (без учёта регистра и пунктуации): «meet you» в «Nice to
    meet you, Tom.» — да; «eet» — нет. Дефис разделяет слова: «check» и «check-in» оба находятся в «check-in»."""
    return _contains_seq(tokens(text), tokens(query))
