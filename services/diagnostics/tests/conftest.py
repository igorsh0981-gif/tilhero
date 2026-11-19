from __future__ import annotations

import itertools
import json
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from dx_testkit import FakeCatalog, Policy, correct_answer, wrong_answer
from sqlalchemy import text

from tilhero_common.app import Runtime
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import Envelope, InMemoryBus
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    assert_event_conforms,
    create_schema,
    drop_schema,
    internal_headers,
    migrate,
    unique_schema,
)
from tilhero_diagnostics.main import build_app
from tilhero_diagnostics.settings import Settings

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
T0 = datetime(2026, 11, 19, 7, 0, tzinfo=UTC)
# ключи ответов — поля задания, которых не должно быть ни в одном ответе ученику
KEY_FIELDS = ("answer", "tags", "skill_ids", "band")


def make_settings(**kw: Any) -> Settings:
    base: dict[str, Any] = {"env": "test", "internal_jwt_secret": "t" * 40, "snapshot_revalidate_seconds": 0,
                            "pairs_cache_ttl_seconds": 1}
    base.update(kw)
    return Settings(**base)


class Env:
    def __init__(self, settings: Settings, client: httpx.AsyncClient, runtime: Runtime, bus: InMemoryBus, app: Any,
                 catalog: FakeCatalog) -> None:
        self.settings = settings
        self.c = client
        self.runtime = runtime
        self.bus = bus
        self.app = app
        self.catalog = catalog
        self.now = T0
        app.state.clock = lambda: self.now
        self._seeds = itertools.count()
        self.fixed_seed: str | None = None
        app.state.seed_factory = lambda: self.fixed_seed or f"seed-{next(self._seeds):04d}"
        self._items: dict[tuple[str, int], dict[str, dict[str, Any]]] = {}

    # ---------- заголовки
    def h(self, user: uuid.UUID | str | None = None, issuer: str = "telegram-bff") -> dict[str, str]:
        return internal_headers(self.settings, issuer=issuer, subject=str(user) if user else None)

    def staff(self, *perms: str, issuer: str = "admin-bff", actor: bool = True) -> dict[str, str]:
        a = Actor(id=str(uuid.uuid4()), role="methodist", permissions=frozenset(perms), name="Метод")
        return internal_headers(self.settings, issuer=issuer, actor=a if actor else None)

    # ---------- данные
    async def flush(self) -> None:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()

    async def events(self, event_type: str, user: uuid.UUID | None = None) -> list[Envelope]:
        await self.flush()
        found = [e for e in self.bus.of_type(event_type)
                 if user is None or e.payload.get("user_id") == str(user)]
        for e in found:
            assert_event_conforms(e)
            assert e.producer == "diagnostics"
        return found

    async def sql(self, stmt: str, **params: Any) -> Any:
        async with self.runtime.transaction() as s:
            result = await s.execute(text(stmt), params)
            return result.all() if result.returns_rows else None

    async def items(self, test_ref: str) -> dict[str, dict[str, Any]]:
        """Задания версии теста с ключами — из БД (сид может заменить координатор)."""
        test_id, version = test_ref.split("@")
        key = (test_id, int(version))
        if key not in self._items:
            [(items,)] = await self.sql("SELECT items FROM tests WHERE test_id = :t AND version = :v",
                                        t=test_id, v=int(version))
            self._items[key] = {i["item_id"]: i for i in items}
        return self._items[key]

    # ---------- сценарии ученика
    async def start(self, user: uuid.UUID, *, audience: str | None = None, pair_id: str | None = None,
                    key: str | None = None, expect: int = 201) -> dict[str, Any]:
        params = {"audience": audience} if audience else None
        body = {"pair_id": pair_id} if pair_id else None
        r = await self.c.post("/internal/v1/diagnostics/sessions", params=params, json=body,
                              headers={**self.h(user), "Idempotency-Key": key or f"key-{uuid.uuid4()}"})
        assert r.status_code == expect, r.text
        return r.json()

    async def answer(self, user: uuid.UUID, session: dict[str, Any], item: dict[str, Any], kind: str,
                     expect: int = 200) -> dict[str, Any]:
        full = (await self.items(session["test_version"]))[item["item_id"]]
        payload: dict[str, Any] = {"item_id": item["item_id"], "time_ms": 4000, "dont_know": kind == "dont_know",
                                   "answer": None}
        if kind == "correct":
            payload["answer"] = correct_answer(full)
        elif kind == "wrong":
            payload["answer"] = wrong_answer(full)
        r = await self.c.post(f"/internal/v1/diagnostics/sessions/{session['session_id']}/answers", json=payload,
                              headers=self.h(user))
        assert r.status_code == expect, r.text
        return r.json()

    async def run(self, user: uuid.UUID, session: dict[str, Any], policy: Policy,
                  limit: int = 200) -> list[dict[str, Any]]:
        """Отвечает по политике до конца; возвращает показанные задания (как их видит ученик)."""
        shown: list[dict[str, Any]] = []
        r = await self.c.get(f"/internal/v1/diagnostics/sessions/{session['session_id']}/next", headers=self.h(user))
        assert r.status_code == 200, r.text
        item = r.json()
        while not item.get("done") and len(shown) < limit:
            assert_no_keys(item)
            shown.append(item)
            full = (await self.items(session["test_version"]))[item["item_id"]]
            res = await self.answer(user, session, item, policy(full))
            assert res["accepted"] is True
            item = res["next"] if res["next"] is not None else {"done": True}
            assert res["done"] is (res["next"] is None)
        return shown

    async def finish(self, user: uuid.UUID, session: dict[str, Any], expect: int = 200) -> dict[str, Any]:
        r = await self.c.post(f"/internal/v1/diagnostics/sessions/{session['session_id']}/finish",
                              headers=self.h(user))
        assert r.status_code == expect, r.text
        assert_no_item_ids(r.json())
        return r.json()

    async def complete(self, user: uuid.UUID, policy: Policy, *, audience: str | None = None) -> dict[str, Any]:
        session = await self.start(user, audience=audience)
        await self.run(user, session, policy)
        return await self.finish(user, session)


def assert_no_keys(obj: Any, path: str = "") -> None:
    """Рекурсивно: в ответе ученику нет ключей ответа и служебных полей задания."""
    if isinstance(obj, dict):
        if "item_id" in obj and "options" in obj:
            for field in KEY_FIELDS:
                assert field not in obj, f"{path}.{field} leaked"
        for k, v in obj.items():
            assert_no_keys(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            assert_no_keys(v, f"{path}[{i}]")


def assert_no_item_ids(obj: Any) -> None:
    """В результате диагностики нет ни заданий, ни отметок по ним — только основания по полосам (решение ревью:
    иначе результат — «оракул» ключей банка)."""
    text = json.dumps(obj, ensure_ascii=False)
    assert "item_id" not in text, text[:300]
    if isinstance(obj, dict) and "areas" in obj:
        for a in obj["areas"]:
            assert all(set(e) == {"band", "answered", "correct"} for e in a["evidence"]), a
            assert [e["band"] for e in a["evidence"]] == sorted(e["band"] for e in a["evidence"])
            if a["status"] == "not_assessed":
                assert a["evidence"] == [], a


def area_of(result: dict[str, Any], area: str) -> dict[str, Any]:
    return next(a for a in result["areas"] if a["area"] == area)


def by_area(items: Iterable[dict[str, Any]]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for i in items:
        out.setdefault(i["area"], []).append(i["item_id"])
    return out


@pytest.fixture
async def env():
    schema = unique_schema("dx")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    catalog = FakeCatalog()
    app = build_app(settings, runtime, catalog_transport=httpx.MockTransport(catalog.handler))
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://diagnostics")
        e = Env(settings, client, runtime, bus, app, catalog)
        await e.flush()  # прогрев пула; сид пишет запись аудита в outbox
        yield e
        await client.aclose()
    await drop_schema(schema)


@pytest.fixture
def user() -> uuid.UUID:
    return uuid.uuid4()
