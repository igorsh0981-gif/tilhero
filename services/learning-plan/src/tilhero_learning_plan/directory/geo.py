"""География (TG-FR-011): world / регионы / страны (ISO 3166-1 alpha-2) / города (English naming).

В справочнике для Mini App — «весь мир», 9 регионов и популярные страны (RU/EN). Валидация страны в
предпочтениях шире справочника: принимается любой действующий код ISO 3166-1 alpha-2.
"""

from __future__ import annotations

from typing import Final

Label = dict[str, str]

WORLD_LABEL: Final[Label] = {"ru": "Весь мир", "en": "Worldwide"}

REGIONS: Final[dict[str, Label]] = {
    "central_asia": {"ru": "Центральная Азия", "en": "Central Asia"},
    "cis": {"ru": "СНГ", "en": "CIS"},
    "middle_east": {"ru": "Ближний Восток", "en": "Middle East"},
    "europe": {"ru": "Европа", "en": "Europe"},
    "asia": {"ru": "Азия", "en": "Asia"},
    "north_america": {"ru": "Северная Америка", "en": "North America"},
    "latin_america": {"ru": "Латинская Америка", "en": "Latin America"},
    "africa": {"ru": "Африка", "en": "Africa"},
    "oceania": {"ru": "Океания", "en": "Oceania"},
}

# Популярные страны для выбора в Mini App (порядок = порядок показа).
POPULAR_COUNTRIES: Final[dict[str, Label]] = {
    # Центральная Азия и СНГ
    "UZ": {"ru": "Узбекистан", "en": "Uzbekistan"},
    "KZ": {"ru": "Казахстан", "en": "Kazakhstan"},
    "KG": {"ru": "Кыргызстан", "en": "Kyrgyzstan"},
    "TJ": {"ru": "Таджикистан", "en": "Tajikistan"},
    "TM": {"ru": "Туркменистан", "en": "Turkmenistan"},
    "RU": {"ru": "Россия", "en": "Russia"},
    "BY": {"ru": "Беларусь", "en": "Belarus"},
    "AZ": {"ru": "Азербайджан", "en": "Azerbaijan"},
    "GE": {"ru": "Грузия", "en": "Georgia"},
    "AM": {"ru": "Армения", "en": "Armenia"},
    # Ближний Восток
    "AE": {"ru": "ОАЭ", "en": "UAE"},
    "TR": {"ru": "Турция", "en": "Türkiye"},
    "QA": {"ru": "Катар", "en": "Qatar"},
    "SA": {"ru": "Саудовская Аравия", "en": "Saudi Arabia"},
    "BH": {"ru": "Бахрейн", "en": "Bahrain"},
    "OM": {"ru": "Оман", "en": "Oman"},
    "KW": {"ru": "Кувейт", "en": "Kuwait"},
    "JO": {"ru": "Иордания", "en": "Jordan"},
    "IL": {"ru": "Израиль", "en": "Israel"},
    "EG": {"ru": "Египет", "en": "Egypt"},
    # Европа
    "GB": {"ru": "Великобритания", "en": "United Kingdom"},
    "FR": {"ru": "Франция", "en": "France"},
    "DE": {"ru": "Германия", "en": "Germany"},
    "IT": {"ru": "Италия", "en": "Italy"},
    "ES": {"ru": "Испания", "en": "Spain"},
    "PT": {"ru": "Португалия", "en": "Portugal"},
    "NL": {"ru": "Нидерланды", "en": "Netherlands"},
    "BE": {"ru": "Бельгия", "en": "Belgium"},
    "CH": {"ru": "Швейцария", "en": "Switzerland"},
    "AT": {"ru": "Австрия", "en": "Austria"},
    "CZ": {"ru": "Чехия", "en": "Czechia"},
    "PL": {"ru": "Польша", "en": "Poland"},
    "HU": {"ru": "Венгрия", "en": "Hungary"},
    "GR": {"ru": "Греция", "en": "Greece"},
    "CY": {"ru": "Кипр", "en": "Cyprus"},
    "HR": {"ru": "Хорватия", "en": "Croatia"},
    "RS": {"ru": "Сербия", "en": "Serbia"},
    "ME": {"ru": "Черногория", "en": "Montenegro"},
    "MC": {"ru": "Монако", "en": "Monaco"},
    "IE": {"ru": "Ирландия", "en": "Ireland"},
    "SE": {"ru": "Швеция", "en": "Sweden"},
    "NO": {"ru": "Норвегия", "en": "Norway"},
    "DK": {"ru": "Дания", "en": "Denmark"},
    "FI": {"ru": "Финляндия", "en": "Finland"},
    "LV": {"ru": "Латвия", "en": "Latvia"},
    # Азия
    "CN": {"ru": "Китай", "en": "China"},
    "JP": {"ru": "Япония", "en": "Japan"},
    "KR": {"ru": "Южная Корея", "en": "South Korea"},
    "IN": {"ru": "Индия", "en": "India"},
    "TH": {"ru": "Таиланд", "en": "Thailand"},
    "VN": {"ru": "Вьетнам", "en": "Vietnam"},
    "SG": {"ru": "Сингапур", "en": "Singapore"},
    "MY": {"ru": "Малайзия", "en": "Malaysia"},
    "ID": {"ru": "Индонезия", "en": "Indonesia"},
    "HK": {"ru": "Гонконг", "en": "Hong Kong"},
    "MV": {"ru": "Мальдивы", "en": "Maldives"},
    "LK": {"ru": "Шри-Ланка", "en": "Sri Lanka"},
    "MN": {"ru": "Монголия", "en": "Mongolia"},
    # Америка
    "US": {"ru": "США", "en": "USA"},
    "CA": {"ru": "Канада", "en": "Canada"},
    "MX": {"ru": "Мексика", "en": "Mexico"},
    "BR": {"ru": "Бразилия", "en": "Brazil"},
    "AR": {"ru": "Аргентина", "en": "Argentina"},
    # Африка и Океания
    "MA": {"ru": "Марокко", "en": "Morocco"},
    "ZA": {"ru": "ЮАР", "en": "South Africa"},
    "KE": {"ru": "Кения", "en": "Kenya"},
    "TZ": {"ru": "Танзания", "en": "Tanzania"},
    "AU": {"ru": "Австралия", "en": "Australia"},
    "NZ": {"ru": "Новая Зеландия", "en": "New Zealand"},
}

# Все действующие коды ISO 3166-1 alpha-2 (249).
ISO_COUNTRIES: Final[frozenset[str]] = frozenset(
    """
    AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW
    BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI
    FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN
    IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME
    MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF
    PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV
    SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE
    YT ZA ZM ZW
    """.split()
)

# Чипы согласованного прототипа (proto/miniapp/src/20-data.js GEO) → Geography контракта.
PROTOTYPE_GEO_CHIPS: Final[dict[str, dict[str, str]]] = {
    "world": {"level": "world"},
    "uz": {"level": "country", "code": "UZ"},
    "kz": {"level": "country", "code": "KZ"},
    "uae": {"level": "country", "code": "AE"},
    "turkey": {"level": "country", "code": "TR"},
    "europe": {"level": "region", "code": "europe"},
    "asia": {"level": "region", "code": "asia"},
    "na": {"level": "region", "code": "north_america"},
}


def geo_options() -> list[dict]:
    """GET /directory/geographies → GeoOption[] (порядок: мир, регионы, страны)."""
    items: list[dict] = [{"level": "world", "code": None, "label": dict(WORLD_LABEL)}]
    items += [{"level": "region", "code": code, "label": dict(label)} for code, label in REGIONS.items()]
    items += [{"level": "country", "code": code, "label": dict(label)}
              for code, label in POPULAR_COUNTRIES.items()]
    return items
