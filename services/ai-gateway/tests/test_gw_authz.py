"""Матрица доступа admin API ai-gateway: 401 без токена, 403 чужой вызывающий, 403 без actor, 403 без права
(права проверяются в домене — защита в глубину, даже если admin-bff ошибётся)."""

from __future__ import annotations

import pytest
from gw_kit import ANALYST, OPERATIONS, QA, SUPPORT

RID = "00000000-0000-4000-8000-0000000000aa"
A = "/admin/v1/ai/agents/conversation_partner"
CASE = {"title": "Кейс", "mandatory": False, "checks": [{"kind": "schema_valid"}],
        "input": {"audience": "adults", "context": {}}}
BUDGET = {"monthly_cap_usd": 20, "learner_daily_cap_usd": 0.05, "lesson_cap_usd": 0.03, "alert_percent": 80,
          "speech_monthly_cap_usd": 5,
          "reason": "Лимиты"}

# (метод, путь, тело, право)
ADMIN = [
    ("GET", "/admin/v1/ai/agents", None, "ai.read"),
    ("GET", A, None, "ai.read"),
    ("GET", f"{A}/versions/1", None, "ai.read"),
    ("POST", f"{A}/versions", {}, "ai.manage"),
    ("PATCH", f"{A}/versions/1", {"notes": "x"}, "ai.manage"),
    ("DELETE", f"{A}/versions/1", None, "ai.manage"),
    ("POST", f"{A}/versions/1/test-runs", None, "ai.manage"),
    ("GET", f"{A}/versions/1/test-runs/{RID}", None, "ai.read"),
    ("POST", f"{A}/versions/1/publish", {"reason": "Публикация"}, "ai.publish"),
    ("PUT", f"{A}/canary", {"version": 2, "percent": 5, "reason": "Канарейка"}, "ai.publish"),
    ("DELETE", f"{A}/canary", {"reason": "Снять"}, "ai.publish"),
    ("POST", f"{A}/rollback", {"reason": "Откат"}, "ai.publish"),
    ("GET", f"{A}/golden-cases", None, "ai.read"),
    ("POST", f"{A}/golden-cases", CASE, "ai.manage"),
    ("PATCH", "/admin/v1/ai/golden-cases/cp-order-coffee", {"mandatory": True}, "ai.manage"),
    ("DELETE", "/admin/v1/ai/golden-cases/cp-order-coffee", None, "ai.manage"),
    ("GET", "/admin/v1/ai/models", None, "ai.read"),
    ("PUT", "/admin/v1/ai/models/fake", {"input_usd_per_mtok": 0, "output_usd_per_mtok": 0, "active": True,
                                         "reason": "Цена"}, "ai.publish"),
    ("GET", "/admin/v1/ai/provider", None, "ai.read"),
    ("GET", "/admin/v1/ai/budget", None, "costs.read"),
    ("PUT", "/admin/v1/ai/budget", BUDGET, "costs.manage"),
    ("POST", "/admin/v1/ai/emergency-stop", {"enabled": True, "reason": "Авария"}, "costs.manage"),
    ("GET", "/admin/v1/ai/usage/summary?period=day", None, "costs.read"),
    ("GET", "/admin/v1/ai/usage", None, "costs.read"),
    ("GET", f"/admin/v1/ai/usage?session_id={RID}", None, "costs.read"),
    ("GET", f"/admin/v1/ai/usage/by-session?session_id={RID}", None, "qa.read"),
]


@pytest.mark.parametrize(("method", "path", "body", "permission"), ADMIN, ids=[f"{m} {p}" for m, p, _, _ in ADMIN])
async def test_admin_route_access(env, method: str, path: str, body, permission: str) -> None:
    r = await env.c.request(method, path, json=body)
    assert r.status_code == 401 and r.json()["code"] == "INTERNAL_TOKEN_MISSING"
    for caller in ("lessons", "assessment", "telegram-bff"):
        r = await env.c.request(method, path, json=body, headers=env.svc(caller))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", caller
    r = await env.c.request(method, path, json=body, headers=env.h(None))
    assert r.status_code == 403 and r.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    r = await env.c.request(method, path, json=body, headers=env.h(SUPPORT))
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    assert r.json()["details"]["permission"] == permission


@pytest.mark.parametrize(("method", "path", "body"), [(m, p, b) for m, p, b, perm in ADMIN
                                                       if perm in ("ai.manage", "ai.publish", "costs.manage")])
async def test_read_only_roles_cannot_change(env, method: str, path: str, body) -> None:
    """analyst / qa_analyst (ai.read, qa.read, costs.read) не меняют агентов, модели и бюджет."""
    for actor in (ANALYST, QA):
        r = await env.c.request(method, path, json=body, headers=env.h(actor))
        assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED", actor.role


async def test_actor_only_from_admin_bff(env) -> None:
    """Контекст сотрудника принимается только от admin-bff (подделка actor другим сервисом — 403)."""
    from tilhero_common.testing import internal_headers

    r = await env.c.get("/admin/v1/ai/agents", headers=internal_headers(env.settings, issuer="lessons", actor=ANALYST))
    assert r.status_code == 403


async def test_internal_status_for_domains_only(env) -> None:
    """GET /internal/v1/status — lessons, assessment и memory (спринт 5: + speech_available); аварийная остановка →
    ai_available и speech_available false."""
    assert (await env.c.get("/internal/v1/status")).status_code == 401
    for caller in ("telegram-bff", "admin-bff"):
        r = await env.c.get("/internal/v1/status", headers=env.svc(caller))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", caller
    for caller in ("lessons", "assessment", "memory"):
        r = await env.c.get("/internal/v1/status", headers=env.svc(caller))
        assert r.status_code == 200 and r.json() == {"ai_available": True, "speech_available": True}, caller
    stop = await env.c.post("/admin/v1/ai/emergency-stop", json={"enabled": True, "reason": "Авария"},
                            headers=env.h(OPERATIONS, **{"Idempotency-Key": "stop-status-1"}))
    assert stop.status_code == 200, stop.text
    assert (await env.c.get("/internal/v1/status", headers=env.svc("lessons"))).json() == {
        "ai_available": False, "speech_available": False}
