"""Unit-тесты доменной валидации (без БД и HTTP)."""

from __future__ import annotations

import pytest

from tilhero_learning_plan.domain import validation as v
from tilhero_learning_plan.schemas import BudgetIn, GeographyIn, InterestsIn


def test_budget_normalization() -> None:
    assert v.budget(BudgetIn(preset="2000_5000")) == {"currency": "USD", "preset": "2000_5000", "min": 2000,
                                                      "max": 5000, "custom_amount": None}
    assert v.budget(BudgetIn(min=0, max=5000))["preset"] is None
    assert v.budget(BudgetIn(min=0, max=500))["preset"] == "under_500"
    with pytest.raises(v.PreferencesInvalid) as e:
        v.budget(BudgetIn(min=500, max=500))
    assert (e.value.field, e.value.reason) == ("budget.max", "invalid_range")


@pytest.mark.parametrize("city", ["São Paulo", "Nevşehir", "Rostov-on-Don", "Xi'an", "St. Moritz", "Ürümqi"])
def test_city_english_naming_accepts_latin_with_diacritics(city: str) -> None:
    assert v.geographies([GeographyIn(level="city", code=city)]) == [{"level": "city", "code": city}]


@pytest.mark.parametrize("city", ["Ташкент", "東京", "<script>", "New York; DROP", "123"])
def test_city_rejects_non_latin_and_markup(city: str) -> None:
    with pytest.raises(v.PreferencesInvalid) as e:
        v.geographies([GeographyIn(level="city", code=city)])
    assert e.value.reason == "english_name_required"


def test_entities_trim_and_casefold_duplicates() -> None:
    out = v.interests(InterestsIn(categories=["sport.motorsport"], entities=[" Formula   1 ", "Coldplay"]))
    assert out == {"categories": ["sport.motorsport"], "entities": ["Formula 1", "Coldplay"]}
    with pytest.raises(v.PreferencesInvalid):
        v.interests(InterestsIn(categories=[], entities=["Formula 1", "FORMULA 1"]))


def test_departures_resolution() -> None:
    assert v.departures([" tas ", "AUH"]) == [
        {"airport_iata": "TAS", "city": "Tashkent", "country_code": "UZ"},
        {"airport_iata": "AUH", "city": "Abu Dhabi", "country_code": "AE"},
    ]
    with pytest.raises(v.UnknownAirport) as e:
        v.departures(["ZZZ"])
    assert e.value.iata == "ZZZ"


def test_pydantic_error_mapping() -> None:
    err = v.from_pydantic([{"loc": ("body", "geographies", 3, "code"), "type": "string_type"}])
    assert (err.field, err.reason) == ("geographies.code", "invalid_type")
    err = v.from_pydantic([{"loc": ("body", "budget", "custom_amount"), "type": "int_from_float"}])
    assert err.reason == "integer_required"
    assert v.from_pydantic([]).reason == "invalid"


def test_departures_normalize_provider_code() -> None:
    """7.3: код поставщика (BSZ) сохраняется как наш IATA (FRU); FRU и BSZ вместе — один город (дубль)."""
    assert v.departures(["BSZ"]) == [{"airport_iata": "FRU", "city": "Bishkek", "country_code": "KG"}]
    with pytest.raises(v.PreferencesInvalid):
        v.departures(["FRU", "bsz"])
