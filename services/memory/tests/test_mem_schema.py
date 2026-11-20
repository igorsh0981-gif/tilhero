"""Модели = миграции (schema_drift); миграции под ролью-владельцем, сервис — под своей ролью без DDL и без права
снять триггеры неизменяемости; откат/подъём; сквозной прогон под ролями; неизменяемость истории; настройки."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

import httpx
import pytest
from conftest import SERVICE_DIR, make_settings
from mem_testkit import FakeAI, FakeAssessment, FakeCatalog, FakeIdentity
from pydantic import ValidationError

from tilhero_common.app import Runtime
from tilhero_common.internal_auth import HEADER, issue_token
from tilhero_common.messaging import InMemoryBus, make_envelope, messaging_metadata
from tilhero_common.testing import assert_event_conforms, ddl_allowed_for, migrated_under_roles, schema_drift
from tilhero_memory.main import build_app
from tilhero_memory.models import Base
from tilhero_memory.settings import Settings

TABLES = ("cards", "review_log", "review_sessions", "review_tasks", "retention_checks", "pronunciation_attempts",
          "learner_projection", "skill_projection", "reminders_sent", "activity_days", "feed_log", "idempotency",
          "deleted_users", "outbox", "inbox")


async def test_models_match_migrations_and_runtime_role() -> None:
    async with migrated_under_roles(SERVICE_DIR, make_settings, "mem_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in TABLES:
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        bus = InMemoryBus()
        runtime = Runtime(settings, bus=bus)
        catalog, assessment = FakeCatalog(), FakeAssessment()
        app = build_app(settings, runtime, transports={
            "catalog": httpx.MockTransport(catalog.handler), "assessment": httpx.MockTransport(assessment.handler),
            "ai-gateway": httpx.MockTransport(FakeAI().handler),
            "identity-consent": httpx.MockTransport(FakeIdentity().handler)})
        user = uuid.uuid4()
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://mem") as c:
                ev = assessment.feed(user)
                await bus.publish(make_envelope("assessment.completed.v1", {
                    "evaluation_id": ev, "user_id": str(user), "pair_id": "ru-en", "session_id": str(uuid.uuid4()),
                    "kind": "lesson", "skill_outcomes": [], "practice_only": False,
                    "created_at": "2026-11-20T05:00:00Z"}, producer="assessment"))
                token = issue_token(settings.internal_jwt_secret.get_secret_value(), issuer="telegram-bff",
                                    audience="memory", subject=str(user), extra={"lrn": str(user), "age_band": "18+"})
                h = {HEADER: token}
                r = await c.post("/internal/v1/review-sessions", headers={**h, "Idempotency-Key": "k-roles-01"})
                assert r.status_code == 201, r.text
                sid = r.json()["session_id"]
                task = (await c.get(f"/internal/v1/review-sessions/{sid}/current", headers=h)).json()
                while task is not None:
                    body = {} if task["type"] == "intro" else {"choice": 0}
                    r = await c.post(f"/internal/v1/review-sessions/{sid}/tasks/{task['task_id']}", json=body,
                                     headers=h)
                    assert r.status_code == 200, r.text
                    task = r.json()["next"]
                assert (await c.post(f"/internal/v1/review-sessions/{sid}/finish", headers=h)).status_code == 200
                r = await c.post("/internal/v1/memory:tick", headers={"Authorization": f"Bearer {'s' * 40}"})
                assert r.status_code == 200, r.text
                await bus.publish(make_envelope(
                    "user.deletion.requested.v1",
                    {"user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": "2026-11-20T10:00:00Z"},
                    producer="identity-consent"))
                assert (await c.get("/health/ready")).status_code == 200
            assert runtime.relay is not None
            await runtime.relay.drain()
        for t in ("memory.review.completed.v1", "user.domain.deleted.v1"):
            [ev_] = bus.of_type(t)
            assert_event_conforms(ev_)
        assert bus.dlq == [] and bus.transient == []


async def test_migration_down_up_under_roles() -> None:
    from alembic import command
    from alembic.config import Config

    async with migrated_under_roles(SERVICE_DIR, make_settings, "mem_rb") as (settings, _roles):
        cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
        cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
        cfg.attributes["settings"] = settings
        await asyncio.to_thread(command.downgrade, cfg, "base")
        await asyncio.to_thread(command.upgrade, cfg, "head")


async def test_history_and_shown_tasks_are_immutable(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    s = await env.start(user)
    sid = uuid.UUID(s["session_id"])
    intro = await env.current(user, s["session_id"])
    await env.answer(user, s["session_id"], intro, {})
    choice = await env.current(user, s["session_id"])
    await env.answer(user, s["session_id"], choice, {"choice": 0})
    for stmt in ("UPDATE review_log SET grade = 'good'", "UPDATE review_log SET after = '{}'::jsonb",
                 "UPDATE review_tasks SET payload = '{}'::jsonb WHERE session_id = :s",
                 "UPDATE review_tasks SET key = '{}'::jsonb WHERE session_id = :s",
                 "UPDATE review_tasks SET result = 'correct' WHERE session_id = :s AND answered_at IS NOT NULL",
                 "UPDATE review_tasks SET answer = '{\"choice\": 1}'::jsonb WHERE session_id = :s "
                 "AND answered_at IS NOT NULL",
                 "UPDATE review_tasks SET hints = '[\"reveal\"]'::jsonb WHERE session_id = :s "
                 "AND answered_at IS NOT NULL"):
        with pytest.raises(Exception, match=r"immutable|written once"):
            await env.sql(stmt, s=sid)
    # стирание ввода по сроку хранения — допустимо (answer → NULL вместе с redacted_at)
    await env.sql("UPDATE review_tasks SET answer = NULL, redacted_at = now() WHERE session_id = :s "
                  "AND answered_at IS NOT NULL", s=sid)


def test_settings_guards() -> None:
    urls = {k: "http://x:1" for k in ("catalog_url", "assessment_url", "ai_gateway_url", "identity_consent_url")}
    prod = {"env": "prod", "internal_jwt_secret": "x" * 40, "internal_jwt_private_key": "a" * 43,
            "scheduler_token": "t" * 43}
    with pytest.raises(ValidationError, match="CATALOG_URL"):
        Settings(**prod)
    ok = Settings(**prod, **urls)
    assert ok.port == 8116 and ok.db_schema == "memory" and ok.service_name == "memory"
    assert ok.gloss_deadline_ms == 8000 and ok.speech_timeout_seconds == 15 and ok.ai_status_timeout_seconds == 2
    assert ok.due_limit_adults == 20 and ok.due_limit_kids == 10 and ok.new_limit_adults == 5 and ok.new_limit_kids == 3
    assert ok.cards_limit == 2000 and ok.reminder_hour == 19 and ok.gloss_cache_ttl_seconds == 3600
    for bad in ("short", ""):
        with pytest.raises(ValidationError, match="SCHEDULER_TOKEN"):
            Settings(**{**prod, "scheduler_token": bad}, **urls)
    with pytest.raises(ValidationError, match="http"):
        Settings(env="test", catalog_url="ftp://x")
    with pytest.raises(ValidationError, match="GLOSS_TIMEOUT"):
        Settings(env="test", gloss_timeout_seconds=5)
    with pytest.raises(ValidationError):
        Settings(env="test", default_timezone="Mars/Olympus")
