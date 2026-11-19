"""Модели = миграции (schema_drift); миграции под ролью-владельцем, сервис — под своей ролью без DDL и без права
снять триггеры неизменяемости (оценки и флаги — UPDATE запрещён, апелляции — только допустимые переходы); откат и
подъём миграций; сквозной прогон под ролями (оценка, апелляция, переоценка, решение, сага)."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

import asyncpg
import httpx
import pytest
from as_testkit import FakeAi, FakeCatalog, lesson_request
from conftest import SERVICE_DIR, make_settings
from sqlalchemy.engine import make_url

from tilhero_assessment.main import build_app
from tilhero_assessment.models import Base
from tilhero_common.app import Runtime
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import InMemoryBus, make_envelope, messaging_metadata
from tilhero_common.testing import (
    assert_event_conforms,
    ddl_allowed_for,
    internal_headers,
    migrated_under_roles,
    schema_drift,
)

TABLES = ("evaluations", "appeals", "flags", "deleted_users", "outbox", "inbox")


def _pg(url: str) -> str:
    return make_url(url).set(drivername="postgresql").render_as_string(hide_password=False)


async def test_models_match_migrations_roles_and_triggers() -> None:
    async with migrated_under_roles(SERVICE_DIR, make_settings, "as_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in TABLES:
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        bus, catalog, ai = InMemoryBus(), FakeCatalog(), FakeAi()
        runtime = Runtime(settings, bus=bus)
        app = build_app(settings, runtime, catalog_transport=httpx.MockTransport(catalog.handler),
                        ai_transport=httpx.MockTransport(ai.handler))
        user = uuid.uuid4()
        staff = internal_headers(settings, issuer="admin-bff", actor=Actor(
            id=str(uuid.uuid4()), role="methodist", permissions=frozenset({"qa.read", "qa.review"})))
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://as") as c:
                r = await c.post("/internal/v1/evaluations", json=lesson_request("l-01-greetings"),
                                 headers=internal_headers(settings, issuer="lessons", subject=str(user)))
                assert r.status_code == 201, r.text
                created = r.json()
                eid = created["evaluation_id"]
                r = await c.post(f"/internal/v1/evaluations/{eid}/appeal", json={"reason": "проверьте"},
                                 headers={**internal_headers(settings, subject=str(user)),
                                          "Idempotency-Key": "k-roles-0001"})
                assert r.status_code == 201, r.text
                aid = r.json()["appeal_id"]
                r = await c.post(f"/admin/v1/evaluations/{eid}/flag", json={"reason": "спорно"}, headers=staff)
                assert r.status_code == 201, r.text
                r = await c.post(f"/admin/v1/evaluations/{eid}/reevaluate", headers=staff, json={
                    "scores": {"task": 2}, "skill_outcomes": created["skill_outcomes"], "confirmed_errors": [],
                    "reason": "Переоценка по апелляции", "appeal_id": aid})
                assert r.status_code == 201, r.text
                new_id = r.json()["evaluation_id"]
                r = await c.post(f"/admin/v1/appeals/{aid}/decide", headers=staff, json={
                    "decision": "corrected", "note": "Оценка исправлена", "new_evaluation_id": new_id})
                assert r.status_code == 200, r.text
                # триггеры: под ролью сервиса оценки и флаги не меняются, решённая апелляция — тоже
                conn = await asyncpg.connect(_pg(roles.runtime_url))
                try:
                    await conn.execute(f'SET search_path TO "{roles.schema}"')
                    for stmt in ("UPDATE evaluations SET passed = NOT passed",
                                 "UPDATE evaluations SET scores = '{}'::jsonb",
                                 "UPDATE flags SET reason = 'x'",
                                 "UPDATE appeals SET reason = 'x'",
                                 "UPDATE appeals SET status = 'new'",
                                 "UPDATE appeals SET decision_note = 'другое'"):
                        with pytest.raises(asyncpg.PostgresError) as exc:
                            await conn.execute(stmt)
                        assert exc.value.sqlstate == "42501", stmt  # insufficient_privilege
                finally:
                    await conn.close()
                await bus.publish(make_envelope(
                    "user.deletion.requested.v1",
                    {"user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": "2026-11-19T10:00:00Z"},
                    producer="identity-consent"))
                assert (await c.get("/health/ready")).status_code == 200
            assert runtime.relay is not None
            await runtime.relay.drain()
        for t in ("assessment.completed.v1", "assessment.reevaluated.v1", "assessment.appeal.decided.v1",
                  "user.domain.deleted.v1"):
            [e] = bus.of_type(t)
            assert_event_conforms(e)
        assert len(bus.of_type("admin.audit.recorded.v1")) == 3  # flagged, reevaluated, appeal_decided
        assert bus.dlq == []


async def test_appeal_transitions_guarded_by_trigger() -> None:
    async with migrated_under_roles(SERVICE_DIR, make_settings, "as_trg") as (_settings, roles):
        conn = await asyncpg.connect(_pg(roles.runtime_url))
        try:
            await conn.execute(f'SET search_path TO "{roles.schema}"')
            eid, sid, uid, aid = (uuid.uuid4() for _ in range(4))
            await conn.execute(
                "INSERT INTO evaluations (evaluation_id, session_id, user_id, kind, pair_id, audience, content_refs, "
                "rubric_id, rubric_version, rubric, status, scores, confirmed_errors, items, turns, skill_outcomes, "
                "practice_only, support_used, ai_status, requires_human_review, created_at) VALUES ($1, $2, $3, "
                "'lesson', 'ru-en', 'adults', '[]', 'r-kids', 1, '{}', 'insufficient_evidence', '{}', '[]', '[]', "
                "'[]', '[]', false, false, 'not_used', false, now())", eid, sid, uid)
            await conn.execute(
                "INSERT INTO appeals (appeal_id, evaluation_id, session_id, user_id, reason, status, idempotency_key, "
                "created_at) VALUES ($1, $2, $3, $4, 'r', 'new', 'k-trg-0001', now())", aid, eid, sid, uid)
            # new → upheld без отметок решения — CHECK; in_review → new — триггер
            with pytest.raises(asyncpg.CheckViolationError):
                await conn.execute("UPDATE appeals SET status = 'upheld' WHERE appeal_id = $1", aid)
            await conn.execute("UPDATE appeals SET status = 'in_review', taken_by = 's', taken_at = now() "
                               "WHERE appeal_id = $1", aid)
            with pytest.raises(asyncpg.PostgresError) as exc:
                await conn.execute("UPDATE appeals SET status = 'new' WHERE appeal_id = $1", aid)
            assert exc.value.sqlstate == "42501"
            # ревью R1-14: стереть текст нерешённой апелляции нельзя; решённой — только reason → NULL с отметкой
            redact = "UPDATE appeals SET reason = NULL, reason_redacted_at = now() WHERE appeal_id = $1"
            with pytest.raises(asyncpg.PostgresError) as exc:
                await conn.execute(redact, aid)
            assert exc.value.sqlstate == "42501"
            await conn.execute("UPDATE appeals SET status = 'upheld', decided_by = 's', decided_at = now(), "
                               "decision_note = 'Оценка верна' WHERE appeal_id = $1", aid)
            for stmt in ("UPDATE appeals SET reason = NULL WHERE appeal_id = $1",  # без отметки времени
                         "UPDATE appeals SET reason = NULL, reason_redacted_at = now(), decision_note = 'x' "
                         "WHERE appeal_id = $1",  # вместе с другим полем
                         "UPDATE appeals SET reason = 'другой текст' WHERE appeal_id = $1",
                         "UPDATE appeals SET reason_redacted_at = now() WHERE appeal_id = $1"):
                with pytest.raises(asyncpg.PostgresError) as exc:
                    await conn.execute(stmt, aid)
                assert exc.value.sqlstate == "42501", stmt
            await conn.execute(redact, aid)
            row = await conn.fetchrow("SELECT reason, reason_redacted_at, status, decision_note FROM appeals "
                                      "WHERE appeal_id = $1", aid)
            assert row["reason"] is None and row["reason_redacted_at"] is not None and row["status"] == "upheld"
            for stmt in ("UPDATE appeals SET reason = 'r', reason_redacted_at = NULL WHERE appeal_id = $1",
                         "UPDATE appeals SET reason_redacted_at = now() + interval '1 day' WHERE appeal_id = $1",
                         "UPDATE appeals SET decision_note = 'x' WHERE appeal_id = $1"):
                with pytest.raises(asyncpg.PostgresError) as exc:
                    await conn.execute(stmt, aid)
                assert exc.value.sqlstate == "42501", stmt
            # вторая исходная оценка той же сессии и вторая апелляция — уникальные индексы
            with pytest.raises(asyncpg.UniqueViolationError):
                await conn.execute(
                    "INSERT INTO evaluations (evaluation_id, session_id, user_id, kind, pair_id, audience, "
                    "content_refs, rubric_id, rubric_version, rubric, status, scores, confirmed_errors, items, turns, "
                    "skill_outcomes, practice_only, support_used, ai_status, requires_human_review, created_at) "
                    "VALUES ($1, $2, $3, 'lesson', 'ru-en', 'adults', '[]', 'r-kids', 1, '{}', "
                    "'insufficient_evidence', '{}', '[]', '[]', '[]', '[]', false, false, 'not_used', false, now())",
                    uuid.uuid4(), sid, uid)
            # сага может удалить (DELETE не запрещён)
            await conn.execute("DELETE FROM appeals WHERE user_id = $1", uid)
            await conn.execute("DELETE FROM evaluations WHERE user_id = $1", uid)
        finally:
            await conn.close()


async def test_migration_down_up_under_roles() -> None:
    from alembic import command
    from alembic.config import Config

    async with migrated_under_roles(SERVICE_DIR, make_settings, "as_rb") as (settings, roles):
        cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
        cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
        cfg.attributes["settings"] = settings
        # откат 0002 со стёртым текстом апелляции: NOT NULL прежней схемы — заглушка «—»
        conn = await asyncpg.connect(_pg(roles.owner_url))
        try:
            await conn.execute(f'SET search_path TO "{roles.schema}"')
            eid, sid, uid, aid = (uuid.uuid4() for _ in range(4))
            await conn.execute(
                "INSERT INTO evaluations (evaluation_id, session_id, user_id, kind, pair_id, audience, content_refs, "
                "rubric_id, rubric_version, rubric, status, scores, confirmed_errors, items, turns, skill_outcomes, "
                "practice_only, support_used, ai_status, requires_human_review, created_at) VALUES ($1, $2, $3, "
                "'lesson', 'ru-en', 'adults', '[]', 'r-kids', 1, '{}', 'insufficient_evidence', '{}', '[]', '[]', "
                "'[]', '[]', false, false, 'not_used', false, now())", eid, sid, uid)
            await conn.execute(
                "INSERT INTO appeals (appeal_id, evaluation_id, session_id, user_id, reason, status, idempotency_key, "
                "created_at, taken_by, taken_at, decided_by, decided_at, decision_note, reason_redacted_at) VALUES "
                "($1, $2, $3, $4, NULL, 'upheld', 'k-rb-0001', now(), 's', now(), 's', now(), 'Оценка верна', now())",
                aid, eid, sid, uid)
            await asyncio.to_thread(command.downgrade, cfg, "0001")
            assert await conn.fetchval("SELECT reason FROM appeals WHERE appeal_id = $1", aid) == "—"
        finally:
            await conn.close()
        await asyncio.to_thread(command.downgrade, cfg, "base")
        await asyncio.to_thread(command.upgrade, cfg, "head")
