"""Спринт 6: право news.manage — каталог, зеркало admin.ts, матрица после миграции 0006, непривилегированность,
выдача через four-eyes без MFA, откат и повтор миграции (docs/sprint6/INTERNAL_API.md §3.1, §8)."""

from __future__ import annotations

import asyncio
import re
import uuid
from pathlib import Path

import asyncpg
from aid_testkit import SERVICE_DIR, Env, Person, make_settings, new_email

from tilhero_admin_identity.domain.catalog import PERMISSIONS, PRIVILEGED_PERMISSIONS, privileged_by
from tilhero_common.testing import TEST_ADMIN_URL, create_schema, drop_schema, migrate, unique_schema

NEWS = "news.manage"
ADMIN_TS = Path(SERVICE_DIR).parents[1] / "packages" / "contracts" / "src" / "admin.ts"
OPERATIONS_S4 = ["dashboard.read", "users.read", "support.read", "audit.read", "config.read", "ops.kill_switch",
                 "events.review", "sources.manage", "discovery.manage"]


def _ts_union(source: str, type_name: str) -> list[str]:
    m = re.search(rf"export type {type_name} =(.*?);", source, re.S)
    assert m, type_name
    return re.findall(r'"([^"]+)"', re.sub(r"//[^\n]*", "", m.group(1)))


# ---------------------------------------------------------------- каталог и зеркало admin.ts

def test_news_manage_in_catalog_and_admin_ts() -> None:
    src = ADMIN_TS.read_text(encoding="utf-8")
    ts = _ts_union(src, "Permission")
    # новое право — в конце (порядок выдачи в API); права спринтов 7, 8 — после него
    assert ts == list(PERMISSIONS) and ts[-3] == NEWS
    assert len(PERMISSIONS) == 25 and len(set(PERMISSIONS)) == 25
    # раздел «Спринт 6» описывает типы, на которые опираются admin-bff и admin-web
    for name in ("NewsSource", "NewsSourceInput", "NewsAdminItem", "WatchStats", "Sprint6ErrorCode"):
        assert re.search(rf"export (interface|type) {name}\b", src), name


def test_news_manage_is_not_privileged() -> None:
    assert NEWS not in PRIVILEGED_PERMISSIONS
    assert privileged_by("analyst", ["dashboard.read", NEWS]) is False
    assert privileged_by("support", ["dashboard.read", "support.read", NEWS]) is False


# ---------------------------------------------------------------- матрица после миграции

async def test_matrix_after_migration_0006(env: Env, root: Person) -> None:
    roles = (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()
    assert roles["permissions"] == list(PERMISSIONS)
    by = {r["code"]: r for r in roles["items"]}
    assert by["super_admin"]["permissions"] == list(PERMISSIONS)
    # + 0007, 0008
    assert by["operations"]["permissions"] == [*OPERATIONS_S4, NEWS, "users.access.manage", "ops.queues.manage"]
    for code in ("support", "billing", "agent_manager", "analyst", "auditor", "read_only"):
        assert NEWS not in by[code]["permissions"], code
    # привилегированность ролей не изменилась
    assert {c for c, r in by.items() if r["privileged"]} == {"super_admin", "operations", "billing", "agent_manager"}
    # principal (из него admin-bff строит actor для news/watch) — с новым правом
    p = (await env.principal(root.staff_id)).json()
    assert NEWS in p["permissions"]
    rows = await env.sql("SELECT role FROM role_permissions WHERE permission = :p ORDER BY 1", p=NEWS)
    assert rows == [("operations",), ("super_admin",)]


async def test_operations_staff_gets_news_manage(env: Env, root: Person) -> None:
    ops = await env.onboard(root.actor, new_email("ops6"), "operations")
    p = (await env.principal(ops.staff_id)).json()
    assert NEWS in p["permissions"] and p["staff"]["role"] == "operations"
    sup = await env.onboard(root.actor, new_email("sup6"), "support")
    assert NEWS not in (await env.principal(sup.staff_id)).json()["permissions"]


async def test_grant_news_manage_keeps_role_unprivileged(env: Env, root: Person, root2: Person) -> None:
    """Выдача news.manage непривилегированной роли — через four-eyes, но без MFA и без отзыва сессий."""
    analyst = await env.onboard(root.actor, new_email("an6"), "analyst")
    sv = (await env.principal(analyst.staff_id)).json()["session_version"]
    upd = await env.c.put("/admin/v1/roles/analyst",
                          json={"permissions": ["dashboard.read", "users.read", NEWS], "reason": "Модерация новостей"},
                          headers=env.h(root.actor))
    assert upd.status_code == 202 and upd.json()["approval"]["kind"] == "role.permissions_change"
    assert NEWS not in (await env.principal(analyst.staff_id)).json()["permissions"]  # до решения — нет
    assert (await env.approve(root2.actor, upd.json()["approval"]["approval_id"])).json()["status"] == "APPLIED"
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    assert roles["analyst"]["privileged"] is False and NEWS in roles["analyst"]["permissions"]
    p = (await env.principal(analyst.staff_id)).json()
    assert NEWS in p["permissions"] and p["session_version"] == sv
    # назначение роли analyst по-прежнему без four-eyes (роль не стала привилегированной)
    other = await env.onboard(root.actor, new_email("sp6"), "support")
    grant = await env.patch(root.actor, other.staff_id, {"role": "analyst", "reason": "Перевод"})
    assert grant.status_code == 200 and grant.json()["role"] == "analyst"


async def test_unknown_permission_still_rejected(env: Env, root: Person) -> None:
    bad = await env.c.put("/admin/v1/roles/analyst",
                          json={"permissions": ["dashboard.read", "news.publish"], "reason": "Опечатка"},
                          headers=env.h(root.actor))
    assert bad.status_code == 422


# ---------------------------------------------------------------- откат и повтор миграции 0006

async def _downgrade(settings, revision: str) -> None:
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = settings
    await asyncio.to_thread(command.downgrade, cfg, revision)


async def test_migration_0006_downgrade_and_reapply() -> None:
    schema = unique_schema("adminid6")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    conn = await asyncpg.connect(TEST_ADMIN_URL, server_settings={"search_path": schema})

    async def perms(role: str) -> list[str]:
        return sorted(r[0] for r in await conn.fetch("SELECT permission FROM role_permissions WHERE role = $1", role))

    async def privileged() -> set[str]:
        return {r[0] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}

    try:
        await migrate(SERVICE_DIR, settings, "0005")
        assert await perms("operations") == sorted(OPERATIONS_S4)
        # матрица, изменённая до спринта 6 (four-eyes): у operations нет config.read — upgrade его не возвращает
        await conn.execute("DELETE FROM role_permissions WHERE role = 'operations' AND permission = 'config.read'")
        ops_updated = await conn.fetchval("SELECT updated_at FROM roles WHERE code = 'operations'")
        support_updated = await conn.fetchval("SELECT updated_at FROM roles WHERE code = 'support'")
        priv_before = await privileged()

        await migrate(SERVICE_DIR, settings)
        expected_ops = sorted([*(p for p in OPERATIONS_S4 if p != "config.read"), NEWS, "users.access.manage",
                               "ops.queues.manage"])
        assert await perms("operations") == expected_ops
        assert await perms("super_admin") == sorted(PERMISSIONS)
        assert await conn.fetchval("SELECT updated_at FROM roles WHERE code = 'operations'") > ops_updated
        assert await conn.fetchval("SELECT updated_at FROM roles WHERE code = 'support'") == support_updated
        assert await conn.fetchval("SELECT updated_by FROM roles WHERE code = 'operations'") is None
        assert await privileged() == priv_before

        # после спринта 6: auditor получил news.manage (four-eyes), открыта заявка с news.manage для analyst
        await conn.execute("INSERT INTO role_permissions VALUES ('auditor', 'news.manage')")
        author = uuid.uuid4()
        await conn.execute(
            "INSERT INTO staff (staff_id, email, display_name, role) "
            "VALUES ($1, 'a6@tilhero.test', 'A', 'super_admin')", author)
        pending, other = uuid.uuid4(), uuid.uuid4()
        for aid, role, perms_json in ((pending, "analyst", '["dashboard.read", "news.manage"]'),
                                      (other, "support", '["dashboard.read"]')):
            await conn.execute(
                "INSERT INTO approvals (approval_id, kind, target, payload, summary, reason, requested_by, expires_at) "
                "VALUES ($1, 'role.permissions_change', $4, $2::jsonb, '{}'::jsonb, 'r', $3, "
                "now() + interval '1 day')",
                aid, f'{{"role": "{role}", "before": ["dashboard.read"], "permissions": {perms_json}}}', author,
                f"role:{role}")

        await _downgrade(settings, "0005")
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE permission = $1", NEWS) == 0
        assert await perms("operations") == sorted(p for p in OPERATIONS_S4 if p != "config.read")
        assert await perms("auditor") == ["audit.read", "dashboard.read"]
        assert await privileged() == priv_before
        assert await conn.fetchval("SELECT status FROM approvals WHERE approval_id = $1", pending) == "EXPIRED"
        assert await conn.fetchval("SELECT status FROM approvals WHERE approval_id = $1", other) == "PENDING"
        assert await conn.fetchval("SELECT version_num FROM alembic_version") == "0005"

        # повтор upgrade — та же матрица, без дублей
        await migrate(SERVICE_DIR, settings)
        await migrate(SERVICE_DIR, settings)
        assert await perms("operations") == expected_ops
        assert await perms("super_admin") == sorted(PERMISSIONS)
        assert await perms("auditor") == ["audit.read", "dashboard.read"]
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE permission = $1", NEWS) == 2
    finally:
        await conn.close()
        await drop_schema(schema)
