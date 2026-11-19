"""Вызов агента для доменов: `POST /internal/v1/agents/{agent_id}/invoke` (lessons, assessment; INTERNAL_API §1.2);
`GET /internal/v1/status` — доступен ли ИИ (аварийная остановка, готовность провайдера).

Ответ всегда AgentInvokeResult со статусом 200 (`ok | unavailable | refused`) — вызывающий продолжает без ИИ при
unavailable/refused. 404 — агент не найден или не `llm`+`active`; 422 — контекст не по ai.ts; 401 — в токене нет
ученика (`sub`); 403 — user_id тела не совпадает с учеником токена (`sub` или `lrn`).

Аудитория kids: детский профиль определяется по `audience` тела (lessons и assessment передают аудиторию сессии).
Claims токена (`lrn` ≠ `sub`, `age_band` 6–13) проверяются как дополнительная защита на будущее, но сейчас вызывающие
их не передают (их токен несёт только `sub`) — основная защита детей — `audience` тела и отказ lessons/assessment
отправлять детский свободный текст (ревью R1-07).

Дедлайн вызывающего (`deadline_ms`, ревью R1-03) отсчитывается от приёма запроса. Повтор request_id ≤ 24 ч —
сохранённый результат (Redis); дубль, пришедший во время первого вызова, ждёт его результат (опрос 200 мс, не дольше
дедлайна вызывающего и 25 с) и получает его как повтор (`idempotent-replay: true`); не дождался — 409
IDEMPOTENCY_IN_PROGRESS (ревью R1-04).
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Final, Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from redis.exceptions import RedisError

from tilhero_ai_gateway.api.common import InvokeCache, deps_of, invoke_auth, is_child_token, settings_of
from tilhero_ai_gateway.contracts import AudienceSegment, SessionKind, validate_context
from tilhero_ai_gateway.domain import costs
from tilhero_ai_gateway.domain.invoke import InvokeRequest, invoke
from tilhero_ai_gateway.models import AgentRow
from tilhero_common.errors import forbidden, not_found, unprocessable
from tilhero_common.internal_auth import Principal
from tilhero_common.redis_tools import fingerprint

router = APIRouter(prefix="/internal/v1", tags=["internal"])
log = logging.getLogger("tilhero.ai_gateway.internal")
PENDING_TTL = 150  # три попытки по ≤ 30 с + запас
DUPLICATE_WAIT_MAX_S: Final = 25.0  # дубль ждёт результат первого вызова не дольше (и не дольше дедлайна)
DUPLICATE_WAIT_MARGIN_S: Final = 0.25  # ответ 409 должен успеть дойти до вызывающего до его дедлайна


class InvokeIn(BaseModel):
    """AgentInvokeRequest (ai.ts)."""

    model_config = ConfigDict(extra="forbid")

    request_id: uuid.UUID
    session_id: uuid.UUID
    session_kind: SessionKind
    user_id: uuid.UUID
    audience: AudienceSegment
    locale: Literal["ru", "uz"]
    context: dict[str, Any]
    # сколько вызывающий готов ждать с момента отправки, мс (ai.ts AgentInvokeRequest.deadline_ms)
    deadline_ms: int | None = Field(default=None, ge=1000, le=60_000)


def _check_user(principal: Principal, user_id: uuid.UUID) -> None:
    """user_id тела — ученик из токена вызывающего (`sub`, либо `lrn`, если токен его несёт): IDOR, защита в глубину.
    Токена без `sub` у вызова ученика не бывает → 401 USER_CONTEXT_REQUIRED (ревью R1-07: раньше такой токен
    пропускал проверку целиком)."""
    subject = principal.user_id  # нет sub → 401 USER_CONTEXT_REQUIRED
    allowed = {v for v in (subject, principal.claims.get("lrn")) if isinstance(v, str) and v}
    if str(user_id) not in allowed:
        raise forbidden("USER_CONTEXT_MISMATCH", "Ученик вызова не совпадает с учеником токена")


@router.post("/agents/{agent_id}/invoke",
             responses={404: {"description": "AGENT_NOT_FOUND | AGENT_NOT_ACTIVE"},
                        422: {"description": "CONTEXT_INVALID {errors} | IDEMPOTENCY_KEY_REUSED"},
                        409: {"description": "IDEMPOTENCY_IN_PROGRESS"}})
async def invoke_agent(agent_id: str, body: InvokeIn, request: Request,
                       principal: Principal = Depends(invoke_auth)) -> JSONResponse:
    received = time.monotonic()
    deadline = received + body.deadline_ms / 1000 if body.deadline_ms is not None else None
    _check_user(principal, body.user_id)
    deps = deps_of(request)
    rt = deps.rt
    async with rt.transaction() as s:
        agent = await s.get(AgentRow, agent_id[:64])
    if agent is None:
        raise not_found("AGENT_NOT_FOUND", "Агент не найден")
    if agent.implementation != "llm" or agent.availability != "active":
        raise not_found("AGENT_NOT_ACTIVE", "Агент не вызывается через ai-gateway")
    context, errors = validate_context(agent_id, body.context)
    if context is None:
        raise unprocessable("CONTEXT_INVALID", "Контекст агента не соответствует контракту", {"errors": errors})
    audience = "kids" if is_child_token(principal) else body.audience
    req = InvokeRequest(agent_id=agent_id, request_id=body.request_id, session_id=body.session_id,
                        session_kind=body.session_kind, user_id=body.user_id, audience=audience, locale=body.locale,
                        context=context, deadline=deadline)
    cache: InvokeCache | None = None
    caller = principal.issuer
    request_key = str(body.request_id)
    # дедлайн — свойство доставки, а не запроса: повтор с другим deadline_ms — тот же вызов
    fp = fingerprint({"agent_id": agent_id, "body": body.model_dump(mode="json", exclude={"deadline_ms"}),
                      "audience": audience})
    if rt.redis is not None:
        conf = settings_of(rt)
        cache = InvokeCache(rt.redis, conf.cache_namespace, conf.invoke_cache_ttl_seconds, PENDING_TTL)
        wait_until = received + DUPLICATE_WAIT_MAX_S
        if deadline is not None:
            wait_until = min(wait_until, deadline - DUPLICATE_WAIT_MARGIN_S)
        try:
            replay = await cache.begin(caller, request_key, fp, wait_until=wait_until)
        except RedisError:
            log.warning("invoke cache unavailable, executing without idempotency")
            cache, replay = None, None
        if replay is not None:
            return JSONResponse(replay, headers={"idempotent-replay": "true"})
    try:
        result = await invoke(deps, req, caller=caller)
    except BaseException:
        if cache is not None:
            try:
                await cache.abort(caller, request_key)
            except RedisError:
                log.warning("invoke cache abort failed")
        raise
    if cache is not None:
        try:
            await cache.complete(caller, request_key, fp, result, str(body.user_id))
        except RedisError:
            log.warning("invoke cache complete failed")
    return JSONResponse(result)


@router.get("/status")
async def ai_status(request: Request, principal: Principal = Depends(invoke_auth)) -> dict[str, bool]:
    """{ai_available}: ИИ включён (нет аварийной остановки) и провайдер готов (ключ задан или fake). lessons спрашивает
    при старте занятия: недоступен → режим «варианты» сразу (INTERNAL_API §2.1), а не после первого отказа. Лимиты
    бюджета здесь не учитываются — они проверяются на каждом вызове."""
    deps = deps_of(request)
    async with deps.rt.transaction() as s:
        budget = await costs.get_budget(s)
    return {"ai_available": bool(budget.ai_enabled and deps.provider.ready())}
