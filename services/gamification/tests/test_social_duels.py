"""Дуэли (INTERNAL_API спринта 7 §2.3, AT-75): вызов (social relations, лимиты, уровни, Idempotency-Key), принятие с
набором lessons (503 — дуэль остаётся challenged; два одновременных принятия — один набор), отказ, истечение;
счёт из lesson.session.completed.v1 kind duel (только lessons, повтор — один результат); завершение: победа, ничья,
техническая победа по дедлайну, cancelled; дневной лимит наград; переоценка админом с историей и обратными записями;
изоляция учеников (чужая дуэль — 404), счёт соперника — только после завершения; дети — только семья."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from typing import Any

from conftest import Env


async def pair(env: Env, a: uuid.UUID, b: uuid.UUID, nick_a: str = "Alpha", nick_b: str = "Bravo") -> None:
    await env.community(a, nick_a)
    await env.community(b, nick_b)
    await env.befriend(a, b)


async def score(env: Env, user: uuid.UUID, duel_id: str, correct: int, total: int = 10, *,
                producer: str = "lessons", status: str = "completed", session_id: uuid.UUID | None = None) -> None:
    await env.publish("lesson.session.completed.v1", {
        "session_id": str(session_id or uuid.uuid4()), "user_id": str(user), "kind": "duel", "pair_id": "ru-en",
        "status": status, "minutes": 3, "practice_only": True, "evaluation_id": None, "passed": None,
        "finished_at": env.ts(), "duel_id": duel_id, "score": {"correct": correct, "total": total}}, producer)


async def accepted(env: Env, a: uuid.UUID, b: uuid.UUID) -> str:
    d = await env.challenge(a, b)
    await env.send("POST", b, f"duels/{d['duel_id']}/accept")
    return str(d["duel_id"])


def xp_ops(ops: list[Any], duel_id: str) -> list[tuple[int, str]]:
    return [(op.amount, op.status) for op in ops if op.reason in ("duel", "reversal") and op.currency == "xp"]


async def test_challenge_accept_finish_win(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    await pair(env, a, b)
    await env.diag(a, "B1")
    await env.diag(b, "A2")
    d = await env.challenge(a, b, key="k-duel-001")
    assert d["status"] == "challenged" and d["role"] == "challenger" and d["level_band"] == "A2"  # нижняя полоса
    assert d["opponent"] == {"member_id": env.mid(b), "nickname": "Bravo", "hero": None}
    assert "user_id" not in str(d) and str(b) not in str(d)  # user_id соперника наружу не уходит
    # повтор ключа — та же дуэль (200); тот же ключ с другим телом — 422
    again = await env.challenge(a, b, 200, key="k-duel-001")
    assert again["duel_id"] == d["duel_id"]
    out = await env.send("POST", a, "duels", {"opponent_member_id": env.mid(b), "pair_id": "uz-en"}, 422,
                         key="k-duel-001")
    assert out["code"] == "IDEMPOTENCY_KEY_REUSED"
    [ev] = await env.events("game.duel.challenged.v1")
    assert ev.payload["opponent_user_id"] == str(b) and ev.payload["challenger_nickname"] == "Alpha"
    # соперник видит вызов и может принять; вызвавший — нет
    view_b = await env.get(b, f"duels/{d['duel_id']}")
    assert view_b["role"] == "opponent" and view_b["can_accept"] and view_b["opponent"]["member_id"] == env.mid(a)
    assert (await env.send("POST", a, f"duels/{d['duel_id']}/accept", None, 404))["code"] == "DUEL_NOT_FOUND"
    acc = await env.send("POST", b, f"duels/{d['duel_id']}/accept")
    assert acc["status"] == "accepted" and acc["can_play"] and acc["play_deadline"]
    assert env.lessons.calls == [{"duel_id": d["duel_id"], "pair_id": "ru-en", "level_band": "A2",
                                  "user_ids": [str(a), str(b)]}]
    assert (await env.send("POST", b, f"duels/{d['duel_id']}/accept"))["status"] == "accepted"  # повтор — 200
    assert (await env.send("POST", b, f"duels/{d['duel_id']}/decline", None, 409))["code"] == "DUEL_STATE"
    # счёт: только от lessons; повтор — один результат; до завершения счёт соперника не виден
    await score(env, a, d["duel_id"], 9, producer="memory")
    await score(env, a, d["duel_id"], 7)
    await score(env, a, d["duel_id"], 10)
    mid = await env.get(b, f"duels/{d['duel_id']}")
    assert mid["opponent_played"] and not mid["my_played"] and mid["result"] is None
    sid_b = uuid.uuid4()
    await score(env, b, d["duel_id"], 5, session_id=sid_b)
    # экран наград сессии: завершивший дуэль — ready (XP), сыгравший раньше — none (награда — в DuelView)
    rw = await env.get(b, "rewards", params={"source_session_id": str(sid_b)})
    assert rw["status"] == "ready" and [(o["reason"], o["amount"]) for o in rw["operations"]] == [("duel", 10)]
    sid_a = uuid.UUID((await env.get(a, f"duels/{d['duel_id']}"))["my_session"]["session_id"])
    assert (await env.get(a, "rewards", params={"source_session_id": str(sid_a)}))["status"] == "none"
    fin_a = await env.get(a, f"duels/{d['duel_id']}")
    fin_b = await env.get(b, f"duels/{d['duel_id']}")
    assert fin_a["status"] == "finished" and fin_a["result"] == {
        "outcome": "win", "technical": False, "my_score": {"correct": 7, "total": 10},
        "opponent_score": {"correct": 5, "total": 10}, "xp": 30, "version": 1}
    assert fin_b["result"]["outcome"] == "loss" and fin_b["result"]["xp"] == 10
    assert fin_a["my_session"]["status"] == "completed"
    [fe] = await env.events("game.duel.finished.v1")
    assert fe.payload["result"] == "challenger" and fe.payload["result_version"] == 1
    assert fe.payload["scores"] == {"challenger": {"correct": 7, "total": 10}, "opponent": {"correct": 5, "total": 10}}
    duel_ops = [op for op in await env.ops(a) if op.reason == "duel"]
    assert [(op.amount, op.idempotency_key) for op in duel_ops] == [(30, f"duel:{d['duel_id']}:{a}")]
    # списки: активные / завершённые; чужой — 404
    assert (await env.get(a, "duels", params={"status": "active"}))["items"] == []
    assert [x["duel_id"] for x in (await env.get(a, "duels", params={"status": "finished"}))["items"]] == [
        d["duel_id"]]
    assert (await env.get(uuid.uuid4(), f"duels/{d['duel_id']}", 404))["code"] == "DUEL_NOT_FOUND"


async def test_challenge_checks(env: Env) -> None:
    a, b, c, stranger = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await pair(env, a, b)
    await env.community(stranger, "Stranger")
    # себе — 422; неизвестный member_id — 404; не друг — 403 PARTNER_NOT_ALLOWED
    await env.community(a, "Alpha")
    assert (await env.challenge(a, a, 422))["code"] == "VALIDATION_ERROR"
    out = await env.send("POST", a, "duels", {"opponent_member_id": "mb_" + "x" * 22}, 404, key="k-duel-404")
    assert out["code"] == "MEMBER_NOT_FOUND"
    assert (await env.challenge(a, stranger, 403))["code"] == "PARTNER_NOT_ALLOWED"
    # уровни различаются больше чем на одну полосу
    await env.diag(a, "B2")
    await env.diag(b, "A1")
    assert (await env.challenge(a, b, 409))["code"] == "LEVELS_INCOMPATIBLE"
    await env.diag(b, "A2")
    # блокировка (в любую сторону) — 403 BLOCKED, без раскрытия кто
    await env.block(b, a)
    assert (await env.challenge(a, b, 403))["code"] == "BLOCKED"
    await env.block(b, a, "removed")
    # санкция вызывающего — 403 SOCIAL_RESTRICTED {until}; санкция соперника — PARTNER_NOT_ALLOWED
    sid = await env.sanction(a, days=3)
    out = await env.challenge(a, b, 403)
    assert out["code"] == "SOCIAL_RESTRICTED" and out["details"]["until"]
    await env.sanction(a, active=False, sanction_id=sid)
    env.social.relate(a, b, restricted={str(b)})
    assert (await env.challenge(a, b, 403))["code"] == "PARTNER_NOT_ALLOWED"
    env.social.relate(a, b, restricted=set())
    # одна активная дуэль на пару; не больше 3 активных вызовов
    d = await env.challenge(a, b)
    out = await env.challenge(b, a, 409)
    assert out["code"] == "DUEL_EXISTS" and out["details"]["duel_id"] == d["duel_id"]
    others = [uuid.uuid4() for _ in range(3)]
    for i, o in enumerate(others):
        await pair(env, a, o, "Alpha", f"Other_{i}")
        await env.diag(o, "B1")
    await env.challenge(a, others[0])
    await env.challenge(a, others[1])
    assert (await env.challenge(a, others[2], 409))["code"] == "DUELS_LIMIT"
    # social недоступен — 503 UPSTREAM_UNAVAILABLE {service}, дуэли нет
    env.social.down = True
    await pair(env, c, b, "Charlie", "Bravo")
    out = await env.challenge(c, b, 503)
    assert out["code"] == "UPSTREAM_UNAVAILABLE" and out["details"] == {"service": "social"}
    env.social.down = False
    assert await env.sql("SELECT count(*) FROM duels WHERE challenger = :c", c=c) == [(0,)]


async def test_member_resolved_via_social_and_kids_family_only(env: Env) -> None:
    parent, kid, friend = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await env.family(parent, (kid, "child"))
    env.social.audience[str(kid)] = "kids"
    # ребёнок вызывает родителя (member_id вычисляется из семьи, без social /members)
    d = await env.challenge(kid, parent, age_band="6-9", account=parent)
    assert d["opponent"]["member_id"] == env.mid(parent)
    assert not [c for c in env.social.calls if "/members/" in c]
    # друг ребёнка невозможен: дружба без семьи — 403 PARTNER_NOT_ALLOWED (детям — только семья)
    env.social.members[env.mid(friend)] = str(friend)
    env.social.relate(kid, friend, friends=True)
    assert (await env.challenge(kid, friend, 403, age_band="6-9", account=parent))["code"] == "PARTNER_NOT_ALLOWED"
    assert [c for c in env.social.calls if "/members/" in c]  # не друг и не семья по проекциям → social


async def test_accept_unavailable_lessons_and_concurrent_accepts(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    await pair(env, a, b)
    d = await env.challenge(a, b)
    env.lessons.down = True
    out = await env.send("POST", b, f"duels/{d['duel_id']}/accept", None, 503)
    assert out["code"] == "DUEL_SET_UNAVAILABLE"
    assert (await env.get(b, f"duels/{d['duel_id']}"))["status"] == "challenged"
    env.lessons.down = False
    env.lessons.delay = 0.3
    results = await asyncio.gather(*[env.c.post(f"/internal/v1/game/duels/{d['duel_id']}/accept",
                                                headers=env.h(b)) for _ in range(2)])
    assert [r.status_code for r in results] == [200, 200], [r.text for r in results]
    assert {r.json()["status"] for r in results} == {"accepted"}
    assert len(env.lessons.sets) == 1  # один набор на дуэль
    [(set_id, accepted_at)] = await env.sql("SELECT set_id, accepted_at FROM duels WHERE duel_id = :d",
                                            d=uuid.UUID(d["duel_id"]))
    assert str(set_id) == env.lessons.sets[d["duel_id"]] and accepted_at is not None


async def test_decline_expire_and_block_cancels(env: Env) -> None:
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await pair(env, a, b)
    await pair(env, a, c, "Alpha", "Charlie")
    d1 = await env.challenge(a, b)
    dec = await env.send("POST", b, f"duels/{d1['duel_id']}/decline")
    assert dec["status"] == "declined" and (await env.send("POST", b, f"duels/{d1['duel_id']}/decline"))
    assert (await env.send("POST", b, f"duels/{d1['duel_id']}/accept", None, 409))["details"] == {
        "status": "declined"}
    # блокировка отменяет вызов
    d2 = await env.challenge(a, c)
    await env.block(c, a)
    assert (await env.get(a, f"duels/{d2['duel_id']}"))["status"] == "cancelled"
    await env.block(c, a, "removed")
    # без ответа 24 ч — expired (tick); принять после дедлайна — 409 DUEL_STATE {expired}
    d3 = await env.challenge(a, b)
    env.now += timedelta(hours=25)
    assert (await env.send("POST", b, f"duels/{d3['duel_id']}/accept", None, 409))["details"] == {"status": "expired"}
    d4 = await env.challenge(a, c)
    env.now += timedelta(hours=25)
    assert (await env.tick())["duels_expired"] == 1
    assert (await env.get(c, f"duels/{d4['duel_id']}"))["status"] == "expired"
    assert env.lessons.calls == []


async def test_deadline_technical_draw_cancelled(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    await pair(env, a, b)
    # ничья
    d1 = await accepted(env, a, b)
    await score(env, a, d1, 6)
    await score(env, b, d1, 6)
    r = (await env.get(a, f"duels/{d1}"))["result"]
    assert r["outcome"] == "draw" and r["xp"] == 15 and not r["technical"]
    # сыграл один — техническая победа по дедлайну (tick после play_deadline + grace)
    d2 = await accepted(env, a, b)
    await score(env, b, d2, 2)
    env.now += timedelta(hours=48, minutes=10)
    assert (await env.tick())["duels_finished"] == 0  # grace: lessons закрывает незаконченные сессии
    env.now += timedelta(minutes=30)
    assert (await env.tick())["duels_finished"] == 1
    rb = (await env.get(b, f"duels/{d2}"))["result"]
    ra = (await env.get(a, f"duels/{d2}"))["result"]
    assert rb == {**rb, "outcome": "win", "technical": True, "xp": 30, "opponent_score": None}
    assert ra["outcome"] == "loss" and ra["xp"] == 0 and ra["my_score"] is None
    # никто не сыграл — cancelled, без наград, событие status cancelled
    d3 = await accepted(env, a, b)
    env.now += timedelta(hours=49)
    await env.tick()
    v = await env.get(a, f"duels/{d3}")
    assert v["status"] == "cancelled" and v["result"] is None
    events = {e.payload["duel_id"]: e.payload for e in await env.events("game.duel.finished.v1")}
    assert events[d3]["status"] == "cancelled" and events[d3]["result"] == "none"
    assert events[d2]["technical"] is True and events[d2]["result"] == "opponent"
    # счёт после завершения не меняет результат
    await score(env, a, d2, 10)
    assert (await env.get(a, f"duels/{d2}"))["result"]["my_score"] is None


async def test_daily_cap_of_rewarded_duels(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    await pair(env, a, b)
    xs = []
    for i in range(4):
        d = await accepted(env, a, b)
        await score(env, a, d, 8)
        await score(env, b, d, 3 + (i % 2))
        xs.append((await env.get(a, f"duels/{d}"))["result"]["xp"])
    assert xs == [30, 30, 30, 0]  # не больше 3 наградных дуэлей в день
    assert len([op for op in await env.ops(b) if op.reason == "duel"]) == 3
    # следующий день — снова
    env.now += timedelta(days=1)
    d = await accepted(env, a, b)
    await score(env, a, d, 8)
    await score(env, b, d, 1)
    assert (await env.get(a, f"duels/{d}"))["result"]["xp"] == 30


async def test_admin_reevaluate_history_and_rights(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    await pair(env, a, b)
    d = await accepted(env, a, b)
    await env.adm("POST", f"duels/{d}/reevaluate", {"result": "draw", "reason": "спор по результату"}, 409)
    await score(env, a, d, 9)
    await score(env, b, d, 4)
    body = {"result": "opponent", "reason": "списывание подтверждено"}
    await env.adm("POST", f"duels/{d}/reevaluate", body, 403, perms=("league.read",))
    out = await env.adm("POST", f"duels/{d}/reevaluate", body, 403, step_up=False)
    assert out["code"] == "STEP_UP_REQUIRED"
    await env.adm("POST", f"duels/{d}/reevaluate", {"result": "opponent", "reason": "коротко"}, 422)
    await env.adm("POST", f"duels/{uuid.uuid4()}/reevaluate", body, 404)
    view = await env.adm("POST", f"duels/{d}/reevaluate", body)
    assert view["result"] == "opponent" and view["result_version"] == 2
    assert [(h["version"], h["result"]) for h in view["history"]] == [(2, "opponent"), (1, "challenger")]
    assert view["history"][0]["reason"] == "списывание подтверждено" and view["history"][1]["by"] is None
    by_user = {}
    for r in view["rewards"]:
        by_user.setdefault(r["user_id"], []).append((r["amount"], r["status"], r["result_version"]))
    assert by_user[str(a)] == [(30, "reversed", 1), (-30, "confirmed", 2), (10, "confirmed", 2)]
    assert by_user[str(b)] == [(10, "reversed", 1), (-10, "confirmed", 2), (30, "confirmed", 2)]
    assert (await env.get(a, f"duels/{d}"))["result"] == {**(await env.get(a, f"duels/{d}"))["result"],
                                                          "outcome": "loss", "xp": 10, "version": 2}
    finished = [e.payload for e in await env.events("game.duel.finished.v1")]
    assert [(e["result"], e["result_version"]) for e in finished] == [("challenger", 1), ("opponent", 2)]
    [audit] = [e for e in await env.events("admin.audit.recorded.v1") if e.payload["action"] == "game.duel.reevaluated"]
    assert audit.payload["reason"] == "списывание подтверждено"
    # кошельки = сумма реестра
    assert (await env.wallet(a))["xp"] == sum(op.amount for op in await env.ops(a, bonus=True) if op.currency == "xp")
    # админ-списки и обзор
    rows = await env.adm("GET", "duels", perms=("league.read",))
    assert [r["duel_id"] for r in rows["items"]] == [d] and rows["items"][0]["challenger_user_id"] == str(a)
    assert (await env.adm("GET", "duels?status=accepted", perms=("league.read",)))["items"] == []
    assert (await env.adm("GET", f"duels/{d}", perms=("league.read",)))["set_id"]
    await env.adm("GET", f"duels/{uuid.uuid4()}", expect=404, perms=("league.read",))
    await env.adm("GET", "duels", expect=403, perms=("game.read",))
    stats = await env.adm("GET", "duels/stats?period=today", perms=("dashboard.read",))
    assert stats == {"period": "today", "duels_finished": 1}


async def test_relations_extra_fields(env: Env) -> None:
    """Поля social сверх §1.2: срок санкции из relations; подросток без согласия родителя — 403 FRIENDS_NOT_ALLOWED
    {guardian_consent}, но с семьёй дуэль доступна; соперник без доступа к социальному — PARTNER_NOT_ALLOWED."""
    teen, friend, sibling = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await pair(env, teen, friend, "Teen", "Friend")
    await env.family(teen, (sibling, "adult"))
    env.social.audience[str(teen)] = "teens"
    env.social.social_allowed[str(teen)] = False
    out = await env.challenge(teen, friend, 403, age_band="14-17")
    assert out["code"] == "FRIENDS_NOT_ALLOWED" and out["details"] == {"reason": "guardian_consent"}
    assert (await env.challenge(teen, sibling, 201, age_band="14-17"))["status"] == "challenged"
    env.social.social_allowed[str(teen)] = True
    env.social.social_allowed[str(friend)] = False
    assert (await env.challenge(teen, friend, 403, age_band="14-17"))["code"] == "PARTNER_NOT_ALLOWED"
    env.social.social_allowed[str(friend)] = True
    env.social.relate(teen, friend, restricted={str(teen)})
    env.social.restricted_until[str(teen)] = "2026-12-01T00:00:00.000Z"
    out = await env.challenge(teen, friend, 403, age_band="14-17")
    assert out["code"] == "SOCIAL_RESTRICTED" and out["details"] == {"until": "2026-12-01T00:00:00.000Z"}
