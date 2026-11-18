"""Тексты сотрудников (версии шаблонов и рассылки) — чистые функции без БД и сети.

- плейсхолдеры — `{name}` (только идентификатор: без формата, преобразования, индекса и атрибута); `{{` и `}}` —
  буквальные скобки. Подстановка — строго из переданного словаря (str.format не вызывается: доступ к атрибутам
  и индексам невозможен по построению);
- проверка при сохранении (→ 422 `TEMPLATE_INVALID` / `CAMPAIGN_INVALID {fields: [{path, reason}]}`): оба языка,
  непустые title и body, длины (admin.ts: title ≤ 80, body ≤ 1000, button ≤ 32), только известные плейсхолдеры,
  без управляющих символов (перевод строки — только в body), для детских шаблонов — без слов давления.

Коды `reason`: `required`, `too_long`, `unknown_placeholder`, `invalid_placeholder` (непарная скобка, формат,
индекс), `control_chars`, `pressure_words`.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Mapping
from string import Formatter
from typing import Any

LANGS = ("ru", "uz")
FIELDS = ("title", "body", "button")
LIMITS = {"title": 80, "body": 1000, "button": 32}
# Предел отрисованного текста (после подстановки): центр уведомлений хранит title ≤ 200, body ≤ 1000;
# кнопка bot-gateway — ≤ 64
RENDERED_LIMITS = {"title": 200, "body": 1000, "button": 64}

# Детям и о детях — без давления: ни «потери серии», ни «провала», ни штрафов (CONVENTIONS §8). Тот же список
# проверяет тест детских шаблонов из кода (tests/test_notifications_templates.py).
PRESSURE_WORDS = re.compile(
    r"сери|потер|провал|теря|штраф|seriya|yoʻqot|muvaffaqiyatsiz|jarima", re.IGNORECASE
)
# Узбекский апостроф пишут по-разному (U+02BB, U+2018, U+2019, ', `, U+02BC): для проверки — к одному виду
_APOSTROPHES = str.maketrans({"'": "ʻ", "‘": "ʻ", "’": "ʻ", "`": "ʻ", "ʼ": "ʻ"})
# Управление направлением текста (подмена видимого порядка символов)
_BIDI = frozenset(chr(c) for c in (*range(0x202A, 0x202F), *range(0x2066, 0x206A)))
_IDENT = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
_SPACES = re.compile(r"[ \t]{2,}")

FieldError = dict[str, str]


class TextError(ValueError):
    """Текст сотрудника нельзя отрисовать (неизвестный плейсхолдер, непарная скобка)."""


def has_pressure(text: str) -> bool:
    return bool(PRESSURE_WORDS.search(text.translate(_APOSTROPHES)))


def has_control(text: str, *, allow_newline: bool) -> bool:
    for ch in text:
        if ch == "\n" and allow_newline:
            continue
        if unicodedata.category(ch) == "Cc" or ch in _BIDI:
            return True
    return False


def placeholders_in(text: str) -> list[str]:
    """Имена плейсхолдеров текста. ValueError — синтаксис (непарная скобка, формат `{x:>5}`, `{x!r}`, `{x.y}`,
    `{x[0]}`, `{}`)."""
    names: list[str] = []
    for _literal, field, spec, conversion in Formatter().parse(text):
        if field is None:
            continue
        if spec or conversion or not _IDENT.match(field):
            raise ValueError("invalid placeholder")
        names.append(field)
    return names


def substitute(text: str, values: Mapping[str, str]) -> str:
    """Подстановка строго из `values`; пробелы, сдвоенные пустым значением, схлопываются."""
    out: list[str] = []
    try:
        parsed = list(Formatter().parse(text))
    except ValueError as exc:
        raise TextError("invalid placeholder syntax") from exc
    for literal, field, spec, conversion in parsed:
        out.append(literal)
        if field is None:
            continue
        if spec or conversion or not _IDENT.match(field) or field not in values:
            raise TextError("unknown placeholder")
        out.append(values[field])
    return "\n".join(_SPACES.sub(" ", line).strip() for line in "".join(out).split("\n")).strip()


def normalize(text: Any) -> dict[str, dict[str, str | None]] | None:
    """Тексты к хранению: обрезка пробелов по краям, пустая кнопка → null. Вход уже прошёл check_texts."""
    if not isinstance(text, Mapping):
        return None
    result: dict[str, dict[str, str | None]] = {}
    for lang in LANGS:
        item = text.get(lang) or {}
        button = item.get("button")
        result[lang] = {
            "title": str(item.get("title") or "").strip(),
            "body": str(item.get("body") or "").strip(),
            "button": button.strip() if isinstance(button, str) and button.strip() else None,
        }
    return result


def check_texts(
    texts: Mapping[str, Any] | None, *, allowed: Iterable[str], kid: bool = False, prefix: str = "texts"
) -> list[FieldError]:
    """Ошибки по полям: [{path: "texts.uz.body", reason: "required"}, …]; пусто — тексты годны."""
    allowed_set = frozenset(allowed)
    errors: list[FieldError] = []
    for lang in LANGS:
        item = texts.get(lang) if isinstance(texts, Mapping) else None
        if not isinstance(item, Mapping):
            errors.append({"path": f"{prefix}.{lang}", "reason": "required"})
            continue
        for field in FIELDS:
            path = f"{prefix}.{lang}.{field}"
            value = item.get(field)
            if value is None or (isinstance(value, str) and not value.strip()):
                if field != "button":
                    errors.append({"path": path, "reason": "required"})
                continue
            if not isinstance(value, str):
                errors.append({"path": path, "reason": "required"})
                continue
            value = value.strip()
            if len(value) > LIMITS[field]:
                errors.append({"path": path, "reason": "too_long"})
            if has_control(value, allow_newline=field == "body"):
                errors.append({"path": path, "reason": "control_chars"})
            try:
                names = placeholders_in(value)
            except ValueError:
                errors.append({"path": path, "reason": "invalid_placeholder"})
            else:
                if any(name not in allowed_set for name in names):
                    errors.append({"path": path, "reason": "unknown_placeholder"})
            if kid and has_pressure(value):
                errors.append({"path": path, "reason": "pressure_words"})
    return errors


def check_plain(value: str | None, *, path: str, limit: int, required: bool = True) -> list[FieldError]:
    """Простой текст сотрудника (название рассылки): непустой, длина, без управляющих символов."""
    if value is None or not value.strip():
        return [{"path": path, "reason": "required"}] if required else []
    errors: list[FieldError] = []
    if len(value.strip()) > limit:
        errors.append({"path": path, "reason": "too_long"})
    if has_control(value, allow_newline=False):
        errors.append({"path": path, "reason": "control_chars"})
    return errors
