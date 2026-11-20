"""Модели = миграции; миграции под ролью-владельцем, сервис — под своей ролью без DDL; неизменяемость версий на уровне
БД (триггер); реальный сид автора инструкций (migrations/seed) загружается миграцией 0002 как опубликованный v1,
накладка 0003 (migrations/seed/0003) публикует independent_evaluator v2 и детский золотой кейс, накладка 0004
(migrations/seed/0004) создаёт черновик teaching_coach v2 с gloss_word и кейсы gloss_word, а стенд (fake +
AI_ALLOW_FAKE_TEST_PUBLISH) при старте публикует его по прогону золотых тестов на fake; реестр и модели речи
спринта 5; откат и повторный подъём миграций, повторная загрузка без изменений."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import asyncpg
import httpx
import pytest
from alembic import command
from alembic.config import Config
from conftest import SERVICE_DIR, make_settings
from gw_kit import MANAGER
from sqlalchemy.engine import make_url

from tilhero_ai_gateway.domain.common import SEED_ACTOR_ID
from tilhero_ai_gateway.domain.registry import AGENT_IDS, AGENTS, LLM_AGENT_IDS
from tilhero_ai_gateway.domain.seed import apply_seed, apply_seed_drafts, load_seed_dir
from tilhero_ai_gateway.main import build_app
from tilhero_ai_gateway.models import Base
from tilhero_common.app import Runtime
from tilhero_common.db import make_engine
from tilhero_common.messaging import Envelope, InMemoryBus, messaging_metadata
from tilhero_common.testing import (
    assert_event_conforms,
    ddl_allowed_for,
    internal_headers,
    migrate,
    migrated_under_roles,
    schema_drift,
)

TABLES = ("agents", "models", "agent_versions", "agent_rollout", "golden_cases", "test_runs", "budget", "usage",
          "deleted_users", "outbox", "inbox")
REAL_SEED = Path(SERVICE_DIR) / "migrations" / "seed"
OVERLAY_0003 = REAL_SEED / "0003"
OVERLAY_0004 = REAL_SEED / "0004"


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
    """Миграции под владельцем (реальный сид migrations/seed), рантайм — под ролью сервиса."""
    def make(**kw: Any):
        return make_settings(seed_dir=None, **kw)

    async with migrated_under_roles(SERVICE_DIR, make, "aigw_roles") as (settings, roles):
        yield settings, roles


async def test_models_match_migrations_and_runtime_role_has_no_ddl(roles_env) -> None:
    _, roles = roles_env
    assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
    for table in TABLES:
        assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table


async def test_reference_data_seeded(roles_env) -> None:
    _, roles = roles_env
    agents = await _fetch(roles.runtime_url, roles.schema, "SELECT * FROM agents ORDER BY agent_id")
    assert [a["agent_id"] for a in agents] == sorted(AGENT_IDS) and len(agents) == 17
    by_id = {a["agent_id"]: a for a in agents}
    assert {a for a, r in by_id.items() if r["implementation"] == "llm" and r["availability"] == "active"} == {
        "teaching_coach", "conversation_partner", "independent_evaluator"}
    assert {a for a, r in by_id.items() if r["implementation"] == "code"} == {
        "learning_orchestrator", "curriculum_planner", "diagnostic_assessor", "spaced_repetition_coach",
        "pronunciation_coach"}
    assert (by_id["spaced_repetition_coach"]["availability"], by_id["spaced_repetition_coach"]["implemented_in"],
            by_id["pronunciation_coach"]["availability"], by_id["pronunciation_coach"]["implemented_in"],
            by_id["pronunciation_coach"]["free_text"], by_id["evening_review_coach"]["availability"]) == (
        "active", "memory", "active", "ai-gateway", False, "planned")
    assert {a for a, r in by_id.items() if r["implementation"] == "rules"} == {"safety_quality_gate", "error_analyst"}
    assert all(r["planned_sprint"] for r in agents if r["availability"] == "planned")
    assert {a for a, r in by_id.items() if r["free_text"] and r["availability"] == "active"} == {
        "conversation_partner", "independent_evaluator"}
    for row in agents:
        title, purpose = json.loads(row["title"]), json.loads(row["purpose"])
        assert set(title) == set(purpose) == {"ru", "uz"} and all(title.values()) and all(purpose.values())
    models = {r["model_id"]: r for r in await _fetch(roles.runtime_url, roles.schema, "SELECT * FROM models")}
    assert {m: (str(r["input_usd_per_mtok"]), str(r["output_usd_per_mtok"]), r["provider"],
                str(r["audio_usd_per_hour"])) for m, r in models.items()} == {
        "claude-haiku-5-5": ("0.1000", "0.5000", "anthropic", "None"),
        "claude-sonnet-5-5": ("2.0000", "10.0000", "anthropic", "None"),
        "fake": ("0.0000", "0.0000", "fake", "None"),
        "azure-speech-pa": ("0.0000", "0.0000", "azure_speech", "1.3200"),
        "fake-speech": ("0.0000", "0.0000", "fake_speech", "0.0000")}
    budget = (await _fetch(roles.runtime_url, roles.schema, "SELECT * FROM budget"))[0]
    assert (budget["ai_enabled"], str(budget["monthly_cap_usd"]), str(budget["learner_daily_cap_usd"]),
            str(budget["lesson_cap_usd"]), budget["alert_percent"]) == (True, "20.00", "0.0500", "0.0300", 80)
    rollouts = await _fetch(roles.runtime_url, roles.schema, "SELECT agent_id FROM agent_rollout")
    assert {r["agent_id"] for r in rollouts} == set(LLM_AGENT_IDS)
    assert len(AGENTS) == 17


async def test_real_seed_published_with_audit(roles_env) -> None:
    """Сид автора инструкций: 3 версии v1 автора seed (0002), затем накладка 0003 — independent_evaluator v2 (те же
    тексты, новые параметры вызова) и кейс ie-19-kids-refused; v1 оценщика → archived; аудит ai.version_published;
    накладка 0004 — черновик teaching_coach v2 (публикация — после золотых тестов) и 8 кейсов gloss_word (6
    обязательных), аудит ai.version_created."""
    _, roles = roles_env
    seed, overlay, overlay4 = load_seed_dir(REAL_SEED), load_seed_dir(OVERLAY_0003), load_seed_dir(OVERLAY_0004)
    assert set(seed.versions) == {"teaching_coach", "conversation_partner", "independent_evaluator"}
    assert set(overlay.versions) == {"independent_evaluator"} and set(overlay4.versions) == {"teaching_coach"}
    gloss = [c for c in overlay4.cases if c["input"]["context"].get("request") == "gloss_word"]
    assert len(gloss) == len(overlay4.cases) >= 6 and sum(c["mandatory"] for c in gloss) >= 6
    per_agent = Counter(c["agent_id"] for c in [*seed.cases, *overlay.cases, *overlay4.cases])
    assert all(n >= 10 for n in per_agent.values()) and len(per_agent) == 3  # ≥ 10 кейсов на агента (PLAN G)
    rows = await _fetch(roles.runtime_url, roles.schema,
                        "SELECT agent_id, version, status, author_id, published_by, body_hash, max_output_tokens, "
                        "max_cost_usd, timeout_ms, instructions, rules, output_schema FROM agent_versions")
    assert sorted((r["agent_id"], r["version"], r["status"], r["author_id"], r["published_by"]) for r in rows) == \
        sorted([("teaching_coach", 1, "published", SEED_ACTOR_ID, SEED_ACTOR_ID),
                ("teaching_coach", 2, "draft", SEED_ACTOR_ID, None),
                ("conversation_partner", 1, "published", SEED_ACTOR_ID, SEED_ACTOR_ID),
                ("independent_evaluator", 1, "archived", SEED_ACTOR_ID, SEED_ACTOR_ID),
                ("independent_evaluator", 2, "published", SEED_ACTOR_ID, SEED_ACTOR_ID)])
    tc2 = next(r for r in rows if (r["agent_id"], r["version"]) == ("teaching_coach", 2))
    assert (tc2["max_output_tokens"], str(tc2["max_cost_usd"]), tc2["timeout_ms"]) == (400, "0.005000", 8000)
    assert json.loads(tc2["output_schema"])["anyOf"]  # объединённая схема: v1 + gloss_word
    ev = {r["version"]: r for r in rows if r["agent_id"] == "independent_evaluator"}
    assert (ev[2]["max_output_tokens"], str(ev[2]["max_cost_usd"]), ev[2]["timeout_ms"]) == (600, "0.030000", 12000)
    assert (ev[1]["max_output_tokens"], str(ev[1]["max_cost_usd"]), ev[1]["timeout_ms"]) == (900, "0.020000", 20000)
    assert (ev[2]["instructions"], ev[2]["rules"], ev[2]["output_schema"]) == (
        ev[1]["instructions"], ev[1]["rules"], ev[1]["output_schema"])  # тексты v1 без изменений
    rollout = await _fetch(roles.runtime_url, roles.schema, "SELECT agent_id, published_version, previous_version "
                                                            "FROM agent_rollout WHERE published_version IS NOT NULL")
    assert {r["agent_id"]: (r["published_version"], r["previous_version"]) for r in rollout} == {
        "teaching_coach": (1, None), "conversation_partner": (1, None), "independent_evaluator": (2, 1)}
    cases = await _fetch(roles.runtime_url, roles.schema, "SELECT agent_id, case_id, mandatory, created_by "
                                                          "FROM golden_cases")
    assert Counter(r["agent_id"] for r in cases) == per_agent and {r["created_by"] for r in cases} == {SEED_ACTOR_ID}
    assert ("independent_evaluator", "ie-19-kids-refused", True) in {(r["agent_id"], r["case_id"], r["mandatory"])
                                                                     for r in cases}
    outbox = [Envelope.model_validate(json.loads(r["envelope"])) for r in
              await _fetch(roles.runtime_url, roles.schema, "SELECT envelope FROM outbox")]
    assert len(outbox) == 5
    for e in outbox:
        assert_event_conforms(e)
        assert (e.event_type, e.producer, e.payload["actor_type"], e.payload["actor_id"]) == (
            "admin.audit.recorded.v1", "ai-gateway", "system", SEED_ACTOR_ID)
    published = [e for e in outbox if e.payload["action"] == "ai.version_published"]
    assert sorted(e.payload["after"]["published_version"] for e in published) == [1, 1, 1, 2]
    created = [e.payload for e in outbox if e.payload["action"] == "ai.version_created"]
    assert [(c["object_id"], c["after"]["status"]) for c in created] == [("teaching_coach@2", "draft")]


async def test_real_seed_serves_fake_stand_and_golden_runs(roles_env) -> None:
    """Под ролью сервиса и провайдером fake (стенд e2e): при старте черновик сида teaching_coach v2 прогоняется на fake
    и публикуется (аудит ai.test_run и ai.version_published от system); каждый агент отвечает по схеме опубликованной
    версии (gloss_word — вызывающий memory); прогон золотых тестов на fake — обязательные пройдены (содержимое
    output.* — skipped)."""
    settings, roles = roles_env
    app = build_app(settings, Runtime(settings, bus=InMemoryBus()))
    seed, overlay, overlay4 = load_seed_dir(REAL_SEED), load_seed_dir(OVERLAY_0003), load_seed_dir(OVERLAY_0004)
    published = {"teaching_coach": 2, "conversation_partner": 1, "independent_evaluator": 2}
    async with app.router.lifespan_context(app), httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://ai-gateway") as c:
        rows = await _fetch(roles.runtime_url, roles.schema, "SELECT version, status, published_by FROM "
                                                             "agent_versions WHERE agent_id = 'teaching_coach'")
        assert sorted((r["version"], r["status"], r["published_by"]) for r in rows) == [
            (1, "archived", SEED_ACTOR_ID), (2, "published", SEED_ACTOR_ID)]
        stand_run = await _fetch(roles.runtime_url, roles.schema, "SELECT provider, passed_mandatory, started_by "
                                                                  "FROM test_runs WHERE agent_id = 'teaching_coach'")
        assert [(r["provider"], r["passed_mandatory"], r["started_by"]) for r in stand_run] == [
            ("fake", True, SEED_ACTOR_ID)]
        for case in [*seed.cases, *overlay.cases, *overlay4.cases]:
            ctx = case["input"]["context"]
            gloss = ctx.get("request") == "gloss_word"
            body = {"request_id": str(uuid.uuid4()), "session_id": str(uuid.uuid4()),
                    "session_kind": "memory" if gloss else "lesson",
                    "user_id": str(uuid.uuid4()), "audience": case["input"]["audience"],
                    "locale": ctx.get("explain_locale", "ru"), "context": ctx}
            caller = "memory" if gloss else "lessons"
            r = await c.post(f"/internal/v1/agents/{case['agent_id']}/invoke", json=body,
                             headers=internal_headers(settings, issuer=caller, subject=body["user_id"]))
            assert r.status_code == 200, (case["case_id"], r.text)
            expected = "refused" if case["input"]["audience"] == "kids" and case["agent_id"] != "teaching_coach" \
                else "ok"
            assert r.json()["status"] == expected, (case["case_id"], r.json())
            if expected == "ok":
                assert r.json()["agent_version"] == published[case["agent_id"]], case["case_id"]
        for agent_id, version in published.items():
            r = await c.post(f"/admin/v1/ai/agents/{agent_id}/versions/{version}/test-runs",
                             headers=internal_headers(settings, issuer="admin-bff", actor=MANAGER))
            assert r.status_code == 202, r.text
            run_id = r.json()["run_id"]
            for _ in range(500):
                run = (await c.get(f"/admin/v1/ai/agents/{agent_id}/versions/{version}/test-runs/{run_id}",
                                   headers=internal_headers(settings, issuer="admin-bff", actor=MANAGER))).json()
                if run["status"] != "running":
                    break
                await asyncio.sleep(0.02)
            assert run["status"] == "finished" and run["provider"] == "fake"
            assert run["passed_mandatory"], [(x["case_id"], x["failures"]) for x in run["results"] if not x["passed"]]
            assert any(x["skipped"] for x in run["results"])  # содержимое output.* на fake не проверяется
            if agent_id == "independent_evaluator":  # детский кейс накладки 0003 — обязательный и пройден
                kids = next(x for x in run["results"] if x["case_id"] == "ie-19-kids-refused")
                assert kids["mandatory"] and kids["passed"], kids
            if agent_id == "teaching_coach":  # кейсы gloss_word накладки 0004 — обязательные пройдены, дети — ok
                gloss = {x["case_id"]: x for x in run["results"] if x["case_id"].startswith("tc-gloss-")}
                assert len(gloss) == len(overlay4.cases) and all(x["passed"] for x in gloss.values()), gloss
                assert gloss["tc-gloss-kids-ok"]["mandatory"]


async def test_seed_migration_is_reversible_and_idempotent(roles_env) -> None:
    _, roles = roles_env
    owner = make_settings(database_url=roles.owner_url, db_schema=roles.schema, seed_dir=None)
    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = owner

    async def count(query: str) -> int:
        return int((await _fetch(roles.owner_url, roles.schema, query))[0]["n"])

    # откат только накладки 0003: v2 оценщика удалена, v1 снова опубликована, детский кейс удалён, cost_limit → CHECK
    await _execute(roles.owner_url, roles.schema,
                   "INSERT INTO usage (call_id, request_id, caller, agent_id, provider, status, reason, finished_at) "
                   "VALUES ($1, $2, 'lessons', 'independent_evaluator', 'anthropic', 'unavailable', 'cost_limit', "
                   "now())", uuid.uuid4(), uuid.uuid4())
    # откат 0004: черновик teaching_coach v2 и кейсы gloss_word удалены, агенты и модели — как в спринте 4
    await asyncio.to_thread(command.downgrade, cfg, "0003")
    assert await count("SELECT count(*) AS n FROM agent_versions WHERE agent_id = 'teaching_coach'") == 1
    assert await count("SELECT count(*) AS n FROM golden_cases WHERE case_id LIKE 'tc-gloss-%'") == 0
    assert await count("SELECT count(*) AS n FROM models") == 3
    assert await count("SELECT count(*) AS n FROM agent_rollout WHERE agent_id IN ('pronunciation_coach', "
                       "'spaced_repetition_coach')") == 2
    assert await count("SELECT count(*) AS n FROM agents WHERE implementation = 'llm' "
                       "AND availability = 'planned' AND agent_id = 'pronunciation_coach'") == 1
    await asyncio.to_thread(command.downgrade, cfg, "0002")
    rows = await _fetch(roles.owner_url, roles.schema, "SELECT version, status FROM agent_versions "
                                                       "WHERE agent_id = 'independent_evaluator'")
    assert [(r["version"], r["status"]) for r in rows] == [(1, "published")]
    assert (await _fetch(roles.owner_url, roles.schema, "SELECT published_version AS v FROM agent_rollout "
                                                        "WHERE agent_id = 'independent_evaluator'"))[0]["v"] == 1
    assert await count("SELECT count(*) AS n FROM golden_cases WHERE case_id = 'ie-19-kids-refused'") == 0
    assert await count("SELECT count(*) AS n FROM usage WHERE reason = 'budget_exceeded'") == 1
    with pytest.raises(asyncpg.PostgresError):
        await _execute(roles.owner_url, roles.schema, "UPDATE usage SET reason = 'cost_limit'")
    await migrate(SERVICE_DIR, owner)
    assert await count("SELECT count(*) AS n FROM agent_versions WHERE agent_id = 'independent_evaluator' "
                       "AND status = 'published' AND max_output_tokens = 600") == 1

    await asyncio.to_thread(command.downgrade, cfg, "0001")
    assert await count("SELECT count(*) AS n FROM agent_versions") == 0
    assert await count("SELECT count(*) AS n FROM golden_cases") == 0
    assert await count("SELECT count(*) AS n FROM agent_rollout WHERE published_version IS NOT NULL") == 0
    await migrate(SERVICE_DIR, owner)
    seed, overlay, overlay4 = load_seed_dir(REAL_SEED), load_seed_dir(OVERLAY_0003), load_seed_dir(OVERLAY_0004)
    assert await count("SELECT count(*) AS n FROM agent_versions") == 5
    engine = make_engine(roles.owner_url, roles.schema, pool_size=1)
    try:
        async with engine.begin() as conn:
            counts = await conn.run_sync(lambda sync: apply_seed(sync, seed, datetime(2026, 11, 19, tzinfo=UTC)))
            # повтор 0002 не откатывает оценщика на тело v1: оно уже публиковалось сидом
            assert counts == {"published": 0, "skipped": 3, "cases_written": 0, "cases_skipped": len(seed.cases)}
            counts = await conn.run_sync(lambda sync: apply_seed(sync, overlay, datetime(2026, 11, 19, tzinfo=UTC)))
            assert counts == {"published": 0, "skipped": 1, "cases_written": 0, "cases_skipped": len(overlay.cases)}
            counts = await conn.run_sync(
                lambda sync: apply_seed_drafts(sync, overlay4, datetime(2026, 11, 20, tzinfo=UTC)))
            assert counts == {"drafted": 0, "skipped": 1, "blocked": 0, "cases_written": 0,
                              "cases_skipped": len(overlay4.cases)}
    finally:
        await engine.dispose()
    # полный откат схемы и повторный подъём
    await asyncio.to_thread(command.downgrade, cfg, "base")
    tables = await _fetch(roles.owner_url, roles.schema,
                          "SELECT table_name FROM information_schema.tables WHERE table_schema = $1", roles.schema)
    assert {t["table_name"] for t in tables} <= {"alembic_version"}
    await migrate(SERVICE_DIR, owner)
    assert await count("SELECT count(*) AS n FROM agents") == 17


async def test_db_immutability_under_runtime_role(roles_env) -> None:
    settings, roles = roles_env
    rt, schema = roles.runtime_url, roles.schema
    app = build_app(settings, Runtime(settings, bus=InMemoryBus()))
    async with app.router.lifespan_context(app), httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://ai-gateway") as c:
        # стенд опубликовал черновик сида teaching_coach v2 при старте → черновик сотрудника — v3
        r = await c.post("/admin/v1/ai/agents/teaching_coach/versions",
                         headers=internal_headers(settings, issuer="admin-bff", actor=MANAGER))
        assert r.status_code == 201 and r.json()["version"] == 3, r.text
    forbidden = [
        "UPDATE agent_versions SET instructions = 'x' WHERE status = 'published'",
        "UPDATE agent_versions SET status = 'draft' WHERE status = 'published'",
        "UPDATE agent_versions SET published_by = 'x' WHERE status = 'published'",
        "UPDATE agent_versions SET version = 9 WHERE status = 'draft'",
        "UPDATE agent_versions SET status = 'archived', archived_at = now() WHERE status = 'draft'",
        "DELETE FROM agent_versions WHERE status = 'published'",
        "TRUNCATE agent_versions",
    ]
    for stmt in forbidden:
        with pytest.raises(asyncpg.PostgresError):
            await _execute(rt, schema, stmt)
    for stmt in forbidden[:6]:  # триггер действует и для владельца схемы
        with pytest.raises(asyncpg.PostgresError):
            await _execute(roles.owner_url, schema, stmt)
    # черновик правится; под канарейкой — заморожен и не удаляется
    await _execute(rt, schema, "UPDATE agent_versions SET notes = 'n' WHERE status = 'draft'")
    await _execute(rt, schema, "UPDATE agent_rollout SET canary_version = 3, canary_percent = 10 "
                               "WHERE agent_id = 'teaching_coach'")
    with pytest.raises(asyncpg.PostgresError):
        await _execute(rt, schema, "UPDATE agent_versions SET notes = 'm' WHERE status = 'draft'")
    with pytest.raises(asyncpg.PostgresError):
        await _execute(rt, schema, "DELETE FROM agent_versions WHERE status = 'draft'")
    # завершённый прогон неизменяем
    await _execute(rt, schema, "INSERT INTO test_runs (run_id, agent_id, version, status, provider, body_hash, "
                               "cases_hash, started_by, finished_at) VALUES ($1, 'teaching_coach', 1, 'finished', "
                               "'fake', $2, $2, 'x', now())", uuid.uuid4(), "0" * 64)
    with pytest.raises(asyncpg.PostgresError):
        await _execute(rt, schema, "UPDATE test_runs SET passed_mandatory = true")
    # допустимый переход проходит и в обход API (published → archived)
    await _execute(rt, schema, "UPDATE agent_rollout SET published_version = NULL, canary_version = NULL, "
                               "canary_percent = 0 WHERE agent_id = 'teaching_coach'")
    await _execute(rt, schema, "UPDATE agent_versions SET status = 'archived', archived_at = now() "
                               "WHERE agent_id = 'teaching_coach' AND status = 'published'")
