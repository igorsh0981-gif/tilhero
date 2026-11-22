"""API ученика и общие механизмы: 401/403 (чужой вызывающий, нет actor, планировщик), изоляция учеников, награды
занятия (pending | ready | none, чужая сессия — none), дети (аудитория, тихие праздники, мягкие задания), картинки
без sub, сага удаления, tick (сверка кошельков, один tick за раз), обзор."""

from __future__ import annotations

import uuid
from datetime import timedelta

import asyncpg
from conftest import SCHEDULER_TOKEN, Env
from sqlalchemy.engine import make_url

from tilhero_common.testing import TEST_ADMIN_URL
from tilhero_gamification.domain.tick import TICK_LOCK_CLASS, tick_lock_object

LEARNER_PATHS = ("summary", "heroes", "quests", "badges", "shop", "history", "settings",
                 f"rewards?source_session_id={uuid.uuid4()}")


async def test_auth_and_callers(env: Env, user: uuid.UUID) -> None:
    for path in LEARNER_PATHS:
        r = await env.c.get(f"/internal/v1/game/{path}")
        assert r.status_code == 401 and r.json()["code"] == "INTERNAL_TOKEN_MISSING", path
        r = await env.c.get(f"/internal/v1/game/{path}", headers=env.h(user, issuer="admin-bff"))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", path
    r = await env.c.get("/internal/v1/game/summary", headers={"x-internal-token": "garbage"})
    assert r.status_code == 401
    r = await env.c.get("/internal/v1/game/summary", headers=env.svc())  # без ученика
    assert r.status_code == 401 and r.json()["code"] == "USER_CONTEXT_REQUIRED"
    r = await env.c.get("/internal/v1/admin/game/rules", headers=env.h(user))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    r = await env.c.get("/internal/v1/admin/game/rules", headers=env.staff(actor=False))
    assert r.status_code == 403 and r.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    r = await env.c.get("/internal/v1/admin/game/rules", headers=env.staff("dashboard.read"))
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    r = await env.c.get(f"/internal/v1/game/assets/{uuid.uuid4()}", headers=env.svc(issuer="admin-bff"))
    assert r.status_code == 403
    r = await env.c.post("/internal/v1/game:tick")
    assert r.status_code == 401 and r.json()["code"] == "SCHEDULER_TOKEN_INVALID"
    r = await env.c.post("/internal/v1/game:tick", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401
    r = await env.c.post("/internal/v1/game:tick", headers=env.svc())
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    # клиент не задаёт ни сумм, ни причин: лишние поля — 422
    await env.send("PATCH", user, "settings", {"til_balance": 100}, 422)
    await env.send("PATCH", user, "settings", {"celebrations": "loud"}, 422)


async def test_learner_isolation(env: Env, user: uuid.UUID) -> None:
    other = uuid.uuid4()
    sid = await env.lesson(user, passed=True)
    await env.grant(user, "til", 100)
    await env.buy(user, "bg_sunrise")
    assert [i["reason"] for i in (await env.get(other, "history"))["items"]] == ["registration_bonus"]
    s = await env.get(other, "summary")
    assert (s["xp_total"], s["til_balance"]) == (0, 0)
    r = await env.get(other, "rewards", params={"source_session_id": str(sid)})
    assert r["status"] == "none" and r["operations"] == []
    assert not {i["code"]: i for i in (await env.get(other, "shop"))["items"]}["bg_sunrise"]["owned"]
    # ученик всегда из токена: путь и тело не принимают user_id
    await env.send("PUT", other, "equipment", {"background_code": "bg_sunrise", "frame_code": None}, 409)


async def test_session_rewards(env: Env, user: uuid.UUID) -> None:
    unknown = uuid.uuid4()
    r = await env.get(user, "rewards", params={"source_session_id": str(unknown)})
    assert r == {"status": "pending", "operations": [], "level_up": None, "hero_stage_up": None, "badges": [],
                 "quests_completed": []}
    await env.get(user, "rewards", params={"source_session_id": "not-a-uuid"}, expect=422)
    await env.send("PATCH", user, "settings", {"celebrations": "quiet"})
    sid = await env.lesson(user, passed=True)
    r = await env.get(user, "rewards", params={"source_session_id": str(sid)})
    assert r["status"] == "ready"
    assert [(o["reason"], o["currency"], o["amount"]) for o in r["operations"] if o["reason"] == "lesson"] == [
        ("lesson", "xp", 30), ("lesson", "til", 5)]
    assert [b["code"] for b in r["badges"]] == ["first_lesson"] and r["badges"][0]["earned_at"]
    ups = []
    for _ in range(3):  # 120 XP → уровень 2 (раньше, если выпало задание дня с XP)
        sid = await env.lesson(user, passed=True)
        ups.append((await env.get(user, "rewards", params={"source_session_id": str(sid)}))["level_up"])
    assert [u for u in ups if u] == [{"from": 1, "to": 2}]
    cancelled = await env.lesson(user, status="cancelled")
    assert (await env.get(user, "rewards", params={"source_session_id": str(cancelled)}))["status"] == "none"
    review = await env.review(user, reviewed=10, correct=5)
    r = await env.get(user, "rewards", params={"source_session_id": str(review)})
    assert r["status"] == "ready" and {o["reason"] for o in r["operations"]} >= {"review"}
    # дневной лимит исчерпан — занятие без наград → none
    await env.grant(user, "xp", 1)

    def tiny(p: dict) -> None:  # type: ignore[type-arg]
        p["caps"] = {"xp_per_day": 30, "til_per_day": 10}

    await env.activate(tiny)
    await env.send("PATCH", user, "settings", {"quests_hidden": True})
    capped = await env.lesson(user, passed=True)
    assert (await env.get(user, "rewards", params={"source_session_id": str(capped)}))["status"] == "none"
    # задание дня в наградах занятия
    fresh = uuid.uuid4()
    q = await env.get(fresh, "quests")
    if any(i["kind"] == "lesson_complete" for i in q["items"]):
        sid = await env.lesson(fresh)
        r = await env.get(fresh, "rewards", params={"source_session_id": str(sid)})
        assert [x["kind"] for x in r["quests_completed"]] == ["lesson_complete"]


async def test_kids_defaults(env: Env, user: uuid.UUID) -> None:
    parent = uuid.uuid4()
    s = await env.get(user, "settings", age_band="10-13", account=parent)
    assert s == {"auto_freeze": True, "quests_hidden": False, "celebrations": "quiet", "game_notifications": True,
                 "league_opt_in": False}
    # детский профиль (lrn ≠ sub) — дети, даже если в claims возраст аккаунта
    kid = uuid.uuid4()
    s = await env.get(kid, "summary", age_band="18+", account=parent)
    assert s["settings"]["celebrations"] == "quiet"
    assert {i["code"] for i in s["quests"]["items"]} <= {"lesson_1", "review_10", "reading_1", "skill_1"}
    # ребёнок может сам включить праздники — выбор сохраняется
    s = await env.send("PATCH", user, "settings", {"celebrations": "full"}, age_band="10-13", account=parent)
    assert s["celebrations"] == "full"
    assert (await env.get(user, "settings", age_band="10-13", account=parent))["celebrations"] == "full"
    # взрослый — full по умолчанию; профиль ребёнка из события регистрации — quiet
    adult = uuid.uuid4()
    assert (await env.get(adult, "settings"))["celebrations"] == "full"
    child = uuid.uuid4()
    await env.lesson(child)  # событие раньше регистрации — пока взрослый по умолчанию
    await env.profile(child, kind="child", age_band="6-9", guardian=parent)
    assert (await env.get(child, "settings", age_band="6-9", account=parent))["celebrations"] == "quiet"
    w = await env.adm("GET", f"wallets/{child}", perms=("game.read",))
    assert w["audience"] == "kids"


async def test_deletion_saga(env: Env, user: uuid.UUID) -> None:
    keep, invitee = uuid.uuid4(), uuid.uuid4()
    for u in (user, keep):
        await env.profile(u)
        await env.lesson(u, passed=True)
        await env.skills(u, [("en.x", "learning", "demonstrated")])
        await env.grant(u, "til", 200)
        await env.buy(u, "bg_sunrise")
        await env.missed(u)
        await env.send("PUT", u, "hero", {"hero_code": "pet_0"})
    await env.invite(user, invitee)
    tables = ("ledger", "wallets", "learners", "skill_states", "quests", "badges", "ownership", "purchases",
              "session_rewards")

    async def counts(u: uuid.UUID) -> dict[str, int]:
        return {t: (await env.sql(f"SELECT count(*) FROM {t} WHERE user_id = :u", u=u))[0][0]  # noqa: S608
                for t in tables}

    before = await counts(user)
    assert all(v > 0 for v in before.values()), before
    stats_before = await env.sql("SELECT sum(value) FROM daily_stats")
    request_id = str(uuid.uuid4())
    payload = {"user_id": str(user), "request_id": request_id, "requested_at": env.ts()}
    await env.publish("user.deletion.requested.v1", payload, "social")  # чужой издатель — игнор
    assert await counts(user) == before
    await env.publish("user.deletion.requested.v1", payload, "identity-consent")
    assert all(v == 0 for v in (await counts(user)).values())
    assert all(v > 0 for v in (await counts(keep)).values())
    assert await env.sql("SELECT count(*) FROM referrals") == [(0,)]
    assert await env.sql("SELECT sum(value) FROM daily_stats") == stats_before  # обезличенная статистика остаётся
    [ack] = await env.events("user.domain.deleted.v1", user)
    assert ack.payload == {"user_id": str(user), "request_id": request_id, "domain": "gamification",
                           "mode": "deleted"}
    # повтор — снова подтверждается; события и запросы после удаления данных не воскрешают
    await env.publish("user.deletion.requested.v1", payload, "identity-consent")
    assert len(await env.events("user.domain.deleted.v1", user)) == 2
    await env.lesson(user)
    await env.profile(user)
    assert all(v == 0 for v in (await counts(user)).values())
    r = await env.c.get("/internal/v1/game/summary", headers=env.h(user))
    assert r.status_code == 410 and r.json()["code"] == "USER_DELETED"
    # сотрудники в правилах и героях не трогаются
    assert (await env.sql("SELECT count(*) FROM heroes"))[0][0] == 9


async def test_tick_reconcile_and_single_run(env: Env, user: uuid.UUID) -> None:
    await env.lesson(user, passed=True)
    first = await env.tick()
    assert first["skipped"] is False and first["reconciled"] is True and first["wallets_fixed"] == 0
    # ручной сбой итогов кошелька → сверка раз в сутки исправляет по реестру
    await env.sql("UPDATE wallets SET til_balance = til_balance + 7, xp_total = 0 WHERE user_id = :u", u=user)
    assert (await env.tick())["reconciled"] is False  # ещё не прошли сутки
    env.now += timedelta(hours=25)
    out = await env.tick()
    assert out["reconciled"] is True and out["wallets_fixed"] == 1
    [(xp, til)] = await env.sql("SELECT sum(amount) FILTER (WHERE currency='xp'), sum(amount) FILTER "
                                "(WHERE currency='til') FROM ledger WHERE user_id = :u", u=user)
    w = await env.wallet(user)
    assert (w["xp"], w["til"]) == (xp, til)
    # один tick за раз
    url = make_url(TEST_ADMIN_URL).set(drivername="postgresql").render_as_string(hide_password=False)
    conn = await asyncpg.connect(url)
    try:
        assert await conn.fetchval("SELECT pg_try_advisory_lock($1, $2)", TICK_LOCK_CLASS,
                                   tick_lock_object(env.settings.db_schema))
        assert (await env.tick()) == {"skipped": True}
    finally:
        await conn.close()
    r = await env.c.post("/internal/v1/game:tick", headers={"Authorization": f"Bearer {SCHEDULER_TOKEN}"})
    assert r.json()["skipped"] is False


async def test_overview(env: Env, user: uuid.UUID) -> None:
    kid = uuid.uuid4()
    await env.profile(user)
    await env.profile(kid, kind="child", age_band="6-9", guardian=user)
    await env.lesson(user, passed=True)
    await env.lesson(kid)
    await env.grant(user, "til", 100)
    await env.buy(user, "streak_freeze")
    await env.missed(user)
    out = await env.adm("GET", "overview?period=30d", perms=("game.read",))
    assert out["period"] == "30d" and out["active_rules_version"] == 2
    assert out["earned"]["xp"] >= 50 and out["spent_til"] == 40 and out["purchases"] == 1
    assert out["freezes"] == {"granted": 4, "bought": 1, "used": 1}
    by = {a["audience"]: a for a in out["by_audience"]}
    assert by["kids"]["earned_xp"] >= 20 and by["teens"]["earned_xp"] == 0
    assert by["adults"]["earned_xp"] >= 30
