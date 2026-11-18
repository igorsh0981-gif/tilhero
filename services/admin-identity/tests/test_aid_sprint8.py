"""Спринт 8: право ops.queues.manage (DLQ — просмотр маскированного payload, повтор и удаление) — каталог, зеркало
admin.ts, матрица после миграции 0008 (super_admin, operations), привилегированность (MFA, four-eyes), откат и повтор
миграции поверх изменённой матрицы (docs/sprint8/INTERNAL_API.md §7.6)."""

from __future__ import annotations

import re
import uuid
from pathlib import Path

import asyncpg
from aid_testkit import SERVICE_DIR, Env, Person, make_settings, new_email
from test_aid_sprint7 import _downgrade

from tilhero_admin_identity.domain.catalog import PERMISSIONS, PRIVILEGED_PERMISSIONS, privileged_by
from tilhero_common.testing import TEST_ADMIN_URL, create_schema, drop_schema, migrate, unique_schema

QUEUES = "ops.queues.manage"
ADMIN_TS = Path(SERVICE_DIR).parents[1] / "packages" / "contracts" / "src" / "admin.ts"


def _ts_union(source: str, type_name: str) -> list[str]:
    m = re.search(rf"export type {type_name} =(.*?);", source, re.S)
    assert m, type_name
    return re.findall(r'"([^"]+)"', re.sub(r"//[^\n]*", "", m.group(1)))


def test_ops_queues_manage_in_catalog_and_admin_ts() -> None:
    ts = _ts_union(ADMIN_TS.read_text(encoding="utf-8"), "Permission")
    assert ts == list(PERMISSIONS) and ts[-1] == QUEUES
    assert len(PERMISSIONS) == 25 and len(set(PERMISSIONS)) == 25


def test_ops_queues_manage_is_privileged() -> None:
    assert QUEUES in PRIVILEGED_PERMISSIONS
    assert privileged_by("analyst", ["dashboard.read", QUEUES]) is True
    assert privileged_by("analyst", ["dashboard.read"]) is False


async def test_matrix_after_migration_0008(env: Env, root: Person) -> None:
    roles = (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()
    by = {r["code"]: r for r in roles["items"]}
    assert QUEUES in by["super_admin"]["permissions"] and by["operations"]["permissions"][-1] == QUEUES
    for code in ("support", "billing", "agent_manager", "analyst", "auditor", "read_only"):
        assert QUEUES not in by[code]["permissions"], code
    assert {c for c, r in by.items() if r["privileged"]} == {"super_admin", "operations", "billing", "agent_manager"}
    ops = await env.onboard(root.actor, new_email("ops8"), "operations")
    assert QUEUES in (await env.principal(ops.staff_id)).json()["permissions"]


async def test_grant_ops_queues_manage_makes_role_privileged(env: Env, root: Person, root2: Person) -> None:
    """Выдача ops.queues.manage непривилегированной роли — four-eyes; роль становится привилегированной."""
    perms = ["dashboard.read", QUEUES]
    upd = await env.c.put("/admin/v1/roles/analyst", json={"permissions": perms, "reason": "Дежурство по очередям"},
                          headers=env.h(root.actor))
    assert upd.status_code == 202 and upd.json()["approval"]["kind"] == "role.permissions_change"
    assert (await env.approve(root2.actor, upd.json()["approval"]["approval_id"])).json()["status"] == "APPLIED"
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    assert roles["analyst"]["privileged"] is True and QUEUES in roles["analyst"]["permissions"]


async def test_migration_0008_over_changed_matrix_downgrade_and_reapply() -> None:
    schema = unique_schema("adminid8")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    conn = await asyncpg.connect(TEST_ADMIN_URL, server_settings={"search_path": schema})

    async def perms(role: str) -> list[str]:
        return sorted(r[0] for r in await conn.fetch("SELECT permission FROM role_permissions WHERE role = $1", role))

    async def privileged() -> set[str]:
        return {r[0] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}

    try:
        await migrate(SERVICE_DIR, settings, "0007")
        ops7 = await perms("operations")
        assert QUEUES not in ops7
        priv_before = await privileged()
        support_updated = await conn.fetchval("SELECT updated_at FROM roles WHERE code = 'support'")
        sessions = await conn.fetchval("SELECT count(*) FROM staff")

        await migrate(SERVICE_DIR, settings)
        assert await perms("operations") == sorted([*ops7, QUEUES])
        assert await perms("super_admin") == sorted(PERMISSIONS)
        assert await privileged() == priv_before  # super_admin и operations привилегированы и так
        assert await conn.fetchval("SELECT updated_at FROM roles WHERE code = 'support'") == support_updated
        assert await conn.fetchval("SELECT count(*) FROM staff") == sessions

        # после спринта 8: auditor получил ops.queues.manage (four-eyes) — стал привилегированным; открыта заявка
        await conn.execute("INSERT INTO role_permissions VALUES ('auditor', $1)", QUEUES)
        await conn.execute("UPDATE roles SET privileged = true WHERE code = 'auditor'")
        author = uuid.uuid4()
        await conn.execute("INSERT INTO staff (staff_id, email, display_name, role) "
                           "VALUES ($1, 'a8@tilhero.test', 'A', 'super_admin')", author)
        pending = uuid.uuid4()
        await conn.execute(
            "INSERT INTO approvals (approval_id, kind, target, payload, summary, reason, requested_by, expires_at) "
            "VALUES ($1, 'role.permissions_change', 'role:read_only', $2::jsonb, '{}'::jsonb, 'r', $3, "
            "now() + interval '1 day')",
            pending, f'{{"role": "read_only", "before": ["dashboard.read"], '
                     f'"permissions": ["dashboard.read", "{QUEUES}"]}}', author)

        await _downgrade(settings, "0007")
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE permission = $1", QUEUES) == 0
        assert await perms("operations") == ops7
        assert "auditor" not in await privileged()  # привилегированность пересчитана
        assert await conn.fetchval("SELECT status FROM approvals WHERE approval_id = $1", pending) == "EXPIRED"
        assert await conn.fetchval("SELECT version_num FROM alembic_version") == "0007"

        await migrate(SERVICE_DIR, settings)
        await migrate(SERVICE_DIR, settings)
        assert await perms("operations") == sorted([*ops7, QUEUES])
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE permission = $1", QUEUES) == 2
    finally:
        await conn.close()
        await drop_schema(schema)
