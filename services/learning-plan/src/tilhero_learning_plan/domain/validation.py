"""Бизнес-валидация предпочтений (TG-FR-010…017, BR-TG-002…004) — чистые функции без FastAPI.

Каждая ошибка — PreferencesInvalid(field, reason): field — путь поля в контракте,
reason — машинный код причины (клиент локализует по нему).
Пользовательский текст (entities, города) в details не возвращается.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from typing import Any

from pydantic_core import ErrorDetails

from tilhero_learning_plan.directory import airports
from tilhero_learning_plan.directory.geo import ISO_COUNTRIES, REGIONS
from tilhero_learning_plan.directory.taxonomy import CATEGORY_CODES
from tilhero_learning_plan.schemas import BudgetIn, FlightPrefsIn, GeographyIn, HotelPrefsIn, InterestsIn

MAX_ENTITIES = 20
ENTITY_LEN = (1, 60)
MAX_GEOGRAPHIES = 30
CITY_LEN = (1, 60)
MAX_DEPARTURES = 10
CUSTOM_BUDGET = (50, 100_000)

BUDGET_PRESETS: dict[str, tuple[int, int]] = {
    "under_500": (0, 500),
    "500_1000": (500, 1000),
    "1000_2000": (1000, 2000),
    "2000_5000": (2000, 5000),
}
BUDGET_BOUNDS = frozenset(b for rng in BUDGET_PRESETS.values() for b in rng)
FORMAT_ORDER = ("offline", "online")
# 6.3: настройки отеля — значения чипов Mini App (0 — «любая оценка»)
HOTEL_RATINGS = (0.0, 7.0, 7.5, 8.0, 8.5, 9.0)
HOTEL_DISTANCES_KM = (1, 3, 5, 10, 15)
HOTEL_STARS = (3, 4, 5)

# Английское название города: латиница (в т.ч. с диакритикой — São Paulo, Nevşehir),
# пробел, дефис, апостроф, точка.
_CITY_RE = re.compile(r"^[A-Za-zÀ-ɏḀ-ỿ][A-Za-zÀ-ɏḀ-ỿ' .\-]*$")


class PreferencesInvalid(Exception):
    def __init__(self, field: str, reason: str, **extra: Any) -> None:
        super().__init__(f"{field}: {reason}")
        self.field = field
        self.reason = reason
        self.extra = extra


def _clean_text(value: str) -> str:
    """trim + схлопывание пробелов; управляющие символы недопустимы."""
    if any(unicodedata.category(ch) in {"Cc", "Cf", "Cs", "Co"} for ch in value):
        raise ValueError("control")
    return " ".join(value.split())


# ---------------------------------------------------------------- поля


def interests(value: InterestsIn) -> dict[str, list[str]]:
    cats: list[str] = []
    for code in value.categories:
        if code not in CATEGORY_CODES:
            raise PreferencesInvalid("interests.categories", "unknown_category", value=code[:64])
        if code in cats:
            raise PreferencesInvalid("interests.categories", "duplicate", value=code)
        cats.append(code)
    if len(value.entities) > MAX_ENTITIES:
        raise PreferencesInvalid("interests.entities", "too_many", max=MAX_ENTITIES)
    ents: list[str] = []
    seen: set[str] = set()
    for raw in value.entities:
        try:
            text = _clean_text(raw)
        except ValueError:
            raise PreferencesInvalid("interests.entities", "invalid_chars") from None
        if not ENTITY_LEN[0] <= len(text) <= ENTITY_LEN[1]:
            raise PreferencesInvalid("interests.entities", "length", min=ENTITY_LEN[0], max=ENTITY_LEN[1])
        key = text.casefold()
        if key in seen:
            raise PreferencesInvalid("interests.entities", "duplicate")
        seen.add(key)
        ents.append(text)
    return {"categories": cats, "entities": ents}


def geographies(items: list[GeographyIn]) -> list[dict[str, str]]:
    if len(items) > MAX_GEOGRAPHIES:
        raise PreferencesInvalid("geographies", "too_many", max=MAX_GEOGRAPHIES)
    out: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for g in items:
        if g.level == "world":
            if g.code not in (None, ""):
                raise PreferencesInvalid("geographies.code", "not_allowed")
            item = {"level": "world"}
            key = ("world", "")
        elif g.level == "region":
            if g.code not in REGIONS:
                raise PreferencesInvalid("geographies.code", "unknown_region")
            item, key = {"level": "region", "code": g.code}, ("region", g.code)
        elif g.level == "country":
            code = (g.code or "").strip().upper()
            if code not in ISO_COUNTRIES:
                raise PreferencesInvalid("geographies.code", "unknown_country")
            item, key = {"level": "country", "code": code}, ("country", code)
        else:  # city — English naming
            try:
                city = _clean_text(g.code or "")
            except ValueError:
                raise PreferencesInvalid("geographies.code", "invalid_chars") from None
            if not CITY_LEN[0] <= len(city) <= CITY_LEN[1]:
                raise PreferencesInvalid("geographies.code", "length", min=CITY_LEN[0], max=CITY_LEN[1])
            if not _CITY_RE.match(city):
                raise PreferencesInvalid("geographies.code", "english_name_required")
            item, key = {"level": "city", "code": city}, ("city", city.casefold())
        if key in seen:
            raise PreferencesInvalid("geographies", "duplicate")
        seen.add(key)
        out.append(item)
    # «Весь мир» исключает остальные варианты (как чипы прототипа: world снимает страны и наоборот).
    if ("world", "") in seen and len(out) > 1:
        raise PreferencesInvalid("geographies", "world_exclusive")
    return out


def event_formats(items: list[str]) -> list[str]:
    if not items:
        raise PreferencesInvalid("event_formats", "empty")
    if len(set(items)) != len(items):
        raise PreferencesInvalid("event_formats", "duplicate")
    return [f for f in FORMAT_ORDER if f in items]


def budget(value: BudgetIn) -> dict[str, Any]:
    """Нормализованный бюджет на 1 человека, USD (BR-TG-002, BR-TG-003, TG-FR-013/014)."""
    base = {"currency": "USD", "preset": None, "min": None, "max": None, "custom_amount": None}
    if value.preset == "custom":
        amount = value.custom_amount
        if amount is None:
            raise PreferencesInvalid("budget.custom_amount", "required")
        if not CUSTOM_BUDGET[0] <= amount <= CUSTOM_BUDGET[1]:
            raise PreferencesInvalid("budget.custom_amount", "out_of_range", min=CUSTOM_BUDGET[0],
                                     max=CUSTOM_BUDGET[1])
        return {**base, "preset": "custom", "min": 0, "max": amount, "custom_amount": amount}
    if value.custom_amount is not None:
        raise PreferencesInvalid("budget.custom_amount", "not_allowed")
    if value.preset is not None:
        # min/max пресета вычисляет сервис; присланные клиентом значения игнорируются
        # (round-trip GET → PATCH не ломается).
        lo, hi = BUDGET_PRESETS[value.preset]
        return {**base, "preset": value.preset, "min": lo, "max": hi}
    if value.min is None and value.max is None:
        return base  # бюджет не задан
    for name, bound in (("min", value.min), ("max", value.max)):
        if bound is None:
            raise PreferencesInvalid(f"budget.{name}", "required")
        if bound not in BUDGET_BOUNDS:
            raise PreferencesInvalid(f"budget.{name}", "not_preset_boundary", allowed=sorted(BUDGET_BOUNDS))
    assert value.min is not None and value.max is not None
    if value.min >= value.max:
        raise PreferencesInvalid("budget.max", "invalid_range")
    for preset, (lo, hi) in BUDGET_PRESETS.items():
        if (lo, hi) == (value.min, value.max):
            return {**base, "preset": preset, "min": lo, "max": hi}
    return {**base, "min": value.min, "max": value.max}


def notification_points(points: Sequence[int], horizon: int) -> list[int]:
    if len(set(points)) != len(points):
        raise PreferencesInvalid("notification_points_months", "duplicate")
    if any(p > horizon for p in points):
        raise PreferencesInvalid("notification_points_months", "exceeds_horizon", horizon=horizon)
    return sorted(points)


def flight_prefs(value: FlightPrefsIn) -> dict[str, bool]:
    if not (value.direct or value.connecting):
        raise PreferencesInvalid("flight_prefs", "at_least_one")
    return value.model_dump()


def hotel_prefs(value: HotelPrefsIn) -> dict[str, Any]:
    """null — значение по умолчанию; «любые звёзды» (0) хранится как null."""
    rating = value.rating_min
    if rating is not None and float(rating) not in HOTEL_RATINGS:
        raise PreferencesInvalid("hotel_prefs.rating_min", "not_allowed", allowed=list(HOTEL_RATINGS))
    if value.max_distance_km is not None and value.max_distance_km not in HOTEL_DISTANCES_KM:
        raise PreferencesInvalid("hotel_prefs.max_distance_km", "not_allowed", allowed=list(HOTEL_DISTANCES_KM))
    stars = value.min_stars or None
    if stars is not None and stars not in HOTEL_STARS:
        raise PreferencesInvalid("hotel_prefs.min_stars", "not_allowed", allowed=[0, *HOTEL_STARS])
    return {"rating_min": None if rating is None else float(rating), "max_distance_km": value.max_distance_km,
            "min_stars": stars}


def departures(codes: list[str]) -> list[dict[str, str]]:
    """IATA → Departure. Город вылета задаёт только пользователь (BR-TG-004): пустой список допустим."""
    if len(codes) > MAX_DEPARTURES:
        raise PreferencesInvalid("airports", "too_many", max=MAX_DEPARTURES)
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in codes:
        airport = airports.get(raw)
        if airport is None:
            raise UnknownAirport(raw.strip().upper()[:8])
        if airport.iata in seen:
            raise PreferencesInvalid("airports", "duplicate", value=airport.iata)
        seen.add(airport.iata)
        out.append(airport.departure())
    return out


class UnknownAirport(Exception):
    def __init__(self, iata: str) -> None:
        super().__init__(iata)
        self.iata = iata


# ---------------------------------------------------------------- ошибки структуры (pydantic) → field/reason

_TYPE_REASONS = {
    "missing": "required",
    "extra_forbidden": "unknown_field",
    "literal_error": "not_allowed",
    "enum": "not_allowed",
    "too_long": "too_many",
    "string_too_long": "too_long",
    "too_short": "too_few",
    "greater_than_equal": "out_of_range",
    "less_than_equal": "out_of_range",
    "json_invalid": "invalid_json",
}
_INT_FIELDS = {"budget.min", "budget.max", "budget.custom_amount"}


def from_pydantic(errors: list[ErrorDetails] | list[dict[str, Any]]) -> PreferencesInvalid:
    """Первая ошибка структуры → PreferencesInvalid. Индексы списков из пути убираются: field стабилен."""
    if not errors:
        return PreferencesInvalid("", "invalid")
    err = errors[0]
    loc = [str(p) for p in err.get("loc", ()) if not isinstance(p, int)]
    if loc and loc[0] == "body":
        loc = loc[1:]
    field = ".".join(loc)
    etype = str(err.get("type", ""))
    if etype in _TYPE_REASONS:
        reason = _TYPE_REASONS[etype]
    elif etype.endswith("_type") or etype.endswith("_parsing") or etype == "int_from_float":
        reason = "integer_required" if field in _INT_FIELDS else "invalid_type"
    else:
        reason = "invalid"
    return PreferencesInvalid(field or "body", reason)
