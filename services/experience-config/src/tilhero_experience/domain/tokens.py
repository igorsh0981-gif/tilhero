"""Белый список токенов темы и строгая проверка значений (никакого произвольного CSS/JS).

Каждый токен имеет тип; значение проверяется грамматикой этого типа целиком (fullmatch):
  color  — #RGB, #RGBA, #RRGGBB, #RRGGBBAA, rgb(r,g,b), rgba(r,g,b,a);
  length — 0 | N px | N rem (неотрицательная; диапазон токена задан в px, 1rem = 16px);
  number — десятичное число (диапазон задаётся токеном);
  font   — Mini App: одно семейство бренда (Onest / Unbounded / Caveat; фолбэки добавляет клиент);
           Admin: стек из бренда и системных фолбэков.
url(), expression(), var(), javascript:, ;, {, }, <, >, \\, комментарии и управляющие символы в эти грамматики
не входят.

Mini App: набор токенов = allowlist санитайзера Mini App (packages/ui-tokens/token-names.json, визуальный язык
«Тетрадь» прототипа TilHero: бумага, сетка, чернила, ручка, маркер, поля): сервер принимает только то, что клиент
действительно применит, и проверяет значения не мягче клиента. Совпадение имён, типов и шрифтов проверяет контрактный
тест (tests/test_exp_validation.py). Admin — токены `.ad` прототипа админки TilHero (Admin.dc.html).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Final, Literal

Kind = Literal["color", "length", "number", "font"]
REM_PX: Final = Decimal(16)


@dataclass(frozen=True)
class TokenSpec:
    kind: Kind
    min: float | None = None  # length — в px (rem пересчитывается), number — как есть
    max: float | None = None
    units: tuple[str, ...] = ("px", "rem")
    single_family: bool = False  # font: только одно семейство бренда (форма, которую принимает Mini App)


def _colors(*names: str) -> dict[str, TokenSpec]:
    return {n: TokenSpec("color") for n in names}


_FONT_FAMILY = TokenSpec("font", single_family=True)
_FONT_STACK = TokenSpec("font")

MINIAPP_TOKENS: Final[dict[str, TokenSpec]] = {
    **_colors(
        "--paper", "--grid", "--ink", "--ink2", "--line", "--card",
        "--pen", "--pen-ink", "--pen-soft", "--mark", "--margin",
        "--err", "--err-soft", "--ok", "--ok-soft", "--warn", "--warn-soft", "--scrim",
    ),
    "--r-card": TokenSpec("length", 0, 32),
    "--r-btn": TokenSpec("length", 0, 24),
    "--r-field": TokenSpec("length", 0, 24),
    "--r-sheet": TokenSpec("length", 0, 32),
    "--gutter": TokenSpec("length", 8, 32, ("px",)),  # поле экрана 390 px: меньше 8 — текст у края
    "--font-display": _FONT_FAMILY,
    "--font-body": _FONT_FAMILY,
    "--font-hand": _FONT_FAMILY,
}

ADMIN_TOKENS: Final[dict[str, TokenSpec]] = {
    **_colors(
        "--bg", "--card", "--ink", "--ink2", "--line", "--pen", "--pen-soft", "--side", "--side2",
        "--ok", "--ok-soft", "--warn", "--warn-soft", "--err", "--err-soft",
    ),
    "--r-card": TokenSpec("length", 0, 32),
    "--r-btn": TokenSpec("length", 0, 24),
    "--r-field": TokenSpec("length", 0, 24),
    "--nav-w": TokenSpec("length", 180, 360, ("px",)),
    "--font-ui": _FONT_STACK,
    "--font-display": _FONT_STACK,
    "--font-mono": _FONT_STACK,
}

# Шрифты бренда TilHero (Google Fonts с кириллицей и узбекской латиницей): интерфейс, заголовки, «рукописные» пометки
# на полях тетради. Admin — плюс системные фолбэки для стеков.
BRAND_FONTS: Final[frozenset[str]] = frozenset({"Onest", "Unbounded", "Caveat"})
ALLOWED_FONTS: Final[frozenset[str]] = BRAND_FONTS | frozenset({
    "ui-sans-serif", "ui-monospace", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI",
    "Roboto", "Helvetica Neue", "Arial", "SFMono-Regular", "Menlo", "Consolas", "sans-serif", "monospace", "cursive",
})
MAX_FONT_FAMILIES = 8

# Явные опасные конструкции — отдельная причина в ответе (для аудита попыток инъекции).
_FORBIDDEN = re.compile(r"url\s*\(|expression\s*\(|javascript\s*:|var\s*\(|@import|<|>|\\|;|\{|\}|/\*|\*/",
                        re.IGNORECASE)

_HEX = re.compile(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})")
_NUM = r"(?:\d{1,3}(?:\.\d{1,4})?|\.\d{1,4})"
_RGB = re.compile(r"rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)")
_RGBA = re.compile(rf"rgba\(\s*(\d{{1,3}})\s*,\s*(\d{{1,3}})\s*,\s*(\d{{1,3}})\s*,\s*({_NUM})(%?)\s*\)")
_LENGTH = re.compile(r"(-?)(\d{1,4}(?:\.\d{1,3})?|\.\d{1,3})(px|rem|em|%)?")
_NUMBER = re.compile(r"-?(?:\d{1,6}(?:\.\d{1,4})?|\.\d{1,4})")
_FAMILY = re.compile(
    r'"([A-Za-z][A-Za-z0-9 \-]{0,40})"'  # "Segoe UI"
    r"|'([A-Za-z][A-Za-z0-9 \-]{0,40})'"  # 'Helvetica Neue'
    r"|(-?[A-Za-z][A-Za-z0-9\-]{0,40})"  # system-ui, -apple-system
)


class TokenError(ValueError):
    """reason: unknown_token | forbidden_construct | invalid_<kind> | out_of_range | too_long | invalid_type."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def is_color(value: str) -> bool:
    if _HEX.fullmatch(value):
        return True
    m = _RGB.fullmatch(value)
    if m:
        return all(int(x) <= 255 for x in m.groups())
    m = _RGBA.fullmatch(value)
    if m:
        r, g, b, a, pct = m.groups()
        alpha_ok = Decimal(a) <= (100 if pct else 1)
        return all(int(x) <= 255 for x in (r, g, b)) and alpha_ok
    return False


def length_px(value: str, units: tuple[str, ...]) -> Decimal | None:
    """Неотрицательная длина в px (rem × 16) или None, если значение вне грамматики/единиц токена."""
    m = _LENGTH.fullmatch(value)
    if not m:
        return None
    sign, num, unit = m.groups()
    amount = Decimal(num)
    if unit is None:
        return Decimal(0) if amount == 0 and not sign else None  # без единицы допустим только 0
    if unit not in units or sign:
        return None
    return amount * REM_PX if unit == "rem" else amount


def _family(part: str) -> str | None:
    m = _FAMILY.fullmatch(part.strip())
    return next(g for g in m.groups() if g is not None) if m else None


def is_font_family(value: str) -> bool:
    """Одно семейство бренда, в кавычках или без: Onest, "Unbounded"."""
    return _family(value) in BRAND_FONTS


def is_font_stack(value: str) -> bool:
    parts = value.split(",")
    if not parts or len(parts) > MAX_FONT_FAMILIES:
        return False
    return all(_family(p) in ALLOWED_FONTS for p in parts)


def _check_range(amount: Decimal, spec: TokenSpec) -> None:
    if spec.min is not None and amount < Decimal(str(spec.min)):
        raise TokenError("out_of_range")
    if spec.max is not None and amount > Decimal(str(spec.max)):
        raise TokenError("out_of_range")


def validate_token(name: str, value: object, whitelist: dict[str, TokenSpec]) -> None:
    spec = whitelist.get(name)
    if spec is None:
        raise TokenError("unknown_token")
    if not isinstance(value, str):
        raise TokenError("invalid_type")
    if len(value) > 200:
        raise TokenError("too_long")
    if _FORBIDDEN.search(value) or any(ord(ch) < 0x20 for ch in value):
        raise TokenError("forbidden_construct")
    if spec.kind == "color":
        if not is_color(value):
            raise TokenError("invalid_color")
    elif spec.kind == "length":
        amount = length_px(value, spec.units)
        if amount is None:
            raise TokenError("invalid_length")
        _check_range(amount, spec)
    elif spec.kind == "number":
        if not _NUMBER.fullmatch(value):
            raise TokenError("invalid_number")
        _check_range(Decimal(value), spec)
    elif spec.kind == "font" and not (is_font_family(value) if spec.single_family else is_font_stack(value)):
        raise TokenError("invalid_font")
