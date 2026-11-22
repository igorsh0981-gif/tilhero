"""Лиги недели (INTERNAL_API спринта 7 §2.2, AT-74, AT-80, AT-81): лига друзей и семейная на лету (скрытые и
заблокированные не видны, ребёнок видит только семью, приватность строк), общая лига по желанию (ник обязателен —
409, санкция — 403, дети — 403), группы по паре и полосе, вступление в середине недели, выключение; закрытие недели
одной транзакцией на группу — повтор без вторых призов; гонка закрытия и запоздавшего XP; аномалии с удержанием,
снятие удержания и переоценка с новой версией и исправлением призов; история; админ-API (права, step-up, аудит)."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

from conftest import Env

from tilhero_gamification.domain import weeks

W0 = date(2026, 11, 16)  # неделя T0 (пятница 20.11)
W1 = W0 + timedelta(days=7)
W0_END = datetime(2026, 11, 22, 19, 0, tzinfo=UTC)  # понедельник 23.11 00:00 Ташкент


async def learner(env: Env, nickname: str | None = None, *, opt_in: bool = False, level: str | None = None,
                  **hk: Any) -> uuid.UUID:
    u = uuid.uuid4()
    await env.send("PATCH", u, "settings", {"quests_hidden": True}, **hk)  # XP только за уроки — детерминированно
    if nickname:
        await env.community(u, nickname)
    if level:
        await env.diag(u, level)
    if opt_in:
        await env.send("PATCH", u, "settings", {"league_opt_in": True}, **hk)
    return u


def rows(st: dict[str, Any]) -> list[tuple[str | None, int, int, bool]]:
    return [(r["nickname"], r["xp"], r["place"], r["me"]) for r in st["rows"]]


async def test_friends_and_family_leagues_privacy(env: Env) -> None:
    a = await learner(env, "Alpha")
    b = await learner(env, "Bravo")
    c = await learner(env, "Charlie")
    d = await learner(env, "Delta")
    for other in (b, c, d):
        await env.befriend(a, other)
    await env.community(c, "Charlie", hidden=True)
    await env.block(a, d)
    for user, n in ((a, 1), (b, 2), (c, 3), (d, 4)):
        await env.xp(user, n)
    view = await env.get(a, "leagues")
    assert view["week"] == W0.isoformat() and view["ends_at"] == "2026-11-22T19:00:00.000Z"
    assert rows(view["friends"]) == [("Bravo", 60, 1, False), ("Alpha", 30, 2, True)]  # скрытый и заблокированный
    assert view["friends"]["participants"] == 2 and view["friends"]["total_xp"] == 90
    assert view["friends"]["me_row"] is None and view["family"] is None
    row = view["friends"]["rows"][0]
    assert set(row) == {"member_id", "nickname", "hero", "xp", "place", "badges", "me"}
    assert row["member_id"] == env.mid(b) and row["badges"] == ["first_lesson"]
    dump = json.dumps(view)
    assert all(str(u) not in dump for u in (a, b, c, d))  # user_id наружу не уходит
    # скрытый видит себя (и друзей); другие его — нет
    assert rows((await env.get(c, "leagues"))["friends"]) == [("Charlie", 90, 1, True), ("Alpha", 30, 2, False)]
    # заблокированный не видит заблокировавшего (в любую сторону)
    assert all(r["member_id"] != env.mid(a) for r in (await env.get(d, "leagues"))["friends"]["rows"])
    # героя видно: картинка ступени
    await env.send("PUT", b, "hero", {"hero_code": "robot_0"})
    hero = (await env.get(a, "leagues"))["friends"]["rows"][0]["hero"]
    assert hero["code"] == "robot_0" and hero["stage"] == 1 and hero["image"]["url"].startswith("/v1/game/assets/")


async def test_family_league_and_kids(env: Env) -> None:
    parent = await learner(env, "Parent")
    kid = uuid.uuid4()
    teen = await learner(env, None)
    await env.family(parent, (kid, "child"), (teen, "teen"))
    friend = await learner(env, "Friend")
    await env.befriend(parent, friend)
    kid_h = {"age_band": "6-9", "account": parent}
    await env.send("PATCH", kid, "settings", {"quests_hidden": True}, **kid_h)
    await env.xp(kid, 2)
    await env.xp(parent, 1)
    k = await env.get(kid, "leagues", **kid_h)
    assert k["friends"] is None  # детям — только семья
    fam = k["family"]
    assert [(r["xp"], r["me"]) for r in fam["rows"]] == [(60, True), (30, False), (0, False)]
    assert fam["total_xp"] == 90 and fam["participants"] == 3
    assert all(r["member_id"] != env.mid(friend) for r in fam["rows"])  # незнакомых нет
    assert k["general"] == {"opt_in": False, "available": False, "unavailable_reason": "kids", "pair_id": None,
                            "level_band": None, "group": None, "prizes": [50, 30, 20]}
    out = await env.send("PATCH", kid, "settings", {"league_opt_in": True}, 403, **kid_h)
    assert out["code"] == "KIDS_NOT_ALLOWED"
    # опекун видит семью и свою лигу друзей
    p = await env.get(parent, "leagues")
    assert p["family"]["participants"] == 3 and rows(p["friends"]) == [("Parent", 30, 1, True), ("Friend", 0, 2, False)]


async def test_opt_in_rules_mid_week_join_and_opt_out(env: Env) -> None:
    nobody = await learner(env)
    out = await env.send("PATCH", nobody, "settings", {"league_opt_in": True}, 409)
    assert out["code"] == "NICKNAME_REQUIRED"
    assert (await env.get(nobody, "settings"))["league_opt_in"] is False
    banned = await learner(env, "Banned")
    await env.sanction(banned, days=None)
    out = await env.send("PATCH", banned, "settings", {"league_opt_in": True}, 403)
    assert out["code"] == "SOCIAL_RESTRICTED" and out["details"] == {"until": None}
    g = (await env.get(banned, "leagues"))["general"]
    assert (g["available"], g["unavailable_reason"]) == (False, "restricted")
    # включение в середине недели — группа сразу
    a = await learner(env, "Alpha", level="A2")
    s = await env.send("PATCH", a, "settings", {"league_opt_in": True})
    assert s["league_opt_in"] is True
    b = await learner(env, "Bravo", opt_in=True, level="A2")
    other_band = await learner(env, "Other", opt_in=True, level="B1")
    await env.xp(b, 1)
    g = (await env.get(a, "leagues"))["general"]
    assert (g["opt_in"], g["available"], g["pair_id"], g["level_band"]) == (True, True, "ru-en", "A2")
    assert rows(g["group"]) == [("Bravo", 30, 1, False), ("Alpha", 0, 2, True)]
    assert (await env.get(other_band, "leagues"))["general"]["group"]["participants"] == 1  # другая полоса
    groups = await env.sql("SELECT week, pair_id, level_band, group_no FROM league_groups ORDER BY level_band")
    assert [(g_[1], g_[2], g_[3]) for g_ in groups] == [("ru-en", "A2", 1), ("ru-en", "B1+", 1)]
    # выключение: неделя доигрывается без строки в рейтинге
    await env.send("PATCH", a, "settings", {"league_opt_in": False})
    assert (await env.get(a, "leagues"))["general"]["group"] is None
    assert rows((await env.get(b, "leagues"))["general"]["group"]) == [("Bravo", 30, 1, True)]
    # снова включил — та же группа
    await env.send("PATCH", a, "settings", {"league_opt_in": True})
    assert (await env.get(b, "leagues"))["general"]["group"]["participants"] == 2
    assert await env.sql("SELECT count(*) FROM league_members WHERE user_id = :u", u=a) == [(1,)]
    # скрытый профиль: участие сохранено, в группе не виден
    await env.community(a, "Alpha", hidden=True)
    g = (await env.get(a, "leagues"))["general"]
    assert (g["available"], g["unavailable_reason"], g["group"]) == (False, "hidden", None)
    assert (await env.get(b, "leagues"))["general"]["group"]["participants"] == 1


async def test_week_close_once_prizes_and_history(env: Env) -> None:
    u1 = await learner(env, "First", opt_in=True)
    u2 = await learner(env, "Second", opt_in=True)
    u3 = await learner(env, "Third", opt_in=True)
    await env.xp(u1, 3)
    await env.xp(u2, 1)
    [(gid,)] = await env.sql("SELECT group_id FROM league_groups WHERE week = :w", w=W0)
    env.now = W0_END + timedelta(minutes=5)
    out = await env.tick()
    assert out["league_groups_closed"] == 1 and out["league_members_assigned"] == 3  # новая неделя — группы
    assert (await env.tick())["league_groups_closed"] == 0  # повтор закрытия ничего не меняет
    prizes = await env.sql("SELECT user_id, amount, idempotency_key FROM ledger WHERE reason = 'league_prize' "
                           "ORDER BY amount DESC")
    assert [(u, a) for u, a, _ in prizes] == [(u1, 50), (u2, 30)]  # без XP приза нет
    assert prizes[0][2] == f"league:{W0}:{gid}:{u1}"
    [ev] = await env.events("game.league.closed.v1")
    assert ev.payload["version"] == 1 and ev.payload["prizes_held"] is False
    assert [(s["user_id"], s["place"], s["xp"], s["prize_til"]) for s in ev.payload["standings"]] == [
        (str(u1), 1, 90, 50), (str(u2), 2, 30, 30), (str(u3), 3, 0, 0)]
    [(status,)] = await env.sql("SELECT status FROM league_weeks WHERE week = :w", w=W0)
    assert status == "closed"
    # итоги неизменяемы
    import pytest

    with pytest.raises(Exception, match="immutable"):
        await env.sql("UPDATE league_results SET prizes_held = true")
    hist = await env.get(u1, "leagues/history")
    assert hist["items"] == [{"week": W0.isoformat(), "pair_id": "ru-en", "level_band": "A0-A1", "place": 1,
                              "participants": 3, "xp": 90, "prize_til": 50, "prize_held": False, "version": 1,
                              "closed_at": hist["items"][0]["closed_at"]}]
    assert (await env.get(u1, "leagues"))["week"] == W1.isoformat()
    assert (await env.get(u1, "leagues"))["general"]["group"]["participants"] == 3


async def test_close_race_with_late_xp(env: Env) -> None:
    u = await learner(env, "Late", opt_in=True)
    await env.xp(u, 1)
    late = W0_END - timedelta(minutes=1)
    # запоздавшее событие до закрытия — в свою неделю
    env.now = W0_END + timedelta(minutes=1)
    await env.xp(u, 1, finished_at=late)
    # закрытие держит исключительную блокировку недели: событие ждёт и уходит в следующую неделю
    async with env.runtime.transaction() as db:
        await weeks.mark_closing(db, W0, env.now)
        task = asyncio.create_task(env.xp(u, 1, finished_at=late))
        await asyncio.sleep(0.5)
        assert not task.done(), "XP закрывающейся недели ждёт отметку closing"
    await task
    await env.xp(u, 1, finished_at=late)  # после отметки — сразу в текущую
    weeks_of = [w for (w,) in await env.sql(
        "SELECT league_week FROM ledger WHERE user_id = :u AND currency = 'xp' ORDER BY created_at", u=u)]
    assert weeks_of == [W0, W0, W1, W1]
    await env.tick()
    [ev] = await env.events("game.league.closed.v1")
    assert ev.payload["standings"][0]["xp"] == 60  # в закрытую неделю после закрытия XP не попал
    assert (await env.get(u, "leagues"))["general"]["group"]["rows"][0]["xp"] == 60  # XP новой недели


async def anomaly_rules(env: Env) -> None:
    def mutate(p: dict[str, Any]) -> None:
        p["league"]["anomaly"] = {"median_factor": 2, "min_xp": 50}

    await env.activate(mutate)


async def test_anomaly_hold_release_and_reevaluate(env: Env) -> None:
    await anomaly_rules(env)
    cheat = await learner(env, "Cheat", opt_in=True)
    u2 = await learner(env, "Honest", opt_in=True)
    u3 = await learner(env, "Third", opt_in=True)
    outsider = uuid.uuid4()
    await env.xp(cheat, 4)
    await env.xp(u2, 1)
    await env.xp(u3, 1)
    [(gid,)] = await env.sql("SELECT group_id FROM league_groups WHERE week = :w", w=W0)
    # открытая группа — переоценка и снятие удержания недоступны
    body = {"exclude_user_ids": [], "reason": "проверка аномалии"}
    assert (await env.adm("POST", f"leagues/{gid}/reevaluate", body, 409))["details"] == {"status": "open"}
    env.now = W0_END + timedelta(minutes=5)
    await env.tick()
    [ev1] = await env.events("game.league.closed.v1")
    assert ev1.payload["prizes_held"] is True and all(s["prize_til"] == 0 for s in ev1.payload["standings"])
    assert await env.sql("SELECT count(*) FROM ledger WHERE reason = 'league_prize'") == [(0,)]
    grp = await env.adm("GET", f"leagues/{gid}", perms=("league.read",))
    assert grp["status"] == "held" and grp["anomalies"] == 1
    assert {m["user_id"]: (m["place"], m["prize_til"], m["anomaly"]) for m in grp["members"]} == {
        str(cheat): (1, 50, True), str(u2): (2, 30, False), str(u3): (3, 20, False)}  # u2 набрал раньше u3
    week = await env.adm("GET", f"leagues?week={W0.isoformat()}", perms=("league.read",))
    assert week["status"] == "closed" and week["participants"] == 3 and week["prizes_til"] == 0
    assert [(g["status"], g["size"], g["anomalies"]) for g in week["groups"]] == [("held", 3, 1)]
    # снятие удержания — league.manage, только held → версия 2, призы выданы
    await env.adm("POST", f"leagues/{gid}/release-prizes", {"reason": "аномалия проверена"}, 403,
                  perms=("league.read",))
    rel = await env.adm("POST", f"leagues/{gid}/release-prizes", {"reason": "аномалия проверена"}, step_up=False)
    assert rel["status"] == "closed" and rel["version"] == 2
    assert (await env.adm("POST", f"leagues/{gid}/release-prizes", {"reason": "аномалия проверена"}, 409))[
        "details"] == {"status": "closed"}
    # переоценка: исключить нарушителя (step-up) → версия 3, призы исправлены обратными записями
    body = {"exclude_user_ids": [str(cheat)], "reason": "накрутка XP подтверждена"}
    assert (await env.adm("POST", f"leagues/{gid}/reevaluate", body, 403, step_up=False))["code"] == \
        "STEP_UP_REQUIRED"
    await env.adm("POST", f"leagues/{gid}/reevaluate", {**body, "exclude_user_ids": [str(outsider)]}, 422)
    await env.adm("POST", f"leagues/{uuid.uuid4()}/reevaluate", body, 404)
    grp = await env.adm("POST", f"leagues/{gid}/reevaluate", body)
    assert grp["version"] == 3 and [r["version"] for r in grp["results"]] == [3, 2, 1]
    v3, v2, v1 = grp["results"]
    assert v3["excluded_user_ids"] == [str(cheat)] and v3["closed_by"]["name"] == "Оператор"
    assert [(s["user_id"], s["prize_til"]) for s in v3["standings"]] == [(str(u2), 50), (str(u3), 30)]
    assert [(s["user_id"], s["prize_til"]) for s in v2["standings"]] == [  # прежняя версия хранится
        (str(cheat), 50), (str(u2), 30), (str(u3), 20)]
    assert v1["prizes_held"] is True and v1["closed_by"] is None
    members = {m["user_id"]: m for m in grp["members"]}
    assert members[str(cheat)]["excluded"] and members[str(cheat)]["place"] is None
    prize = {u: sum(op.amount for op in await env.ops(u) if op.reason in ("league_prize", "reversal"))
             for u in (cheat, u2, u3)}
    assert prize == {cheat: 0, u2: 50, u3: 30}
    for u in (cheat, u2, u3):
        assert (await env.wallet(u))["til"] == sum(op.amount for op in await env.ops(u, bonus=True)
                                                   if op.currency == "til")
    events = [(e.payload["version"], e.payload["prizes_held"]) for e in await env.events("game.league.closed.v1")]
    assert events == [(1, True), (2, False), (3, False)]
    actions = [e.payload["action"] for e in await env.events("admin.audit.recorded.v1")]
    assert {"game.league.prizes_released", "game.league.reevaluated"} <= set(actions)
    # повтор с пустым списком — исключение сохраняется (накапливаются), призы не меняются
    again = await env.adm("POST", f"leagues/{gid}/reevaluate", {"exclude_user_ids": [], "reason": "пересчёт итогов"})
    assert again["version"] == 4 and again["results"][0]["excluded_user_ids"] == [str(cheat)]
    assert len([op for op in await env.ops(u2) if op.reason == "league_prize"]) == 2
    # история ученика — по последней версии
    h = (await env.get(u2, "leagues/history"))["items"][0]
    assert (h["place"], h["prize_til"], h["version"]) == (1, 50, 4)
    assert (await env.get(cheat, "leagues/history"))["items"] == []


async def test_league_admin_rights(env: Env) -> None:
    await env.adm("GET", "leagues", expect=403, perms=("game.read",))
    week = await env.adm("GET", "leagues?week=2026-11-18", perms=("league.read",))  # среда → её неделя
    assert week["week"] == W0.isoformat() and week["groups"] == [] and week["status"] == "open"
    await env.adm("GET", f"leagues/{uuid.uuid4()}", expect=404, perms=("league.read",))
    r = await env.c.get("/internal/v1/admin/game/leagues", headers=env.svc("telegram-bff"))
    assert r.status_code == 403
    u = await learner(env, "Solo", opt_in=True)
    [(gid,)] = await env.sql("SELECT group_id FROM league_groups")
    grp = await env.adm("GET", f"leagues/{gid}", perms=("league.read",))
    assert grp["status"] == "open" and grp["results"] == [] and grp["members"][0]["user_id"] == str(u)
    assert grp["members"][0]["member_id"] == env.mid(u) and grp["members"][0]["nickname"] == "Solo"


async def test_week_xp_only_allowed_reasons(env: Env) -> None:
    a = await learner(env, "Alpha")
    b = await learner(env, "Bravo")
    await env.befriend(a, b)
    await env.xp(a, 1)
    await env.grant(a, "xp", 500)  # ручная операция — не XP недели
    await env.profile(a)  # бонус регистрации — не XP
    await env.review(a)  # повторение — XP недели
    view = await env.get(b, "leagues")
    xp = {r["nickname"]: r["xp"] for r in view["friends"]["rows"]}
    [(review_xp,)] = await env.sql("SELECT sum(amount) FROM ledger WHERE user_id = :u AND reason = 'review' "
                                   "AND currency = 'xp'", u=a)
    assert xp["Alpha"] == 30 + int(review_xp)
    assert await env.sql("SELECT league_week FROM ledger WHERE user_id = :u AND reason = 'manual'", u=a) == [(None,)]


async def test_parallel_close_of_one_group(env: Env) -> None:
    from tilhero_gamification.domain import leagues

    u = await learner(env, "Solo", opt_in=True)
    await env.xp(u, 1)
    [(gid,)] = await env.sql("SELECT group_id FROM league_groups")
    env.now = W0_END + timedelta(minutes=1)

    async def close() -> Any:
        async with env.runtime.transaction() as db:
            return await leagues.close_group(db, env.settings, gid, env.now)

    results = await asyncio.gather(close(), close())
    assert results.count("closed") == 1 and results.count(None) == 1
    assert await env.sql("SELECT count(*) FROM league_results") == [(1,)]
    assert await env.sql("SELECT count(*) FROM ledger WHERE reason = 'league_prize'") == [(1,)]
    assert len(await env.events("game.league.closed.v1")) == 1


async def test_group_size_overflow_and_balanced_formation(env: Env) -> None:
    def small(p: dict[str, Any]) -> None:
        p["league"]["group_size"] = [2, 2]

    await env.activate(small)
    users = [await learner(env, f"User_{i}", opt_in=True) for i in range(3)]
    sizes = await env.sql("SELECT g.group_no, count(*) FROM league_members m JOIN league_groups g USING (group_id) "
                          "GROUP BY g.group_no ORDER BY g.group_no")
    assert sizes == [(1, 2), (2, 1)]  # в середине недели: группа с местом или новая
    late = [await learner(env, f"Late_{i}") for i in range(2)]
    for u in late:
        await env.sql("UPDATE learners SET league_opt_in = true WHERE user_id = :u", u=u)  # без группы до tick
    env.now = W0_END + timedelta(minutes=5)
    out = await env.tick()
    assert out["league_members_assigned"] == 5
    sizes = await env.sql("SELECT count(*) FROM league_members m JOIN league_groups g USING (group_id) "
                          "WHERE g.week = :w GROUP BY g.group_no ORDER BY g.group_no", w=W1)
    assert sorted(n for (n,) in sizes) == [1, 2, 2]  # ceil(5 / 2) = 3 группы поровну
    assert (await env.tick())["league_members_assigned"] == 0
    del users


async def test_social_routes_auth(env: Env) -> None:
    u = uuid.uuid4()
    learner_routes = [("GET", "leagues"), ("GET", "leagues/history"), ("GET", "duels"),
                      ("GET", f"duels/{uuid.uuid4()}"), ("POST", "duels"), ("POST", f"duels/{uuid.uuid4()}/accept"),
                      ("POST", f"duels/{uuid.uuid4()}/decline")]
    for method, path in learner_routes:
        r = await env.c.request(method, f"/internal/v1/game/{path}")
        assert r.status_code == 401, (path, r.text)
        r = await env.c.request(method, f"/internal/v1/game/{path}", headers=env.h(u, issuer="admin-bff"))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", (path, r.text)
    reason = "достаточно длинная причина"
    admin_routes = [("GET", "leagues", None), ("GET", f"leagues/{uuid.uuid4()}", None), ("GET", "duels", None),
                    ("GET", "duels/stats", None), ("GET", f"duels/{uuid.uuid4()}", None),
                    ("POST", f"leagues/{uuid.uuid4()}/reevaluate", {"exclude_user_ids": [], "reason": reason}),
                    ("POST", f"leagues/{uuid.uuid4()}/release-prizes", {"reason": reason}),
                    ("POST", f"duels/{uuid.uuid4()}/reevaluate", {"result": "draw", "reason": reason})]
    for method, path, body in admin_routes:
        r = await env.c.request(method, f"/internal/v1/admin/game/{path}", headers=env.svc("telegram-bff"),
                                json=body)
        assert r.status_code == 403, (path, r.text)
        r = await env.c.request(method, f"/internal/v1/admin/game/{path}", headers=env.staff("game.manage"),
                                json=body)
        assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED", (path, r.text)
    # Idempotency-Key обязателен для вызова на дуэль; 422 на неверный member_id
    r = await env.c.post("/internal/v1/game/duels", json={"opponent_member_id": env.mid(u)}, headers=env.h(u))
    assert r.status_code == 400 and r.json()["code"] == "IDEMPOTENCY_KEY_REQUIRED"
    out = await env.send("POST", u, "duels", {"opponent_member_id": str(u)}, 422, key="k-bad-member")
    assert out["code"] == "VALIDATION_ERROR"
    assert (await env.send("POST", u, "duels?x=1", {"opponent_member_id": env.mid(u), "extra": 1}, 422,
                           key="k-extra-field"))["code"] == "VALIDATION_ERROR"
    assert (await env.get(u, "leagues/history", 400, params={"cursor": "!!"}))["code"] == "INVALID_CURSOR"


async def test_sanction_mid_week_removes_from_general_league(env: Env) -> None:
    """Санкция social_ban запрещает участие в общей лиге: пока действует — без строки в рейтинге и без приза."""
    a = await learner(env, "Alpha", opt_in=True)
    b = await learner(env, "Bravo", opt_in=True)
    await env.xp(a, 2)
    await env.xp(b, 1)
    await env.sanction(a, days=None)
    g = (await env.get(a, "leagues"))["general"]
    assert (g["available"], g["unavailable_reason"], g["group"]) == (False, "restricted", None)
    assert rows((await env.get(b, "leagues"))["general"]["group"]) == [("Bravo", 30, 1, True)]
    env.now = W0_END + timedelta(minutes=5)
    await env.tick()
    [ev] = await env.events("game.league.closed.v1")
    assert [(s["user_id"], s["prize_til"]) for s in ev.payload["standings"]] == [(str(b), 50)]
    assert await env.sql("SELECT count(*) FROM league_members WHERE user_id = :u AND week = :w", u=a, w=W1) == [(0,)]
