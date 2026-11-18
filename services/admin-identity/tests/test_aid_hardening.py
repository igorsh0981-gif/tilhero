"""Доработки после внутреннего QA: эскалация через staff.manage, разблокировка входа, маскирование email
в аудите заявок, фиктивный хеш для неизвестного email, 404/422 Staff API, изоляция TOTP, утечки в ответах."""

from __future__ import annotations

import json
import uuid

import pytest
from aid_testkit import ROOT_EMAIL, ROOT_PASSWORD, Env, Person, bad_code, code_at, new_email


def _err(r) -> tuple[int, str]:
    return r.status_code, r.json()["code"]


async def _grant_staff_manage_to_auditor(env: Env, root: Person) -> None:
    r = await env.c.put("/admin/v1/roles/auditor",
                        json={"permissions": ["dashboard.read", "audit.read", "staff.manage"],
                              "reason": "Аудитор ведёт учётки"}, headers=env.h(root.actor))
    assert r.status_code == 202 and r.json()["approval"]["status"] == "APPLIED", r.text


async def test_staff_manage_cannot_escalate(env: Env, root: Person) -> None:
    await _grant_staff_manage_to_auditor(env, root)  # root — единственный super_admin → сразу
    auditor = await env.onboard(root.actor, new_email("aud"), "auditor")
    ops = await env.onboard(root.actor, new_email("ops"), "operations")  # waived, MFA подключена
    a = auditor.actor
    # сброс пароля/MFA более сильной учётки — 403 (иначе вход под ней)
    r = await env.c.post(f"/admin/v1/staff/{root.staff_id}/reset-password", json={"reason": "Захват"},
                         headers=env.h(a))
    assert _err(r) == (403, "PERMISSION_DENIED") and r.json()["details"]["role"] == "super_admin"
    r = await env.c.post(f"/admin/v1/staff/{ops.staff_id}/reset-mfa", json={"reason": "Захват"}, headers=env.h(a))
    assert _err(r) == (403, "PERMISSION_DENIED")
    assert r.json()["details"] == {"permission": "users.read", "role": "operations"}
    r = await env.patch(a, ops.staff_id, {"display_name": "X", "reason": "Попытка"})
    assert _err(r) == (403, "PERMISSION_DENIED")
    # создать/назначить непривилегированную роль шире своей — 403; ⊆ своей — можно
    r = await env.create_staff(a, new_email("sup"), "support")
    assert _err(r) == (403, "PERMISSION_DENIED") and r.json()["details"]["permission"] == "users.read"
    ro = await env.create_staff(a, new_email("ro"), "read_only")
    assert ro.status_code == 201
    ro_id = ro.json()["staff"]["staff_id"]
    up = await env.patch(a, ro_id, {"role": "analyst", "reason": "Повышение"})
    assert _err(up) == (403, "PERMISSION_DENIED")
    ok = await env.patch(a, ro_id, {"display_name": "Новое имя", "reason": "Опечатка"})
    assert ok.status_code == 200 and ok.json()["display_name"] == "Новое имя"
    # auditor со staff.manage стал привилегированным (M2) — назначение только заявкой
    grant = await env.patch(a, ro_id, {"role": "auditor", "reason": "Перевод"})
    assert grant.status_code == 202 and grant.json()["approval"]["status"] == "PENDING"
    # привилегированная роль — не сразу, а заявкой на решение super_admin (автор не super_admin → без waiver)
    priv = await env.create_staff(a, new_email("bill"), "billing")
    assert priv.status_code == 201
    assert priv.json()["staff"]["role"] == "read_only" and priv.json()["approval"]["status"] == "PENDING"
    assert priv.json()["approval"]["waived"] is None
    ok = await env.approve(root.actor, priv.json()["approval"]["approval_id"])
    assert ok.status_code == 200 and ok.json()["status"] == "APPLIED"
    # super_admin по-прежнему может всё
    r = await env.c.post(f"/admin/v1/staff/{ops.staff_id}/reset-mfa", json={"reason": "Потерян телефон"},
                         headers=env.h(root.actor))
    assert r.status_code == 200


async def test_approval_audit_masks_staff_email(env: Env, root: Person, root2: Person) -> None:
    email = new_email("masked")
    r = await env.create_staff(root.actor, email, "billing", "Биллинг")
    assert r.json()["approval"]["summary"]["staff"]["email"] == email  # решающему — полностью
    await env.approve(root2.actor, r.json()["approval"]["approval_id"])
    recs = [e.payload for e in await env.audit() if e.payload["action"].startswith("approval.")]
    assert {"approval.requested", "approval.approved", "approval.applied"} <= {p["action"] for p in recs}
    dump = json.dumps([e.payload for e in await env.audit()], ensure_ascii=False)
    assert email not in dump and email.split("@")[0] not in dump


async def test_unlock_active_staff_resets_login_lock(env: Env, root: Person, root2: Person) -> None:
    for _ in range(5):
        await env.login(root2.email, "Wrong-passw0rd-xx")
    assert (await env.login(root2.email, root2.password)).status_code == 423
    sv = (await env.principal(root2.staff_id)).json()["session_version"]
    r = await env.patch(root.actor, root2.staff_id, {"status": "ACTIVE", "reason": "Разблокировка входа"})
    assert r.status_code == 200 and r.json()["status"] == "ACTIVE"
    assert (await env.principal(root2.staff_id)).json()["session_version"] == sv  # сессии не отзываются
    await env.reset_last_step(root2.staff_id)
    assert (await env.login(root2.email, root2.password)).json()["next"] == "mfa"
    rec = [e.payload for e in await env.audit() if e.payload["action"] == "staff.updated"]
    assert rec[-1]["after"] == {"login_attempts_reset": True} and rec[-1]["reason"] == "Разблокировка входа"


async def test_unknown_email_checks_dummy_hash(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    passwords = env.app.state.identity.passwords
    calls: list[str | None] = []
    original = passwords.verify_sync

    def spy(password_hash: str | None, password: str) -> bool:
        calls.append(password_hash)
        return original(password_hash, password)

    monkeypatch.setattr(passwords, "verify_sync", spy)
    for email in (new_email("ghost"), "not-an-email", ROOT_EMAIL):
        r = await env.login(email, "Wrong-passw0rd-xx")
        assert _err(r) == (401, "INVALID_CREDENTIALS")
    # argon2 выполняется для каждого запроса — и для несуществующих учёток (фиктивный хеш)
    assert len(calls) == 3 and calls[0] is None and calls[1] is None and calls[2] is not None


async def test_staff_api_404_and_422(env: Env, root: Person, root2: Person) -> None:
    h = env.h(root.actor)
    ghost = uuid.uuid4()
    for action in ("reset-password", "reset-mfa"):
        r = await env.c.post(f"/admin/v1/staff/{ghost}/{action}", json={"reason": "Нет такого"}, headers=h)
        assert _err(r) == (404, "STAFF_NOT_FOUND")
        r = await env.c.post(f"/admin/v1/staff/{root2.staff_id}/{action}", json={"reason": "x"}, headers=h)
        assert _err(r) == (422, "VALIDATION_ERROR")
        r = await env.c.post(f"/admin/v1/staff/{root2.staff_id}/{action}", json={}, headers=h)
        assert r.status_code == 422
        r = await env.c.post(f"/admin/v1/staff/not-a-uuid/{action}", json={"reason": "Проверка"}, headers=h)
        assert r.status_code == 422
    assert (await env.patch(root.actor, root2.staff_id, {"status": "LOCKED", "reason": "Нельзя"})).status_code == 422
    assert (await env.patch(root.actor, root2.staff_id, {"role": "god", "reason": "Нельзя"})).status_code == 422
    assert (await env.patch(root.actor, root2.staff_id,
                            {"display_name": "X", "reason": "ok!", "extra": 1})).status_code == 422
    many = ",".join(str(uuid.uuid4()) for _ in range(101))
    assert _err(await env.c.get(f"/admin/v1/staff/lookup?ids={many}", headers=h)) == (422, "VALIDATION_ERROR")
    assert (await env.c.get("/admin/v1/staff?limit=0", headers=h)).status_code == 422
    assert (await env.c.get("/admin/v1/staff?status=GONE", headers=h)).status_code == 422
    assert (await env.c.get("/admin/v1/approvals?status=DONE", headers=h)).status_code == 422
    assert (await env.c.get("/admin/v1/approvals?cursor=@@", headers=h)).status_code == 400
    assert (await env.c.post("/admin/v1/approvals/nope/approve", json={}, headers=h)).status_code == 422
    r = await env.c.post(f"/admin/v1/approvals/{ghost}/reject", json={"note": "Нет"}, headers=h)
    assert _err(r) == (404, "APPROVAL_NOT_FOUND")
    assert (await env.c.put("/admin/v1/roles/analyst", json={"permissions": []}, headers=h)).status_code == 422
    # без токена и без права — на каждом маршруте Staff API
    for method, path in (("GET", "/admin/v1/roles"), ("GET", "/admin/v1/approvals"),
                         ("GET", f"/admin/v1/staff/lookup?ids={root.staff_id}"),
                         ("POST", f"/admin/v1/approvals/{ghost}/approve")):
        r = await env.c.request(method, path, json={} if method == "POST" else None)
        assert _err(r) == (401, "INTERNAL_TOKEN_MISSING"), path


async def test_reject_four_eyes_and_expired(env: Env, root: Person, root2: Person) -> None:
    target = await env.onboard(root.actor, new_email("an"), "analyst")
    r = await env.patch(root.actor, target.staff_id, {"role": "billing", "reason": "Повышение"})
    aid = r.json()["approval"]["approval_id"]
    same = await env.approve(root.actor, aid, action="reject")
    assert _err(same) == (409, "FOUR_EYES_SAME_PERSON")
    not_super = await env.approve(target.actor, aid, action="reject")
    assert _err(not_super) == (403, "PERMISSION_DENIED")
    await env.sql("UPDATE approvals SET expires_at = now() - interval '1 second' WHERE approval_id = :i "
                  "RETURNING approval_id", i=aid)
    late = await env.approve(root2.actor, aid, action="reject")
    assert _err(late) == (409, "APPROVAL_EXPIRED")
    pending = (await env.c.get("/admin/v1/approvals?status=PENDING", headers=env.h(root.actor))).json()
    assert aid not in {x["approval_id"] for x in pending["items"]}


async def test_totp_isolation_and_enroll_code_replay(env: Env, root: Person, root2: Person) -> None:
    assert root.secret and root2.secret
    await env.reset_last_step(root.staff_id)
    # код чужого секрета не подходит
    foreign = await env.post("/auth/step-up", {"staff_id": root.staff_id, "code": code_at(root2.secret, 1)})
    if code_at(root2.secret, 1) not in {code_at(root.secret, d) for d in (-1, 0, 1)}:
        assert _err(foreign) == (401, "MFA_INVALID")
    # код, которым только что подтвердили подключение MFA, нельзя повторить при входе
    email = new_email("ops")
    created = await env.create_staff(root.actor, email, "operations")  # двое super_admin → PENDING
    await env.approve(root2.actor, created.json()["approval"]["approval_id"])
    temp = created.json()["temporary_password"]
    step = (await env.login(email, temp)).json()
    step = (await env.post("/auth/password", {"challenge": step["challenge"], "new_password": "Ops-Passw0rd-123"})
            ).json()
    assert step["next"] == "mfa_enroll"
    secret = (await env.post("/auth/mfa/enroll/start", {"challenge": step["challenge"]})).json()["secret"]
    bad = bad_code(secret)
    wrong = await env.post("/auth/mfa/enroll/confirm", {"challenge": step["challenge"], "code": bad})
    assert _err(wrong) == (401, "MFA_INVALID") and wrong.json()["details"] == {"remaining": 4}
    code = code_at(secret, 1)
    done = await env.post("/auth/mfa/enroll/confirm", {"challenge": step["challenge"], "code": code})
    assert done.status_code == 200 and done.json()["next"] == "done"
    ch = (await env.login(email, "Ops-Passw0rd-123")).json()
    assert ch["next"] == "mfa"
    replay = await env.post("/auth/mfa/verify", {"challenge": ch["challenge"], "code": code})
    assert _err(replay) == (401, "MFA_INVALID")
    for c in (code_at(secret, -1), code_at(secret, 0)):  # шаги ≤ использованного тоже отвергаются
        r = await env.post("/auth/mfa/verify", {"challenge": ch["challenge"], "code": c})
        assert r.status_code == 401


async def test_responses_never_echo_secrets(env: Env, root: Person) -> None:
    secret_pwd = "Leaky-Passw0rd-Value"
    responses = [
        await env.login(root.email, secret_pwd),
        await env.login("x" * 300, secret_pwd),
        await env.login(root.email, secret_pwd * 20),  # > 256 → 422 без эха значения
        await env.post("/auth/password", {"challenge": "A" * 43, "staff_id": root.staff_id,
                                          "current_password": secret_pwd, "new_password": secret_pwd}),
        await env.post("/auth/password", {"staff_id": root.staff_id, "current_password": secret_pwd,
                                          "new_password": secret_pwd}),
        await env.post("/auth/mfa/verify", {"challenge": "B" * 43, "code": "123456"}),
    ]
    for r in responses:
        assert r.status_code in (401, 422, 423), r.text
        assert secret_pwd not in r.text and "B" * 43 not in r.text and "123456" not in r.text
    p = (await env.principal(root.staff_id)).json()
    lst = (await env.c.get("/admin/v1/staff", headers=env.h(root.actor))).json()["items"][0]
    for body in (p, p["staff"], lst):
        assert not {"password_hash", "mfa_secret_enc", "mfa_last_step", "temp_password_expires_at"} & set(body)


async def test_bootstrap_reminds_to_remove_variables(env_factory, capsys: pytest.CaptureFixture[str]) -> None:
    # Старт сервиса переинициализирует логирование (JSON в stdout) — проверяем вывод, а не caplog
    env = await env_factory()
    capsys.readouterr()
    await env_factory()  # повторный старт до первого входа — напоминание завершить вход
    out = capsys.readouterr().out
    assert "first login of the bootstrap super_admin is not completed" in out
    await env.first_login(ROOT_EMAIL, ROOT_PASSWORD)
    capsys.readouterr()
    await env_factory()  # после первого входа — напоминание удалить переменные
    out2 = capsys.readouterr().out
    assert "remove ADMIN_BOOTSTRAP_EMAIL/ADMIN_BOOTSTRAP_PASSWORD" in out2
    for o in (out, out2):
        assert ROOT_PASSWORD not in o and ROOT_EMAIL not in o


async def test_idempotency_key_is_scoped_to_actor(env: Env, root: Person, root2: Person) -> None:
    key = uuid.uuid4().hex
    a = await env.create_staff(root.actor, new_email("k1"), "support", **{"Idempotency-Key": key})
    b = await env.create_staff(root2.actor, new_email("k2"), "support", **{"Idempotency-Key": key})
    assert a.status_code == b.status_code == 201
    assert a.json()["staff"]["staff_id"] != b.json()["staff"]["staff_id"]
    assert a.json()["temporary_password"] and b.json()["temporary_password"]
    env.leaks += [a.json()["temporary_password"], b.json()["temporary_password"]]
