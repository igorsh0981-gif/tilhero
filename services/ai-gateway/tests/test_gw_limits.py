"""Ревью R1-02, R1-03, R1-04, R1-08: лимит версии на вызов — накопительно и с отдельной причиной `cost_limit`, не
помещается основная модель — резервная (и по лимиту версии, и по бюджету урока); дедлайн вызывающего (`deadline_ms`);
дубль request_id ждёт результат первого вызова; таймаут клиента и неразборчивый ответ после HTTP 200 — в стоимости
оценка попытки. Провайдер — сценарный с именем anthropic (стоимость по ценам Claude из таблицы models)."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from decimal import Decimal

import pytest
from conftest import make_env
from gw_kit import CP_OK, ScriptedProvider, ie_context

from tilhero_ai_gateway.domain.budget import estimate_cost
from tilhero_ai_gateway.models import ModelRow
from tilhero_ai_gateway.providers import ProviderError, ProviderRequest, ProviderTimeout

PRICES = {"claude-haiku-5-5": (Decimal("0.10"), Decimal("0.50")),
          "claude-sonnet-5-5": (Decimal("2.00"), Decimal("10.00"))}
EV = "independent_evaluator"


@pytest.fixture
async def gw():
    provider = ScriptedProvider()
    async for e in make_env(provider=provider):
        e.provider = provider
        yield e


def ev_ok(**over) -> str:
    base = {"status": "ok", "scores": {"task": 3, "grammar": 2}, "task_completed": True,
            "confirmed_errors": [{"turn_id": "T1", "evidence": "I am agree", "correction": "I agree",
                                  "error_code": "extra_be", "severity": "medium"}],
            "support_used": False, "confidence": 0.8, "pronunciation_score": None, "cefr_certificate": False,
            "requires_human_review": False}
    base.update(over)
    return json.dumps(base)


def estimate(call: ProviderRequest) -> Decimal:
    """Оценка шлюза для попытки (символы/3 входа + max_tokens выхода) по ценам модели попытки."""
    price_in, price_out = PRICES[call.model_id]
    model = ModelRow(model_id=call.model_id, provider="anthropic", input_usd_per_mtok=price_in,
                     output_usd_per_mtok=price_out, active=True)
    return estimate_cost(model, input_chars=len(call.system) + len(call.user), max_output_tokens=call.max_tokens)


async def evaluate(gw, **kw) -> dict:
    return await gw.ok(EV, ie_context("I am agree with you."), caller="assessment", **kw)


async def probe_sonnet(gw) -> Decimal:
    """Оценка первой попытки оценщика (sonnet) на этом контексте — по фактическому запросу к провайдеру."""
    gw.provider.responses = [ev_ok()]
    assert (await evaluate(gw))["model_id"] == "claude-sonnet-5-5"
    value = estimate(gw.provider.calls[-1])
    gw.provider.calls.clear()
    return value


# ---------------------------------------------------------------- лимит версии на вызов (R1-02)


async def test_cost_limit_falls_back_to_cheaper_model(gw) -> None:
    """Оценка основной модели больше max_cost_usd версии → попытка на резервной (дешевле), а не отказ."""
    sonnet = await probe_sonnet(gw)
    await gw.publish_patched(EV, {"max_cost_usd": float(sonnet - Decimal("0.000001"))})
    gw.provider.responses = [ev_ok()]
    res = await evaluate(gw)
    assert (res["status"], res["model_id"]) == ("ok", "claude-haiku-5-5")
    assert [c.model_id for c in gw.provider.calls] == ["claude-haiku-5-5"]  # sonnet не вызывался
    row = (await gw.usage())[-1]
    assert (row["status"], row["reason"], row["attempts"]) == ("ok", None, 2)


async def test_cost_limit_reason_when_fallback_does_not_fit(gw) -> None:
    await gw.publish_patched(EV, {"max_cost_usd": 0.000001})
    res = await evaluate(gw)
    assert (res["status"], res["reason"], res["cost_usd"]) == ("unavailable", "cost_limit", 0)
    assert not gw.provider.calls
    row = (await gw.usage())[-1]
    assert (row["reason"], row["attempts"], row["reserved_usd"]) == ("cost_limit", 2, 0)


async def test_max_cost_is_cumulative_per_call(gw) -> None:
    """max_cost_usd — на вызов целиком: оплаченная неудачная попытка + оценка повтора не помещаются → повтор на
    основной модели пропускается, следующая попытка — резервная модель (с ограничениями повтора)."""
    await gw.publish_patched(EV, {"max_cost_usd": 0.02})
    # sonnet: 1000 × 2 + 1000 × 10 = 0.012 оплачено; повтор ≥ 0.008 (только вывод) → > 0.02
    gw.provider.responses = [("not json", 1000, 1000), (ev_ok(), 2000, 300)]
    res = await evaluate(gw)
    assert res["status"] == "ok" and res["warnings"] == ["not_json"]
    calls = gw.provider.calls
    assert [c.model_id for c in calls] == ["claude-sonnet-5-5", "claude-haiku-5-5"]
    assert "not_json" in calls[1].system
    # 0.012 (sonnet) + 2000 × 0.10 + 300 × 0.50 (haiku) = 0.012 + 0.00035
    assert res["cost_usd"] == pytest.approx(0.01235)
    assert res["cost_usd"] <= 0.02


# ---------------------------------------------------------------- бюджет → резервная модель (R1-03)


async def test_lesson_budget_falls_back_to_cheaper_model(gw) -> None:
    sonnet = await probe_sonnet(gw)
    await gw.set_budget(lesson_cap_usd=float(sonnet - Decimal("0.0001")))
    gw.provider.responses = [ev_ok()]
    res = await evaluate(gw)
    assert (res["status"], res["model_id"]) == ("ok", "claude-haiku-5-5")
    assert [c.model_id for c in gw.provider.calls] == ["claude-haiku-5-5"]
    # и резервная не помещается → только тогда budget_exceeded
    await gw.set_budget(lesson_cap_usd=0.0001)
    gw.provider.calls.clear()
    res = await evaluate(gw)
    assert (res["status"], res["reason"]) == ("unavailable", "budget_exceeded") and not gw.provider.calls


async def test_retry_not_fitting_lesson_budget_goes_to_fallback(gw) -> None:
    """Неудачная первая попытка; повтор на основной не помещается в лимит урока — резервная модель помещается."""
    sonnet = await probe_sonnet(gw)
    await gw.set_budget(lesson_cap_usd=float(sonnet + Decimal("0.002")))
    gw.provider.responses = [("not json", 500, 100), ev_ok()]  # sonnet: 0.001 + 0.001 = 0.002 оплачено
    res = await evaluate(gw)
    assert res["status"] == "ok" and res["model_id"] == "claude-haiku-5-5"
    assert [c.model_id for c in gw.provider.calls] == ["claude-sonnet-5-5", "claude-haiku-5-5"]


async def test_learner_daily_budget_falls_back_to_cheaper_model(gw) -> None:
    sonnet = await probe_sonnet(gw)
    await gw.set_budget(learner_daily_cap_usd=float(sonnet - Decimal("0.0001")))
    gw.provider.responses = [ev_ok()]
    res = await evaluate(gw, user_id=uuid.uuid4())
    assert (res["status"], res["model_id"]) == ("ok", "claude-haiku-5-5")


# ---------------------------------------------------------------- дедлайн вызывающего (R1-03)


async def _post(gw, body: dict, caller: str = "lessons"):
    return await gw.c.post(f"/internal/v1/agents/{'conversation_partner'}/invoke", json=body,
                           headers=gw.svc(caller, body["user_id"]))


async def test_deadline_too_short_no_attempt(gw) -> None:
    body = gw.body()
    body["deadline_ms"] = 1000  # < 1,5 с — попытку не начинаем
    r = await _post(gw, body)
    assert r.status_code == 200
    assert (r.json()["status"], r.json()["reason"], r.json()["cost_usd"]) == ("unavailable", "timeout", 0)
    assert not gw.provider.calls
    row = (await gw.usage())[-1]
    assert (row["status"], row["reason"], row["attempts"]) == ("unavailable", "timeout", 0)


async def test_deadline_bounds_attempt_and_skips_fallback(gw) -> None:
    """Таймаут попытки = min(timeout_ms версии 8 с, остаток − 0,5 с); после неё до дедлайна < 1,5 с — резервную
    модель не пробуем. Таймаут клиента — в стоимость оценка попытки (ревью R1-08)."""
    async def slow(_request):
        await asyncio.sleep(5)
        return CP_OK

    gw.provider.responses = [slow]
    body = gw.body()
    body["deadline_ms"] = 3500
    started = time.monotonic()
    r = await _post(gw, body)
    elapsed = time.monotonic() - started
    assert (r.json()["status"], r.json()["reason"]) == ("unavailable", "timeout")
    assert elapsed < 3.5  # ответ до дедлайна вызывающего (попытка ≈ 3 с + запись учёта)
    [call] = gw.provider.calls  # резервная (sonnet) не вызывалась
    assert 2.0 <= call.timeout_s <= 3.0  # остаток − 0,5 с, а не 8 с версии
    assert r.json()["cost_usd"] == pytest.approx(float(estimate(call)))
    row = (await gw.usage())[-1]
    assert row["cost_usd"] == estimate(call)


async def test_long_deadline_keeps_version_timeout(gw) -> None:
    gw.provider.responses = [CP_OK]
    body = gw.body()
    body["deadline_ms"] = 60_000
    r = await _post(gw, body)
    assert r.json()["status"] == "ok" and gw.provider.calls[0].timeout_s == 8.0  # timeout_ms версии


@pytest.mark.parametrize("value", [999, 60_001, 0, "soon"])
async def test_deadline_validation(gw, value) -> None:
    body = gw.body()
    body["deadline_ms"] = value
    r = await _post(gw, body)
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"


# ---------------------------------------------------------------- стоимость при сбоях (R1-08)


async def test_timeout_and_bad_response_cost_is_estimate(gw) -> None:
    gw.provider.responses = [ProviderTimeout(), ProviderError("bad_response")]
    res = await gw.ok()
    assert (res["status"], res["reason"]) == ("unavailable", "provider_error")
    expected = sum((estimate(c) for c in gw.provider.calls), Decimal(0))
    assert [c.model_id for c in gw.provider.calls] == ["claude-haiku-5-5", "claude-sonnet-5-5"]
    row = (await gw.usage())[-1]
    assert row["cost_usd"] == expected > 0 and res["cost_usd"] == pytest.approx(float(expected))
    # ошибка HTTP и сети — запрос не обработан, не оплачен
    gw.provider.responses = [ProviderError("http_529"), ProviderError("network")]
    res = await gw.ok()
    assert res["cost_usd"] == 0 and (await gw.usage())[-1]["cost_usd"] == 0


async def test_estimated_cost_counts_against_budget(gw) -> None:
    """Оценка за таймаут входит в лимиты: следующая попытка видит её как оплаченную."""
    gw.provider.responses = [ProviderTimeout()]
    session = uuid.uuid4()
    await gw.ok(session_id=session)
    row = (await gw.usage())[-1]
    spent = await gw.sql("SELECT sum(cost_usd) AS s FROM usage WHERE session_id = $1", session)
    assert spent[0]["s"] == row["cost_usd"] > 0


# ---------------------------------------------------------------- дубль request_id (R1-04)


async def test_duplicate_waits_for_first_result(gw) -> None:
    async def slow(_request):
        await asyncio.sleep(0.6)
        return CP_OK

    gw.provider.responses = [slow]
    body = gw.body()

    async def second():
        await asyncio.sleep(0.15)
        return await _post(gw, body)

    first, dup = await asyncio.gather(_post(gw, body), second())
    assert first.status_code == dup.status_code == 200
    assert first.json() == dup.json() and first.json()["status"] == "ok"
    assert first.headers.get("idempotent-replay") is None and dup.headers.get("idempotent-replay") == "true"
    assert len(gw.provider.calls) == 1 and len(await gw.usage()) == 1


async def test_duplicate_gives_up_at_caller_deadline(gw) -> None:
    async def slow(_request):
        await asyncio.sleep(2.5)
        return CP_OK

    gw.provider.responses = [slow]
    body = gw.body()
    dup_body = {**body, "deadline_ms": 1000}  # дедлайн — не часть отпечатка: тот же вызов

    async def second():
        await asyncio.sleep(0.15)
        started = time.monotonic()
        r = await _post(gw, dup_body)
        return r, time.monotonic() - started

    first, (dup, waited) = await asyncio.gather(_post(gw, body), second())
    assert dup.status_code == 409 and dup.json()["code"] == "IDEMPOTENCY_IN_PROGRESS"
    assert 0.5 <= waited < 1.5  # ждал до дедлайна вызывающего (1 с минус запас 0,25 с), а не 25 с
    assert first.status_code == 200 and first.json()["status"] == "ok"
    late = await _post(gw, dup_body)  # после завершения — сохранённый результат
    assert late.status_code == 200 and late.headers.get("idempotent-replay") == "true"
    assert late.json() == first.json() and len(gw.provider.calls) == 1


async def test_duplicate_with_other_body_rejected_immediately(gw) -> None:
    async def slow(_request):
        await asyncio.sleep(1.0)
        return CP_OK

    gw.provider.responses = [slow]
    body = gw.body()
    other = {**body, "locale": "uz"}

    async def second():
        await asyncio.sleep(0.15)
        started = time.monotonic()
        return await _post(gw, other), time.monotonic() - started

    _, (dup, waited) = await asyncio.gather(_post(gw, body), second())
    assert dup.status_code == 422 and dup.json()["code"] == "IDEMPOTENCY_KEY_REUSED" and waited < 0.5
