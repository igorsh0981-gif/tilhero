"""Координаты аэропортов справочника (спринт 8, INTERNAL_API §7.3): `lat`, `lon` из OurAirports (общественное достояние).

    curl -sSo /tmp/airports.csv https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv
    python infra/scripts/airports_coords.py /tmp/airports.csv

Обновляет оба файла справочника (preferences и копию provider-gateway — они должны быть одинаковыми): каждой записи
`lat`/`lon` — строки с 4 знаками; записи без совпадения по IATA — `null` (в отчёте). При нескольких строках с одним IATA
берётся аэропорт с регулярными рейсами и большего типа. Версия справочника — `--version` (по умолчанию 2026.10.15).
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FILES = (
    ROOT / "services/preferences/src/tilhero_preferences/directory/airports.json",
    ROOT / "services/provider-gateway/src/tilhero_providers/travel/airports.json",
)
SOURCE_NOTE = "coordinates — OurAirports (ourairports.com/data, public domain), matched by IATA"
TYPE_RANK = {"large_airport": 0, "medium_airport": 1, "small_airport": 2}


def load_coords(csv_path: Path) -> dict[str, tuple[str, str]]:
    """IATA → (lat, lon). Сначала `iata_code`; затем прежний код из `keywords` аэропорта с регулярными рейсами
    (Бишкек: в OurAirports Manas — BSZ, «FRU» — в keywords; у нас FRU, как публикует аэропорт)."""
    best: dict[str, tuple[tuple[int, int, int], str, str]] = {}
    with csv_path.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            codes = [(0, (row.get("iata_code") or "").strip().upper())]
            if row.get("scheduled_service") == "yes" and row.get("type") in ("large_airport", "medium_airport"):
                codes += [(1, k.strip().upper()) for k in (row.get("keywords") or "").split(",")]
            for via, iata in codes:
                if len(iata) != 3 or not iata.isalpha():
                    continue
                _keep(best, iata, via, row)
    return {k: (v[1], v[2]) for k, v in best.items()}


def _keep(best: dict[str, tuple[tuple[int, int, int], str, str]], iata: str, via: int, row: dict[str, str]) -> None:
    try:
        lat, lon = float(row["latitude_deg"]), float(row["longitude_deg"])
    except (KeyError, ValueError):
        return
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return
    rank = (via, 0 if row.get("scheduled_service") == "yes" else 1, TYPE_RANK.get(row.get("type", ""), 9))
    if iata not in best or rank < best[iata][0]:
        best[iata] = (rank, f"{lat:.4f}", f"{lon:.4f}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", type=Path, help="airports.csv OurAirports")
    ap.add_argument("--version", default="2026.10.15")
    args = ap.parse_args()
    coords = load_coords(args.csv)
    data = json.loads(FILES[0].read_text(encoding="utf-8"))
    missing: list[str] = []
    for item in data["items"]:
        c = coords.get(item["iata"])
        item["lat"], item["lon"] = (c if c else (None, None))
        if c is None:
            missing.append(item["iata"])
    data["version"] = args.version
    if SOURCE_NOTE not in data["source"]:
        data["source"] = f"{data['source']}; {SOURCE_NOTE}"
    # формат файла — как у справочника: шапка и одна запись на строку (диф по записям читаемый)
    head = {k: v for k, v in data.items() if k != "items"}
    lines = [f" {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}," for k, v in head.items()]
    rows = [f"  {json.dumps(i, ensure_ascii=False)}" for i in data["items"]]
    text = "{\n" + "\n".join(lines) + '\n "items": [\n' + ",\n".join(rows) + "\n ]\n}\n"
    for path in FILES:
        path.write_text(text, encoding="utf-8")
    print(f"{len(data['items'])} airports, without coordinates: {len(missing)} {missing}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
