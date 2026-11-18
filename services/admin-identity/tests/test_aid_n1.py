"""Ревью N1: один super_admin не может захватить учётку другого через reset-password + reset-mfa;
временный пароль получает только решающий. MINOR 7: агрегирование auth.login_failed."""

from __future__ import annotations

import json

from aid_testkit import Env, Person, new_email
from sqlalchemy import text


def _err(r) -> tuple[int, str]:
    return r.status_code, r.json()["code"]


async def _third_super_admin(env: Env, root: Person, root2: Person) -> Person:
    email = new_email("sa3")
    c = await env.create_staff(root.actor, email, "super_admin", "Third Admin")
    assert c.json()["approval"]["status"] == "PENDING"
    assert (await env.approve(root2.actor, c.json()["approval"]["approval_id"])).status_code == 200
    return await env.first_login(email, c.json()["temporary_password"])


async def _dump(env: Env) -> str:
    events = json.dumps([e.payload for e in await env.audit()], ensure_ascii=False)
    async with env.runtime.transaction() as s:
        outbox = json.dumps([r[0] for r in (await s.execute(text("SELECT envelope FROM outbox"))).all()],
                            ensure_ascii=False)
    return events + outbox


async def test_n1_super_admin_cannot_take_over_another(env: Env, root: Person, root2: Person) -> None:
    c = await _third_super_admin(env, root, root2)
    h = env.h(root.actor)
    # A (root) сбрасывает пароль B (root2) — только заявка, пароль автору не выдаётся
    r = await env.c.post(f"/admin/v1/staff/{root2.staff_id}/reset-password", json={"reason": "Забыл пароль"},
                         headers=h)
    assert r.status_code == 202 and r.headers["cache-control"] == "no-store"
    a = r.json()["approval"]
    assert "temporary_password" not in r.json() and "temporary_password" not in json.dumps(a)
    assert a["kind"] == "staff.privileged_reset" and a["status"] == "PENDING" and a["waived"] is None
    assert a["summary"]["action"] == "password" and a["summary"]["staff"]["staff_id"] == root2.staff_id
    # ничего не применено: B входит старым паролем, сессии не отозваны
    sv = (await env.principal(root2.staff_id)).json()["session_version"]
    await env.reset_last_step(root2.staff_id)
    assert (await env.login(root2.email, root2.password)).json()["next"] == "mfa"
    # reset-mfa той же цели, пока заявка открыта, — 409; сам A решить не может
    mfa = await env.c.post(f"/admin/v1/staff/{root2.staff_id}/reset-mfa", json={"reason": "Телефон"}, headers=h)
    assert _err(mfa) == (409, "APPROVAL_PENDING")
    assert _err(await env.approve(root.actor, a["approval_id"])) == (409, "FOUR_EYES_SAME_PERSON")
    # решает второй человек (C) — временный пароль получает только он, один раз
    ok = await env.approve(c.actor, a["approval_id"], note="Подтверждаю по звонку")
    assert ok.status_code == 200 and ok.headers["cache-control"] == "no-store"
    body = ok.json()
    temp = body["temporary_password"]
    assert body["status"] == "APPLIED" and len(temp) == 20 and body["decided_by"]["staff_id"] == c.staff_id
    env.leaks.append(temp)
    p = (await env.principal(root2.staff_id)).json()
    assert p["session_version"] == sv + 1 and p["must_change_password"] is True
    assert (await env.login(root2.email, root2.password)).status_code == 401
    assert (await env.login(root2.email, temp)).json()["next"] == "password_change"
    # пароль больше нигде: ни в списке заявок, ни в повторном решении, ни в аудите/outbox, ни в Redis
    lst = await env.c.get("/admin/v1/approvals?status=APPLIED", headers=h)
    assert temp not in lst.text and "temporary_password" not in lst.text
    again = await env.approve(c.actor, a["approval_id"])
    assert _err(again) == (409, "APPROVAL_NOT_PENDING") and temp not in again.text
    assert temp not in await _dump(env)
    assert env.runtime.redis is not None
    async for k in env.runtime.redis.scan_iter(match=f"*{env.settings.redis_namespace}*"):
        if await env.runtime.redis.type(k) == "string":
            assert temp not in (await env.runtime.redis.get(k) or "")
    stored = (await env.sql("SELECT password_hash FROM staff WHERE staff_id = :i", i=root2.staff_id))[0][0]
    assert stored.startswith("$argon2id$") and temp not in stored
    rec = next(e.payload for e in await env.audit() if e.payload["action"] == "staff.password_reset")
    assert rec["actor_id"] == c.staff_id and rec["after"]["approval_id"] == a["approval_id"]
    # сброс MFA привилегированной цели — тоже заявкой; в ответе решения пароля нет
    m = await env.c.post(f"/admin/v1/staff/{root2.staff_id}/reset-mfa", json={"reason": "Телефон"}, headers=h)
    assert m.status_code == 202 and m.json()["approval"]["summary"]["action"] == "mfa"
    mo = await env.approve(c.actor, m.json()["approval"]["approval_id"])
    assert mo.status_code == 200 and "temporary_password" not in mo.json()
    assert (await env.principal(root2.staff_id)).json()["mfa_enabled"] is False


async def test_n1_no_waiver_for_super_admin_target(env: Env, root: Person, root2: Person) -> None:
    ops_email = new_email("ops")
    c = await env.create_staff(root.actor, ops_email, "operations")  # двое super_admin → заявка
    assert (await env.approve(root2.actor, c.json()["approval"]["approval_id"])).status_code == 200
    ops_id = c.json()["staff"]["staff_id"]
    env.leaks.append(c.json()["temporary_password"])
    # уже входил — перевыпуск автором до первого входа здесь не применяется, проверяем именно исключение waived
    await env.first_login(ops_email, c.json()["temporary_password"])
    off = await env.patch(root.actor, root2.staff_id, {"status": "DISABLED", "reason": "Отпуск"})
    assert (await env.approve(root2.actor, off.json()["approval"]["approval_id"])).status_code == 200
    await env.sql("UPDATE approvals SET decided_at = now() - interval '73 hours' RETURNING approval_id")
    await env.patch(root.actor, root2.staff_id, {"status": "ACTIVE", "reason": "Вернулся"})
    await env.sql("UPDATE staff SET status = 'DISABLED' WHERE staff_id = :i RETURNING staff_id", i=root2.staff_id)
    # root — единственный активный super_admin; цель — super_admin → исключение не действует никогда
    r = await env.c.post(f"/admin/v1/staff/{root2.staff_id}/reset-password", json={"reason": "Сброс"},
                         headers=env.h(root.actor))
    assert r.status_code == 202 and r.json()["approval"]["status"] == "PENDING"
    assert r.json()["approval"]["waived"] is None
    # остальные привилегированные при единственном super_admin — сразу (waived), пароль — ему как решающему
    r = await env.c.post(f"/admin/v1/staff/{ops_id}/reset-password", json={"reason": "Сброс"},
                         headers=env.h(root.actor))
    assert r.status_code == 200 and len(r.json()["temporary_password"]) == 20
    env.leaks.append(r.json()["temporary_password"])
    applied = (await env.c.get("/admin/v1/approvals?status=APPLIED", headers=env.h(root.actor))).json()["items"]
    w = next(x for x in applied if x["kind"] == "staff.privileged_reset")
    assert w["waived"] == "single_super_admin" and w["summary"]["staff"]["staff_id"] == ops_id
    assert r.json()["temporary_password"] not in await _dump(env)
    m = await env.c.post(f"/admin/v1/staff/{ops_id}/reset-mfa", json={"reason": "Телефон"},
                         headers=env.h(root.actor))
    assert m.status_code == 200 and m.json()["mfa_enabled"] is False


async def test_n1_equal_privileged_rights_reset_needs_approval(env: Env, root: Person) -> None:
    grant = await env.c.put("/admin/v1/roles/auditor",
                            json={"permissions": ["dashboard.read", "audit.read", "staff.manage"],
                                  "reason": "Аудиторы ведут учётки"}, headers=env.h(root.actor))
    assert grant.json()["approval"]["status"] == "APPLIED"
    a1 = await env.onboard(root.actor, new_email("a1"), "auditor")  # привилегированная (staff.manage) → MFA
    a2 = await env.onboard(root.actor, new_email("a2"), "auditor")
    assert a1.secret and a2.secret
    # коллега с тем же набором привилегированных прав — только заявкой (автор не super_admin → без waiver)
    r = await env.c.post(f"/admin/v1/staff/{a2.staff_id}/reset-password", json={"reason": "Захват коллеги"},
                         headers=env.h(a1.actor))
    assert r.status_code == 202 and r.json()["approval"]["waived"] is None
    assert (await env.login(a2.email, a2.password)).json()["next"] == "mfa"  # не применено
    ok = await env.approve(root.actor, r.json()["approval"]["approval_id"])
    assert ok.status_code == 200 and len(ok.json()["temporary_password"]) == 20
    env.leaks.append(ok.json()["temporary_password"])
    # непривилегированная цель — как раньше, сразу
    ro = await env.create_staff(a1.actor, new_email("ro"), "read_only")
    rp = await env.c.post(f"/admin/v1/staff/{ro.json()['staff']['staff_id']}/reset-password",
                          json={"reason": "Забыл"}, headers=env.h(a1.actor))
    assert rp.status_code == 200 and len(rp.json()["temporary_password"]) == 20
    env.leaks.append(rp.json()["temporary_password"])
    # права шире своих — по-прежнему 403
    r = await env.c.post(f"/admin/v1/staff/{root.staff_id}/reset-mfa", json={"reason": "Захват"},
                         headers=env.h(a1.actor))
    assert _err(r) == (403, "PERMISSION_DENIED")


async def test_login_failed_audit_is_aggregated_per_email(env: Env) -> None:
    email = new_email("brute")
    subject = env.app.state.identity.email_subject(email)
    gate = f"{env.settings.redis_namespace}:lfa:gate:{subject}"
    assert env.runtime.redis is not None
    for _ in range(3):
        assert (await env.login(email, "Wrong-passw0rd-xx")).status_code == 401

    async def recs() -> list[dict]:
        return [e.payload for e in await env.audit()
                if e.payload["action"] in ("auth.login_failed", "auth.locked")
                and e.payload["after"]["email_hash"] == subject]

    first = await recs()
    assert [(p["action"], p["after"]["failures"]) for p in first] == [("auth.login_failed", 1)]
    assert first[0]["after"]["window_seconds"] == 60 and first[0]["after"]["remaining"] == 4
    await env.runtime.redis.delete(gate)  # прошла минута
    assert (await env.login(email, "Wrong-passw0rd-xx")).status_code == 401
    r = await env.login(email, "Wrong-passw0rd-xx")
    assert r.status_code == 423
    for _ in range(10):  # во время блокировки — ни одной записи
        assert (await env.login(email, "Wrong-passw0rd-xx")).status_code == 423
    got = [(p["action"], p["after"]["failures"]) for p in await recs()]
    # 2 накопленные + 4-я → одна запись; 5-я — блокировка
    assert got == [("auth.login_failed", 1), ("auth.login_failed", 3), ("auth.locked", 1)]


async def test_author_reissues_temp_password_before_first_login(env: Env, root: Person) -> None:
    """Инцидент форка aievent: второй super_admin потерял временный пароль до первого входа → сброс уходил
    в заявку, которую мог согласовать только он сам (тупик). Автор учётки перевыпускает пароль сразу, пока цель
    ни разу не входила и других решающих нет; висящая заявка по цели отклоняется."""
    email = new_email("sa-new")
    c = await env.create_staff(root.actor, email, "super_admin", "New Admin")  # единственный super_admin → waived
    first = c.json()["temporary_password"]
    sid = c.json()["staff"]["staff_id"]
    stuck = await env.c.post(f"/admin/v1/staff/{sid}/reset-mfa", json={"reason": "Телефон"}, headers=env.h(root.actor))
    assert stuck.status_code == 202 and stuck.json()["approval"]["status"] == "PENDING"
    r = await env.c.post(f"/admin/v1/staff/{sid}/reset-password", json={"reason": "Потерян пароль"},
                         headers=env.h(root.actor))
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    temp = r.json()["temporary_password"]
    env.leaks.extend([first, temp])
    assert temp != first and (await env.login(email, first)).status_code == 401
    st = (await env.sql("SELECT status, decision_note FROM approvals WHERE approval_id = :i",
                        i=stuck.json()["approval"]["approval_id"]))[0]
    assert st[0] == "REJECTED"
    rec = [e.payload for e in await env.audit() if e.payload["action"] == "staff.password_reset"][-1]
    assert rec["actor_id"] == root.staff_id and rec["after"]["reissued_before_first_login"] is True
    assert temp not in await _dump(env)
    # после первого входа исключение больше не действует: снова заявка
    await env.first_login(email, temp)
    again = await env.c.post(f"/admin/v1/staff/{sid}/reset-password", json={"reason": "Снова"},
                             headers=env.h(root.actor))
    assert again.status_code == 202 and "temporary_password" not in again.text


async def test_no_reissue_when_another_decider_exists(env: Env, root: Person, root2: Person) -> None:
    """Ревью M-1: есть третий активный super_admin — перевыпуск автором не действует, только заявка (N1)."""
    email = new_email("sa-new2")
    c = await env.create_staff(root.actor, email, "super_admin", "New Admin")
    assert (await env.approve(root2.actor, c.json()["approval"]["approval_id"])).status_code == 200
    env.leaks.append(c.json()["temporary_password"])
    sid = c.json()["staff"]["staff_id"]
    for who in (root, root2):
        r = await env.c.post(f"/admin/v1/staff/{sid}/reset-password", json={"reason": "Потерян пароль"},
                             headers=env.h(who.actor))
        assert r.status_code == 202 and "temporary_password" not in r.text
        await env.sql("UPDATE approvals SET status = 'REJECTED' WHERE status = 'PENDING' RETURNING approval_id")
