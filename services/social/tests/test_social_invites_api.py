"""Создание, список, отзыв приглашений: формы bff.ts, Idempotency-Key, правила возраста, лимиты, авторизация."""

from __future__ import annotations

import uuid
from datetime import timedelta

from tilhero_common.testing import internal_headers


async def test_create_friend_invite(env) -> None:
    me = env.identity.add()
    r = await env.create(me, "friend", key="create-key-1")
    assert r.status_code == 201, r.text
    body = r.json()
    assert set(body) == {"invite_id", "kind", "link", "status", "expires_at", "created_at", "accepted_count"}
    assert body["kind"] == "friend" and body["status"] == "active" and body["accepted_count"] == 0
    assert body["created_at"] == "2026-11-16T08:00:00Z" and body["expires_at"] == "2026-12-16T08:00:00Z"
    token = body["link"].split("startapp=inv_")[1]
    assert len(token) == 32
    # токен в БД не хранится — только sha256
    [(stored,)] = await env.sql("SELECT token_hash FROM invites")
    assert token not in stored and len(stored) == 64
    [ev] = await env.events("social.invite.created.v1")
    assert ev.payload == {"invite_id": body["invite_id"], "inviter_user_id": str(me), "kind": "friend",
                          "expires_at": "2026-12-16T08:00:00Z"}
    # идемпотентность: тот же ключ — то же приглашение, без нового события; другой kind с тем же ключом — 422
    again = await env.create(me, "friend", key="create-key-1")
    assert again.status_code == 201 and again.json() == body and again.headers["idempotent-replayed"] == "true"
    assert len(await env.events("social.invite.created.v1")) == 1
    reused = await env.create(me, "referral", key="create-key-1")
    assert reused.status_code == 422 and reused.json()["code"] == "IDEMPOTENCY_KEY_REUSED"


async def test_kinds_expiry_and_reissued_link(env) -> None:
    me = env.identity.add()
    family = (await env.create(me, "family")).json()
    referral = (await env.create(me, "referral")).json()
    assert family["expires_at"] == "2026-11-23T08:00:00Z" and referral["expires_at"] is None
    listed = (await env.c.get("/internal/v1/me/invites", headers=env.h(me))).json()
    # создатель видит ту же ссылку повторно (токен выводится из invite_id)
    assert {i["invite_id"]: i["link"] for i in listed["items"]} == {
        family["invite_id"]: family["link"], referral["invite_id"]: referral["link"]}


async def test_idempotency_key_header(env) -> None:
    me = env.identity.add()
    missing = await env.c.post("/internal/v1/me/invites", json={"kind": "friend"}, headers=env.h(me))
    assert missing.status_code == 400 and missing.json()["code"] == "IDEMPOTENCY_KEY_REQUIRED"
    bad = await env.c.post("/internal/v1/me/invites", json={"kind": "friend"},
                           headers={**env.h(me), "Idempotency-Key": "bad key!"})
    assert bad.status_code == 422 and bad.json()["code"] == "IDEMPOTENCY_KEY_INVALID"
    for body in ({"kind": "enemy"}, {}, {"kind": "friend", "inviter_user_id": str(uuid.uuid4())}):
        r = await env.c.post("/internal/v1/me/invites", json=body,
                             headers={**env.h(me), "Idempotency-Key": str(uuid.uuid4())})
        assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", body


async def test_age_rules_for_inviter(env) -> None:
    teen = env.identity.add("Тимур", age="14-17")
    no_age = env.identity.add("Без возраста", age=None)
    kid = env.identity.add("Мадина", age="10-13", kind="child")
    disabled = env.identity.add("Отключён", status="DISABLED")
    unknown = uuid.uuid4()
    r = await env.create(teen, "family")
    assert r.status_code == 403 and r.json()["code"] == "ADULT_REQUIRED"
    r = await env.create(teen, "friend")
    assert r.status_code == 403 and r.json()["code"] == "INVITES_NOT_ALLOWED"  # нет согласия родителя
    await env.grant_guardian_consent(teen)
    assert (await env.create(teen, "friend")).status_code == 201
    assert (await env.create(teen, "family")).json()["code"] == "ADULT_REQUIRED"
    await env.grant_guardian_consent(teen, "declined")  # родитель отозвал — снова нельзя
    assert (await env.create(teen, "referral")).json()["code"] == "INVITES_NOT_ALLOWED"
    assert (await env.create(no_age, "family")).json()["code"] == "ADULT_REQUIRED"
    assert (await env.create(no_age, "friend")).json()["code"] == "INVITES_NOT_ALLOWED"
    for user in (kid, disabled, unknown):
        r = await env.create(user, "friend")
        assert r.status_code == 403 and r.json()["code"] == "INVITES_NOT_ALLOWED"
    # «подросток» из чужого издателя проекцию не меняет
    other = env.identity.add("Подросток", age="14-17")
    await env.profile_event("user.profile.updated.v1", {"user_id": str(other), "changed_fields": ["guardian_consent"],
                                                        "guardian_consent": "granted"}, producer="support")
    assert (await env.create(other, "friend")).json()["code"] == "INVITES_NOT_ALLOWED"


async def test_active_and_daily_limits(env) -> None:
    me = env.identity.add()
    ids = []
    for _ in range(10):
        r = await env.create(me, "referral")
        assert r.status_code == 201
        ids.append(r.json()["invite_id"])
    over = await env.create(me, "friend")
    assert over.status_code == 409 and over.json()["code"] == "INVITES_LIMIT"
    assert over.json()["details"] == {"limit": 10, "window": "active"}
    # отозванное и истёкшее не считаются активными
    assert (await env.c.delete(f"/internal/v1/me/invites/{ids[0]}", headers=env.h(me))).status_code == 200
    assert (await env.create(me, "family")).status_code == 201
    env.now += timedelta(days=8)  # семейное истекло (7 дней), tick ещё не отметил
    assert (await env.create(me, "friend")).status_code == 201
    # частота: не больше 20 созданий за 24 ч, отзыв лимит не возвращает
    user = env.identity.add()
    for _ in range(10):
        iid = (await env.create(user, "friend")).json()["invite_id"]
        await env.c.delete(f"/internal/v1/me/invites/{iid}", headers=env.h(user))
    for _ in range(10):
        iid = (await env.create(user, "friend")).json()["invite_id"]
        await env.c.delete(f"/internal/v1/me/invites/{iid}", headers=env.h(user))
    daily = await env.create(user, "friend")
    assert daily.status_code == 409 and daily.json()["details"] == {"limit": 20, "window": "24h"}
    env.now += timedelta(hours=24, seconds=1)
    assert (await env.create(user, "friend")).status_code == 201


async def test_list_pagination_and_isolation(env) -> None:
    me, other = env.identity.add(), env.identity.add()
    created = []
    for i in range(5):
        env.now += timedelta(minutes=1)
        created.append((await env.create(me, "referral", key=f"page-key-{i}")).json()["invite_id"])
    await env.create(other, "friend")
    page1 = (await env.c.get("/internal/v1/me/invites?limit=2", headers=env.h(me))).json()
    page2 = (await env.c.get(f"/internal/v1/me/invites?limit=2&cursor={page1['next_cursor']}",
                             headers=env.h(me))).json()
    page3 = (await env.c.get(f"/internal/v1/me/invites?limit=2&cursor={page2['next_cursor']}",
                             headers=env.h(me))).json()
    got = [i["invite_id"] for p in (page1, page2, page3) for i in p["items"]]
    assert got == list(reversed(created)) and page3["next_cursor"] is None
    bad = await env.c.get("/internal/v1/me/invites?cursor=garbage", headers=env.h(me))
    assert bad.status_code == 400 and bad.json()["code"] == "INVALID_CURSOR"
    assert (await env.c.get("/internal/v1/me/invites?limit=101", headers=env.h(me))).status_code == 422
    assert (await env.c.get("/internal/v1/me/invites?limit=0", headers=env.h(me))).status_code == 422


async def test_revoke_own_only(env) -> None:
    me, other = env.identity.add(), env.identity.add()
    iid, _ = await env.invite(me, "friend")
    foreign = await env.c.delete(f"/internal/v1/me/invites/{iid}", headers=env.h(other))
    assert foreign.status_code == 404 and foreign.json()["code"] == "INVITE_NOT_FOUND"
    for bad in (str(uuid.uuid4()), "not-a-uuid"):
        assert (await env.c.delete(f"/internal/v1/me/invites/{bad}", headers=env.h(me))).status_code == 404
    r = await env.c.delete(f"/internal/v1/me/invites/{iid}", headers=env.h(me))
    assert r.status_code == 200 and r.json()["status"] == "revoked"
    again = await env.c.delete(f"/internal/v1/me/invites/{iid}", headers=env.h(me))
    assert again.json() == r.json()


async def test_auth_and_callers(env) -> None:
    me = env.identity.add()
    iid = str(uuid.uuid4())
    endpoints = (("POST", "/internal/v1/me/invites"), ("GET", "/internal/v1/me/invites"),
                 ("DELETE", f"/internal/v1/me/invites/{iid}"), ("POST", "/internal/v1/invites:open"),
                 ("GET", f"/internal/v1/invites/{iid}/preview"), ("POST", f"/internal/v1/invites/{iid}/accept"),
                 ("POST", f"/internal/v1/invites/{iid}/decline"), ("GET", "/internal/v1/me/family"))
    for method, path in endpoints:
        r = await env.c.request(method, path, json={"kind": "friend", "token": "x"})
        assert r.status_code == 401 and r.json()["code"] == "INTERNAL_TOKEN_MISSING", path
        bad = await env.c.request(method, path, json={}, headers={"x-internal-token": "garbage"})
        assert bad.status_code == 401, path
        other = await env.c.request(method, path, json={}, headers=env.h(me, issuer="notifications"))
        assert other.status_code == 403 and other.json()["code"] == "CALLER_NOT_ALLOWED", path
        no_sub = await env.c.request(method, path, json={"kind": "friend", "token": "x"}, headers=env.h(None))
        assert no_sub.status_code == 401 and no_sub.json()["code"] == "USER_CONTEXT_REQUIRED", path
    wrong_aud = internal_headers(env.settings, subject=str(me), audience="learning-plan")
    assert (await env.c.get("/internal/v1/me/invites", headers=wrong_aud)).status_code == 401


async def test_identity_unavailable_is_503(env) -> None:
    me = env.identity.add()
    env.identity.down = True
    r = await env.create(me, "friend")
    assert r.status_code == 503 and r.json()["code"] == "UPSTREAM_UNAVAILABLE"
    assert await env.sql("SELECT invite_id FROM invites") == []
