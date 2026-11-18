"""Дефекты независимого ревью: B1 (обход four-eyes через понижение super_admin), M1 (перебор TOTP новыми
challenge), M2 (привилегированность роли по правам), MINOR 1/4/5/6/7."""

from __future__ import annotations

import hashlib
import hmac

from aid_testkit import ROOT_EMAIL, ROOT_PASSWORD, Env, Person, bad_code, code_at, new_email

from tilhero_common.internal_auth import Actor


def _err(r) -> tuple[int, str]:
    return r.status_code, r.json()["code"]


# ---------------------------------------------------------------- B1

async def test_b1_super_admin_revoke_needs_four_eyes_and_blocks_waiver(env: Env, root: Person,
                                                                      root2: Person) -> None:
    an = await env.onboard(root.actor, new_email("an"), "analyst")
    # заявка root2, которая должна отклониться при его отключении (MINOR 5)
    b_req = await env.patch(root2.actor, an.staff_id, {"role": "billing", "reason": "Повышение от B"})
    assert b_req.status_code == 202 and b_req.json()["approval"]["status"] == "PENDING"
    # A отключает B — не сразу, а заявкой; B по-прежнему активный super_admin
    r = await env.patch(root.actor, root2.staff_id, {"status": "DISABLED", "reason": "Ротация"})
    assert r.status_code == 202, r.text
    a = r.json()["approval"]
    assert a["kind"] == "staff.privileged_revoke" and a["status"] == "PENDING" and a["waived"] is None
    assert a["summary"]["status"] == "DISABLED"
    assert (await env.principal(root2.staff_id)).json()["status"] == "ACTIVE"
    assert _err(await env.approve(root.actor, a["approval_id"])) == (409, "FOUR_EYES_SAME_PERSON")
    dup = await env.patch(root.actor, root2.staff_id, {"role": "support", "reason": "Ещё"})
    assert _err(dup) == (409, "APPROVAL_PENDING")
    ok = await env.approve(root2.actor, a["approval_id"])
    assert ok.status_code == 200 and ok.json()["status"] == "APPLIED"
    assert _err(await env.principal(root2.staff_id)) == (403, "ACCOUNT_DISABLED")
    # заявки отключённого автора → REJECTED
    lst = (await env.c.get("/admin/v1/approvals?status=REJECTED", headers=env.h(root.actor))).json()["items"]
    rej = next(x for x in lst if x["approval_id"] == b_req.json()["approval"]["approval_id"])
    # отклонение фиксируется за тем, кто применил отключение (согласовавший заявку root2)
    assert rej["decision_note"] == "Автор заявки отключён" and rej["decided_by"]["staff_id"] == root2.staff_id
    # A теперь единственный, но сам только что отключал super_admin → исключение single_super_admin не действует
    c = await env.create_staff(root.actor, new_email("ops"), "operations")
    assert c.json()["approval"]["status"] == "PENDING" and c.json()["approval"]["waived"] is None
    assert c.json()["staff"]["role"] == "read_only"
    g = await env.patch(root.actor, an.staff_id, {"role": "billing", "reason": "Повышение"})
    assert g.status_code == 202 and g.json()["approval"]["status"] == "PENDING"
    # спустя 72 ч исключение снова действует
    await env.sql("UPDATE approvals SET decided_at = now() - interval '73 hours' WHERE approval_id = :i "
                  "RETURNING approval_id", i=a["approval_id"])
    later = await env.create_staff(root.actor, new_email("ops2"), "operations")
    assert later.json()["approval"]["waived"] == "single_super_admin"
    actions = await env.actions()
    assert "approval.rejected" in actions


async def test_b1_role_change_of_super_admin_also_needs_approval(env: Env, root: Person, root2: Person) -> None:
    r = await env.patch(root.actor, root2.staff_id, {"role": "operations", "reason": "Сужение прав"})
    assert r.status_code == 202 and r.json()["approval"]["kind"] == "staff.privileged_revoke"
    # объект изменился (стал не super_admin другим путём) → применить нельзя
    await env.sql("UPDATE staff SET role = 'auditor' WHERE staff_id = :i RETURNING staff_id", i=root2.staff_id)
    third = await env.onboard(root.actor, new_email("sa3"), "support")
    await env.sql("UPDATE staff SET role = 'super_admin' WHERE staff_id = :i RETURNING staff_id", i=third.staff_id)
    third = await env.refresh(third)
    late = await env.approve(third.actor, r.json()["approval"]["approval_id"])
    assert _err(late) == (409, "APPROVAL_NOT_APPLICABLE")


# ---------------------------------------------------------------- M1

async def test_m1_totp_limit_is_per_staff_across_challenges(env: Env, root: Person, root2: Person) -> None:
    assert root.secret
    bad = bad_code(root.secret)
    await env.reset_last_step(root.staff_id)
    ch1 = (await env.login(root.email, root.password)).json()["challenge"]
    for left in (4, 3, 2, 1):
        assert (await env.post("/auth/mfa/verify", {"challenge": ch1, "code": bad})).json()["details"] == {
            "remaining": left}
    # новый challenge после верного пароля не обнуляет счётчик
    ch2 = (await env.login(root.email, root.password)).json()["challenge"]
    r = await env.post("/auth/mfa/verify", {"challenge": ch2, "code": bad})
    assert _err(r) == (423, "MFA_LOCKED")
    ch3 = (await env.login(root.email, root.password)).json()["challenge"]
    assert _err(await env.post("/auth/mfa/verify", {"challenge": ch3, "code": code_at(root.secret)})) == (
        423, "MFA_LOCKED")
    # попытки во время блокировки не пишутся в аудит (MINOR 7)
    before = len(await env.audit())
    for _ in range(5):
        await env.post("/auth/mfa/verify", {"challenge": ch3, "code": bad})
        await env.post("/auth/step-up", {"staff_id": root.staff_id, "code": bad})
    assert len(await env.audit()) == before
    # разблокировка администратором снимает и блокировку MFA
    ok = await env.patch(root2.actor, root.staff_id, {"status": "ACTIVE", "reason": "Разблокировка"})
    assert ok.status_code == 200
    r = await env.post("/auth/mfa/verify", {"challenge": ch3, "code": code_at(root.secret)})
    assert r.status_code == 200 and r.json()["next"] == "done"


async def test_m1_success_resets_and_enroll_shares_counter(env: Env, root: Person) -> None:
    assert root.secret
    bad = bad_code(root.secret)
    await env.reset_last_step(root.staff_id)
    for _ in range(4):
        await env.post("/auth/step-up", {"staff_id": root.staff_id, "code": bad})
    assert (await env.post("/auth/step-up", {"staff_id": root.staff_id, "code": code_at(root.secret)})
            ).status_code == 200  # успех сбрасывает счётчик
    ch = (await env.login(root.email, root.password)).json()["challenge"]
    r = await env.post("/auth/mfa/verify", {"challenge": ch, "code": bad})
    assert r.json()["details"] == {"remaining": 4}
    # подключение MFA: тот же счётчик по staff_id
    email = new_email("ops")
    created = await env.create_staff(root.actor, email, "operations")  # root один → waived
    step = (await env.login(email, created.json()["temporary_password"])).json()
    step = (await env.post("/auth/password", {"challenge": step["challenge"], "new_password": "Ops-Passw0rd-123"})
            ).json()
    secret = (await env.post("/auth/mfa/enroll/start", {"challenge": step["challenge"]})).json()["secret"]
    eb = bad_code(secret)
    for _ in range(4):
        await env.post("/auth/mfa/enroll/confirm", {"challenge": step["challenge"], "code": eb})
    r = await env.post("/auth/mfa/enroll/confirm", {"challenge": step["challenge"], "code": eb})
    assert _err(r) == (423, "MFA_LOCKED")
    rec = [e.payload["after"] for e in await env.audit() if e.payload["action"] == "auth.locked"]
    assert {"context": "mfa_enroll", "lock_seconds": 900} in rec


# ---------------------------------------------------------------- M2

async def test_m2_role_with_sensitive_permission_becomes_privileged(env: Env, root: Person, root2: Person) -> None:
    sup = await env.onboard(root.actor, new_email("sup"), "support")
    assert sup.secret is None
    sv = sup.principal["session_version"]
    upd = await env.c.put("/admin/v1/roles/support",
                          json={"permissions": ["dashboard.read", "users.read", "support.read", "support.reply",
                                                "users.sensitive.read"], "reason": "Раскрытие ID для поддержки"},
                          headers=env.h(root.actor))
    assert upd.status_code == 202
    assert (await env.approve(root2.actor, upd.json()["approval"]["approval_id"])).status_code == 200
    roles = {r["code"]: r for r in (await env.c.get("/admin/v1/roles", headers=env.h(root.actor))).json()["items"]}
    assert roles["support"]["privileged"] is True
    assert (await env.sql("SELECT privileged FROM roles WHERE code = 'support'"))[0][0] is True
    # сессии сотрудников роли отозваны, при входе — обязательное подключение MFA
    p = (await env.principal(sup.staff_id)).json()
    assert p["session_version"] == sv + 1
    assert (await env.login(sup.email, sup.password)).json()["next"] == "mfa_enroll"
    # назначение такой роли — four-eyes
    c = await env.create_staff(root.actor, new_email("sup2"), "support")
    assert c.json()["approval"]["kind"] == "staff.create_privileged" and c.json()["approval"]["status"] == "PENDING"
    an = await env.onboard(root.actor, new_email("an"), "analyst")
    g = await env.patch(root.actor, an.staff_id, {"role": "support", "reason": "Перевод"})
    assert g.status_code == 202 and g.json()["approval"]["kind"] == "staff.role_grant"


# ---------------------------------------------------------------- MINOR

async def test_minor1_email_hash_is_keyed_hmac(env: Env) -> None:
    email = "victim@tilhero.test"
    await env.login(email, "Wrong-passw0rd-xx")
    rec = next(e.payload for e in await env.audit() if e.payload["action"] == "auth.login_failed")
    h = rec["after"]["email_hash"]
    assert h != hashlib.sha256(email.encode()).hexdigest() and len(h) == 64
    idn = env.app.state.identity
    assert h == idn.email_subject(" Victim@TilHero.test ")
    assert h != hmac.new(b"other-key" * 4, email.encode(), hashlib.sha256).hexdigest()
    assert env.runtime.redis is not None
    assert [k async for k in env.runtime.redis.scan_iter(match=f"{env.settings.redis_namespace}:login:*{h}")]


async def test_minor4_permissions_come_from_db_role(env: Env, root: Person) -> None:
    sup = await env.onboard(root.actor, new_email("sup"), "support")
    forged = Actor(id=sup.staff_id, role="super_admin", permissions=frozenset({"staff.manage", "roles.manage"}),
                   name="x")
    for method, path, body in (
        ("GET", "/admin/v1/staff", None),
        ("POST", "/admin/v1/staff", {"email": new_email(), "display_name": "X", "role": "read_only"}),
        ("GET", "/admin/v1/roles", None),
        ("GET", "/admin/v1/approvals", None),
        ("POST", f"/admin/v1/staff/{root.staff_id}/reset-mfa", {"reason": "Захват"}),
    ):
        r = await env.c.request(method, path, json=body, headers=env.h(forged))
        assert _err(r) == (403, "PERMISSION_DENIED"), path
    # токен может только сузить права (dev-имперсонация admin-bff)
    narrowed = Actor(id=root.staff_id, role="read_only", permissions=frozenset({"dashboard.read"}), name="Root")
    assert _err(await env.c.get("/admin/v1/staff", headers=env.h(narrowed))) == (403, "PERMISSION_DENIED")


async def test_minor5_approval_of_inactive_author_not_applicable(env: Env, root: Person, root2: Person) -> None:
    an = await env.onboard(root.actor, new_email("an"), "analyst")
    r = await env.patch(root2.actor, an.staff_id, {"role": "billing", "reason": "Повышение"})
    aid = r.json()["approval"]["approval_id"]
    # автор отключён в обход API (например, вручную) — согласовать нельзя, отклонить можно
    await env.sql("UPDATE staff SET status = 'DISABLED' WHERE staff_id = :i RETURNING staff_id", i=root2.staff_id)
    assert _err(await env.approve(root.actor, aid)) == (409, "APPROVAL_NOT_APPLICABLE")
    rej = await env.approve(root.actor, aid, action="reject")
    assert rej.status_code == 200 and rej.json()["status"] == "REJECTED"
    # обычное отключение (не super_admin) отклоняет PENDING-заявки автора сразу
    await env.sql("UPDATE staff SET status = 'ACTIVE' WHERE staff_id = :i RETURNING staff_id", i=root2.staff_id)
    await env.c.put("/admin/v1/roles/auditor", json={"permissions": ["dashboard.read", "audit.read", "staff.manage"],
                                                     "reason": "Учётки"}, headers=env.h(root.actor))
    aid2 = (await env.c.get("/admin/v1/approvals?status=PENDING", headers=env.h(root.actor))).json()["items"][0]
    assert (await env.approve(root2.actor, aid2["approval_id"])).status_code == 200
    aud = await env.onboard(root.actor, new_email("aud"), "support")
    await env.sql("UPDATE staff SET role = 'auditor' WHERE staff_id = :i RETURNING staff_id", i=aud.staff_id)
    aud = await env.refresh(aud)
    ro = await env.create_staff(aud.actor, new_email("ro"), "read_only")
    req = await env.patch(aud.actor, ro.json()["staff"]["staff_id"], {"role": "billing", "reason": "Повышение"})
    assert req.status_code == 202
    off = await env.patch(root.actor, aud.staff_id, {"status": "DISABLED", "reason": "Увольнение"})
    assert off.status_code == 200
    got = (await env.c.get("/admin/v1/approvals?status=REJECTED", headers=env.h(root.actor))).json()["items"]
    assert req.json()["approval"]["approval_id"] in {x["approval_id"] for x in got}


async def test_minor6_bootstrap_password_expires_and_is_reissued(env_factory) -> None:
    env = await env_factory()
    await env.sql("UPDATE staff SET temp_password_expires_at = now() - interval '1 minute' RETURNING staff_id")
    r = await env.login(ROOT_EMAIL, ROOT_PASSWORD)
    assert _err(r) == (401, "TEMPORARY_PASSWORD_EXPIRED")
    env2 = await env_factory()  # повторный старт: учётка — единственный super_admin, вход не выполнен → новый срок
    hours = (await env2.sql("SELECT extract(epoch FROM temp_password_expires_at - now()) / 3600 FROM staff"))[0][0]
    assert 71 < float(hours) <= 72
    assert (await env2.login(ROOT_EMAIL, ROOT_PASSWORD)).json()["next"] == "password_change"
    boot = [e.payload["after"] for e in await env2.audit() if e.payload["action"] == "staff.bootstrap"]
    assert boot == [{"refreshed": True, "password_ttl_hours": 72}]


async def test_minor7_failed_logins_after_lock_are_not_audited(env: Env, root: Person) -> None:
    for _ in range(5):
        await env.login(root.email, "Wrong-passw0rd-xx")
    events = await env.audit()
    assert [e.payload["action"] for e in events].count("auth.locked") == 1
    n = len(events)
    for i in range(10):
        r = await env.login(root.email if i % 2 else new_email("x"), "Wrong-passw0rd-xx")
        assert r.status_code in (401, 423)
    after = await env.audit()
    # для заблокированного email — ни одной записи; для 5 разных неизвестных email — по одной
    extra = [e.payload["action"] for e in after[n:]]
    assert extra == ["auth.login_failed"] * 5
