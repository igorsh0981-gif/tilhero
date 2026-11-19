"""Модели = миграции (schema_drift); миграции под ролью-владельцем, сервис — под своей ролью без DDL и без права
снять триггеры неизменяемости; откат/подъём; сквозной прогон урока, оценки и саги под ролями; настройки."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

import httpx
import pytest
from conftest import SERVICE_DIR, make_settings
from ls_testkit import FakeAI, FakeAssessment, FakeCatalog, FakeDiagnostics, FakePlan
from pydantic import ValidationError

from tilhero_common.app import Runtime
from tilhero_common.internal_auth import HEADER, issue_token
from tilhero_common.messaging import InMemoryBus, make_envelope, messaging_metadata
from tilhero_common.testing import assert_event_conforms, ddl_allowed_for, migrated_under_roles, schema_drift
from tilhero_lessons.main import build_app
from tilhero_lessons.models import Base
from tilhero_lessons.settings import DEV_USER_REF_SECRET, Settings

TABLES = ("sessions", "status_history", "steps", "turns", "review_items", "learner_profiles", "deleted_users",
          "outbox", "inbox")


async def test_models_match_migrations_and_runtime_role() -> None:
    async with migrated_under_roles(SERVICE_DIR, make_settings, "ls_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in TABLES:
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        bus = InMemoryBus()
        runtime = Runtime(settings, bus=bus)
        catalog = FakeCatalog()
        app = build_app(settings, runtime, transports={
            "catalog": httpx.MockTransport(catalog.handler), "ai-gateway": httpx.MockTransport(FakeAI().handler),
            "assessment": httpx.MockTransport(FakeAssessment(catalog).handler),
            "learning-plan": httpx.MockTransport(FakePlan(catalog).handler),
            "diagnostics": httpx.MockTransport(FakeDiagnostics().handler)})
        user = uuid.uuid4()
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://ls") as c:
                token = issue_token(settings.internal_jwt_secret.get_secret_value(), issuer="telegram-bff",
                                    audience="lessons", subject=str(user), extra={"lrn": str(user), "age_band": "18+"})
                h = {HEADER: token}
                r = await c.post("/internal/v1/scenarios/sc-meet-greetings/sessions",
                                 headers={**h, "Idempotency-Key": "k-roles-01"})
                assert r.status_code == 201, r.text
                sid = r.json()["session_id"]
                step = (await c.get(f"/internal/v1/sessions/{sid}/current", headers=h)).json()
                r = await c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}", headers=h,
                                 json={"text": "Hi, Mia! I'm Aziz."})
                assert r.status_code == 200, r.text
                step = r.json()["next"]
                while step["type"] == "roleplay":
                    r = await c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}", headers=h,
                                     json={"choice_id": step["choices"][0]["choice_id"]})
                    step = r.json()["next"]
                r = await c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}", headers=h, json={})
                assert r.status_code == 200, r.text
                r = await c.post(f"/internal/v1/sessions/{sid}/finish", headers=h)
                assert r.status_code == 200, r.text
                await bus.publish(make_envelope(
                    "user.deletion.requested.v1",
                    {"user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": "2026-11-19T10:00:00Z"},
                    producer="identity-consent"))
                assert (await c.get("/health/ready")).status_code == 200
            assert runtime.relay is not None
            await runtime.relay.drain()
        for t in ("lesson.session.started.v1", "lesson.session.completed.v1", "user.domain.deleted.v1"):
            [ev] = bus.of_type(t)
            assert_event_conforms(ev)
        assert bus.dlq == []


async def test_migration_down_up_under_roles() -> None:
    from alembic import command
    from alembic.config import Config

    async with migrated_under_roles(SERVICE_DIR, make_settings, "ls_rb") as (settings, _roles):
        cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
        cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
        cfg.attributes["settings"] = settings
        await asyncio.to_thread(command.downgrade, cfg, "base")
        await asyncio.to_thread(command.upgrade, cfg, "head")


async def test_answered_step_is_immutable(env) -> None:  # type: ignore[no-untyped-def]
    user = uuid.uuid4()
    s = await env.lesson(user)
    step = await env.current(user, s["session_id"])
    await env.answer(user, s["session_id"], step, {})
    for stmt in ("UPDATE steps SET payload = '{}'::jsonb WHERE session_id = :s",
                 "UPDATE steps SET result = 'correct' WHERE session_id = :s AND answered_at IS NOT NULL",
                 "UPDATE steps SET answer = '{\"x\": 1}'::jsonb WHERE session_id = :s AND answered_at IS NOT NULL"):
        with pytest.raises(Exception, match=r"immutable|written once"):
            await env.sql(stmt, s=uuid.UUID(s["session_id"]))


def test_settings_guards() -> None:
    with pytest.raises(ValidationError, match="CATALOG_URL"):
        Settings(env="prod", internal_jwt_secret="x" * 40, internal_jwt_private_key="a" * 43)
    urls: dict[str, str] = {k: "http://x:1" for k in ("catalog_url", "ai_gateway_url", "assessment_url",
                                                      "learning_plan_url", "diagnostics_url")}
    prod: dict[str, str] = {"env": "prod", "internal_jwt_secret": "x" * 40, "internal_jwt_private_key": "a" * 43,
                            "scheduler_token": "t" * 43}
    ok = Settings(**prod, **urls, user_ref_secret="r" * 32)
    assert ok.port == 8112 and ok.db_schema == "lessons"
    # цепочка таймаутов (R1-16, R2-02): статус ИИ 2 с; finish = 2 + 32 + 2 < 45 с BFF; 32 > 26 + 3 (assessment → ИИ
    # и чтение ключей из catalog)
    assert ok.ai_status_timeout_seconds == 2 and ok.assessment_timeout_seconds == 32 and ok.ai_timeout_seconds == 20
    assert ok.assessment_timeout_seconds > 26 + 3
    assert 2 * ok.summary_aux_timeout_seconds + ok.assessment_timeout_seconds < 45
    assert ok.summary_refresh_timeout_seconds < 25
    for bad_token in ("short", ""):  # R3-05: в stage/prod обязателен (от tick зависит стирание текстов через 90 дней)
        with pytest.raises(ValidationError, match="SCHEDULER_TOKEN"):
            Settings(**{**prod, "scheduler_token": bad_token}, **urls, user_ref_secret="r" * 32)
    # R2-06: USER_REF_SECRET обязателен в stage/prod (не dev-значение, ≥ 32 символов); dev/test — по умолчанию
    for bad in ({}, {"user_ref_secret": "short"}, {"user_ref_secret": DEV_USER_REF_SECRET}, {"user_ref_secret": " "}):
        with pytest.raises(ValidationError, match="USER_REF_SECRET"):
            Settings(**prod, **urls, **bad)
    dev = Settings(env="test")
    assert dev.user_ref_secret.get_secret_value() == DEV_USER_REF_SECRET
    assert Settings(env="test", user_ref_secret="").user_ref_key() == DEV_USER_REF_SECRET.encode()
    with pytest.raises(ValidationError, match="http"):
        Settings(env="test", catalog_url="ftp://x")
