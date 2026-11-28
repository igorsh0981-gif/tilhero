"""Контроль ИИ спринта 8 (INTERNAL_API §7, ai.ts «Контроль ИИ», AT-98): тариф ученика из billing.access.changed.v1,
дневной лимит по тарифу, уровни деградации economy → paid_only → off (авто по доле месяца и вручную со step-up),
событие ai.degradation.changed.v1 и аудит, AiStatus, стоимость занятий (session_costs), сага."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
import ts_contract as ts
from conftest import make_env
from gw_kit import (
    ANALYST,
    CP_OK,
    DASHBOARD,
    OPERATIONS,
    SUPPORT,
    T0,
    ScriptedProvider,
    coach_context,
    coach_out,
    gloss_context,
    gloss_out,
)

from tilhero_common.messaging import make_envelope
from tilhero_common.testing import assert_event_conforms

DEGRADATION = "/admin/v1/ai/degradation"
UNIT_COSTS = "/admin/v1/ai/unit-costs"
STATUS = "/internal/v1/status"
STEP_UP = {"X-Step-Up": "ok"}


@pytest.fixture
async def gw():
    provider = ScriptedProvider(default=(CP_OK, 1000, 100))
    async for e in make_env(provider=provider):
        e.provider = provider
        yield e


async def _spend(gw, usd: str, *, user_id=None, session_id=None, at: datetime | None = None,
                 status: str = "ok", reason: str | None = None, kind: str = "lesson",
                 agent_id: str = "conversation_partner") -> None:
    await gw.sql("INSERT INTO usage (call_id, request_id, caller, agent_id, provider, status, reason, cost_usd, "
                 "user_id, session_id, session_kind, created_at, finished_at) VALUES ($1, $2, 'lessons', $9, "
                 "'anthropic', $7, $8, $3::numeric, $4, $5, $10, $6, $6)",
                 uuid.uuid4(), uuid.uuid4(), usd, user_id, session_id, at or gw.now, status, reason, agent_id, kind)


def _access(user_id: uuid.UUID, tier: str = "paid", *, paid_until: datetime | None = None,
            changed_at: datetime = T0, producer: str = "billing"):
    return make_envelope("billing.access.changed.v1", {
        "user_id": str(user_id), "account_id": str(user_id), "tier": tier,
        "features": ["ai_lessons", "pair_lessons"] if tier == "paid" else [],
        "paid_until": paid_until.isoformat().replace("+00:00", "Z") if paid_until else None,
        "changed_at": changed_at.isoformat().replace("+00:00", "Z")}, producer=producer)


async def _paid(gw, user_id: uuid.UUID | None = None, **kw: Any) -> uuid.UUID:
    user_id = user_id or uuid.uuid4()
    await gw.bus.publish(_access(user_id, **kw))
    assert not gw.bus.dlq
    return user_id


async def _degradation(gw, body: dict[str, Any], *, actor=OPERATIONS, step_up: bool = True):
    payload = {"mode": "auto", "manual_level": None, "economy_at_percent": 80, "paid_only_at_percent": 90,
               "reason": "Правка уровня в тесте", **body}
    return await gw.c.put(DEGRADATION, json=payload, headers=gw.h(actor, **(STEP_UP if step_up else {})))


async def _status(gw, caller: str = "lessons") -> dict[str, Any]:
    r = await gw.c.get(STATUS, headers=gw.svc(caller))
    assert r.status_code == 200, r.text
    return dict(r.json())


async def _level_events(gw) -> list[dict[str, Any]]:
    """Смены уровня в порядке журнала (degradation_events.seq); события шины (порядок публикации outbox не
    гарантирован) — те же смены, каждое строго по схеме."""
    await gw.flush()
    events = gw.events("ai.degradation.changed.v1")
    for e in events:
        assert e.producer == "ai-gateway"
        assert_event_conforms(e)
    rows = await gw.sql("SELECT from_level, to_level, mode, reason, spent_percent FROM degradation_events "
                        "ORDER BY seq")
    journal = [{"from": r["from_level"], "to": r["to_level"], "mode": r["mode"], "reason": r["reason"],
                "spent_percent": float(r["spent_percent"])} for r in rows]

    def key(p: dict[str, Any]) -> tuple[Any, ...]:
        return p["from"], p["to"], p["mode"], p["reason"], p["spent_percent"]

    assert sorted(map(key, (e.payload for e in events))) == sorted(map(key, journal))
    return journal


# ---------------------------------------------------------------- миграция и формы


async def test_defaults_and_shapes(gw) -> None:
    budget = (await gw.c.get("/admin/v1/ai/budget", headers=gw.h(OPERATIONS))).json()
    assert budget["paid_learner_daily_cap_usd"] == 0.3 and budget["learner_daily_cap_usd"] == 0.05
    r = await gw.c.get(DEGRADATION, headers=gw.h(ANALYST))
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == set(ts.fields("ai.ts", "AiDegradation"))
    assert {k: body[k] for k in ("mode", "manual_level", "level", "economy_at_percent", "paid_only_at_percent",
                                 "spent_percent", "month", "events")} == {
        "mode": "auto", "manual_level": None, "level": "normal", "economy_at_percent": 80,
        "paid_only_at_percent": 90, "spent_percent": 0.0, "month": "2026-11", "events": []}
    status = await _status(gw)
    assert set(status) == set(ts.fields("ai.ts", "AiStatus"))
    assert status == {"ai_available": True, "speech_available": True, "level": "normal", "free_available": True,
                      "paid_available": True}
    costs = (await gw.c.get(UNIT_COSTS, params={"period": "week"}, headers=gw.h(ANALYST))).json()
    assert set(costs) == set(ts.fields("ai.ts", "AiUnitCosts"))
    assert set(costs["by_kind"]) == {"lesson", "scenario", "pair"}
    assert set(costs["by_kind"]["lesson"]) == set(ts.fields("ai.ts", "AiUnitCostsKind"))
    assert costs["degraded_sessions_pct"] is None and costs["period"] == "week"


async def test_admin_access(gw) -> None:
    for actor in (SUPPORT, DASHBOARD):
        r = await gw.c.get(DEGRADATION, headers=gw.h(actor))
        assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    r = await _degradation(gw, {"mode": "manual", "manual_level": "economy"}, actor=ANALYST)
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    r = await _degradation(gw, {"mode": "manual", "manual_level": "economy"}, step_up=False)
    assert r.status_code == 403 and r.json()["code"] == "STEP_UP_REQUIRED"
    assert r.json()["details"] == {"permission": "costs.manage"}
    assert (await gw.c.get(DEGRADATION)).status_code == 401
    assert (await gw.c.get(DEGRADATION, headers=gw.svc("lessons"))).status_code == 403
    # стоимость занятий — costs.read или dashboard.read (обзор)
    assert (await gw.c.get(UNIT_COSTS, headers=gw.h(DASHBOARD))).status_code == 200
    r = await gw.c.get(UNIT_COSTS, headers=gw.h(SUPPORT))
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    assert (await gw.c.get(UNIT_COSTS, params={"period": "day"}, headers=gw.h(ANALYST))).status_code == 422
    assert (await gw.c.get(UNIT_COSTS)).status_code == 401
    # ничего не поменялось — ни событий, ни аудита
    assert await _level_events(gw) == [] and await gw.audit("ai.degradation_updated") == []


@pytest.mark.parametrize("body,fields", [
    ({"economy_at_percent": 91, "paid_only_at_percent": 90}, ["paid_only_at_percent"]),
    ({"economy_at_percent": 0}, ["economy_at_percent"]),
    ({"paid_only_at_percent": 101}, ["paid_only_at_percent"]),
    ({"mode": "manual", "manual_level": None}, ["manual_level"]),
    ({"mode": "auto", "manual_level": "off"}, ["manual_level"]),
])
async def test_degradation_invalid(gw, body: dict[str, Any], fields: list[str]) -> None:
    r = await _degradation(gw, body)
    assert r.status_code == 422 and r.json()["code"] == "DEGRADATION_INVALID", r.text
    assert r.json()["details"]["fields"] == fields


async def test_degradation_validation_errors(gw) -> None:
    for body in ({"mode": "manual", "manual_level": "turbo"}, {"reason": "коротко"}, {"extra": 1},
                 {"mode": "sometimes"}):
        r = await _degradation(gw, body)
        assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", body


# ---------------------------------------------------------------- тариф ученика


async def test_tier_projection(gw) -> None:
    learner = await _paid(gw)
    rows = await gw.sql("SELECT tier, paid_until FROM learner_tiers WHERE user_id = $1", learner)
    assert [(r["tier"], r["paid_until"]) for r in rows] == [("paid", None)]
    # позднее событие (раньше записанного) тариф не откатывает
    await gw.bus.publish(_access(learner, "free", changed_at=T0 - timedelta(minutes=5)))
    assert (await gw.sql("SELECT tier FROM learner_tiers WHERE user_id = $1", learner))[0]["tier"] == "paid"
    await gw.bus.publish(_access(learner, "free", changed_at=T0 + timedelta(minutes=5)))
    assert (await gw.sql("SELECT tier FROM learner_tiers WHERE user_id = $1", learner))[0]["tier"] == "free"
    # чужой издатель не меняет тариф
    other = uuid.uuid4()
    await gw.bus.publish(_access(other, producer="lessons"))
    assert await gw.sql("SELECT 1 FROM learner_tiers WHERE user_id = $1", other) == []
    assert not gw.bus.dlq


async def test_daily_cap_by_tier(gw) -> None:
    free, paid = uuid.uuid4(), await _paid(gw)
    expired = await _paid(gw, paid_until=T0 - timedelta(seconds=1))
    for learner in (free, paid, expired):
        await _spend(gw, "0.0499", user_id=learner)
    assert (await gw.ok(user_id=free))["reason"] == "budget_exceeded"
    assert (await gw.ok(user_id=expired))["reason"] == "budget_exceeded"  # подписка кончилась — бесплатный лимит
    assert (await gw.ok(user_id=paid))["status"] == "ok"  # подписчик — 0,30 $ в день
    await _spend(gw, "0.2500", user_id=paid)
    assert (await gw.ok(user_id=paid))["reason"] == "budget_exceeded"
    # лимит подписчика правится в бюджете
    await gw.set_budget(paid_learner_daily_cap_usd=1.0)
    assert (await gw.ok(user_id=paid))["status"] == "ok"


async def test_budget_paid_cap_validation(gw) -> None:
    current = (await gw.c.get("/admin/v1/ai/budget", headers=gw.h(OPERATIONS))).json()
    base = {k: current[k] for k in ("monthly_cap_usd", "learner_daily_cap_usd", "lesson_cap_usd",
                                    "speech_monthly_cap_usd", "room_cap_usd", "alert_percent")}
    for paid, fields in ((0.01, ["paid_learner_daily_cap_usd"]), (25.0, ["paid_learner_daily_cap_usd"])):
        r = await gw.c.put("/admin/v1/ai/budget", json={**base, "paid_learner_daily_cap_usd": paid,
                                                        "reason": "Проверка"}, headers=gw.h(OPERATIONS))
        assert r.status_code == 422 and r.json()["code"] == "BUDGET_INVALID", r.text
        assert r.json()["details"]["fields"] == fields
    # без поля — прежнее значение; бесплатный лимит выше лимита подписчика — тоже 422
    r = await gw.c.put("/admin/v1/ai/budget", json={**base, "learner_daily_cap_usd": 0.5, "reason": "Проверка"},
                       headers=gw.h(OPERATIONS))
    assert r.status_code == 422 and r.json()["details"]["fields"] == ["paid_learner_daily_cap_usd"]
    r = await gw.c.put("/admin/v1/ai/budget", json={**base, "paid_learner_daily_cap_usd": 0.5, "reason": "Проверка"},
                       headers=gw.h(OPERATIONS))
    assert r.status_code == 200 and r.json()["paid_learner_daily_cap_usd"] == 0.5
    [audit] = await gw.audit("ai.budget_updated")
    assert audit["before"]["paid_learner_daily_cap_usd"] == 0.3 and audit["after"]["paid_learner_daily_cap_usd"] == 0.5


# ---------------------------------------------------------------- уровни: авто


async def test_auto_levels_by_month_share(gw) -> None:
    free, paid = uuid.uuid4(), await _paid(gw)
    await _spend(gw, "16.00", at=T0 - timedelta(hours=1))  # 80 % — economy
    res = await gw.ok(user_id=free)
    # economy: попытка сразу резервной моделью версии
    assert res["status"] == "ok" and res["model_id"] == "claude-sonnet-5-5"
    assert [c.model_id for c in gw.provider.calls] == ["claude-sonnet-5-5"]
    status = await _status(gw)
    assert (status["level"], status["free_available"], status["paid_available"]) == ("economy", True, True)
    [changed] = await _level_events(gw)
    assert {k: changed[k] for k in ("from", "to", "mode", "reason")} == {
        "from": "normal", "to": "economy", "mode": "auto", "reason": "threshold"}
    assert 80 <= changed["spent_percent"] < 81

    await _spend(gw, "2.00", at=T0 - timedelta(hours=1))  # ≥ 90 % — paid_only
    gw.provider.calls.clear()
    res = await gw.ok(user_id=free)
    assert (res["status"], res["reason"], res["cost_usd"]) == ("unavailable", "degraded", 0)
    assert not gw.provider.calls  # до провайдера
    row = (await gw.usage())[-1]
    assert (row["status"], row["reason"], row["attempts"]) == ("unavailable", "degraded", 0)
    res = await gw.ok(user_id=paid)  # подписчик — как economy
    assert res["status"] == "ok" and res["model_id"] == "claude-sonnet-5-5"
    status = await _status(gw)
    assert (status["level"], status["free_available"], status["paid_available"]) == ("paid_only", False, True)
    # перевод по тапу (memory) бесплатному ученику — тоже degraded
    await gw.publish_v2()
    gw.provider.responses = [(gloss_out(), 200, 50)]
    gloss = (await gw.gloss(gloss_context(), user_id=free)).json()
    assert (gloss["status"], gloss["reason"]) == ("unavailable", "degraded")

    await _spend(gw, "2.50", at=T0 - timedelta(hours=1))  # ≥ 100 % — off
    res = await gw.ok(user_id=paid)
    assert (res["status"], res["reason"]) == ("unavailable", "budget_exceeded")
    status = await _status(gw)
    assert status == {"ai_available": True, "speech_available": False, "level": "off", "free_available": False,
                      "paid_available": False}
    levels = [(e["from"], e["to"], e["reason"]) for e in await _level_events(gw)]
    assert levels == [("normal", "economy", "threshold"), ("economy", "paid_only", "threshold"),
                      ("paid_only", "off", "threshold")]
    # новый месяц UTC — расход с нуля: normal, причина month_reset
    gw.set_now(datetime(2026, 12, 1, 0, 5, tzinfo=UTC))
    assert (await _status(gw))["level"] == "normal"
    last = (await _level_events(gw))[-1]
    assert (last["from"], last["to"], last["reason"]) == ("off", "normal", "month_reset")
    view = (await gw.c.get(DEGRADATION, headers=gw.h(ANALYST))).json()
    assert view["month"] == "2026-12" and view["level"] == "normal"
    assert [e["to"] for e in view["events"]] == ["normal", "off", "paid_only", "economy"]  # новые сверху
    assert all(e["actor"] is None for e in view["events"])


async def test_level_change_recorded_once_under_concurrency(gw) -> None:
    import asyncio

    await _spend(gw, "18.50", at=T0 - timedelta(hours=1))
    results = await asyncio.gather(*[_status(gw) for _ in range(8)])
    assert {r["level"] for r in results} == {"paid_only"}
    assert [(e["from"], e["to"]) for e in await _level_events(gw)] == [("normal", "paid_only")]
    rows = await gw.sql("SELECT from_level, to_level FROM degradation_events")
    assert [(r["from_level"], r["to_level"]) for r in rows] == [("normal", "paid_only")]


async def test_thresholds_are_configurable(gw) -> None:
    await _spend(gw, "16.00", at=T0 - timedelta(hours=1))  # 80 %
    r = await _degradation(gw, {"economy_at_percent": 85, "paid_only_at_percent": 95})
    assert r.status_code == 200, r.text
    assert (r.json()["level"], r.json()["economy_at_percent"]) == ("normal", 85)
    r = await _degradation(gw, {"economy_at_percent": 50, "paid_only_at_percent": 70})
    assert r.json()["level"] == "paid_only"
    # накопившийся до правки порог записан со своим основанием; пороги — правка сотрудника: manual и автор
    events = await _level_events(gw)
    assert [(e["to"], e["reason"]) for e in events] == [("economy", "threshold"), ("normal", "manual"),
                                                        ("paid_only", "manual")]
    rows = await gw.sql("SELECT actor FROM degradation_events ORDER BY seq")
    assert [r["actor"] for r in rows] == [None, OPERATIONS.id, OPERATIONS.id]


# ---------------------------------------------------------------- уровни: вручную и аварийная остановка


async def test_manual_levels_with_audit(gw) -> None:
    free, paid = uuid.uuid4(), await _paid(gw)
    r = await gw.c.put(
        DEGRADATION, json={"mode": "manual", "manual_level": "paid_only", "economy_at_percent": 80,
                           "paid_only_at_percent": 90, "reason": "Ручной режим: только подписчики"},
        headers=gw.h(OPERATIONS, **STEP_UP, **{"Idempotency-Key": "degr-manual-1"}))
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["mode"], body["manual_level"], body["level"]) == ("manual", "paid_only", "paid_only")
    assert body["events"][0]["actor"] == OPERATIONS.id and body["events"][0]["reason"] == "manual"
    # повтор с тем же Idempotency-Key — тот же ответ, без второй смены
    again = await gw.c.put(
        DEGRADATION, json={"mode": "manual", "manual_level": "paid_only", "economy_at_percent": 80,
                           "paid_only_at_percent": 90, "reason": "Ручной режим: только подписчики"},
        headers=gw.h(OPERATIONS, **STEP_UP, **{"Idempotency-Key": "degr-manual-1"}))
    assert again.status_code == 200 and again.headers.get("idempotent-replay") == "true"
    assert (await gw.ok(user_id=free))["reason"] == "degraded"
    assert (await gw.ok(user_id=paid))["status"] == "ok"
    [audit] = await gw.audit("ai.degradation_updated")
    assert audit["actor_id"] == OPERATIONS.id and audit["reason"] == "Ручной режим: только подписчики"
    assert audit["before"] == {"mode": "auto", "manual_level": None, "economy_at_percent": 80,
                               "paid_only_at_percent": 90, "level": "normal"}
    assert audit["after"] == {"mode": "manual", "manual_level": "paid_only", "economy_at_percent": 80,
                              "paid_only_at_percent": 90, "level": "paid_only"}
    # то же значение — без аудита и событий
    assert (await _degradation(gw, {"mode": "manual", "manual_level": "paid_only"})).status_code == 200
    assert len(await gw.audit("ai.degradation_updated")) == 1

    # ручной off: ИИ и произношение выключены (ai_disabled), статус — off
    r = await _degradation(gw, {"mode": "manual", "manual_level": "off"})
    assert r.json()["level"] == "off"
    assert (await gw.ok(user_id=paid))["reason"] == "ai_disabled"
    status = await _status(gw, "memory")
    assert (status["level"], status["speech_available"], status["ai_available"]) == ("off", False, True)
    from tilhero_ai_gateway.domain.wav import make_wav

    speech = (await gw.speech(make_wav(2000))).json()
    assert (speech["status"], speech["reason"]) == ("unavailable", "ai_disabled")
    # обратно в auto: normal
    r = await _degradation(gw, {"mode": "auto", "manual_level": None})
    assert (r.json()["mode"], r.json()["manual_level"], r.json()["level"]) == ("auto", None, "normal")
    assert [(e["from"], e["to"], e["mode"], e["reason"]) for e in await _level_events(gw)] == [
        ("normal", "paid_only", "manual", "manual"), ("paid_only", "off", "manual", "manual"),
        ("off", "normal", "auto", "manual")]
    assert len(await gw.audit("ai.degradation_updated")) == 3


async def test_paid_room_coach_on_behalf_of_payer(gw) -> None:
    """Поток C (lessons): коуч оплаченной комнаты урока вдвоём вызывается от имени плательщика (user_id = sub =
    пригласивший): на paid_only бесплатный приглашённый коуча не останавливает; комната без плательщика (вызов от
    имени ученика без подписки) — degraded до провайдера. Статус: paid_available при paid_only — true."""
    await gw.publish_coach()
    payer, guest = await _paid(gw), uuid.uuid4()
    assert (await _degradation(gw, {"mode": "manual", "manual_level": "paid_only"})).status_code == 200
    status = await _status(gw)
    assert (status["level"], status["free_available"], status["paid_available"]) == ("paid_only", False, True)
    ctx = coach_context()
    gw.provider.responses = [coach_out(ctx)]
    res = (await gw.coach(ctx, user_id=payer)).json()
    assert res["status"] == "ok", res
    gw.provider.calls.clear()
    res = (await gw.coach(coach_context(), user_id=guest)).json()
    assert (res["status"], res["reason"]) == ("unavailable", "degraded") and not gw.provider.calls


async def test_manual_economy_without_fallback_uses_primary(gw) -> None:
    await gw.publish_patched("conversation_partner", {"fallback_model_id": None})
    assert (await _degradation(gw, {"mode": "manual", "manual_level": "economy"})).json()["level"] == "economy"
    res = await gw.ok()
    assert res["status"] == "ok" and res["model_id"] == "claude-haiku-5-5"


async def test_emergency_stop_level(gw) -> None:
    r = await gw.c.post("/admin/v1/ai/emergency-stop", json={"enabled": True, "reason": "Проверка остановки"},
                        headers=gw.h(OPERATIONS))
    assert r.status_code == 200, r.text
    assert (await _status(gw))["level"] == "off"
    assert (await gw.ok())["reason"] == "ai_disabled"
    r = await gw.c.post("/admin/v1/ai/emergency-stop", json={"enabled": False, "reason": "Снятие остановки"},
                        headers=gw.h(OPERATIONS))
    assert r.status_code == 200
    events = await _level_events(gw)
    assert [(e["from"], e["to"], e["reason"]) for e in events] == [("normal", "off", "emergency_stop"),
                                                                    ("off", "normal", "emergency_stop")]
    rows = await gw.sql("SELECT actor FROM degradation_events ORDER BY seq")
    assert [r["actor"] for r in rows] == [OPERATIONS.id, OPERATIONS.id]


async def test_golden_runs_ignore_levels(env) -> None:
    """Золотые прогоны — только потолок месяца: ручной off их не останавливает (fake-провайдер)."""
    assert (await _degradation(env, {"mode": "manual", "manual_level": "off"})).status_code == 200
    v = await env.tested_draft("teaching_coach")
    assert v["version"] >= 2
    usage = await env.sql("SELECT status, reason FROM usage WHERE session_kind = 'golden'")
    assert usage and all(r["status"] == "ok" for r in usage)


# ---------------------------------------------------------------- стоимость занятий


def _session_completed(session_id: uuid.UUID, user_id: uuid.UUID, *, kind: str = "lesson", billable: int | None = 3,
                       at: datetime = T0, producer: str = "lessons"):
    return make_envelope("lesson.session.completed.v1", {
        "session_id": str(session_id), "user_id": str(user_id), "kind": kind, "pair_id": "en-ru",
        "status": "completed", "minutes": 5, "practice_only": False,
        "finished_at": at.isoformat().replace("+00:00", "Z"), "billable_minutes": billable,
        "billing_hold_id": str(uuid.uuid4()) if billable is not None else None}, producer=producer)


def _pair_completed(room_id: uuid.UUID, payer: uuid.UUID | None, billable: int | None, at: datetime = T0):
    def participant(minutes: int) -> dict[str, Any]:
        return {"user_id": str(uuid.uuid4()), "role": "A", "contributed": True, "turns": 4, "speaking_seconds": 30,
                "minutes": minutes}

    payload: dict[str, Any] = {
        "room_id": str(room_id), "scenario_id": "sc-1", "pair_id": "en-ru", "status": "finished",
        "end_reason": "completed", "team_goal_reached": True, "participants": [participant(7), participant(9)],
        "ended_at": at.isoformat().replace("+00:00", "Z")}
    if billable is not None and payer is not None:
        payload["billing"] = {"payer_user_id": str(payer), "hold_id": str(uuid.uuid4()),
                              "billable_minutes": billable}
    return make_envelope("lesson.pair.completed.v1", payload, producer="lessons")


async def test_unit_costs_report(gw) -> None:
    learner = uuid.uuid4()
    s1, s2, s3, sc, room, room2 = (uuid.uuid4() for _ in range(6))
    # урок 1: два вызова 0.002 + 0.001, 3 ИИ-минуты; урок 2: 0.010, 2 минуты; урок 3 — без ИИ (деградация)
    await _spend(gw, "0.002", session_id=s1, user_id=learner)
    await _spend(gw, "0.001", session_id=s1, user_id=learner)
    await _spend(gw, "0.010", session_id=s2, user_id=learner)
    await _spend(gw, "0", session_id=s3, user_id=learner, status="unavailable", reason="degraded")
    await _spend(gw, "0.004", session_id=sc, user_id=learner, kind="scenario")
    await _spend(gw, "0.006", session_id=room, kind="pair", agent_id="cooperative_lesson_coach")
    events = [_session_completed(s1, learner, billable=3), _session_completed(s2, learner, billable=2),
              _session_completed(s3, learner, billable=0), _session_completed(sc, learner, kind="scenario",
                                                                             billable=None),
              _session_completed(uuid.uuid4(), learner, kind="media", billable=None),  # не занятие с ИИ
              _session_completed(uuid.uuid4(), learner, kind="pair", billable=None),  # учитывается по комнате
              _pair_completed(room, learner, 4), _pair_completed(room2, None, None),
              _session_completed(uuid.uuid4(), learner, producer="gamification")]  # чужой издатель
    for e in events:
        await gw.bus.publish(e)
    await gw.bus.publish(events[0])  # повтор — без второй строки
    assert not gw.bus.dlq
    rows = await gw.sql("SELECT kind, count(*) AS n FROM session_costs GROUP BY kind ORDER BY kind")
    assert {r["kind"]: r["n"] for r in rows} == {"lesson": 3, "pair": 2, "scenario": 1}
    pair_row = (await gw.sql("SELECT user_id, minutes, billable_minutes FROM session_costs WHERE session_id = $1",
                             room))[0]
    assert (pair_row["user_id"], pair_row["minutes"], pair_row["billable_minutes"]) == (learner, 9, 4)

    r = await gw.c.get(UNIT_COSTS, params={"period": "month"}, headers=gw.h(ANALYST))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["period"] == "month" and body["from"] == "2026-11-01T00:00:00.000Z"
    lesson = body["by_kind"]["lesson"]
    assert lesson == {"sessions": 3, "ai_sessions": 2, "cost_usd": "0.013000",
                      "cost_per_ai_session_p50_usd": "0.003000", "cost_per_ai_session_p95_usd": "0.010000",
                      "billable_minutes": 5, "cost_per_billable_minute_usd": "0.002600"}
    scenario = body["by_kind"]["scenario"]
    assert (scenario["sessions"], scenario["ai_sessions"], scenario["cost_usd"], scenario["billable_minutes"],
            scenario["cost_per_billable_minute_usd"]) == (1, 1, "0.004000", 0, None)
    pair = body["by_kind"]["pair"]
    assert (pair["sessions"], pair["ai_sessions"], pair["cost_usd"], pair["billable_minutes"],
            pair["cost_per_billable_minute_usd"]) == (2, 1, "0.006000", 4, "0.001500")
    assert pair["cost_per_ai_session_p50_usd"] == "0.006000"
    assert body["degraded_sessions_pct"] == round(100 / 6, 1)
    # неделя — последние 7 дней по Ташкенту: занятие двухнедельной давности не попадает
    await gw.bus.publish(_session_completed(uuid.uuid4(), learner, at=T0 - timedelta(days=14)))
    week = (await gw.c.get(UNIT_COSTS, params={"period": "week"}, headers=gw.h(ANALYST))).json()
    assert week["by_kind"]["lesson"]["sessions"] == 3


async def test_saga_removes_tier_and_anonymizes_costs(gw) -> None:
    learner = await _paid(gw)
    session = uuid.uuid4()
    await gw.bus.publish(_session_completed(session, learner))
    await gw.bus.publish(make_envelope("user.deletion.requested.v1", {
        "user_id": str(learner), "request_id": str(uuid.uuid4()), "requested_at": "2026-11-19T07:00:00Z"},
        producer="identity-consent"))
    assert await gw.sql("SELECT 1 FROM learner_tiers WHERE user_id = $1", learner) == []
    rows = await gw.sql("SELECT user_id FROM session_costs WHERE session_id = $1", session)
    assert [r["user_id"] for r in rows] == [None]
    # тариф удалённого ученика больше не записывается; его новые занятия — без user_id
    await gw.bus.publish(_access(learner, changed_at=T0 + timedelta(minutes=1)))
    assert await gw.sql("SELECT 1 FROM learner_tiers WHERE user_id = $1", learner) == []
    late = uuid.uuid4()
    await gw.bus.publish(_session_completed(late, learner))
    assert [r["user_id"] for r in await gw.sql("SELECT user_id FROM session_costs WHERE session_id = $1",
                                               late)] == [None]


def test_spent_percent_and_levels() -> None:
    from tilhero_ai_gateway.domain import degradation as d

    assert d.spent_percent(Decimal("16"), Decimal("20")) == Decimal("80")
    assert d.shown_percent(d.spent_percent(Decimal("19.9999"), Decimal("20"))) == Decimal("99.99")
    assert d.auto_level(d.spent_percent(Decimal("19.9999"), Decimal("20")), 100, 100) == "normal"
    assert d.spent_percent(Decimal("1"), Decimal("0")) == Decimal(1000)
    assert d.spent_percent(Decimal("0"), Decimal("0")) == Decimal(0)
    assert d.spent_percent(Decimal("500"), Decimal("1")) == Decimal(1000)
    assert [d.auto_level(Decimal(p), 80, 90) for p in ("0", "79.99", "80", "89.99", "90", "99.99", "100")] == [
        "normal", "normal", "economy", "economy", "paid_only", "paid_only", "off"]
    assert d.auto_level(Decimal("99"), 100, 100) == "normal"
