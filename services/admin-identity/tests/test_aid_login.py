"""Вход: пароль, смена пароля, подключение MFA, TOTP, блокировка, challenge, step-up, principal, logout."""

from __future__ import annotations

import asyncio
import time
import types
import uuid

import aid_testkit
import pytest
from aid_testkit import NEW_PASSWORD, ROOT_EMAIL, ROOT_PASSWORD, Env, Person, bad_code, code_at, new_email

from tilhero_admin_identity.domain.catalog import PERMISSIONS


def _shape(r) -> tuple[int, str, dict]:
    body = r.json()
    return r.status_code, body["code"], body["details"]


async def test_bootstrap_first_login_then_mfa_login(env: Env) -> None:
    r = await env.login(ROOT_EMAIL.upper(), ROOT_PASSWORD, ip="10.0.0.1", user_agent="pytest")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    step = r.json()
    assert step["next"] == "password_change" and step["principal"] is None and len(step["challenge"]) == 43
    r = await env.post("/auth/password", {"challenge": step["challenge"], "new_password": NEW_PASSWORD})
    assert r.status_code == 200, r.text
    step = r.json()
    assert step["next"] == "mfa_enroll"  # super_admin — привилегированная роль, MFA обязательна
    start = await env.post("/auth/mfa/enroll/start", {"challenge": step["challenge"]})
    assert start.status_code == 200
    s = start.json()
    assert s["issuer"] == "TilHero Admin" and s["account"] == ROOT_EMAIL
    assert s["otpauth_uri"].startswith("otpauth://totp/TilHero%20Admin:root@tilhero.test?secret=" + s["secret"])
    done = await env.post("/auth/mfa/enroll/confirm", {"challenge": step["challenge"], "code": code_at(s["secret"])})
    assert done.status_code == 200, done.text
    p = done.json()["principal"]
    assert done.json()["next"] == "done" and done.json()["challenge"] is None
    assert p["staff"]["role"] == "super_admin" and p["mfa_enabled"] is True and p["must_change_password"] is False
    assert p["session_version"] == 2 and p["status"] == "ACTIVE"  # смена пароля → рост версии
    assert p["permissions"] == list(PERMISSIONS)  # super_admin — все 17 прав в порядке admin.ts
    # повторный вход: пароль → TOTP → done (следующий шаг TOTP — повтор текущего запрещён)
    r = await env.login(ROOT_EMAIL, NEW_PASSWORD)
    assert r.json()["next"] == "mfa"
    ok = await env.post("/auth/mfa/verify", {"challenge": r.json()["challenge"], "code": code_at(s["secret"], 1)})
    assert ok.status_code == 200 and ok.json()["next"] == "done"
    assert ok.json()["principal"]["staff"]["email"] == ROOT_EMAIL
    actions = await env.actions()
    for a in ("staff.bootstrap", "auth.password_changed", "auth.mfa_enrolled", "auth.login"):
        assert a in actions, a
    assert actions.count("auth.login") == 2


async def test_wrong_password_and_unknown_email_look_the_same(env: Env, root: Person) -> None:
    wrong = await env.login(root.email, "Wrong-passw0rd-xx")
    unknown = await env.login(new_email("ghost"), "Wrong-passw0rd-xx")
    garbage = await env.login("not-an-email", "Wrong-passw0rd-xx")
    assert _shape(wrong) == _shape(unknown) == _shape(garbage) == (401, "INVALID_CREDENTIALS", {"remaining": 4})
    assert wrong.json()["message"] == unknown.json()["message"]
    again = await env.login(root.email.upper() + " ", "Wrong-passw0rd-xx")  # тот же нормализованный email
    assert again.json()["details"] == {"remaining": 3}
    events = [e.payload for e in await env.audit() if e.payload["action"] == "auth.login_failed"]
    assert len(events) == 3  # повтор по тому же email в пределах минуты — без новой записи (агрегирование)
    for p in events:
        assert set(p["after"]) >= {"email_hash"} and "@" not in str(p)  # email — только хеш


async def test_lockout_after_five_failures_for_existing_and_unknown(env: Env, root: Person) -> None:
    for email in (root.email, new_email("ghost")):
        for i in range(4):
            r = await env.login(email, "Wrong-passw0rd-xx")
            assert r.json()["details"]["remaining"] == 4 - i
        locked = await env.login(email, "Wrong-passw0rd-xx")
        assert locked.status_code == 423 and locked.json()["code"] == "ACCOUNT_LOCKED"
        assert 0 < locked.json()["details"]["retry_after"] <= 900 and locked.headers["retry-after"]
    # правильный пароль во время блокировки — тоже 423
    blocked = await env.login(root.email, root.password)
    assert blocked.status_code == 423
    assert (await env.actions()).count("auth.locked") == 2


async def test_unlock_by_admin_status_change(env: Env, root: Person) -> None:
    sup = await env.onboard(root.actor, new_email("sup"), "support")
    for _ in range(5):
        await env.login(sup.email, "Wrong-passw0rd-xx")
    assert (await env.login(sup.email, sup.password)).status_code == 423
    off = await env.patch(root.actor, sup.staff_id, {"status": "DISABLED", "reason": "Проверка доступа"})
    assert off.status_code == 200 and off.json()["status"] == "DISABLED"
    on = await env.patch(root.actor, sup.staff_id, {"status": "ACTIVE", "reason": "Разблокировка"})
    assert on.status_code == 200
    assert (await env.login(sup.email, sup.password)).json()["next"] == "done"


async def test_disabled_account_and_temp_password_expiry(env: Env, root: Person) -> None:
    sup = await env.onboard(root.actor, new_email("sup"), "support")
    off = await env.patch(root.actor, sup.staff_id, {"status": "DISABLED", "reason": "Увольнение"})
    assert off.status_code == 200
    r = await env.login(sup.email, sup.password)
    assert _shape(r)[:2] == (403, "ACCOUNT_DISABLED")
    bad = await env.login(sup.email, "Wrong-passw0rd-xx")
    assert bad.status_code == 401  # без верного пароля статус учётки не раскрывается
    email = new_email("temp")
    created = await env.create_staff(root.actor, email, "support")
    await env.sql("UPDATE staff SET temp_password_expires_at = now() - interval '1 minute' WHERE email = :e "
                  "RETURNING staff_id", e=email)
    r = await env.login(email, created.json()["temporary_password"])
    assert _shape(r)[:2] == (401, "TEMPORARY_PASSWORD_EXPIRED")


async def test_password_rules_and_weak_password_keeps_challenge(env: Env) -> None:
    step = (await env.login(ROOT_EMAIL, ROOT_PASSWORD)).json()
    cases = {
        "short1": ["min_length_12"],
        "onlyletterslong": ["letters_and_digits"],
        ROOT_EMAIL: ["letters_and_digits", "not_email"],
        ROOT_PASSWORD: ["not_previous"],
        "root@tilhero.test1": [],
    }
    for pwd, rules in cases.items():
        if not rules:
            continue
        r = await env.post("/auth/password", {"challenge": step["challenge"], "new_password": pwd})
        assert _shape(r) == (422, "PASSWORD_WEAK", {"rules": rules}), pwd
    from tilhero_admin_identity.domain.policy import password_violations

    assert password_violations("root1234567890", email="root1234567890@x.io", same_as_previous=False) == ["not_email"]
    ok = await env.post("/auth/password", {"challenge": step["challenge"], "new_password": NEW_PASSWORD})
    assert ok.status_code == 200 and ok.json()["next"] == "mfa_enroll"


async def test_wrong_and_replayed_totp(env: Env, root: Person) -> None:
    assert root.secret is not None
    await env.reset_last_step(root.staff_id)
    ch = (await env.login(root.email, root.password)).json()["challenge"]
    good = code_at(root.secret)
    bad = bad_code(root.secret)
    r = await env.post("/auth/mfa/verify", {"challenge": ch, "code": bad})
    assert _shape(r) == (401, "MFA_INVALID", {"remaining": 4})
    ok = await env.post("/auth/mfa/verify", {"challenge": ch, "code": good})
    assert ok.status_code == 200
    # тот же код (тот же шаг) при новом входе — повтор
    ch2 = (await env.login(root.email, root.password)).json()["challenge"]
    replay = await env.post("/auth/mfa/verify", {"challenge": ch2, "code": good})
    assert _shape(replay) == (401, "MFA_INVALID", {"remaining": 4})
    # 5 неверных кодов подряд → challenge сгорает и MFA сотрудника блокируется на 15 мин (M1)
    for left in (3, 2, 1):
        r = await env.post("/auth/mfa/verify", {"challenge": ch2, "code": bad})
        assert _shape(r) == (401, "MFA_INVALID", {"remaining": left})
    r = await env.post("/auth/mfa/verify", {"challenge": ch2, "code": bad})
    assert r.status_code == 423 and r.json()["code"] == "MFA_LOCKED"
    assert 0 < r.json()["details"]["retry_after"] <= 900
    gone = await env.post("/auth/mfa/verify", {"challenge": ch2, "code": code_at(root.secret, 1)})
    assert _shape(gone)[:2] == (401, "CHALLENGE_INVALID")
    # новый challenge после верного пароля не даёт новых попыток — даже верный код отвергается
    ch3 = (await env.login(root.email, root.password)).json()["challenge"]
    locked = await env.post("/auth/mfa/verify", {"challenge": ch3, "code": code_at(root.secret, 1)})
    assert locked.status_code == 423 and locked.json()["code"] == "MFA_LOCKED"
    still = await env.post("/auth/step-up", {"staff_id": root.staff_id, "code": code_at(root.secret, 1)})
    assert still.status_code == 423  # счётчик общий со step-up
    assert "auth.mfa_failed" in await env.actions()
    rec = [e.payload for e in await env.audit() if e.payload["action"] == "auth.locked"]
    assert [p["after"] for p in rec] == [{"context": "login_mfa", "lock_seconds": 900}]
    invalid = await env.post("/auth/mfa/verify", {"challenge": ch2, "code": "12ab56"})
    assert invalid.status_code == 422


async def test_challenge_is_one_time_step_bound_and_expires(env: Env, root: Person) -> None:
    assert root.secret is not None
    await env.reset_last_step(root.staff_id)
    ch = (await env.login(root.email, root.password)).json()["challenge"]
    # чужой шаг
    wrong_step = await env.post("/auth/mfa/enroll/start", {"challenge": ch})
    assert _shape(wrong_step)[:2] == (401, "CHALLENGE_INVALID")
    pw = await env.post("/auth/password", {"challenge": ch, "new_password": "Another-Passw0rd-9"})
    assert _shape(pw)[:2] == (401, "CHALLENGE_INVALID")
    ok = await env.post("/auth/mfa/verify", {"challenge": ch, "code": code_at(root.secret)})
    assert ok.status_code == 200
    reuse = await env.post("/auth/mfa/verify", {"challenge": ch, "code": code_at(root.secret, 1)})
    assert _shape(reuse)[:2] == (401, "CHALLENGE_INVALID")
    # истечение (TTL в Redis)
    ch2 = (await env.login(root.email, root.password)).json()["challenge"]
    assert env.runtime.redis is not None
    ttl = await env.runtime.redis.ttl(env.challenge_key(ch2))
    assert 0 < ttl <= 300
    await env.runtime.redis.pexpire(env.challenge_key(ch2), 1)
    await asyncio.sleep(0.05)
    expired = await env.post("/auth/mfa/verify", {"challenge": ch2, "code": code_at(root.secret, 1)})
    assert _shape(expired)[:2] == (401, "CHALLENGE_INVALID")
    # неизвестный challenge
    unknown = await env.post("/auth/mfa/verify", {"challenge": "A" * 43, "code": "123456"})
    assert _shape(unknown)[:2] == (401, "CHALLENGE_INVALID")


async def test_challenge_revoked_by_session_version_change(env: Env, root: Person, root2: Person) -> None:
    await env.reset_last_step(root2.staff_id)
    ch = (await env.login(root2.email, root2.password)).json()["challenge"]
    reset = await env.c.post(f"/admin/v1/staff/{root2.staff_id}/reset-mfa", json={"reason": "Потерян телефон"},
                             headers=env.h(root.actor))
    assert reset.status_code == 202  # цель — super_admin: four-eyes (N1)
    ok = await env.approve(root2.actor, reset.json()["approval"]["approval_id"])
    assert ok.status_code == 200 and "temporary_password" not in ok.json()
    assert root2.secret is not None
    r = await env.post("/auth/mfa/verify", {"challenge": ch, "code": code_at(root2.secret)})
    assert _shape(r)[:2] == (401, "CHALLENGE_INVALID")
    # после сброса MFA — подключение заново
    again = await env.login(root2.email, root2.password)
    assert again.json()["next"] == "mfa_enroll"


async def test_step_up(env: Env, root: Person) -> None:
    assert root.secret is not None
    await env.reset_last_step(root.staff_id)
    # код вычисляется один раз: пересчёт после смены 30-секундного шага дал бы код нового шага — уже не повтор
    code, bad = code_at(root.secret), bad_code(root.secret)
    ok = await env.post("/auth/step-up", {"staff_id": root.staff_id, "code": code})
    assert ok.status_code == 200 and ok.json() == {"ok": True}
    replay = await env.post("/auth/step-up", {"staff_id": root.staff_id, "code": code})
    assert _shape(replay) == (401, "MFA_INVALID", {"remaining": 4})
    for left in (3, 2, 1):
        r = await env.post("/auth/step-up", {"staff_id": root.staff_id, "code": bad})
        assert _shape(r) == (401, "MFA_INVALID", {"remaining": left})
    locked = await env.post("/auth/step-up", {"staff_id": root.staff_id, "code": bad})
    assert locked.status_code == 423 and locked.json()["code"] == "MFA_LOCKED"
    still = await env.post("/auth/step-up", {"staff_id": root.staff_id, "code": code_at(root.secret, 1)})
    assert still.status_code == 423
    missing = await env.post("/auth/step-up", {"staff_id": str(uuid.uuid4()), "code": "123456"})
    assert _shape(missing)[:2] == (404, "STAFF_NOT_FOUND")
    actions = await env.actions()
    assert "auth.step_up" in actions and "auth.mfa_failed" in actions
    locked_rec = [e.payload for e in await env.audit() if e.payload["action"] == "auth.locked"]
    assert len(locked_rec) == 1 and locked_rec[0]["after"] == {"context": "step_up", "lock_seconds": 900}


async def test_step_up_replay_rejected_after_step_change(env: Env, root: Person,
                                                         monkeypatch: pytest.MonkeyPatch) -> None:
    """Исправление Q9 форка aievent: смена 30-секундного шага между входом и повтором — детерминированно,
    на подменённых часах TOTP (сервер и тест). Прежний код ещё в окне −1, но его шаг использован → повтор;
    код нового шага принимается."""
    from tilhero_admin_identity.domain import crypto

    assert root.secret is not None
    await env.reset_last_step(root.staff_id)
    clock = {"now": (time.time() // 30) * 30 + 15}  # середина текущего шага
    fake = types.SimpleNamespace(time=lambda: clock["now"])
    monkeypatch.setattr(crypto, "time", fake)
    monkeypatch.setattr(aid_testkit, "time", fake)
    code = code_at(root.secret)
    ok = await env.post("/auth/step-up", {"staff_id": root.staff_id, "code": code})
    assert ok.status_code == 200
    clock["now"] += 30
    replay = await env.post("/auth/step-up", {"staff_id": root.staff_id, "code": code})
    assert _shape(replay) == (401, "MFA_INVALID", {"remaining": 4})
    fresh = await env.post("/auth/step-up", {"staff_id": root.staff_id, "code": code_at(root.secret)})
    assert fresh.status_code == 200


async def test_step_up_requires_mfa(env: Env, root: Person) -> None:
    support = await env.onboard(root.actor, new_email("sup"), "support")
    assert support.secret is None and support.principal["mfa_enabled"] is False
    r = await env.post("/auth/step-up", {"staff_id": support.staff_id, "code": "123456"})
    assert _shape(r)[:2] == (409, "MFA_NOT_ENABLED")


async def test_change_own_password_in_session(env: Env, root: Person) -> None:
    before = root.principal["session_version"]
    wrong = await env.post("/auth/password", {"staff_id": root.staff_id, "current_password": "Nope-passw0rd-1",
                                              "new_password": "Brand-New-Passw0rd"})
    assert _shape(wrong) == (401, "INVALID_CREDENTIALS", {"remaining": 4})
    same = await env.post("/auth/password", {"staff_id": root.staff_id, "current_password": root.password,
                                             "new_password": root.password})
    assert _shape(same) == (422, "PASSWORD_WEAK", {"rules": ["not_previous"]})
    ok = await env.post("/auth/password", {"staff_id": root.staff_id, "current_password": root.password,
                                           "new_password": "Brand-New-Passw0rd"})
    assert ok.status_code == 200 and ok.json()["next"] == "done"
    assert ok.json()["principal"]["session_version"] == before + 1
    mixed = await env.post("/auth/password", {"challenge": "A" * 43, "staff_id": root.staff_id,
                                              "current_password": "x", "new_password": "Brand-New-Passw0rd"})
    assert mixed.status_code == 422 and mixed.json()["code"] == "VALIDATION_ERROR"


async def test_principal_and_logout(env: Env, root: Person) -> None:
    r = await env.principal(root.staff_id)
    assert r.status_code == 200 and r.json()["staff"]["staff_id"] == root.staff_id
    assert (await env.principal(str(uuid.uuid4()))).status_code == 404
    out = await env.post("/auth/logout", {"staff_id": root.staff_id, "session_id": "s" * 43})
    assert out.status_code == 204
    rec = next(e.payload for e in await env.audit() if e.payload["action"] == "auth.logout")
    assert rec["session_id"] and "s" * 43 not in str(rec) and len(rec["session_id"]) == 32


async def test_internal_api_caller_checks(env: Env, root: Person) -> None:
    body = {"email": ROOT_EMAIL, "password": "x"}
    none = await env.c.post("/internal/v1/auth/login", json=body)
    assert _shape(none)[:2] == (401, "INTERNAL_TOKEN_MISSING")
    alien = await env.c.post("/internal/v1/auth/login", json=body, headers=env.h(issuer="telegram-bff"))
    assert _shape(alien)[:2] == (403, "CALLER_NOT_ALLOWED")
    bad = await env.c.post("/internal/v1/auth/login", json=body, headers={"x-internal-token": "garbage"})
    assert bad.status_code == 401
    other_aud = await env.c.get(f"/internal/v1/staff/{root.staff_id}/principal",
                                headers=env.h() | {"x-internal-token": env.h()["x-internal-token"][:-4] + "AAAA"})
    assert other_aud.status_code == 401
    extra = await env.c.post("/internal/v1/auth/login", json={**body, "role": "super_admin"}, headers=env.h())
    assert extra.status_code == 422


async def test_parallel_burst_cannot_exceed_attempt_limit(env: Env, root: Person) -> None:
    burst = await asyncio.gather(*(env.login(root.email, f"Wrong-passw0rd-{i}") for i in range(8)))
    codes = sorted(r.status_code for r in burst)
    assert codes == [401] * 4 + [423] * 4, codes
    assert root.secret is not None
    bad = bad_code(root.secret)
    burst = await asyncio.gather(*(env.post("/auth/step-up", {"staff_id": root.staff_id, "code": bad})
                                   for _ in range(8)))
    assert sorted(r.status_code for r in burst) == [401] * 4 + [423] * 4


def test_email_validation_rejects_template_brackets() -> None:
    from tilhero_admin_identity.domain.policy import is_valid_email, normalize_email
    for bad in ["<admin@example.uz>", "\"a\"@b.ru", "a b@c.ru", "a@b", "a,b@c.ru", "ВПИШИТЕ_EMAIL", "a@-b.ru", "@b.ru"]:
        assert not is_valid_email(normalize_email(bad)), bad
    for good in ["admin@example.uz", "First.Last+tag@Example.co.uk", "o'neil@mail.example.com", "a_b-c%d@x-y.uz"]:
        assert is_valid_email(normalize_email(good)), good
