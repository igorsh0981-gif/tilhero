"""Вызов агента (INTERNAL_API §1.2, AT-50): ok, идемпотентность, дети, ИИ выключен, канарейка, доступ, учёт без текстов.
Провайдер — fake (детерминированный, стоимость 0)."""

from __future__ import annotations

import uuid

import pytest
from gw_kit import OPERATIONS, PUBLISHER, cp_context, ie_context, tc_context

from tilhero_ai_gateway.domain.invoke import canary_bucket

AGENTS = ("conversation_partner", "teaching_coach", "independent_evaluator")
RESULT_KEYS = {"status", "reason", "output", "agent_id", "agent_version", "prompt_version", "schema_version",
               "model_id", "canary", "cost_usd", "latency_ms", "warnings"}


@pytest.mark.parametrize("agent_id", AGENTS)
async def test_invoke_ok_with_fake_provider(env, agent_id: str) -> None:
    res = await env.ok(agent_id)
    assert set(res) == RESULT_KEYS
    assert (res["status"], res["reason"], res["agent_id"]) == ("ok", None, agent_id)
    assert res["agent_version"] == 1 and res["prompt_version"] == f"{agent_id}@1"
    assert res["schema_version"] == f"{agent_id}.v1" and res["model_id"] == "fake"
    assert res["canary"] is False and res["cost_usd"] == 0 and res["warnings"] == []
    assert isinstance(res["output"], dict)
    rows = await env.usage()
    assert len(rows) == 1 and rows[0]["status"] == "ok" and rows[0]["attempts"] == 1
    assert rows[0]["caller"] == "lessons" and rows[0]["provider"] == "fake"


async def test_conversation_partner_output(env) -> None:
    res = await env.ok("conversation_partner", cp_context("Can I have a cappuccino, please?"))
    assert res["output"]["intent"] == "order_coffee"
    res = await env.ok("conversation_partner", cp_context("purple elephant", attempts=1))
    assert res["output"] == {"intent": "unclear", "reply_en": "Sorry, I didn't catch that. Could you say it again?",
                             "hint_offered": True}


async def test_evaluator_output_and_assessment_caller(env) -> None:
    res = await env.ok("independent_evaluator", ie_context("I am agree with you.", "He go to school."),
                       caller="assessment")
    out = res["output"]
    assert out["status"] == "ok" and out["cefr_certificate"] is False and out["pronunciation_score"] is None
    assert [(e["turn_id"], e["evidence"], e["correction"]) for e in out["confirmed_errors"]] == [
        ("T1", "I am agree", "I agree"), ("T2", "He go", "He goes")]
    assert out["scores"]["task"] == 3 and out["scores"]["pronunciation"] is None


async def test_idempotent_by_request_id(env) -> None:
    rid, uid, sid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    first = await env.invoke(request_id=rid, user_id=uid, session_id=sid)
    second = await env.invoke(request_id=rid, user_id=uid, session_id=sid)
    assert first.status_code == second.status_code == 200
    assert second.json() == first.json() and second.headers.get("idempotent-replay") == "true"
    assert len(await env.usage()) == 1
    other = await env.invoke(context=cp_context("A cup of tea, please"), request_id=rid, user_id=uid, session_id=sid)
    assert other.status_code == 422 and other.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    # другой вызывающий — своё пространство request_id
    r = await env.invoke(request_id=rid, user_id=uid, session_id=sid, caller="assessment")
    assert r.status_code == 200 and r.headers.get("idempotent-replay") is None


@pytest.mark.parametrize("agent_id", ["conversation_partner", "independent_evaluator"])
async def test_kids_refused_for_free_text_agents(env, agent_id: str) -> None:
    res = await env.ok(agent_id, audience="kids")
    assert (res["status"], res["reason"], res["output"]) == ("refused", "kids_not_allowed", None)
    assert res["cost_usd"] == 0 and res["agent_version"] is None
    rows = await env.usage()
    assert rows[0]["status"] == "refused" and rows[0]["reason"] == "kids_not_allowed" and rows[0]["attempts"] == 0


@pytest.mark.parametrize("claims", [{"age_band": "6-9"}, {"age_band": "10-13"}, {"lrn": None}])
async def test_kids_refused_by_token_claims_regardless_of_body(env, claims) -> None:
    """Детский профиль по claims токена (lrn ≠ sub или age_band 6–13) — отказ, даже если тело говорит adults."""
    learner = uuid.uuid4()
    account = uuid.uuid4()
    if "lrn" in claims:
        claims = {"lrn": str(learner)}
        res = await env.ok("conversation_partner", user_id=learner, subject=str(account), claims=claims)
    else:
        res = await env.ok("conversation_partner", user_id=learner, subject=str(learner), claims=claims)
    assert (res["status"], res["reason"]) == ("refused", "kids_not_allowed")


async def test_teaching_coach_allowed_for_kids(env) -> None:
    """teaching_coach не принимает текст ученика — ребёнку разрешён (lessons его детям не вызывает)."""
    res = await env.ok("teaching_coach", tc_context("uz"), audience="kids")
    assert res["status"] == "ok" and res["output"]["explanation"].startswith("Misolga")


async def test_emergency_stop_makes_ai_disabled(env) -> None:
    r = await env.c.post("/admin/v1/ai/emergency-stop", json={"enabled": True, "reason": "Авария провайдера"},
                         headers=env.h(OPERATIONS))
    assert r.status_code == 200 and r.json()["ai_enabled"] is False
    for agent_id in AGENTS:
        res = await env.ok(agent_id)
        assert (res["status"], res["reason"], res["output"], res["cost_usd"]) == (
            "unavailable", "ai_disabled", None, 0)
    r = await env.c.post("/admin/v1/ai/emergency-stop", json={"enabled": False, "reason": "Провайдер восстановлен"},
                         headers=env.h(OPERATIONS))
    assert r.json()["ai_enabled"] is True
    assert (await env.ok())["status"] == "ok"
    audit = await env.audit("ai.emergency_stop")
    assert [a["after"]["ai_enabled"] for a in audit] == [False, True]


async def test_learner_mismatch_and_validation(env) -> None:
    learner = uuid.uuid4()
    r = await env.invoke(user_id=uuid.uuid4(), subject=str(learner))
    assert r.status_code == 403 and r.json()["code"] == "USER_CONTEXT_MISMATCH"
    assert (await env.invoke(user_id=learner, subject=str(learner))).status_code == 200
    assert (await env.invoke(user_id=learner, subject=str(uuid.uuid4()), claims={"lrn": str(learner)})).json()[
        "reason"] == "kids_not_allowed"  # lrn ≠ sub — детский профиль
    calls = len(await env.usage())
    bad = cp_context()
    bad["node"]["transitions"][0]["intent"] = "unclear"
    r = await env.invoke(context=bad)
    assert r.status_code == 422 and r.json()["code"] == "CONTEXT_INVALID"
    r = await env.invoke("teaching_coach", context=cp_context())
    assert r.status_code == 422 and r.json()["code"] == "CONTEXT_INVALID"
    body = env.body()
    body["extra"] = 1
    r = await env.c.post("/internal/v1/agents/conversation_partner/invoke", json=body, headers=env.svc())
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"
    body = env.body()
    body["session_kind"] = "golden"
    r = await env.c.post("/internal/v1/agents/conversation_partner/invoke", json=body, headers=env.svc())
    assert r.status_code == 422
    assert len(await env.usage()) == calls  # отклонённые проверкой входа вызовы не учитываются


async def test_unknown_and_inactive_agents_404(env) -> None:
    for agent_id, code in (("nope", "AGENT_NOT_FOUND"), ("learning_orchestrator", "AGENT_NOT_ACTIVE"),
                           ("spaced_repetition_coach", "AGENT_NOT_ACTIVE"), ("safety_quality_gate",
                                                                              "AGENT_NOT_ACTIVE")):
        body = env.body(context={"x": 1})
        r = await env.c.post(f"/internal/v1/agents/{agent_id}/invoke", json=body,
                             headers=env.svc(subject=body["user_id"]))
        assert r.status_code == 404 and r.json()["code"] == code, agent_id


async def test_invoke_callers(env) -> None:
    body = env.body()
    r = await env.c.post("/internal/v1/agents/conversation_partner/invoke", json=body)
    assert r.status_code == 401 and r.json()["code"] == "INTERNAL_TOKEN_MISSING"
    for caller in ("telegram-bff", "admin-bff", "learning-plan", "catalog", "diagnostics"):
        r = await env.c.post("/internal/v1/agents/conversation_partner/invoke", json=env.body(),
                             headers=env.svc(caller))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", caller
    for caller in ("lessons", "assessment"):
        body = env.body()
        r = await env.c.post("/internal/v1/agents/conversation_partner/invoke", json=body,
                             headers=env.svc(caller, body["user_id"]))
        assert r.status_code == 200, caller
        # ревью R1-07: токен вызывающего без ученика (`sub`) — 401, а не пропуск проверки ученика
        r = await env.c.post("/internal/v1/agents/conversation_partner/invoke", json=env.body(),
                             headers=env.svc(caller))
        assert r.status_code == 401 and r.json()["code"] == "USER_CONTEXT_REQUIRED", caller
        # lrn без sub тоже не спасает
        r = await env.c.post("/internal/v1/agents/conversation_partner/invoke", json=body,
                             headers=env.svc(caller, None, lrn=body["user_id"]))
        assert r.status_code == 401, caller
    assert len(await env.usage()) == 2  # отклонённые проверкой ученика вызовы не учитываются


async def test_no_published_version_refused_agent_not_active(env) -> None:
    await env.sql("UPDATE agent_rollout SET published_version = NULL WHERE agent_id = 'teaching_coach'")
    res = await env.ok("teaching_coach")
    assert (res["status"], res["reason"]) == ("refused", "agent_not_active")


async def test_usage_has_no_texts(env) -> None:
    secret_turn = "My phone is +998 90 123 45 67 and my name is Dilnoza"
    await env.ok("conversation_partner", cp_context(secret_turn))
    rows = await env.sql("SELECT row_to_json(u)::text AS j FROM usage u")
    assert rows and all("Dilnoza" not in r["j"] and "998" not in r["j"] for r in rows)
    outbox = await env.sql("SELECT envelope::text AS e FROM outbox")
    assert all("Dilnoza" not in r["e"] for r in outbox)


async def test_canary_share_is_deterministic(env) -> None:
    v = await env.tested_draft("conversation_partner", {"temperature": 0.1})
    r = await env.c.put(env.url("conversation_partner", "canary"),
                        json={"version": v["version"], "percent": 30, "reason": "Канарейка 30 %"},
                        headers=env.h(PUBLISHER))
    assert r.status_code == 200, r.text
    users = [uuid.uuid4() for _ in range(60)]
    expected = {u for u in users if canary_bucket(str(u), "conversation_partner") < 30}
    assert 0 < len(expected) < len(users)
    for u in users:
        res = await env.ok("conversation_partner", user_id=u)
        assert res["canary"] is (u in expected)
        assert res["agent_version"] == (v["version"] if u in expected else 1)
        again = await env.ok("conversation_partner", user_id=u)
        assert again["canary"] is res["canary"]  # одна и та же доля на каждый вызов
    rows = await env.sql("SELECT count(*) AS n FROM usage WHERE canary")
    assert rows[0]["n"] == 2 * len(expected)
