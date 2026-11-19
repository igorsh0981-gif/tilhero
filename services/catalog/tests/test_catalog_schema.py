"""Модели = миграции; миграции под ролью-владельцем, сервис — под своей ролью без DDL; неизменяемость опубликованного
на уровне БД (триггер, AT-26); полный сид методистов (migrations/seed) загружается миграцией 0003 как опубликованный."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections import Counter
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import asyncpg
import httpx
import pytest
from alembic import command
from alembic.config import Config
from catalog_kit import CONTENT_MANAGER, PUBLISHER, REVIEWER, RIGHTS, skill
from conftest import SERVICE_DIR, make_settings
from sqlalchemy.engine import make_url

from tilhero_catalog.content import KEY_FIELDS
from tilhero_catalog.domain.common import SEED_ACTOR_ID
from tilhero_catalog.domain.seed import SeedInvalid, apply_seed, load_seed_dir
from tilhero_catalog.main import build_app
from tilhero_catalog.models import Base
from tilhero_common.app import Runtime
from tilhero_common.db import make_engine
from tilhero_common.messaging import Envelope, InMemoryBus, make_envelope, messaging_metadata
from tilhero_common.testing import (
    assert_event_conforms,
    ddl_allowed_for,
    internal_headers,
    migrate,
    migrated_under_roles,
    schema_drift,
)

TABLES = ("languages", "language_pairs", "content_versions", "content_pointers", "scenario_test_runs", "media_blobs",
          "media_requests", "deleted_users", "outbox", "inbox")
REAL_SEED = Path(SERVICE_DIR) / "migrations" / "seed"
NOW = datetime(2026, 11, 19, 6, tzinfo=UTC)


def _pg(url: str) -> str:
    return make_url(url).set(drivername="postgresql").render_as_string(hide_password=False)


async def _fetch(url: str, schema: str, query: str, *args: Any) -> list[asyncpg.Record]:
    conn = await asyncpg.connect(_pg(url), server_settings={"search_path": schema})
    try:
        return await conn.fetch(query, *args)
    finally:
        await conn.close()


async def _execute(url: str, schema: str, query: str, *args: Any) -> None:
    conn = await asyncpg.connect(_pg(url), server_settings={"search_path": schema})
    try:
        await conn.execute(query, *args)
    finally:
        await conn.close()


@pytest.fixture
async def roles_env():
    """Миграции под владельцем (полный сид методистов), рантайм — под ролью сервиса."""
    def make(**kw: Any):
        return make_settings(seed_dir=None, **kw)

    async with migrated_under_roles(SERVICE_DIR, make, "catalog_roles") as (settings, roles):
        yield settings, roles


async def test_models_match_migrations_and_runtime_role_has_no_ddl(roles_env) -> None:
    _, roles = roles_env
    assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
    for table in TABLES:
        assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table


async def test_real_seed_loaded_as_published(roles_env) -> None:
    """Сид методистов: все записи — опубликованные v1 автора seed, локализации «проверено: сид», права медиа
    подтверждены, у сценариев зелёный прогон; аудит content.published от system и события — в outbox."""
    _, roles = roles_env
    entries = load_seed_dir(REAL_SEED)
    expected = Counter(kind for kind, _ in entries)
    assert expected["course"] == 1 and expected["scenario"] >= 20 and expected["media_asset"] >= 1
    rows = await _fetch(roles.runtime_url, roles.schema,
                        "SELECT kind, key, version, status, author_id, reviewer_id, published_by, locale_checks, "
                        "rights_approved_by FROM content_versions")
    assert Counter(r["kind"] for r in rows) == expected
    for r in rows:
        assert (r["version"], r["status"], r["author_id"], r["reviewer_id"], r["published_by"]) == (
            1, "published", SEED_ACTOR_ID, SEED_ACTOR_ID, SEED_ACTOR_ID)
        assert json.loads(r["locale_checks"]) == {"ru": "checked", "uz": "checked"}
        assert (r["rights_approved_by"] == SEED_ACTOR_ID) == (r["kind"] == "media_asset")
    pointers = await _fetch(roles.runtime_url, roles.schema,
                            "SELECT count(*) AS n FROM content_pointers WHERE published_version = 1")
    assert pointers[0]["n"] == sum(expected.values())
    runs = await _fetch(roles.runtime_url, roles.schema, "SELECT ok FROM scenario_test_runs")
    assert len(runs) == expected["scenario"] and all(r["ok"] for r in runs)
    outbox = await _fetch(roles.runtime_url, roles.schema, "SELECT envelope FROM outbox")
    envelopes = [Envelope.model_validate(json.loads(r["envelope"])) for r in outbox]
    by_type = Counter(e.event_type for e in envelopes)
    assert by_type == {"catalog.version.published.v1": sum(expected.values()),
                       "admin.audit.recorded.v1": sum(expected.values())}
    for e in envelopes:
        assert_event_conforms(e)
        if e.event_type == "admin.audit.recorded.v1":
            assert e.payload["actor_type"] == "system" and e.payload["action"] == "content.published"
            assert e.payload["actor_id"] == SEED_ACTOR_ID


async def test_real_seed_serves_learners(roles_env) -> None:
    settings, _ = roles_env
    app = build_app(settings, Runtime(settings, bus=InMemoryBus()))
    async with app.router.lifespan_context(app), httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://catalog") as c:
        snap = await c.get("/internal/v1/courses/en-core/snapshot",
                           headers=internal_headers(settings, issuer="learning-plan"))
        assert snap.status_code == 200
        body = snap.json()
        entries = load_seed_dir(REAL_SEED)
        counts = Counter(kind for kind, _ in entries)
        assert len(body["modules"]) == counts["module"] and len(body["lessons"]) == counts["lesson"]
        assert len(body["skills"]) == counts["skill"]
        assert '"answer"' not in snap.text and "control_items" not in body["lessons"][0]
        tb = internal_headers(settings, issuer="telegram-bff", subject=str(uuid.uuid4()))
        kids = (await c.get("/internal/v1/scenarios", params={"audience": "kids", "limit": 100}, headers=tb)).json()
        adults = (await c.get("/internal/v1/scenarios", params={"audience": "adults", "limit": 100},
                              headers=tb)).json()
        kid_ids = {p["scenario_id"] for k, p in entries if k == "scenario" and "kids" in p["audience"]}
        assert {i["scenario_id"] for i in kids["items"]} == kid_ids
        assert len(adults["items"]) == sum(1 for k, p in entries if k == "scenario" and "adults" in p["audience"])
        media = (await c.get("/internal/v1/media", params={"audience": "adults", "limit": 100}, headers=tb)).json()
        assert len(media["items"]) == counts["media_asset"]


async def test_runtime_role_flows_and_db_immutability(roles_env) -> None:
    """Под ролью сервиса работают публикация, откат, tick и заявки; опубликованное в БД не меняется (триггер)."""
    settings, roles = roles_env
    bus = InMemoryBus()
    app = build_app(settings, Runtime(settings, bus=bus))
    async with app.router.lifespan_context(app), httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://catalog") as c:
        def staff(actor):
            return internal_headers(settings, issuer="admin-bff", actor=actor)

        r = await c.post("/admin/v1/content/skill", json={"payload": skill("en.func.roles")},
                         headers=staff(CONTENT_MANAGER))
        assert r.status_code == 201, r.text
        base = "/admin/v1/content/skill/en.func.roles/versions/1"
        assert (await c.post(f"{base}/submit", headers=staff(CONTENT_MANAGER))).status_code == 200
        review = {"decision": "approve", "note": "Проверено", "locale_checks": {"ru": "checked", "uz": "checked"}}
        assert (await c.post(f"{base}/review", json=review, headers=staff(REVIEWER))).status_code == 200
        r = await c.post(f"{base}/publish", json={"reason": "Роли"}, headers=staff(PUBLISHER))
        assert r.status_code == 200, r.text
        tick = await c.post("/internal/v1/catalog:tick",
                            headers={"Authorization": f"Bearer {settings.scheduler_token.get_secret_value()}"})
        assert tick.status_code == 200
        learner = uuid.uuid4()
        req = await c.post("/internal/v1/media/requests", json={"kind": "song", "title": "Песня"},
                           headers=internal_headers(settings, issuer="telegram-bff", subject=str(learner)))
        assert req.status_code == 201, req.text
        event = make_envelope("user.deletion.requested.v1",
                              {"user_id": str(learner), "request_id": str(uuid.uuid4()),
                               "requested_at": "2026-11-19T06:00:00Z"}, producer="identity-consent")
        await bus.publish(event)
        assert not bus.dlq
        rid = req.json()["request_id"]
        assert (await _fetch(roles.runtime_url, roles.schema,
                             "SELECT user_id FROM media_requests WHERE request_id = $1", uuid.UUID(rid)))[0][0] is None
        assert RIGHTS.id

    rt, schema = roles.runtime_url, roles.schema
    forbidden = [
        "UPDATE content_versions SET payload = '{}'::jsonb WHERE status = 'published' AND key = 'en.func.roles'",
        "UPDATE content_versions SET status = 'draft' WHERE status = 'published' AND key = 'en.func.roles'",
        "UPDATE content_versions SET locale_checks = '{}'::jsonb WHERE status = 'published'",
        "UPDATE content_versions SET review_note = 'x' WHERE status = 'published'",
        "UPDATE content_versions SET key = 'x-x' WHERE status = 'published'",
        "DELETE FROM content_versions WHERE status = 'published'",
        "UPDATE scenario_test_runs SET ok = false",
        "DELETE FROM scenario_test_runs",
        "TRUNCATE content_versions",
    ]
    for stmt in forbidden:
        with pytest.raises(asyncpg.PostgresError):
            await _execute(rt, schema, stmt)
    # то же под владельцем схемы: триггер действует и для него (снять можно только DDL — в миграции)
    for stmt in forbidden[:6]:
        with pytest.raises(asyncpg.PostgresError):
            await _execute(roles.owner_url, schema, stmt)
    still = await _fetch(rt, schema, "SELECT status, payload FROM content_versions WHERE key = 'en.func.roles'")
    assert still[0]["status"] == "published" and json.loads(still[0]["payload"])["skill_id"] == "en.func.roles"
    # допустимые переходы проходят и в обход API (published → archived)
    await _execute(rt, schema, "UPDATE content_versions SET status = 'archived', archived_at = now() "
                               "WHERE key = 'en.func.roles'")


async def test_seed_migration_is_reversible_and_idempotent(roles_env) -> None:
    _, roles = roles_env
    owner = make_settings(database_url=roles.owner_url, db_schema=roles.schema, seed_dir=None)
    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = owner
    await asyncio.to_thread(command.downgrade, cfg, "0002")
    left = await _fetch(roles.owner_url, roles.schema, "SELECT count(*) AS n FROM content_versions")
    assert left[0]["n"] == 0
    await migrate(SERVICE_DIR, owner)
    again = await _fetch(roles.owner_url, roles.schema, "SELECT count(*) AS n FROM content_versions")
    assert again[0]["n"] == len(load_seed_dir(REAL_SEED))
    # повтор загрузки того же сида — без изменений
    engine = make_engine(roles.owner_url, roles.schema, pool_size=1)
    try:
        async with engine.begin() as conn:
            result = await conn.run_sync(lambda sync: apply_seed(
                sync, load_seed_dir(REAL_SEED), today=date(2026, 11, 19), external_sources=False,
                now=NOW))
        assert result == {"published": 0, "skipped": len(load_seed_dir(REAL_SEED))}
        # невалидный сид — миграция падает со списком ошибок, ничего не пишет
        bad = [(kind, dict(p)) for kind, p in load_seed_dir(REAL_SEED) if kind == "lesson"][:1]
        bad[0][1]["control_items"] = []
        bad[0][1][KEY_FIELDS["lesson"]] = "l-broken"
        with pytest.raises(SeedInvalid) as exc:
            async with engine.begin() as conn:
                await conn.run_sync(lambda sync: apply_seed(
                    sync, bad, today=date(2026, 11, 19), external_sources=False,
                    now=NOW))
        assert "NO_CONTROL_ITEMS" in str(exc.value)
    finally:
        await engine.dispose()
