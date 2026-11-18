"""Получатель (AT-09): открытие по deep link, карточка, двустороннее принятие, отклонение, семья и дружба;
самоприглашение и повторная активация отклоняются; дети и подростки — по правилам CONVENTIONS §8."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta


async def test_open_records_redemption_once(env) -> None:
    inviter, guest = env.identity.add("Азиза"), env.identity.add("Бобур")
    iid, token = await env.invite(inviter, "friend")
    r = await env.open(guest, token)
    assert r.status_code == 200, r.text
    assert r.json() == {"invite_id": iid, "kind": "friend", "inviter_display_name": "Азиза", "status": "active",
                        "can_accept": True, "reason": None}
    again = await env.open(guest, token)
    assert again.json() == r.json()
    [ev] = await env.events("social.invite.opened.v1")
    assert ev.payload == {"invite_id": iid, "inviter_user_id": str(inviter), "invitee_user_id": str(guest),
                          "kind": "friend", "opened_at": "2026-11-16T08:00:00Z"}
    # в ответе нет username/Telegram ID: только имя из identity-consent /public
    assert set(r.json()) == {"invite_id", "kind", "inviter_display_name", "status", "can_accept", "reason"}


async def test_open_self_unknown_and_malformed(env) -> None:
    inviter = env.identity.add("Азиза")
    iid, token = await env.invite(inviter, "referral")
    own = await env.open(inviter, token)
    assert own.status_code == 200 and own.json()["can_accept"] is False and own.json()["reason"] == "self"
    assert await env.events("social.invite.opened.v1") == []
    assert await env.sql("SELECT * FROM invite_redemptions") == []
    for bad in ("A" * 32, "short", "inv_" + token, token[:-1] + "!", "a" * 64):
        r = await env.open(inviter, bad)
        assert r.status_code == 404 and r.json()["code"] == "INVITE_NOT_FOUND", bad
    assert (await env.c.post("/internal/v1/invites:open", json={"token": "a" * 65},
                             headers=env.h(inviter))).status_code == 422
    # предпросмотр по id — только тому, кто уже открывал
    stranger = env.identity.add()
    r = await env.c.get(f"/internal/v1/invites/{iid}/preview", headers=env.h(stranger))
    assert r.status_code == 404 and r.json()["code"] == "INVITE_NOT_FOUND"
    assert (await env.c.get(f"/internal/v1/invites/{iid}/preview", headers=env.h(inviter))).status_code == 404
    await env.open(stranger, token)
    r = await env.c.get(f"/internal/v1/invites/{iid}/preview", headers=env.h(stranger))
    assert r.status_code == 200 and r.json()["can_accept"] is True


async def test_family_accept_is_two_way(env) -> None:
    mom, dad = env.identity.add("Мама"), env.identity.add("Папа")
    iid, token = await env.invite(mom, "family")
    # принять можно только открытое приглашение; своё — нельзя
    r = await env.accept(dad, iid)
    assert r.status_code == 404 and r.json()["code"] == "INVITE_NOT_FOUND"
    r = await env.accept(mom, iid)
    assert r.status_code == 409 and r.json()["code"] == "INVITE_SELF"
    await env.open(dad, token)
    env.now += timedelta(hours=1)
    r = await env.accept(dad, iid)
    assert r.status_code == 200, r.text
    body = r.json()
    family = body["family"]
    assert body["invite_id"] == iid and body["kind"] == "family"
    assert [(m["display_name"], m["role"], m["is_me"]) for m in family["members"]] == [
        ("Мама", "owner", False), ("Папа", "adult", True)]
    # повтор принятия — тот же результат, без новых событий
    again = await env.accept(dad, iid)
    assert again.status_code == 200 and again.json() == body
    [acc] = await env.events("social.invite.accepted.v1")
    assert acc.payload == {"invite_id": iid, "inviter_user_id": str(mom), "invitee_user_id": str(dad),
                           "kind": "family", "accepted_at": "2026-11-16T09:00:00Z"}
    [added] = await env.events("social.family.member_added.v1")
    assert added.payload == {"family_id": family["family_id"], "owner_user_id": str(mom), "user_id": str(dad),
                             "role": "adult", "added_at": "2026-11-16T09:00:00Z"}
    # обе стороны видят одну семью
    for user, me_name in ((mom, "Мама"), (dad, "Папа")):
        f = (await env.c.get("/internal/v1/me/family", headers=env.h(user))).json()
        assert f["family_id"] == family["family_id"]
        assert [m["display_name"] for m in f["members"] if m["is_me"]] == [me_name]
    # одноразовая ссылка: повторная активация другим человеком отклоняется
    aunt = env.identity.add("Тётя")
    preview = (await env.open(aunt, token)).json()
    assert preview["status"] == "accepted" and preview["reason"] == "already_used" and not preview["can_accept"]
    r = await env.accept(aunt, iid)
    assert r.status_code == 409 and r.json()["code"] == "INVITE_ALREADY_USED"
    listed = (await env.c.get("/internal/v1/me/invites", headers=env.h(mom))).json()["items"]
    assert listed[0]["status"] == "accepted" and listed[0]["accepted_count"] == 1
    lonely = env.identity.add()
    r = await env.c.get("/internal/v1/me/family", headers=env.h(lonely))
    assert r.status_code == 404 and r.json()["code"] == "FAMILY_NOT_FOUND"


async def test_family_rules(env) -> None:
    owner = env.identity.add("Владелец")
    teen = env.identity.add("Подросток", age="14-17")
    member = env.identity.add("Уже в семье")
    # member уже в другой семье
    other_owner = env.identity.add("Другая семья")
    oid, otok = await env.invite(other_owner, "family")
    await env.open(member, otok)
    assert (await env.accept(member, oid)).status_code == 200
    iid, token = await env.invite(owner, "family")
    p = (await env.open(member, token)).json()
    assert p["reason"] == "already_member" and p["can_accept"] is False
    r = await env.accept(member, iid)
    assert r.status_code == 409 and r.json()["code"] == "FAMILY_ALREADY_MEMBER"
    # подросток без согласия родителя — не может; после согласия — роль teen
    p = (await env.open(teen, token)).json()
    assert p["reason"] == "not_allowed"
    r = await env.accept(teen, iid)
    assert r.status_code == 403 and r.json()["code"] == "INVITES_NOT_ALLOWED"
    await env.grant_guardian_consent(teen)
    r = await env.accept(teen, iid)
    assert r.status_code == 200, r.text
    assert [(m["role"], m["is_me"]) for m in r.json()["family"]["members"]] == [("owner", False), ("teen", True)]


async def test_family_size_limit(env) -> None:
    env.settings.family_max_members = 2
    owner, first, second = env.identity.add(), env.identity.add(), env.identity.add()
    iid1, t1 = await env.invite(owner, "family")
    iid2, t2 = await env.invite(owner, "family")
    await env.open(first, t1)
    await env.open(second, t2)
    assert (await env.accept(first, iid1)).status_code == 200
    p = (await env.c.get(f"/internal/v1/invites/{iid2}/preview", headers=env.h(second))).json()
    assert p["reason"] == "not_allowed" and p["can_accept"] is False
    r = await env.accept(second, iid2)
    assert r.status_code == 409 and r.json()["code"] == "FAMILY_FULL" and r.json()["details"] == {"limit": 2}


async def test_expired_and_revoked(env) -> None:
    inviter, guest = env.identity.add(), env.identity.add()
    fam_id, fam_token = await env.invite(inviter, "family")
    fr_id, fr_token = await env.invite(inviter, "friend")
    await env.open(guest, fam_token)
    await env.open(guest, fr_token)
    await env.c.delete(f"/internal/v1/me/invites/{fr_id}", headers=env.h(inviter))
    r = await env.accept(guest, fr_id)
    assert r.status_code == 409 and r.json()["code"] == "INVITE_REVOKED"
    assert (await env.open(guest, fr_token)).json()["reason"] == "revoked"
    env.now += timedelta(days=7)  # ровно срок — уже истекло
    p = (await env.open(guest, fam_token)).json()
    assert p["status"] == "expired" and p["reason"] == "expired"
    r = await env.accept(guest, fam_id)
    assert r.status_code == 409 and r.json()["code"] == "INVITE_EXPIRED"


async def test_friend_and_referral(env) -> None:
    host = env.identity.add("Хост")
    a, b = env.identity.add("А"), env.identity.add("Б")
    fid, ftoken = await env.invite(host, "friend")
    await env.open(a, ftoken)
    r = await env.accept(a, fid)
    assert r.status_code == 200 and r.json() == {"invite_id": fid, "kind": "friend", "family": None}
    [(ua, ub)] = await env.sql("SELECT user_a, user_b FROM friendships")
    assert {ua, ub} == {host, a} and ua.int < ub.int
    # реферальная — многоразовая; уже друзья — нельзя
    rid, rtoken = await env.invite(host, "referral")
    p = (await env.open(a, rtoken)).json()
    assert p["reason"] == "already_friends"
    r = await env.accept(a, rid)
    assert r.status_code == 409 and r.json()["code"] == "ALREADY_FRIENDS"
    await env.open(b, rtoken)
    assert (await env.accept(b, rid)).status_code == 200
    c = env.identity.add("В")
    await env.open(c, rtoken)
    assert (await env.accept(c, rid)).status_code == 200
    mine = (await env.c.get("/internal/v1/me/invites", headers=env.h(host))).json()["items"]
    assert {i["invite_id"]: (i["status"], i["accepted_count"]) for i in mine}[rid] == ("active", 2)
    # повторная активация реферала: тот же получатель по чужой реферальной ссылке — отклоняется
    other_host = env.identity.add("Другой")
    oid, otoken = await env.invite(other_host, "referral")
    p = (await env.open(b, otoken)).json()
    assert p["reason"] == "already_used"
    r = await env.accept(b, oid)
    assert r.status_code == 409 and r.json()["code"] == "INVITE_ALREADY_USED"
    accepted = await env.events("social.invite.accepted.v1")
    assert [(e.payload["invitee_user_id"], e.payload["kind"]) for e in accepted] == [
        (str(a), "friend"), (str(b), "referral"), (str(c), "referral")]


async def test_decline(env) -> None:
    inviter, guest = env.identity.add("Азиза"), env.identity.add()
    iid, token = await env.invite(inviter, "friend")
    r = await env.decline(guest, iid)
    assert r.status_code == 404  # не открывал
    await env.open(guest, token)
    r = await env.decline(guest, iid)
    assert r.status_code == 200 and r.json()["invite_id"] == iid and r.json()["status"] == "active"
    assert (await env.decline(guest, iid)).status_code == 200
    [ev] = await env.events("social.invite.declined.v1")
    assert ev.payload == {"invite_id": iid, "inviter_user_id": str(inviter), "invitee_user_id": str(guest),
                          "kind": "friend", "declined_at": "2026-11-16T08:00:00Z"}
    assert (await env.decline(inviter, iid)).json()["code"] == "INVITE_SELF"
    # передумал — можно принять, пока ссылка активна; после принятия отклонение ничего не меняет
    assert (await env.accept(guest, iid)).status_code == 200
    assert (await env.decline(guest, iid)).status_code == 200
    assert len(await env.events("social.invite.declined.v1")) == 1


async def test_concurrent_accept_of_one_time_invite(env) -> None:
    inviter = env.identity.add()
    guests = [env.identity.add() for _ in range(3)]
    iid, token = await env.invite(inviter, "family")
    for g in guests:
        await env.open(g, token)
    results = await asyncio.gather(*[env.accept(g, iid) for g in guests])
    assert sorted(r.status_code for r in results) == [200, 409, 409]
    assert len(await env.events("social.invite.accepted.v1")) == 1
    [(n,)] = await env.sql("SELECT count(*) FROM family_members")
    assert n == 2


async def test_isolation_between_users(env) -> None:
    alice, bob, eve = env.identity.add(), env.identity.add(), env.identity.add()
    iid, token = await env.invite(alice, "friend")
    await env.open(bob, token)
    # eve не открывала: ни карточка, ни принятие, ни отклонение по id ей недоступны
    for method, path in (("GET", f"/internal/v1/invites/{iid}/preview"),
                         ("POST", f"/internal/v1/invites/{iid}/accept"),
                         ("POST", f"/internal/v1/invites/{iid}/decline")):
        r = await env.c.request(method, path, headers=env.h(eve))
        assert r.status_code == 404 and r.json()["code"] == "INVITE_NOT_FOUND", path
    assert (await env.c.get("/internal/v1/me/invites", headers=env.h(bob))).json()["items"] == []
    for bad in ("not-a-uuid", str(uuid.uuid4())):
        assert (await env.accept(bob, bad)).status_code == 404
