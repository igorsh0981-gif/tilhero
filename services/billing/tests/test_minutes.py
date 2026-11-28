"""Минуты (§1.10–1.11, AT-90/91/92): пробный один раз, удержание при старте и списание ⌈ИИ-секунды/60⌉ по событию один
раз, перерасход без минуса, пул аккаунта (родитель и ребёнок), урок вдвоём, доступ, окончание периода и сгорание
остатка, истечение удержаний, опоздавшее событие, «мало минут», история минут."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

from conftest import Env


async def test_trial_once_and_idempotent(env: Env) -> None:
    a = await env.account()
    key = f"k-{uuid.uuid4()}"
    view = await env.post(a, "trial", None, 201, key=key)
    assert view["status"] == "trial" and view["period"]["minutes_left"] == 60 and view["features"] == [
        "ai_lessons", "pair_lessons"]
    assert view["trial_available"] is False
    assert await env.post(a, "trial", None, 201, key=key) == view  # повтор ключа — тот же ответ
    assert (await env.trial(a, 409))["code"] == "TRIAL_USED"
    assert await env.events("billing.subscription.changed.v1", account_id=a, status="trial", reason="trial")
    child = uuid.uuid4()
    await env.profile(child, kind="child", age_band="10-13", guardian=a)
    assert (await env.trial(a, 403, lrn=child, age_band="10-13"))["code"] == "PAYER_REQUIRED"
    assert (await env.trial(a, 409, chn="web"))["code"] == "TRIAL_NOT_AVAILABLE"
    kid_view = await env.get(a, "subscription", lrn=child, age_band="10-13")
    assert kid_view["status"] == "trial" and kid_view["stars_subscription"] is None and kid_view["payer_required"]
    # новому детскому профилю — тариф аккаунта; дальше — каждому ученику аккаунта при каждой смене (D)
    [acc] = await env.events("billing.access.changed.v1", user_id=child)
    assert acc.payload["tier"] == "paid" and acc.payload["account_id"] == str(a) and acc.payload["changed_at"]
    env.shift(days=8)
    await env.tick()
    for user in (a, child):
        last = (await env.events("billing.access.changed.v1", user_id=user))[-1]
        assert last.payload["tier"] == "free" and last.payload["paid_until"] is None and last.payload["changed_at"]


async def test_hold_settle_once_overage_and_low(env: Env) -> None:
    a = await env.account()
    none = await env.hold(a)
    assert none == {"allowed": False, "reason": "no_subscription"}
    await env.trial(a)
    sid = uuid.uuid4()
    h = await env.hold(a, ref_id=sid, minutes=40)
    assert h["allowed"] and h["minutes_held"] == 40 and h["minutes_left"] == 20 and h["period_ends_at"]
    assert await env.hold(a, ref_id=sid, minutes=40) == h  # повтор (ref_kind, ref_id) — тот же ответ
    e = await env.lesson_done(a, h["hold_id"], 48)
    b = await env.balance(a)
    assert (b["spent"], b["held"], b["left"], b["overage"]) == (48, 0, 12, 0)  # сверх удержания — из доступного
    assert await env.events("billing.minutes.low.v1", account_id=a) == []  # 12 из 60 > 10 %
    await env.lesson_done(a, h["hold_id"], 48, env=e)  # повтор того же события
    await env.lesson_done(a, h["hold_id"], 48)  # то же занятие другим событием
    assert (await env.balance(a))["spent"] == 48
    h2 = await env.hold(a, minutes=7)
    await env.lesson_done(a, h2["hold_id"], 7)
    [low] = await env.events("billing.minutes.low.v1", account_id=a)
    assert low.payload == {"account_id": str(a), "period_id": low.payload["period_id"], "minutes_left": 5,
                           "minutes_granted": 60}
    h3 = await env.hold(a, minutes=60)
    assert h3["minutes_held"] == 5 and h3["minutes_left"] == 0
    await env.lesson_done(a, h3["hold_id"], 17, status="cancelled")  # любой итог; минуты кончились — перерасход
    b = await env.balance(a)
    assert (b["spent"], b["left"], b["overage"]) == (60, 0, 12)
    assert len(await env.events("billing.minutes.low.v1", account_id=a)) == 1  # один раз за период
    assert (await env.hold(a))["reason"] == "minutes_exhausted"
    await env.lesson_done(a, None, None)  # без удержания — ничего
    view = await env.get(a, "subscription")
    assert view["minutes_exhausted"] and view["period"]["overage"] == 12 and view["period"]["minutes_left"] == 0
    hist = (await env.get(a, "minutes"))["items"]
    assert [i["kind"] for i in hist] == ["debit", "debit", "debit", "grant"] and hist[0]["learner"] == "self"
    # деградация посреди урока — billable 0 → удержание закрывается без списания
    await env.lesson_done(a, h["hold_id"], 0)


async def test_family_pool_parallel_holds_and_kids(env: Env) -> None:
    a = await env.account()
    child = uuid.uuid4()
    await env.profile(child, kind="child", age_band="10-13", guardian=a)
    await env.trial(a)
    kid = await env.hold(child)
    assert kid == {"allowed": False, "reason": "kids"}
    teen_child = uuid.uuid4()  # детский профиль — пул аккаунта, но ИИ в уроках детям не включается
    await env.profile(teen_child, kind="child", age_band="6-9", guardian=a)
    r1, r2 = await asyncio.gather(env.hold(a, minutes=40), env.hold(a, minutes=40))
    assert r1["minutes_held"] + r2["minutes_held"] == 60
    b = await env.balance(a)
    assert b["held"] == 60 and b["left"] == 0
    # чужой вызывающий и чужой user_id
    r = await env.c.post("/internal/v1/holds", json={"user_id": str(a), "feature": "ai_lessons",
                                                     "ref_kind": "session", "ref_id": str(uuid.uuid4()),
                                                     "minutes_planned": 10}, headers=env.svc("telegram-bff", a))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    r = await env.c.post("/internal/v1/holds", json={"user_id": str(a), "feature": "ai_lessons",
                                                     "ref_kind": "session", "ref_id": str(uuid.uuid4()),
                                                     "minutes_planned": 10}, headers=env.svc("lessons", child))
    assert r.status_code == 403 and r.json()["code"] == "USER_CONTEXT_MISMATCH"
    r = await env.c.post("/internal/v1/holds", json={"user_id": str(a), "feature": "ai_lessons",
                                                     "ref_kind": "session", "ref_id": str(uuid.uuid4()),
                                                     "minutes_planned": 121}, headers=env.svc("lessons", a))
    assert r.status_code == 422


async def test_pair_lessons_access_and_settlement(env: Env) -> None:
    a = await env.account()
    r = await env.c.get(f"/internal/v1/access/{a}", params={"feature": "pair_lessons"},
                        headers=env.svc("lessons", a))
    assert r.json() == {"allowed": False, "reason": "no_subscription", "minutes_left": 0}
    await env.trial(a)
    r = await env.c.get(f"/internal/v1/access/{a}", params={"feature": "pair_lessons"},
                        headers=env.svc("lessons", a))
    assert r.json() == {"allowed": True, "reason": None, "minutes_left": 60}
    room = uuid.uuid4()
    h = await env.hold(a, feature="pair_lessons", ref_kind="room", ref_id=room, minutes=60)
    again = await env.hold(a, feature="pair_lessons", ref_kind="room", ref_id=room, minutes=60)
    assert again["hold_id"] == h["hold_id"]  # переподключение — без второго удержания
    base = {"room_id": str(room), "scenario_id": "s1", "pair_id": "ru-en", "status": "finished",
            "end_reason": "completed", "team_goal_reached": True,
            "participants": [{"user_id": str(a), "role": "A", "contributed": True, "turns": 5,
                              "speaking_seconds": 60, "minutes": 9}], "ended_at": env.ts()}
    await env.publish("lesson.pair.completed.v1", {**base, "billing": None}, "lessons")
    assert (await env.balance(a))["held"] == 60
    await env.publish("lesson.pair.completed.v1", {**base, "billing": {
        "payer_user_id": str(a), "hold_id": h["hold_id"], "billable_minutes": 9}}, "lessons")
    await env.publish("lesson.pair.completed.v1", {**base, "billing": {
        "payer_user_id": str(a), "hold_id": h["hold_id"], "billable_minutes": 9}}, "lessons")
    b = await env.balance(a)
    assert (b["spent"], b["held"], b["left"]) == (9, 0, 51)
    r = await env.c.get(f"/internal/v1/access/{a}", params={"feature": "pair_lessons"},
                        headers=env.svc("lessons", uuid.uuid4()))
    assert r.status_code == 403


async def test_period_end_expires_rest_and_late_settlement(env: Env) -> None:
    a = await env.account()
    await env.trial(a)
    env.shift(days=6, hours=23)
    h = await env.hold(a, minutes=30)
    env.shift(hours=1, minutes=1)
    out = await env.tick()
    assert out["accounts_refreshed"] == 1
    rows = await env.sql("SELECT kind, minutes, ref_kind FROM minute_ledger ORDER BY seq")
    assert [tuple(r) for r in rows] == [("grant", 60, "trial"), ("expire", -30, "period")]
    assert (await env.get(a, "subscription"))["status"] == "expired"
    [ended] = await env.events("billing.subscription.changed.v1", account_id=a, reason="ended")
    assert ended.payload["status"] == "expired" and ended.payload["period_id"] is None
    # занятие закончилось после конца периода: списание из удержания, остаток удержания сгорает
    await env.lesson_done(a, h["hold_id"], 12)
    rows = await env.sql("SELECT kind, minutes, ref_kind FROM minute_ledger ORDER BY seq")
    assert [tuple(r) for r in rows][2:] == [("debit", -12, "session"), ("expire", -18, "hold")]
    bal = await env.one("SELECT granted - spent - removed - held FROM period_balances")
    assert bal[0] == 0


async def test_hold_expiry_and_late_event(env: Env) -> None:
    a = await env.account()
    await env.trial(a)
    h = await env.hold(a, minutes=20)
    env.shift(hours=81)
    out = await env.tick()
    assert out["holds_expired"] == 1
    assert (await env.balance(a))["held"] == 0
    await env.lesson_done(a, h["hold_id"], 5)
    await env.lesson_done(a, h["hold_id"], 5)
    b = await env.balance(a)
    assert (b["spent"], b["left"]) == (5, 55)
    kinds = {r[0] for r in await env.sql("SELECT dedup_key FROM reconciliation_items")}
    assert kinds == {f"hold_expired:late:{h['hold_id']}", f"hold_expired:{h['hold_id']}"}


async def test_expiring_notice_and_scheduled_next(env: Env) -> None:
    a = await env.account()
    await env.trial(a)
    await env.tick()
    env.shift(days=4, minutes=1)
    await env.tick()
    [ev] = await env.events("billing.subscription.expiring.v1", account_id=a)
    assert ev.payload["days_left"] == 3 and ev.payload["minutes_left"] == 60
    await env.tick()
    assert len(await env.events("billing.subscription.expiring.v1", account_id=a)) == 1
    view = await env.get(a, "subscription")
    assert view["expiring"] is True and view["next_period"] is None
    _ = timedelta
