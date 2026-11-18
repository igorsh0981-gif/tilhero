"""Staff API, роли, four-eyes, инварианты (LAST_SUPER_ADMIN, SELF_ACTION), session_version, права."""

from __future__ import annotations

import uuid

from aid_testkit import Env, Person, new_email

from tilhero_common.internal_auth import Actor


def _err(r) -> tuple[int, str]:
    return r.status_code, r.json()["code"]


async def test_staff_create_list_lookup(env: Env, root: Person) -> None:
    email = new_email("Support.Agent").upper()
    r = await env.create_staff(root.actor, email, "support", "Алина")
    assert r.status_code == 201 and r.headers["cache-control"] == "no-store"
    body = r.json()
    temp = body["temporary_password"]
    assert len(temp) == 20 and any(c.isdigit() for c in temp) and any(c.isalpha() for c in temp)
    staff = body["staff"]
    assert staff["email"] == email.lower() and staff["role"] == "support" and body["approval"] is None
    assert staff["must_change_password"] is True and staff["mfa_enabled"] is False
    assert staff["created_by"] == root.staff_id and staff["auth_provider"] == "local" and staff["status"] == "ACTIVE"
    env.leaks.append(temp)
    dup = await env.create_staff(root.actor, email, "analyst")
    assert _err(dup) == (409, "STAFF_EMAIL_EXISTS")
    bad = await env.create_staff(root.actor, "not-an-email", "support")
    assert _err(bad) == (422, "VALIDATION_ERROR")
    bad_role = await env.create_staff(root.actor, new_email(), "god")
    assert bad_role.status_code == 422
    # вход временным паролем → смена пароля; support не привилегированная → без MFA
    person = await env.first_login(email.lower(), temp)
    assert person.secret is None and person.principal["permissions"] == [
        "dashboard.read", "users.read", "support.read", "support.reply"]
    for i in range(3):
        await env.create_staff(root.actor, new_email(f"p{i}"), "analyst", f"Аналитик {i}")
    page1 = (await env.c.get("/admin/v1/staff?limit=2", headers=env.h(root.actor))).json()
    page2 = (await env.c.get(f"/admin/v1/staff?limit=2&cursor={page1['next_cursor']}",
                             headers=env.h(root.actor))).json()
    page3 = (await env.c.get(f"/admin/v1/staff?limit=2&cursor={page2['next_cursor']}",
                             headers=env.h(root.actor))).json()
    ids = [s["staff_id"] for p in (page1, page2, page3) for s in p["items"]]
    assert len(ids) == 5 == len(set(ids)) and page3["next_cursor"] is None
    analysts = (await env.c.get("/admin/v1/staff?role=analyst", headers=env.h(root.actor))).json()["items"]
    assert len(analysts) == 3
    found = (await env.c.get("/admin/v1/staff", params={"q": "алина"}, headers=env.h(root.actor))).json()["items"]
    assert [s["display_name"] for s in found] == ["Алина"]
    assert (await env.c.get("/admin/v1/staff?q=100%25", headers=env.h(root.actor))).json()["items"] == []
    bad_cursor = await env.c.get("/admin/v1/staff?cursor=zzz", headers=env.h(root.actor))
    assert _err(bad_cursor) == (400, "INVALID_CURSOR")
    # lookup — любой сотрудник (даже без staff.manage)
    look = await env.c.get(f"/admin/v1/staff/lookup?ids={person.staff_id},{root.staff_id},{uuid.uuid4()}",
                           headers=env.h(person.actor))
    assert look.status_code == 200
    assert {i["staff_id"] for i in look.json()["items"]} == {person.staff_id, root.staff_id}
    assert set(look.json()["items"][0]) == {"staff_id", "email", "display_name", "role"}
    assert (await env.c.get("/admin/v1/staff/lookup?ids=nope", headers=env.h(person.actor))).status_code == 422
    assert "staff.created" in await env.actions()


async def test_staff_api_permissions_and_callers(env: Env, root: Person) -> None:
    support = await env.onboard(root.actor, new_email("sup"), "support")
    denied = await env.c.get("/admin/v1/staff", headers=env.h(support.actor))
    assert _err(denied) == (403, "PERMISSION_DENIED") and denied.json()["details"] == {"permission": "staff.manage"}
    for method, path, body in (
        ("post", "/admin/v1/staff", {"email": new_email(), "display_name": "X", "role": "support"}),
        ("patch", f"/admin/v1/staff/{root.staff_id}", {"display_name": "X", "reason": "Попытка"}),
        ("post", f"/admin/v1/staff/{root.staff_id}/reset-password", {"reason": "Попытка"}),
        ("post", f"/admin/v1/staff/{root.staff_id}/reset-mfa", {"reason": "Попытка"}),
        ("put", "/admin/v1/roles/support", {"permissions": ["dashboard.read"], "reason": "Попытка"}),
    ):
        r = await env.c.request(method.upper(), path, json=body, headers=env.h(support.actor))
        assert _err(r) == (403, "PERMISSION_DENIED"), path
    roles = await env.c.get("/admin/v1/roles", headers=env.h(support.actor))
    assert roles.json()["details"] == {"permission": "staff.manage"}
    approvals = await env.c.get("/admin/v1/approvals", headers=env.h(support.actor))
    assert approvals.status_code == 403
    no_actor = await env.c.get("/admin/v1/staff", headers=env.h())
    assert _err(no_actor) == (403, "STAFF_CONTEXT_REQUIRED")
    no_token = await env.c.get("/admin/v1/staff")
    assert _err(no_token) == (401, "INTERNAL_TOKEN_MISSING")
    alien = await env.c.get("/admin/v1/staff", headers=env.h(root.actor, issuer="support"))
    assert alien.status_code == 403 and alien.json()["code"] in {"CALLER_NOT_ALLOWED", "ACTOR_NOT_ALLOWED"}
    alien_no_actor = await env.c.get("/admin/v1/staff", headers=env.h(issuer="support"))
    assert _err(alien_no_actor) == (403, "CALLER_NOT_ALLOWED")
    lookup_no_actor = await env.c.get(f"/admin/v1/staff/lookup?ids={root.staff_id}", headers=env.h())
    assert _err(lookup_no_actor) == (403, "STAFF_CONTEXT_REQUIRED")
    # actor с правом, но не существующий/отключённый сотрудник — команды не выполняются
    ghost = Actor(id=str(uuid.uuid4()), role="super_admin", permissions=frozenset({"staff.manage"}))
    r = await env.create_staff(ghost, new_email(), "support")
    assert _err(r) == (403, "ACTOR_UNKNOWN")
    missing = await env.patch(root.actor, str(uuid.uuid4()), {"display_name": "X", "reason": "Нет такого"})
    assert _err(missing) == (404, "STAFF_NOT_FOUND")
    empty = await env.patch(root.actor, support.staff_id, {"reason": "Ничего"})
    assert empty.status_code == 422


async def test_create_idempotency_does_not_store_temp_password(env: Env, root: Person) -> None:
    key = uuid.uuid4().hex
    email = new_email("idem")
    first = await env.create_staff(root.actor, email, "support", **{"Idempotency-Key": key})
    again = await env.create_staff(root.actor, email, "support", **{"Idempotency-Key": key})
    assert first.status_code == again.status_code == 201
    assert again.json()["staff"] == first.json()["staff"]
    assert first.json()["temporary_password"] and again.json()["temporary_password"] is None
    other = await env.create_staff(root.actor, new_email(), "support", **{"Idempotency-Key": key})
    assert _err(other) == (422, "IDEMPOTENCY_KEY_REUSED")
    assert env.runtime.redis is not None
    async for k in env.runtime.redis.scan_iter(match=f"idem:{env.settings.redis_namespace}*"):
        assert first.json()["temporary_password"] not in (await env.runtime.redis.get(k) or "")


async def test_self_action_and_last_super_admin(env: Env, root: Person) -> None:
    me = root.actor
    for body in ({"role": "support", "reason": "Сам себя"}, {"status": "DISABLED", "reason": "Сам себя"}):
        assert _err(await env.patch(me, root.staff_id, body)) == (409, "SELF_ACTION")
    for action in ("reset-password", "reset-mfa"):
        r = await env.c.post(f"/admin/v1/staff/{root.staff_id}/{action}", json={"reason": "Сам себя"},
                             headers=env.h(me))
        assert _err(r) == (409, "SELF_ACTION")
    rename = await env.patch(me, root.staff_id, {"display_name": "Главный", "reason": "Опечатка"})
    assert rename.status_code == 200 and rename.json()["display_name"] == "Главный"
    # матрица: auditor получает staff.manage (root — единственный super_admin → waived)
    grant = await env.c.put("/admin/v1/roles/auditor",
                            json={"permissions": ["dashboard.read", "audit.read", "staff.manage"],
                                  "reason": "Аудитор ведёт учётки"}, headers=env.h(me))
    assert grant.status_code == 202, grant.text
    a = grant.json()["approval"]
    assert a["status"] == "APPLIED" and a["waived"] == "single_super_admin" and a["kind"] == "role.permissions_change"
    assert a["summary"] == {"role": "auditor", "added": ["staff.manage"], "removed": []}
    auditor = await env.onboard(me, new_email("aud"), "auditor")
    assert "staff.manage" in auditor.principal["permissions"]
    demote = await env.patch(auditor.actor, root.staff_id, {"role": "support", "reason": "Понижение"})
    assert _err(demote) == (409, "LAST_SUPER_ADMIN")
    disable = await env.patch(auditor.actor, root.staff_id, {"status": "DISABLED", "reason": "Блокировка"})
    assert _err(disable) == (409, "LAST_SUPER_ADMIN")
    # не super_admin не решает заявки
    r = await env.patch(auditor.actor, auditor.staff_id, {"display_name": "Аудитор", "reason": "Имя"})
    assert r.status_code == 200
    actions = await env.actions()
    assert {"role.permissions_requested", "approval.waived", "approval.applied", "staff.updated"} <= set(actions)


async def test_four_eyes_role_grant(env: Env, root: Person, root2: Person) -> None:
    created = await env.onboard(root.actor, new_email("ops"), "support")
    sv = created.principal["session_version"]
    r = await env.patch(root.actor, created.staff_id, {"role": "billing", "reason": "Перевод в биллинг"})
    assert r.status_code == 202, r.text
    a = r.json()["approval"]
    assert a["status"] == "PENDING" and a["waived"] is None and a["kind"] == "staff.role_grant"
    assert a["requested_by"]["staff_id"] == root.staff_id and a["decided_by"] is None
    assert a["summary"]["from_role"] == "support" and a["summary"]["to_role"] == "billing"
    assert (await env.principal(created.staff_id)).json()["staff"]["role"] == "support"  # ещё не применено
    dup = await env.patch(root.actor, created.staff_id, {"role": "operations", "reason": "Ещё одна"})
    assert _err(dup) == (409, "APPROVAL_PENDING")
    same = await env.approve(root.actor, a["approval_id"])
    assert _err(same) == (409, "FOUR_EYES_SAME_PERSON")
    not_super = await env.approve(created.actor, a["approval_id"])
    assert _err(not_super) == (403, "PERMISSION_DENIED")
    ok = await env.approve(root2.actor, a["approval_id"], note="Согласовано")
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "APPLIED" and ok.json()["decided_by"]["staff_id"] == root2.staff_id
    assert ok.json()["decision_note"] == "Согласовано"
    p = (await env.principal(created.staff_id)).json()
    assert p["staff"]["role"] == "billing" and "billing.refund" in p["permissions"]
    assert p["session_version"] == sv + 1
    twice = await env.approve(root2.actor, a["approval_id"])
    assert _err(twice) == (409, "APPROVAL_NOT_PENDING")
    assert _err(await env.approve(root2.actor, str(uuid.uuid4()))) == (404, "APPROVAL_NOT_FOUND")
    # привилегированная роль → при следующем входе обязательное подключение MFA
    assert (await env.login(created.email, created.password)).json()["next"] == "mfa_enroll"
    actions = await env.actions()
    assert {"approval.approved", "approval.applied"} <= set(actions)
    lst = (await env.c.get("/admin/v1/approvals?status=APPLIED", headers=env.h(root.actor))).json()
    assert a["approval_id"] in {x["approval_id"] for x in lst["items"]}


async def test_four_eyes_reject_and_create_privileged(env: Env, root: Person, root2: Person) -> None:
    r = await env.create_staff(root.actor, new_email("bill"), "billing", "Биллинг")
    assert r.status_code == 201
    body = r.json()
    assert body["staff"]["role"] == "read_only" and body["approval"]["status"] == "PENDING"
    assert body["approval"]["kind"] == "staff.create_privileged" and body["temporary_password"]
    rej = await env.approve(root2.actor, body["approval"]["approval_id"], note="Не нужен", action="reject")
    assert rej.status_code == 200 and rej.json()["status"] == "REJECTED"
    p = (await env.principal(body["staff"]["staff_id"])).json()
    assert p["staff"]["role"] == "read_only"
    assert "approval.rejected" in await env.actions()


async def test_approval_expiry(env: Env, root: Person, root2: Person) -> None:
    target = await env.onboard(root.actor, new_email("exp"), "analyst")
    r = await env.patch(root.actor, target.staff_id, {"role": "operations", "reason": "Повышение"})
    aid = r.json()["approval"]["approval_id"]
    expires = r.json()["approval"]["expires_at"]
    requested = r.json()["approval"]["requested_at"]
    from datetime import datetime

    assert (datetime.fromisoformat(expires) - datetime.fromisoformat(requested)).total_seconds() == 72 * 3600
    await env.sql("UPDATE approvals SET expires_at = now() - interval '1 second' WHERE approval_id = :i "
                  "RETURNING approval_id", i=aid)
    late = await env.approve(root2.actor, aid)
    assert _err(late) == (409, "APPROVAL_EXPIRED")
    again = await env.approve(root2.actor, aid)
    assert _err(again) == (409, "APPROVAL_EXPIRED")
    expired = (await env.c.get("/admin/v1/approvals?status=EXPIRED", headers=env.h(root.actor))).json()["items"]
    assert [x["approval_id"] for x in expired] == [aid]
    assert (await env.principal(target.staff_id)).json()["staff"]["role"] == "analyst"
    # после истечения можно подать новую заявку
    new = await env.patch(root.actor, target.staff_id, {"role": "operations", "reason": "Повторно"})
    assert new.status_code == 202 and new.json()["approval"]["status"] == "PENDING"


async def test_waived_when_single_super_admin(env: Env, root: Person) -> None:
    r = await env.create_staff(root.actor, new_email("ops"), "operations")
    a = r.json()["approval"]
    assert a["status"] == "APPLIED" and a["waived"] == "single_super_admin"
    assert r.json()["staff"]["role"] == "operations"
    target = await env.onboard(root.actor, new_email("an"), "analyst")
    up = await env.patch(root.actor, target.staff_id, {"role": "agent_manager", "reason": "Повышение"})
    assert up.status_code == 202 and up.json()["approval"]["waived"] == "single_super_admin"
    assert (await env.principal(target.staff_id)).json()["staff"]["role"] == "agent_manager"
    rec = [e.payload for e in await env.audit() if e.payload["action"] == "approval.waived"]
    assert len(rec) == 2 and rec[0]["actor_id"] == root.staff_id


async def test_role_matrix_update_via_approval(env: Env, root: Person, root2: Person) -> None:
    analyst = await env.onboard(root.actor, new_email("an"), "analyst")
    roles = (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()
    assert [r["code"] for r in roles["items"]] == ["super_admin", "operations", "support", "billing",
                                                     "agent_manager", "analyst", "auditor", "read_only"]
    assert len(roles["permissions"]) == 25
    by = {r["code"]: r for r in roles["items"]}
    assert by["super_admin"]["staff_count"] == 2 and by["analyst"]["staff_count"] == 1
    assert by["operations"]["privileged"] is True and by["support"]["privileged"] is False
    assert by["operations"]["permissions"] == ["dashboard.read", "users.read", "support.read", "audit.read",
                                               "config.read", "ops.kill_switch", "events.review",
                                               "sources.manage", "discovery.manage", "news.manage",
                                               "users.access.manage", "ops.queues.manage"]
    assert by["read_only"]["name"] == {"ru": "Только просмотр", "en": "Read Only"}
    upd = await env.c.put("/admin/v1/roles/analyst",
                          json={"permissions": ["dashboard.read", "users.read", "export.csv"],
                                "reason": "Выгрузки для аналитиков"}, headers=env.h(root.actor))
    assert upd.status_code == 202 and upd.json()["approval"]["status"] == "PENDING"
    assert "export.csv" not in (await env.principal(analyst.staff_id)).json()["permissions"]
    pend = await env.c.put("/admin/v1/roles/analyst", json={"permissions": ["dashboard.read"], "reason": "Ещё"},
                           headers=env.h(root.actor))
    assert _err(pend) == (409, "APPROVAL_PENDING")
    ok = await env.approve(root2.actor, upd.json()["approval"]["approval_id"])
    assert ok.status_code == 200 and ok.json()["status"] == "APPLIED"
    assert "export.csv" in (await env.principal(analyst.staff_id)).json()["permissions"]
    after = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    assert after["analyst"]["updated_by"] == root.staff_id
    sa = await env.c.put("/admin/v1/roles/super_admin", json={"permissions": ["dashboard.read"], "reason": "Сужение"},
                         headers=env.h(root.actor))
    assert _err(sa) == (409, "SUPER_ADMIN_ROLES_MANAGE")
    same = await env.c.put("/admin/v1/roles/analyst",
                           json={"permissions": ["users.read", "dashboard.read", "export.csv"], "reason": "Без изм."},
                           headers=env.h(root.actor))
    assert _err(same) == (409, "ROLE_UNCHANGED")
    unknown = await env.c.put("/admin/v1/roles/ceo", json={"permissions": [], "reason": "Нет"},
                              headers=env.h(root.actor))
    assert _err(unknown) == (404, "ROLE_NOT_FOUND")
    bad_perm = await env.c.put("/admin/v1/roles/analyst", json={"permissions": ["root.all"], "reason": "Нет"},
                               headers=env.h(root.actor))
    assert bad_perm.status_code == 422
    dup_perm = await env.c.put("/admin/v1/roles/analyst",
                               json={"permissions": ["users.read", "users.read"], "reason": "Нет"},
                               headers=env.h(root.actor))
    assert dup_perm.status_code == 422
    rec = next(e.payload for e in await env.audit() if e.payload["action"] == "role.permissions_requested")
    assert rec["object_type"] == "approval" and rec["reason"] == "Выгрузки для аналитиков"


async def test_session_version_grows_and_principal_reflects(env: Env, root: Person, root2: Person) -> None:
    person = await env.onboard(root.actor, new_email("sv"), "support")
    sv = (await env.principal(person.staff_id)).json()["session_version"]
    r = await env.patch(root.actor, person.staff_id, {"role": "analyst", "reason": "Перевод"})
    assert r.status_code == 200 and r.json()["role"] == "analyst"  # непривилегированная — сразу
    p = (await env.principal(person.staff_id)).json()
    assert p["session_version"] == sv + 1 and p["staff"]["role"] == "analyst"
    assert p["permissions"] == ["dashboard.read", "users.read"]
    name = await env.patch(root.actor, person.staff_id, {"display_name": "Новое имя", "reason": "Имя"})
    assert name.status_code == 200
    assert (await env.principal(person.staff_id)).json()["session_version"] == sv + 1  # имя не отзывает сессии
    rp = await env.c.post(f"/admin/v1/staff/{person.staff_id}/reset-password", json={"reason": "Забыл пароль"},
                          headers=env.h(root.actor))
    assert rp.status_code == 200 and len(rp.json()["temporary_password"]) == 20
    assert rp.headers["cache-control"] == "no-store"
    env.leaks.append(rp.json()["temporary_password"])
    p = (await env.principal(person.staff_id)).json()
    assert p["session_version"] == sv + 2 and p["must_change_password"] is True
    old = await env.login(person.email, person.password)
    assert old.status_code == 401
    fresh = await env.login(person.email, rp.json()["temporary_password"])
    assert fresh.json()["next"] == "password_change"
    # понижение второго super_admin (их двое) — только four-eyes (B1): 202 + заявка staff.privileged_revoke
    sv2 = (await env.principal(root2.staff_id)).json()["session_version"]
    dem = await env.patch(root.actor, root2.staff_id, {"role": "read_only", "reason": "Ротация"})
    assert dem.status_code == 202, dem.text
    a = dem.json()["approval"]
    assert a["kind"] == "staff.privileged_revoke" and a["status"] == "PENDING" and a["waived"] is None
    assert a["summary"]["to_role"] == "read_only" and a["summary"]["from_role"] == "super_admin"
    assert (await env.principal(root2.staff_id)).json()["staff"]["role"] == "super_admin"  # ещё не применено
    assert _err(await env.approve(root.actor, a["approval_id"])) == (409, "FOUR_EYES_SAME_PERSON")
    ok = await env.approve(root2.actor, a["approval_id"])
    assert ok.status_code == 200 and ok.json()["status"] == "APPLIED"
    p2 = (await env.principal(root2.staff_id)).json()
    assert p2["staff"]["role"] == "read_only" and p2["session_version"] == sv2 + 1
    off = await env.patch(root.actor, person.staff_id, {"status": "DISABLED", "reason": "Увольнение"})
    assert off.status_code == 200
    gone = await env.principal(person.staff_id)
    assert _err(gone) == (403, "ACCOUNT_DISABLED")
    # отключённый сотрудник не может действовать даже с действительным actor-токеном
    r = await env.create_staff(Actor(id=person.staff_id, role="super_admin", permissions=frozenset({"staff.manage"})),
                               new_email(), "support")
    assert _err(r) == (403, "ACCOUNT_DISABLED")
    actions = await env.actions()
    assert {"staff.updated", "staff.password_reset"} <= set(actions)
    upd = [e.payload for e in await env.audit() if e.payload["action"] == "staff.updated"]
    assert any(p["before"] == {"role": "support"} and p["after"] == {"role": "analyst"} and p["reason"] == "Перевод"
               for p in upd)
