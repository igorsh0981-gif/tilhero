"""Справочник аэропортов (ТЗ §5 п.9: English naming, IATA) — встроенный airports.json.

Поиск регистронезависимый, без учёта диакритики и «ё»; ранжирование:
  0 — точное совпадение IATA;
  1 — префикс города (английское название или русский алиас);
  2 — начало слова в городе / названии / стране / алиасе;
  3 — вхождение подстроки в город / название / страну / алиасы.
Внутри ранга — порядок файла (Узбекистан первым, далее региональные хабы).
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources
from typing import Any

_PUNCT = re.compile(r"[\s\-‐‑–—'’`.,()/]+")
_IATA = re.compile(r"^[A-Z]{3}$")


def normalize(value: str) -> str:
    """casefold + без диакритики (Gökçen → gokcen, ё → е, й → и) + пунктуация как пробел.

    Запрос и данные нормализуются одинаково, поэтому «Мумбай» и «Мумбаи», «Abu-Dhabi» и «abu dhabi» совпадают.
    """
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return _PUNCT.sub(" ", stripped).strip()


@dataclass(frozen=True, slots=True)
class Airport:
    iata: str
    city: str
    country: str
    country_code: str
    name: str
    aliases_ru: tuple[str, ...]
    order: int
    # 7.3: коды поставщиков для города, если отличаются от IATA (Aviasales: Бишкек — BSZ). Наш код остаётся IATA;
    # код поставщика, пришедший на вход (поиск, сохранение вылета), нормализуется к нему.
    provider_codes: tuple[str, ...]
    # нормализованные поля для поиска
    n_city: str
    n_name: str
    n_country: str
    n_aliases: tuple[str, ...]

    def public(self) -> dict[str, str]:
        return {"iata": self.iata, "city": self.city, "country": self.country,
                "country_code": self.country_code, "name": self.name}

    def departure(self) -> dict[str, str]:
        return {"airport_iata": self.iata, "city": self.city, "country_code": self.country_code}


@lru_cache(maxsize=1)
def load() -> tuple[Airport, ...]:
    raw = json.loads(resources.files(__package__).joinpath("airports.json").read_text(encoding="utf-8"))
    items: list[Airport] = []
    for i, a in enumerate(raw["items"]):
        aliases = tuple(a.get("aliases_ru", ()))
        codes = a.get("provider_codes") if isinstance(a.get("provider_codes"), dict) else {}
        items.append(Airport(
            iata=a["iata"], city=a["city"], country=a["country"], country_code=a["country_code"],
            name=a["name"], aliases_ru=aliases, order=i,
            provider_codes=tuple(sorted({str(v).upper() for v in codes.values()})),
            n_city=normalize(a["city"]), n_name=normalize(a["name"]), n_country=normalize(a["country"]),
            n_aliases=tuple(normalize(x) for x in aliases),
        ))
    return tuple(items)


@lru_cache(maxsize=1)
def by_iata() -> dict[str, Airport]:
    """IATA → аэропорт; код поставщика (BSZ) — тот же аэропорт (FRU), если такого IATA в справочнике нет."""
    out = {a.iata: a for a in load()}
    for a in load():
        for code in a.provider_codes:
            out.setdefault(code, a)
    return out


def get(iata: str) -> Airport | None:
    code = iata.strip().upper()
    return by_iata().get(code) if _IATA.match(code) else None


def _word_prefix(haystack: str, needle: str) -> bool:
    return haystack.startswith(needle) or f" {needle}" in haystack


def _rank(a: Airport, q_upper: str, nq: str) -> int | None:
    if a.iata == q_upper or q_upper in a.provider_codes:
        return 0
    if a.n_city.startswith(nq) or any(x.startswith(nq) for x in a.n_aliases):
        return 1
    fields = (a.n_city, a.n_name, a.n_country, *a.n_aliases)
    if any(_word_prefix(f, nq) for f in fields):
        return 2
    if any(nq in f for f in fields) or a.iata.startswith(q_upper):
        return 3
    return None


def search(q: str | None, limit: int) -> list[Airport]:
    nq = normalize(q or "")
    if not nq:
        return list(load()[:limit])
    q_upper = (q or "").strip().upper()
    ranked: list[tuple[int, int, Airport]] = []
    for a in load():
        r = _rank(a, q_upper, nq)
        if r is not None:
            ranked.append((r, a.order, a))
    ranked.sort(key=lambda t: (t[0], t[1]))
    return [a for _, _, a in ranked[:limit]]


def stats() -> dict[str, Any]:
    items = load()
    return {"airports": len(items), "countries": len({a.country_code for a in items})}
