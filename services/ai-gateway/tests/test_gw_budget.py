"""Бюджеты (решение владельца 19.11.2026, AT-51): месяц (UTC), ученик в день (Asia/Tashkent), урок (session_id) —
`unavailable: budget_exceeded` ДО вызова провайдера; max_cost_usd версии — накопительно по вызову, `cost_limit`
(ревью R1-02); не помещается основная модель — резервная, и только потом отказ; резервы параллельных вызовов."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from conftest import make_env
from gw_kit import CP_OK, ScriptedProvider

from tilhero_ai_gateway.domain.budget import estimate_cost
from tilhero_ai_gateway.models import ModelRow


@pytest.fixture
async def gw():
    provider = ScriptedProvider(default=(CP_OK, 1000, 100))
    async for e in make_env(provider=provider):
        e.provider = provider
        yield e


async def _spend(gw, usd: str, *, user_id=None, session_id=None, at: datetime | None = None) -> None:
    await gw.sql("INSERT INTO usage (call_id, request_id, caller, agent_id, provider, status, cost_usd, user_id, "
                 "session_id, session_kind, created_at, finished_at) VALUES ($1, $2, 'lessons', "
                 "'conversation_partner', 'anthropic', 'ok', $3::numeric, $4, $5, 'lesson', $6, $6)",
                 uuid.uuid4(), uuid.uuid4(), usd, user_id, session_id, at or gw.now)


def test_estimate_is_worst_case() -> None:
    haiku = ModelRow(model_id="claude-haiku-5-5", provider="anthropic", input_usd_per_mtok=Decimal("0.10"),
                     output_usd_per_mtok=Decimal("0.50"), active=True)
    # 3000 символов ≈ 1000 токенов × 0.10 + 2000 × 0.50 → 0.0001 + 0.001
    assert estimate_cost(haiku, input_chars=3000, max_output_tokens=2000) == Decimal("0.001100")
    assert estimate_cost(haiku, input_chars=1, max_output_tokens=1) == Decimal("0.000001")


async def test_monthly_cap(gw) -> None:
    # спринт 8: пороги деградации 100/100 — уровень normal до 100 %, проверяется сам потолок (уровни — в
    # test_gw_ai_control.py)
    await gw.sql("UPDATE budget SET economy_at_percent = 100, paid_only_at_percent = 100")
    await _spend(gw, "19.9999")
    res = await gw.ok()
    assert (res["status"], res["reason"], res["cost_usd"]) == ("unavailable", "budget_exceeded", 0)
    assert not gw.provider.calls  # до вызова провайдера
    row = (await gw.usage())[-1]
    # основная модель не поместилась → резервная (тоже не поместилась) → отказ
    assert (row["status"], row["reason"], row["attempts"], row["reserved_usd"]) == (
        "unavailable", "budget_exceeded", 2, 0)
    # прошлый месяц не считается: потолок — календарный месяц UTC
    gw.set_now(datetime(2026, 12, 1, 0, 30, tzinfo=UTC))
    assert (await gw.ok())["status"] == "ok"


async def test_monthly_cap_change_applies(gw) -> None:
    await gw.set_budget(monthly_cap_usd=0)
    assert (await gw.ok())["reason"] == "budget_exceeded"
    # спринт 8: learner_daily ≤ paid ≤ monthly — при потолке 0 дневные лимиты тоже 0, возвращаются явно
    await gw.set_budget(monthly_cap_usd=20, learner_daily_cap_usd=0.05, paid_learner_daily_cap_usd=0.3)
    assert (await gw.ok())["status"] == "ok"


async def test_learner_daily_cap_by_tashkent_day(gw) -> None:
    learner = uuid.uuid4()
    await _spend(gw, "0.0499", user_id=learner)
    res = await gw.ok(user_id=learner)
    assert res["reason"] == "budget_exceeded"
    assert (await gw.ok(user_id=uuid.uuid4()))["status"] == "ok"  # другой ученик — свой лимит
    gw.set_now(datetime(2026, 11, 19, 18, 30, tzinfo=UTC))  # 23:30 по Ташкенту — тот же день
    assert (await gw.ok(user_id=learner))["reason"] == "budget_exceeded"
    gw.set_now(datetime(2026, 11, 19, 19, 30, tzinfo=UTC))  # 00:30 по Ташкенту — новый день
    assert (await gw.ok(user_id=learner))["status"] == "ok"


async def test_lesson_cap_by_session(gw) -> None:
    session = uuid.uuid4()
    learner = uuid.uuid4()
    gw.provider.responses = [(CP_OK, 100_000, 50_000)]  # 0.01 + 0.025 = 0.035 > потолка урока 0.03
    first = await gw.ok(session_id=session, user_id=learner)
    assert first["status"] == "ok" and first["cost_usd"] == pytest.approx(0.035)
    res = await gw.ok(session_id=session, user_id=learner)
    assert res["reason"] == "budget_exceeded" and len(gw.provider.calls) == 1
    other = await gw.ok(session_id=uuid.uuid4(), user_id=learner)
    assert other["status"] == "ok"  # другая сессия того же ученика (0.035 < 0.05 в день)


async def test_retry_attempts_are_budgeted(gw) -> None:
    """Повтор и резервная модель тоже проходят проверку бюджета: дорогой неудачный ответ не оплачивает следующий."""
    await gw.price("claude-sonnet-5-5", 0.1, 0.5)  # резервная — по цене основной (повышение цены ai.publish можно)
    await gw.set_budget(lesson_cap_usd=0.005)
    gw.provider.responses = [("not json", 20_000, 8_000)]  # 0.002 + 0.004 = 0.006 > потолка урока
    res = await gw.ok()
    assert (res["status"], res["reason"]) == ("unavailable", "budget_exceeded")
    assert len(gw.provider.calls) == 1  # повтор и резервная не поместились — к провайдеру не ходили
    row = (await gw.usage())[-1]
    assert str(row["cost_usd"]) == "0.006000" and row["attempts"] == 3 and row["reason"] == "budget_exceeded"


async def test_max_cost_per_call(gw) -> None:
    v = await gw.draft("conversation_partner")
    r = await gw.patch("conversation_partner", v["version"], {"max_cost_usd": 0.000001}, v["updated_at"])
    assert r.status_code == 200
    await gw.sql("UPDATE agent_rollout SET canary_version = $1, canary_percent = 50 "
                 "WHERE agent_id = 'conversation_partner'", v["version"])
    from tilhero_ai_gateway.domain.invoke import canary_bucket

    learner = next(u for u in (uuid.uuid4() for _ in range(200)) if canary_bucket(str(u), "conversation_partner") < 50)
    res = await gw.ok(user_id=learner)
    # лимит версии — не бюджет (ревью R1-02): отдельная причина, резервная модель тоже не поместилась
    assert res["canary"] and res["reason"] == "cost_limit" and not gw.provider.calls
    row = (await gw.usage())[-1]
    assert (row["reason"], row["attempts"], row["cost_usd"]) == ("cost_limit", 2, 0)


async def test_parallel_calls_reserve_budget(gw) -> None:
    """Параллельные вызовы видят резервы друг друга: потолок урока не превышается гонкой."""
    session = uuid.uuid4()
    await gw.set_budget(lesson_cap_usd=0.0005)  # хватает на один резерв (~0.00016), не на четыре

    async def slow(_request):
        await asyncio.sleep(0.2)
        return CP_OK, 10, 10

    gw.provider.default = slow
    results = await asyncio.gather(*(gw.ok(session_id=session) for _ in range(4)))
    statuses = sorted(r["status"] for r in results)
    assert statuses.count("ok") in (1, 2, 3) and "unavailable" in statuses
    rows = await gw.sql("SELECT sum(cost_usd + reserved_usd) AS s FROM usage WHERE session_id = $1", session)
    assert rows[0]["s"] <= Decimal("0.0005")


async def test_stale_pending_reservation_released(gw) -> None:
    learner = uuid.uuid4()
    await gw.sql("INSERT INTO usage (call_id, request_id, caller, agent_id, provider, status, reserved_usd, user_id, "
                 "created_at) VALUES ($1, $2, 'lessons', 'conversation_partner', 'anthropic', 'pending', 1, $3, $4)",
                 uuid.uuid4(), uuid.uuid4(), learner, datetime(2026, 11, 19, 6, 0, tzinfo=UTC))
    res = await gw.ok(user_id=learner)  # резерв «зависшего» вызова старше 10 минут снят
    assert res["status"] == "ok"
    stale = await gw.sql("SELECT status, reason, reserved_usd FROM usage WHERE user_id = $1 AND reserved_usd = 0 "
                         "AND status = 'unavailable'", learner)
    assert len(stale) == 1 and stale[0]["reason"] == "provider_error"
