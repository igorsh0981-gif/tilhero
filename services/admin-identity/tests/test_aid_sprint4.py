"""Спринт 4: права AI-поиска (events.review, sources.manage, discovery.manage) — каталог, зеркало admin.ts,
матрица после миграции 0005, привилегированность sources.manage, откат и повтор миграции."""

from __future__ import annotations

import asyncio
import re
import uuid
from pathlib import Path

import asyncpg
from aid_testkit import SERVICE_DIR, Env, Person, make_settings, new_email

from tilhero_admin_identity.domain.catalog import (
    PERMISSIONS,
    PRIVILEGED_PERMISSIONS,
    PRIVILEGED_ROLES,
    ROLE_CODES,
    privileged_by,
)
from tilhero_common.testing import TEST_ADMIN_URL, create_schema, drop_schema, migrate, unique_schema

SPRINT4 = ["events.review", "sources.manage", "discovery.manage"]
SPRINT6 = ["news.manage"]  # миграция 0006 (test_aid_sprint6.py)
SPRINT7 = ["users.access.manage"]  # миграция 0007 (test_aid_sprint7.py)
SPRINT8 = ["ops.queues.manage"]  # миграция 0008 (test_aid_sprint8.py)
ADMIN_TS = Path(SERVICE_DIR).parents[1] / "packages" / "contracts" / "src" / "admin.ts"
OPERATIONS_BEFORE = ["dashboard.read", "users.read", "support.read", "audit.read", "config.read", "ops.kill_switch"]


def _ts_union(source: str, type_name: str) -> list[str]:
    m = re.search(rf"export type {type_name} =(.*?);", source, re.S)
    assert m, type_name
    body = re.sub(r"//[^\n]*", "", m.group(1))
    return re.findall(r'"([^"]+)"', body)


def _ts_const_list(source: str, name: str) -> list[str]:
    m = re.search(rf"export const {name}[^=]*=\s*\[(.*?)\]", source, re.S)
    assert m, name
    return re.findall(r'"([^"]+)"', m.group(1))


# ---------------------------------------------------------------- каталог и зеркало admin.ts

def test_catalog_mirrors_admin_ts() -> None:
    src = ADMIN_TS.read_text(encoding="utf-8")
    assert list(PERMISSIONS) == _ts_union(src, "Permission")  # тот же набор и порядок (порядок выдачи в API)
    assert list(ROLE_CODES) == _ts_union(src, "RoleCode")
    assert set(PRIVILEGED_ROLES) == set(_ts_const_list(src, "PRIVILEGED_ROLES"))
    for p in SPRINT4:
        assert p in PERMISSIONS


def test_sources_manage_is_privileged_permission() -> None:
    assert "sources.manage" in PRIVILEGED_PERMISSIONS
    assert "events.review" not in PRIVILEGED_PERMISSIONS and "discovery.manage" not in PRIVILEGED_PERMISSIONS
    assert privileged_by("analyst", ["dashboard.read", "sources.manage"]) is True
    assert privileged_by("analyst", ["dashboard.read", "events.review", "discovery.manage"]) is False
    assert privileged_by("operations", []) is True


# ---------------------------------------------------------------- матрица после миграции

async def test_matrix_after_migration(env: Env, root: Person) -> None:
    roles = (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()
    assert roles["permissions"] == list(PERMISSIONS) and len(roles["permissions"]) == 25
    by = {r["code"]: r for r in roles["items"]}
    assert by["super_admin"]["permissions"] == list(PERMISSIONS)
    assert by["operations"]["permissions"] == [*OPERATIONS_BEFORE, *SPRINT4, *SPRINT6, *SPRINT7, *SPRINT8]
    assert by["operations"]["privileged"] is True and by["super_admin"]["privileged"] is True
    for code in ("support", "billing", "agent_manager", "analyst", "auditor", "read_only"):
        assert not set(SPRINT4) & set(by[code]["permissions"]), code
    # прежние привилегированные флаги не изменились
    assert {c for c, r in by.items() if r["privileged"]} == {"super_admin", "operations", "billing", "agent_manager"}
    # principal (из него admin-bff строит actor) — с новыми правами
    p = (await env.principal(root.staff_id)).json()
    assert set(SPRINT4) <= set(p["permissions"])
    rows = await env.sql("SELECT role, permission FROM role_permissions WHERE permission = ANY(:p) ORDER BY 1, 2",
                         p=SPRINT4)
    assert sorted(rows) == sorted((r, p) for r in ("operations", "super_admin") for p in SPRINT4)


async def test_sources_manage_grant_makes_role_privileged(env: Env, root: Person, root2: Person) -> None:
    analyst = await env.onboard(root.actor, new_email("an4"), "analyst")
    sv = (await env.principal(analyst.staff_id)).json()["session_version"]
    # непривилегированные права спринта 4 — роль остаётся непривилегированной, сессии не отзываются
    upd = await env.c.put("/admin/v1/roles/analyst",
                          json={"permissions": ["dashboard.read", "users.read", "events.review", "discovery.manage"],
                                "reason": "Проверка событий"}, headers=env.h(root.actor))
    assert upd.status_code == 202
    assert (await env.approve(root2.actor, upd.json()["approval"]["approval_id"])).json()["status"] == "APPLIED"
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    assert roles["analyst"]["privileged"] is False
    assert (await env.principal(analyst.staff_id)).json()["session_version"] == sv
    # sources.manage делает роль привилегированной: сессии её сотрудников отзываются, вход — с подключением MFA
    upd = await env.c.put("/admin/v1/roles/analyst",
                          json={"permissions": ["dashboard.read", "users.read", "sources.manage"],
                                "reason": "Ведение источников"}, headers=env.h(root.actor))
    assert upd.status_code == 202
    assert (await env.approve(root2.actor, upd.json()["approval"]["approval_id"])).json()["status"] == "APPLIED"
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    assert roles["analyst"]["privileged"] is True
    p = (await env.principal(analyst.staff_id)).json()
    assert p["session_version"] == sv + 1 and "sources.manage" in p["permissions"]
    r = await env.login(analyst.email, analyst.password)
    assert r.status_code == 200 and r.json()["next"] == "mfa_enroll"
    # назначение теперь привилегированной роли — four-eyes (root2 есть → заявка, а не сразу)
    other = await env.onboard(root.actor, new_email("sp4"), "support")
    grant = await env.patch(root.actor, other.staff_id, {"role": "analyst", "reason": "Перевод"})
    assert grant.status_code == 202 and grant.json()["approval"]["kind"] == "staff.role_grant"


# ---------------------------------------------------------------- откат и повтор миграции 0005

async def _downgrade(settings, revision: str) -> None:
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = settings
    await asyncio.to_thread(command.downgrade, cfg, revision)


async def test_migration_0005_downgrade_and_reapply() -> None:
    schema = unique_schema("adminid4")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    conn = await asyncpg.connect(TEST_ADMIN_URL, server_settings={"search_path": schema})

    async def perms(role: str) -> list[str]:
        return sorted(r[0] for r in await conn.fetch("SELECT permission FROM role_permissions WHERE role = $1", role))

    async def privileged(role: str) -> bool:
        return await conn.fetchval("SELECT privileged FROM roles WHERE code = $1", role)

    try:
        await migrate(SERVICE_DIR, settings, "0004")
        assert await perms("operations") == sorted(OPERATIONS_BEFORE)
        # матрица, изменённая до спринта 4 (four-eyes): у operations нет audit.read — upgrade его не возвращает
        await conn.execute("DELETE FROM role_permissions WHERE role = 'operations' AND permission = 'audit.read'")
        ops_updated = await conn.fetchval("SELECT updated_at FROM roles WHERE code = 'operations'")
        support_updated = await conn.fetchval("SELECT updated_at FROM roles WHERE code = 'support'")

        await migrate(SERVICE_DIR, settings)
        expected_ops = sorted([*(p for p in OPERATIONS_BEFORE if p != "audit.read"), *SPRINT4, *SPRINT6, *SPRINT7,
                               *SPRINT8])
        assert await perms("operations") == expected_ops
        assert await perms("super_admin") == sorted(PERMISSIONS)
        assert await conn.fetchval("SELECT updated_at FROM roles WHERE code = 'operations'") > ops_updated
        assert await conn.fetchval("SELECT updated_at FROM roles WHERE code = 'support'") == support_updated
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE permission = ANY($1::text[])",
                                   SPRINT4) == 6

        # после спринта 4: analyst получил sources.manage (four-eyes), открыта заявка с discovery.manage
        await conn.execute("INSERT INTO role_permissions VALUES ('analyst', 'sources.manage')")
        await conn.execute("UPDATE roles SET privileged = true WHERE code = 'analyst'")
        author = uuid.uuid4()
        await conn.execute(
            "INSERT INTO staff (staff_id, email, display_name, role) "
            "VALUES ($1, 'a4@tilhero.test', 'A', 'super_admin')", author)
        pending = uuid.uuid4()
        await conn.execute(
            "INSERT INTO approvals (approval_id, kind, target, payload, summary, reason, requested_by, expires_at) "
            "VALUES ($1, 'role.permissions_change', 'role:auditor', $2::jsonb, '{}'::jsonb, 'r', $3, "
            "now() + interval '1 day')",
            pending, '{"role": "auditor", "before": ["audit.read", "dashboard.read"], '
                     '"permissions": ["dashboard.read", "audit.read", "discovery.manage"]}', author)

        await _downgrade(settings, "0004")
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE permission = ANY($1::text[])",
                                   SPRINT4) == 0
        assert await perms("operations") == sorted(p for p in OPERATIONS_BEFORE if p != "audit.read")
        assert await perms("analyst") == ["dashboard.read", "users.read"]
        assert await privileged("analyst") is False
        assert await privileged("operations") is True and await privileged("super_admin") is True
        assert await conn.fetchval("SELECT status FROM approvals WHERE approval_id = $1", pending) == "EXPIRED"
        assert await conn.fetchval("SELECT version_num FROM alembic_version") == "0004"

        # повтор upgrade — та же матрица, без дублей
        await migrate(SERVICE_DIR, settings)
        assert await perms("operations") == expected_ops
        assert await perms("super_admin") == sorted(PERMISSIONS)
        assert await perms("analyst") == ["dashboard.read", "users.read"]
    finally:
        await conn.close()
        await drop_schema(schema)
