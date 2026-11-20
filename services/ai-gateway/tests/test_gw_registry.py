"""Спринт 6 (INTERNAL_API спринта 6 §7, PLAN «Требования LinguaFlow 1.2»): реестр агентов — `gameplay_director`
становится `code`/`active`, реализован в gamification (правила игры кодом), модель не вызывается: invoke — 404
AGENT_NOT_ACTIVE, версий инструкций нет (409 AGENT_NOT_LLM), маршрутизации версий нет. Миграция 0007 поверх живого
реестра спринта 5 и откат. Самопроверка сида (`migrations/seed/check_seed.py`) сверяет реестр с ai.ts и файлами сида."""

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
    FREE_TEXT_AGENT_IDS,
    LLM_AGENT_IDS,
    SPRINT6_CODE_AGENTS,
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
    # остальные агенты планов спринтов 7+ не тронуты
    for agent_id in ("duel_host", "referral_integrity_reviewer", "cooperative_lesson_coach"):
        assert (BY_ID[agent_id]["availability"], BY_ID[agent_id]["planned_sprint"]) == ("planned", 7), agent_id


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

        await asyncio.to_thread(command.upgrade, cfg, "0007")
        assert await row() == ("code", "active", None, "gamification", BY_ID["gameplay_director"]["purpose"]["ru"])
        assert await rollout() == 0
        others = await conn.fetch("SELECT agent_id, implementation, availability FROM agents "
                                  "WHERE agent_id IN ('duel_host', 'spaced_repetition_coach')")
        assert {(r["agent_id"], r["implementation"], r["availability"]) for r in others} == {
            ("duel_host", "llm", "planned"), ("spaced_repetition_coach", "code", "active")}

        await asyncio.to_thread(command.downgrade, cfg, "0006")
        assert await row() == ("llm", "planned", 6, None, old["purpose"]["ru"]) and await rollout() == 1
        await asyncio.to_thread(command.downgrade, cfg, "0006")  # уже 0006 — без изменений
        await asyncio.to_thread(command.upgrade, cfg, "head")
        assert (await row())[:4] == ("code", "active", None, "gamification") and await rollout() == 0
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
