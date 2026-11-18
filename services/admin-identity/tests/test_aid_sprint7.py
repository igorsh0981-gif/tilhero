"""Спринт 7: право users.access.manage — каталог, зеркало admin.ts, матрица после миграции 0007 (super_admin,
operations), непривилегированность, выдача через four-eyes без MFA, откат и повтор миграции; права AI-экранов
(skills.edit, skills.publish, ai.content.read, ops.kill_switch) — как были (docs/sprint7/INTERNAL_API.md §4, §6)."""

from __future__ import annotations

import asyncio
import re
import uuid
from pathlib import Path

import asyncpg
from aid_testkit import SERVICE_DIR, Env, Person, make_settings, new_email

from tilhero_admin_identity.domain.catalog import PERMISSIONS, PRIVILEGED_PERMISSIONS, privileged_by
from tilhero_common.testing import TEST_ADMIN_URL, create_schema, drop_schema, migrate, unique_schema

ACCESS = "users.access.manage"
ADMIN_TS = Path(SERVICE_DIR).parents[1] / "packages" / "contracts" / "src" / "admin.ts"
OPERATIONS_S6 = ["dashboard.read", "users.read", "support.read", "audit.read", "config.read", "ops.kill_switch",
                 "events.review", "sources.manage", "discovery.manage", "news.manage"]


def _ts_union(source: str, type_name: str) -> list[str]:
    m = re.search(rf"export type {type_name} =(.*?);", source, re.S)
    assert m, type_name
    return re.findall(r'"([^"]+)"', re.sub(r"//[^\n]*", "", m.group(1)))


# ---------------------------------------------------------------- каталог и зеркало admin.ts

def test_users_access_manage_in_catalog_and_admin_ts() -> None:
    src = ADMIN_TS.read_text(encoding="utf-8")
    ts = _ts_union(src, "Permission")
    assert ts == list(PERMISSIONS) and ts[-2] == ACCESS  # новое право — в конце (порядок выдачи в API); 0008 — после
    assert len(PERMISSIONS) == 25 and len(set(PERMISSIONS)) == 25
    # права AI-экранов спринта 7 — уже в каталоге (используются как есть)
    for p in ("dashboard.read", "users.read", "skills.edit", "skills.publish", "ai.content.read", "ops.kill_switch"):
        assert p in PERMISSIONS, p


def test_users_access_manage_is_not_privileged_but_content_read_is() -> None:
    assert ACCESS not in PRIVILEGED_PERMISSIONS
    assert privileged_by("analyst", ["dashboard.read", ACCESS]) is False
    assert privileged_by("support", ["dashboard.read", "users.read", "support.read", ACCESS]) is False
    # раскрытие AI-переписки (A43) и kill switch (A47) — привилегированные
    assert {"ai.content.read", "ops.kill_switch"} <= PRIVILEGED_PERMISSIONS
    assert privileged_by("analyst", ["dashboard.read", "ai.content.read"]) is True


# ---------------------------------------------------------------- матрица после миграции

async def test_matrix_after_migration_0007(env: Env, root: Person) -> None:
    roles = (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()
    assert roles["permissions"] == list(PERMISSIONS)
    by = {r["code"]: r for r in roles["items"]}
    assert by["super_admin"]["permissions"] == list(PERMISSIONS)
    assert by["operations"]["permissions"] == [*OPERATIONS_S6, ACCESS, "ops.queues.manage"]  # + 0008
    for code in ("support", "billing", "agent_manager", "analyst", "auditor", "read_only"):
        assert ACCESS not in by[code]["permissions"], code
    # матрица AI-экранов §6 — как была: skills.edit у agent_manager, skills.publish и ai.content.read — только
    # у super_admin, ops.kill_switch — у operations; dashboard.read (чтение экранов) — у всех ролей
    holders = {p: sorted(c for c, r in by.items() if p in r["permissions"])
               for p in ("skills.edit", "skills.publish", "ai.content.read", "ops.kill_switch", "dashboard.read")}
    assert holders == {
        "skills.edit": ["agent_manager", "super_admin"], "skills.publish": ["super_admin"],
        "ai.content.read": ["super_admin"], "ops.kill_switch": ["operations", "super_admin"],
        "dashboard.read": sorted(by),
    }
    # поддержка переписку не видит (TG-FR-044)
    assert "ai.content.read" not in by["support"]["permissions"]
    # привилегированность ролей не изменилась
    assert {c for c, r in by.items() if r["privileged"]} == {"super_admin", "operations", "billing", "agent_manager"}
    # principal (из него admin-bff строит actor для ai-control) — с новым правом
    p = (await env.principal(root.staff_id)).json()
    assert ACCESS in p["permissions"]
    rows = await env.sql("SELECT role FROM role_permissions WHERE permission = :p ORDER BY 1", p=ACCESS)
    assert rows == [("operations",), ("super_admin",)]


async def test_operations_staff_gets_users_access_manage(env: Env, root: Person) -> None:
    ops = await env.onboard(root.actor, new_email("ops7"), "operations")
    p = (await env.principal(ops.staff_id)).json()
    assert ACCESS in p["permissions"] and "ai.content.read" not in p["permissions"]
    for role in ("support", "agent_manager", "analyst"):
        person = await env.onboard(root.actor, new_email(f"{role[:3]}7"), role)
        assert ACCESS not in (await env.principal(person.staff_id)).json()["permissions"], role


async def test_grant_users_access_manage_keeps_role_unprivileged(env: Env, root: Person, root2: Person) -> None:
    """Выдача users.access.manage непривилегированной роли (support) — four-eyes, но без MFA и отзыва сессий."""
    sup = await env.onboard(root.actor, new_email("sup7"), "support")
    sv = (await env.principal(sup.staff_id)).json()["session_version"]
    perms = ["dashboard.read", "users.read", "support.read", "support.reply", ACCESS]
    upd = await env.c.put("/admin/v1/roles/support", json={"permissions": perms, "reason": "Уровни AI для поддержки"},
                          headers=env.h(root.actor))
    assert upd.status_code == 202 and upd.json()["approval"]["kind"] == "role.permissions_change"
    assert ACCESS not in (await env.principal(sup.staff_id)).json()["permissions"]  # до решения — нет
    assert (await env.approve(root2.actor, upd.json()["approval"]["approval_id"])).json()["status"] == "APPLIED"
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    assert roles["support"]["privileged"] is False and ACCESS in roles["support"]["permissions"]
    p = (await env.principal(sup.staff_id)).json()
    assert ACCESS in p["permissions"] and p["session_version"] == sv


async def test_permission_typo_rejected(env: Env, root: Person) -> None:
    for bad in ("users.access.write", "ai.content.view", "users.access"):
        body = {"permissions": ["dashboard.read", bad], "reason": "Опечатка"}
        r = await env.c.put("/admin/v1/roles/analyst", json=body, headers=env.h(root.actor))
        assert r.status_code == 422, bad


async def test_roles_api_requires_admin_bff_and_permission(env: Env, root: Person) -> None:
    """Матрицу читает только admin-bff с roles.manage; новые AI-сервисы — не вызывающие admin-identity."""
    for issuer in ("ai-control", "ai-concierge"):
        r = await env.c.get("/admin/v1/roles", headers=env.h(None, issuer=issuer))
        assert r.status_code in (401, 403), (issuer, r.text)
    assert (await env.c.get("/admin/v1/roles")).status_code == 401
    ops = await env.onboard(root.actor, new_email("ops7r"), "operations")
    r = await env.c.get("/admin/v1/roles", headers=env.h(ops.actor))
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"


# ---------------------------------------------------------------- откат и повтор миграции 0007

async def _downgrade(settings, revision: str) -> None:
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = settings
    await asyncio.to_thread(command.downgrade, cfg, revision)


async def test_migration_0007_downgrade_and_reapply() -> None:
    schema = unique_schema("adminid7")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    conn = await asyncpg.connect(TEST_ADMIN_URL, server_settings={"search_path": schema})

    async def perms(role: str) -> list[str]:
        return sorted(r[0] for r in await conn.fetch("SELECT permission FROM role_permissions WHERE role = $1", role))

    async def privileged() -> set[str]:
        return {r[0] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}

    try:
        await migrate(SERVICE_DIR, settings, "0006")
        assert await perms("operations") == sorted(OPERATIONS_S6)
        # матрица, изменённая до спринта 7 (four-eyes): у operations нет news.manage — upgrade его не возвращает
        await conn.execute("DELETE FROM role_permissions WHERE role = 'operations' AND permission = 'news.manage'")
        ops_updated = await conn.fetchval("SELECT updated_at FROM roles WHERE code = 'operations'")
        support_updated = await conn.fetchval("SELECT updated_at FROM roles WHERE code = 'support'")
        priv_before = await privileged()

        await migrate(SERVICE_DIR, settings)
        expected_ops = sorted([*(p for p in OPERATIONS_S6 if p != "news.manage"), ACCESS, "ops.queues.manage"])
        assert await perms("operations") == expected_ops
        assert await perms("super_admin") == sorted(PERMISSIONS)
        assert await conn.fetchval("SELECT updated_at FROM roles WHERE code = 'operations'") > ops_updated
        assert await conn.fetchval("SELECT updated_at FROM roles WHERE code = 'support'") == support_updated
        assert await conn.fetchval("SELECT updated_by FROM roles WHERE code = 'operations'") is None
        assert await privileged() == priv_before

        # после спринта 7: support получил users.access.manage (four-eyes), открыта заявка с ним для analyst
        await conn.execute("INSERT INTO role_permissions VALUES ('support', 'users.access.manage')")
        author = uuid.uuid4()
        await conn.execute(
            "INSERT INTO staff (staff_id, email, display_name, role) "
            "VALUES ($1, 'a7@tilhero.test', 'A', 'super_admin')", author)
        pending, other = uuid.uuid4(), uuid.uuid4()
        for aid, role, perms_json in ((pending, "analyst", '["dashboard.read", "users.access.manage"]'),
                                      (other, "auditor", '["dashboard.read"]')):
            await conn.execute(
                "INSERT INTO approvals (approval_id, kind, target, payload, summary, reason, requested_by, expires_at) "
                "VALUES ($1, 'role.permissions_change', $4, $2::jsonb, '{}'::jsonb, 'r', $3, "
                "now() + interval '1 day')",
                aid, f'{{"role": "{role}", "before": ["dashboard.read"], "permissions": {perms_json}}}', author,
                f"role:{role}")

        await _downgrade(settings, "0006")
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE permission = $1", ACCESS) == 0
        assert await perms("operations") == sorted(p for p in OPERATIONS_S6 if p != "news.manage")
        assert await perms("support") == ["dashboard.read", "support.read", "support.reply", "users.read"]
        assert await privileged() == priv_before
        assert await conn.fetchval("SELECT status FROM approvals WHERE approval_id = $1", pending) == "EXPIRED"
        assert await conn.fetchval("SELECT status FROM approvals WHERE approval_id = $1", other) == "PENDING"
        assert await conn.fetchval("SELECT version_num FROM alembic_version") == "0006"

        # повтор upgrade — та же матрица, без дублей
        await migrate(SERVICE_DIR, settings)
        await migrate(SERVICE_DIR, settings)
        assert await perms("operations") == expected_ops
        assert await perms("super_admin") == sorted(PERMISSIONS)
        assert await perms("support") == ["dashboard.read", "support.read", "support.reply", "users.read"]
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE permission = $1", ACCESS) == 2
    finally:
        await conn.close()
        await drop_schema(schema)
