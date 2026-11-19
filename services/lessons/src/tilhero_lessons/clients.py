"""Клиенты доменов, которые вызывает lessons (INTERNAL_API §0): ai-gateway, assessment, learning-plan, diagnostics.

Все вызовы — «мягкие»: недоступность домена не ломает урок.
- ai-gateway: любой сбой (сеть, 5xx, неверный ответ) → `unavailable` — вызывающий продолжает без ИИ; исключение —
  409 IDEMPOTENCY_IN_PROGRESS (тот же request_id ещё обрабатывается, ревью R1-04): это не «ИИ недоступен», а
  `AiBusy` → клиенту 409 AI_BUSY, сессия не меняется (повтор той же реплики отдаст сохранённый ответ шлюза);
  шлюзу передаётся deadline_ms = таймаут клиента − 1 с (ревью R1-03);
- assessment: сбой → None (итог без оценки, повторная отправка — tick);
- learning-plan, diagnostics: сбой → None (следующий урок / «было» навыка не показываются).
Тексты учеников в логи не пишутся — только тип ошибки и код агента.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError
from tilhero_common.http_client import UpstreamError

log = logging.getLogger("tilhero.lessons.clients")

AI_GATEWAY = "ai-gateway"
ASSESSMENT = "assessment"
LEARNING_PLAN = "learning-plan"
DIAGNOSTICS = "diagnostics"

EVALUATION_STATUSES = frozenset({"ok", "partial", "insufficient_evidence", "pending_review"})
SKILL_STATES = frozenset({"not_started", "learning", "demonstrated", "retained"})


@dataclass
class Evaluation:
    """Ответ assessment: EvaluationView-поля, skill_outcomes, requires_human_review (флаг журнала)."""

    view: dict[str, Any]
    outcomes: list[dict[str, Any]]
    human_review: bool


@dataclass
class AgentResult:
    status: str  # ok | unavailable | refused
    reason: str | None
    output: dict[str, Any] | None
    request_id: str
    model_id: str | None = None
    warnings: list[str] = field(default_factory=list)


def _unavailable(request_id: str, reason: str) -> AgentResult:
    return AgentResult("unavailable", reason, None, request_id)


class AiBusy(ApiError):
    """409 AI_BUSY: ai-gateway ещё обрабатывает этот же запрос (request_id) — например, повторная отправка реплики,
    пока первая в работе. Не «ИИ недоступен»: сессию не менять, клиенту — «попробуйте через пару секунд»."""

    def __init__(self) -> None:
        super().__init__(409, "AI_BUSY", "Ответ ещё обрабатывается — попробуйте через пару секунд")


def deadline_ms(runtime: Runtime) -> int:
    """Сколько lessons ждёт ai-gateway: таймаут клиента (AI_TIMEOUT_SECONDS) − 1 с, в пределах ai.ts 1000..60000."""
    timeout = float(getattr(runtime.settings, "ai_timeout_seconds", 20.0))
    return max(1000, min(60_000, int(timeout * 1000) - 1000))


async def invoke_agent(runtime: Runtime, agent_id: str, *, request_id: str, session_id: uuid.UUID, session_kind: str,
                       user_id: uuid.UUID, audience: str, locale: str, context: dict[str, Any]) -> AgentResult:
    """POST /internal/v1/agents/{agent_id}/invoke (AgentInvokeRequest, ai.ts). request_id — идемпотентность в
    ai-gateway (повтор той же реплики не тратит бюджет повторно). AiBusy — тот же request_id ещё в работе (409)."""
    body = {"request_id": request_id, "session_id": str(session_id), "session_kind": session_kind,
            "user_id": str(user_id), "audience": audience, "locale": locale, "context": context,
            "deadline_ms": deadline_ms(runtime)}
    try:
        data = await runtime.client(AI_GATEWAY).post(f"/internal/v1/agents/{agent_id}/invoke", json=body,
                                                     subject=str(user_id), idempotency_key=request_id)
    except UpstreamError as exc:
        if exc.status == 409 and exc.code == "IDEMPOTENCY_IN_PROGRESS":
            log.info("ai-gateway call in progress", extra={"agent_id": agent_id, "status": exc.status})
            raise AiBusy() from None
        log.warning("ai-gateway call failed", extra={"agent_id": agent_id, "error_type": type(exc).__name__,
                                                     "status": exc.status})
        return _unavailable(request_id, "provider_error")
    except Exception as exc:  # таймаут клиента и прочее: урок продолжается без ИИ
        log.warning("ai-gateway call error", extra={"agent_id": agent_id, "error_type": type(exc).__name__})
        return _unavailable(request_id, "provider_error")
    if not isinstance(data, dict) or data.get("status") not in ("ok", "unavailable", "refused"):
        return _unavailable(request_id, "invalid_output")
    status = str(data["status"])
    output = data.get("output") if isinstance(data.get("output"), dict) else None
    if status == "ok" and output is None:
        return _unavailable(request_id, "invalid_output")
    reason = data.get("reason") if isinstance(data.get("reason"), str) else None
    warnings = [str(w)[:64] for w in data.get("warnings") or [] if isinstance(w, str)]
    model = data.get("model_id") if isinstance(data.get("model_id"), str) else None
    return AgentResult(status, reason, output if status == "ok" else None, request_id, model, warnings)


async def ai_available(runtime: Runtime) -> bool:
    """GET ai-gateway /internal/v1/status: False — аварийная остановка или провайдер не готов → занятие сразу в режиме
    вариантов (INTERNAL_API §2.1). Ошибка связи — True: режим full, деградация на первом же вызове (старт не
    блокируется)."""
    try:
        data = await runtime.client(AI_GATEWAY).get("/internal/v1/status")
    except Exception as exc:  # статус необязателен: урок не блокируется
        log.warning("ai-gateway status failed", extra={"error_type": type(exc).__name__})
        return True
    return not (isinstance(data, dict) and data.get("ai_available") is False)


def _valid_view(view: Any) -> bool:
    if not isinstance(view, dict):
        return False
    try:
        uuid.UUID(str(view.get("evaluation_id")))
    except ValueError:
        return False
    return view.get("status") in EVALUATION_STATUSES


async def request_evaluation(runtime: Runtime, user_id: uuid.UUID, body: dict[str, Any]) -> Evaluation | None:
    """POST /internal/v1/evaluations (EvaluationRequest, INTERNAL_API §3.2; `sub` = ученик; идемпотентно по session_id:
    повтор возвращает актуальную запись цепочки, в т. ч. после переоценки) → Evaluation или None, если assessment
    недоступен (сеть, 5xx, 503 CATALOG_UNAVAILABLE) или ответ не по контракту."""
    try:
        data = await runtime.client(ASSESSMENT).post("/internal/v1/evaluations", json=body, subject=str(user_id),
                                                     idempotency_key=f"lessons-{body['session_id']}")
    except UpstreamError as exc:
        log.warning("assessment unavailable", extra={"error_type": type(exc).__name__, "status": exc.status})
        return None
    except Exception as exc:
        log.warning("assessment call error", extra={"error_type": type(exc).__name__})
        return None
    if not isinstance(data, dict):
        return None
    view: dict[str, Any] = data["evaluation"] if isinstance(data.get("evaluation"), dict) else data
    if not _valid_view(view):
        log.warning("assessment response malformed")
        return None
    raw_outcomes = data.get("skill_outcomes", view.get("skill_outcomes")) or []
    outcomes = [{"skill_id": str(o["skill_id"])[:64], "outcome": str(o["outcome"])}
                for o in raw_outcomes if isinstance(o, dict) and isinstance(o.get("skill_id"), str)
                and o.get("outcome") in ("demonstrated", "learning", "not_assessed")]
    human = data.get("requires_human_review", view.get("requires_human_review"))
    return Evaluation(view, outcomes, human is True)


async def next_lesson_card(runtime: Runtime, user_id: uuid.UUID, pair_id: str, audience: str) -> dict[str, Any] | None:
    """learning-plan `GET /internal/v1/plan/trajectory?pair_id=&audience=` → next (LessonCard) или None."""
    try:
        data = await runtime.client(LEARNING_PLAN).get("/internal/v1/plan/trajectory", subject=str(user_id),
                                                       params={"pair_id": pair_id, "audience": audience})
    except Exception as exc:
        log.info("learning-plan trajectory unavailable", extra={"error_type": type(exc).__name__})
        return None
    nxt = data.get("next") if isinstance(data, dict) else None
    if not isinstance(nxt, dict) or not isinstance(nxt.get("lesson_id"), str):
        return None
    fields = ("lesson_id", "module_id", "title", "goal", "level", "kind", "duration_min", "primary_skill_id",
              "scenario_id", "stages")
    if any(f not in nxt for f in fields):
        return None
    return {f: nxt[f] for f in fields}


async def skill_states(runtime: Runtime, user_id: uuid.UUID, pair_id: str) -> dict[str, str] | None:
    """diagnostics `GET /internal/v1/skills/map?pair_id=` → {skill_id: state} или None."""
    try:
        data = await runtime.client(DIAGNOSTICS).get("/internal/v1/skills/map", subject=str(user_id),
                                                     params={"pair_id": pair_id})
    except Exception as exc:
        log.info("diagnostics skill map unavailable", extra={"error_type": type(exc).__name__})
        return None
    skills = data.get("skills") if isinstance(data, dict) else None
    if not isinstance(skills, list):
        return None
    return {str(s["skill_id"]): str(s["state"]) for s in skills
            if isinstance(s, dict) and isinstance(s.get("skill_id"), str) and s.get("state") in SKILL_STATES}
