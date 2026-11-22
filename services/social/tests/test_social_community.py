"""Профиль сообщества (§1.1, AT-73): ленивое создание, member_id (формат §0, стабилен, не раскрывает user_id), ник
(формат, запрещённые слова, двойники кириллица/латиница, уникальность, кулдаун), код друга (смена ≤ 3 в сутки),
скрытие игрового профиля → social.profile.updated.v1; дети; доступ; удалённый ученик под блокировкой."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import re
import uuid
from datetime import timedelta

from conftest import MEMBER_KEY

from tilhero_social.domain import nicknames

CODE_RE = re.compile(r"^TH-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$")


async def test_profile_created_lazily_with_member_id(env) -> None:
    me = env.identity.add("Азиза")
    assert await env.sql("SELECT * FROM community_profiles") == []
    body = await env.community(me)
    assert set(body) == {"member_id", "nickname", "friend_code", "game_profile_hidden", "restrictions",
                         "nickname_change_available_at", "friends_available", "friends_unavailable_reason"}
    assert body["nickname"] is None and body["game_profile_hidden"] is False
    assert CODE_RE.match(body["friend_code"])
    assert body["restrictions"] == {"social_ban": False, "social_ban_until": None}
    assert body["friends_available"] is True and body["friends_unavailable_reason"] is None
    assert body["nickname_change_available_at"] is None
    # формат §0: "mb_" + base64url(HMAC-SHA256(MEMBER_ID_KEY, str(user_id))[:16]) без "="
    digest = hmac.new(MEMBER_KEY.encode(), str(me).encode(), hashlib.sha256).digest()[:16]
    assert body["member_id"] == "mb_" + base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    assert re.match(r"^mb_[A-Za-z0-9_-]{22}$", body["member_id"])
    # повтор — тот же профиль и тот же код; события о создании нет (изменились только ник и скрытие)
    again = await env.community(me)
    assert again == body
    assert await env.events("social.profile.updated.v1") == []


async def test_member_id_stable_and_opaque(env) -> None:
    a, b = env.identity.add("А"), env.identity.add("Б")
    ma = (await env.community(a))["member_id"]
    assert (await env.community(a))["member_id"] == ma
    assert (await env.community(b))["member_id"] != ma
    # не раскрывает user_id: ни uuid, ни его частей в hex/base64
    for part in (str(a), a.hex, a.hex[:8], base64.urlsafe_b64encode(a.bytes).decode().rstrip("=")[:10]):
        assert part not in ma
    # тот же member_id выдаёт и семья (§10 п. 1), и реестр отвечает только gamification/lessons
    r = await env.c.get(f"/internal/v1/members/{ma}", headers=env.svc("gamification"))
    assert r.status_code == 200 and r.json() == {"user_id": str(a)}
    assert (await env.c.get(f"/internal/v1/members/{ma}", headers=env.svc("lessons"))).status_code == 200
    r = await env.c.get(f"/internal/v1/members/{ma}", headers=env.svc("telegram-bff"))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    for bad in ("mb_" + "A" * 22, "mb_short", str(a)):
        r = await env.c.get(f"/internal/v1/members/{bad}", headers=env.svc())
        assert r.status_code == 404 and r.json()["code"] == "MEMBER_NOT_FOUND", bad


async def test_family_members_have_member_id(env) -> None:
    mom, dad = env.identity.add("Мама"), env.identity.add("Папа")
    iid, token = await env.invite(mom, "family")
    await env.open(dad, token)
    await env.accept(dad, iid)
    fam = (await env.c.get("/internal/v1/me/family", headers=env.h(mom))).json()
    assert [(m["user_id"], m["member_id"]) for m in fam["members"]] == [(str(mom), env.mid(mom)),
                                                                          (str(dad), env.mid(dad))]
    r = await env.c.get(f"/internal/v1/members/{env.mid(dad)}", headers=env.svc("lessons"))
    assert r.json() == {"user_id": str(dad)}


async def test_nickname_rules(env) -> None:
    me = env.identity.add()
    for bad, reason in (("ab", "length"), ("a" * 21, "length"), ("  ", "length"), ("bob smith", "chars"),
                        ("bob!", "chars"), ("ник😀", "chars"), ("Ωmega", "chars"), ("fuck_you", "forbidden"),
                        ("Sh1tHead", "forbidden"), ("хуйло", "forbidden"), ("ХУЙ_2", "forbidden"),
                        ("Админ", "forbidden"), ("Аdmin", "forbidden"), ("adm1n", "forbidden"),
                        ("TilHero_bot", "forbidden"), ("jalab", "forbidden"), ("Сука123", "forbidden")):
        r = await env.nick(me, bad)
        assert r.status_code == 422, (bad, r.text)
        assert r.json()["code"] == "NICKNAME_INVALID" and r.json()["details"] == {"reason": reason}, bad
    # RU / UZ (кириллица и латиница с ʻ) / EN, цифры, «_»; пробелы по краям убираются; й из «и + ˘» — NFC
    for ok in ("Азиза_07", "Oʻgʻiloy", "Ўткир", "Қаҳрамон", "Bobur2009", "Nazira", "Amanda", "Себастьян"):
        assert nicknames.validate(ok)[1] is None, ok
    r = await env.nick(me, "  Бобур_1  ")
    assert r.status_code == 200 and r.json()["nickname"] == "Бобур_1"
    assert nicknames.validate("Сергей")[0] == "Сергей"
    # тот же ник — 200 без смены и без события
    [ev] = await env.events("social.profile.updated.v1")
    assert ev.payload == {"user_id": str(me), "member_id": env.mid(me), "nickname": "Бобур_1",
                          "game_profile_hidden": False, "updated_at": "2026-11-16T08:00:00.000Z"}
    assert (await env.nick(me, "Бобур_1")).status_code == 200
    assert len(await env.events("social.profile.updated.v1")) == 1


async def test_nickname_unique_case_and_twins(env) -> None:
    a, b = env.identity.add(), env.identity.add()
    assert (await env.nick(a, "Bobur")).status_code == 200
    # регистр, кириллические двойники (В, о), ё/е — тот же ник
    for twin in ("bobur", "BOBUR", "Воbur", "ВОВUR"):
        r = await env.nick(b, twin)
        assert r.status_code == 409 and r.json()["code"] == "NICKNAME_TAKEN", twin
    assert (await env.nick(b, "Алёна")).status_code == 200
    c = env.identity.add()
    r = await env.nick(c, "Алена")
    assert r.status_code == 409 and r.json()["code"] == "NICKNAME_TAKEN"
    # себе сменить регистр своего ника можно (кулдаун — отдельно)
    assert nicknames.unique_key("Bobur") == nicknames.unique_key("Воbur")


async def test_nickname_race_unique(env) -> None:
    users = [env.identity.add() for _ in range(5)]
    for u in users:
        await env.community(u)
    results = await asyncio.gather(*(env.nick(u, "Racer") for u in users))
    assert sorted(r.status_code for r in results) == [200, 409, 409, 409, 409]


async def test_nickname_cooldown(env) -> None:
    me = env.identity.add()
    assert (await env.nick(me, "First")).status_code == 200
    body = await env.community(me)
    assert body["nickname_change_available_at"] == "2026-11-23T08:00:00.000Z"
    env.now += timedelta(days=6, hours=23)
    r = await env.nick(me, "Second")
    assert r.status_code == 429 and r.json()["code"] == "NICKNAME_COOLDOWN"
    assert r.json()["details"] == {"until": "2026-11-23T08:00:00.000Z"}
    env.now += timedelta(hours=1)
    assert (await env.nick(me, "Second")).json()["nickname"] == "Second"


async def test_friend_code_rotation_limit(env) -> None:
    me = env.identity.add()
    old = (await env.community(me))["friend_code"]
    codes = {old}
    for _ in range(3):
        r = await env.c.post("/internal/v1/me/community/friend-code:rotate", headers=env.lh(me))
        assert r.status_code == 200, r.text
        codes.add(r.json()["friend_code"])
    assert len(codes) == 4 and all(CODE_RE.match(c) for c in codes)
    r = await env.c.post("/internal/v1/me/community/friend-code:rotate", headers=env.lh(me))
    assert r.status_code == 429 and r.json()["code"] == "FRIEND_CODE_LIMIT"
    assert r.json()["details"] == {"until": "2026-11-17T08:00:00.000Z"}
    # прежний код больше не находится
    other = env.identity.add()
    r = await env.c.get("/internal/v1/me/friends/search", params={"q": old}, headers=env.lh(other))
    assert r.json() == {"items": []}
    env.now += timedelta(hours=24)
    assert (await env.c.post("/internal/v1/me/community/friend-code:rotate", headers=env.lh(me))).status_code == 200


async def test_hide_game_profile(env) -> None:
    me = env.identity.add()
    r = await env.c.patch("/internal/v1/me/community", json={"game_profile_hidden": True}, headers=env.lh(me))
    assert r.status_code == 200 and r.json()["game_profile_hidden"] is True
    [ev] = await env.events("social.profile.updated.v1")
    assert ev.payload["game_profile_hidden"] is True and ev.payload["nickname"] is None
    # повтор и пустой PATCH — без события
    await env.c.patch("/internal/v1/me/community", json={"game_profile_hidden": True}, headers=env.lh(me))
    await env.c.patch("/internal/v1/me/community", json={}, headers=env.lh(me))
    assert len(await env.events("social.profile.updated.v1")) == 1
    r = await env.c.patch("/internal/v1/me/community", json={"game_profile_hidden": "yes", "x": 1},
                          headers=env.lh(me))
    assert r.status_code == 422


async def test_kids_teens_consent_in_profile(env) -> None:
    parent = env.identity.add("Мама")
    child = env.identity.add("Малыш", age="6-9", kind="child")
    body = await env.community(child, account=parent, age_band="6-9")
    assert body["friends_available"] is False and body["friends_unavailable_reason"] == "kids"
    assert child not in env.identity.calls and str(child) not in env.identity.calls  # детям — без identity
    teen = env.identity.add("Тимур", age="14-17")
    assert (await env.community(teen, age_band="14-17"))["friends_unavailable_reason"] == "guardian_consent"
    await env.grant_guardian_consent(teen)
    assert (await env.community(teen, age_band="14-17"))["friends_available"] is True
    no_social = env.identity.add("Без цели", purposes=("terms", "privacy"))
    assert (await env.community(no_social))["friends_unavailable_reason"] == "consent"
    no_age = env.identity.add("Без возраста", age=None)
    assert (await env.community(no_age))["friends_unavailable_reason"] == "kids"
    # дети могут задать ник (виден только семье)
    assert (await env.nick(child, "Малыш_1", account=parent, age_band="6-9")).status_code == 200


async def test_auth_and_upstream(env) -> None:
    me = env.identity.add()
    assert (await env.c.get("/internal/v1/me/community")).status_code == 401
    r = await env.c.get("/internal/v1/me/community", headers=env.lh(me, issuer="admin-bff"))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    r = await env.c.get("/internal/v1/me/community", headers=env.lh(me, issuer="gamification"))
    assert r.status_code == 403
    env.identity.down = True
    r = await env.c.get("/internal/v1/me/community", headers=env.lh(me))
    assert r.status_code == 503 and r.json()["code"] == "UPSTREAM_UNAVAILABLE"
    assert r.json()["details"] == {"service": "identity-consent"}


async def test_deleted_user_checked_under_lock(env) -> None:
    """Сага и запись профиля сериализуются блокировкой ученика: после саги профиль не воскресает (410)."""
    me = env.identity.add()
    await env.nick(me, "Gone")
    await env.publish("user.deletion.requested.v1", {"user_id": str(me), "request_id": str(uuid.uuid4()),
                                                     "requested_at": "2026-11-16T08:00:00Z"}, "identity-consent")
    assert await env.sql("SELECT * FROM community_profiles WHERE user_id = :u", u=me) == []
    r = await env.c.get("/internal/v1/me/community", headers=env.lh(me))
    assert r.status_code == 410 and r.json()["code"] == "USER_DELETED"
    assert await env.sql("SELECT * FROM community_profiles WHERE user_id = :u", u=me) == []
    assert await env.sql("SELECT * FROM member_ids WHERE user_id = :u", u=me) == []
    # ник освобождён
    other = env.identity.add()
    assert (await env.nick(other, "Gone")).status_code == 200
