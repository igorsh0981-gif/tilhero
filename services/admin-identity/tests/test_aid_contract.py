"""Контрактный тест матрицы TilHero: сид миграций 0001 + 0003 + 0004 и каталог = packages/contracts/src/admin.ts
(`PERMISSIONS`, `RoleCode`, `PRIVILEGED_ROLES`), таблица docs/sprint2/PLAN.md §«Роли и права» и дополнения
docs/sprint3/PLAN.md §«Права и роли» (права контента, роль content_manager) и docs/sprint4/PLAN.md §«Права и роли»
(права ИИ, контроля диалогов и затрат, роль qa_analyst); формы ответов Staff API = интерфейсы admin.ts (Staff, Role,
Approval). admin.ts и PLAN.md спринтов 2–4 разбираются регулярками."""

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
PLAN3_MD = ROOT / "docs" / "sprint3" / "PLAN.md"
PLAN4_MD = ROOT / "docs" / "sprint4" / "PLAN.md"
MIGRATION = Path(SERVICE_DIR) / "migrations" / "versions" / "0001_initial.py"
MIGRATION3 = Path(SERVICE_DIR) / "migrations" / "versions" / "0003_content_permissions.py"
MIGRATION4 = Path(SERVICE_DIR) / "migrations" / "versions" / "0004_ai_qa_permissions.py"
EXCLUSIVE = {"users.sensitive.read", "staff.manage", "roles.manage"}  # PLAN: только super_admin
SPRINT3_PERMISSIONS = ["content.read", "content.edit", "content.review", "content.publish", "media.rights",
                       "lang.manage"]
STEP_UP_SPRINT3 = {"content.publish", "media.rights", "lang.manage"}  # PLAN спринта 3: step-up
SPRINT4_PERMISSIONS = ["ai.read", "ai.manage", "ai.publish", "qa.read", "qa.transcripts", "qa.review", "costs.read",
                       "costs.manage"]
STEP_UP_SPRINT4 = {"ai.publish", "qa.review", "costs.manage"}  # PLAN спринта 4: step-up
# привилегированные роли матрицы по умолчанию: PRIVILEGED_ROLES + права со step-up (methodist — content.publish,
# ai.publish, qa.review; content_manager — media.rights); qa_analyst — только чтение и реплики с причиной
PRIVILEGED_BY_RIGHTS = {"methodist", "content_manager"}


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


_PERM_RE = r"\b[a-z]+(?:\.[a-z]+)+\b"


def _plan2_matrix() -> tuple[dict[str, list[str]], dict[str, bool]]:
    """{роль: права}, {роль: MFA обязательна} из таблицы docs/sprint2/PLAN.md §«Роли и права»."""
    text = PLAN_MD.read_text(encoding="utf-8")
    section = text.split("## Роли и права", 1)[1].split("\n## ", 1)[0]
    matrix: dict[str, list[str]] = {}
    mfa: dict[str, bool] = {}
    for line in section.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) != 3 or cells[0] not in ROLE_CODES:
            continue
        role, perms, factor = cells
        matrix[role] = ["*"] if perms == "все" else re.findall(_PERM_RE, perms)
        mfa[role] = factor == "обязательна"
    return matrix, mfa


def _plan_section(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    return text.split("## Права и роли", 1)[1].split("\n## ", 1)[0]


def _plan_additions(path: Path) -> tuple[list[str], dict[str, list[str]], set[str]]:
    """(новые права, {роль: добавленные права}, права со step-up) из §«Права и роли» PLAN спринта 3 или 4."""
    section = _plan_section(path)
    new_perms = re.findall(r"`([a-z]+\.[a-z.]+)`", section.split("Новые права:", 1)[1].split(". Новая роль", 1)[0])
    step_up = {p for p in new_perms if re.search(rf"`{re.escape(p)}` \([^)]*step-up", section)}
    adds: dict[str, list[str]] = {}
    m = re.search(r"Новая роль `([a-z_]+)` \([^)]*\):(.*?)\.(?=\s|$)", section)
    assert m, f"{path}: новая роль"
    adds[m.group(1)] = re.findall(_PERM_RE, m.group(2))
    for roles, perms in re.findall(r"((?:`[a-z_]+`(?:, )?)+): \+(.*?)\.(?=\s|$)", section):
        for role in re.findall(r"`([a-z_]+)`", roles):
            adds.setdefault(role, []).extend(re.findall(_PERM_RE, perms))
    assert "super_admin — все" in section
    return new_perms, adds, step_up


def _plan3_additions() -> tuple[list[str], dict[str, list[str]], set[str]]:
    return _plan_additions(PLAN3_MD)


def _plan4_additions() -> tuple[list[str], dict[str, list[str]], set[str]]:
    return _plan_additions(PLAN4_MD)


def _plan_matrix() -> tuple[dict[str, list[str]], dict[str, bool]]:
    """Действующая матрица по умолчанию: спринт 2 + спринт 3 + спринт 4. {роль: права}, {роль: MFA обязательна}.
    MFA обязательна для PRIVILEGED_ROLES (таблица спринта 2) и для ролей с правами со step-up (правило спринта 2;
    PLAN спринта 3: «роли с content.publish / media.rights / lang.manage — привилегированные»; PLAN спринта 4: «роли с
    ai.publish / qa.review / costs.manage — привилегированные»)."""
    matrix2, mfa2 = _plan2_matrix()
    _, adds3, _ = _plan3_additions()
    _, adds4, _ = _plan4_additions()
    matrix: dict[str, list[str]] = {}
    for role in ROLE_CODES:
        base = matrix2.get(role, [])
        perms = list(PERMISSIONS) if base == ["*"] else [*base, *adds3.get(role, []), *adds4.get(role, [])]
        matrix[role] = list(dict.fromkeys(perms))
    mfa = {role: mfa2.get(role, False) or privileged_by(role, perms) for role, perms in matrix.items()}
    return matrix, mfa


def _load(path: Path, name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _migration() -> ModuleType:
    return _load(MIGRATION, "aid_migration_0001")


def _migration3() -> ModuleType:
    return _load(MIGRATION3, "aid_migration_0003")


def _migration4() -> ModuleType:
    return _load(MIGRATION4, "aid_migration_0004")


def _seeded_matrix() -> dict[str, list[str]]:
    """Матрица после цепочки миграций: сид 0001 + новые роли и права 0003 и 0004."""
    m1 = _migration()
    seeded = {code: list(perms) for code, _, _, perms in m1.ROLES}
    for m in (_migration3(), _migration4()):
        for code, _, _ in m.NEW_ROLES:
            seeded.setdefault(code, [])
        for code, perms in m.GRANTS.items():
            seeded[code] = list(dict.fromkeys([*seeded[code], *perms]))
    return seeded


def _seeded_roles() -> list[str]:
    """Порядок ролей каталога: 0001 + новые роли 0003 и 0004 на своих местах в RoleCode."""
    m1, m3, m4 = _migration(), _migration3(), _migration4()
    codes = [code for code, *_ in m1.ROLES] + [code for code, *_ in m3.NEW_ROLES] + [c for c, *_ in m4.NEW_ROLES]
    return sorted(codes, key=list(ROLE_CODES).index)


def _sorted(perms: list[str]) -> list[str]:
    return sorted(perms, key=list(PERMISSIONS).index)


# ---------------------------------------------------------------- каталог и сид

def _expected_privileged() -> set[str]:
    """Привилегированные роли матрицы по умолчанию: admin.ts PRIVILEGED_ROLES + роли с правами со step-up."""
    matrix, _ = _plan_matrix()
    return {code for code, perms in matrix.items() if privileged_by(code, perms)}


def test_catalog_mirrors_admin_ts() -> None:
    src = _ts_source()
    assert list(PERMISSIONS) == _ts_union(src, "Permission") == _ts_const_list(src, "PERMISSIONS")
    assert len(PERMISSIONS) == 31
    assert list(PERMISSIONS)[-14:-8] == SPRINT3_PERMISSIONS
    assert list(PERMISSIONS)[-8:] == SPRINT4_PERMISSIONS
    assert list(ROLE_CODES) == _ts_union(src, "RoleCode")
    assert {"content_manager", "qa_analyst"} <= set(ROLE_CODES) and len(ROLE_CODES) == 10
    assert set(PRIVILEGED_ROLES) == set(_ts_const_list(src, "PRIVILEGED_ROLES"))
    for gone in ("billing.refund", "ai.content.read", "ops.kill_switch", "sources.manage", "users.access.manage",
                 "ops.queues.manage", "export.csv", "skills.edit", "news.manage", "events.review"):
        assert gone not in PERMISSIONS, gone
    assert not {"billing", "agent_manager"} & set(ROLE_CODES)


def test_plan3_parsed() -> None:
    """Разбор дополнения PLAN спринта 3 — не пустой и совпадает с ожидаемым (страховка регулярок)."""
    new_perms, adds, step_up = _plan3_additions()
    assert new_perms == SPRINT3_PERMISSIONS
    assert step_up == STEP_UP_SPRINT3
    assert {r: sorted(p) for r, p in adds.items()} == {
        "content_manager": sorted(["content.read", "content.edit", "media.rights", "dashboard.read"]),
        "methodist": sorted(["content.read", "content.edit", "content.review", "content.publish"]),
        "operations": ["content.read"], "analyst": ["content.read"], "auditor": ["content.read"],
    }


def test_plan4_parsed() -> None:
    """Разбор дополнения PLAN спринта 4 — не пустой и совпадает с ожидаемым (страховка регулярок)."""
    new_perms, adds, step_up = _plan4_additions()
    assert new_perms == SPRINT4_PERMISSIONS
    assert step_up == STEP_UP_SPRINT4
    assert {r: sorted(p) for r, p in adds.items()} == {
        "qa_analyst": sorted(["dashboard.read", "content.read", "ai.read", "qa.read", "qa.transcripts"]),
        "methodist": sorted(["ai.read", "ai.manage", "ai.publish", "qa.read", "qa.transcripts", "qa.review"]),
        "operations": sorted(["ai.read", "qa.read", "costs.read", "costs.manage"]),
        "analyst": sorted(["ai.read", "qa.read", "costs.read"]),
        "auditor": sorted(["ai.read", "qa.read", "costs.read"]),
    }
    assert "`qa_analyst` (QA-аналитик)" in _plan_section(PLAN4_MD)


def test_approval_kinds_equal_admin_ts() -> None:
    from typing import get_args

    from tilhero_admin_identity.models import Approval
    from tilhero_admin_identity.schemas import ApprovalKind

    kinds = _ts_union(_ts_source(), "ApprovalKind")
    assert list(get_args(ApprovalKind)) == kinds
    check = next(c for c in Approval.__table__.constraints if c.name == "ck_approval_kind")
    assert set(re.findall(r"'([^']+)'", str(check.sqltext))) == set(kinds)  # type: ignore[attr-defined]
    mod = _load(MIGRATION.parent / "0002_reactivate_privileged.py", "aid_migration_0002")
    assert set(re.findall(r"'([^']+)'", mod._KINDS_NEW)) == set(kinds)


def test_migration_seed_equals_contract() -> None:
    src, m1, m3, m4 = _ts_source(), _migration(), _migration3(), _migration4()
    seeded = _seeded_matrix()
    assert {p for perms in seeded.values() for p in perms} == set(_ts_const_list(src, "PERMISSIONS"))
    # 0001 зафиксирован как каталог спринта 2, 0003 и 0004 добавляют ровно права спринтов 3 и 4
    assert m1.ALL_PERMISSIONS + m3.NEW_PERMISSIONS + m4.NEW_PERMISSIONS == _ts_const_list(src, "PERMISSIONS")
    assert m3.NEW_PERMISSIONS == SPRINT3_PERMISSIONS
    assert m4.NEW_PERMISSIONS == SPRINT4_PERMISSIONS
    assert sorted(m3.GRANTS["super_admin"]) == sorted(SPRINT3_PERMISSIONS)
    assert sorted(m4.GRANTS["super_admin"]) == sorted(SPRINT4_PERMISSIONS)
    assert _seeded_roles() == _ts_union(src, "RoleCode")
    assert (set(m1.PRIVILEGED_ROLES) == set(m3.PRIVILEGED_ROLES) == set(m4.PRIVILEGED_ROLES)
            == set(_ts_const_list(src, "PRIVILEGED_ROLES")))
    assert set(m1.PRIVILEGED_PERMISSIONS) == set(m3.PRIVILEGED_PERMISSIONS_V2)
    assert set(m3.PRIVILEGED_PERMISSIONS) == set(m4.PRIVILEGED_PERMISSIONS_V3)
    assert set(m4.PRIVILEGED_PERMISSIONS) == PRIVILEGED_PERMISSIONS
    assert set(m4.PRIVILEGED_PERMISSIONS) - set(m3.PRIVILEGED_PERMISSIONS) == STEP_UP_SPRINT4
    for code, ru, en, perms in m1.ROLES:
        assert len(perms) == len(set(perms)) and ru.strip() and en.strip(), code
    assert m3.NEW_ROLES == [("content_manager", "Контент-менеджер", "Content manager")]
    assert m4.NEW_ROLES == [("qa_analyst", "QA-аналитик", "QA analyst")]
    for m in (m3, m4):
        for code, perms in m.GRANTS.items():
            assert len(perms) == len(set(perms)), code
    privileged = {code for code, perms in seeded.items() if code in m4.PRIVILEGED_ROLES
                  or set(perms) & set(m4.PRIVILEGED_PERMISSIONS)}
    assert privileged == _expected_privileged() == set(PRIVILEGED_ROLES) | PRIVILEGED_BY_RIGHTS
    assert "qa_analyst" not in privileged


def test_migration_seed_equals_plan_matrix() -> None:
    matrix, mfa = _plan_matrix()
    assert list(matrix) == list(ROLE_CODES)  # в PLAN описаны все роли
    seeded = _seeded_matrix()
    assert {c: sorted(p) for c, p in seeded.items()} == {c: sorted(p) for c, p in matrix.items()}
    assert {c for c, required in mfa.items() if required} == _expected_privileged()
    for perm in EXCLUSIVE:
        assert [c for c, p in seeded.items() if perm in p] == ["super_admin"], perm
    # PLAN спринта 3: content.review — только methodist (и super_admin); media.rights — content_manager
    assert sorted(c for c, p in seeded.items() if "content.review" in p) == ["methodist", "super_admin"]
    assert sorted(c for c, p in seeded.items() if "content.publish" in p) == ["methodist", "super_admin"]
    assert sorted(c for c, p in seeded.items() if "media.rights" in p) == ["content_manager", "super_admin"]
    assert [c for c, p in seeded.items() if "lang.manage" in p] == ["super_admin"]
    assert sorted(c for c, p in seeded.items() if "content.read" in p) == sorted(
        ["super_admin", "operations", "methodist", "content_manager", "qa_analyst", "analyst", "auditor"])
    # PLAN спринта 4: публикация агентов и решения QA — методист; лимиты ИИ — операции; реплики — методист и QA
    assert sorted(c for c, p in seeded.items() if "ai.publish" in p) == ["methodist", "super_admin"]
    assert sorted(c for c, p in seeded.items() if "ai.manage" in p) == ["methodist", "super_admin"]
    assert sorted(c for c, p in seeded.items() if "qa.review" in p) == ["methodist", "super_admin"]
    assert sorted(c for c, p in seeded.items() if "qa.transcripts" in p) == ["methodist", "qa_analyst", "super_admin"]
    assert sorted(c for c, p in seeded.items() if "costs.manage" in p) == ["operations", "super_admin"]
    assert sorted(c for c, p in seeded.items() if "costs.read" in p) == sorted(
        ["super_admin", "operations", "analyst", "auditor"])
    assert sorted(c for c, p in seeded.items() if "ai.read" in p) == sorted(c for c, p in seeded.items()
                                                                             if "qa.read" in p) == sorted(
        ["super_admin", "operations", "methodist", "qa_analyst", "analyst", "auditor"])
    assert sorted(seeded["qa_analyst"]) == sorted(["dashboard.read", "content.read", "ai.read", "qa.read",
                                                   "qa.transcripts"])


def test_privileged_permissions_are_step_up_rights() -> None:
    """Права, чьи команды требуют step-up (PLAN спринтов 2–4), делают роль привилегированной: без MFA
    повторный TOTP невозможен. Чтение, черновики и просмотр реплик с причиной — нет."""
    assert PRIVILEGED_PERMISSIONS == {"users.sensitive.read", "staff.manage", "roles.manage", "config.publish",
                                      "whatsnew.publish", "notif.templates.manage", "notif.campaigns.send",
                                      *STEP_UP_SPRINT3, *STEP_UP_SPRINT4}
    _, _, step_up3 = _plan3_additions()
    _, _, step_up4 = _plan4_additions()
    assert step_up3 | step_up4 <= PRIVILEGED_PERMISSIONS
    for perm in PRIVILEGED_PERMISSIONS:
        assert privileged_by("read_only", ["dashboard.read", perm]) is True, perm
    for perm in set(PERMISSIONS) - PRIVILEGED_PERMISSIONS:
        assert privileged_by("analyst", [perm]) is False, perm
    for perm in ("content.read", "content.edit", "content.review", "ai.read", "ai.manage", "qa.read",
                 "qa.transcripts", "costs.read"):  # чтение, черновики, проверка, реплики с причиной — без step-up
        assert perm not in PRIVILEGED_PERMISSIONS
    for code in PRIVILEGED_ROLES:
        assert privileged_by(code, []) is True
    matrix, _ = _plan_matrix()
    for code, perms in matrix.items():  # матрица по умолчанию: + methodist и content_manager (права со step-up)
        expected = code in PRIVILEGED_ROLES or code in PRIVILEGED_BY_RIGHTS
        assert privileged_by(code, perms) is expected, code


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
    assert {r[0] for r in roles if r[3]} == _expected_privileged()
    assert set(_ts_const_list(src, "PRIVILEGED_ROLES")) <= {r[0] for r in roles if r[3]}
    assert len({r[1] for r in roles}) == len({r[2] for r in roles}) == len(roles) == 10
    api = (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()
    assert api["permissions"] == _ts_const_list(src, "PERMISSIONS")
    assert [r["code"] for r in api["items"]] == _ts_union(src, "RoleCode")
    for r in api["items"]:
        assert set(r) == _ts_fields(src, "Role"), r["code"]
        assert r["permissions"] == _sorted(matrix[r["code"]]), r["code"]
        assert r["privileged"] is (r["code"] in _expected_privileged()), r["code"]
    names = {r["code"]: r["name"] for r in api["items"]}
    assert names["communications"] == {"ru": "Коммуникации", "en": "Communications"}
    assert names["content_manager"] == {"ru": "Контент-менеджер", "en": "Content manager"}
    assert names["qa_analyst"] == {"ru": "QA-аналитик", "en": "QA analyst"}
    assert names["super_admin"] == {"ru": "Суперадминистратор", "en": "Super Admin"}


async def test_mfa_required_exactly_for_privileged_roles(env: Env, root: Person) -> None:
    """Вход сотрудника каждой роли (root — единственный super_admin, four-eyes waived): привилегированным (в т. ч.
    methodist и content_manager — права со step-up спринтов 3–4) — обязательное подключение TOTP, остальным (в т. ч.
    qa_analyst) — вход без MFA; права principal = матрица PLAN."""
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
