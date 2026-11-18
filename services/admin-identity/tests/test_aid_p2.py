"""Регресс ревью спринта 2 (docs/qa/sprint2-review-python.md): P2-1 — автор создания или повышения не владеет
учётными данными цели после применения заявки (пароль и MFA сбрасываются, пароль — решающему); P2-2 — включение
отключённого сотрудника с привилегированной ролью — только four-eyes (staff.reactivate_privileged)."""

from __future__ import annotations

import json

from aid_testkit import Env, Person, code_at, new_email
from sqlalchemy import text


def _err(r) -> tuple[int, str]:
    return r.status_code, r.json()["code"]


async def _no_secret(env: Env, secret: str) -> None:
    dump = json.dumps([e.payload for e in await env.audit()], ensure_ascii=False)
    async with env.runtime.transaction() as s:
        outbox = json.dumps([r[0] for r in (await s.execute(text("SELECT envelope FROM outbox"))).all()],
                            ensure_ascii=False)
    assert secret not in dump and secret not in outbox


# ---------------------------------------------------------------- P2-1

async def test_p2_1_creator_cannot_own_new_super_admin(env: Env, root: Person, root2: Person) -> None:
    """Сценарий ревью: A создаёт super_admin «призрака», входит под ним до согласования, B согласует, A подаёт
    заявку и согласует её «призраком». Теперь: пароль автору не выдаётся, войти под заглушкой нельзя; даже получив
    пароль заглушки обходным путём (прямой сброс read_only), после согласования A его теряет."""
    email = new_email("ghost")
    c = await env.create_staff(root.actor, email, "super_admin", "Ghost")
    assert c.status_code == 201 and c.json()["temporary_password"] is None
    approval = c.json()["approval"]
    assert approval["kind"] == "staff.create_privileged" and approval["status"] == "PENDING"
    ghost_id = c.json()["staff"]["staff_id"]
    assert (await env.login(email, "Any-Guess-Passw0rd")).status_code == 401  # у заглушки нет пароля
    # обход: заглушка read_only непривилегированная — автор сбрасывает ей пароль прямой командой и входит
    rp = await env.c.post(f"/admin/v1/staff/{ghost_id}/reset-password", json={"reason": "Обход"},
                          headers=env.h(root.actor))
    assert rp.status_code == 200
    owned = await env.first_login(email, rp.json()["temporary_password"], new_password="Ghost-Owned-Passw0rd")
    assert owned.principal["staff"]["role"] == "read_only"
    sv = owned.principal["session_version"]
    # B согласует: учётные данные выпускаются заново и отдаются только решающему
    ok = await env.approve(root2.actor, approval["approval_id"])
    assert ok.status_code == 200 and ok.json()["status"] == "APPLIED" and ok.headers["cache-control"] == "no-store"
    temp = ok.json()["temporary_password"]
    env.leaks.append(temp)
    p = (await env.principal(ghost_id)).json()
    assert p["staff"]["role"] == "super_admin" and p["must_change_password"] is True and p["mfa_enabled"] is False
    assert p["session_version"] > sv  # сессии автора под целью отозваны
    assert (await env.login(email, "Ghost-Owned-Passw0rd")).status_code == 401
    step = (await env.login(email, temp)).json()
    assert step["next"] == "password_change"
    # список заявок, повтор решения, аудит и outbox — без пароля
    lst = await env.c.get("/admin/v1/approvals?status=APPLIED", headers=env.h(root.actor))
    assert temp not in lst.text
    assert _err(await env.approve(root2.actor, approval["approval_id"])) == (409, "APPROVAL_NOT_PENDING")
    await _no_secret(env, temp)
    rec = [e.payload for e in await env.audit()
           if e.payload["action"] == "staff.credentials_reset" and e.payload["object_id"] == ghost_id]
    assert len(rec) == 1 and rec[0]["actor_id"] == root2.staff_id
    assert rec[0]["after"]["cause"] == "staff.create_privileged"
    assert rec[0]["after"]["approval_id"] == approval["approval_id"]


async def test_p2_1_role_grant_resets_password_and_mfa(env: Env, root: Person, root2: Person) -> None:
    """Повышение: кто знал пароль и TOTP цели (operations с MFA), после согласования повышения их теряет."""
    ops = await env.onboard(root.actor, new_email("ops"), "operations", approver=root2.actor)
    assert ops.secret is not None
    old_secret = ops.secret
    r = await env.patch(root.actor, ops.staff_id, {"role": "communications", "reason": "Перевод"})
    assert r.status_code == 202 and r.json()["approval"]["kind"] == "staff.role_grant"
    assert "temporary_password" not in r.json()  # PENDING — пароль ещё не выпущен
    await env.reset_last_step(ops.staff_id)
    assert (await env.login(ops.email, ops.password)).json()["next"] == "mfa"  # до согласования ничего не меняется
    ok = await env.approve(root2.actor, r.json()["approval"]["approval_id"])
    assert ok.status_code == 200
    temp = ok.json()["temporary_password"]
    env.leaks.append(temp)
    p = (await env.principal(ops.staff_id)).json()
    assert p["staff"]["role"] == "communications" and p["mfa_enabled"] is False
    assert (await env.sql("SELECT mfa_secret_enc FROM staff WHERE staff_id = :i", i=ops.staff_id))[0][0] is None
    assert (await env.login(ops.email, ops.password)).status_code == 401
    fresh = await env.first_login(ops.email, temp, new_password="Comm-Fresh-Passw0rd")
    assert fresh.secret is not None and fresh.secret != old_secret  # TOTP подключён заново
    # код старого секрета больше не подходит
    await env.reset_last_step(ops.staff_id)
    old_code = code_at(old_secret)
    if old_code not in {code_at(fresh.secret, d) for d in (-1, 0, 1)}:
        r = await env.post("/auth/step-up", {"staff_id": ops.staff_id, "code": old_code})
        assert _err(r) == (401, "MFA_INVALID")


async def test_p2_1_waived_grant_gives_password_to_sole_author(env: Env, root: Person) -> None:
    """Пока super_admin один, заявки применяются сразу: пароль цели — автору (он же единственный решающий)."""
    sup = await env.onboard(root.actor, new_email("sup"), "support")
    r = await env.patch(root.actor, sup.staff_id, {"role": "operations", "reason": "Повышение"})
    assert r.status_code == 202 and r.json()["approval"]["status"] == "APPLIED"
    assert r.json()["approval"]["waived"] == "single_super_admin"
    temp = r.json()["temporary_password"]
    env.leaks.append(temp)
    assert (await env.login(sup.email, sup.password)).status_code == 401
    person = await env.first_login(sup.email, temp, new_password="Ops-Fresh-Passw0rd1")
    assert person.principal["staff"]["role"] == "operations" and person.secret is not None
    created = await env.create_staff(root.actor, new_email("sa"), "super_admin")
    assert created.json()["approval"]["waived"] == "single_super_admin" and created.json()["temporary_password"]
    env.leaks.append(created.json()["temporary_password"])
    await _no_secret(env, temp)


# ---------------------------------------------------------------- P2-2

async def test_p2_2_reenable_disabled_super_admin_needs_four_eyes(env: Env, root: Person, root2: Person) -> None:
    """Сценарий ревью: A и B по four-eyes отключили C; A один включает C обратно → теперь только заявка; при
    применении у C сброшены пароль, MFA и сессии, пароль — решающему."""
    third = await env.onboard(root.actor, new_email("root3"), "super_admin", "Third", approver=root2.actor)
    off = await env.patch(root.actor, third.staff_id, {"status": "DISABLED", "reason": "Уволен"})
    assert off.status_code == 202 and off.json()["approval"]["kind"] == "staff.privileged_revoke"
    assert (await env.approve(root2.actor, off.json()["approval"]["approval_id"])).status_code == 200
    assert (await env.c.get(f"/admin/v1/staff/{third.staff_id}", headers=env.h(root.actor))).json()["status"] == \
        "DISABLED"
    back = await env.patch(root.actor, third.staff_id, {"status": "ACTIVE", "reason": "Вернул"})
    assert back.status_code == 202, back.text
    a = back.json()["approval"]
    assert a["kind"] == "staff.reactivate_privileged" and a["status"] == "PENDING" and a["waived"] is None
    assert a["summary"]["role"] == "super_admin" and a["summary"]["from_status"] == "DISABLED"
    assert "temporary_password" not in back.json()
    st = await env.c.get(f"/admin/v1/staff/{third.staff_id}", headers=env.h(root.actor))
    assert st.json()["status"] == "DISABLED"  # не применено
    assert _err(await env.principal(third.staff_id)) == (403, "ACCOUNT_DISABLED")
    assert _err(await env.approve(root.actor, a["approval_id"])) == (409, "FOUR_EYES_SAME_PERSON")
    dup = await env.patch(root2.actor, third.staff_id, {"status": "ACTIVE", "reason": "Ещё раз"})
    assert _err(dup) == (409, "APPROVAL_PENDING")
    ok = await env.approve(root2.actor, a["approval_id"])
    assert ok.status_code == 200 and ok.json()["status"] == "APPLIED"
    temp = ok.json()["temporary_password"]
    env.leaks.append(temp)
    p = (await env.principal(third.staff_id)).json()
    assert p["status"] == "ACTIVE" and p["staff"]["role"] == "super_admin"
    assert p["mfa_enabled"] is False and p["must_change_password"] is True
    assert (await env.login(third.email, third.password)).status_code == 401  # прежний пароль не действует
    again = await env.first_login(third.email, temp, new_password="Third-Fresh-Passw0rd")
    assert again.secret is not None and again.secret != third.secret
    upd = [e.payload for e in await env.audit() if e.payload["action"] == "staff.updated"
           and e.payload["object_id"] == third.staff_id and (e.payload["after"] or {}).get("status") == "ACTIVE"]
    assert len(upd) == 1 and upd[0]["actor_id"] == root2.staff_id and upd[0]["before"]["status"] == "DISABLED"
    await _no_secret(env, temp)


async def test_p2_2_no_waiver_after_recent_revoke(env: Env, root: Person, root2: Person) -> None:
    """A сам отключил B (заявка, B согласовал) и остался единственным: включить B одной командой нельзя — заявка
    висит без waived; через 72 ч исключение single_super_admin снова действует, пароль — автору."""
    off = await env.patch(root.actor, root2.staff_id, {"status": "DISABLED", "reason": "Ротация"})
    assert (await env.approve(root2.actor, off.json()["approval"]["approval_id"])).status_code == 200
    back = await env.patch(root.actor, root2.staff_id, {"status": "ACTIVE", "reason": "Вернул"})
    assert back.status_code == 202 and back.json()["approval"]["status"] == "PENDING"
    assert back.json()["approval"]["waived"] is None and "temporary_password" not in back.json()
    assert _err(await env.principal(root2.staff_id)) == (403, "ACCOUNT_DISABLED")
    # прошло 72 ч: заявка истекла, отключение — давно
    await env.sql("UPDATE approvals SET decided_at = now() - interval '73 hours' WHERE approval_id = :i "
                  "RETURNING approval_id", i=off.json()["approval"]["approval_id"])
    await env.sql("UPDATE approvals SET expires_at = now() - interval '1 second' WHERE approval_id = :i "
                  "RETURNING approval_id", i=back.json()["approval"]["approval_id"])
    later = await env.patch(root.actor, root2.staff_id, {"status": "ACTIVE", "reason": "Вернул"})
    assert later.status_code == 202 and later.json()["approval"]["waived"] == "single_super_admin"
    temp = later.json()["temporary_password"]
    env.leaks.append(temp)
    assert (await env.principal(root2.staff_id)).json()["status"] == "ACTIVE"
    assert (await env.login(root2.email, root2.password)).status_code == 401
    assert (await env.login(root2.email, temp)).json()["next"] == "password_change"


async def test_p2_2_other_privileged_roles_and_direct_paths(env: Env, root: Person, root2: Person) -> None:
    """operations/communications — тоже заявкой (с ролью из той же команды); непривилегированный — сразу;
    разблокировка входа у ACTIVE — прямой командой; объект изменился — заявку не применить."""
    ops = await env.onboard(root.actor, new_email("ops"), "operations", approver=root2.actor)
    assert (await env.patch(root.actor, ops.staff_id, {"status": "DISABLED", "reason": "Отпуск"})).status_code == 200
    # включение с понижением до support в той же команде — всё равно заявка (текущая роль привилегированная)
    r = await env.patch(root.actor, ops.staff_id, {"status": "ACTIVE", "role": "support", "reason": "Вернулся"})
    assert r.status_code == 202 and r.json()["approval"]["kind"] == "staff.reactivate_privileged"
    assert r.json()["approval"]["summary"]["to_role"] == "support"
    ok = await env.approve(root2.actor, r.json()["approval"]["approval_id"])
    assert ok.status_code == 200 and ok.json()["temporary_password"]
    env.leaks.append(ok.json()["temporary_password"])
    p = (await env.principal(ops.staff_id)).json()
    assert (p["status"], p["staff"]["role"], p["mfa_enabled"]) == ("ACTIVE", "support", False)
    # непривилегированный → привилегированный при включении: тоже заявка (покрывает повышение)
    sup = await env.onboard(root.actor, new_email("sup"), "support")
    assert (await env.patch(root.actor, sup.staff_id, {"status": "DISABLED", "reason": "Отпуск"})).status_code == 200
    r = await env.patch(root.actor, sup.staff_id, {"status": "ACTIVE", "role": "communications", "reason": "Повыш."})
    assert r.status_code == 202 and r.json()["approval"]["kind"] == "staff.reactivate_privileged"
    # объект изменился до решения (роль сменили напрямую в БД) — применить нельзя
    await env.sql("UPDATE staff SET role = 'analyst' WHERE staff_id = :i RETURNING staff_id", i=sup.staff_id)
    assert _err(await env.approve(root2.actor, r.json()["approval"]["approval_id"])) == (
        409, "APPROVAL_NOT_APPLICABLE")
    # непривилегированного включают сразу
    an = await env.onboard(root.actor, new_email("an"), "analyst")
    assert (await env.patch(root.actor, an.staff_id, {"status": "DISABLED", "reason": "Отпуск"})).status_code == 200
    on = await env.patch(root.actor, an.staff_id, {"status": "ACTIVE", "reason": "Вернулся"})
    assert on.status_code == 200 and on.json()["status"] == "ACTIVE"
    assert (await env.login(an.email, an.password)).json()["next"] == "done"  # пароль прежний
    # разблокировка входа активного привилегированного — прямой командой, без заявки и сброса пароля
    for _ in range(5):
        await env.login(root2.email, "Wrong-passw0rd-xx")
    unlock = await env.patch(root.actor, root2.staff_id, {"status": "ACTIVE", "reason": "Разблокировка"})
    assert unlock.status_code == 200 and unlock.json()["status"] == "ACTIVE"
    await env.reset_last_step(root2.staff_id)
    assert (await env.login(root2.email, root2.password)).json()["next"] == "mfa"
    # не super_admin со staff.manage не включает привилегированного (эскалация) — 403, без заявки
    await env.c.put("/admin/v1/roles/auditor", json={"permissions": ["dashboard.read", "audit.read", "staff.manage"],
                                                     "reason": "Учётки"}, headers=env.h(root.actor))
    pend = (await env.c.get("/admin/v1/approvals?status=PENDING", headers=env.h(root.actor))).json()["items"]
    matrix = next(x for x in pend if x["kind"] == "role.permissions_change")
    assert (await env.approve(root2.actor, matrix["approval_id"])).status_code == 200
    aud = await env.onboard(root.actor, new_email("aud"), "auditor", approver=root2.actor)
    assert (await env.patch(root.actor, ops.staff_id, {"status": "DISABLED", "reason": "Снова"})).status_code == 200
    r = await env.patch(aud.actor, ops.staff_id, {"status": "ACTIVE", "reason": "Попытка"})
    assert _err(r) == (403, "PERMISSION_DENIED")
