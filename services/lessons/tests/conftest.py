from __future__ import annotations

import itertools
import uuid
from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from ls_testkit import (
    SEED_DATA,
    FakeAI,
    FakeAssessment,
    FakeBilling,
    FakeCatalog,
    FakeDiagnostics,
    FakeIdentity,
    FakePlan,
    FakeSocial,
    assert_no_keys,
    correct_answer,
    member_id,
    wrong_answer,
)
from sqlalchemy import text

from tilhero_common.app import Runtime
from tilhero_common.internal_auth import HEADER, Actor, issue_token
from tilhero_common.messaging import Envelope, InMemoryBus, make_envelope
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
                            "scheduler_token": SCHEDULER_TOKEN,
                            # long-poll в тестах — доли секунды (в проде ≤ 25 с)
                            "pair_poll_seconds": 0.6, "pair_poll_interval_seconds": 0.05}
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
                 diagnostics: FakeDiagnostics, social: FakeSocial | None = None,
                 identity: FakeIdentity | None = None, billing: FakeBilling | None = None) -> None:
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
        self.social = social or FakeSocial()
        self.identity = identity or FakeIdentity()
        self.billing = billing or FakeBilling()  # спринт 8: удержания и доступ (вызывается только при пэйволе)
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

    # ---------- спринт 7: social, дуэли, парные комнаты
    async def drain(self) -> None:
        """Фоновые задачи комнат (оценка участников) и outbox."""
        await self.app.state.room_hub.drain()
        await self.flush()

    async def publish(self, event_type: str, payload: dict[str, Any], producer: str) -> None:
        await self.bus.publish(make_envelope(event_type, payload, producer=producer))
        await self.flush()

    def mid(self, user: uuid.UUID) -> str:
        return member_id(user)

    def friends(self, a: uuid.UUID, b: uuid.UUID) -> None:
        self.social.know(a, b)
        self.social.friends.add(frozenset((a, b)))

    def family(self, *users: uuid.UUID) -> None:
        self.social.know(*users)
        self.social.families.append(set(users))

    def kid(self, user: uuid.UUID) -> None:
        self.child(user)
        self.social.audience[user] = "kids"

    async def nickname(self, user: uuid.UUID, nick: str | None) -> None:
        await self.publish("social.profile.updated.v1", {
            "user_id": str(user), "member_id": member_id(user), "nickname": nick, "game_profile_hidden": False,
            "updated_at": self.now.isoformat()}, "social")

    async def block(self, blocker: uuid.UUID, blocked: uuid.UUID, status: str = "added") -> None:
        if status == "added":
            self.social.blocks.add((blocker, blocked))
        else:
            self.social.blocks.discard((blocker, blocked))
        await self.publish("social.block.changed.v1", {
            "blocker_user_id": str(blocker), "blocked_user_id": str(blocked), "status": status,
            "at": self.now.isoformat()}, "social")

    async def ban(self, user: uuid.UUID, until: datetime | None, *, active: bool = True,
                  sanction_id: uuid.UUID | None = None) -> uuid.UUID:
        sid = sanction_id or uuid.uuid4()
        await self.publish("social.sanction.changed.v1", {
            "user_id": str(user), "sanction_id": str(sid), "kind": "social_ban",
            "until": until.isoformat() if until else None, "active": active,
            "change": "applied" if active else "revoked", "changed_at": self.now.isoformat()}, "social")
        return sid

    async def invite(self, a: uuid.UUID, b: uuid.UUID, *, scenario: str = "sc-cafe-coffee", start: str = "now",
                     key: str | None = None, expect: int = 201, pair_id: str = "ru-en") -> dict[str, Any]:
        r = await self.c.post("/internal/v1/me/pair-rooms", json={
            "partner_member_id": member_id(b), "pair_id": pair_id, "scenario_id": scenario, "start": start},
            headers={**self.h(a), "Idempotency-Key": key or f"inv-{uuid.uuid4()}"})
        assert r.status_code == expect, r.text
        assert_no_keys(r.json())
        return r.json()

    async def room(self, user: uuid.UUID, room_id: str, action: str, expect: int = 200, **kw: Any) -> Any:
        r = await self.c.post(f"/internal/v1/me/pair-rooms/{room_id}/{action}", headers=self.h(user), **kw)
        assert r.status_code == expect, r.text
        if r.content:
            assert_no_keys(r.json())
            return r.json()
        return None

    async def state(self, user: uuid.UUID, room_id: str, after: int = 0, expect: int = 200,
                    **params: Any) -> dict[str, Any]:
        r = await self.c.get(f"/internal/v1/me/pair-rooms/{room_id}/state", params={"after_seq": after, **params},
                             headers=self.h(user))
        assert r.status_code == expect, r.text
        assert_no_keys(r.json())
        return r.json()

    async def turn(self, user: uuid.UUID, room_id: str, body: dict[str, Any], *, key: str | None = None,
                   expect: int = 200) -> dict[str, Any]:
        r = await self.c.post(f"/internal/v1/me/pair-rooms/{room_id}/turns", json=body,
                              headers={**self.h(user), "Idempotency-Key": key or f"turn-{uuid.uuid4()}"})
        assert r.status_code == expect, r.text
        assert_no_keys(r.json())
        return r.json()

    async def beat(self, room_id: str, *users: uuid.UUID) -> None:
        for u in users:
            await self.room(u, room_id, "heartbeat", expect=204)

    async def pass_time(self, room_id: str, seconds: int, *users: uuid.UUID, step: int = 20) -> None:
        """Время идёт, участники присылают heartbeat (реже 30 с — offline)."""
        left = seconds
        while left > 0:
            dt = min(step, left)
            self.now += timedelta(seconds=dt)
            left -= dt
            await self.beat(room_id, *users)

    async def started_room(self, a: uuid.UUID, b: uuid.UUID, **kw: Any) -> str:
        """Друзья 18+: приглашение → принятие → оба вошли (in_progress)."""
        if not self.social.same_family(a, b):
            self.friends(a, b)
        room = await self.invite(a, b, **kw)
        await self.room(b, room["room_id"], "accept")
        await self.room(a, room["room_id"], "join")
        st = await self.room(b, room["room_id"], "join")
        assert st["status"] == "in_progress", st
        return str(room["room_id"])

    async def duel_set(self, a: uuid.UUID, b: uuid.UUID, *, duel_id: uuid.UUID | None = None,
                       band: str = "A0-A1", expect: int = 201, issuer: str = "gamification",
                       **extra: Any) -> dict[str, Any]:
        r = await self.c.post("/internal/v1/duel-sets", json={
            "duel_id": str(duel_id or uuid.uuid4()), "pair_id": "ru-en", "level_band": band,
            "user_ids": [str(a), str(b)], **extra},
            headers=internal_headers(self.settings, issuer=issuer, audience="lessons"))
        assert r.status_code == expect, r.text
        return dict(r.json())

    async def duel_session(self, user: uuid.UUID, duel_id: str, *, key: str | None = None,
                           expect: int = 201) -> dict[str, Any]:
        r = await self.c.post("/internal/v1/me/duel-sessions", json={"duel_id": duel_id},
                              headers={**self.h(user), "Idempotency-Key": key or f"duel-{uuid.uuid4()}"})
        assert r.status_code == expect, r.text
        assert_no_keys(r.json())
        return dict(r.json())


@asynccontextmanager
async def make_env(**settings_kw: Any) -> AsyncIterator[Env]:
    schema = unique_schema("ls")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema, **settings_kw)
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    catalog = FakeCatalog()
    ai = FakeAI()
    assessment = FakeAssessment(catalog)
    plan = FakePlan(catalog)
    diagnostics = FakeDiagnostics()
    social = FakeSocial()
    identity = FakeIdentity()
    billing = FakeBilling()
    app = build_app(settings, runtime, transports={
        "catalog": httpx.MockTransport(catalog.handler), "ai-gateway": httpx.MockTransport(ai.handler),
        "assessment": httpx.MockTransport(assessment.handler), "learning-plan": httpx.MockTransport(plan.handler),
        "diagnostics": httpx.MockTransport(diagnostics.handler), "social": httpx.MockTransport(social.handler),
        "identity-consent": httpx.MockTransport(identity.handler),
        "billing": httpx.MockTransport(billing.handler)})
    try:
        async with app.router.lifespan_context(app):
            client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://lessons")
            e = Env(settings, client, runtime, bus, app, catalog, ai, assessment, plan, diagnostics, social,
                    identity, billing)
            await e.flush()
            yield e
            await app.state.room_hub.drain()
            await client.aclose()
            if not settings.billing_enforced:  # спринт 8: пэйвол выключен — billing не вызывается (как в спринте 7)
                assert billing.calls == [], billing.calls
    finally:
        await drop_schema(schema)


@pytest.fixture
async def env():
    async with make_env() as e:
        yield e


@pytest.fixture
async def paid():
    """Спринт 8: пэйвол включён (BILLING_ENFORCED=true), срок billing в тестах — доли секунды."""
    async with make_env(billing_enforced=True, billing_timeout_seconds=0.3) as e:
        yield e


@pytest.fixture
def user() -> uuid.UUID:
    return uuid.uuid4()
