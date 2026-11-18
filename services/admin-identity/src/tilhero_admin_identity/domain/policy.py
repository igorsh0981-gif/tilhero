"""Правила паролей и нормализация email."""

from __future__ import annotations

import re
import unicodedata

from tilhero_common.errors import unprocessable

MIN_LENGTH = 12
MAX_LENGTH = 256
# Только обычные адреса: буквы/цифры и . _ % + ' - до @, домен из меток. Угловые скобки, кавычки, запятые,
# пробелы — отказ (иначе «<a@b.ru>» из шаблона становился логином, которым нельзя войти).
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_EMAIL_RE = re.compile(rf"^[a-z0-9._%+'-]{{1,64}}@{_LABEL}(?:\.{_LABEL})+$")


def normalize_email(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().lower()


def is_valid_email(value: str) -> bool:
    return len(value) <= 254 and bool(_EMAIL_RE.match(value))


def mask_email(email: str) -> str:
    """i***@example.com — для аудита; полный email в журнал не пишем."""
    local, _, domain = email.partition("@")
    return f"{local[:1]}***@{domain}" if domain else "***"


def password_violations(password: str, *, email: str, same_as_previous: bool) -> list[str]:
    rules: list[str] = []
    if len(password) < MIN_LENGTH:
        rules.append("min_length_12")
    if not (any(c.isalpha() for c in password) and any(c.isdigit() for c in password)):
        rules.append("letters_and_digits")
    lowered = password.strip().lower()
    if lowered in {email.lower(), email.split("@", 1)[0].lower()}:
        rules.append("not_email")
    if same_as_previous:
        rules.append("not_previous")
    return rules


def ensure_strong(password: str, *, email: str, same_as_previous: bool) -> None:
    rules = password_violations(password, email=email, same_as_previous=same_as_previous)
    if rules:
        raise unprocessable("PASSWORD_WEAK", "Пароль не соответствует требованиям", {"rules": rules})
