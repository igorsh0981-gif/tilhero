"""Pydantic-модели API preferences.

Формы ответов совпадают с packages/contracts/src/bff.ts (BFF проксирует их без перекладывания).
Вход строгий (extra="forbid", strict=True): "1500" вместо 1500, 1500.5, true вместо числа — ошибка 422
PREFERENCES_INVALID (BR-TG-003: бюджет — только целое число USD).
Семантические правила — в domain/validation.py.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, model_serializer

BudgetPreset = Literal["under_500", "500_1000", "1000_2000", "2000_5000", "custom"]
GeoLevel = Literal["world", "region", "country", "city"]
EventFormat = Literal["offline", "online"]
Horizon = Literal[3, 6, 12, 24]
NotificationPoint = Literal[1, 3, 6, 12]


def _iso_z(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


UtcDateTime = Annotated[datetime, PlainSerializer(_iso_z, return_type=str)]

_STRICT_IN = ConfigDict(extra="forbid", strict=True)

# Защитные верхние границы размера входа (точные бизнес-лимиты проверяет домен с понятной причиной).
_MAX_LIST = 100
_MAX_STR = 200


# ---------------------------------------------------------------- вход


class InterestsIn(BaseModel):
    model_config = _STRICT_IN

    categories: list[Annotated[str, Field(max_length=_MAX_STR)]] = Field(max_length=_MAX_LIST)
    entities: list[Annotated[str, Field(max_length=_MAX_STR)]] = Field(max_length=_MAX_LIST)


class GeographyIn(BaseModel):
    model_config = _STRICT_IN

    level: GeoLevel
    code: str | None = Field(default=None, max_length=_MAX_STR)


class BudgetIn(BaseModel):
    """preset задаёт диапазон (min/max вычисляет сервис); custom — сумма custom_amount (50…100 000 USD).

    preset=null + min/max на границах пресетов (0/500/1000/2000/5000) — объединение соседних диапазонов,
    как мультивыбор чипов в прототипе ($500–1 000 + $1 000–2 000 → 500…2000). Всё null — бюджет не задан.
    """

    model_config = _STRICT_IN

    currency: Literal["USD"] = "USD"
    preset: BudgetPreset | None = None
    min: int | None = None
    max: int | None = None
    custom_amount: int | None = None


class FlightPrefsIn(BaseModel):
    model_config = _STRICT_IN

    direct: bool
    connecting: bool
    alternative_departure: bool


class HotelPrefsIn(BaseModel):
    """6.3: настройки отеля для расчёта поездки. null — по умолчанию (оценка — из experience-config, расстояние — 5 км,
    звёзды — любые). Допустимые значения (чипы Mini App) проверяет домен: оценка 0 («любая»)/7.0/7.5/8.0/8.5/9.0,
    расстояние 1/3/5/10/15 км, звёзды 3/4/5 (0 — «любые», хранится как null)."""

    model_config = _STRICT_IN

    rating_min: float | None = None
    max_distance_km: int | None = None
    min_stars: int | None = None


class PreferencesPatchIn(BaseModel):
    """PATCH /internal/v1/me/preferences: частичное обновление (вложенные объекты передаются целиком)."""

    model_config = _STRICT_IN

    interests: InterestsIn | None = None
    geographies: list[GeographyIn] | None = Field(default=None, max_length=_MAX_LIST)
    strong_events_outside_geo: bool | None = None
    event_formats: list[EventFormat] | None = Field(default=None, max_length=10)
    budget: BudgetIn | None = None
    search_horizon_months: Horizon | None = None
    notification_points_months: list[NotificationPoint] | None = Field(default=None, max_length=10)
    flight_prefs: FlightPrefsIn | None = None
    hotel_prefs: HotelPrefsIn | None = None
    version: int | None = Field(default=None, ge=1, description="оптимистическая блокировка")


class DeparturesIn(BaseModel):
    """PUT /internal/v1/me/departures — полная замена списка, максимум 10 IATA из справочника."""

    model_config = _STRICT_IN

    airports: list[Annotated[str, Field(max_length=8)]] = Field(max_length=_MAX_LIST)


# ---------------------------------------------------------------- выход


class InterestsOut(BaseModel):
    categories: list[str]
    entities: list[str]


class GeographyOut(BaseModel):
    level: GeoLevel
    code: str | None = None

    @model_serializer
    def _ser(self) -> dict[str, Any]:
        # bff.ts: Geography.code?: string — для world поле отсутствует, а не null.
        return {"level": self.level} if self.code is None else {"level": self.level, "code": self.code}


class BudgetOut(BaseModel):
    currency: Literal["USD"]
    preset: BudgetPreset | None
    min: int | None
    max: int | None
    custom_amount: int | None


class DepartureOut(BaseModel):
    airport_iata: str
    city: str
    country_code: str


class FlightPrefsOut(BaseModel):
    direct: bool
    connecting: bool
    alternative_departure: bool


class HotelPrefsOut(BaseModel):
    rating_min: float | None
    max_distance_km: int | None
    min_stars: int | None


class PreferencesOut(BaseModel):
    interests: InterestsOut
    geographies: list[GeographyOut]
    strong_events_outside_geo: bool
    event_formats: list[EventFormat]
    budget: BudgetOut
    search_horizon_months: int
    notification_points_months: list[int]
    departures: list[DepartureOut]
    flight_prefs: FlightPrefsOut
    hotel_prefs: HotelPrefsOut
    onboarding_completed_at: UtcDateTime | None
    updated_at: UtcDateTime
    version: int


class AirportOut(BaseModel):
    iata: str
    city: str
    country: str
    country_code: str
    name: str


class AirportList(BaseModel):
    items: list[AirportOut]


class Label(BaseModel):
    ru: str
    en: str


class InterestCategoryOut(BaseModel):
    code: str
    parent: str | None
    label: Label
    icon: str


class InterestList(BaseModel):
    items: list[InterestCategoryOut]


class GeoOptionOut(BaseModel):
    level: GeoLevel
    code: str | None
    label: Label


class GeoOptionList(BaseModel):
    items: list[GeoOptionOut]


# ---------------------------------------------------------------- спрос для discovery (спринт 3)


class DemandCountry(BaseModel):
    code: str
    users: int


class DemandCity(BaseModel):
    name: str
    country_code: str | None  # None — город не найден в справочнике или неоднозначен
    users: int


class DemandCategory(BaseModel):
    code: str
    users: int


class DemandRegion(BaseModel):
    code: str
    users: int


class DemandOut(BaseModel):
    """GET /internal/v1/demand — агрегат без user_id (docs/sprint3/INTERNAL_API.md).

    Сверх контракта (аддитивно): regions и world_users — discovery разворачивает их в страны сам."""

    generated_at: UtcDateTime
    users: int
    countries: list[DemandCountry]
    cities: list[DemandCity]
    categories: list[DemandCategory]
    online_users: int
    regions: list[DemandRegion]
    world_users: int
