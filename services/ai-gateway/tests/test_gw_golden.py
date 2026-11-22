"""Золотые тесты (INTERNAL_API §1.1, §9; AT-49): проверки по путям от корня AgentInvokeResult, прогон на fake
(содержимое output.* — skipped) и на настоящем провайдере, запрет публикации без свежего зелёного прогона этой версии,
CRUD кейсов."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from conftest import make_env
from gw_kit import ANALYST, MANAGER, OPERATIONS, PUBLISHER, T0, ScriptedProvider, golden_context

from tilhero_ai_gateway.domain.golden import evaluate_check
from tilhero_ai_gateway.domain.versions import fail_stale_runs

SCHEMA = {"type": "object", "properties": {"intent": {"type": "string"}}, "additionalProperties": False}
METHODIST_2 = MANAGER.__class__(id=str(uuid.uuid4()), role="methodist",
                                permissions=frozenset({"ai.read", "ai.manage"}))
RESULT = {"status": "ok", "reason": None, "cost_usd": 0.0,
          "output": {"intent": "order", "items": [{"e": "a"}, {"e": "bb"}], "none": None, "text": "Hello World"}}


@pytest.mark.parametrize(("check", "passed"), [
    ({"kind": "field_equals", "path": "status", "value": "ok"}, True),
    ({"kind": "field_equals", "path": "reason", "value": None}, True),
    ({"kind": "field_equals", "path": "output.intent", "value": "order"}, True),
    ({"kind": "field_equals", "path": "intent", "value": "order"}, False),  # пути — от корня результата
    ({"kind": "field_equals", "path": "output.missing", "value": None}, False),
    ({"kind": "field_equals", "path": "cost_usd", "value": 0}, True),
    ({"kind": "field_in", "path": "output.items.1.e", "values": ["a", "bb"]}, True),
    ({"kind": "field_in", "path": "output.items.5.e", "values": ["a"]}, False),
    ({"kind": "field_in", "path": "output.items.*.e", "values": ["a"]}, False),
    ({"kind": "field_absent", "path": "output.none"}, True),
    ({"kind": "field_absent", "path": "output.items.2"}, True),
    ({"kind": "field_absent", "path": "output.items.0"}, False),
    ({"kind": "text_not_contains", "path": "output.text", "values": ["world"]}, False),
    ({"kind": "text_not_contains", "path": "output.text", "values": ["http"]}, True),
    ({"kind": "text_not_contains", "path": "output.nope", "values": ["x"]}, True),
    ({"kind": "text_not_contains", "path": "output.items", "values": ["BB"]}, False),
    ({"kind": "max_length", "path": "output.items", "n": 2}, True),
    ({"kind": "max_length", "path": "output.text", "n": 5}, False),
    ({"kind": "max_length", "path": "output.none", "n": 0}, True),
    ({"kind": "max_length", "path": "cost_usd", "n": 5}, False),
    ({"kind": "max_length", "path": "output.nope", "n": 5}, False),
    ({"kind": "schema_valid"}, False),
])
def test_check_semantics(check: dict[str, Any], passed: bool) -> None:
    assert (evaluate_check(check, RESULT, SCHEMA) is None) is passed, check


def test_schema_valid() -> None:
    assert evaluate_check({"kind": "schema_valid"}, {"output": {"intent": "x"}}, SCHEMA) is None
    assert evaluate_check({"kind": "schema_valid"}, {"output": None}, SCHEMA) == "schema_valid: нет вывода"


async def test_fake_run_skips_output_content(env) -> None:
    run = await env.run_tests("conversation_partner", 1)
    assert run["status"] == "finished" and run["provider"] == "fake" and run["passed_mandatory"] is True
    assert (run["passed"], run["failed"]) == (4, 0) and run["cost_usd"] == 0
    by_case = {r["case_id"]: r for r in run["results"]}
    order = by_case["cp-order-coffee"]
    assert order["mandatory"] and order["failures"] == []
    assert order["skipped"] == ["field_equals output.intent", "max_length output.reply_en",
                                "text_not_contains output.reply_en"]  # schema_valid и status — выполнены
    kids = by_case["cp-kids-refused"]
    assert kids["passed"] and kids["skipped"] == []  # status/reason/output/cost_usd — вне output.*
    calls = await env.sql("SELECT session_kind, user_id, caller, session_id FROM usage")
    assert len(calls) == 4 and {(c["session_kind"], c["user_id"], c["caller"]) for c in calls} == {
        ("golden", None, "golden")}
    assert {str(c["session_id"]) for c in calls} == {run["run_id"]}
    audit = await env.audit("ai.test_run")
    assert audit and audit[0]["object_id"] == "conversation_partner@1" and audit[0]["after"]["provider"] == "fake"


async def test_kids_case_requires_refusal(env) -> None:
    """Агент свободного текста обязан отказать ребёнку; иначе обязательный детский кейс провален."""
    await env.sql("UPDATE agents SET free_text = false WHERE agent_id = 'conversation_partner'")
    run = await env.run_tests("conversation_partner", 1)
    assert run["passed_mandatory"] is False
    kids = next(r for r in run["results"] if r["case_id"] == "cp-kids-refused")
    assert not kids["passed"] and any("status" in f for f in kids["failures"])


def _smart(request) -> tuple[str, int, int]:
    """«Модель»-сценарий, отвечающая по смыслу золотых кейсов фикстуры."""
    ctx = json.loads(request.user)["context"]
    if request.agent_id == "conversation_partner":
        intent = "order_coffee" if "cappuccino" in ctx["learner_turn"].lower() else "unclear"
        return json.dumps({"intent": intent, "reply_en": "Sure!" if intent != "unclear" else "Sorry?",
                           "hint_offered": intent == "unclear"}), 500, 50
    return json.dumps({"explanation": "Скажите проще: Nice to meet you!" if ctx["explain_locale"] == "ru"
                       else "Soddaroq ayting", "example_en": "Nice to meet you!",
                       "example_gloss": "Приятно познакомиться" if ctx["explain_locale"] == "ru"
                       else "Tanishganimdan xursandman"}), 500, 50


@pytest.fixture
async def real():
    """Провайдер «anthropic» (сценарий), публикация только по прогону на настоящем провайдере (как stage/prod)."""
    provider = ScriptedProvider(default=_smart)
    async for e in make_env(provider=provider, ai_allow_fake_test_publish=False):
        e.provider = provider
        yield e


async def test_real_provider_runs_output_checks_and_costs(real) -> None:
    run = await real.run_tests("conversation_partner", 1)
    assert run["provider"] == "anthropic" and run["passed_mandatory"] is True and run["failed"] == 0
    assert all(r["skipped"] == [] for r in run["results"])
    assert run["cost_usd"] == pytest.approx(3 * (500 * 0.1 + 50 * 0.5) / 1e6)  # 3 вызова (кейс детей — без вызова)
    real.provider.default = lambda request: (json.dumps({"intent": "order_coffee", "reply_en": "Sure!",
                                                         "hint_offered": False}), 10, 10)
    run = await real.run_tests("conversation_partner", 1)
    assert run["passed_mandatory"] is False
    failed = {r["case_id"]: r["failures"] for r in run["results"] if not r["passed"]}
    assert set(failed) == {"cp-injection", "cp-unclear"}
    assert "field_in output.intent" in failed["cp-injection"][0]


async def test_publish_requires_fresh_green_run_of_this_version(real) -> None:
    v = await real.draft("conversation_partner")
    no = v["version"]
    r = await real.publish("conversation_partner", no)
    assert r.status_code == 422 and r.json()["code"] == "TESTS_REQUIRED"
    assert r.json()["details"]["reason"] == "no_recent_run"
    # прогон с проваленным обязательным кейсом → TESTS_FAILED {case_ids}
    good = real.provider.default
    real.provider.default = lambda request: (json.dumps({"intent": "order_coffee", "reply_en": "Sure!",
                                                         "hint_offered": False}), 10, 10)
    await real.run_tests("conversation_partner", no)
    r = await real.publish("conversation_partner", no)
    assert r.status_code == 422 and r.json()["code"] == "TESTS_FAILED"
    assert r.json()["details"]["case_ids"] == ["cp-injection"]
    real.provider.default = good
    run = await real.run_tests("conversation_partner", no)
    assert run["passed_mandatory"]
    # правка после прогона → прогон устарел
    current = (await real.c.get(real.url("conversation_partner", "versions", no), headers=real.h(ANALYST))).json()
    r = await real.patch("conversation_partner", no, {"rules": "New rules"}, current["updated_at"])
    assert r.status_code == 200
    r = await real.publish("conversation_partner", no)
    assert r.json()["details"]["reason"] == "version_changed"
    await real.run_tests("conversation_partner", no)
    # новый обязательный кейс после прогона → прогон устарел; необязательный — нет
    case = {"title": "Новый обязательный", "mandatory": True, "checks": [{"kind": "schema_valid"}],
            "input": {"audience": "adults", "context": golden_context("conversation_partner", "cp-order-coffee")}}
    created = await real.c.post(real.url("conversation_partner", "golden-cases"), json=case, headers=real.h(MANAGER))
    assert created.status_code == 201, created.text
    r = await real.publish("conversation_partner", no)
    assert r.json()["details"]["reason"] == "cases_changed"
    await real.run_tests("conversation_partner", no)
    optional = {**case, "mandatory": False, "title": "Новый необязательный"}
    assert (await real.c.post(real.url("conversation_partner", "golden-cases"), json=optional,
                              headers=real.h(MANAGER))).status_code == 201
    # старше 14 дней → нужен новый прогон
    real.set_now(T0 + timedelta(days=15))
    r = await real.publish("conversation_partner", no)
    assert r.json()["details"]["reason"] == "no_recent_run"
    real.set_now(T0)
    r = await real.publish("conversation_partner", no)
    assert r.status_code == 200, r.text
    row = r.json()
    assert row["published"]["version"] == no and row["published"]["published_by"] == PUBLISHER.id
    assert row["rollout"]["published_version"] == no and row["rollout"]["previous_version"] == 1
    assert (await real.publish("conversation_partner", no)).status_code == 200  # повтор — без изменений
    r = await real.publish("conversation_partner", 1)
    assert r.status_code == 409 and r.json()["code"] == "VERSION_NOT_DRAFT"
    statuses = await real.sql("SELECT version, status FROM agent_versions WHERE agent_id = 'conversation_partner' "
                              "ORDER BY version")
    assert [(s["version"], s["status"]) for s in statuses] == [(1, "archived"), (no, "published")]
    audit = await real.audit("ai.version_published")
    assert len(audit) == 1 and audit[0]["before"]["published_version"] == 1 and audit[0]["reason"]


async def test_fake_run_does_not_allow_publish_in_secure_mode() -> None:
    """Без AI_ALLOW_FAKE_TEST_PUBLISH прогон на fake не даёт права публиковать (stage/prod — только anthropic)."""
    async for e in make_env(ai_allow_fake_test_publish=False):
        v = await e.tested_draft("teaching_coach")
        r = await e.publish("teaching_coach", v["version"])
        assert r.status_code == 422 and r.json()["details"]["reason"] == "real_provider_required"
        r = await e.c.put(e.url("teaching_coach", "canary"), json={"version": v["version"], "percent": 5,
                                                                    "reason": "Канарейка"}, headers=e.h(PUBLISHER))
        assert r.status_code == 422 and r.json()["code"] == "TESTS_REQUIRED"


async def test_no_mandatory_cases(env) -> None:
    v = await env.draft("teaching_coach")
    await env.run_tests("teaching_coach", v["version"])
    for case_id in ("tc-simpler-ru", "tc-simpler-uz"):
        assert (await env.c.delete(f"/admin/v1/ai/golden-cases/{case_id}", headers=env.h(MANAGER))).status_code == 204
    run = await env.run_tests("teaching_coach", v["version"])
    assert run["passed_mandatory"] is False  # нет обязательных кейсов — нечем подтвердить
    r = await env.publish("teaching_coach", v["version"])
    assert r.status_code == 422 and r.json()["details"]["reason"] == "no_mandatory_cases"


async def test_test_run_errors(env) -> None:
    r = await env.c.post(env.url("conversation_partner", "versions", 9, "test-runs"), headers=env.h(MANAGER))
    assert r.status_code == 404 and r.json()["code"] == "VERSION_NOT_FOUND"
    r = await env.c.post(env.url("learning_orchestrator", "versions", 1, "test-runs"), headers=env.h(MANAGER))
    assert r.status_code == 409 and r.json()["code"] == "AGENT_NOT_LLM"
    # spaced_repetition_coach с 0004 — code (memory): версий инструкций нет
    r = await env.c.post(env.url("spaced_repetition_coach", "versions"), headers=env.h(MANAGER))
    assert r.status_code == 409 and r.json()["code"] == "AGENT_NOT_LLM"
    # duel_host с 0008 — code (lessons), referral_integrity_reviewer — rules (social): версий инструкций нет
    for agent_id in ("duel_host", "referral_integrity_reviewer"):
        r = await env.c.post(env.url(agent_id, "versions"), headers=env.h(MANAGER))
        assert r.status_code == 409 and r.json()["code"] == "AGENT_NOT_LLM", agent_id
    draft = await env.draft("media_lesson_designer")  # planned LLM-агент: черновик из шаблона, кейсов нет
    assert draft["version"] == 1 and draft["output_schema"] == {"type": "object"}
    r = await env.c.post(env.url("media_lesson_designer", "versions", 1, "test-runs"), headers=env.h(MANAGER))
    assert r.status_code == 422 and r.json()["code"] == "NO_GOLDEN_CASES"
    r = await env.c.get(env.url("conversation_partner", "versions", 1, "test-runs", uuid.uuid4()),
                        headers=env.h(ANALYST))
    assert r.status_code == 404 and r.json()["code"] == "TEST_RUN_NOT_FOUND"
    run = await env.run_tests("conversation_partner", 1)
    r = await env.c.get(env.url("teaching_coach", "versions", 1, "test-runs", run["run_id"]), headers=env.h(ANALYST))
    assert r.status_code == 404  # прогон другого агента


async def test_parallel_run_conflict_and_stale_runs() -> None:
    gate = asyncio.Event()

    async def slow(request):
        await gate.wait()
        return json.dumps({"intent": "unclear", "reply_en": "Sorry?", "hint_offered": True}), 1, 1

    provider = ScriptedProvider(default=slow)
    async for e in make_env(provider=provider):
        r = await e.c.post(e.url("conversation_partner", "versions", 1, "test-runs"), headers=e.h(MANAGER))
        assert r.status_code == 202 and r.json()["status"] == "running"
        again = await e.c.post(e.url("conversation_partner", "versions", 1, "test-runs"), headers=e.h(MANAGER))
        assert again.status_code == 409 and again.json()["code"] == "TEST_RUN_IN_PROGRESS"
        gate.set()
        await e.wait_run("conversation_partner", 1, r.json()["run_id"])
        await e.sql("INSERT INTO test_runs (run_id, agent_id, version, status, provider, body_hash, cases_hash, "
                    "started_by, started_at) VALUES ($1, 'teaching_coach', 1, 'running', 'fake', $2, $2, 'x', $3)",
                    uuid.uuid4(), "0" * 64, T0 - timedelta(hours=3))
        async with e.runtime.transaction() as session:
            assert await fail_stale_runs(session, T0, 60) == 1
        rows = await e.sql("SELECT status FROM test_runs WHERE agent_id = 'teaching_coach'")
        assert [r["status"] for r in rows] == ["failed"]


async def test_daily_run_limit_for_everyone(env) -> None:
    """Ревью R1-11: не больше 20 прогонов в сутки (день — Asia/Tashkent) на все агенты и всех сотрудников →
    429 TEST_RUNS_LIMIT {retry_after}; вчерашние прогоны не считаются; новый день — снова можно."""
    async def runs(n: int, at: datetime, agent: str = "teaching_coach") -> None:
        for _ in range(n):
            await env.sql("INSERT INTO test_runs (run_id, agent_id, version, status, provider, body_hash, cases_hash, "
                          "started_by, started_at, finished_at) VALUES ($1, $2, 1, 'finished', 'fake', $3, $3, 'x', "
                          "$4, $4)", uuid.uuid4(), agent, "0" * 64, at)

    await runs(5, T0 - timedelta(hours=13))  # 23:00 вчера по Ташкенту (T0 = 12:00, UTC+5) — не в счёт
    await runs(10, T0 - timedelta(hours=11), "teaching_coach")  # 01:00 сегодня
    await runs(9, T0 - timedelta(hours=1), "independent_evaluator")
    r = await env.c.post(env.url("conversation_partner", "versions", 1, "test-runs"), headers=env.h(MANAGER))
    assert r.status_code == 202  # двадцатый за сегодня
    await env.wait_run("conversation_partner", 1, r.json()["run_id"])
    r = await env.c.post(env.url("conversation_partner", "versions", 1, "test-runs"), headers=env.h(MANAGER))
    assert r.status_code == 429 and r.json()["code"] == "TEST_RUNS_LIMIT"
    assert r.json()["details"]["retry_after"] == 12 * 3600  # до полуночи по Ташкенту
    other = await env.c.post(env.url("teaching_coach", "versions", 1, "test-runs"), headers=env.h(METHODIST_2))
    assert other.status_code == 429  # лимит общий: другой агент, другой сотрудник
    env.set_now(datetime(2026, 11, 19, 19, 5, tzinfo=UTC))  # 00:05 следующего дня по Ташкенту
    r = await env.c.post(env.url("conversation_partner", "versions", 1, "test-runs"), headers=env.h(MANAGER))
    assert r.status_code == 202
    await env.wait_run("conversation_partner", 1, r.json()["run_id"])


async def test_emergency_stop_does_not_block_golden_run(env) -> None:
    """Ревью R1-11: аварийная остановка выключает ИИ ученикам, но не проверку версии сотрудником."""
    r = await env.c.post("/admin/v1/ai/emergency-stop", json={"enabled": True, "reason": "Проверка перед включением"},
                         headers=env.h(OPERATIONS))
    assert r.status_code == 200 and r.json()["ai_enabled"] is False
    assert (await env.ok())["reason"] == "ai_disabled"  # ученику — выключено
    run = await env.run_tests("conversation_partner", 1)
    assert run["status"] == "finished" and run["passed_mandatory"] is True and run["failed"] == 0
    order = next(x for x in run["results"] if x["case_id"] == "cp-order-coffee")
    assert order["failures"] == []
    # месячный потолок — учитывается и для прогона
    await env.set_budget(monthly_cap_usd=0)
    await env.price("fake", 1, 1)
    run = await env.run_tests("conversation_partner", 1)
    assert run["passed_mandatory"] is False
    order = next(x for x in run["results"] if x["case_id"] == "cp-order-coffee")
    assert any("budget_exceeded" in f or "status" in f for f in order["failures"]), order


# ---------------------------------------------------------------- CRUD кейсов


async def test_golden_case_crud_and_validation(env) -> None:
    base = env.url("teaching_coach", "golden-cases")
    case = {"title": "Пример на узбекском", "mandatory": False, "checks": [{"kind": "schema_valid"}],
            "input": {"audience": "teens", "context": golden_context("teaching_coach", "tc-simpler-uz")}}
    r = await env.c.post(base, json=case, headers=env.h(MANAGER, **{"Idempotency-Key": "case-create-1"}))
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["case_id"].startswith("teaching-coach-") and created["created_by"] == MANAGER.id
    again = await env.c.post(base, json=case, headers=env.h(MANAGER, **{"Idempotency-Key": "case-create-1"}))
    assert again.json()["case_id"] == created["case_id"] and again.headers["idempotent-replay"] == "true"
    bad = {**case, "input": {"audience": "adults", "context": {"lesson": {}}}}
    r = await env.c.post(base, json=bad, headers=env.h(MANAGER))
    assert r.status_code == 422 and r.json()["code"] == "GOLDEN_CASE_INVALID"
    assert any(e["path"].startswith("input.context.") for e in r.json()["details"]["errors"])
    r = await env.c.post(base, json={**case, "checks": [{"kind": "field_equals", "path": "$result.status",
                                                          "value": "ok"}]}, headers=env.h(MANAGER))
    assert r.status_code == 422
    r = await env.c.post(env.url("error_analyst", "golden-cases"), json=case, headers=env.h(MANAGER))
    assert r.status_code == 409 and r.json()["code"] == "AGENT_NOT_LLM"
    cid = created["case_id"]
    r = await env.c.patch(f"/admin/v1/ai/golden-cases/{cid}", json={"mandatory": True, "title": "Обязательный"},
                          headers=env.h(MANAGER))
    assert r.status_code == 200 and r.json()["mandatory"] is True and r.json()["title"] == "Обязательный"
    r = await env.c.patch(f"/admin/v1/ai/golden-cases/{cid}", json={"checks": [{"kind": "nope"}]},
                          headers=env.h(MANAGER))
    assert r.status_code == 422
    r = await env.c.patch(f"/admin/v1/ai/golden-cases/{cid}", json={"title": None}, headers=env.h(MANAGER))
    assert r.status_code == 422
    listed = (await env.c.get(base, params={"limit": 2}, headers=env.h(ANALYST))).json()
    assert len(listed["items"]) == 2 and listed["next_cursor"]
    rest = (await env.c.get(base, params={"limit": 2, "cursor": listed["next_cursor"]},
                            headers=env.h(ANALYST))).json()
    assert len(rest["items"]) == 2 and rest["next_cursor"] is None
    assert (await env.c.delete(f"/admin/v1/ai/golden-cases/{cid}", headers=env.h(MANAGER))).status_code == 204
    assert (await env.c.delete(f"/admin/v1/ai/golden-cases/{cid}", headers=env.h(MANAGER))).status_code == 204
    r = await env.c.patch(f"/admin/v1/ai/golden-cases/{cid}", json={"mandatory": False}, headers=env.h(MANAGER))
    assert r.status_code == 409 and r.json()["code"] == "GOLDEN_CASE_ARCHIVED"
    active = (await env.c.get(base, headers=env.h(ANALYST))).json()["items"]
    every = (await env.c.get(base, params={"include_archived": True}, headers=env.h(ANALYST))).json()["items"]
    assert len(active) == 3 and len(every) == 4
    r = await env.c.patch("/admin/v1/ai/golden-cases/no-such-case", json={"mandatory": True}, headers=env.h(MANAGER))
    assert r.status_code == 404 and r.json()["code"] == "GOLDEN_CASE_NOT_FOUND"
    actions = [a["action"] for a in (await env.audit("ai.golden_case_created"))
               + (await env.audit("ai.golden_case_updated")) + (await env.audit("ai.golden_case_archived"))]
    assert actions == ["ai.golden_case_created", "ai.golden_case_updated", "ai.golden_case_archived"]
