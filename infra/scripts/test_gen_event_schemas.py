"""Каталог событий генератора совпадает со схемами в packages/contracts/events (CI дополнительно делает git diff)."""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
EVENTS = HERE.parents[1] / "packages" / "contracts" / "events"


def _catalog() -> dict:
    spec = importlib.util.spec_from_file_location("gen_event_schemas", HERE / "gen_event_schemas.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.CATALOG


def test_catalog_names_and_files_match():
    catalog = _catalog()
    assert all(re.fullmatch(r"[a-z_]+(\.[a-z_]+)+\.v\d+", name) for name in catalog), sorted(catalog)
    on_disk = {p.name.removesuffix(".schema.json") for p in EVENTS.glob("*.schema.json")} - {"envelope"}
    assert on_disk == set(catalog)


def test_required_fields_are_declared():
    for name in _catalog():
        schema = json.loads((EVENTS / f"{name}.schema.json").read_text(encoding="utf-8"))
        payload = schema["properties"]["payload"] if "payload" in schema.get("properties", {}) else schema
        props = set(payload.get("properties", {}))
        assert set(payload.get("required", [])) <= props, name
