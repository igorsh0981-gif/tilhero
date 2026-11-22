"""Спринт 6 (INTERNAL_API спринта 6 §7, PLAN «Требования LinguaFlow 1.2»): реестр агентов — `gameplay_director`
становится `code`/`active`, реализован в gamification (правила игры кодом), модель не вызывается: invoke — 404
AGENT_NOT_ACTIVE, версий инструкций нет (409 AGENT_NOT_LLM), маршрутизации версий нет. Миграция 0007 поверх живого
реестра спринта 5 и откат. Спринт 7 (INTERNAL_API §4): `cooperative_lesson_coach` — llm/active, `duel_host` —
code/lessons, `referral_integrity_reviewer` — rules/social; миграция 0008 поверх живого реестра спринта 6 и откат
(потолок комнаты, виды сессий). Самопроверка сида (`migrations/seed/check_seed.py`) сверяет реестр с ai.ts и файлами
сида."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import shutil
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import asyncpg
import pytest
from alembic import command
from alembic.config import Config
from conftest import SERVICE_DIR, make_settings
from gw_kit import ANALYST, MANAGER

from tilhero_ai_gateway.domain.registry import (
    AGENTS,
    AGENTS_SPRINT5,
    AGENTS_SPRINT6,
    FREE_TEXT_AGENT_IDS,
    LLM_AGENT_IDS,
    SPRINT6_CODE_AGENTS,
    SPRINT7_AGENTS,
)
from tilhero_common.testing import TEST_ADMIN_URL, create_schema, drop_schema, unique_schema

REPO = Path(SERVICE_DIR).parents[1]
CHECK_SEED = Path(SERVICE_DIR) / "migrations" / "seed" / "check_seed.py"
REGISTRY = Path(SERVICE_DIR) / "src" / "tilhero_ai_gateway" / "domain" / "registry.py"
BY_ID = {a["agent_id"]: a for a in AGENTS}


def _check_seed() -> ModuleType:
    spec = importlib.util.spec_from_file_location("aigw_check_seed", CHECK_SEED)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------- реестр


def test_gameplay_director_is_code_in_gamification() -> None:
    row = BY_ID["gameplay_director"]
    assert (row["implementation"], row["availability"], row["implemented_in"], row["planned_sprint"],
            row["free_text"], row["owner_role"]) == ("code", "active", "gamification", None, False, "methodist")
    assert set(row["title"]) == set(row["purpose"]) == {"ru", "uz"} and all(row["purpose"].values())
    assert "gameplay_director" not in LLM_AGENT_IDS and "gameplay_director" not in FREE_TEXT_AGENT_IDS
    assert SPRINT6_CODE_AGENTS == ("gameplay_director",)
    # снимок для отката 0007 — строка спринта 5
    [old] = AGENTS_SPRINT5
    assert (old["agent_id"], old["implementation"], old["availability"], old["planned_sprint"],
            old["implemented_in"]) == ("gameplay_director", "llm", "planned", 6, None)
    # агенты планов спринтов 8+ не тронуты
    for agent_id in ("media_lesson_designer", "language_pathway_advisor", "evening_review_coach"):
        assert BY_ID[agent_id]["availability"] == "planned" and BY_ID[agent_id]["implementation"] == "llm", agent_id


async def test_code_agent_is_listed_but_not_invokable(env) -> None:
    agent = await env.agent("gameplay_director")
    assert (agent["implementation"], agent["availability"], agent["implemented_in"], agent["planned_sprint"],
            agent["rollout"]) == ("code", "active", "gamification", None, None)
    items = {a["agent_id"]: a for a in (await env.c.get("/admin/v1/ai/agents", headers=env.h(ANALYST))).json()[
        "items"]}
    assert items["gameplay_director"]["implemented_in"] == "gamification"
    body = env.body(context={"x": 1})
    for caller in ("lessons", "memory"):
        r = await env.c.post("/internal/v1/agents/gameplay_director/invoke", json=body,
                             headers=env.svc(caller, subject=body["user_id"]))
        assert r.status_code == 404 and r.json()["code"] == "AGENT_NOT_ACTIVE", caller
    r = await env.c.post(env.url("gameplay_director", "versions"), headers=env.h(MANAGER))
    assert r.status_code == 409 and r.json()["code"] == "AGENT_NOT_LLM"
    assert await env.usage() == []  # вызовов модели нет


# ---------------------------------------------------------------- миграция 0007


async def test_migration_0007_on_live_registry_and_back() -> None:
    """Живой реестр спринта 5: gameplay_director — llm/planned со строкой маршрутизации версий. 0007 → code/active
    (gamification), пустая маршрутизация удалена; откат к 0006 → прежняя строка и маршрутизация; повторный подъём."""
    schema = unique_schema("aigw_m7")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema, seed_dir=None)
    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = settings
    conn = await asyncpg.connect(TEST_ADMIN_URL, server_settings={"search_path": schema})

    async def row() -> tuple[Any, ...]:
        r = await conn.fetchrow("SELECT implementation, availability, planned_sprint, implemented_in, purpose "
                                "FROM agents WHERE agent_id = 'gameplay_director'")
        assert r is not None
        return (r["implementation"], r["availability"], r["planned_sprint"], r["implemented_in"],
                json.loads(r["purpose"])["ru"])

    async def rollout() -> int:
        return int(await conn.fetchval("SELECT count(*) FROM agent_rollout WHERE agent_id = 'gameplay_director'"))

    try:
        await asyncio.to_thread(command.upgrade, cfg, "0006")
        # прод спринта 5: строка реестра из сида 0001 того времени и пустая маршрутизация LLM-агента
        old = AGENTS_SPRINT5[0]
        await conn.execute("UPDATE agents SET implementation = 'llm', availability = 'planned', planned_sprint = 6, "
                           "implemented_in = NULL, purpose = $1::jsonb WHERE agent_id = 'gameplay_director'",
                           json.dumps(old["purpose"]))
        await conn.execute("INSERT INTO agent_rollout (agent_id, canary_percent, updated_by) "
                           "VALUES ('gameplay_director', 0, 'seed') ON CONFLICT DO NOTHING")
        assert await row() == ("llm", "planned", 6, None, old["purpose"]["ru"]) and await rollout() == 1

        others_sql = ("SELECT agent_id, implementation, availability FROM agents "
                      "WHERE agent_id IN ('duel_host', 'spaced_repetition_coach')")
        before = {(r["agent_id"], r["implementation"], r["availability"]) for r in await conn.fetch(others_sql)}
        await asyncio.to_thread(command.upgrade, cfg, "0007")
        assert await row() == ("code", "active", None, "gamification", BY_ID["gameplay_director"]["purpose"]["ru"])
        assert await rollout() == 0
        # 0007 трогает только gameplay_director
        assert {(r["agent_id"], r["implementation"], r["availability"]) for r in await conn.fetch(others_sql)} == \
            before and ("spaced_repetition_coach", "code", "active") in before

        await asyncio.to_thread(command.downgrade, cfg, "0006")
        assert await row() == ("llm", "planned", 6, None, old["purpose"]["ru"]) and await rollout() == 1
        await asyncio.to_thread(command.downgrade, cfg, "0006")  # уже 0006 — без изменений
        await asyncio.to_thread(command.upgrade, cfg, "head")
        assert (await row())[:4] == ("code", "active", None, "gamification") and await rollout() == 0
    finally:
        await conn.close()
        await drop_schema(schema)


def test_sprint7_agents_registry() -> None:
    coach, duel, referral = BY_ID["cooperative_lesson_coach"], BY_ID["duel_host"], BY_ID["referral_integrity_reviewer"]
    assert (coach["implementation"], coach["availability"], coach["planned_sprint"], coach["free_text"],
            coach["implemented_in"], coach["owner_role"]) == ("llm", "active", None, True, None, "methodist")
    assert (duel["implementation"], duel["availability"], duel["implemented_in"], duel["free_text"]) == (
        "code", "active", "lessons", False)
    assert (referral["implementation"], referral["availability"], referral["implemented_in"],
            referral["owner_role"]) == ("rules", "active", "social", "operations")
    assert "cooperative_lesson_coach" in LLM_AGENT_IDS and "cooperative_lesson_coach" in FREE_TEXT_AGENT_IDS
    assert not {"duel_host", "referral_integrity_reviewer"} & LLM_AGENT_IDS
    assert SPRINT7_AGENTS == ("cooperative_lesson_coach", "duel_host", "referral_integrity_reviewer")
    # снимок для отката 0008 — строки спринта 6 (все три — llm/planned, спринт 7)
    assert {(a["agent_id"], a["implementation"], a["availability"], a["planned_sprint"]) for a in AGENTS_SPRINT6} == {
        (a, "llm", "planned", 7) for a in SPRINT7_AGENTS}
    for row in (coach, duel, referral):
        assert set(row["title"]) == set(row["purpose"]) == {"ru", "uz"} and all(row["purpose"].values())
        assert "ʻ" in row["purpose"]["uz"] or "'" not in row["purpose"]["uz"]


async def test_sprint7_code_and_rules_agents_not_invokable(env) -> None:
    body = env.body(context={"x": 1})
    for agent_id in ("duel_host", "referral_integrity_reviewer"):
        r = await env.c.post(f"/internal/v1/agents/{agent_id}/invoke", json=body,
                             headers=env.svc("lessons", subject=body["user_id"]))
        assert r.status_code == 404 and r.json()["code"] == "AGENT_NOT_ACTIVE", agent_id
    assert await env.usage() == []


async def test_migration_0008_on_live_registry_and_back() -> None:
    """Живой реестр спринта 6: три агента спринта 7 — llm/planned со строками маршрутизации версий, вызовы с видами
    сессий спринта 6. 0008 → коуч llm/active (маршрутизация остаётся), ведущий дуэли — code/lessons, проверка
    рефералов — rules/social (их пустая маршрутизация удалена); потолок комнаты 0,10 (не больше потолка месяца); виды
    сессий duel и pair. Откат к 0007 → строки спринта 6, маршрутизация, pair/duel → NULL, столбца нет; повторный
    подъём."""
    schema = unique_schema("aigw_m8")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema, seed_dir=None)
    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = settings
    conn = await asyncpg.connect(TEST_ADMIN_URL, server_settings={"search_path": schema})

    async def rows() -> dict[str, tuple[Any, ...]]:
        out = await conn.fetch("SELECT agent_id, implementation, availability, planned_sprint, implemented_in "
                               "FROM agents WHERE agent_id = ANY($1::text[])", list(SPRINT7_AGENTS))
        return {r["agent_id"]: (r["implementation"], r["availability"], r["planned_sprint"], r["implemented_in"])
                for r in out}

    async def rollouts() -> set[str]:
        out = await conn.fetch("SELECT agent_id FROM agent_rollout WHERE agent_id = ANY($1::text[])",
                               list(SPRINT7_AGENTS))
        return {r["agent_id"] for r in out}

    async def columns() -> set[str]:
        out = await conn.fetch("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 "
                               "AND table_name = 'budget'", schema)
        return {r["column_name"] for r in out}

    usage_sql = ("INSERT INTO usage (call_id, request_id, caller, agent_id, provider, status, session_kind, "
                 "finished_at) VALUES (gen_random_uuid(), gen_random_uuid(), 'lessons', 'cooperative_lesson_coach', "
                 "'fake', 'ok', $1, now())")
    try:
        await asyncio.to_thread(command.upgrade, cfg, "0007")
        # прод спринта 6: строки реестра из сида 0001 того времени и пустая маршрутизация LLM-агентов
        for old in AGENTS_SPRINT6:
            await conn.execute("UPDATE agents SET implementation = $2, availability = $3, planned_sprint = $4, "
                               "implemented_in = NULL, free_text = $5 WHERE agent_id = $1", old["agent_id"],
                               old["implementation"], old["availability"], old["planned_sprint"], old["free_text"])
            await conn.execute("INSERT INTO agent_rollout (agent_id, canary_percent, updated_by) "
                               "VALUES ($1, 0, 'seed') ON CONFLICT DO NOTHING", old["agent_id"])
        await conn.execute("UPDATE budget SET monthly_cap_usd = 0.05, speech_monthly_cap_usd = 0.05")
        await conn.execute(usage_sql, "lesson")
        with pytest.raises(asyncpg.PostgresError):
            await conn.execute(usage_sql, "pair")
        assert set((await rows()).values()) == {("llm", "planned", 7, None)} and await rollouts() == set(SPRINT7_AGENTS)

        await asyncio.to_thread(command.upgrade, cfg, "0008")
        assert await rows() == {"cooperative_lesson_coach": ("llm", "active", None, None),
                                "duel_host": ("code", "active", None, "lessons"),
                                "referral_integrity_reviewer": ("rules", "active", None, "social")}
        assert await rollouts() == {"cooperative_lesson_coach"}
        # потолок месяца 0,05 $ (правка сотрудника) — потолок комнаты не больше него
        assert str(await conn.fetchval("SELECT room_cap_usd FROM budget")) == "0.0500"
        with pytest.raises(asyncpg.PostgresError):
            await conn.execute("UPDATE budget SET room_cap_usd = 1")
        await conn.execute(usage_sql, "pair")
        await conn.execute(usage_sql, "duel")
        # сид без накладки 0008 (seed_dir тестов не задан → реальный сид): черновик коуча v1 и 8 кейсов
        drafts = await conn.fetch("SELECT version, status, author_id FROM agent_versions "
                                  "WHERE agent_id = 'cooperative_lesson_coach'")
        assert [(r["version"], r["status"]) for r in drafts] == [(1, "draft")]
        assert await conn.fetchval("SELECT count(*) FROM golden_cases WHERE agent_id = "
                                   "'cooperative_lesson_coach' AND mandatory") == 8

        await asyncio.to_thread(command.downgrade, cfg, "0007")
        assert set((await rows()).values()) == {("llm", "planned", 7, None)} and await rollouts() == set(SPRINT7_AGENTS)
        assert "room_cap_usd" not in await columns()
        assert await conn.fetchval("SELECT count(*) FROM usage WHERE session_kind IS NULL") == 2
        assert await conn.fetchval("SELECT count(*) FROM agent_versions WHERE agent_id = "
                                   "'cooperative_lesson_coach'") == 0
        assert await conn.fetchval("SELECT count(*) FROM golden_cases WHERE agent_id = "
                                   "'cooperative_lesson_coach'") == 0
        await asyncio.to_thread(command.upgrade, cfg, "head")
        assert (await rows())["duel_host"] == ("code", "active", None, "lessons") and "room_cap_usd" in await columns()
        assert await rollouts() == {"cooperative_lesson_coach"}
    finally:
        await conn.close()
        await drop_schema(schema)


# ---------------------------------------------------------------- самопроверка сида


def test_check_seed_passes_on_repository(monkeypatch: pytest.MonkeyPatch,
                                         capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(sys, "argv", [str(CHECK_SEED), "--repo", str(REPO)])
    code = _check_seed().main()
    out = capsys.readouterr().out
    assert code == 0, out[-2000:]
    assert "Итого: ошибок 0" in out


def test_check_seed_registry_rules(tmp_path: Path) -> None:
    """Сверка реестра: агенты = ai.ts AgentId, code-агенты с implemented_in (gameplay_director → gamification),
    сид только у активных LLM-агентов; поломки реестра и лишний файл сида — ошибки."""
    cs = _check_seed()
    contracts = REPO / "packages/contracts/src"
    ts = cs.TS((contracts / "content.ts").read_text("utf-8"), (contracts / "ai.ts").read_text("utf-8"))
    seed = Path(CHECK_SEED).parent

    def run(registry_text: str, extra_seed: str | None = None) -> list[str]:
        repo = tmp_path / f"repo{len(list(tmp_path.iterdir()))}"
        target = repo / "services/ai-gateway/src/tilhero_ai_gateway/domain/registry.py"
        target.parent.mkdir(parents=True)
        target.write_text(registry_text, "utf-8")
        seed_dir = repo / "seed"
        shutil.copytree(seed / "agents", seed_dir / "agents")
        shutil.copytree(seed / "golden", seed_dir / "golden")
        if extra_seed:
            (seed_dir / extra_seed).write_text("{}", "utf-8")
        rep = cs.Report()
        cs.check_registry(ts, repo, seed_dir, [], rep)
        return rep.errors

    original = REGISTRY.read_text("utf-8")
    rows = cs.read_registry(REGISTRY, cs.Report())
    assert {r["agent_id"]: r["implemented_in"] for r in rows if r["implementation"] == "code"} == \
        cs.EXPECTED_CODE_AGENTS
    assert cs.EXPECTED_CODE_AGENTS["gameplay_director"] == "gamification"
    assert run(original) == []
    # агент снова LLM: реестр расходится с ожидаемым набором code-агентов, у LLM — implemented_in
    llm = original.replace('"methodist", "code", implemented_in="gamification"),',
                           '"methodist", "llm", implemented_in="gamification"),')
    assert llm != original
    errors = run(llm)
    assert any("implemented_in должен быть null" in e for e in errors)
    assert any("code-агенты реестра" in e for e in errors)
    assert any("активные LLM-агенты" in e for e in errors)
    # code-агент без implemented_in
    errors = run(original.replace('implemented_in="gamification"),', "),"))
    assert any("gameplay_director: у code/rules-агента нет implemented_in" in e for e in errors)
    # лишний файл сида у code-агента
    errors = run(original, extra_seed="agents/gameplay_director.v1.json")
    assert any("gameplay_director" in e and "лишний" in e for e in errors)
