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
    """auditor получает whatsnew.publish (публикация «Что нового» — step-up) через four-eyes: роль становится
    привилегированной, сессии её сотрудников отзываются, при входе — подключение TOTP; назначение — four-eyes.
    (До спринта 7 пример был на support; с moderation.manage она привилегирована по умолчанию.)"""
    sup = await env.onboard(root.actor, new_email("aud"), "auditor")
    assert sup.secret is None
    upd = await env.c.put("/admin/v1/roles/auditor",
                          json={"permissions": ["dashboard.read", "users.read", "audit.read",
                                                "whatsnew.manage", "whatsnew.publish"],
                                "reason": "Аудиторы публикуют заметки"}, headers=env.h(root.actor))
    assert upd.status_code == 202 and upd.json()["approval"]["status"] == "PENDING"
    assert (await env.approve(root2.actor, upd.json()["approval"]["approval_id"])).status_code == 200
    p = (await env.principal(sup.staff_id)).json()
    assert p["session_version"] == sup.principal["session_version"] + 1 and "whatsnew.publish" in p["permissions"]
    assert (await env.login(sup.email, sup.password)).json()["next"] == "mfa_enroll"
    c = await env.create_staff(root.actor, new_email("aud2"), "auditor")
    assert c.json()["approval"]["kind"] == "staff.create_privileged" and c.json()["staff"]["role"] == "read_only"
    # whatsnew.manage без публикации — не привилегированное: methodist с ним MFA не требует
    meth = await env.c.put("/admin/v1/roles/methodist",
                           json={"permissions": ["dashboard.read", "users.read", "whatsnew.manage"],
                                 "reason": "Методисты готовят черновики"}, headers=env.h(root.actor))
    assert (await env.approve(root2.actor, meth.json()["approval"]["approval_id"])).status_code == 200
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    assert roles["auditor"]["privileged"] is True and roles["methodist"]["privileged"] is False
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
        # operations / analyst / auditor +1; 0004: super_admin +8, methodist +6, operations +4, qa_analyst 5,
        # analyst / auditor +3; 0005: super_admin +3, methodist +2, operations +2, content_manager / qa_analyst /
        # analyst / auditor +1; 0006: super_admin +4, operations +4, content_manager +2, methodist / support /
        # analyst / auditor +1; 0007: super_admin +8, operations +8, support +4, analyst / auditor +4,
        # content_manager +1; 0008: super_admin +6, finance 8, support +2, operations +6, analyst / auditor +1
        assert await conn.fetchval("SELECT count(*) FROM role_permissions") == (41 + 6 + 4 + 4 + 3
                                                                               + 8 + 6 + 4 + 5 + 3 + 3
                                                                               + 3 + 2 + 2 + 4
                                                                               + 4 + 4 + 2 + 4
                                                                               + 8 + 8 + 4 + 8 + 1
                                                                               + 6 + 8 + 2 + 6 + 1 + 1)
        await asyncio.to_thread(command.downgrade, cfg, "base")
        tables = {r[0] for r in await conn.fetch(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = $1", schema)}
        assert tables <= {"alembic_version"}
        await migrate(SERVICE_DIR, settings)
        assert await conn.fetchval("SELECT count(*) FROM roles") == 11
        assert await conn.fetchval("SELECT version_num FROM alembic_version") == "0008"
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

        await asyncio.to_thread(command.upgrade, cfg, "0003")
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
        # повторный прогон безопасен (ON CONFLICT): 0003 → 0002 → head
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
        assert await conn.fetchval("SELECT count(*) FROM roles") == 11  # спринт 8: + finance
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


# ---------------------------------------------------------------- спринт 4: ИИ, контроль диалогов, затраты (0004)

async def test_migration_0004_on_live_matrix() -> None:
    """0004 поверх действующей матрицы спринта 3: права добавляются, изменения four-eyes не затираются; роль, ставшая
    привилегированной (methodist, у которого content.publish сняли через four-eyes, получает ai.publish и qa.review), —
    сессии её сотрудников отзываются; уже привилегированные (operations) и получившие только чтение (analyst) — нет;
    qa_analyst не привилегирован. Откат к 0003: qa_analyst → read_only (сессии отзываются), заявки с новыми правами →
    REJECTED, права спринта 4 удалены, привилегированность — по правилам спринта 3."""
    schema = unique_schema("adminid_m4")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = settings
    conn = await asyncpg.connect(TEST_ADMIN_URL, server_settings={"search_path": schema})
    meth, an, ops = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    try:
        await asyncio.to_thread(command.upgrade, cfg, "0003")
        # матрица изменена через four-eyes в спринте 3: методисты больше не публикуют контент, аналитикам — аудит
        await conn.execute("DELETE FROM role_permissions WHERE role = 'methodist' AND permission = 'content.publish'")
        await conn.execute("UPDATE roles SET privileged = false WHERE code = 'methodist'")
        await conn.execute("INSERT INTO role_permissions (role, permission) VALUES ('analyst', 'audit.read')")
        for sid, role, email in ((meth, "methodist", "m@tilhero.test"), (an, "analyst", "a@tilhero.test"),
                                 (ops, "operations", "o@tilhero.test")):
            await conn.execute("INSERT INTO staff (staff_id, email, display_name, role) VALUES ($1, $2, 'X', $3)",
                               sid, email, role)

        await asyncio.to_thread(command.upgrade, cfg, "0004")
        rows = await conn.fetch("SELECT role, permission FROM role_permissions")
        perms = {r: sorted(p for (role, p) in rows if role == r)
                 for r in ("analyst", "methodist", "operations", "qa_analyst", "auditor", "super_admin")}
        assert perms["analyst"] == ["ai.read", "audit.read", "content.read", "costs.read", "dashboard.read", "qa.read",
                                    "users.read"]
        assert perms["methodist"] == ["ai.manage", "ai.publish", "ai.read", "content.edit", "content.read",
                                      "content.review", "dashboard.read", "qa.read", "qa.review", "qa.transcripts",
                                      "users.read"]  # content.publish не возвращён
        assert perms["operations"] == ["ai.read", "audit.read", "config.edit", "config.publish", "config.read",
                                       "content.read", "costs.manage", "costs.read", "dashboard.read", "qa.read",
                                       "support.read", "users.read"]
        assert perms["qa_analyst"] == ["ai.read", "content.read", "dashboard.read", "qa.read", "qa.transcripts"]
        assert perms["auditor"] == ["ai.read", "audit.read", "content.read", "costs.read", "dashboard.read", "qa.read"]
        assert len(perms["super_admin"]) == 31
        privileged = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert privileged == {"super_admin", "operations", "communications", "methodist", "content_manager"}
        versions = {r["staff_id"]: r["session_version"] for r in await conn.fetch(
            "SELECT staff_id, session_version FROM staff")}
        assert versions[meth] == 2 and versions[an] == 1 and versions[ops] == 1
        name = await conn.fetchrow("SELECT name_ru, name_en FROM roles WHERE code = 'qa_analyst'")
        assert tuple(name) == ("QA-аналитик", "QA analyst")

        # откат: сотрудник qa_analyst и заявка с правом спринта 4
        qa, root_id = uuid.uuid4(), uuid.uuid4()
        await conn.execute("INSERT INTO staff (staff_id, email, display_name, role) VALUES ($1, 'q@tilhero.test', "
                           "'Q', 'qa_analyst')", qa)
        await conn.execute("INSERT INTO staff (staff_id, email, display_name, role) VALUES ($1, 'r@tilhero.test', "
                           "'R', 'super_admin')", root_id)
        appr = uuid.uuid4()
        await conn.execute(
            "INSERT INTO approvals (approval_id, kind, status, target, payload, summary, reason, requested_by, "
            "expires_at) VALUES ($1, 'role.permissions_change', 'PENDING', 'role:auditor', $2::jsonb, '{}'::jsonb, "
            "'Аудиторам — лимиты', $3, now() + interval '1 day')",
            appr, json.dumps({"role": "auditor", "permissions": ["dashboard.read", "costs.manage"]}), root_id)
        await asyncio.to_thread(command.downgrade, cfg, "0003")
        assert await conn.fetchval("SELECT count(*) FROM roles WHERE code = 'qa_analyst'") == 0
        row = await conn.fetchrow("SELECT role, session_version FROM staff WHERE staff_id = $1", qa)
        assert (row["role"], row["session_version"]) == ("read_only", 2)
        assert await conn.fetchval("SELECT status FROM approvals WHERE approval_id = $1", appr) == "REJECTED"
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE permission LIKE 'ai.%' "
                                   "OR permission LIKE 'qa.%' OR permission LIKE 'costs.%'") == 0
        privileged = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert privileged == {"super_admin", "operations", "communications", "content_manager"}
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE role = 'analyst' "
                                   "AND permission = 'audit.read'") == 1
        await asyncio.to_thread(command.upgrade, cfg, "0004")
        assert await conn.fetchval("SELECT count(*) FROM roles") == 10
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE role = 'super_admin'") == 31
    finally:
        await conn.close()
        await drop_schema(schema)


async def test_sprint4_roles_and_permissions(env: Env, root: Person) -> None:
    """qa_analyst — непривилегированная роль (только чтение и реплики с причиной): создаётся сразу, без four-eyes,
    вход без TOTP; methodist получает ai.* и qa.* (уже привилегирован), operations — лимиты ИИ; analyst и auditor —
    только чтение ИИ, контроля диалогов и затрат."""
    c = await env.create_staff(root.actor, new_email("qa"), "qa_analyst")
    assert c.status_code == 201, c.text
    body = c.json()
    assert body["approval"] is None and body["staff"]["role"] == "qa_analyst"
    assert body["temporary_password"]
    qa = await env.first_login(body["staff"]["email"], body["temporary_password"])
    assert qa.secret is None and qa.principal["mfa_enabled"] is False
    assert qa.principal["permissions"] == ["dashboard.read", "content.read", "ai.read", "qa.read", "qa.transcripts",
                                           "memory.read"]  # спринт 5: + memory.read
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    assert roles["qa_analyst"]["privileged"] is False
    assert roles["qa_analyst"]["name"] == {"ru": "QA-аналитик", "en": "QA analyst"}
    assert {"ai.read", "ai.manage", "ai.publish", "qa.read", "qa.transcripts", "qa.review"} <= set(
        roles["methodist"]["permissions"]) and roles["methodist"]["privileged"] is True
    assert {"ai.read", "qa.read", "costs.read", "costs.manage"} <= set(roles["operations"]["permissions"])
    for code in ("analyst", "auditor"):
        assert {"ai.read", "qa.read", "costs.read"} <= set(roles[code]["permissions"]), code
        assert not {"ai.manage", "ai.publish", "qa.transcripts", "qa.review", "costs.manage"} & set(
            roles[code]["permissions"]), code
        assert roles[code]["privileged"] is False, code
    assert roles["qa_analyst"]["staff_count"] == 1


async def test_role_update_with_sprint4_step_up_rights(env: Env, root: Person, root2: Person) -> None:
    """qa.review / costs.manage / ai.publish, выданные через four-eyes непривилегированной роли, делают её
    привилегированной: сессии сотрудников отзываются, вход — с подключением TOTP, назначение — four-eyes."""
    for perm in ("qa.review", "costs.manage", "ai.publish"):
        qa = await env.onboard(root.actor, new_email("qa" + perm.split(".")[1]), "qa_analyst")
        assert qa.secret is None
        upd = await env.c.put("/admin/v1/roles/qa_analyst",
                              json={"permissions": ["dashboard.read", "content.read", "ai.read", "qa.read",
                                                    "qa.transcripts", perm],
                                    "reason": "Расширение роли QA"}, headers=env.h(root.actor))
        assert upd.status_code == 202, upd.text
        assert (await env.approve(root2.actor, upd.json()["approval"]["approval_id"])).status_code == 200
        p = (await env.principal(qa.staff_id)).json()
        assert p["session_version"] == qa.principal["session_version"] + 1 and perm in p["permissions"], perm
        assert (await env.login(qa.email, qa.password)).json()["next"] == "mfa_enroll", perm
        roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
        assert roles["qa_analyst"]["privileged"] is True, perm
        new = await env.create_staff(root.actor, new_email("qa2" + perm.split(".")[1]), "qa_analyst")
        assert new.json()["approval"]["kind"] == "staff.create_privileged", perm
        # вернуть роль к непривилегированной для следующего права
        back = await env.c.put("/admin/v1/roles/qa_analyst",
                               json={"permissions": ["dashboard.read", "content.read", "ai.read", "qa.read",
                                                     "qa.transcripts"], "reason": "Возврат роли QA"},
                               headers=env.h(root.actor))
        assert back.status_code == 202, back.text
        assert (await env.approve(root2.actor, back.json()["approval"]["approval_id"])).status_code == 200
    bad = await env.c.put("/admin/v1/roles/qa_analyst", json={"permissions": ["qa.delete"], "reason": "Нет прав"},
                          headers=env.h(root.actor))
    assert bad.status_code == 422


# ---------------------------------------------------------------- спринт 5: память и словарь курса (0005)

async def test_migration_0005_on_live_matrix() -> None:
    """0005 поверх действующей матрицы спринта 4: права памяти и словаря добавляются, изменения four-eyes не
    затираются; memory.manage получают только operations и super_admin (уже привилегированные) — сессии никого не
    отзываются; qa_analyst, analyst, auditor (memory.read) и content_manager (glossary.manage) привилегированность не
    меняют. Если же memory.manage к этому моменту выдан через four-eyes непривилегированной роли — она уже
    привилегирована правом в каталоге 0005 (пересчёт) и сессии её сотрудников отзываются. Откат к 0004: права
    спринта 5 удалены, заявки с ними → REJECTED, привилегированность — по правилам спринта 4."""
    schema = unique_schema("adminid_m5")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = settings
    conn = await asyncpg.connect(TEST_ADMIN_URL, server_settings={"search_path": schema})
    meth, an, ops, qa, cm, sup = (uuid.uuid4() for _ in range(6))
    try:
        await asyncio.to_thread(command.upgrade, cfg, "0004")
        # матрица изменена через four-eyes в спринте 4: аналитикам — журнал аудита; поддержке заранее выдано право
        # спринта 5 (каталог до 0005 его не знал — роль ещё не привилегирована)
        await conn.execute("INSERT INTO role_permissions (role, permission) VALUES ('analyst', 'audit.read')")
        await conn.execute("INSERT INTO role_permissions (role, permission) VALUES ('support', 'memory.manage')")
        for sid, role, email in ((meth, "methodist", "m@tilhero.test"), (an, "analyst", "a@tilhero.test"),
                                 (ops, "operations", "o@tilhero.test"), (qa, "qa_analyst", "q@tilhero.test"),
                                 (cm, "content_manager", "c@tilhero.test"), (sup, "support", "s@tilhero.test")):
            await conn.execute("INSERT INTO staff (staff_id, email, display_name, role) VALUES ($1, $2, 'X', $3)",
                               sid, email, role)
        before = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert "support" not in before

        await asyncio.to_thread(command.upgrade, cfg, "0005")
        rows = await conn.fetch("SELECT role, permission FROM role_permissions")

        def new(role: str) -> list[str]:
            return sorted(p for (r, p) in rows if r == role and p.split(".")[0] in ("memory", "glossary"))

        assert new("methodist") == ["glossary.manage", "memory.read"]
        assert new("content_manager") == ["glossary.manage"]
        assert new("operations") == ["memory.manage", "memory.read"]
        for role in ("qa_analyst", "analyst", "auditor"):
            assert new(role) == ["memory.read"], role
        for role in ("communications", "read_only"):
            assert new(role) == [], role
        assert new("support") == ["memory.manage"]  # выданное через four-eyes не тронуто
        assert new("super_admin") == ["glossary.manage", "memory.manage", "memory.read"]
        assert len([p for (r, p) in rows if r == "super_admin"]) == 34
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE role = 'analyst' "
                                   "AND permission = 'audit.read'") == 1
        privileged = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert privileged == before | {"support"}
        versions = {r["staff_id"]: r["session_version"] for r in await conn.fetch(
            "SELECT staff_id, session_version FROM staff")}
        assert versions[sup] == 2  # поддержка стала привилегированной по memory.manage — вход с MFA
        assert all(versions[s] == 1 for s in (meth, an, ops, qa, cm))

        # повторный прогон безопасен (ON CONFLICT); откат с заявкой на право спринта 5
        root_id, appr = uuid.uuid4(), uuid.uuid4()
        await conn.execute("INSERT INTO staff (staff_id, email, display_name, role) VALUES ($1, 'r@tilhero.test', "
                           "'R', 'super_admin')", root_id)
        await conn.execute(
            "INSERT INTO approvals (approval_id, kind, status, target, payload, summary, reason, requested_by, "
            "expires_at) VALUES ($1, 'role.permissions_change', 'PENDING', 'role:read_only', $2::jsonb, "
            "'{}'::jsonb, 'Просмотр памяти', $3, now() + interval '1 day')",
            appr, json.dumps({"role": "read_only", "permissions": ["dashboard.read", "memory.read"]}), root_id)
        await asyncio.to_thread(command.downgrade, cfg, "0004")
        assert await conn.fetchval("SELECT status FROM approvals WHERE approval_id = $1", appr) == "REJECTED"
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE permission LIKE 'memory.%' "
                                   "OR permission LIKE 'glossary.%'") == 0
        privileged = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert privileged == before
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE role = 'super_admin'") == 31
        await asyncio.to_thread(command.upgrade, cfg, "0005")
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE role = 'super_admin'") == 34
        assert await conn.fetchval("SELECT count(*) FROM roles") == 10
    finally:
        await conn.close()
        await drop_schema(schema)


async def test_sprint5_roles_and_permissions(env: Env, root: Person) -> None:
    """memory.read — methodist, qa_analyst, analyst, operations, auditor; memory.manage — operations; glossary.manage
    — methodist и content_manager; привилегированность ролей по умолчанию не меняется (qa_analyst, analyst, auditor
    по-прежнему без MFA; support привилегирована с спринта 7 — moderation.manage)."""
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    holders = {perm: sorted(c for c, r in roles.items() if perm in r["permissions"])
               for perm in ("memory.read", "memory.manage", "glossary.manage")}
    assert holders == {
        "memory.read": sorted(["super_admin", "operations", "methodist", "qa_analyst", "analyst", "auditor"]),
        "memory.manage": ["operations", "super_admin"],
        "glossary.manage": sorted(["super_admin", "methodist", "content_manager"]),
    }
    for code in ("qa_analyst", "analyst", "auditor", "read_only"):
        assert roles[code]["privileged"] is False, code
    an = await env.onboard(root.actor, new_email("an5"), "analyst")
    assert an.secret is None and "memory.read" in an.principal["permissions"]
    assert "memory.manage" not in an.principal["permissions"]


async def test_role_update_with_sprint5_rights(env: Env, root: Person, root2: Person) -> None:
    """memory.manage (step-up), выданный через four-eyes непривилегированной роли, делает её привилегированной: сессии
    отзываются, вход — с подключением TOTP; glossary.manage и memory.read — без step-up, роль остаётся без MFA."""
    an = await env.onboard(root.actor, new_email("an5g"), "analyst")
    upd = await env.c.put("/admin/v1/roles/analyst",
                          json={"permissions": ["dashboard.read", "users.read", "content.read", "memory.read",
                                                "glossary.manage"], "reason": "Аналитики правят словарь"},
                          headers=env.h(root.actor))
    assert upd.status_code == 202, upd.text
    assert (await env.approve(root2.actor, upd.json()["approval"]["approval_id"])).status_code == 200
    p = (await env.principal(an.staff_id)).json()
    assert "glossary.manage" in p["permissions"]
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    assert roles["analyst"]["privileged"] is False
    assert (await env.login(an.email, an.password)).json()["next"] != "mfa_enroll"

    qa = await env.onboard(root.actor, new_email("qa5m"), "qa_analyst")
    upd = await env.c.put("/admin/v1/roles/qa_analyst",
                          json={"permissions": ["dashboard.read", "content.read", "ai.read", "qa.read",
                                                "qa.transcripts", "memory.read", "memory.manage"],
                                "reason": "QA правит карточки учеников"}, headers=env.h(root.actor))
    assert upd.status_code == 202, upd.text
    assert (await env.approve(root2.actor, upd.json()["approval"]["approval_id"])).status_code == 200
    p = (await env.principal(qa.staff_id)).json()
    assert p["session_version"] == qa.principal["session_version"] + 1 and "memory.manage" in p["permissions"]
    assert (await env.login(qa.email, qa.password)).json()["next"] == "mfa_enroll"
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    assert roles["qa_analyst"]["privileged"] is True
    bad = await env.c.put("/admin/v1/roles/qa_analyst", json={"permissions": ["memory.delete"], "reason": "Нет прав"},
                          headers=env.h(root.actor))
    assert bad.status_code == 422


# ---------------------------------------------------------------- спринт 6: игра и кошельки учеников (0006)

async def test_migration_0006_on_live_matrix() -> None:
    """0006 поверх действующей матрицы спринта 5: права игры добавляются, изменения four-eyes не затираются;
    game.publish и wallet.adjust получают только operations и super_admin (уже привилегированные) — сессии никого не
    отзываются; support, methodist, analyst, auditor (game.read) и content_manager (game.manage) привилегированность не
    меняют. Если wallet.adjust к этому моменту выдан через four-eyes непривилегированной роли — она привилегирована
    правом в каталоге 0006 (пересчёт) и сессии её сотрудников отзываются. Откат к 0005: права спринта 6 удалены,
    заявки с ними → REJECTED, привилегированность — по правилам спринта 5."""
    schema = unique_schema("adminid_m6")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = settings
    conn = await asyncpg.connect(TEST_ADMIN_URL, server_settings={"search_path": schema})
    meth, an, ops, sup, cm, qa = (uuid.uuid4() for _ in range(6))
    try:
        await asyncio.to_thread(command.upgrade, cfg, "0005")
        # матрица изменена через four-eyes в спринте 5: аналитикам — журнал аудита; QA заранее выдано право спринта 6
        # (каталог до 0006 его не знал — роль ещё не привилегирована)
        await conn.execute("INSERT INTO role_permissions (role, permission) VALUES ('analyst', 'audit.read')")
        await conn.execute("INSERT INTO role_permissions (role, permission) VALUES ('qa_analyst', 'wallet.adjust')")
        for sid, role, email in ((meth, "methodist", "m@tilhero.test"), (an, "analyst", "a@tilhero.test"),
                                 (ops, "operations", "o@tilhero.test"), (sup, "support", "s@tilhero.test"),
                                 (cm, "content_manager", "c@tilhero.test"), (qa, "qa_analyst", "q@tilhero.test")):
            await conn.execute("INSERT INTO staff (staff_id, email, display_name, role) VALUES ($1, $2, 'X', $3)",
                               sid, email, role)
        before = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert "qa_analyst" not in before and "support" not in before

        await asyncio.to_thread(command.upgrade, cfg, "0006")
        rows = await conn.fetch("SELECT role, permission FROM role_permissions")

        def new(role: str) -> list[str]:
            return sorted(p for (r, p) in rows if r == role and p.split(".")[0] in ("game", "wallet"))

        assert new("operations") == ["game.manage", "game.publish", "game.read", "wallet.adjust"]
        assert new("content_manager") == ["game.manage", "game.read"]
        for role in ("methodist", "support", "analyst", "auditor"):
            assert new(role) == ["game.read"], role
        for role in ("communications", "read_only"):
            assert new(role) == [], role
        assert new("qa_analyst") == ["wallet.adjust"]  # выданное через four-eyes не тронуто, game.read не добавлен
        assert new("super_admin") == ["game.manage", "game.publish", "game.read", "wallet.adjust"]
        assert len([p for (r, p) in rows if r == "super_admin"]) == 38
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE role = 'analyst' "
                                   "AND permission = 'audit.read'") == 1
        privileged = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert privileged == before | {"qa_analyst"}
        versions = {r["staff_id"]: r["session_version"] for r in await conn.fetch(
            "SELECT staff_id, session_version FROM staff")}
        assert versions[qa] == 2  # QA стал привилегированным по wallet.adjust — вход с MFA
        assert all(versions[s] == 1 for s in (meth, an, ops, sup, cm))

        # откат с заявкой на право спринта 6; повторный подъём безопасен (ON CONFLICT)
        root_id, appr = uuid.uuid4(), uuid.uuid4()
        await conn.execute("INSERT INTO staff (staff_id, email, display_name, role) VALUES ($1, 'r@tilhero.test', "
                           "'R', 'super_admin')", root_id)
        await conn.execute(
            "INSERT INTO approvals (approval_id, kind, status, target, payload, summary, reason, requested_by, "
            "expires_at) VALUES ($1, 'role.permissions_change', 'PENDING', 'role:read_only', $2::jsonb, "
            "'{}'::jsonb, 'Просмотр кошельков', $3, now() + interval '1 day')",
            appr, json.dumps({"role": "read_only", "permissions": ["dashboard.read", "game.read"]}), root_id)
        await asyncio.to_thread(command.downgrade, cfg, "0005")
        assert await conn.fetchval("SELECT status FROM approvals WHERE approval_id = $1", appr) == "REJECTED"
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE permission LIKE 'game.%' "
                                   "OR permission LIKE 'wallet.%'") == 0
        privileged = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert privileged == before
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE role = 'super_admin'") == 34
        await asyncio.to_thread(command.upgrade, cfg, "0006")
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE role = 'super_admin'") == 38
        assert await conn.fetchval("SELECT count(*) FROM roles") == 10
    finally:
        await conn.close()
        await drop_schema(schema)


async def test_sprint6_roles_and_permissions(env: Env, root: Person) -> None:
    """game.read — support, methodist, content_manager, operations, analyst, auditor; game.manage — content_manager и
    operations; game.publish и wallet.adjust — только operations (и super_admin); привилегированность ролей по
    умолчанию правами игры не меняется (analyst, auditor без MFA; support с спринта 7 привилегирована —
    moderation.manage, создание — four-eyes)."""
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    holders = {perm: sorted(c for c, r in roles.items() if perm in r["permissions"])
               for perm in ("game.read", "game.manage", "game.publish", "wallet.adjust")}
    assert holders == {
        "game.read": sorted(["super_admin", "operations", "support", "methodist", "content_manager", "analyst",
                             "auditor"]),
        "game.manage": sorted(["super_admin", "operations", "content_manager"]),
        "game.publish": ["operations", "super_admin"],
        "wallet.adjust": ["operations", "super_admin"],
    }
    for code in ("analyst", "auditor", "qa_analyst", "read_only"):
        assert roles[code]["privileged"] is False, code
    sup = await env.onboard(root.actor, new_email("aud6"), "auditor")
    assert sup.secret is None and "game.read" in sup.principal["permissions"]
    assert not {"game.manage", "game.publish", "wallet.adjust"} & set(sup.principal["permissions"])
    ops = await env.onboard(root.actor, new_email("ops6"), "operations")
    assert ops.secret is not None  # operations — MFA обязательна (step-up для game.publish и wallet.adjust)
    assert {"game.read", "game.manage", "game.publish", "wallet.adjust"} <= set(ops.principal["permissions"])


async def test_role_update_with_sprint6_rights(env: Env, root: Person, root2: Person) -> None:
    """game.publish и wallet.adjust (step-up), выданные через four-eyes непривилегированной роли, делают её
    привилегированной: сессии отзываются, вход — с подключением TOTP; game.read и game.manage — без step-up, роль
    остаётся без MFA."""
    sup = await env.onboard(root.actor, new_email("aud6m"), "auditor")
    upd = await env.c.put("/admin/v1/roles/auditor",
                          json={"permissions": ["dashboard.read", "users.read", "audit.read",
                                                "game.read", "game.manage"], "reason": "Аудиторы правят магазин"},
                          headers=env.h(root.actor))
    assert upd.status_code == 202, upd.text
    assert (await env.approve(root2.actor, upd.json()["approval"]["approval_id"])).status_code == 200
    p = (await env.principal(sup.staff_id)).json()
    assert "game.manage" in p["permissions"]
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    assert roles["auditor"]["privileged"] is False
    assert (await env.login(sup.email, sup.password)).json()["next"] != "mfa_enroll"

    for perm in ("wallet.adjust", "game.publish"):
        an = await env.onboard(root.actor, new_email("an6" + perm.split(".")[1]), "analyst")
        assert an.secret is None
        upd = await env.c.put("/admin/v1/roles/analyst",
                              json={"permissions": ["dashboard.read", "users.read", "content.read", "game.read", perm],
                                    "reason": "Аналитики правят кошельки"}, headers=env.h(root.actor))
        assert upd.status_code == 202, upd.text
        assert (await env.approve(root2.actor, upd.json()["approval"]["approval_id"])).status_code == 200
        p = (await env.principal(an.staff_id)).json()
        assert p["session_version"] == an.principal["session_version"] + 1 and perm in p["permissions"], perm
        assert (await env.login(an.email, an.password)).json()["next"] == "mfa_enroll", perm
        roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
        assert roles["analyst"]["privileged"] is True, perm
        new = await env.create_staff(root.actor, new_email("an6n" + perm.split(".")[1]), "analyst")
        assert new.json()["approval"]["kind"] == "staff.create_privileged", perm
        back = await env.c.put("/admin/v1/roles/analyst",
                               json={"permissions": ["dashboard.read", "users.read", "content.read", "game.read"],
                                     "reason": "Возврат роли аналитика"}, headers=env.h(root.actor))
        assert back.status_code == 202, back.text
        assert (await env.approve(root2.actor, back.json()["approval"]["approval_id"])).status_code == 200
    bad = await env.c.put("/admin/v1/roles/analyst", json={"permissions": ["wallet.drain"], "reason": "Нет прав"},
                          headers=env.h(root.actor))
    assert bad.status_code == 422


# ---------------------------------------------------------------- спринт 7: социальный контур (0007)

SPRINT7 = ["social.read", "moderation.manage", "referral.read", "referral.manage", "league.read", "league.manage",
           "room.read", "room.manage"]


async def test_migration_0007_on_live_matrix() -> None:
    """0007 поверх действующей матрицы спринта 6: права сообщества добавляются, изменения four-eyes не затираются;
    support получает moderation.manage (step-up) — становится привилегированной, сессии её сотрудников отзываются;
    остальные роли привилегированность не меняют (operations и super_admin уже привилегированы; analyst, auditor,
    content_manager получают только чтение). Откат к 0006: права спринта 7 удалены, заявки с ними → REJECTED,
    привилегированность — по правилам спринта 6."""
    schema = unique_schema("adminid_m7")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = settings
    conn = await asyncpg.connect(TEST_ADMIN_URL, server_settings={"search_path": schema})
    sup, an, ops, cm, meth = (uuid.uuid4() for _ in range(5))
    try:
        await asyncio.to_thread(command.upgrade, cfg, "0006")
        # матрица изменена через four-eyes в спринте 6: аналитикам — журнал аудита
        await conn.execute("INSERT INTO role_permissions (role, permission) VALUES ('analyst', 'audit.read')")
        for sid, role, email in ((sup, "support", "s@tilhero.test"), (an, "analyst", "a@tilhero.test"),
                                 (ops, "operations", "o@tilhero.test"), (cm, "content_manager", "c@tilhero.test"),
                                 (meth, "methodist", "m@tilhero.test")):
            await conn.execute("INSERT INTO staff (staff_id, email, display_name, role) VALUES ($1, $2, 'X', $3)",
                               sid, email, role)
        before = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert "support" not in before

        await asyncio.to_thread(command.upgrade, cfg, "0007")
        rows = await conn.fetch("SELECT role, permission FROM role_permissions")

        def new(role: str) -> list[str]:
            return sorted(p for (r, p) in rows if r == role and p in SPRINT7)

        reads = sorted(["social.read", "referral.read", "league.read", "room.read"])
        assert new("super_admin") == sorted(SPRINT7) and new("operations") == sorted(SPRINT7)
        assert new("support") == sorted(["social.read", "moderation.manage", "referral.read", "room.read"])
        assert new("content_manager") == ["league.read"]
        assert new("analyst") == reads and new("auditor") == reads
        for role in ("methodist", "communications", "qa_analyst", "read_only"):
            assert new(role) == [], role
        assert len([p for (r, p) in rows if r == "super_admin"]) == 46
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE role = 'analyst' "
                                   "AND permission = 'audit.read'") == 1
        privileged = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert privileged == before | {"support"}
        versions = {r["staff_id"]: r["session_version"] for r in await conn.fetch(
            "SELECT staff_id, session_version FROM staff")}
        assert versions[sup] == 2  # support стала привилегированной — вход с MFA
        assert all(versions[s] == 1 for s in (an, ops, cm, meth))

        # откат с заявкой на право спринта 7; повторный подъём безопасен (ON CONFLICT)
        root_id, appr = uuid.uuid4(), uuid.uuid4()
        await conn.execute("INSERT INTO staff (staff_id, email, display_name, role) VALUES ($1, 'r@tilhero.test', "
                           "'R', 'super_admin')", root_id)
        await conn.execute(
            "INSERT INTO approvals (approval_id, kind, status, target, payload, summary, reason, requested_by, "
            "expires_at) VALUES ($1, 'role.permissions_change', 'PENDING', 'role:read_only', $2::jsonb, "
            "'{}'::jsonb, 'Просмотр лиг', $3, now() + interval '1 day')",
            appr, json.dumps({"role": "read_only", "permissions": ["dashboard.read", "league.read"]}), root_id)
        await asyncio.to_thread(command.downgrade, cfg, "0006")
        assert await conn.fetchval("SELECT status FROM approvals WHERE approval_id = $1", appr) == "REJECTED"
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE permission = ANY($1::text[])",
                                   SPRINT7) == 0
        privileged = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert privileged == before
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE role = 'super_admin'") == 38
        await asyncio.to_thread(command.upgrade, cfg, "0007")
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE role = 'super_admin'") == 46
        assert await conn.fetchval("SELECT count(*) FROM roles") == 10
    finally:
        await conn.close()
        await drop_schema(schema)


async def test_sprint7_roles_and_permissions(env: Env, root: Person, root2: Person) -> None:
    """PLAN спринта 7: модерация — support и operations; кампании рефералов, лиги, комнаты — operations; чтение —
    analyst и auditor; league.read — ещё content_manager. support привилегирована (MFA, создание — four-eyes),
    analyst и auditor — нет."""
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    holders = {perm: sorted(c for c, r in roles.items() if perm in r["permissions"]) for perm in SPRINT7}
    readers = sorted(["super_admin", "operations", "support", "analyst", "auditor"])
    assert holders == {
        "social.read": readers, "referral.read": readers, "room.read": readers,
        "league.read": sorted(["super_admin", "operations", "content_manager", "analyst", "auditor"]),
        "moderation.manage": sorted(["super_admin", "operations", "support"]),
        "referral.manage": ["operations", "super_admin"],
        "league.manage": ["operations", "super_admin"],
        "room.manage": ["operations", "super_admin"],
    }
    assert roles["support"]["privileged"] is True
    for code in ("analyst", "auditor", "qa_analyst", "read_only"):
        assert roles[code]["privileged"] is False, code
    c = await env.create_staff(root.actor, new_email("sup7"), "support")
    assert c.json()["approval"]["kind"] == "staff.create_privileged" and c.json()["staff"]["role"] == "read_only"
    sup = await env.onboard(root.actor, new_email("sup7a"), "support", approver=root2.actor)
    assert sup.secret is not None  # MFA обязательна
    assert {"social.read", "moderation.manage", "referral.read", "room.read"} <= set(sup.principal["permissions"])
    assert not {"referral.manage", "league.manage", "room.manage"} & set(sup.principal["permissions"])
    an = await env.onboard(root.actor, new_email("an7"), "analyst")
    assert an.secret is None and set(an.principal["permissions"]) & set(SPRINT7) == {
        "social.read", "referral.read", "league.read", "room.read"}


# ---------------------------------------------------------------- спринт 8: деньги (0008)

SPRINT8 = ["billing.read", "billing.manage", "billing.publish", "billing.approve", "billing.refund",
           "subscriptions.override"]


async def test_migration_0008_on_live_matrix() -> None:
    """0008 поверх действующей матрицы спринта 7: права денег добавляются, изменения four-eyes не затираются; новая
    роль finance привилегирована составом прав (PRIVILEGED_ROLES не расширяется); роли, уже привилегированные
    (support, operations), и получившие только чтение (analyst, auditor) — без отзыва сессий. Откат: сотрудники
    finance → read_only с отзывом сессий, роль и права удалены, заявки с ними — REJECTED, привилегированность — по
    правилам спринта 7."""
    schema = unique_schema("adminid_m8")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = settings
    conn = await asyncpg.connect(TEST_ADMIN_URL, server_settings={"search_path": schema})
    sup, an, ops, ro = (uuid.uuid4() for _ in range(4))
    try:
        await asyncio.to_thread(command.upgrade, cfg, "0007")
        await conn.execute("INSERT INTO role_permissions (role, permission) VALUES ('analyst', 'audit.read')")
        for sid, role, email in ((sup, "support", "s@tilhero.test"), (an, "analyst", "a@tilhero.test"),
                                 (ops, "operations", "o@tilhero.test"), (ro, "read_only", "r@tilhero.test")):
            await conn.execute("INSERT INTO staff (staff_id, email, display_name, role) VALUES ($1, $2, 'X', $3)",
                               sid, email, role)
        before = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert {"support", "operations"} <= before and "finance" not in before

        await asyncio.to_thread(command.upgrade, cfg, "0008")
        rows = await conn.fetch("SELECT role, permission FROM role_permissions")

        def new(role: str) -> list[str]:
            return sorted(p for (r, p) in rows if r == role and p in SPRINT8)

        assert new("super_admin") == sorted(SPRINT8) and new("operations") == sorted(SPRINT8)
        assert new("finance") == sorted(p for p in SPRINT8 if p.startswith("billing."))
        assert sorted(p for (r, p) in rows if r == "finance") == sorted(
            [*(p for p in SPRINT8 if p.startswith("billing.")), "costs.read", "dashboard.read", "users.read"])
        assert new("support") == sorted(["billing.read", "subscriptions.override"])
        assert new("analyst") == ["billing.read"] and new("auditor") == ["billing.read"]
        for role in ("methodist", "communications", "content_manager", "qa_analyst", "read_only"):
            assert new(role) == [], role
        assert len([p for (r, p) in rows if r == "super_admin"]) == 52
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE role = 'analyst' "
                                   "AND permission = 'audit.read'") == 1
        name = await conn.fetchrow("SELECT name_ru, name_en FROM roles WHERE code = 'finance'")
        assert tuple(name) == ("Финансы", "Finance")
        privileged = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert privileged == before | {"finance"}
        versions = {r["staff_id"]: r["session_version"] for r in await conn.fetch(
            "SELECT staff_id, session_version FROM staff")}
        assert all(versions[s] == 1 for s in (sup, an, ops, ro))  # никто не стал привилегированным

        # сотрудник finance и заявка на право денег; откат → read_only, REJECTED
        fin, root_id, appr = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        await conn.execute("INSERT INTO staff (staff_id, email, display_name, role) VALUES ($1, 'f@tilhero.test', "
                           "'F', 'finance')", fin)
        await conn.execute("INSERT INTO staff (staff_id, email, display_name, role) VALUES ($1, 'root@tilhero.test', "
                           "'R', 'super_admin')", root_id)
        await conn.execute(
            "INSERT INTO approvals (approval_id, kind, status, target, payload, summary, reason, requested_by, "
            "expires_at) VALUES ($1, 'role.permissions_change', 'PENDING', 'role:read_only', $2::jsonb, "
            "'{}'::jsonb, 'Чтение денег', $3, now() + interval '1 day')",
            appr, json.dumps({"role": "read_only", "permissions": ["dashboard.read", "billing.read"]}), root_id)
        await asyncio.to_thread(command.downgrade, cfg, "0007")
        assert await conn.fetchval("SELECT status FROM approvals WHERE approval_id = $1", appr) == "REJECTED"
        assert await conn.fetchval("SELECT role FROM staff WHERE staff_id = $1", fin) == "read_only"
        assert await conn.fetchval("SELECT session_version FROM staff WHERE staff_id = $1", fin) == 2
        assert await conn.fetchval("SELECT count(*) FROM roles WHERE code = 'finance'") == 0
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE permission = ANY($1::text[])",
                                   SPRINT8) == 0
        privileged = {r["code"] for r in await conn.fetch("SELECT code FROM roles WHERE privileged")}
        assert privileged == before
        # повторный подъём безопасен (ON CONFLICT)
        await asyncio.to_thread(command.upgrade, cfg, "head")
        assert await conn.fetchval("SELECT count(*) FROM role_permissions WHERE role = 'super_admin'") == 52
        assert await conn.fetchval("SELECT count(*) FROM roles") == 11
    finally:
        await conn.close()
        await drop_schema(schema)


async def test_sprint8_finance_role(env: Env, root: Person, root2: Person) -> None:
    """PLAN спринта 8: finance — права денег без заявок «четыре глаза» (subscriptions.override — у support и
    operations), costs.read, dashboard.read, users.read; привилегирована (MFA, создание — four-eyes); support и
    operations создают заявки; analyst и auditor — только чтение, не привилегированы."""
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    holders = {perm: sorted(c for c, r in roles.items() if perm in r["permissions"]) for perm in SPRINT8}
    assert holders == {
        "billing.read": sorted(["super_admin", "operations", "support", "finance", "analyst", "auditor"]),
        "billing.manage": ["finance", "operations", "super_admin"],
        "billing.publish": ["finance", "operations", "super_admin"],
        "billing.approve": ["finance", "operations", "super_admin"],
        "billing.refund": ["finance", "operations", "super_admin"],
        "subscriptions.override": ["operations", "super_admin", "support"],
    }
    assert roles["finance"]["privileged"] is True
    for code in ("analyst", "auditor", "read_only"):
        assert roles[code]["privileged"] is False, code
    c = await env.create_staff(root.actor, new_email("fin8"), "finance")
    assert c.json()["approval"]["kind"] == "staff.create_privileged" and c.json()["staff"]["role"] == "read_only"
    fin = await env.onboard(root.actor, new_email("fin8a"), "finance", approver=root2.actor)
    assert fin.secret is not None  # MFA обязательна
    assert fin.principal["permissions"] == ["dashboard.read", "users.read", "costs.read", "billing.read",
                                            "billing.manage", "billing.publish", "billing.approve",
                                            "billing.refund"]
