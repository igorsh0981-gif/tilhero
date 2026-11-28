"""Спринт 8 — уроки с ИИ по подписке (INTERNAL_API спринта 8 §5, AT-90, AT-91): удержание минут при старте урока и
сценария, режим по удержанию, ИИ-секунды и billable_minutes, деградация и отказ ИИ не списывают, минуты кончились —
урок до конца без минуса, billing недоступен — урок без ИИ; урок вдвоём — подписка пригласившего, удержание при старте
с коучем, одно списание за комнату, комната без коуча и с ребёнком бесплатны. BILLING_ENFORCED=false — как в спринте 7
(billing не вызывается: проверка в фикстуре env для всех тестов)."""

from __future__ import annotations

import asyncio
import math
import time
import uuid
from datetime import timedelta
from typing import Any

import pytest
from conftest import Env
from pydantic import ValidationError

from tilhero_lessons.settings import Settings

LESSON = "l-01-greetings"
SCN = "sc-meet-phone-number"


async def _row(env: Env, sid: str) -> dict[str, Any]:
    rows = await env.sql("SELECT ai_mode, ai_degraded, ai_lock_reason, billing_hold_id, ai_active_seconds, "
                         "active_seconds, minutes, billable_minutes, status FROM sessions WHERE session_id = :s",
                         s=uuid.UUID(sid))
    keys = ("ai_mode", "ai_degraded", "ai_lock_reason", "billing_hold_id", "ai_active_seconds", "active_seconds",
            "minutes", "billable_minutes", "status")
    return dict(zip(keys, rows[0], strict=True))


async def _completed(env: Env, user: uuid.UUID, sid: str) -> dict[str, Any]:
    [ev] = [e for e in await env.events("lesson.session.completed.v1", user) if e.payload["session_id"] == sid]
    return dict(ev.payload)


async def _play_scenario(env: Env, user: uuid.UUID, sid: str, *, texts: int = 0) -> dict[str, Any]:
    """Сценарий до конца: сначала `texts` свободных реплик (ИИ), затем выбор реплик; → итог finish."""
    step = await env.current(user, sid)
    while step["type"] == "roleplay":
        env.now += timedelta(seconds=env.step_seconds)
        if texts > 0 and step["free_text_allowed"]:
            texts -= 1
            res = await env.answer(user, sid, step, {"text": "Yes, sure, of course!"})
        else:
            res = await env.answer(user, sid, step, {"choice_id": env.choice_to(step, "success", SCN)})
        step = res["next"]
    env.now += timedelta(seconds=env.step_seconds)
    await env.answer(user, sid, step, {})
    return await env.finish(user, sid)


# ---------------------------------------------------------------- пэйвол выключен (спринт 7)


async def test_unenforced_lesson_is_sprint7(env: Env, user: uuid.UUID) -> None:
    s, _summary = await env.complete_lesson(user)
    assert s["ai_mode"] == "full" and s["ai_degraded"] is False
    assert s["ai_locked"] is None and s["ai_minutes_left"] is None
    ev = await _completed(env, user, s["session_id"])
    # новые поля события — необязательные: удержания нет, ИИ-минуты считаются (стоимость урока для ai-gateway)
    assert ev["billing_hold_id"] is None and 0 < ev["billable_minutes"] <= ev["minutes"]
    assert env.billing.calls == []


# ---------------------------------------------------------------- урок и сценарий с подпиской


async def test_subscriber_lesson_full_hold_and_single_debit(paid: Env, user: uuid.UUID) -> None:
    paid.billing.subscribe(user, minutes=300)
    s = await paid.lesson(user)
    assert s["ai_mode"] == "full" and s["ai_degraded"] is False and s["ai_locked"] is None
    [call] = paid.billing.hold_calls()
    assert call["body"] == {"user_id": str(user), "feature": "ai_lessons", "ref_kind": "session",
                            "ref_id": s["session_id"], "minutes_planned": 40}  # min(120, 2 × 20)
    assert call["sub"] == str(user) and call["idempotency_key"] == f"hold:session:{s['session_id']}"
    assert s["ai_minutes_left"] == 260  # 300 − 40 удержано
    # открытое задание оценщику — как у урока full спринта 4
    assert [u for st in (await paid.sql("SELECT plan FROM sessions"))[0][0]["stages"] for u in st["units"]
            if u["t"] == "open_answer"]
    steps = await paid.play(user, s["session_id"])
    assert any(x["type"] == "open_answer" for x in steps)
    await paid.finish(user, s["session_id"])
    row = await _row(paid, s["session_id"])
    assert row["ai_active_seconds"] == row["active_seconds"] > 0
    ev = await _completed(paid, user, s["session_id"])
    assert ev["billing_hold_id"] == str(row["billing_hold_id"])
    assert ev["billable_minutes"] == min(math.ceil(row["ai_active_seconds"] / 60), ev["minutes"])
    # списание по событию (как consumer billing) — один раз; повтор события — без второго списания
    debit = paid.billing.settle_session(ev)
    assert debit == ev["billable_minutes"] and paid.billing.settle_session(ev) == 0
    assert paid.billing.available(user) == 300 - debit
    # просмотр сессии: плашки нет, остаток минут — после удержания
    view = (await paid.c.get(f"/internal/v1/sessions/{s['session_id']}", headers=paid.h(user))).json()
    assert view["ai_locked"] is None and view["ai_minutes_left"] == 260


async def test_replay_same_key_no_second_hold_and_session_active_no_orphan(paid: Env, user: uuid.UUID) -> None:
    paid.billing.subscribe(user)
    s = await paid.lesson(user, key="lesson-key-0001")
    again = await paid.lesson(user, key="lesson-key-0001", expect=200)
    assert again["session_id"] == s["session_id"] and again["ai_mode"] == "full"
    # другая сессия при незавершённой — 409 SESSION_ACTIVE ДО удержания: удержаний без сессии нет
    r = await paid.c.post(f"/internal/v1/scenarios/{SCN}/sessions",
                          headers={**paid.h(user), "Idempotency-Key": "scenario-key-0001"})
    assert r.status_code == 409 and r.json()["code"] == "SESSION_ACTIVE"
    assert len(paid.billing.hold_calls()) == 1 and len(paid.billing.holds) == 1


async def test_concurrent_start_same_key_one_session_one_hold(paid: Env, user: uuid.UUID) -> None:
    paid.billing.subscribe(user)
    headers = {**paid.h(user), "Idempotency-Key": "same-key-0001"}
    r1, r2 = await asyncio.gather(*(paid.c.post(f"/internal/v1/lessons/{LESSON}/sessions", headers=headers)
                                    for _ in range(2)))
    assert sorted((r1.status_code, r2.status_code)) == [200, 201], (r1.text, r2.text)
    assert r1.json()["session_id"] == r2.json()["session_id"]
    assert r1.json()["ai_mode"] == r2.json()["ai_mode"] == "full"
    assert len(paid.billing.holds) == 1  # удержание идемпотентно по (session, session_id)


async def test_concurrent_start_different_keys_no_orphan_hold(paid: Env, user: uuid.UUID) -> None:
    paid.billing.subscribe(user)
    rs = await asyncio.gather(*(paid.c.post(f"/internal/v1/lessons/{LESSON}/sessions",
                                            headers={**paid.h(user), "Idempotency-Key": f"diff-key-000{i}"})
                                for i in range(3)))
    assert sorted(r.status_code for r in rs) == [201, 409, 409]
    assert len(paid.billing.holds) == 1 and paid.billing.available(user) == 260


async def test_no_subscription_lesson_in_choices_with_lock(paid: Env, user: uuid.UUID) -> None:
    s = await paid.lesson(user)
    assert s["ai_mode"] == "choices" and s["ai_degraded"] is False
    assert s["ai_locked"] == {"reason": "no_subscription"} and s["ai_minutes_left"] is None
    steps = await paid.play(user, s["session_id"])
    assert all(x["type"] != "open_answer" for x in steps)
    assert all(x.get("free_text_allowed") is not True for x in steps if x["type"] == "roleplay")
    await paid.finish(user, s["session_id"])
    assert paid.ai.requests == []  # без подписки ИИ не вызывается
    ev = await _completed(paid, user, s["session_id"])
    assert ev["billing_hold_id"] is None and ev["billable_minutes"] == 0
    [started] = [e for e in await paid.events("lesson.session.started.v1", user)]
    assert started.payload["ai_mode"] == "choices"


@pytest.mark.parametrize("setup,reason", [
    (lambda b, u: b.subscribe(u, features=("pair_lessons",)), "feature_not_in_plan"),
    (lambda b, u: b.subscribe(u, minutes=0), "minutes_exhausted"),
])
async def test_lock_reasons(paid: Env, user: uuid.UUID, setup: Any, reason: str) -> None:
    setup(paid.billing, user)
    s = await paid.start(user, f"scenarios/{SCN}")
    assert s["ai_mode"] == "choices" and s["ai_locked"] == {"reason": reason} and s["ai_degraded"] is False
    step = await paid.current(user, s["session_id"])
    assert step["free_text_allowed"] is False
    r = await paid.answer(user, s["session_id"], step, {"text": "Hello there"}, expect=409)
    assert r["code"] == "FREE_TEXT_NOT_ALLOWED"


async def test_billing_kids_reason_is_not_a_paywall(paid: Env, user: uuid.UUID) -> None:
    paid.billing.kids.add(user)  # billing знает ученика как ребёнка 6–13 — «варианты» без плашки тарифа
    s = await paid.lesson(user)
    assert s["ai_mode"] == "choices" and s["ai_locked"] is None and s["ai_degraded"] is False


@pytest.mark.parametrize("mode", ["down", "slow", "garbage"])
async def test_billing_unavailable_lesson_without_ai(paid: Env, user: uuid.UUID, mode: str) -> None:
    paid.billing.subscribe(user)
    paid.billing.mode = mode
    paid.billing.delay = 2.0  # больше срока billing (0,3 с в тестах)
    started = time.monotonic()
    s = await paid.lesson(user)
    assert time.monotonic() - started < 1.5  # старт не ждёт billing дольше своего срока
    assert s["ai_mode"] == "choices" and s["ai_locked"] == {"reason": "billing_unavailable"}
    assert s["ai_minutes_left"] is None
    await paid.play(user, s["session_id"])
    await paid.finish(user, s["session_id"])
    ev = await _completed(paid, user, s["session_id"])
    assert ev["billing_hold_id"] is None and ev["billable_minutes"] == 0
    # billing вернулся — следующий урок снова с ИИ
    paid.billing.mode, paid.billing.delay = "ok", 0.0
    await asyncio.sleep(0)
    s2 = await paid.lesson(user)
    assert s2["ai_mode"] == "full" and s2["ai_locked"] is None


async def test_subscriber_but_ai_unavailable_degraded_and_zero_debit(paid: Env, user: uuid.UUID) -> None:
    paid.billing.subscribe(user)
    paid.ai.paid_available = False  # уровень off (ИИ недоступен и подписчику)
    s = await paid.lesson(user)
    assert s["ai_mode"] == "choices" and s["ai_degraded"] is True and s["ai_locked"] is None
    assert s["ai_minutes_left"] == 260  # удержание есть — закроется событием с 0
    await paid.play(user, s["session_id"])
    await paid.finish(user, s["session_id"])
    ev = await _completed(paid, user, s["session_id"])
    assert ev["billing_hold_id"] is not None and ev["billable_minutes"] == 0
    assert paid.billing.settle_session(ev) == 0 and paid.billing.available(user) == 300


async def test_paid_only_level_keeps_subscriber_on_ai(paid: Env, user: uuid.UUID) -> None:
    paid.billing.subscribe(user)
    paid.ai.available, paid.ai.paid_available = False, True  # бесплатным ИИ закрыт, подписчику — нет
    s = await paid.lesson(user)
    assert s["ai_mode"] == "full" and s["ai_degraded"] is False


async def test_degradation_mid_scenario_bills_until_degradation(paid: Env, user: uuid.UUID) -> None:
    paid.billing.subscribe(user)
    paid.step_seconds = 50
    s = await paid.start(user, f"scenarios/{SCN}")
    assert s["ai_mode"] == "full"
    sid = s["session_id"]
    step = await paid.current(user, sid)
    paid.now += timedelta(seconds=50)
    res = await paid.answer(user, sid, step, {"text": "Yes, sure, of course!"})  # ИИ ответил: 50 с с ИИ
    paid.ai.mode["conversation_partner"] = "unavailable"
    paid.now += timedelta(seconds=50)
    res = await paid.answer(user, sid, res["next"], {"text": "Hello again"})  # ИИ отказал: деградация
    assert res["reply"]["clarification"] is True
    view = (await paid.c.get(f"/internal/v1/sessions/{sid}", headers=paid.h(user))).json()
    assert view["ai_degraded"] is True and view["ai_locked"] is None
    step = res["next"]
    while step["type"] == "roleplay":
        paid.now += timedelta(seconds=50)
        step = (await paid.answer(user, sid, step, {"choice_id": paid.choice_to(step, "success", SCN)}))["next"]
    paid.now += timedelta(seconds=50)
    await paid.answer(user, sid, step, {})
    await paid.finish(user, sid)
    row = await _row(paid, sid)
    # до деградации — 100 с с ИИ (два ответа по 50 с, второй и вызвал деградацию); дальше — без ИИ
    assert row["ai_active_seconds"] == 100 and row["active_seconds"] > 100
    ev = await _completed(paid, user, sid)
    assert ev["billable_minutes"] == 2 and ev["minutes"] > 2


async def test_ai_refusal_stops_billing(paid: Env, user: uuid.UUID) -> None:
    paid.billing.subscribe(user)
    s = await paid.start(user, f"scenarios/{SCN}")
    sid = s["session_id"]
    step = await paid.current(user, sid)
    paid.ai.mode["conversation_partner"] = "refused"
    paid.now += timedelta(seconds=40)
    res = await paid.answer(user, sid, step, {"text": "Something odd"})
    before = (await _row(paid, sid))["ai_active_seconds"]
    assert before == 40
    step = res["next"]
    while step["type"] == "roleplay":
        paid.now += timedelta(seconds=40)
        step = (await paid.answer(user, sid, step, {"choice_id": paid.choice_to(step, "success", SCN)}))["next"]
    paid.now += timedelta(seconds=40)
    await paid.answer(user, sid, step, {})
    await paid.finish(user, sid)
    row = await _row(paid, sid)
    assert row["ai_active_seconds"] == before and row["active_seconds"] > before  # отказ ИИ не списывает


async def test_minutes_exhausted_mid_lesson_continues_without_negative(paid: Env, user: uuid.UUID) -> None:
    paid.billing.subscribe(user, minutes=3)
    paid.step_seconds = 120
    s = await paid.lesson(user)
    assert s["ai_mode"] == "full" and s["ai_minutes_left"] == 0  # удержано всё доступное (3)
    await paid.play(user, s["session_id"])
    summary = await paid.finish(user, s["session_id"])
    assert summary["status"] == "completed"  # урок не обрывается
    ev = await _completed(paid, user, s["session_id"])
    assert ev["billable_minutes"] > 3
    debit = paid.billing.settle_session(ev)
    assert debit == 3 and paid.billing.overage == ev["billable_minutes"] - 3
    assert paid.billing.available(user) == 0  # баланс не отрицательный, перерасход — за счёт сервиса
    nxt = await paid.lesson(user)
    assert nxt["ai_locked"] == {"reason": "minutes_exhausted"} and nxt["ai_mode"] == "choices"


async def test_cancelled_session_reports_billable_and_hold(paid: Env, user: uuid.UUID) -> None:
    paid.billing.subscribe(user)
    s = await paid.lesson(user)
    sid = s["session_id"]
    step = await paid.current(user, sid)
    paid.now += timedelta(seconds=70)
    await paid.answer(user, sid, step, paid.body_for(step))
    await paid.post(user, sid, "cancel")
    ev = await _completed(paid, user, sid)
    assert ev["status"] == "cancelled" and ev["billing_hold_id"] is not None and ev["billable_minutes"] == 2
    assert paid.billing.settle_session(ev) == 2


async def test_billing_not_called_for_kids_media_review_reading(paid: Env, user: uuid.UUID) -> None:
    kid, parent = uuid.uuid4(), uuid.uuid4()
    paid.child(kid)
    k = await paid.lesson(kid, account=parent)  # детский профиль 6–13: ИИ в уроках не включается (спринт 4)
    assert k["ai_mode"] == "choices" and k["ai_locked"] is None and k["ai_minutes_left"] is None
    await paid.post(kid, k["session_id"], "cancel", account=parent)
    m = await paid.start(user, "media/m-own-coffee-order")
    assert m["ai_locked"] is None and m["ai_minutes_left"] is None
    await paid.post(user, m["session_id"], "cancel")
    r = await paid.start(user, "readings/r-a1-coffee-shop")
    assert r["ai_locked"] is None and r["ai_mode"] == "choices"
    assert paid.billing.calls == []


# ---------------------------------------------------------------- урок вдвоём


async def _finish_room(env: Env, a: uuid.UUID, b: uuid.UUID, rid: str) -> dict[str, Any]:
    env.now += timedelta(seconds=30)
    await env.turn(a, rid, {"text": "Two coffees, please."})
    env.now += timedelta(seconds=30)
    await env.beat(rid, a)
    await env.turn(b, rid, {"text": "I will pay for you."})
    env.now += timedelta(seconds=30)
    await env.beat(rid, b)
    await env.turn(a, rid, {"text": "Thank you very much!"})
    env.now += timedelta(seconds=30)
    await env.beat(rid, a)
    st = await env.turn(b, rid, {"text": "You are welcome."})
    assert st["status"] == "finished"
    await env.drain()
    [done] = [e for e in await env.events("lesson.pair.completed.v1") if e.payload["room_id"] == rid]
    return dict(done.payload)


async def test_unenforced_pair_room_is_sprint7(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    rid = await env.started_room(a, b)
    done = await _finish_room(env, a, b, rid)
    assert done["billing"] is None and env.billing.calls == []
    assert {c["user_id"] for c in env.ai.coach_calls()} == {str(a), str(b)}  # как в спринте 7: от говорящего


async def test_pair_invite_requires_subscription(paid: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    paid.friends(a, b)
    r = await paid.invite(a, b, expect=403)
    assert r["code"] == "SUBSCRIPTION_REQUIRED" and r["details"] == {"feature": "pair_lessons",
                                                                     "reason": "no_subscription"}
    paid.billing.subscribe(a, features=("ai_lessons",))
    r = await paid.invite(a, b, expect=403)
    assert r["details"]["reason"] == "feature_not_in_plan"
    paid.billing.subscribe(a, minutes=5)  # меньше pair_min_minutes (10)
    assert (await paid.invite(a, b, expect=403))["details"]["reason"] == "minutes_exhausted"
    paid.billing.mode = "down"
    assert (await paid.invite(a, b, expect=503))["code"] == "BILLING_UNAVAILABLE"
    [call, *_] = paid.billing.access_calls()
    assert call["params"] == {"feature": "pair_lessons"} and call["sub"] == str(a)
    assert paid.billing.hold_calls() == []
    # приглашённый без подписки входит (В8): приглашает подписчик b
    paid.billing.mode = "ok"
    paid.billing.subscribe(b, minutes=100)
    room = await paid.invite(b, a)
    await paid.room(a, room["room_id"], "accept")
    assert room["status"] == "invited"


async def test_pair_hold_at_coach_start_single_debit(paid: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    paid.billing.subscribe(a, minutes=100)
    paid.friends(a, b)
    room = await paid.invite(a, b)
    rid = room["room_id"]
    await paid.room(b, rid, "accept")
    await paid.room(a, rid, "join")
    assert paid.billing.hold_calls() == []  # ожидание партнёра — без удержания
    st = await paid.room(b, rid, "join")
    assert st["status"] == "in_progress" and st["ai_degraded"] is False and st["mode"] == "free"
    [call] = paid.billing.hold_calls()
    assert call["body"] == {"user_id": str(a), "feature": "pair_lessons", "ref_kind": "room", "ref_id": rid,
                            "minutes_planned": 20} and call["sub"] == str(a)
    # переподключение приглашённого: выход и возврат ≤ 3 мин — та же комната, удержание не повторяется
    paid.now += timedelta(seconds=20)
    await paid.beat(rid, a, b)
    await paid.room(b, rid, "leave")
    paid.now += timedelta(seconds=20)
    await paid.beat(rid, a)
    await paid.room(b, rid, "join")
    assert len(paid.billing.hold_calls()) == 1
    done = await _finish_room(paid, a, b, rid)
    rows = await paid.sql("SELECT coach_active_seconds, billable_minutes, billing_payer_user_id, billing_hold_id "
                          "FROM pair_rooms WHERE room_id = :r", r=uuid.UUID(rid))
    coach_seconds, billable, payer, hold = rows[0]
    assert payer == a and hold is not None and coach_seconds > 0
    assert billable == math.ceil(coach_seconds / 60)
    assert done["billing"] == {"payer_user_id": str(a), "hold_id": str(hold), "billable_minutes": billable}
    assert paid.billing.settle_room(done) == billable and paid.billing.settle_room(done) == 0  # один раз
    assert paid.billing.available(a) == 100 - billable
    assert paid.billing.available(b) == 0 and paid.billing.account(b) is None  # у приглашённого ничего
    # коуч оплаченной комнаты — от имени плательщика (тариф paid у ai-gateway), в том числе на ходы приглашённого
    assert {c["user_id"] for c in paid.ai.coach_calls()} == {str(a)} and len(paid.ai.coach_calls()) >= 3


async def test_pair_hold_denied_at_start_room_without_coach(paid: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    paid.billing.subscribe(a, minutes=100)
    paid.friends(a, b)
    room = await paid.invite(a, b)
    rid = room["room_id"]
    await paid.room(b, rid, "accept")
    await paid.room(a, rid, "join")
    paid.billing.accounts[a]["spent"] = 95  # минуты кончились между приглашением и стартом
    st = await paid.room(b, rid, "join")
    assert st["status"] == "in_progress" and st["mode"] == "choices" and st["ai_degraded"] is True
    assert "mode_changed" in [e["kind"] for e in st["events"]]
    assert paid.ai.coach_calls() == []  # коуч не звали
    rows = await paid.sql("SELECT engine, coach_used, billing_hold_id, coach_active_seconds FROM pair_rooms "
                          "WHERE room_id = :r", r=uuid.UUID(rid))
    assert rows[0][0] == "script" and rows[0][1] is False and rows[0][2] is None
    # сценарий с выбором реплик до конца — без списания
    for _ in range(20):
        state = await paid.state(a, rid)
        if state["status"] != "in_progress":
            break
        me = a if state["next_speaker"] == "A" else b
        mine = await paid.state(me, rid)
        paid.now += timedelta(seconds=10)
        await paid.beat(rid, a, b)
        await paid.turn(me, rid, {"choice_id": mine["options"][0]["choice_id"]})
    await paid.drain()
    [done] = [e for e in await paid.events("lesson.pair.completed.v1") if e.payload["room_id"] == rid]
    assert done.payload["billing"] is None


async def test_pair_billing_unavailable_at_start_room_without_coach(paid: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    paid.billing.subscribe(a, minutes=100)
    paid.friends(a, b)
    room = await paid.invite(a, b)
    rid = room["room_id"]
    await paid.room(b, rid, "accept")
    await paid.room(a, rid, "join")
    paid.billing.mode = "down"
    st = await paid.room(b, rid, "join")
    assert st["mode"] == "choices" and st["ai_degraded"] is True and paid.ai.coach_calls() == []


async def test_pair_room_with_kid_is_free(paid: Env) -> None:
    parent, kid = uuid.uuid4(), uuid.uuid4()
    paid.family(parent, kid)
    paid.kid(kid)
    rid = await paid.started_room(parent, kid, scenario="sc-cafe-coffee")
    rows = await paid.sql("SELECT engine, billing_payer_user_id FROM pair_rooms WHERE room_id = :r",
                          r=uuid.UUID(rid))
    assert rows[0] == ("script", None)
    assert paid.billing.calls == []  # без проверки и без удержания (В9)


async def test_pair_room_over_coach_limit_no_hold(paid: Env) -> None:
    paid.settings.pair_ai_rooms_per_day = 0  # суточный лимит комнат с коучем — комната сразу без коуча
    a, b = uuid.uuid4(), uuid.uuid4()
    paid.billing.subscribe(a)
    rid = await paid.started_room(a, b)
    rows = await paid.sql("SELECT engine, billing_hold_id FROM pair_rooms WHERE room_id = :r", r=uuid.UUID(rid))
    assert rows[0] == ("script", None) and paid.billing.hold_calls() == []


async def test_pair_coach_degradation_stops_coach_seconds(paid: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    paid.billing.subscribe(a)
    rid = await paid.started_room(a, b)
    paid.now += timedelta(seconds=30)
    await paid.turn(a, rid, {"text": "Two coffees, please."})
    before = (await paid.sql("SELECT coach_active_seconds FROM pair_rooms WHERE room_id = :r",
                             r=uuid.UUID(rid)))[0][0]
    assert before == 30
    paid.ai.mode["cooperative_lesson_coach"] = "unavailable"
    paid.now += timedelta(seconds=30)
    await paid.beat(rid, a)
    st = await paid.turn(b, rid, {"text": "I will pay for you."})
    assert st["ai_degraded"] is True and st["mode"] == "choices"
    paid.now += timedelta(seconds=40)
    await paid.beat(rid, a, b)
    rows = await paid.sql("SELECT coach_active_seconds, progress_seconds FROM pair_rooms WHERE room_id = :r",
                          r=uuid.UUID(rid))
    assert rows[0][0] == 60 and rows[0][1] == 100  # после деградации время коуча не идёт


async def test_pair_payer_deleted_clears_billing(paid: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    paid.billing.subscribe(a)
    rid = await paid.started_room(a, b)
    await paid.publish("user.deletion.requested.v1", {"user_id": str(a), "request_id": str(uuid.uuid4()),
                                                      "requested_at": paid.now.isoformat()}, "identity-consent")
    rows = await paid.sql("SELECT billing_payer_user_id, billing_hold_id FROM pair_rooms WHERE room_id = :r",
                          r=uuid.UUID(rid))
    assert rows[0] == (None, None)


async def test_room_turn_concurrent_start_single_hold(paid: Env) -> None:
    """Гонка: вход второго участника и обслуживание по сроку — удержание запрашивается по (room, room_id):
    billing отвечает тем же удержанием, в комнате одно."""
    a, b = uuid.uuid4(), uuid.uuid4()
    paid.billing.subscribe(a)
    paid.friends(a, b)
    room = await paid.invite(a, b)
    rid = room["room_id"]
    await paid.room(b, rid, "accept")
    await paid.room(a, rid, "join")
    await asyncio.gather(paid.room(b, rid, "join"), paid.state(a, rid))
    await paid.drain()
    assert len(paid.billing.holds) == 1


# ---------------------------------------------------------------- настройки


def test_billing_settings_guards() -> None:
    prod: dict[str, Any] = {
        "env": "prod", "internal_jwt_secret": "x" * 40, "internal_jwt_private_key": "a" * 43,
        "scheduler_token": "t" * 43, "member_id_key": "m" * 32, "user_ref_secret": "r" * 32,
        **{k: "http://x:1" for k in ("catalog_url", "ai_gateway_url", "assessment_url", "learning_plan_url",
                                     "diagnostics_url", "social_url", "identity_consent_url")}}
    ok = Settings(**prod)
    # по умолчанию пэйвол выключен (prod — до решения владельца), срок billing 2 с (INTERNAL_API §0.3)
    assert ok.billing_enforced is False and ok.billing_timeout_seconds == 2
    with pytest.raises(ValidationError, match="BILLING_URL"):
        Settings(**prod, billing_enforced=True)  # пэйвол включён — адрес billing обязателен
    assert Settings(**prod, billing_enforced=True, billing_url="http://billing:8118").billing_enforced is True
    with pytest.raises(ValidationError, match="BILLING_URL"):
        Settings(env="test", billing_url="ftp://billing")
