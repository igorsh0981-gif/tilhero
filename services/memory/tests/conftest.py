from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from mem_testkit import FakeAI, FakeAssessment, FakeCatalog, FakeIdentity, assert_no_keys, wav
from sqlalchemy import text

from tilhero_common.app import Runtime
from tilhero_common.internal_auth import HEADER, Actor, issue_token
from tilhero_common.messaging import Envelope, InMemoryBus, make_envelope
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    TEST_REDIS_URL,
    assert_event_conforms,
    create_schema,
    drop_schema,
    migrate,
    unique_schema,
)
from tilhero_memory.main import build_app
from tilhero_memory.settings import Settings

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
# 10:00 в Ташкенте (UTC+5)
T0 = datetime(2026, 11, 20, 5, 0, tzinfo=UTC)
SCHEDULER_TOKEN = "s" * 40


def make_settings(**kw: Any) -> Settings:
    base: dict[str, Any] = {"env": "test", "internal_jwt_secret": "t" * 40, "scheduler_token": SCHEDULER_TOKEN,
                            "redis_url": TEST_REDIS_URL, "titles_cache_seconds": 0}
    base.update(kw)
    return Settings(**base)


class Env:
    def __init__(self, settings: Settings, client: httpx.AsyncClient, runtime: Runtime, bus: InMemoryBus, app: Any,
                 catalog: FakeCatalog, assessment: FakeAssessment, ai: FakeAI, identity: FakeIdentity) -> None:
        self.settings = settings
        self.c = client
        self.runtime = runtime
        self.bus = bus
        self.app = app
        self.catalog = catalog
        self.assessment = assessment
        self.ai = ai
        self.identity = identity
        self.now = T0
        runtime.clock = lambda: self.now  # type: ignore[attr-defined]

    # ---------- заголовки
    def h(self, user: uuid.UUID, *, age_band: str | None = "18+", account: uuid.UUID | None = None,
          issuer: str = "telegram-bff") -> dict[str, str]:
        extra: dict[str, Any] = {"lrn": str(user)}
        if age_band:
            extra["age_band"] = age_band
        token = issue_token(self.settings.internal_jwt_secret.get_secret_value(), issuer=issuer, audience="memory",
                            subject=str(account or user), extra=extra)
        return {HEADER: token}

    def staff(self, *perms: str, issuer: str = "admin-bff", actor: bool = True, name: str = "Оператор"
              ) -> dict[str, str]:
        a = Actor(id=str(uuid.uuid4()), role="operations", permissions=frozenset(perms), name=name)
        token = issue_token(self.settings.internal_jwt_secret.get_secret_value(), issuer=issuer, audience="memory",
                            actor=a if actor else None)
        return {HEADER: token}

    # ---------- события и данные
    async def flush(self) -> None:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()

    async def events(self, event_type: str, user: uuid.UUID | None = None) -> list[Envelope]:
        await self.flush()
        found = [e for e in self.bus.of_type(event_type) if user is None or e.payload.get("user_id") == str(user)]
        for e in found:
            assert_event_conforms(e)
            assert e.producer == "memory"
        return found

    async def publish(self, event_type: str, payload: dict[str, Any], producer: str) -> Envelope:
        env = make_envelope(event_type, payload, producer=producer)
        await self.bus.publish(env)
        await self.flush()
        return env

    async def sql(self, stmt: str, **params: Any) -> Any:
        async with self.runtime.transaction() as s:
            result = await s.execute(text(stmt), params)
            return result.all() if result.returns_rows else None

    async def tick(self, expect: int = 200) -> dict[str, Any]:
        r = await self.c.post("/internal/v1/memory:tick", headers={"Authorization": f"Bearer {SCHEDULER_TOKEN}"})
        assert r.status_code == expect, r.text
        return r.json()

    # ---------- сценарии
    async def lesson_done(self, user: uuid.UUID, lesson: str = "l-01-greetings", *,
                          errors: list[dict[str, Any]] | None = None, kind: str = "lesson", **kw: Any) -> str:
        """Урок оценён → assessment.completed.v1 → карточки."""
        ev = self.assessment.feed(user, kind=kind, lesson=lesson if kind == "lesson" else None, errors=errors, **kw)
        await self.publish("assessment.completed.v1", {
            "evaluation_id": ev, "user_id": str(user), "pair_id": "ru-en",
            "session_id": self.assessment.feeds[ev]["session_id"], "kind": kind, "skill_outcomes": [],
            "practice_only": kind != "lesson", "created_at": self.now.isoformat().replace("+00:00", "Z")},
            "assessment")
        return ev

    async def plan(self, user: uuid.UUID, *, tz: str = "Asia/Tashkent", reminders: bool = True,
                   ui_lang: str = "ru") -> None:
        await self.publish("learning.plan.updated.v1", {
            "user_id": str(user), "changed_fields": ["timezone"], "goal": None, "ui_lang": ui_lang,
            "course_pair": "ru-en", "timezone": tz, "days": [1, 2, 3, 4, 5, 6, 7], "preferred_time": "19:00",
            "duration_min": 20, "reminders_enabled": reminders, "onboarding_completed": True, "level_self": None,
            "preset": "daily"}, "learning-plan")

    async def get(self, user: uuid.UUID, path: str, expect: int = 200, **hk: Any) -> Any:
        r = await self.c.get(f"/internal/v1/{path}", headers=self.h(user, **hk))
        assert r.status_code == expect, r.text
        return r.json()

    async def post(self, user: uuid.UUID, path: str, body: Any = None, expect: int = 200, *,
                   key: str | None = None, **hk: Any) -> Any:
        headers = self.h(user, **hk)
        if key is not None:
            headers["Idempotency-Key"] = key
        r = await self.c.post(f"/internal/v1/{path}", json=body, headers=headers)
        assert r.status_code == expect, r.text
        return r.json() if r.content else None

    async def start(self, user: uuid.UUID, expect: int = 201, key: str | None = None, **hk: Any) -> dict[str, Any]:
        return dict(await self.post(user, "review-sessions", None, expect, key=key or f"k-{uuid.uuid4()}", **hk))

    async def current(self, user: uuid.UUID, sid: str, expect: int = 200, **hk: Any) -> dict[str, Any]:
        task = await self.get(user, f"review-sessions/{sid}/current", expect, **hk)
        if expect == 200:
            assert_no_keys(task)
        return dict(task)

    async def answer(self, user: uuid.UUID, sid: str, task: dict[str, Any] | str, body: dict[str, Any],
                     expect: int = 200, **hk: Any) -> dict[str, Any]:
        tid = task if isinstance(task, str) else task["task_id"]
        self.now += timedelta(seconds=1)  # порядок строк истории планирования
        res = await self.post(user, f"review-sessions/{sid}/tasks/{tid}", body, expect, **hk)
        if expect == 200 and res.get("next"):
            assert_no_keys(res["next"])
        return dict(res)

    async def key_of(self, task_id: str) -> dict[str, Any]:
        [(key,)] = await self.sql("SELECT key FROM review_tasks WHERE task_id = :t", t=uuid.UUID(task_id))
        return dict(key)

    async def correct_body(self, task: dict[str, Any]) -> dict[str, Any]:
        """Верный ответ по ключу сервиса (как его знал бы ученик)."""
        key = await self.key_of(task["task_id"])
        kind = task["answer_kind"]
        if task["type"] == "intro":
            return {}
        if task["type"] == "check_item":
            if kind == "choice":
                return {"choice": key["answer"]}
            if kind == "text":
                return {"text": key["answer"][0]}
            return {"order": [key["options"].index(w) for w in key["answer"]]}
        if kind == "choice":
            return {"choice": key["correct"]}
        if kind == "text":
            return {"text": key["answers"][0]}
        tiles = list(task["tiles"])
        order = []
        for t in key["target"]:
            i = next(j for j, x in enumerate(tiles) if x == t and j not in order)
            order.append(i)
        return {"order": order}

    def wrong_body(self, task: dict[str, Any]) -> dict[str, Any]:
        kind = task["answer_kind"]
        if kind == "choice":
            return {"choice": 0}  # проверяется отдельно: если 0 верный — тест берёт 1
        if kind == "text":
            return {"text": "zzzz qqqq"}
        return {"order": list(reversed(range(len(task["tiles"] or task["options"]))))}

    async def play(self, user: uuid.UUID, sid: str, *, policy: str = "correct", **hk: Any) -> list[dict[str, Any]]:
        """Проходит все задания: correct — верно; → результаты."""
        results = []
        task: dict[str, Any] | None = await self.current(user, sid, **hk)
        while task is not None:
            self.now += timedelta(seconds=20)
            body = await self.correct_body(task) if policy == "correct" else self.wrong_body(task)
            res = await self.answer(user, sid, task, body, **hk)
            results.append({"task": task, "res": res})
            task = res["next"]
        return results

    async def make_review(self, user: uuid.UUID, *, stability: float = 10.0, due_days: float = -1.0,
                          kind: str | None = None) -> None:
        """Перевести карточки ученика в стадию review (S ≥ 3 — воспроизведение) со сроком в прошлом."""
        await self.sql(
            "UPDATE cards SET status = 'review', fsrs_state = 'review', stability = :s, difficulty = 5, reps = 3, "
            "last_review_at = :last, due_at = :due WHERE user_id = :u AND (CAST(:k AS text) IS NULL OR kind = :k)",
            s=stability, last=self.now - timedelta(days=stability), due=self.now + timedelta(days=due_days),
            u=user, k=kind)


@pytest.fixture
async def env():
    schema = unique_schema("mem")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema, gloss_cache_namespace=schema)
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    catalog, assessment, ai, identity = FakeCatalog(), FakeAssessment(), FakeAI(), FakeIdentity()
    app = build_app(settings, runtime, transports={
        "catalog": httpx.MockTransport(catalog.handler), "assessment": httpx.MockTransport(assessment.handler),
        "ai-gateway": httpx.MockTransport(ai.handler), "identity-consent": httpx.MockTransport(identity.handler)})
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://memory")
        e = Env(settings, client, runtime, bus, app, catalog, assessment, ai, identity)
        await e.flush()
        yield e
        await client.aclose()
    await drop_schema(schema)


@pytest.fixture
def user() -> uuid.UUID:
    return uuid.uuid4()


__all__ = ["T0", "Env", "make_settings", "wav"]
