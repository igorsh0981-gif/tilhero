"""Набор для тестов ai-gateway: сотрудники, контексты агентов, сценарный провайдер, сквозные помощники."""

from __future__ import annotations

import asyncio
import copy
import json
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import asyncpg
import httpx
from sqlalchemy.engine import make_url

from tilhero_ai_gateway.providers import ProviderError, ProviderRequest, ProviderResponse
from tilhero_ai_gateway.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.internal_auth import HEADER, Actor, issue_token
from tilhero_common.messaging import Envelope, InMemoryBus
from tilhero_common.testing import TEST_ADMIN_URL, internal_headers

SEED_DIR = Path(__file__).resolve().parent / "fixtures" / "seed"
T0 = datetime(2026, 11, 19, 7, 0, tzinfo=UTC)  # 12:00 по Ташкенту


def _actor(role: str, *perms: str) -> Actor:
    return Actor(id=str(uuid.uuid4()), role=role, permissions=frozenset(perms))


# PLAN «Права и роли»: methodist — ai.read/manage/publish + qa.*; operations — ai.read, qa.read, costs.*
METHODIST = _actor("methodist", "ai.read", "ai.manage", "ai.publish", "qa.read", "qa.transcripts", "qa.review")
MANAGER = _actor("methodist", "ai.read", "ai.manage")
PUBLISHER = _actor("methodist", "ai.read", "ai.publish")
OPERATIONS = _actor("operations", "ai.read", "qa.read", "costs.read", "costs.manage")
ANALYST = _actor("analyst", "ai.read", "qa.read", "costs.read")
QA = _actor("qa_analyst", "dashboard.read", "content.read", "ai.read", "qa.read", "qa.transcripts")
DASHBOARD = _actor("support_lead", "dashboard.read")
# снижение цены модели — ai.publish + costs.manage (ревью R1-12); у методиста costs.manage нет
PRICING = _actor("super_admin", "ai.read", "ai.publish", "costs.read", "costs.manage")
SUPPORT = _actor("support", "support.reply", "users.read")


def seed_file(*parts: str) -> Any:
    return json.loads((SEED_DIR.joinpath(*parts)).read_text(encoding="utf-8"))


def golden_context(agent_id: str, case_id: str) -> dict[str, Any]:
    for case in seed_file("golden", f"{agent_id}.json"):
        if case["case_id"] == case_id:
            return copy.deepcopy(case["input"]["context"])
    raise KeyError(case_id)


def cp_context(turn: str = "Can I have a cappuccino, please?", *, level: str = "A1",
               attempts: int = 0) -> dict[str, Any]:
    ctx = golden_context("conversation_partner", "cp-order-coffee")
    ctx["learner_turn"] = turn
    ctx["attempts_on_node"] = attempts
    ctx["scenario"]["level"] = level
    return ctx


def tc_context(locale: str = "ru") -> dict[str, Any]:
    ctx = golden_context("teaching_coach", "tc-simpler-ru")
    ctx["explain_locale"] = locale
    return ctx


def ie_context(*learner: str, outcome: str | None = "success", hints: int = 0) -> dict[str, Any]:
    ctx = golden_context("independent_evaluator", "ie-errors")
    turns: list[dict[str, Any]] = []
    for i, text in enumerate(learner, start=1):
        turns.append({"turn_id": f"C{i}", "speaker": "character", "text": "Tell me more."})
        turns.append({"turn_id": f"T{i}", "speaker": "learner", "text": text})
    ctx["turns"] = turns
    ctx["task"]["outcome"] = outcome
    ctx["hint_usage"] = {"count": hints, "turn_ids": []}
    return ctx


CONTEXTS: dict[str, Callable[[], dict[str, Any]]] = {
    "conversation_partner": cp_context, "teaching_coach": tc_context,
    "independent_evaluator": lambda: ie_context("I am agree with you."),
}

CP_OK = json.dumps({"intent": "order_coffee", "reply_en": "Sure! Small or large?", "hint_offered": False})


class ScriptedProvider:
    """Провайдер-сценарий: по очереди отдаёт заданные ответы (текст | (текст, in, out) | исключение | функция).
    name = anthropic — стоимость считается по ценам Claude из таблицы models."""

    name = "anthropic"

    def __init__(self, *responses: Any, ready: bool = True, default: Any = None) -> None:
        self.responses = list(responses)
        self.default = default
        self.calls: list[ProviderRequest] = []
        self._ready = ready

    def ready(self) -> bool:
        return self._ready

    async def complete(self, request: ProviderRequest) -> ProviderResponse:
        self.calls.append(request)
        item = self.responses.pop(0) if self.responses else self.default
        if item is None:
            raise ProviderError("script_exhausted")
        if callable(item) and not isinstance(item, BaseException):
            item = item(request)
            if asyncio.iscoroutine(item):
                item = await item
        if isinstance(item, BaseException):
            raise item
        if isinstance(item, tuple):
            text, tokens_in, tokens_out = item
            return ProviderResponse(text, tokens_in, tokens_out)
        return ProviderResponse(str(item), 1000, 100)

    async def aclose(self) -> None:
        return None


class Env:
    def __init__(self, settings: Settings, client: httpx.AsyncClient, runtime: Runtime, bus: InMemoryBus,
                 schema: str, app: Any) -> None:
        self.settings = settings
        self.c = client
        self.runtime = runtime
        self.bus = bus
        self.schema = schema
        self.app = app
        self.now = T0

    # ---------------------------------------------------------------- часы

    def set_now(self, value: datetime) -> None:
        self.now = value
        self.runtime.clock = lambda: self.now  # type: ignore[attr-defined]

    # ---------------------------------------------------------------- заголовки

    def h(self, actor: Actor | None = None, issuer: str = "admin-bff", **extra: str) -> dict[str, str]:
        return {**internal_headers(self.settings, issuer=issuer, actor=actor), **extra}

    def svc(self, issuer: str = "lessons", subject: str | None = None, **claims: Any) -> dict[str, str]:
        token = issue_token(self.settings.internal_jwt_secret.get_secret_value(), issuer=issuer,
                            audience=self.settings.service_name, subject=subject, extra=claims or None)
        return {HEADER: token}

    # ---------------------------------------------------------------- вызов агента

    def body(self, agent_id: str = "conversation_partner", context: dict[str, Any] | None = None, *,
             user_id: uuid.UUID | str | None = None, session_id: uuid.UUID | str | None = None,
             audience: str = "adults", request_id: uuid.UUID | str | None = None, locale: str = "ru",
             session_kind: str = "lesson") -> dict[str, Any]:
        return {"request_id": str(request_id or uuid.uuid4()), "session_id": str(session_id or uuid.uuid4()),
                "session_kind": session_kind, "user_id": str(user_id or uuid.uuid4()), "audience": audience,
                "locale": locale, "context": context if context is not None else CONTEXTS[agent_id]()}

    async def invoke(self, agent_id: str = "conversation_partner", context: dict[str, Any] | None = None, *,
                     caller: str = "lessons", claims: dict[str, Any] | None = None, subject: str | None = None,
                     **kw: Any) -> httpx.Response:
        """subject по умолчанию — user_id тела (как у lessons и assessment: `sub` = ученик)."""
        body = self.body(agent_id, context, **kw)
        return await self.c.post(f"/internal/v1/agents/{agent_id}/invoke", json=body,
                                 headers=self.svc(caller, subject or body["user_id"], **(claims or {})))

    async def ok(self, agent_id: str = "conversation_partner", context: dict[str, Any] | None = None,
                 **kw: Any) -> dict[str, Any]:
        r = await self.invoke(agent_id, context, **kw)
        assert r.status_code == 200, r.text
        return dict(r.json())

    # ---------------------------------------------------------------- админка

    def url(self, agent_id: str, *rest: Any) -> str:
        return "/".join([f"/admin/v1/ai/agents/{agent_id}", *(str(r) for r in rest)])

    async def draft(self, agent_id: str = "conversation_partner", actor: Actor = MANAGER,
                    from_version: int | None = None) -> dict[str, Any]:
        r = await self.c.post(self.url(agent_id, "versions"), json={"from_version": from_version} if from_version
                              else None, headers=self.h(actor))
        assert r.status_code == 201, r.text
        return dict(r.json())

    async def patch(self, agent_id: str, version: int, changes: dict[str, Any], updated_at: str | None,
                    actor: Actor = MANAGER) -> httpx.Response:
        headers = self.h(actor)
        if updated_at is not None:
            headers["If-Match"] = updated_at
        return await self.c.patch(self.url(agent_id, "versions", version), json=changes, headers=headers)

    async def run_tests(self, agent_id: str, version: int, actor: Actor = MANAGER) -> dict[str, Any]:
        r = await self.c.post(self.url(agent_id, "versions", version, "test-runs"), headers=self.h(actor))
        assert r.status_code == 202, r.text
        return await self.wait_run(agent_id, version, r.json()["run_id"])

    async def wait_run(self, agent_id: str, version: int, run_id: str) -> dict[str, Any]:
        for _ in range(500):
            r = await self.c.get(self.url(agent_id, "versions", version, "test-runs", run_id),
                                 headers=self.h(ANALYST))
            assert r.status_code == 200, r.text
            if r.json()["status"] != "running":
                return dict(r.json())
            await asyncio.sleep(0.02)
        raise AssertionError("golden run did not finish")

    async def publish(self, agent_id: str, version: int, actor: Actor = PUBLISHER) -> httpx.Response:
        return await self.c.post(self.url(agent_id, "versions", version, "publish"),
                                 json={"reason": "Публикация в тесте"}, headers=self.h(actor))

    async def tested_draft(self, agent_id: str = "conversation_partner",
                           changes: dict[str, Any] | None = None) -> dict[str, Any]:
        """Черновик (с правкой) и зелёный прогон золотых тестов → версия."""
        v = await self.draft(agent_id)
        if changes:
            r = await self.patch(agent_id, v["version"], changes, v["updated_at"])
            assert r.status_code == 200, r.text
            v = r.json()
        run = await self.run_tests(agent_id, v["version"])
        assert run["passed_mandatory"], run
        return v

    async def publish_patched(self, agent_id: str, changes: dict[str, Any]) -> int:
        """Черновик с правкой → опубликован в обход золотых тестов (SQL: допустимые триггером переходы) — для тестов
        параметров вызова на сценарном провайдере."""
        v = await self.draft(agent_id)
        r = await self.patch(agent_id, v["version"], changes, v["updated_at"])
        assert r.status_code == 200, r.text
        await self.sql("UPDATE agent_rollout SET published_version = NULL WHERE agent_id = $1", agent_id)
        await self.sql("UPDATE agent_versions SET status = 'archived', archived_at = now() "
                       "WHERE agent_id = $1 AND status = 'published'", agent_id)
        await self.sql("UPDATE agent_versions SET status = 'published', published_at = now() "
                       "WHERE agent_id = $1 AND version = $2", agent_id, v["version"])
        await self.sql("UPDATE agent_rollout SET published_version = $2 WHERE agent_id = $1", agent_id, v["version"])
        return int(v["version"])

    async def agent(self, agent_id: str) -> dict[str, Any]:
        r = await self.c.get(self.url(agent_id), headers=self.h(ANALYST))
        assert r.status_code == 200, r.text
        return dict(r.json())

    async def set_budget(self, **values: Any) -> dict[str, Any]:
        current = (await self.c.get("/admin/v1/ai/budget", headers=self.h(OPERATIONS))).json()
        body = {k: current[k] for k in ("monthly_cap_usd", "learner_daily_cap_usd", "lesson_cap_usd",
                                        "alert_percent")}
        body.update(values)
        body["reason"] = "Лимиты в тесте"
        r = await self.c.put("/admin/v1/ai/budget", json=body, headers=self.h(OPERATIONS))
        assert r.status_code == 200, r.text
        return dict(r.json())

    async def price(self, model_id: str, input_usd: float, output_usd: float, active: bool = True,
                    actor: Actor = PRICING) -> None:
        r = await self.c.put(f"/admin/v1/ai/models/{model_id}",
                             json={"input_usd_per_mtok": input_usd, "output_usd_per_mtok": output_usd,
                                   "active": active, "reason": "Цена в тесте"}, headers=self.h(actor))
        assert r.status_code == 200, r.text

    # ---------------------------------------------------------------- события и БД

    async def flush(self) -> None:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()

    def events(self, event_type: str) -> list[Envelope]:
        return self.bus.of_type(event_type)

    async def audit(self, action: str) -> list[dict[str, Any]]:
        await self.flush()
        return [e.payload for e in self.events("admin.audit.recorded.v1") if e.payload["action"] == action]

    async def sql(self, query: str, *args: Any) -> list[asyncpg.Record]:
        url = make_url(TEST_ADMIN_URL).set(drivername="postgresql").render_as_string(hide_password=False)
        conn = await asyncpg.connect(url, server_settings={"search_path": self.schema})
        try:
            return await conn.fetch(query, *args)
        finally:
            await conn.close()

    async def usage(self) -> list[asyncpg.Record]:
        return await self.sql("SELECT * FROM usage ORDER BY seq")
