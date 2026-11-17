"""Белый список токенов темы и строгая проверка значений (ТЗ UI/CSS §4–5: никакого произвольного CSS/JS).

Каждый токен имеет тип; значение проверяется грамматикой этого типа целиком (fullmatch):
  color  — #RGB, #RGBA, #RRGGBB, #RRGGBBAA, rgb(r,g,b), rgba(r,g,b,a);
  length — 0 | N px | N rem | N % (неотрицательная; единицы и диапазон задаются токеном);
  number — десятичное число (диапазон задаётся токеном);
  font   — одно семейство бренда (Manrope / Unbounded / JetBrains Mono; системные фолбэки добавляет клиент)
           или, где токен это допускает, стек из бренда и системных фолбэков;
  shadow — до 3 теней из длин px и цвета (`inset` допускается), либо none.
url(), expression(), var(), javascript:, ;, {, }, <, >, \\, @, кавычки вне шрифта и т.п.
в эти грамматики не входят.

Mini App: набор токенов = allowlist санитайзера Mini App (packages/ui-tokens/token-names.json — CSS-слои,
выведенные из согласованного прототипа proto/miniapp/src/01-base.css): сервер принимает только то, что клиент
действительно применит, и проверяет значения не мягче клиента. Совпадение имён и типов проверяет контрактный
тест (tests/test_exp_validation.py). Ширины рельсов Home — доли ширины в границах ТЗ UI/CSS §7
(0.85–0.90 / 0.65–0.75). Admin — токены :root прототипа proto/admin/src/02-style.css.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Final, Literal

Kind = Literal["color", "length", "number", "font", "shadow"]


@dataclass(frozen=True)
class TokenSpec:
    kind: Kind
    min: float | None = None  # для length/number: допустимый диапазон
    max: float | None = None
    units: tuple[str, ...] = ("px", "rem", "%")
    single_family: bool = False  # font: только одно семейство бренда (форма, которую принимает Mini App)


def _colors(*names: str) -> dict[str, TokenSpec]:
    return {n: TokenSpec("color") for n in names}


_RADIUS = TokenSpec("length", 0, 64, ("px", "rem"))
_SPACE = TokenSpec("length", 0, 64, ("px", "rem"))
_FONT_STACK = TokenSpec("font")
_FONT_FAMILY = TokenSpec("font", single_family=True)
_SHADOW = TokenSpec("shadow")

MINIAPP_TOKENS: Final[dict[str, TokenSpec]] = {
    **_colors(
        "--bg", "--bg-2", "--surface", "--surface-2", "--surface-3", "--line", "--line-2",
        "--ink", "--ink-2", "--muted",
        "--accent", "--accent-ink", "--accent-tx", "--accent-soft", "--accent-line",
        "--focus", "--btn-bg", "--btn-tx",
        "--good", "--good-soft", "--warn", "--warn-soft", "--bad", "--bad-soft", "--info", "--info-soft",
        "--chrome", "--tabbar", "--scrim", "--sheet-bg", "--card-border", "--knob-on",
        "--match-bg", "--match-ink",
    ),
    "--r-card": _RADIUS,
    "--r-btn": _RADIUS,
    "--r-field": _RADIUS,
    "--r-chip-grid": _RADIUS,
    "--r-sheet": _RADIUS,
    "--gutter": TokenSpec("length", 8, 32, ("px",)),
    **{f"--sp-{n}": _SPACE for n in (1, 2, 3, 4, 5, 6, 8)},
    "--ec-media-h": TokenSpec("length", 120, 320, ("px",)),
    "--rail-w": TokenSpec("number", 0.85, 0.90),  # «Лучшее для вас»: виден край следующей карточки
    "--rail-w-compact": TokenSpec("number", 0.65, 0.75),
    "--font-display": _FONT_FAMILY,
    "--font-body": _FONT_FAMILY,
}

ADMIN_TOKENS: Final[dict[str, TokenSpec]] = {
    **_colors(
        "--bg", "--surface", "--surface-2", "--surface-3", "--surface-sunk", "--line", "--line-strong",
        "--ink", "--ink-2", "--muted", "--faint", "--field-line",
        "--nav", "--nav-2", "--nav-3", "--nav-ink", "--nav-ink-strong", "--nav-muted", "--nav-line",
        "--accent", "--accent-press", "--accent-ink", "--primary", "--primary-ink", "--primary-hover",
        "--info", "--info-bg", "--info-ink", "--info-line",
        "--good", "--good-bg", "--good-ink", "--good-line",
        "--warn", "--warn-bg", "--warn-ink", "--warn-line", "--bad", "--bad-bg", "--bad-ink", "--bad-line",
        "--neutral-bg", "--neutral-ink", "--note-bg", "--note-line", "--note-ink", "--focus", "--scrim",
        "--chart-grid", "--chart-axis", "--chart-label", "--s1", "--s2", "--s3", "--s4", "--s-other",
        "--s-single", "--s-ghost", "--code-key", "--code-str", "--code-num", "--code-bool",
        "--diff-add", "--diff-add-ink", "--diff-del", "--diff-del-ink",
    ),
    "--shadow-pop": _SHADOW,
    "--shadow-drawer": _SHADOW,
    "--r-xs": _RADIUS,
    "--r-sm": _RADIUS,
    "--r": _RADIUS,
    "--r-lg": _RADIUS,
    "--nav-w": TokenSpec("length", 180, 360, ("px",)),
    "--top-h": TokenSpec("length", 40, 96, ("px",)),
    "--font-ui": _FONT_STACK,
    "--font-display": _FONT_STACK,
    "--font-mono": _FONT_STACK,
}

# Шрифты бренда (Google Fonts с кириллицей, BRIEF заказчика) и системные фолбэки для стеков.
BRAND_FONTS: Final[frozenset[str]] = frozenset({"Manrope", "Unbounded", "JetBrains Mono"})
ALLOWED_FONTS: Final[frozenset[str]] = BRAND_FONTS | frozenset({
    "ui-sans-serif", "ui-monospace", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI",
    "Roboto", "Helvetica Neue", "Arial", "Menlo", "Consolas", "sans-serif", "monospace",
})
MAX_FONT_FAMILIES = 8
MAX_SHADOWS = 3

# Явные опасные конструкции — отдельная причина в ответе (для аудита попыток инъекции).
_FORBIDDEN = re.compile(r"url\s*\(|expression\s*\(|javascript\s*:|var\s*\(|@import|<|>|\\|;|\{|\}|/\*|\*/",
                        re.IGNORECASE)

_HEX = re.compile(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})")
_NUM = r"(?:\d{1,3}(?:\.\d{1,4})?|\.\d{1,4})"
_RGB = re.compile(r"rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)")
_RGBA = re.compile(rf"rgba\(\s*(\d{{1,3}})\s*,\s*(\d{{1,3}})\s*,\s*(\d{{1,3}})\s*,\s*({_NUM})(%?)\s*\)")
_LENGTH = re.compile(r"(-?)(\d{1,4}(?:\.\d{1,3})?|\.\d{1,3})(px|rem|%)?")
_NUMBER = re.compile(r"-?(?:\d{1,6}(?:\.\d{1,4})?|\.\d{1,4})")
_FAMILY = re.compile(
    r'"([A-Za-z][A-Za-z0-9 \-]{0,40})"'  # "Segoe UI"
    r"|'([A-Za-z][A-Za-z0-9 \-]{0,40})'"  # 'JetBrains Mono'
    r"|(-?[A-Za-z][A-Za-z0-9\-]{0,40})"  # system-ui, -apple-system
)


class TokenError(ValueError):
    """reason: unknown_token | forbidden_construct | invalid_<kind> | out_of_range | too_long."""

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


def _length(value: str, *, allow_negative: bool, units: tuple[str, ...]) -> Decimal | None:
    m = _LENGTH.fullmatch(value)
    if not m:
        return None
    sign, num, unit = m.groups()
    amount = Decimal(num)
    if unit is None:
        return Decimal(0) if amount == 0 and not sign else None  # без единицы допустим только 0
    if unit not in units or (sign and not allow_negative):
        return None
    return -amount if sign else amount


def _family(part: str) -> str | None:
    m = _FAMILY.fullmatch(part.strip())
    return next(g for g in m.groups() if g is not None) if m else None


def is_font_family(value: str) -> bool:
    """Одно семейство бренда, в кавычках или без: Manrope, "JetBrains Mono"."""
    return _family(value) in BRAND_FONTS


def is_font_stack(value: str) -> bool:
    parts = value.split(",")
    if not parts or len(parts) > MAX_FONT_FAMILIES:
        return False
    return all(_family(p) in ALLOWED_FONTS for p in parts)


def _split_top(value: str) -> list[str]:
    """Разделить по запятым верхнего уровня (не внутри rgba(...))."""
    out: list[str] = []
    cur: list[str] = []
    depth = 0
    for ch in value:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    out.append("".join(cur))
    return [x.strip() for x in out]


def is_shadow(value: str) -> bool:
    if value == "none":
        return True
    layers = _split_top(value)
    if len(layers) > MAX_SHADOWS:
        return False
    for layer in layers:
        # цвет — последний элемент; rgba(...) содержит пробелы только внутри скобок
        m = re.fullmatch(r"(inset\s+)?((?:\S+\s+){1,3}\S+)\s+(#[0-9a-fA-F]{3,8}|rgba?\([^()]*\))", layer)
        if not m:
            return False
        lengths = m.group(2).split()
        if not 2 <= len(lengths) <= 4:
            return False
        for i, item in enumerate(lengths):
            # смещения могут быть отрицательными, размытие (3-й) — нет; только px
            amount = _length(item, allow_negative=i != 2, units=("px",))
            if amount is None or abs(amount) > 200:
                return False
        if not is_color(m.group(3)):
            return False
    return True


def _check_range(amount: Decimal, spec: TokenSpec) -> None:
    if spec.min is not None and amount < Decimal(str(spec.min)):
        raise TokenError("out_of_range")
    if spec.max is not None and amount > Decimal(str(spec.max)):
        raise TokenError("out_of_range")


def validate_token(name: str, value: str, whitelist: dict[str, TokenSpec]) -> None:
    spec = whitelist.get(name)
    if spec is None:
        raise TokenError("unknown_token")
    if not isinstance(value, str):
        raise TokenError("invalid_type")
    if len(value) > 300:
        raise TokenError("too_long")
    if _FORBIDDEN.search(value) or any(ord(ch) < 0x20 for ch in value):
        raise TokenError("forbidden_construct")
    if spec.kind == "color":
        if not is_color(value):
            raise TokenError("invalid_color")
    elif spec.kind == "length":
        amount = _length(value, allow_negative=False, units=spec.units)
        if amount is None:
            raise TokenError("invalid_length")
        _check_range(amount, spec)
    elif spec.kind == "number":
        if not _NUMBER.fullmatch(value):
            raise TokenError("invalid_number")
        _check_range(Decimal(value), spec)
    elif spec.kind == "font":
        if not (is_font_family(value) if spec.single_family else is_font_stack(value)):
            raise TokenError("invalid_font")
    elif spec.kind == "shadow" and not is_shadow(value):
        raise TokenError("invalid_shadow")
