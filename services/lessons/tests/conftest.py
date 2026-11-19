from __future__ import annotations

import itertools
import uuid
from collections import deque
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from ls_testkit import (
    SEED_DATA,
    FakeAI,
    FakeAssessment,
    FakeCatalog,
    FakeDiagnostics,
    FakePlan,
    assert_no_keys,
    correct_answer,
    wrong_answer,
)
from sqlalchemy import text

from tilhero_common.app import Runtime
from tilhero_common.internal_auth import HEADER, Actor, issue_token
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
from tilhero_lessons.main import build_app
from tilhero_lessons.settings import Settings

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
T0 = datetime(2026, 11, 19, 7, 0, tzinfo=UTC)
SCHEDULER_TOKEN = "s" * 40


def make_settings(**kw: Any) -> Settings:
    base: dict[str, Any] = {"env": "test", "internal_jwt_secret": "t" * 40, "snapshot_revalidate_seconds": 0,
                            "published_cache_seconds": 0, "pairs_cache_ttl_seconds": 1,
                            "scheduler_token": SCHEDULER_TOKEN}
    base.update(kw)
    return Settings(**base)


def route(scenario_id: str, node_id: str, outcome: str) -> dict[str, Any] | None:
    """Первый переход на кратчайшем пути от узла к концу с нужным исходом (по графу сида)."""
    nodes = SEED_DATA["scenario"][scenario_id]["nodes"]
    queue: deque[tuple[str, dict[str, Any] | None]] = deque([(node_id, None)])
    seen = {node_id}
    while queue:
        nid, first = queue.popleft()
        end = nodes[nid].get("end")
        if end is not None and end["outcome"] == outcome:
            return first
        for t in nodes[nid]["transitions"]:
            if t["to"] not in seen:
                seen.add(t["to"])
                queue.append((t["to"], first or t))
    return None


class Env:
    def __init__(self, settings: Settings, client: httpx.AsyncClient, runtime: Runtime, bus: InMemoryBus, app: Any,
                 catalog: FakeCatalog, ai: FakeAI, assessment: FakeAssessment, plan: FakePlan,
                 diagnostics: FakeDiagnostics) -> None:
        self.settings = settings
        self.c = client
        self.runtime = runtime
        self.bus = bus
        self.app = app
        self.catalog = catalog
        self.ai = ai
        self.assessment = assessment
        self.plan = plan
        self.diagnostics = diagnostics
        self.now = T0
        app.state.clock = lambda: self.now
        self._seeds = itertools.count()
        app.state.seed_factory = lambda: f"seed-{next(self._seeds):04d}"
        self.age: dict[str, str | None] = {}
        self.step_seconds = 30  # ученик тратит на шаг 30 с (активное время)

    # ---------- заголовки
    def h(self, user: uuid.UUID, *, account: uuid.UUID | None = None, age_band: str | None = "18+",
          issuer: str = "telegram-bff") -> dict[str, str]:
        extra: dict[str, Any] = {"lrn": str(user)}
        band = self.age.get(str(user), age_band)
        if band:
            extra["age_band"] = band
        token = issue_token(self.settings.internal_jwt_secret.get_secret_value(), issuer=issuer,
                            audience="lessons", subject=str(account or user), extra=extra)
        return {HEADER: token}

    def staff(self, *perms: str, issuer: str = "admin-bff", actor: bool = True) -> dict[str, str]:
        a = Actor(id=str(uuid.uuid4()), role="qa_analyst", permissions=frozenset(perms), name="QA")
        return internal_headers(self.settings, issuer=issuer, actor=a if actor else None, audience="lessons")

    def child(self, user: uuid.UUID) -> None:
        self.age[str(user)] = "6-9"

    # ---------- события и данные
    async def flush(self) -> None:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()

    async def events(self, event_type: str, user: uuid.UUID | None = None) -> list[Envelope]:
        await self.flush()
        found = [e for e in self.bus.of_type(event_type)
                 if user is None or e.payload.get("user_id") == str(user)]
        for e in found:
            assert_event_conforms(e)
            assert e.producer == "lessons"
        return found

    async def sql(self, stmt: str, **params: Any) -> Any:
        async with self.runtime.transaction() as s:
            result = await s.execute(text(stmt), params)
            return result.all() if result.returns_rows else None

    async def tick(self, expect: int = 200) -> dict[str, Any]:
        r = await self.c.post("/internal/v1/lessons:tick", headers={"Authorization": f"Bearer {SCHEDULER_TOKEN}"})
        assert r.status_code == expect, r.text
        return r.json()

    # ---------- сценарии ученика
    async def start(self, user: uuid.UUID, path: str, *, key: str | None = None, expect: int = 201,
                    params: dict[str, str] | None = None, **hk: Any) -> dict[str, Any]:
        r = await self.c.post(f"/internal/v1/{path}/sessions", params=params,
                              headers={**self.h(user, **hk), "Idempotency-Key": key or f"key-{uuid.uuid4()}"})
        assert r.status_code == expect, r.text
        assert_no_keys(r.json())
        return r.json()

    async def lesson(self, user: uuid.UUID, lesson_id: str = "l-01-greetings", **kw: Any) -> dict[str, Any]:
        return await self.start(user, f"lessons/{lesson_id}", **kw)

    async def current(self, user: uuid.UUID, sid: str, expect: int = 200, **hk: Any) -> dict[str, Any]:
        r = await self.c.get(f"/internal/v1/sessions/{sid}/current", headers=self.h(user, **hk))
        assert r.status_code == expect, r.text
        assert_no_keys(r.json())
        return r.json()

    async def answer(self, user: uuid.UUID, sid: str, step: dict[str, Any] | str, body: dict[str, Any],
                     expect: int = 200, **hk: Any) -> dict[str, Any]:
        step_id = step if isinstance(step, str) else step["step_id"]
        r = await self.c.post(f"/internal/v1/sessions/{sid}/steps/{step_id}", json=body, headers=self.h(user, **hk))
        assert r.status_code == expect, r.text
        assert_no_keys(r.json())
        return r.json()

    async def post(self, user: uuid.UUID, sid: str, action: str, expect: int = 200, **hk: Any) -> dict[str, Any]:
        r = await self.c.post(f"/internal/v1/sessions/{sid}/{action}", headers=self.h(user, **hk))
        assert r.status_code == expect, r.text
        assert_no_keys(r.json())
        return r.json()

    def body_for(self, step: dict[str, Any], *, items: str = "correct", outcome: str = "success",
                 open_text: str = "Hello! My name is Aziz. Nice to meet you.") -> dict[str, Any]:
        t = step["type"]
        if t == "item":
            return {"answer": correct_answer(step["item"]) if items == "correct" else wrong_answer(step["item"])}
        if t == "roleplay":
            return {"choice_id": self.choice_to(step, outcome)}
        if t == "open_answer":
            return {"text": open_text}
        return {}

    def choice_to(self, step: dict[str, Any], outcome: str, scenario_id: str | None = None) -> str:
        scenario_id = scenario_id or self._scenario_of(step["node_id"], step["line_en"])
        t = route(scenario_id, step["node_id"], outcome) or route(scenario_id, step["node_id"], "success")
        assert t is not None
        return next(c["choice_id"] for c in step["choices"] if c["text_en"] == t["examples_en"][0])

    def _scenario_of(self, node_id: str, line: str) -> str:
        for sid, scn in SEED_DATA["scenario"].items():
            node = scn["nodes"].get(node_id)
            if node is not None and node["line_en"] == line:
                return sid
        raise AssertionError(node_id)

    async def play(self, user: uuid.UUID, sid: str, *, until: str = "done", **policy: Any) -> list[dict[str, Any]]:
        """Проходит шаги по политике до шага типа `until`; → показанные шаги (включая последний)."""
        shown = [await self.current(user, sid)]
        while shown[-1]["type"] != until:
            step = shown[-1]
            assert step["type"] != "done", f"reached done before {until}"
            self.now += timedelta(seconds=self.step_seconds)
            res = await self.answer(user, sid, step, self.body_for(step, **policy))
            assert res["accepted"] is True
            if step["stage"] == "assessment" or step.get("graded_later"):
                assert res["feedback"] is None
            shown.append(res["next"])
        return shown

    async def finish(self, user: uuid.UUID, sid: str, expect: int = 200) -> dict[str, Any]:
        return await self.post(user, sid, "finish", expect=expect)

    async def complete_lesson(self, user: uuid.UUID, lesson_id: str = "l-01-greetings", **policy: Any
                              ) -> tuple[dict[str, Any], dict[str, Any]]:
        s = await self.lesson(user, lesson_id)
        await self.play(user, s["session_id"], **policy)
        return s, await self.finish(user, s["session_id"])


@pytest.fixture
async def env():
    schema = unique_schema("ls")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    catalog = FakeCatalog()
    ai = FakeAI()
    assessment = FakeAssessment(catalog)
    plan = FakePlan(catalog)
    diagnostics = FakeDiagnostics()
    app = build_app(settings, runtime, transports={
        "catalog": httpx.MockTransport(catalog.handler), "ai-gateway": httpx.MockTransport(ai.handler),
        "assessment": httpx.MockTransport(assessment.handler), "learning-plan": httpx.MockTransport(plan.handler),
        "diagnostics": httpx.MockTransport(diagnostics.handler)})
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://lessons")
        e = Env(settings, client, runtime, bus, app, catalog, ai, assessment, plan, diagnostics)
        await e.flush()
        yield e
        await client.aclose()
    await drop_schema(schema)


@pytest.fixture
def user() -> uuid.UUID:
    return uuid.uuid4()
