"""Ник и код друга (§1.1) — чистые правила.

Ник: 3–20 символов, буквы RU/UZ/EN (кириллица русская и узбекская ЎҚҒҲ, латиница, узбекские ʻ ʼ), цифры, «_».
Ввод нормализуется в NFC (й из «и + ˘» — одна буква), пробелы по краям убираются.

- **Ключ уникальности** (`nickname_lc`): регистр не важен, ё = е, кириллические двойники латинских букв
  (А/A, В/B, Е/E, К/K, М/M, Н/H, О/O, Р/P, С/C, Т/T, У/Y, Х/X и строчные г/r, и/u, п/n, ш/w, ь/b) — одна буква:
  «Аdmin» с кириллической А и «Admin» — один ник.
- **Запрещённые слова** — список корней RU/UZ/EN (мат, оскорбления, выдача себя за сотрудника); проверка после
  нормализации ключа + цифр-подстановок (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, 8→b) без «_» и апострофов.

Код друга — `TH-XXXX-XXXX`, алфавит без 0/O/1/I (32 символа: 8 знаков ≈ 40 бит). Поиск — без учёта регистра и
дефисов.
"""

from __future__ import annotations

import re
import secrets
import unicodedata
from typing import Final

MIN_LEN: Final = 3
MAX_LEN: Final = 20
_ALLOWED_RE: Final = re.compile(r"^[A-Za-z0-9_А-яЁёЎўҚқҒғ"
                                r"Ҳҳʻʼ]+$")

# кириллица → латинский двойник (после casefold)
_TWINS: Final = {
    "а": "a", "в": "b", "г": "r", "е": "e", "ё": "e", "и": "u", "к": "k", "м": "m", "н": "h", "о": "o", "п": "n",
    "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ш": "w", "ь": "b", "қ": "k", "ҳ": "x", "ў": "y",
    "ʼ": "ʻ",
}
_LEET: Final = {"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "l": "i"}

# корни запрещённых слов (пишутся как есть; сравниваются в нормализованном виде — см. _fold). Без коротких корней,
# которые дают ложные срабатывания на имена (nazi → Nazira, манда → Аманда, еба → Себастьян)
_FORBIDDEN_RAW: Final = (
    # RU: мат и оскорбления
    "хуй", "хуе", "хуё", "хуя", "пизд", "ебан", "ебат", "ебал", "заеб", "уеб", "выеб", "долбоеб", "бляд",
    "блят", "сука", "мудак", "мудил", "пидор", "пидар", "педик", "гандон", "залуп", "шлюх", "дрочи", "дебил",
    "уебок", "чмо",
    # UZ
    "jalab", "qanjiq", "qotoq", "qotaq", "kotak", "sikaman", "sikay", "siktir", "dalbayob", "dolbayob", "onangni",
    "haromi", "харомий", "жалаб", "қанжиқ", "сикаман",
    # EN
    "fuck", "shit", "bitch", "cunt", "dick", "pussy", "whore", "slut", "nigger", "nigga", "faggot", "porn",
    "hitler", "asshole", "bastard",
    # выдача себя за сотрудника или сервис
    "admin", "админ", "moderator", "модератор", "tilhero", "тилхеро", "support", "поддержка", "official",
)


def _norm(raw: str) -> str:
    return unicodedata.normalize("NFC", raw.strip())


def unique_key(nickname: str) -> str:
    """Ключ уникальности: casefold, ё=е, кириллические двойники → латиница (длина не меняется)."""
    return "".join(_TWINS.get(ch, ch) for ch in unicodedata.normalize("NFC", nickname).casefold())


def _fold(value: str) -> str:
    key = unique_key(value)
    return "".join(_LEET.get(ch, ch) for ch in key if ch not in "_ʻ")


_FORBIDDEN: Final = tuple(sorted({_fold(w) for w in _FORBIDDEN_RAW}))


def validate(raw: str) -> tuple[str, str | None]:
    """→ (нормализованный ник, причина отказа | None): length | chars | forbidden."""
    nick = _norm(raw)
    if not MIN_LEN <= len(nick) <= MAX_LEN:
        return nick, "length"
    if not _ALLOWED_RE.match(nick):
        return nick, "chars"
    folded = _fold(nick)
    if any(root in folded for root in _FORBIDDEN):
        return nick, "forbidden"
    return nick, None


# ---------------------------------------------------------------- код друга

CODE_ALPHABET: Final = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_CODE_RE: Final = re.compile(rf"^TH[{CODE_ALPHABET}]{{8}}$")


def new_friend_code() -> str:
    body = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    return f"TH-{body[:4]}-{body[4:]}"


def parse_friend_code(q: str) -> str | None:
    """Ввод поиска → код TH-XXXX-XXXX или None (не код). Без учёта регистра, дефисов и пробелов."""
    compact = re.sub(r"[\s\-‐-―]", "", q).upper()
    if not _CODE_RE.match(compact):
        return None
    return f"TH-{compact[2:6]}-{compact[6:]}"
