"""Друзья, заявки, блокировки, поиск и связь учеников (§1.2, AT-73): заявка → принять/отклонить/отозвать, встречная
заявка = принятие (и одновременно — одна дружба), лимиты, блокировка (заявки в обе стороны, дружба, поиск),
поиск без детей и заблокированных, приватность (только member_id и ник), дружба через приглашение Telegram,
relations/members для gamification и lessons."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

BASE = "/internal/v1/me"


async def _accept(env, user, request_id, action="accept"):
    return await env.c.post(f"{BASE}/friend-requests/{request_id}/{action}", headers=env.lh(user))


async def test_request_accept_flow_and_privacy(env) -> None:
    a, b = env.identity.add("Азиза"), env.identity.add("Бобур")
    await env.nick(a, "Aziza")
    r = await env.request_friend(a, b, key="req-key-0001")
    assert r.status_code == 201, r.text
    view = r.json()
    assert view == {"request_id": view["request_id"], "direction": "out", "member_id": env.mid(b),
                    "nickname": None, "status": "pending", "created_at": "2026-11-16T08:00:00.000Z",
                    "decided_at": None}
    # повтор того же ключа — 200 тот же ответ; тот же ключ с другим телом — 422
    again = await env.request_friend(a, b, key="req-key-0001")
    assert again.status_code == 200 and again.json() == view and again.headers["Idempotent-Replayed"] == "true"
    other = env.identity.add()
    await env.community(other)
    r = await env.request_friend(a, env.mid(other), key="req-key-0001")
    assert r.status_code == 422 and r.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    [ev] = await env.events("social.friend_request.created.v1")
    assert ev.payload == {"request_id": view["request_id"], "from_user_id": str(a), "to_user_id": str(b),
                          "from_nickname": "Aziza", "created_at": "2026-11-16T08:00:00.000Z"}
    # входящие у b: только member_id и ник отправителя, никаких user_id и имён
    inbox = (await env.c.get(f"{BASE}/friend-requests", params={"direction": "in"}, headers=env.lh(b))).json()
    assert inbox["items"] == [{**view, "direction": "in", "member_id": env.mid(a), "nickname": "Aziza"}]
    assert str(a) not in str(inbox) and "Азиза" not in str(inbox)
    assert (await env.c.get(f"{BASE}/friend-requests", params={"direction": "out"},
                            headers=env.lh(a))).json()["items"][0]["request_id"] == view["request_id"]
    # отправитель не может принять свою заявку; чужой — 404
    assert (await _accept(env, a, view["request_id"])).json()["code"] == "REQUEST_NOT_FOUND"
    assert (await _accept(env, other, view["request_id"])).status_code == 404
    env.now += timedelta(minutes=5)
    r = await _accept(env, b, view["request_id"])
    assert r.status_code == 200 and r.json()["status"] == "accepted"
    assert r.json()["decided_at"] == "2026-11-16T08:05:00.000Z"
    # повтор с тем же исходом — 200; другой исход — 409 REQUEST_STATE
    assert (await _accept(env, b, view["request_id"])).status_code == 200
    r = await _accept(env, b, view["request_id"], "decline")
    assert r.status_code == 409 and r.json() == {**r.json(), "code": "REQUEST_STATE",
                                                 "details": {"status": "accepted"}}
    [fe] = await env.events("social.friendship.changed.v1")
    lo, hi = sorted([str(a), str(b)])
    assert fe.payload == {"user_a": lo, "user_b": hi, "status": "added", "source": "request",
                          "requester_user_id": str(a), "accepter_nickname": None,
                          "at": "2026-11-16T08:05:00.000Z"}
    friends_a = (await env.c.get(f"{BASE}/friends", headers=env.lh(a))).json()
    assert friends_a == {"items": [{"member_id": env.mid(b), "nickname": None,
                                    "since": "2026-11-16T08:05:00.000Z"}], "next_cursor": None}
    r = await env.request_friend(a, b)
    assert r.status_code == 409 and r.json()["code"] == "ALREADY_FRIENDS"


async def test_decline_cancel_and_exists(env) -> None:
    a, b = env.identity.add(), env.identity.add()
    rid = (await env.request_friend(a, b)).json()["request_id"]
    r = await env.request_friend(a, b)
    assert r.status_code == 409 and r.json()["code"] == "REQUEST_EXISTS"
    assert (await _accept(env, b, rid, "cancel")).json()["code"] == "REQUEST_NOT_FOUND"  # отзыв — только своей
    r = await _accept(env, b, rid, "decline")
    assert r.status_code == 200 and r.json()["status"] == "declined"
    assert (await _accept(env, a, rid, "cancel")).json()["details"] == {"status": "declined"}
    rid2 = (await env.request_friend(a, b)).json()["request_id"]
    assert (await _accept(env, a, rid2, "cancel")).json()["status"] == "cancelled"
    assert (await _accept(env, a, rid2, "cancel")).status_code == 200
    assert (await env.c.post(f"{BASE}/friend-requests/not-a-uuid/accept", headers=env.lh(b))).status_code == 422
    assert await env.events("social.friendship.changed.v1") == []


async def test_counter_request_is_accept(env) -> None:
    a, b = env.identity.add(), env.identity.add()
    await env.nick(b, "Bobur")
    rid = (await env.request_friend(a, b)).json()["request_id"]
    r = await env.request_friend(b, a)
    assert r.status_code == 200, r.text
    assert r.json()["request_id"] == rid and r.json()["status"] == "accepted" and r.json()["direction"] == "in"
    [fe] = await env.events("social.friendship.changed.v1")
    assert fe.payload["requester_user_id"] == str(a) and fe.payload["accepter_nickname"] == "Bobur"


async def test_simultaneous_counter_requests_make_one_friendship(env) -> None:
    for _ in range(3):
        a, b = env.identity.add(), env.identity.add()
        await env.community(a)
        await env.community(b)
        ra, rb = await asyncio.gather(env.request_friend(a, b), env.request_friend(b, a))
        assert sorted([ra.status_code, rb.status_code]) == [200, 201], (ra.text, rb.text)
        lo, hi = sorted([a, b], key=lambda u: u.int)
        assert len(await env.sql("SELECT 1 FROM friendships WHERE user_a = :a AND user_b = :b", a=lo, b=hi)) == 1
        assert len(await env.sql("SELECT 1 FROM friend_requests WHERE pair_a = :a", a=lo)) == 1
    assert len(await env.events("social.friendship.changed.v1")) == 3


async def test_request_errors_and_access(env) -> None:
    a = env.identity.add()
    r = await env.request_friend(a, env.mid(a))
    assert r.status_code == 404  # себя нет в реестре, пока не обращался
    await env.community(a)
    r = await env.request_friend(a, env.mid(a))
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"
    r = await env.request_friend(a, "mb_" + "x" * 22)
    assert r.status_code == 404 and r.json()["code"] == "MEMBER_NOT_FOUND"
    r = await env.c.post(f"{BASE}/friend-requests", json={"member_id": env.mid(a)}, headers=env.lh(a))
    assert r.status_code == 400 and r.json()["code"] == "IDEMPOTENCY_KEY_REQUIRED"
    r = await env.c.post(f"{BASE}/friend-requests", json={"member_id": "x", "user_id": str(a)},
                         headers={**env.lh(a), "Idempotency-Key": "k" * 10})
    assert r.status_code == 422
    # дети — FRIENDS_NOT_ALLOWED kids; подросток без согласия родителя; без цели social — CONSENT_REQUIRED
    parent = env.identity.add()
    child = env.identity.add(age="6-9", kind="child")
    b = env.identity.add()
    r = await env.request_friend(child, b, account=parent, age_band="6-9")
    assert r.status_code == 403 and r.json()["details"] == {"reason": "kids"}
    teen = env.identity.add(age="14-17")
    r = await env.request_friend(teen, b, age_band="14-17")
    assert r.status_code == 403 and r.json()["code"] == "FRIENDS_NOT_ALLOWED"
    assert r.json()["details"] == {"reason": "guardian_consent"}
    nos = env.identity.add(purposes=("terms", "privacy"))
    r = await env.request_friend(nos, b)
    assert r.status_code == 403 and r.json() == {**r.json(), "code": "CONSENT_REQUIRED",
                                                 "details": {"purpose": "social"}}
    # цель без доступа к друзьям (подросток без согласия, ребёнок) неотличима от несуществующей
    r = await env.request_friend(b, teen)
    assert r.status_code == 404 and r.json()["code"] == "MEMBER_NOT_FOUND"
    await env.community(child, account=parent, age_band="6-9")
    assert (await env.request_friend(b, env.mid(child))).status_code == 404
    env.identity.down = True
    r = await env.request_friend(b, env.mid(a))
    assert r.status_code == 503 and r.json()["details"] == {"service": "identity-consent"}


async def test_request_limits(env) -> None:
    me = env.identity.add()
    env.settings.friend_requests_per_day = 2  # type: ignore[misc]
    targets = [env.identity.add() for _ in range(3)]
    assert (await env.request_friend(me, targets[0])).status_code == 201
    assert (await env.request_friend(me, targets[1])).status_code == 201
    r = await env.request_friend(me, targets[2])
    assert r.status_code == 429 and r.json()["code"] == "REQUESTS_LIMIT" and r.json()["details"] == {"limit": 2}
    env.now += timedelta(hours=24, seconds=1)
    assert (await env.request_friend(me, targets[2])).status_code == 201
    # предел друзей — у любой из сторон
    env.settings.friends_max = 1  # type: ignore[misc]
    rid = (await env.c.get(f"{BASE}/friend-requests", params={"direction": "in"},
                           headers=env.lh(targets[0]))).json()["items"][0]["request_id"]
    assert (await _accept(env, targets[0], rid)).status_code == 200
    rid = (await env.c.get(f"{BASE}/friend-requests", params={"direction": "in"},
                           headers=env.lh(targets[1]))).json()["items"][0]["request_id"]
    r = await _accept(env, targets[1], rid)
    assert r.status_code == 409 and r.json() == {**r.json(), "code": "FRIENDS_LIMIT", "details": {"limit": 1}}
    r = await env.request_friend(env.identity.add(), me)
    assert r.status_code == 409 and r.json()["code"] == "FRIENDS_LIMIT"


async def test_request_expires_after_30_days(env) -> None:
    a, b = env.identity.add(), env.identity.add()
    rid = (await env.request_friend(a, b)).json()["request_id"]
    env.now += timedelta(days=30)
    assert (await env.c.get(f"{BASE}/friend-requests", params={"direction": "in"},
                            headers=env.lh(b))).json()["items"] == []
    r = await _accept(env, b, rid)
    assert r.status_code == 409 and r.json()["details"] == {"status": "expired"}
    assert (await env.tick_all())["friend_requests_expired"] == 1
    assert (await env.tick_all())["friend_requests_expired"] == 0
    rid2 = (await env.request_friend(a, b)).json()["request_id"]  # новая заявка после истечения — можно
    env.now += timedelta(days=31)
    assert (await env.tick_all())["friend_requests_expired"] == 1
    assert await env.sql("SELECT status FROM friend_requests WHERE request_id = :r", r=uuid.UUID(rid2)) == [
        ("expired",)]


async def test_block_cancels_requests_both_ways_and_removes_friendship(env) -> None:
    a, b, c = env.identity.add(), env.identity.add(), env.identity.add()
    await env.befriend(a, b)
    rid_ac = (await env.request_friend(a, c)).json()["request_id"]
    r = await env.c.post(f"{BASE}/blocks", json={"member_id": env.mid(b)}, headers=env.lh(a))
    assert r.status_code == 201 and r.json() == {"member_id": env.mid(b), "nickname": None,
                                                 "created_at": "2026-11-16T08:00:00.000Z"}
    again = await env.c.post(f"{BASE}/blocks", json={"member_id": env.mid(b)}, headers=env.lh(a))
    assert again.status_code == 200
    assert (await env.c.get(f"{BASE}/friends", headers=env.lh(a))).json()["items"] == []
    removed = [e for e in await env.events("social.friendship.changed.v1") if e.payload["status"] == "removed"]
    assert [e.payload["source"] for e in removed] == ["block"]
    [be] = await env.events("social.block.changed.v1")
    assert be.payload == {"blocker_user_id": str(a), "blocked_user_id": str(b), "status": "added",
                          "at": "2026-11-16T08:00:00.000Z"}
    # заявки в обе стороны: c → блокирует a, исходящая a→c и входящая отменены
    rid_ca_counter = (await env.request_friend(c, env.identity.add())).json()["request_id"]
    r = await env.c.post(f"{BASE}/blocks", json={"member_id": env.mid(a)}, headers=env.lh(c))
    assert r.status_code == 201
    assert await env.sql("SELECT status FROM friend_requests WHERE request_id = :r", r=uuid.UUID(rid_ac)) == [
        ("cancelled",)]
    assert await env.sql("SELECT status FROM friend_requests WHERE request_id = :r",
                         r=uuid.UUID(rid_ca_counter)) == [("pending",)]
    # заблокированный не может отправить заявку и не узнаёт, кто заблокировал: 403 BLOCKED в обе стороны
    for x, y in ((b, a), (a, b), (a, c), (c, a)):
        r = await env.request_friend(x, y)
        assert r.status_code == 403 and r.json()["code"] == "BLOCKED", (x, y)
        assert r.json()["details"] == {}
    # список и снятие блокировки (дружба не возвращается)
    blocks = (await env.c.get(f"{BASE}/blocks", headers=env.lh(a))).json()["items"]
    assert [x["member_id"] for x in blocks] == [env.mid(b)]
    r = await env.c.delete(f"{BASE}/blocks/{env.mid(b)}", headers=env.lh(a))
    assert r.status_code == 204
    assert (await env.c.delete(f"{BASE}/blocks/{env.mid(b)}", headers=env.lh(a))).status_code == 204
    assert [e.payload["status"] for e in await env.events("social.block.changed.v1")] == ["added", "added", "removed"]
    assert (await env.c.get(f"{BASE}/friends", headers=env.lh(a))).json()["items"] == []
    assert (await env.request_friend(a, b)).status_code == 201
    # дети блокировок не ставят
    parent = env.identity.add()
    child = env.identity.add(age="10-13", kind="child")
    r = await env.c.post(f"{BASE}/blocks", json={"member_id": env.mid(a)}, headers=env.lh(child, account=parent,
                                                                                         age_band="10-13"))
    assert r.status_code == 403 and r.json()["code"] == "KIDS_NOT_ALLOWED"


async def test_search_by_code_and_nickname(env) -> None:
    me, b = env.identity.add(), env.identity.add()
    await env.nick(b, "Bobur_07")
    code = (await env.community(b))["friend_code"]
    for q in (code, code.lower(), code.replace("-", ""), " " + code.lower().replace("-", "") + " "):
        r = await env.c.get(f"{BASE}/friends/search", params={"q": q}, headers=env.lh(me))
        assert r.status_code == 200 and r.json() == {"items": [{
            "member_id": env.mid(b), "nickname": "Bobur_07", "relation": "none", "request_id": None}]}, q
    for q in ("bobur_07", "BOBUR_07", "Воbur_07"):
        r = await env.c.get(f"{BASE}/friends/search", params={"q": q}, headers=env.lh(me))
        assert r.json()["items"][0]["member_id"] == env.mid(b), q
    for q in ("bobur", "TH-0000-0000", "zz", "x" * 25):
        r = await env.c.get(f"{BASE}/friends/search", params={"q": q}, headers=env.lh(me))
        assert r.status_code == 200 and r.json() == {"items": []}, q
    rid = (await env.request_friend(me, b)).json()["request_id"]
    card = (await env.c.get(f"{BASE}/friends/search", params={"q": code}, headers=env.lh(me))).json()["items"][0]
    assert card["relation"] == "request_out" and card["request_id"] == rid
    card = (await env.c.get(f"{BASE}/friends/search", params={"q": (await env.community(me))["friend_code"]},
                            headers=env.lh(b))).json()["items"][0]
    assert card["relation"] == "request_in"
    await _accept(env, b, rid)
    card = (await env.c.get(f"{BASE}/friends/search", params={"q": code}, headers=env.lh(me))).json()["items"][0]
    assert card["relation"] == "friend" and card["request_id"] is None
    own = (await env.c.get(f"{BASE}/friends/search", params={"q": "Bobur_07"}, headers=env.lh(b))).json()
    assert own["items"][0]["relation"] == "self"
    assert set(card) == {"member_id", "nickname", "relation", "request_id"}


async def test_search_hides_kids_and_blocked(env) -> None:
    me = env.identity.add()
    await env.community(me)
    parent = env.identity.add()
    child = env.identity.add(age="6-9", kind="child")
    await env.nick(child, "Kiddo", account=parent, age_band="6-9")
    teen = env.identity.add(age="14-17")
    await env.nick(teen, "Teeny", age_band="14-17")
    blocker, blocked = env.identity.add(), env.identity.add()
    await env.nick(blocker, "Blocker")
    await env.nick(blocked, "Blocked")
    await env.c.post(f"{BASE}/blocks", json={"member_id": env.mid(me)}, headers=env.lh(blocker))
    await env.c.post(f"{BASE}/blocks", json={"member_id": env.mid(blocked)}, headers=env.lh(me))
    for q in ("Kiddo", "Teeny", "Blocker", "Blocked"):
        r = await env.c.get(f"{BASE}/friends/search", params={"q": q}, headers=env.lh(me))
        assert r.json() == {"items": []}, q
    await env.grant_guardian_consent(teen)
    r = await env.c.get(f"{BASE}/friends/search", params={"q": "Teeny"}, headers=env.lh(me))
    assert r.json()["items"][0]["nickname"] == "Teeny"
    # сам ребёнок искать не может
    r = await env.c.get(f"{BASE}/friends/search", params={"q": "Teeny"},
                        headers=env.lh(child, account=parent, age_band="6-9"))
    assert r.status_code == 403 and r.json()["details"] == {"reason": "kids"}


async def test_friends_list_order_pagination_and_delete(env) -> None:
    me = env.identity.add()
    names = ["zeta", None, "Alpha", "beta", None]
    users = []
    for n in names:
        u = env.identity.add()
        if n:
            await env.nick(u, n)
        await env.befriend(u, me)
        users.append(u)
    first = (await env.c.get(f"{BASE}/friends", params={"limit": 2}, headers=env.lh(me))).json()
    assert [x["nickname"] for x in first["items"]] == ["Alpha", "beta"] and first["next_cursor"]
    second = (await env.c.get(f"{BASE}/friends", params={"limit": 2, "cursor": first["next_cursor"]},
                              headers=env.lh(me))).json()
    third = (await env.c.get(f"{BASE}/friends", params={"limit": 2, "cursor": second["next_cursor"]},
                             headers=env.lh(me))).json()
    assert [x["nickname"] for x in second["items"] + third["items"]] == ["zeta", None, None]
    assert third["next_cursor"] is None
    assert (await env.c.get(f"{BASE}/friends", params={"cursor": "!!"}, headers=env.lh(me))).status_code == 400
    r = await env.c.delete(f"{BASE}/friends/{env.mid(users[0])}", headers=env.lh(me))
    assert r.status_code == 204
    assert (await env.c.delete(f"{BASE}/friends/{env.mid(users[0])}", headers=env.lh(me))).status_code == 204
    removed = [e for e in await env.events("social.friendship.changed.v1") if e.payload["status"] == "removed"]
    assert len(removed) == 1 and removed[0].payload["source"] == "removed"
    assert (await env.c.delete(f"{BASE}/friends/mb_{'A' * 22}", headers=env.lh(me))).status_code == 404
    assert len((await env.c.get(f"{BASE}/friends", headers=env.lh(me))).json()["items"]) == 4


async def test_invite_friendship_publishes_event_and_respects_blocks(env) -> None:
    a, b = env.identity.add(), env.identity.add()
    iid, token = await env.invite(a, "friend")
    await env.open(b, token)
    assert (await env.accept(b, iid)).status_code == 200
    [fe] = await env.events("social.friendship.changed.v1")
    assert fe.payload["source"] == "invite" and fe.payload["status"] == "added"
    assert "requester_user_id" not in fe.payload
    # дружба через приглашение видна в списке друзей (member_id зарегистрирован)
    assert (await env.c.get(f"{BASE}/friends", headers=env.lh(a))).json()["items"][0]["member_id"] == env.mid(b)
    # блокировка — приглашение больше не создаёт дружбу
    c = env.identity.add()
    await env.community(c)
    await env.community(a)
    await env.c.post(f"{BASE}/blocks", json={"member_id": env.mid(a)}, headers=env.lh(c))
    iid2, token2 = await env.invite(a, "friend")
    await env.open(c, token2)
    r = await env.accept(c, iid2)
    assert r.status_code == 403 and r.json()["code"] == "BLOCKED"


async def test_relations_and_callers(env) -> None:
    a, b, c = env.identity.add(), env.identity.add(), env.identity.add(age="14-17")
    await env.befriend(a, b)
    r = await env.c.get(f"/internal/v1/relations/{a}/{b}", headers=env.svc("gamification"))
    assert r.status_code == 200, r.text
    assert r.json() == {"friends": True, "same_family": False, "blocked_any": False, "a_restricted": False,
                        "b_restricted": False, "a_restricted_until": None, "b_restricted_until": None,
                        "a_audience": "adults", "b_audience": "adults", "a_social_allowed": True,
                        "b_social_allowed": True, "a_member_id": env.mid(a), "b_member_id": env.mid(b)}
    r = await env.c.get(f"/internal/v1/relations/{a}/{c}", headers=env.svc("lessons"))
    assert r.json()["b_audience"] == "teens" and r.json()["b_social_allowed"] is False
    assert r.json()["friends"] is False
    # семья и ребёнок
    parent = env.identity.add()
    child = env.identity.add(age="6-9", kind="child")
    await env.profile_event("user.profile.created.v1", {"user_id": str(child), "kind": "child", "age_band": "6-9",
                                                        "guardian_user_id": str(parent),
                                                        "created_at": "2026-11-16T08:00:00Z"})
    r = await env.c.get(f"/internal/v1/relations/{child}/{parent}", headers=env.svc())
    assert r.json()["same_family"] is True and r.json()["a_audience"] == "kids"
    await env.c.post(f"{BASE}/blocks", json={"member_id": env.mid(a)}, headers=env.lh(b))
    assert (await env.c.get(f"/internal/v1/relations/{a}/{b}", headers=env.svc())).json()["blocked_any"] is True
    for issuer in ("telegram-bff", "admin-bff", "notifications"):
        r = await env.c.get(f"/internal/v1/relations/{a}/{b}", headers=env.svc(issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    assert (await env.c.get(f"/internal/v1/relations/{a}/{b}")).status_code == 401
    r = await env.c.get(f"/internal/v1/relations/{a}/{uuid.uuid4()}", headers=env.svc())
    assert r.status_code == 404 and r.json()["code"] == "MEMBER_NOT_FOUND"
    assert (await env.c.get(f"/internal/v1/relations/{a}/{a}", headers=env.svc())).status_code == 404
    env.identity.down = True
    assert (await env.c.get(f"/internal/v1/relations/{a}/{b}", headers=env.svc())).status_code == 503


async def test_learner_isolation(env) -> None:
    """Ученик — из токена: чужие заявки и друзья недоступны, user_id в теле не принимается."""
    a, b, c = env.identity.add(), env.identity.add(), env.identity.add()
    rid = (await env.request_friend(a, b)).json()["request_id"]
    for action in ("accept", "decline", "cancel"):
        r = await _accept(env, c, rid, action)
        assert r.status_code == 404 and r.json()["code"] == "REQUEST_NOT_FOUND", action
    assert (await env.c.get(f"{BASE}/friend-requests", params={"direction": "in"},
                            headers=env.lh(c))).json()["items"] == []
    # lrn в токене главнее sub: родитель с активным детским профилем — это ребёнок
    parent = env.identity.add()
    child = env.identity.add(age="6-9", kind="child")
    r = await env.c.get(f"{BASE}/friends", headers=env.lh(child, account=parent, age_band="6-9"))
    assert r.status_code == 403 and r.json()["details"] == {"reason": "kids"}
