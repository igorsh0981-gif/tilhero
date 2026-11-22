"""Вызов агента для доменов: `POST /internal/v1/agents/{agent_id}/invoke` (lessons, assessment, memory; INTERNAL_API
§1.2, спринт 5 §1.7); `GET /internal/v1/status` — доступны ли ИИ и оценка произношения (аварийная остановка,
готовность провайдеров, для речи — ещё месячный потолок).

Вызывающий и вид запроса (защита в глубину, спринт 5): memory — только `teaching_coach` с `request: gloss_word`
(перевод слова, которое memory проверила в опубликованном контенте через catalog); lessons и assessment — все
LLM-агенты, кроме `gloss_word` (иначе в «перевод слова» мог бы попасть произвольный текст ученика, а gloss_word
разрешён детям). Нарушение → 403 CALLER_NOT_ALLOWED {agent_id, request}.

Спринт 7 (INTERNAL_API §4): `cooperative_lesson_coach` — только lessons и только `session_kind: pair` с
`session_id = context.room_id` (парная комната; иначе 403 CALLER_NOT_ALLOWED / 422 CONTEXT_INVALID); вид `pair` — только
у коуча; вид `duel` — дуэль без ИИ: вызов агента в ней → 422 CONTEXT_INVALID.

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

from tilhero_ai_gateway.api.common import (
    InvokeCache,
    check_user,
    deps_of,
    invoke_auth,
    is_child_token,
    settings_of,
    speech_deps_of,
)
from tilhero_ai_gateway.contracts import (
    COACH_AGENT,
    NO_AI_SESSION_KINDS,
    PAIR_SESSION,
    AiSessionKind,
    AudienceSegment,
    request_kind,
    validate_context,
)
from tilhero_ai_gateway.domain import costs
from tilhero_ai_gateway.domain.invoke import InvokeRequest, invoke
from tilhero_ai_gateway.domain.speech import speech_available
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
    session_kind: AiSessionKind
    user_id: uuid.UUID
    audience: AudienceSegment
    locale: Literal["ru", "uz"]
    context: dict[str, Any]
    # сколько вызывающий готов ждать с момента отправки, мс (ai.ts AgentInvokeRequest.deadline_ms)
    deadline_ms: int | None = Field(default=None, ge=1000, le=60_000)


# Вызывающий → (agent_id, вид запроса) допустимые; None в виде — основной контракт агента
MEMORY_REQUESTS: Final = frozenset({("teaching_coach", "gloss_word")})


# Агент → единственный допустимый вызывающий (спринт 7: коуч парного урока — только lessons)
AGENT_CALLERS: Final = {COACH_AGENT: "lessons"}


def _check_caller(caller: str, agent_id: str, context: Any) -> None:
    kind = request_kind(agent_id, context)
    allowed = (agent_id, kind) in MEMORY_REQUESTS if caller == "memory" else kind is None
    if agent_id in AGENT_CALLERS and caller != AGENT_CALLERS[agent_id]:
        allowed = False
    if not allowed:
        raise forbidden("CALLER_NOT_ALLOWED", "Вызывающему недоступен этот агент или вид запроса",
                        {"agent_id": agent_id[:64], "request": kind})


def _check_session(agent_id: str, body: InvokeIn, context: dict[str, Any]) -> None:
    """Вид сессии и агент согласованы (спринт 7): pair ⇔ коуч парного урока (session_id = room_id контекста); в
    дуэли ИИ не вызывается."""
    errors: list[dict[str, str]] = []
    if body.session_kind in NO_AI_SESSION_KINDS:
        errors.append({"path": "session_kind", "message": "в дуэли ИИ не вызывается"})
    elif (agent_id == COACH_AGENT) != (body.session_kind == PAIR_SESSION):
        errors.append({"path": "session_kind", "message": "pair — только у cooperative_lesson_coach, и наоборот"})
    elif agent_id == COACH_AGENT and str(context.get("room_id")) != str(body.session_id):
        errors.append({"path": "context.room_id", "message": "room_id контекста ≠ session_id вызова"})
    if errors:
        raise unprocessable("CONTEXT_INVALID", "Контекст агента не соответствует контракту", {"errors": errors})


@router.post("/agents/{agent_id}/invoke",
             responses={404: {"description": "AGENT_NOT_FOUND | AGENT_NOT_ACTIVE"},
                        422: {"description": "CONTEXT_INVALID {errors} | IDEMPOTENCY_KEY_REUSED"},
                        409: {"description": "IDEMPOTENCY_IN_PROGRESS"}})
async def invoke_agent(agent_id: str, body: InvokeIn, request: Request,
                       principal: Principal = Depends(invoke_auth)) -> JSONResponse:
    received = time.monotonic()
    deadline = received + body.deadline_ms / 1000 if body.deadline_ms is not None else None
    check_user(principal, body.user_id)
    deps = deps_of(request)
    rt = deps.rt
    async with rt.transaction() as s:
        agent = await s.get(AgentRow, agent_id[:64])
    if agent is None:
        raise not_found("AGENT_NOT_FOUND", "Агент не найден")
    if agent.implementation != "llm" or agent.availability != "active":
        raise not_found("AGENT_NOT_ACTIVE", "Агент не вызывается через ai-gateway")
    _check_caller(principal.issuer, agent_id, body.context)
    context, errors = validate_context(agent_id, body.context)
    if context is None:
        raise unprocessable("CONTEXT_INVALID", "Контекст агента не соответствует контракту", {"errors": errors})
    _check_session(agent_id, body, context)
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
    """AiStatus {ai_available, speech_available}. ai_available: ИИ включён (нет аварийной остановки) и провайдер
    готов (ключ задан или fake) — lessons спрашивает при старте занятия: недоступен → режим «варианты» сразу
    (INTERNAL_API §2.1); лимиты бюджета не учитываются — они проверяются на каждом вызове. speech_available (спринт 5,
    memory перед оценкой произношения): нет аварийной остановки, ключ и регион Azure заданы (или fake), модель речи
    включена, месячный потолок не превышен."""
    deps = deps_of(request)
    speech = speech_deps_of(request)
    async with deps.rt.transaction() as s:
        budget = await costs.get_budget(s)
        speech_ok = await speech_available(s, speech.provider, speech.clock())
    return {"ai_available": bool(budget.ai_enabled and deps.provider.ready()), "speech_available": speech_ok}
