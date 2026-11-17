"""Язык интерфейса из Telegram language_code (IETF-тег): uz → uz, иначе ru (MVP: интерфейс RU и UZ)."""

from __future__ import annotations

from typing import Literal

Locale = Literal["ru", "uz"]


def locale_from_language_code(code: str | None) -> Locale:
    if not code:
        return "ru"
    primary = code.strip().lower().replace("_", "-").split("-", 1)[0]
    return "uz" if primary == "uz" else "ru"
