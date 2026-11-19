"""Admin API ai-gateway (admin.ts «ИИ, контроль диалогов, затраты»; AT-49, AT-51): реестр, черновики и конфликты,
канарейка, публикация канареечной, откат, модели и цены, бюджет, затраты и вызовы сессии, провайдер."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from conftest import make_env
from gw_kit import ANALYST, CP_OK, DASHBOARD, MANAGER, OPERATIONS, PRICING, PUBLISHER, QA, T0, ScriptedProvider

from tilhero_ai_gateway.domain.invoke import canary_bucket
from tilhero_ai_gateway.providers import ProviderError


async def test_registry_of_17_agents(env) -> None:
    await env.ok("conversation_partner")
    await env.ok("conversation_partner", audience="kids")
    await env.run_tests("teaching_coach", 1)  # золотые вызовы не входят в calls_7d
    items = (await env.c.get("/admin/v1/ai/agents", headers=env.h(ANALYST))).json()["items"]
    assert len(items) == 17
    by_id = {a["agent_id"]: a for a in items}
    cp = by_id["conversation_partner"]
    assert cp["published"]["version"] == 1 and cp["published"]["model_id"] == "claude-haiku-5-5"
    assert cp["published"]["published_by"] == "00000000-0000-4000-a000-000000005eed"
    assert cp["calls_7d"] == 2 and cp["unavailable_pct_7d"] == 0.0 and cp["draft_version"] is None
    assert by_id["teaching_coach"]["calls_7d"] == 0 and by_id["teaching_coach"]["last_test_run"]["provider"] == "fake"
    orchestrator = by_id["learning_orchestrator"]
    assert (orchestrator["implementation"], orchestrator["implemented_in"], orchestrator["rollout"],
            orchestrator["published"], orchestrator["unavailable_pct_7d"]) == ("code", "lessons", None, None, None)
    planned = by_id["duel_host"]
    assert planned["availability"] == "planned" and planned["planned_sprint"] == 7 and planned["rollout"] is not None
    r = await env.c.get("/admin/v1/ai/agents/nope", headers=env.h(ANALYST))
    assert r.status_code == 404 and r.json()["code"] == "AGENT_NOT_FOUND"


async def test_draft_lifecycle_and_conflicts(env) -> None:
    v = await env.draft("conversation_partner")
    assert (v["version"], v["status"], v["author_id"], v["canary"]) == (2, "draft", MANAGER.id, False)
    published = (await env.c.get(env.url("conversation_partner", "versions", 1), headers=env.h(ANALYST))).json()
    assert v["instructions"] == published["instructions"] and v["output_schema"] == published["output_schema"]
    r = await env.c.post(env.url("conversation_partner", "versions"), headers=env.h(MANAGER))
    assert r.status_code == 409 and r.json()["code"] == "DRAFT_EXISTS" and r.json()["details"]["version"] == 2
    # If-Match обязателен и сверяется с updated_at
    r = await env.patch("conversation_partner", 2, {"temperature": 0.5}, None)
    assert r.status_code == 428 and r.json()["code"] == "IF_MATCH_REQUIRED"
    r = await env.patch("conversation_partner", 2, {"temperature": 0.5}, "2020-01-01T00:00:00.000Z")
    assert r.status_code == 409 and r.json()["code"] == "VERSION_CONFLICT"
    env.set_now(T0 + timedelta(minutes=1))
    r = await env.patch("conversation_partner", 2, {"temperature": 0.5, "notes": "Теплее"}, f'"{v["updated_at"]}"')
    assert r.status_code == 200, r.text
    updated = r.json()
    assert updated["temperature"] == 0.5 and updated["notes"] == "Теплее" and updated["updated_at"] != v["updated_at"]
    r = await env.patch("conversation_partner", 2, {"rules": "x"}, v["updated_at"])  # устаревший updated_at
    assert r.status_code == 409 and r.json()["details"]["updated_at"] == updated["updated_at"]
    for change, path in (({"output_schema": {"type": "object", "oneOf": []}}, "output_schema"),
                         ({"model_id": "gpt-4o"}, "model_id"),
                         ({"fallback_model_id": "claude-haiku-5-5"}, "fallback_model_id"),
                         ({"instructions": None}, "instructions")):
        r = await env.patch("conversation_partner", 2, change, updated["updated_at"])
        assert r.status_code == 422 and r.json()["code"] == "VERSION_INVALID", change
        assert r.json()["details"]["errors"][0]["path"] == path
    for change in ({"temperature": 2}, {"max_output_tokens": 2001}, {"timeout_ms": 1999}, {"unknown": 1},
                   {"instructions": "x" * 20_001}):
        r = await env.patch("conversation_partner", 2, change, updated["updated_at"])
        assert r.status_code == 422, change
    same = await env.patch("conversation_partner", 2, {"temperature": 0.5}, updated["updated_at"])
    assert same.status_code == 200 and same.json()["updated_at"] == updated["updated_at"]  # без изменений
    r = await env.patch("conversation_partner", 1, {"temperature": 0.1}, published["updated_at"])
    assert r.status_code == 409 and r.json()["code"] == "VERSION_NOT_DRAFT"
    r = await env.c.delete(env.url("conversation_partner", "versions", 1), headers=env.h(MANAGER))
    assert r.status_code == 409 and r.json()["code"] == "VERSION_NOT_DRAFT"
    assert (await env.c.delete(env.url("conversation_partner", "versions", 2), headers=env.h(MANAGER))).status_code \
        == 204
    assert (await env.c.get(env.url("conversation_partner", "versions", 2), headers=env.h(ANALYST))).status_code \
        == 404
    v3 = await env.draft("conversation_partner", from_version=1)
    assert v3["version"] == 2  # номер удалённого черновика освобождён
    audit = [a["action"] for a in await env.audit("ai.version_created")] + \
        [a["action"] for a in await env.audit("ai.version_updated")] + \
        [a["action"] for a in await env.audit("ai.version_deleted")]
    assert audit == ["ai.version_created", "ai.version_created", "ai.version_updated", "ai.version_deleted"]
    upd = (await env.audit("ai.version_updated"))[0]
    assert upd["after"]["fields"] == ["notes", "temperature"] and "instructions" not in str(upd)
    r = await env.c.post(env.url("safety_quality_gate", "versions"), headers=env.h(MANAGER))
    assert r.status_code == 409 and r.json()["code"] == "AGENT_NOT_LLM"


async def test_canary_publish_and_rollback(env) -> None:
    v = await env.tested_draft("conversation_partner", {"temperature": 0.2})
    url = env.url("conversation_partner", "canary")
    for percent in (0, 51):
        r = await env.c.put(url, json={"version": v["version"], "percent": percent, "reason": "Канарейка"},
                            headers=env.h(PUBLISHER))
        assert r.status_code == 422, percent
    r = await env.c.put(url, json={"version": 1, "percent": 10, "reason": "Канарейка"}, headers=env.h(PUBLISHER))
    assert r.status_code == 409 and r.json()["code"] == "VERSION_NOT_DRAFT"
    r = await env.c.request("DELETE", url, json={"reason": "Снять"}, headers=env.h(PUBLISHER))
    assert r.status_code == 409 and r.json()["code"] == "NO_CANARY"
    r = await env.c.put(url, json={"version": v["version"], "percent": 20, "reason": "Канарейка 20 %"},
                        headers=env.h(PUBLISHER))
    assert r.status_code == 200, r.text
    assert r.json()["rollout"] == {"agent_id": "conversation_partner", "published_version": 1,
                                   "canary_version": v["version"], "canary_percent": 20, "previous_version": None}
    # черновик под канарейкой заморожен
    r = await env.patch("conversation_partner", v["version"], {"temperature": 0.9}, v["updated_at"])
    assert r.status_code == 409 and r.json()["code"] == "VERSION_IN_CANARY"
    r = await env.c.delete(env.url("conversation_partner", "versions", v["version"]), headers=env.h(MANAGER))
    assert r.status_code == 409 and r.json()["code"] == "VERSION_IN_CANARY"
    detail = await env.agent("conversation_partner")
    assert [x["canary"] for x in detail["versions"]] == [True, False]
    # смена доли той же канарейки
    r = await env.c.put(url, json={"version": v["version"], "percent": 50, "reason": "Шире"}, headers=env.h(PUBLISHER))
    assert r.json()["rollout"]["canary_percent"] == 50
    learner = next(u for u in (uuid.uuid4() for _ in range(500))
                   if canary_bucket(str(u), "conversation_partner") < 50)
    assert (await env.ok(user_id=learner))["agent_version"] == v["version"]
    # снять и вернуть
    r = await env.c.request("DELETE", url, json={"reason": "Снять канарейку"}, headers=env.h(PUBLISHER))
    assert r.status_code == 200 and r.json()["rollout"]["canary_version"] is None
    assert (await env.ok(user_id=learner))["agent_version"] == 1
    r = await env.c.put(url, json={"version": v["version"], "percent": 10, "reason": "Снова"}, headers=env.h(PUBLISHER))
    assert r.status_code == 200
    # публикация канареечной делает её основной
    r = await env.publish("conversation_partner", v["version"])
    assert r.status_code == 200, r.text
    assert r.json()["rollout"] == {"agent_id": "conversation_partner", "published_version": v["version"],
                                   "canary_version": None, "canary_percent": 0, "previous_version": 1}
    assert (await env.ok())["agent_version"] == v["version"]
    # откат возвращает прежнюю, повторный откат — снова новую
    r = await env.c.post(env.url("conversation_partner", "rollback"), json={"reason": "Регрессия"},
                         headers=env.h(PUBLISHER))
    assert r.status_code == 200 and r.json()["rollout"]["published_version"] == 1
    assert r.json()["rollout"]["previous_version"] == v["version"]
    assert r.json()["published"]["published_by"] == PUBLISHER.id
    assert (await env.ok())["agent_version"] == 1
    statuses = await env.sql("SELECT version, status FROM agent_versions WHERE agent_id = 'conversation_partner' "
                             "ORDER BY version")
    assert [(s["version"], s["status"]) for s in statuses] == [(1, "published"), (v["version"], "archived")]
    actions = []
    for name in ("ai.canary_set", "ai.canary_cleared", "ai.version_published", "ai.rolled_back"):
        actions.extend((name, a["reason"]) for a in await env.audit(name))
    assert [a for a, _ in actions].count("ai.canary_set") == 3 and all(reason for _, reason in actions)


async def test_rollback_without_previous_and_canary_without_published(env) -> None:
    r = await env.c.post(env.url("teaching_coach", "rollback"), json={"reason": "Откат"}, headers=env.h(PUBLISHER))
    assert r.status_code == 409 and r.json()["code"] == "NO_PREVIOUS_VERSION"
    v = await env.tested_draft("teaching_coach")
    await env.sql("UPDATE agent_rollout SET published_version = NULL WHERE agent_id = 'teaching_coach'")
    r = await env.c.put(env.url("teaching_coach", "canary"),
                        json={"version": v["version"], "percent": 5, "reason": "Канарейка"}, headers=env.h(PUBLISHER))
    assert r.status_code == 409 and r.json()["code"] == "NO_PUBLISHED_VERSION"


async def test_rollback_clears_canary(env) -> None:
    v2 = await env.tested_draft("teaching_coach")
    assert (await env.publish("teaching_coach", v2["version"])).status_code == 200
    v3 = await env.tested_draft("teaching_coach", {"temperature": 0.1})
    r = await env.c.put(env.url("teaching_coach", "canary"),
                        json={"version": v3["version"], "percent": 25, "reason": "Канарейка"}, headers=env.h(PUBLISHER))
    assert r.status_code == 200
    r = await env.c.post(env.url("teaching_coach", "rollback"), json={"reason": "Регрессия v2"},
                         headers=env.h(PUBLISHER))
    assert r.status_code == 200
    assert r.json()["rollout"] == {"agent_id": "teaching_coach", "published_version": 1, "canary_version": None,
                                   "canary_percent": 0, "previous_version": v2["version"]}
    assert r.json()["draft_version"] == v3["version"]  # черновик остаётся черновиком
    audit = await env.audit("ai.rolled_back")
    assert audit[0]["before"]["canary_version"] == v3["version"]


async def test_models_and_prices(env) -> None:
    items = (await env.c.get("/admin/v1/ai/models", headers=env.h(ANALYST))).json()["items"]
    assert [(m["model_id"], m["input_usd_per_mtok"], m["output_usd_per_mtok"]) for m in items] == [
        ("claude-haiku-5-5", 0.1, 0.5), ("claude-sonnet-5-5", 2.0, 10.0), ("fake", 0.0, 0.0)]
    body = {"input_usd_per_mtok": 0.12, "output_usd_per_mtok": 0.6, "active": True, "reason": "Новый прайс"}
    r = await env.c.put("/admin/v1/ai/models/claude-haiku-5-5", json=body, headers=env.h(PUBLISHER))
    assert r.status_code == 200 and r.json()["input_usd_per_mtok"] == 0.12
    r = await env.c.put("/admin/v1/ai/models/claude-haiku-5-5", json={**body, "active": False},
                        headers=env.h(PUBLISHER))
    assert r.status_code == 409 and r.json()["code"] == "MODEL_IN_USE"
    assert "conversation_partner@1" in r.json()["details"]["versions"]
    r = await env.c.put("/admin/v1/ai/models/gpt-4o", json=body, headers=env.h(PUBLISHER))
    assert r.status_code == 404 and r.json()["code"] == "MODEL_NOT_FOUND"
    r = await env.c.put("/admin/v1/ai/models/fake", json={**body, "input_usd_per_mtok": -1}, headers=env.h(PUBLISHER))
    assert r.status_code == 422
    audit = await env.audit("ai.model_updated")
    assert audit[0]["before"]["input_usd_per_mtok"] == "0.1000" and audit[0]["after"]["input_usd_per_mtok"] == "0.1200"


async def test_model_price_rules(env) -> None:
    """Ревью R1-12: у модели anthropic цены > 0 (422 PRICE_REQUIRED); снизить цену может только сотрудник с
    costs.manage (ai.publish мало — 403); повысить — ai.publish; у fake цена может быть 0."""
    url = "/admin/v1/ai/models/claude-haiku-5-5"
    body = {"input_usd_per_mtok": 0.1, "output_usd_per_mtok": 0.5, "active": True, "reason": "Прайс провайдера"}
    for bad in ({"input_usd_per_mtok": 0}, {"output_usd_per_mtok": 0}, {"input_usd_per_mtok": 0,
                                                                       "output_usd_per_mtok": 0}):
        r = await env.c.put(url, json={**body, **bad}, headers=env.h(PRICING))
        assert r.status_code == 422 and r.json()["code"] == "PRICE_REQUIRED", bad
        assert set(r.json()["details"]["fields"]) == set(bad)
    r = await env.c.put(url, json={**body, "input_usd_per_mtok": 0.05}, headers=env.h(PUBLISHER))
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    assert r.json()["details"]["permission"] == "costs.manage"
    r = await env.c.put(url, json={**body, "output_usd_per_mtok": 0.4}, headers=env.h(PUBLISHER))
    assert r.status_code == 403
    r = await env.c.put(url, json={**body, "input_usd_per_mtok": 0.2}, headers=env.h(PUBLISHER))
    assert r.status_code == 200 and r.json()["input_usd_per_mtok"] == 0.2  # повышение — ai.publish
    r = await env.c.put(url, json={**body, "input_usd_per_mtok": 0.05}, headers=env.h(PRICING))
    assert r.status_code == 200 and r.json()["input_usd_per_mtok"] == 0.05
    r = await env.c.put(url, json={**body, "input_usd_per_mtok": 0.05}, headers=env.h(OPERATIONS))
    assert r.status_code == 403 and r.json()["details"]["permission"] == "ai.publish"  # costs.manage без ai.publish
    r = await env.c.put("/admin/v1/ai/models/fake", json={**body, "input_usd_per_mtok": 0, "output_usd_per_mtok": 0},
                        headers=env.h(PUBLISHER))
    assert r.status_code == 200  # fake — без цены
    rows = await env.sql("SELECT input_usd_per_mtok FROM models WHERE model_id = 'claude-haiku-5-5'")
    assert str(rows[0]["input_usd_per_mtok"]) == "0.0500"
    assert len(await env.audit("ai.model_updated")) == 3


async def test_model_price_drives_cost(env) -> None:
    await env.price("fake", 1, 1)
    res = await env.ok()
    assert res["cost_usd"] > 0
    row = (await env.usage())[-1]
    assert row["cost_usd"] > 0 and row["model_id"] == "fake"


async def test_budget_get_update_conflict(env) -> None:
    b = (await env.c.get("/admin/v1/ai/budget", headers=env.h(OPERATIONS))).json()
    assert b == {"ai_enabled": True, "monthly_cap_usd": 20.0, "learner_daily_cap_usd": 0.05, "lesson_cap_usd": 0.03,
                 "alert_percent": 80, "updated_at": b["updated_at"]}
    body = {"monthly_cap_usd": 25, "learner_daily_cap_usd": 0.04, "lesson_cap_usd": 0.02, "alert_percent": 90,
            "updated_at": b["updated_at"], "reason": "Пересмотр лимитов"}
    env.set_now(T0 + timedelta(minutes=5))
    r = await env.c.put("/admin/v1/ai/budget", json=body, headers=env.h(OPERATIONS))
    assert r.status_code == 200 and r.json()["monthly_cap_usd"] == 25.0 and r.json()["alert_percent"] == 90
    r = await env.c.put("/admin/v1/ai/budget", json=body, headers=env.h(OPERATIONS))  # updated_at устарел
    assert r.status_code == 409 and r.json()["code"] == "BUDGET_CONFLICT"
    for bad in ({"alert_percent": 0}, {"monthly_cap_usd": -1}, {"lesson_cap_usd": 5000}, {"reason": ""}):
        r = await env.c.put("/admin/v1/ai/budget", json={**body, "updated_at": None, **bad}, headers=env.h(OPERATIONS))
        assert r.status_code == 422, bad
    r = await env.c.put("/admin/v1/ai/budget", json={**body, "updated_at": None, "ai_enabled": False},
                        headers=env.h(OPERATIONS))
    assert r.status_code == 200 and r.json()["ai_enabled"] is False
    assert len(await env.audit("ai.budget_updated")) == 1
    assert [a["after"] for a in await env.audit("ai.emergency_stop")] == [{"ai_enabled": False}]


async def test_usage_summary_and_calls(env) -> None:
    await env.price("fake", 1, 1)
    lesson = uuid.uuid4()
    await env.ok(session_id=lesson)
    await env.ok("teaching_coach", session_id=lesson)
    await env.ok(audience="kids")
    await env.sql("UPDATE budget SET ai_enabled = false")
    await env.ok()
    await env.sql("UPDATE budget SET ai_enabled = true")
    env.set_now(T0 - timedelta(days=2))
    await env.ok(session_id=uuid.uuid4())
    env.set_now(T0)
    await env.run_tests("teaching_coach", 1)
    month = (await env.c.get("/admin/v1/ai/usage/summary", params={"period": "month"},
                             headers=env.h(OPERATIONS))).json()
    rows = await env.sql("SELECT sum(cost_usd) AS s FROM usage")
    assert month["spent_usd"] == pytest.approx(float(rows[0]["s"]))
    assert month["calls"] == 5 and month["unavailable"] == 1 and month["unavailable_pct"] == 20.0
    assert month["cap_used_pct"] == pytest.approx(round(float(rows[0]["s"]) * 100 / 20, 1))
    assert {a["agent_id"]: a["calls"] for a in month["by_agent"]} == {"conversation_partner": 4,
                                                                      "teaching_coach": 1}
    assert [m["model_id"] for m in month["by_model"]] == ["fake"]
    assert len(month["by_day"]) == 19 and month["by_day"][-1]["date"] == "2026-11-19"
    assert month["by_day"][-3]["calls"] == 1 and month["by_day"][-1]["calls"] == 4
    assert month["p95_latency_ms"] is not None and month["ai_enabled"] is True and month["alert_percent"] == 80
    assert month["avg_cost_per_lesson_usd"] > 0
    day = (await env.c.get("/admin/v1/ai/usage/summary", params={"period": "day"},
                           headers=env.h(DASHBOARD))).json()
    assert day["calls"] == 4 and len(day["by_day"]) == 1
    week = (await env.c.get("/admin/v1/ai/usage/summary", params={"period": "week"}, headers=env.h(OPERATIONS))).json()
    assert len(week["by_day"]) == 7 and week["calls"] == 5
    r = await env.c.get("/admin/v1/ai/usage/summary", params={"period": "year"}, headers=env.h(OPERATIONS))
    assert r.status_code == 422
    # вызовы сессии — для карточки «Контроля диалогов» (qa.read)
    calls = (await env.c.get("/admin/v1/ai/usage", params={"session_id": str(lesson)}, headers=env.h(QA))).json()
    assert [c["agent_id"] for c in calls["items"]] == ["teaching_coach", "conversation_partner"]
    assert all("user_id" not in c for c in calls["items"])
    r = await env.c.get("/admin/v1/ai/usage", params={"agent_id": "conversation_partner"}, headers=env.h(QA))
    assert r.status_code == 403  # без session_id — только costs.read
    page = (await env.c.get("/admin/v1/ai/usage", params={"limit": 3}, headers=env.h(OPERATIONS))).json()
    assert len(page["items"]) == 3 and page["next_cursor"]
    rest = (await env.c.get("/admin/v1/ai/usage", params={"limit": 50, "cursor": page["next_cursor"]},
                            headers=env.h(OPERATIONS))).json()
    assert rest["next_cursor"] is None
    ids = [c["call_id"] for c in page["items"] + rest["items"]]
    assert len(ids) == len(set(ids)) == len(await env.usage())
    r = await env.c.get("/admin/v1/ai/usage", params={"cursor": "%%%"}, headers=env.h(OPERATIONS))
    assert r.status_code == 400 and r.json()["code"] == "INVALID_CURSOR"


async def test_summary_month_boundary_and_cap(env) -> None:
    await env.sql("INSERT INTO usage (call_id, request_id, caller, agent_id, provider, status, cost_usd, session_kind, "
                  "created_at, finished_at) VALUES ($1, $2, 'lessons', 'conversation_partner', 'anthropic', 'ok', 5, "
                  "'lesson', $3, $3)", uuid.uuid4(), uuid.uuid4(), datetime(2026, 10, 31, 23, 0, tzinfo=UTC))
    await env.sql("INSERT INTO usage (call_id, request_id, caller, agent_id, provider, status, cost_usd, session_kind, "
                  "created_at, finished_at) VALUES ($1, $2, 'lessons', 'conversation_partner', 'anthropic', 'ok', 4, "
                  "'lesson', $3, $3)", uuid.uuid4(), uuid.uuid4(), datetime(2026, 11, 1, 0, 30, tzinfo=UTC))
    month = (await env.c.get("/admin/v1/ai/usage/summary", headers=env.h(OPERATIONS))).json()
    assert month["period"] == "month" and month["spent_usd"] == 4.0 and month["cap_used_pct"] == 20.0


async def test_provider_status_fake(env) -> None:
    r = await env.c.get("/admin/v1/ai/provider", headers=env.h(ANALYST))
    assert r.json() == {"provider": "fake", "key_configured": False, "last_error": None, "ai_enabled": True}


async def test_admin_idempotency_replay(env) -> None:
    key = {"Idempotency-Key": "draft-cp-0001"}
    first = await env.c.post(env.url("conversation_partner", "versions"), headers=env.h(MANAGER, **key))
    second = await env.c.post(env.url("conversation_partner", "versions"), headers=env.h(MANAGER, **key))
    assert first.status_code == second.status_code == 201 and second.headers["idempotent-replay"] == "true"
    assert first.json() == second.json()
    stop = {"Idempotency-Key": "stop-0001"}
    body = {"enabled": True, "reason": "Авария"}
    a = await env.c.post("/admin/v1/ai/emergency-stop", json=body, headers=env.h(OPERATIONS, **stop))
    b = await env.c.post("/admin/v1/ai/emergency-stop", json=body, headers=env.h(OPERATIONS, **stop))
    assert a.json() == b.json() and len(await env.audit("ai.emergency_stop")) == 1
    # enabled=true — остановка включена: ИИ выключен; видно и ролям без costs.read (ai.read → provider)
    assert a.json()["ai_enabled"] is False
    assert (await env.c.get("/admin/v1/ai/provider", headers=env.h(ANALYST))).json()["ai_enabled"] is False


async def test_draft_from_version_without_published_and_blank() -> None:
    provider = ScriptedProvider()
    async for e in make_env(provider=provider, seed_dir="/nonexistent"):
        r = await e.c.get("/admin/v1/ai/agents/teaching_coach", headers=e.h(ANALYST))
        assert r.json()["published"] is None and r.json()["versions"] == []
        v = await e.draft("teaching_coach")
        assert v["version"] == 1 and v["instructions"] == "" and v["schema_version"] == "teaching_coach.v1"
        res = await e.ok("teaching_coach")
        assert (res["status"], res["reason"]) == ("refused", "agent_not_active")


async def test_usage_by_session_for_qa_journal() -> None:
    """GET /usage/by-session: модели, оплаченная стоимость и p95 задержки успешных вызовов по сессиям; сессии без
    вызовов — нули; порядок — как в запросе; права qa.read | costs.read; > 50 id — 422."""
    provider = ScriptedProvider(default=(CP_OK, 10_000, 100))
    async for e in make_env(provider=provider):
        lesson, empty, other = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        await e.ok(session_id=lesson)  # haiku: 0.001 + 0.00005
        provider.responses = [ProviderError("http_529")]  # основная падает → резервная sonnet: 0.02 + 0.001
        await e.ok(session_id=lesson)
        await e.ok(session_id=lesson, audience="kids")  # отказ — без модели и стоимости
        await e.ok(session_id=other)
        await e.sql("UPDATE usage SET latency_ms = 100 WHERE session_id = $1 AND model_id = 'claude-haiku-5-5'",
                    lesson)
        await e.sql("UPDATE usage SET latency_ms = 300 WHERE session_id = $1 AND model_id = 'claude-sonnet-5-5'",
                    lesson)
        params = [("session_id", str(empty)), ("session_id", str(lesson)), ("session_id", str(lesson))]
        for actor in (QA, OPERATIONS):
            r = await e.c.get("/admin/v1/ai/usage/by-session", params=params, headers=e.h(actor))
            assert r.status_code == 200, r.text
            assert r.json() == {"items": [
                {"session_id": str(empty), "models": [], "cost_usd": 0.0, "p95_latency_ms": None},
                {"session_id": str(lesson), "models": ["claude-haiku-5-5", "claude-sonnet-5-5"],
                 "cost_usd": pytest.approx(0.02205), "p95_latency_ms": 300}]}
        r = await e.c.get("/admin/v1/ai/usage/by-session", params=params, headers=e.h(DASHBOARD))
        assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
        many = [("session_id", str(uuid.uuid4())) for _ in range(51)]
        r = await e.c.get("/admin/v1/ai/usage/by-session", params=many, headers=e.h(QA))
        assert r.status_code == 422 and r.json()["code"] == "TOO_MANY_SESSIONS"
        r = await e.c.get("/admin/v1/ai/usage/by-session", params=many[:50], headers=e.h(QA))
        assert r.status_code == 200 and len(r.json()["items"]) == 50
        for bad in ([], [("session_id", "not-a-uuid")]):
            r = await e.c.get("/admin/v1/ai/usage/by-session", params=bad, headers=e.h(QA))
            assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"
