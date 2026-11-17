from __future__ import annotations

import re

import pytest

from tilhero_learning_plan.directory import airports
from tilhero_learning_plan.directory.geo import (
    ISO_COUNTRIES,
    POPULAR_COUNTRIES,
    PROTOTYPE_GEO_CHIPS,
    REGIONS,
    geo_options,
)
from tilhero_learning_plan.directory.taxonomy import CATEGORY_CODES, PROTOTYPE_INTEREST_CHIPS, TAXONOMY

UZ_AIRPORTS = {"TAS", "SKD", "BHK", "NMA", "FEG", "UGC", "NCU", "TMJ", "KSQ", "NVI", "AZN"}
# Чипы прототипа городов вылета (proto/miniapp/src/20-data.js AIRPORTS) должны находиться по коду.
PROTOTYPE_AIRPORTS = {"TAS", "SKD", "BHK", "NMA", "FEG", "UGC", "NCU", "TMJ", "ALA", "NQZ", "CIT", "FRU",
                      "OSS", "DYU", "DXB", "AUH", "IST", "SVO", "GYD", "DOH", "TBS", "DEL"}


# ---------------------------------------------------------------- данные


def test_airport_dataset_shape() -> None:
    items = airports.load()
    assert len(items) >= 300
    codes = [a.iata for a in items]
    assert len(codes) == len(set(codes)), "IATA-коды уникальны"
    for a in items:
        assert re.fullmatch(r"[A-Z]{3}", a.iata)
        assert a.country_code in ISO_COUNTRIES
        assert a.city and a.name and a.country
        assert not re.search(r"[А-Яа-яЁё]", a.city + a.name + a.country), "English naming без кириллицы"
    assert UZ_AIRPORTS <= set(codes), "все аэропорты Узбекистана"
    assert PROTOTYPE_AIRPORTS <= set(codes)
    assert {a.iata for a in items if a.country_code == "UZ"} == UZ_AIRPORTS
    regions = {a.country_code for a in items}
    for cc in ("KZ", "KG", "TJ", "TM", "AZ", "GE", "AM", "RU", "AE", "TR", "SA", "GB", "FR", "DE", "CN", "JP",
               "IN", "TH", "US", "CA", "BR", "EG", "ZA", "AU", "NZ"):
        assert cc in regions, cc
    with_alias = {a.city for a in items if a.aliases_ru}
    assert len(with_alias) >= 60
    assert {"Tashkent", "Samarkand", "Moscow", "Dubai", "Istanbul"} <= with_alias


def test_known_codes_are_exact() -> None:
    expected = {"TAS": "Tashkent", "SKD": "Samarkand", "BHK": "Bukhara", "NMA": "Namangan", "FEG": "Fergana",
                "UGC": "Urgench", "NCU": "Nukus", "TMJ": "Termez", "KSQ": "Karshi", "NVI": "Navoi",
                "AZN": "Andijan",
                "NQZ": "Astana", "FRU": "Bishkek", "DYU": "Dushanbe", "ASB": "Ashgabat", "GYD": "Baku",
                "SVO": "Moscow", "LED": "Saint Petersburg", "DXB": "Dubai", "AUH": "Abu Dhabi", "DOH": "Doha",
                "IST": "Istanbul", "SAW": "Istanbul", "JED": "Jeddah", "LHR": "London", "CDG": "Paris",
                "FRA": "Frankfurt", "PEK": "Beijing", "ICN": "Seoul", "HND": "Tokyo", "DEL": "Delhi",
                "BKK": "Bangkok", "SIN": "Singapore", "JFK": "New York", "YYZ": "Toronto", "GRU": "São Paulo",
                "CAI": "Cairo", "JNB": "Johannesburg", "SYD": "Sydney", "AKL": "Auckland", "MXP": "Milan",
                "ULH": "AlUla", "UBN": "Ulaanbaatar", "DSS": "Dakar"}
    for code, city in expected.items():
        a = airports.get(code)
        assert a is not None and a.city == city, code


def test_taxonomy_and_prototype_chips() -> None:
    tops = {c.code for c in TAXONOMY if c.parent is None}
    assert tops == {"music", "sport", "business", "culture", "education", "festivals"}
    for c in TAXONOMY:
        if c.parent:
            assert c.parent in tops and c.code.startswith(c.parent + ".")
        assert c.ru and c.en and c.icon
    required = {"music.concerts", "music.jazz", "music.classical", "music.electronic", "sport.motorsport",
                "sport.football", "sport.tennis", "sport.basketball", "sport.combat", "sport.other",
                "business.ai", "business.fintech", "business.startups", "business.conferences",
                "culture.theatre", "culture.exhibitions", "culture.cinema", "education.lectures",
                "festivals.music", "festivals.city"}
    assert required <= CATEGORY_CODES
    # все 12 чипов онбординга прототипа отображаются в коды таксономии
    assert set(PROTOTYPE_INTEREST_CHIPS) == {"concerts", "motorsport", "football", "tennis", "ai", "fintech",
                                             "forums", "theatre", "exhibitions", "festivals", "education",
                                             "othersport"}
    assert set(PROTOTYPE_INTEREST_CHIPS.values()) <= CATEGORY_CODES


def test_geographies() -> None:
    assert len(ISO_COUNTRIES) == 249
    assert set(REGIONS) == {"central_asia", "cis", "middle_east", "europe", "asia", "north_america",
                            "latin_america", "africa", "oceania"}
    assert len(POPULAR_COUNTRIES) >= 60 and set(POPULAR_COUNTRIES) <= ISO_COUNTRIES
    opts = geo_options()
    assert opts[0] == {"level": "world", "code": None, "label": {"ru": "Весь мир", "en": "Worldwide"}}
    for chip in PROTOTYPE_GEO_CHIPS.values():
        assert chip["level"] == "world" or chip["code"] in REGIONS or chip["code"] in ISO_COUNTRIES


# ---------------------------------------------------------------- поиск


@pytest.mark.parametrize(("q", "first"), [
    ("TAS", "TAS"), ("tas", "TAS"), ("skd", "SKD"), ("DXB", "DXB"),
    ("Tash", "TAS"), ("samar", "SKD"), ("Ташкент", "TAS"), ("таш", "TAS"), ("самарканд", "SKD"),
    ("москва", "SVO"), ("Дубай", "DXB"), ("стамбул", "IST"), ("Абу-Даби", "AUH"), ("абу даби", "AUH"),
    ("Санкт-Петербург", "LED"), ("алма-ата", "ALA"), ("ереван", "EVN"), ("бали", "DPS"),
    ("gokcen", "SAW"), ("Gökçen", "SAW"), ("sao paulo", "GRU"), ("türkiye", "IST"),
])
def test_search_ranking(q: str, first: str) -> None:
    res = airports.search(q, 10)
    assert res and res[0].iata == first, [a.iata for a in res]


def test_search_exact_iata_beats_city_prefix() -> None:
    # «DUB» — код Дублина, хотя «Dubai» тоже начинается с dub
    assert [a.iata for a in airports.search("dub", 5)][:3] == ["DUB", "DXB", "DWC"]
    # префикс города раньше вхождения в название
    res = [a.iata for a in airports.search("lon", 10)]
    assert res[:5] == ["LHR", "LGW", "STN", "LTN", "LCY"]


def test_search_country_and_limits() -> None:
    uz = airports.search("uzbekistan", 50)
    assert {a.iata for a in uz} == UZ_AIRPORTS
    assert len(airports.search("a", 7)) == 7
    assert airports.search("zzzz-nothing", 10) == []
    default = airports.search("", 5)
    assert [a.iata for a in default] == ["TAS", "SKD", "BHK", "NMA", "FEG"]
    assert [a.iata for a in airports.search("москва", 10)] == ["SVO", "DME", "VKO"]


# ---------------------------------------------------------------- API справочников


async def test_directory_api(env) -> None:
    h = env.h()
    r = await env.c.get("/internal/v1/directory/airports", params={"q": "ташкент", "limit": 5}, headers=h)
    assert r.status_code == 200
    tas = {"iata": "TAS", "city": "Tashkent", "country": "Uzbekistan", "country_code": "UZ",
           "name": "Islam Karimov Tashkent International Airport"}
    assert r.json() == {"items": [tas]}
    r = await env.c.get("/internal/v1/directory/airports", headers=h)
    assert len(r.json()["items"]) == 20  # limit по умолчанию
    big = await env.c.get("/internal/v1/directory/airports", params={"limit": 51}, headers=h)
    assert big.status_code == 422 and big.json()["code"] == "VALIDATION_ERROR"
    long_q = await env.c.get("/internal/v1/directory/airports", params={"q": "x" * 61}, headers=h)
    assert long_q.status_code == 422

    interests = (await env.c.get("/internal/v1/directory/interests", headers=h)).json()["items"]
    moto = next(i for i in interests if i["code"] == "sport.motorsport")
    assert moto == {"code": "sport.motorsport", "parent": "sport",
                    "label": {"ru": "Автоспорт", "en": "Motorsport"}, "icon": "flag"}
    geos = (await env.c.get("/internal/v1/directory/geographies", headers=h)).json()["items"]
    central_asia = {"level": "region", "code": "central_asia",
                    "label": {"ru": "Центральная Азия", "en": "Central Asia"}}
    assert central_asia in geos
    assert {"level": "country", "code": "UZ", "label": {"ru": "Узбекистан", "en": "Uzbekistan"}} in geos


async def test_directory_requires_internal_token(env) -> None:
    for path in ("/internal/v1/directory/airports", "/internal/v1/directory/interests",
                 "/internal/v1/directory/geographies"):
        assert (await env.c.get(path)).status_code == 401
        bad = await env.c.get(path, headers={"x-internal-token": "garbage"})
        assert bad.status_code == 401 and bad.json()["code"] == "INTERNAL_TOKEN_INVALID"
        other = await env.c.get(path, headers=env.h(issuer="support"))
        assert other.status_code == 403 and other.json()["code"] == "CALLER_NOT_ALLOWED"


def test_provider_code_is_an_alias_of_our_iata() -> None:
    """7.3: Aviasales знает Бишкек как BSZ; наш код (профили, слежения, снимки) остаётся FRU — BSZ на входе
    нормализуется к нему, поиск по BSZ находит Бишкек. Код поставщика не совпадает ни с одним IATA справочника."""
    bishkek = airports.get("BSZ")
    assert bishkek is not None and bishkek.iata == "FRU" and bishkek.provider_codes == ("BSZ",)
    assert airports.get("FRU") is bishkek
    assert airports.search("BSZ", 3)[0].iata == "FRU"
    iatas = {a.iata for a in airports.load()}
    assert all(code not in iatas for a in airports.load() for code in a.provider_codes)
