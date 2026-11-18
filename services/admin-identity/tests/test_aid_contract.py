"""Контрактный тест матрицы TilHero: сид миграции 0001 и каталог = packages/contracts/src/admin.ts
(`PERMISSIONS`, `RoleCode`, `PRIVILEGED_ROLES`) и таблица docs/sprint2/PLAN.md §«Роли и права»;
формы ответов Staff API = интерфейсы admin.ts (Staff, Role, Approval). admin.ts и PLAN.md разбираются регулярками."""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from types import ModuleType

from aid_testkit import SERVICE_DIR, Env, Person, new_email

from tilhero_admin_identity.domain.catalog import (
    PERMISSIONS,
    PRIVILEGED_PERMISSIONS,
    PRIVILEGED_ROLES,
    ROLE_CODES,
    privileged_by,
)

ROOT = Path(SERVICE_DIR).parents[1]
ADMIN_TS = ROOT / "packages" / "contracts" / "src" / "admin.ts"
PLAN_MD = ROOT / "docs" / "sprint2" / "PLAN.md"
MIGRATION = Path(SERVICE_DIR) / "migrations" / "versions" / "0001_initial.py"
EXCLUSIVE = {"users.sensitive.read", "staff.manage", "roles.manage"}  # PLAN: только super_admin


# ---------------------------------------------------------------- разбор admin.ts и PLAN.md

def _ts_source() -> str:
    src = ADMIN_TS.read_text(encoding="utf-8")
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"(?<!:)//[^\n]*", "", src)  # строчные комментарии; «https://» в строках не трогаем


def _ts_union(src: str, name: str) -> list[str]:
    m = re.search(rf"export type {name} =(.*?);", src, re.S)
    assert m, name
    return re.findall(r'"([^"]+)"', m.group(1))


def _ts_const_list(src: str, name: str) -> list[str]:
    m = re.search(rf"export const {name}\b[^=]*=\s*\[(.*?)\]", src, re.S)
    assert m, name
    return re.findall(r'"([^"]+)"', m.group(1))


def _ts_fields(src: str, name: str) -> set[str]:
    m = re.search(rf"export interface {name}\b(?:\s+extends\s+(\w+))?\s*\{{(.*?)\n\}}", src, re.S)
    assert m, name
    fields = set(re.findall(r"^\s*([a-z_]+)\??:", m.group(2), re.M))
    return fields | (_ts_fields(src, m.group(1)) if m.group(1) else set())


def _plan_matrix() -> tuple[dict[str, list[str]], dict[str, bool]]:
    """{роль: права}, {роль: MFA обязательна} из таблицы PLAN.md §«Роли и права»."""
    text = PLAN_MD.read_text(encoding="utf-8")
    section = text.split("## Роли и права", 1)[1].split("\n## ", 1)[0]
    matrix: dict[str, list[str]] = {}
    mfa: dict[str, bool] = {}
    for line in section.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) != 3 or cells[0] not in ROLE_CODES:
            continue
        role, perms, factor = cells
        matrix[role] = list(PERMISSIONS) if perms == "все" else re.findall(r"\b[a-z]+(?:\.[a-z]+)+\b", perms)
        mfa[role] = factor == "обязательна"
    return matrix, mfa


def _migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("aid_migration_0001", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _sorted(perms: list[str]) -> list[str]:
    return sorted(perms, key=list(PERMISSIONS).index)


# ---------------------------------------------------------------- каталог и сид

def test_catalog_mirrors_admin_ts() -> None:
    src = _ts_source()
    assert list(PERMISSIONS) == _ts_union(src, "Permission") == _ts_const_list(src, "PERMISSIONS")
    assert len(PERMISSIONS) == 17
    assert list(ROLE_CODES) == _ts_union(src, "RoleCode")
    assert set(PRIVILEGED_ROLES) == set(_ts_const_list(src, "PRIVILEGED_ROLES"))
    for gone in ("billing.refund", "ai.content.read", "ops.kill_switch", "sources.manage", "users.access.manage",
                 "ops.queues.manage", "export.csv", "skills.edit", "news.manage", "events.review"):
        assert gone not in PERMISSIONS, gone
    assert not {"billing", "agent_manager"} & set(ROLE_CODES)


def test_approval_kinds_equal_admin_ts() -> None:
    from typing import get_args

    from tilhero_admin_identity.models import Approval
    from tilhero_admin_identity.schemas import ApprovalKind

    kinds = _ts_union(_ts_source(), "ApprovalKind")
    assert list(get_args(ApprovalKind)) == kinds
    check = next(c for c in Approval.__table__.constraints if c.name == "ck_approval_kind")
    assert set(re.findall(r"'([^']+)'", str(check.sqltext))) == set(kinds)  # type: ignore[attr-defined]
    m2 = importlib.util.spec_from_file_location("aid_migration_0002",
                                                MIGRATION.parent / "0002_reactivate_privileged.py")
    assert m2 is not None and m2.loader is not None
    mod = importlib.util.module_from_spec(m2)
    m2.loader.exec_module(mod)
    assert set(re.findall(r"'([^']+)'", mod._KINDS_NEW)) == set(kinds)


def test_migration_seed_equals_contract() -> None:
    src, m = _ts_source(), _migration()
    seeded = {p for _, _, _, perms in m.ROLES for p in perms}
    assert seeded == set(_ts_const_list(src, "PERMISSIONS"))  # множество прав сида = PERMISSIONS
    assert m.ALL_PERMISSIONS == _ts_const_list(src, "PERMISSIONS")
    assert [code for code, *_ in m.ROLES] == _ts_union(src, "RoleCode")
    assert set(m.PRIVILEGED_ROLES) == set(_ts_const_list(src, "PRIVILEGED_ROLES"))
    assert set(m.PRIVILEGED_PERMISSIONS) == PRIVILEGED_PERMISSIONS
    for code, ru, en, perms in m.ROLES:
        assert len(perms) == len(set(perms)) and ru.strip() and en.strip(), code
    assert {code for code, *_, perms in m.ROLES if m._privileged(code, perms)} == set(PRIVILEGED_ROLES)


def test_migration_seed_equals_plan_matrix() -> None:
    matrix, mfa = _plan_matrix()
    assert list(matrix) == list(ROLE_CODES)  # в PLAN описаны все роли
    seeded = {code: perms for code, _, _, perms in _migration().ROLES}
    assert {c: sorted(p) for c, p in seeded.items()} == {c: sorted(p) for c, p in matrix.items()}
    assert {c for c, required in mfa.items() if required} == set(PRIVILEGED_ROLES)
    for perm in EXCLUSIVE:
        assert [c for c, p in seeded.items() if perm in p] == ["super_admin"], perm


def test_privileged_permissions_are_step_up_rights() -> None:
    """Права, чьи команды требуют step-up (PLAN §«Роли и права»), делают роль привилегированной: без MFA
    повторный TOTP невозможен. Чтение и черновики — нет."""
    assert PRIVILEGED_PERMISSIONS == {"users.sensitive.read", "staff.manage", "roles.manage", "config.publish",
                                      "whatsnew.publish", "notif.templates.manage", "notif.campaigns.send"}
    for perm in PRIVILEGED_PERMISSIONS:
        assert privileged_by("read_only", ["dashboard.read", perm]) is True, perm
    for perm in set(PERMISSIONS) - PRIVILEGED_PERMISSIONS:
        assert privileged_by("analyst", [perm]) is False, perm
    for code in PRIVILEGED_ROLES:
        assert privileged_by(code, []) is True
    matrix, _ = _plan_matrix()
    for code, perms in matrix.items():  # матрица по умолчанию: привилегированы ровно PRIVILEGED_ROLES
        assert privileged_by(code, perms) is (code in PRIVILEGED_ROLES), code


# ---------------------------------------------------------------- БД после миграции и API

async def test_seeded_db_and_roles_api_equal_contract(env: Env, root: Person) -> None:
    src = _ts_source()
    matrix, _ = _plan_matrix()
    rows = await env.sql("SELECT role, permission FROM role_permissions")
    assert {p for _, p in rows} == set(_ts_const_list(src, "PERMISSIONS"))
    db: dict[str, list[str]] = {}
    for role, perm in rows:
        db.setdefault(role, []).append(perm)
    assert {c: sorted(p) for c, p in db.items()} == {c: sorted(p) for c, p in matrix.items()}
    roles = await env.sql("SELECT code, name_ru, name_en, privileged FROM roles")
    assert {r[0] for r in roles} == set(_ts_union(src, "RoleCode"))
    assert {r[0] for r in roles if r[3]} == set(_ts_const_list(src, "PRIVILEGED_ROLES"))
    assert len({r[1] for r in roles}) == len({r[2] for r in roles}) == len(roles) == 8
    api = (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()
    assert api["permissions"] == _ts_const_list(src, "PERMISSIONS")
    assert [r["code"] for r in api["items"]] == _ts_union(src, "RoleCode")
    for r in api["items"]:
        assert set(r) == _ts_fields(src, "Role"), r["code"]
        assert r["permissions"] == _sorted(matrix[r["code"]]), r["code"]
        assert r["privileged"] is (r["code"] in PRIVILEGED_ROLES)
    names = {r["code"]: r["name"] for r in api["items"]}
    assert names["communications"] == {"ru": "Коммуникации", "en": "Communications"}
    assert names["super_admin"] == {"ru": "Суперадминистратор", "en": "Super Admin"}


async def test_mfa_required_exactly_for_privileged_roles(env: Env, root: Person) -> None:
    """Вход сотрудника каждой роли (root — единственный super_admin, four-eyes waived): привилегированным —
    обязательное подключение TOTP, остальным — вход без MFA; права principal = матрица PLAN."""
    matrix, mfa = _plan_matrix()
    for code in (*ROLE_CODES[1:], ROLE_CODES[0]):  # второй super_admin — последним: дальше уже нужен второй голос
        person = await env.onboard(root.actor, new_email(code.replace("_", "")), code)
        assert person.principal["staff"]["role"] == code
        assert (person.secret is not None) is mfa[code], code
        assert person.principal["mfa_enabled"] is mfa[code], code
        assert person.principal["permissions"] == _sorted(matrix[code]), code


async def test_staff_api_shapes_equal_admin_ts(env: Env, root: Person) -> None:
    src = _ts_source()
    created = await env.create_staff(root.actor, new_email("shape"), "support")
    body = created.json()
    assert set(body) == _ts_fields(src, "StaffCreated")
    staff_fields = _ts_fields(src, "Staff")
    assert "auth_provider" not in staff_fields and set(body["staff"]) == staff_fields
    one = await env.c.get(f"/admin/v1/staff/{body['staff']['staff_id']}", headers=env.h(root.actor))
    assert set(one.json()) == staff_fields
    for item in (await env.c.get("/admin/v1/staff", headers=env.h(root.actor))).json()["items"]:
        assert set(item) == staff_fields
    look = await env.c.get(f"/admin/v1/staff/lookup?ids={root.staff_id}", headers=env.h(root.actor))
    assert set(look.json()["items"][0]) == _ts_fields(src, "StaffSummary")
    priv = await env.create_staff(root.actor, new_email("priv"), "communications")
    approval = priv.json()["approval"]
    assert set(approval) == _ts_fields(src, "Approval")
    assert set(approval["requested_by"]) == _ts_fields(src, "StaffSummary")
    assert set(_ts_union(src, "ApprovalKind")) >= {approval["kind"]}
    assert set(root.principal) >= {"staff", "permissions", "mfa_enabled", "must_change_password"}
