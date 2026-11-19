"""Отличия от форка aievent (docs/sprint2/INTERNAL_API.md §1, admin.ts): GET /admin/v1/staff/{id}, обязательный
Idempotency-Key создания сотрудника, bootstrap при отсутствии АКТИВНОГО super_admin и с проверкой правил пароля,
ключ MFA в base64, отсутствие AD/LDAP, привилегированность по правам step-up TilHero."""

from __future__ import annotations

import asyncio
import base64
import json
import uuid
from pathlib import Path

import asyncpg
import pytest
from aid_testkit import ROOT_EMAIL, ROOT_PASSWORD, SERVICE_DIR, Env, Person, make_settings, new_email
from alembic import command
from alembic.config import Config
from pydantic import ValidationError

from tilhero_admin_identity.models import Staff
from tilhero_admin_identity.settings import Settings
from tilhero_common.internal_auth import Actor
from tilhero_common.testing import TEST_ADMIN_URL, create_schema, drop_schema, migrate, unique_schema


def _err(r) -> tuple[int, str]:
    return r.status_code, r.json()["code"]


# ---------------------------------------------------------------- GET /admin/v1/staff/{id}

async def test_get_staff_by_id(env: Env, root: Person) -> None:
    sup = await env.onboard(root.actor, new_email("sup"), "support", "Оператор")
    r = await env.c.get(f"/admin/v1/staff/{sup.staff_id}", headers=env.h(root.actor))
    assert r.status_code == 200
    body = r.json()
    assert (body["staff_id"], body["role"], body["display_name"], body["status"]) == (
        sup.staff_id, "support", "Оператор", "ACTIVE")
    assert body["created_by"] == root.staff_id and body["must_change_password"] is False
    assert not {"password_hash", "mfa_secret_enc", "mfa_last_step", "session_version"} & set(body)
    # регистр UUID в пути не важен
    assert (await env.c.get(f"/admin/v1/staff/{sup.staff_id.upper()}", headers=env.h(root.actor))).status_code == 200
    # 403: нет права (и для себя), нет actor, чужой вызывающий; 401 без токена
    denied = await env.c.get(f"/admin/v1/staff/{sup.staff_id}", headers=env.h(sup.actor))
    assert _err(denied) == (403, "PERMISSION_DENIED") and denied.json()["details"] == {"permission": "staff.manage"}
    assert _err(await env.c.get(f"/admin/v1/staff/{root.staff_id}", headers=env.h(sup.actor))) == (
        403, "PERMISSION_DENIED")
    assert _err(await env.c.get(f"/admin/v1/staff/{sup.staff_id}", headers=env.h())) == (
        403, "STAFF_CONTEXT_REQUIRED")
    alien = await env.c.get(f"/admin/v1/staff/{sup.staff_id}", headers=env.h(issuer="user-admin"))
    assert _err(alien) == (403, "CALLER_NOT_ALLOWED")
    assert _err(await env.c.get(f"/admin/v1/staff/{sup.staff_id}")) == (401, "INTERNAL_TOKEN_MISSING")
    # подделанный actor с правом, но роль в БД без staff.manage — 403 (права из БД)
    forged = Actor(id=sup.staff_id, role="super_admin", permissions=frozenset({"staff.manage"}))
    assert _err(await env.c.get(f"/admin/v1/staff/{root.staff_id}", headers=env.h(forged))) == (
        403, "PERMISSION_DENIED")
    # 404 / 422
    assert _err(await env.c.get(f"/admin/v1/staff/{uuid.uuid4()}", headers=env.h(root.actor))) == (
        404, "STAFF_NOT_FOUND")
    assert (await env.c.get("/admin/v1/staff/not-a-uuid", headers=env.h(root.actor))).status_code == 422
    # lookup не перехвачен маршрутом /staff/{id}
    look = await env.c.get(f"/admin/v1/staff/lookup?ids={sup.staff_id}", headers=env.h(sup.actor))
    assert look.status_code == 200 and look.json()["items"][0]["staff_id"] == sup.staff_id
    # отключённый сотрудник с ещё живым actor-токеном: ни карточки, ни lookup
    off = await env.patch(root.actor, sup.staff_id, {"status": "DISABLED", "reason": "Увольнение"})
    assert off.status_code == 200
    gone = await env.c.get(f"/admin/v1/staff/lookup?ids={root.staff_id}", headers=env.h(sup.actor))
    assert _err(gone) == (403, "ACCOUNT_DISABLED")
    ghost = Actor(id=str(uuid.uuid4()), role="read_only", permissions=frozenset({"dashboard.read"}))
    assert _err(await env.c.get(f"/admin/v1/staff/lookup?ids={root.staff_id}", headers=env.h(ghost))) == (
        403, "ACTOR_UNKNOWN")


async def test_approval_decision_respects_narrowed_token(env: Env, root: Person, root2: Person) -> None:
    """Решение по заявке: токен может только сузить права (dev-имперсонация admin-bff) — super_admin с токеном
    без staff.manage/roles.manage не решает; роль решающего — по БД."""
    target = await env.onboard(root.actor, new_email("an"), "analyst")
    r = await env.patch(root.actor, target.staff_id, {"role": "communications", "reason": "Повышение"})
    aid = r.json()["approval"]["approval_id"]
    narrowed = Actor(id=root2.staff_id, role="read_only", permissions=frozenset({"dashboard.read"}), name="Root2")
    for action in ("approve", "reject"):
        denied = await env.approve(narrowed, aid, action=action)
        assert _err(denied) == (403, "PERMISSION_DENIED"), action
    assert (await env.sql("SELECT status FROM approvals WHERE approval_id = :i", i=aid))[0][0] == "PENDING"
    ok = await env.approve(root2.actor, aid)
    assert ok.status_code == 200 and ok.json()["status"] == "APPLIED"


# ---------------------------------------------------------------- Idempotency-Key создания сотрудника

async def test_create_staff_requires_idempotency_key(env: Env, root: Person) -> None:
    body = {"email": new_email("idem"), "display_name": "Без ключа", "role": "support"}
    no_key = await env.c.post("/admin/v1/staff", json=body, headers=env.h(root.actor))
    assert _err(no_key) == (422, "IDEMPOTENCY_KEY_REQUIRED")
    for bad in ("short", "x" * 129, "bad key!", "path/like/key-1234", "quote\"key-1234"):
        r = await env.c.post("/admin/v1/staff", json=body, headers=env.h(root.actor, **{"Idempotency-Key": bad}))
        assert _err(r) == (422, "IDEMPOTENCY_KEY_INVALID"), bad
    assert (await env.sql("SELECT count(*) FROM staff WHERE email = :e", e=body["email"]))[0][0] == 0
    # без права — 403 раньше проверки ключа (форма запроса не раскрывается)
    sup = await env.onboard(root.actor, new_email("sup"), "support")
    r = await env.c.post("/admin/v1/staff", json=body, headers=env.h(sup.actor))
    assert _err(r) == (403, "PERMISSION_DENIED")
    ok = await env.c.post("/admin/v1/staff", json=body,
                          headers=env.h(root.actor, **{"Idempotency-Key": "staff:create.2026-11-18_A"}))
    assert ok.status_code == 201 and ok.json()["temporary_password"]
    env.leaks.append(ok.json()["temporary_password"])
    # сбой команды (email занят) освобождает ключ: тот же ключ с исправленным телом выполняется
    dup_key = f"k-{uuid.uuid4().hex}"
    dup = await env.c.post("/admin/v1/staff", json=body, headers=env.h(root.actor, **{"Idempotency-Key": dup_key}))
    assert _err(dup) == (409, "STAFF_EMAIL_EXISTS")
    fixed = await env.c.post("/admin/v1/staff", json={**body, "email": new_email("fixed")},
                             headers=env.h(root.actor, **{"Idempotency-Key": dup_key}))
    assert fixed.status_code == 201


# ---------------------------------------------------------------- bootstrap

async def test_bootstrap_requires_active_super_admin_absence(env_factory) -> None:
    """INTERNAL_API §1: первый super_admin создаётся, только если нет АКТИВНОГО super_admin."""
    env = await env_factory()
    root = await env.first_login(ROOT_EMAIL, ROOT_PASSWORD)
    # единственного super_admin отключили в обход API (break-glass; через API последнего отключить нельзя)
    await env.sql("UPDATE staff SET status = 'DISABLED' WHERE staff_id = :i RETURNING staff_id", i=root.staff_id)
    # переменные с email отключённой учётки — она не «воскрешается» и второй с тем же email не создаётся
    same = await env_factory()
    assert (await same.sql("SELECT count(*), min(status) FROM staff"))[0] == (1, "DISABLED")
    assert await same.audit() == []
    rescue = "rescue@tilhero.test"
    env2 = await env_factory(admin_bootstrap_email=rescue)
    rows = await env2.sql("SELECT email, role, status, must_change_password, created_by FROM staff "
                          "WHERE email = :e", e=rescue)
    assert rows == [(rescue, "super_admin", "ACTIVE", True, None)]
    boot = [e.payload for e in await env2.audit() if e.payload["action"] == "staff.bootstrap"]
    assert len(boot) == 1 and boot[0]["after"]["email"] == "r***@tilhero.test" and rescue not in json.dumps(boot)
    # активный super_admin есть — повторный старт ничего не создаёт
    env3 = await env_factory(admin_bootstrap_email="third@tilhero.test")
    assert (await env3.sql("SELECT count(*) FROM staff WHERE role = 'super_admin'"))[0][0] == 2
    first = await env2.first_login(rescue, ROOT_PASSWORD)
    assert first.principal["staff"]["role"] == "super_admin" and first.secret is not None


def test_bootstrap_password_must_pass_rules_without_echo() -> None:
    cases = {
        "onlyletterslongpassword": "letters_and_digits",
        "short1A": "min_length_12",
        "root@tilhero.test1": None,  # не совпадает с email — допустим
    }
    for pwd, rule in cases.items():
        if rule is None:
            make_settings(admin_bootstrap_password=pwd)
            continue
        with pytest.raises(ValidationError) as e:
            make_settings(admin_bootstrap_password=pwd)
        assert rule in str(e.value) and pwd not in str(e.value), pwd
    with pytest.raises(ValidationError, match="not_email") as e:
        make_settings(admin_bootstrap_email="boss12345678@tilhero.test", admin_bootstrap_password="boss12345678")
    assert "boss12345678" not in str(e.value)


def test_settings_errors_never_echo_secrets() -> None:
    secret_key = "abcSECRETKEYVALUE"
    for kw in ({"admin_mfa_enc_key": secret_key}, {"admin_bootstrap_password": "SECRETKEYVALUE"},
               {"env": "prod", "internal_jwt_secret": "SECRETKEYVALUE" * 3}):
        with pytest.raises(ValidationError) as e:
            make_settings(**kw)
        assert "SECRETKEYVALUE" not in str(e.value) and "input_value" not in str(e.value), kw


def test_mfa_key_accepts_base64_and_base64url() -> None:
    raw = bytes([0xFB, 0xFF, 0xBF]) * 10 + b"\xfe\xfa"  # 32 байта: в base64 есть «+» и «/»
    std = base64.b64encode(raw).decode()
    url = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    assert "+" in std or "/" in std
    assert make_settings(admin_mfa_enc_key=std).mfa_key == raw == make_settings(admin_mfa_enc_key=url).mfa_key
    for bad in (base64.b64encode(raw[:31]).decode(), "not base64 at all!", ""):
        with pytest.raises(ValidationError, match="ADMIN_MFA_ENC_KEY"):
            make_settings(admin_mfa_enc_key=bad)


# ---------------------------------------------------------------- без AD/LDAP

async def test_no_ad_mode(env: Env, root: Person, monkeypatch: pytest.MonkeyPatch) -> None:
    assert "auth_mode" not in Settings.model_fields and "auth_provider" not in Staff.__table__.c
    cols = {r[0] for r in await env.sql(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() "
        "AND table_name = 'staff'")}
    assert "auth_provider" not in cols and {"staff_id", "email", "password_hash"} <= cols
    monkeypatch.setenv("AUTH_MODE", "ad")  # переменная AD больше ничего не меняет: вход — только пароль + TOTP
    s = make_settings()
    assert not hasattr(s, "auth_mode")
    r = await env.login(root.email, root.password)
    assert r.status_code == 200 and r.json()["next"] == "mfa"


# ---------------------------------------------------------------- привилегированность по правам step-up

async def test_step_up_permission_makes_role_privileged(env: Env, root: Person, root2: Person) -> None:
    """support получает whatsnew.publish (публикация «Что нового» — step-up) через four-eyes: роль становится
    привилегированной, сессии её сотрудников отзываются, при входе — подключение TOTP; назначение — four-eyes."""
    sup = await env.onboard(root.actor, new_email("sup"), "support")
    assert sup.secret is None
    upd = await env.c.put("/admin/v1/roles/support",
                          json={"permissions": ["dashboard.read", "users.read", "support.read", "support.reply",
                                                "whatsnew.manage", "whatsnew.publish"],
                                "reason": "Поддержка публикует заметки"}, headers=env.h(root.actor))
    assert upd.status_code == 202 and upd.json()["approval"]["status"] == "PENDING"
    assert (await env.approve(root2.actor, upd.json()["approval"]["approval_id"])).status_code == 200
    p = (await env.principal(sup.staff_id)).json()
    assert p["session_version"] == sup.principal["session_version"] + 1 and "whatsnew.publish" in p["permissions"]
    assert (await env.login(sup.email, sup.password)).json()["next"] == "mfa_enroll"
    c = await env.create_staff(root.actor, new_email("sup2"), "support")
    assert c.json()["approval"]["kind"] == "staff.create_privileged" and c.json()["staff"]["role"] == "read_only"
    # whatsnew.manage без публикации — не привилегированное: methodist с ним MFA не требует
    meth = await env.c.put("/admin/v1/roles/methodist",
                           json={"permissions": ["dashboard.read", "users.read", "whatsnew.manage"],
                                 "reason": "Методисты готовят черновики"}, headers=env.h(root.actor))
    assert (await env.approve(root2.actor, meth.json()["approval"]["approval_id"])).status_code == 200
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    assert roles["support"]["privileged"] is True and roles["methodist"]["privileged"] is False
    m = await env.onboard(root.actor, new_email("meth"), "methodist")
    assert m.secret is None and "whatsnew.manage" in m.principal["permissions"]


# ---------------------------------------------------------------- миграция

async def test_migration_downgrade_and_reapply() -> None:
    schema = unique_schema("adminid_mig")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = settings
    conn = await asyncpg.connect(TEST_ADMIN_URL, server_settings={"search_path": schema})
    try:
        await migrate(SERVICE_DIR, settings)
        # 0001: 17 + 7 + 6 + 4 + 2 + 2 + 2 + 1; 0003: super_admin +6, methodist +4, content_manager 4,
        # operations / analyst / auditor +1
        assert await conn.fetchval("SELECT count(*) FROM role_permissions") == 41 + 6 + 4 + 4 + 3
        await asyncio.to_thread(command.downgrade, cfg, "base")
        tables = {r[0] for r in await conn.fetch(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = $1", schema)}
        assert tables <= {"alembic_version"}
        await migrate(SERVICE_DIR, settings)
        assert await conn.fetchval("SELECT count(*) FROM roles") == 9
        assert await conn.fetchval("SELECT version_num FROM alembic_version") == "0003"
    finally:
        await conn.close()
        await drop_schema(schema)


# ---------------------------------------------------------------- спринт 3: права контента (миграция 0003)

async def test_migration_0003_on_live_matrix() -> None:
    """0003 поверх действующей матрицы спринта 2: права добавляются, а не заменяют изменённые через four-eyes;
    methodist становится привилегированным — сессии его сотрудников отзываются (как при role.permissions_change),
    остальные не трогаются; откат к 0002 возвращает матрицу и переводит content_manager в read_only."""
    schema = unique_schema("adminid_m3")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = settings
    conn = await asyncpg.connect(TEST_ADMIN_URL, server_settings={"search_path": schema})
    meth, an = uuid.uuid4(), uuid.uuid4()
    try:
        await asyncio.to_thread(command.upgrade, cfg, "0002")
        # матрица изменена через four-eyes в спринте 2: аналитикам выдан журнал аудита
        await conn.execute("INSERT INTO role_permissions (role, permission) VALUES ('analyst', 'audit.read')")
        for sid, role, email in ((meth, "methodist", "m@tilhero.test"), (an, "analyst", "a@tilhero.test")):
            await conn.execute("INSERT INTO staff (staff_id, email, display_name, role) VALUES ($1, $2, 'X', $3)",
                               sid, email, role)
        assert not await conn.fetchval("SELECT privileged FROM roles WHERE code = 'methodist'")

        await asyncio.to_thread(command.upgrade, cfg, "head")
        perms = {r: sorted(p for (role, p) in await conn.fetch("SELECT role, permission FROM role_permissions")
                           if role == r) for r in ("analyst", "methodist", "content_manager", "super_admin")}
        assert perms["analyst"] == ["audit.read", "content.read", "dashboard.read", "users.read"]
        assert perms["methodist"] == ["content.edit", "content.publish", "content.read", "content.review",
                                      "dashboard.read", "users.read"]
        assert perms["content_manager"] == ["content.edit", "content.read", "dashboard.read", "media.rights"]
        assert len(perms["super_admin"]) == 23
        privileged = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert privileged == {"super_admin", "operations", "communications", "methodist", "content_manager"}
        versions = {r["staff_id"]: r["session_version"] for r in await conn.fetch(
            "SELECT staff_id, session_version FROM staff")}
        assert versions[meth] == 2 and versions[an] == 1
        name = await conn.fetchrow("SELECT name_ru, name_en FROM roles WHERE code = 'content_manager'")
        assert tuple(name) == ("Контент-менеджер", "Content manager")
        # повторный прогон безопасен (ON CONFLICT): head → 0002 → head
        cm = uuid.uuid4()
        await conn.execute("INSERT INTO staff (staff_id, email, display_name, role) VALUES ($1, 'c@tilhero.test', "
                           "'C', 'content_manager')", cm)
        await asyncio.to_thread(command.downgrade, cfg, "0002")
        assert await conn.fetchval("SELECT count(*) FROM roles WHERE code = 'content_manager'") == 0
        assert await conn.fetchval("SELECT role FROM staff WHERE staff_id = $1", cm) == "read_only"
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE permission LIKE 'content.%' "
                                   "OR permission IN ('media.rights', 'lang.manage')") == 0
        privileged = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert privileged == {"super_admin", "operations", "communications"}
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE role = 'analyst' "
                                   "AND permission = 'audit.read'") == 1
        await asyncio.to_thread(command.upgrade, cfg, "head")
        assert await conn.fetchval("SELECT count(*) FROM roles") == 9
    finally:
        await conn.close()
        await drop_schema(schema)


async def test_sprint3_roles_privileged_by_step_up_rights(env: Env, root: Person, root2: Person) -> None:
    """methodist (content.publish) и content_manager (media.rights) — привилегированные по правилу спринта 2:
    назначение — four-eyes (учётка создаётся в read_only), вход — с обязательным TOTP; principal несёт права
    контента; права только на чтение (operations/analyst/auditor + content.read) роль не делают привилегированной."""
    for code, perms in (("methodist", {"content.read", "content.edit", "content.review", "content.publish"}),
                        ("content_manager", {"content.read", "content.edit", "media.rights", "dashboard.read"})):
        c = await env.create_staff(root.actor, new_email(code.replace("_", "")), code)
        assert c.status_code == 201, c.text
        body = c.json()
        assert body["approval"]["kind"] == "staff.create_privileged" and body["staff"]["role"] == "read_only"
        assert body["temporary_password"] is None
        ok = await env.approve(root2.actor, body["approval"]["approval_id"])
        assert ok.status_code == 200 and ok.json()["status"] == "APPLIED"
        temp = ok.json()["temporary_password"]
        person = await env.first_login(body["staff"]["email"], temp)
        assert person.secret is not None and person.principal["mfa_enabled"] is True
        assert person.principal["staff"]["role"] == code
        assert perms <= set(person.principal["permissions"])
        assert "lang.manage" not in person.principal["permissions"]
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    for code in ("operations", "analyst", "auditor"):
        assert "content.read" in roles[code]["permissions"], code
    assert roles["analyst"]["privileged"] is False and roles["auditor"]["privileged"] is False
    assert roles["content_manager"]["name"] == {"ru": "Контент-менеджер", "en": "Content manager"}


async def test_role_update_accepts_sprint3_permissions(env: Env, root: Person, root2: Person) -> None:
    """Через four-eyes роли можно выдать новые права; lang.manage (step-up) делает роль привилегированной —
    сессии её сотрудников отзываются, вход — с подключением TOTP."""
    an = await env.onboard(root.actor, new_email("an3"), "analyst")
    assert an.secret is None
    upd = await env.c.put("/admin/v1/roles/analyst",
                          json={"permissions": ["dashboard.read", "users.read", "content.read", "lang.manage"],
                                "reason": "Аналитики ведут справочник языков"}, headers=env.h(root.actor))
    assert upd.status_code == 202, upd.text
    assert (await env.approve(root2.actor, upd.json()["approval"]["approval_id"])).status_code == 200
    p = (await env.principal(an.staff_id)).json()
    assert p["session_version"] == an.principal["session_version"] + 1 and "lang.manage" in p["permissions"]
    assert (await env.login(an.email, an.password)).json()["next"] == "mfa_enroll"
    bad = await env.c.put("/admin/v1/roles/analyst", json={"permissions": ["content.delete"], "reason": "Нет"},
                          headers=env.h(root.actor))
    assert bad.status_code == 422
