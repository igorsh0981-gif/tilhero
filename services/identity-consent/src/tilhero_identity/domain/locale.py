"""Язык интерфейса из Telegram language_code (IETF-тег): ru/uz/kk/be/uk → ru, иначе en."""

from __future__ import annotations

from typing import Literal

Locale = Literal["ru", "en"]

RU_LANGUAGES = frozenset({"ru", "uz", "kk", "be", "uk"})


def locale_from_language_code(code: str | None) -> Locale:
    if not code:
        return "en"
    primary = code.strip().lower().replace("_", "-").split("-", 1)[0]
    return "ru" if primary in RU_LANGUAGES else "en"
