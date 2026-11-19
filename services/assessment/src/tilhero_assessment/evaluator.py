"""Клиент ai-gateway для независимого оценщика `independent_evaluator` (INTERNAL_API §1.2, §1.4; ai.ts).

- Вызов `POST /internal/v1/agents/independent_evaluator/invoke` с `AgentInvokeRequest`; request_id детерминирован
  по session_id — повтор оценки той же сессии (повторное завершение, гонка) не оплачивается дважды (идемпотентность
  ai-gateway 24 ч).
- ИИ необязателен: ошибка HTTP, таймаут, неожиданная форма ответа или вывода → `unavailable` (оценка без открытой
  части); `refused` — как есть. Ошибки провайдера наружу не уходят; в лог — только тип ошибки и статус.
- Дедлайн (ревью R1-03): `deadline_ms` = таймаут клиента к шлюзу − 1 с — шлюз не начинает попытку, которая не
  успеет, и отвечает раньше, чем истечёт таймаут клиента.
- 409 IDEMPOTENCY_IN_PROGRESS (ревью R1-04): оценка этой сессии уже идёт в другом запросе (повтор finish, tick) и шлюз
  не дождался её результата — это не «ИИ недоступен»: `EvaluatorBusy`, API отвечает 503, partial не записывается;
  lessons повторит оценку (tick), а шлюз отдаст сохранённый результат первого вызова.
- Вывод проверяется ещё раз (защита в глубину): статус, баллы 0..3|null, булевы поля; `pronunciation_score` и
  `cefr_certificate` не используются вовсе.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Any, Final

from tilhero_assessment.domain.common import EVALUATOR_AGENT
from tilhero_common.app import Runtime
from tilhero_common.http_client import UpstreamError

log = logging.getLogger("tilhero.assessment.evaluator")

AI_GATEWAY: Final = "ai-gateway"
_NAMESPACE: Final = uuid.UUID("6f1c2b8e-4d0a-4c55-9a8e-0a55e5500001")


class EvaluatorBusy(Exception):
    """Шлюз ответил 409 IDEMPOTENCY_IN_PROGRESS: тот же вызов оценщика ещё выполняется."""


def request_id_for(session_id: uuid.UUID) -> str:
    return str(uuid.uuid5(_NAMESPACE, f"{session_id}:{EVALUATOR_AGENT}"))


@dataclass(frozen=True)
class EvaluatorResult:
    status: str  # ok | unavailable | refused
    reason: str | None
    output: dict[str, Any] | None
    meta: dict[str, Any] | None  # {agent_id, agent_version, prompt_version, model_id, schema_version, canary}


def unavailable_result(reason: str) -> EvaluatorResult:
    return EvaluatorResult("unavailable", reason, None, None)


def _valid_output(out: Any) -> bool:
    if not isinstance(out, dict) or out.get("status") not in ("ok", "insufficient_evidence"):
        return False
    scores = out.get("scores")
    if not isinstance(scores, dict):
        return False
    for value in scores.values():
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 3):
            return False
    if out.get("task_completed") is not None and not isinstance(out.get("task_completed"), bool):
        return False
    if not isinstance(out.get("confirmed_errors", []), list):
        return False
    confidence = out.get("confidence")
    if confidence is not None and (isinstance(confidence, bool) or not isinstance(confidence, int | float)):
        return False
    return all(isinstance(out.get(k, False), bool) for k in ("support_used", "requires_human_review"))


def _meta(data: dict[str, Any]) -> dict[str, Any] | None:
    version, prompt, model, schema = (data.get("agent_version"), data.get("prompt_version"), data.get("model_id"),
                                      data.get("schema_version"))
    if not (isinstance(version, int) and isinstance(prompt, str) and isinstance(model, str)
            and isinstance(schema, str)):
        return None
    return {"agent_id": EVALUATOR_AGENT, "agent_version": version, "prompt_version": prompt[:100],
            "model_id": model[:100], "schema_version": schema[:100], "canary": bool(data.get("canary", False))}


def deadline_ms_for(timeout_seconds: float) -> int:
    """deadline_ms для шлюза: таймаут клиента − 1 с, в пределах контракта ai.ts (1000..60000)."""
    return max(1000, min(60_000, int(timeout_seconds * 1000) - 1000))


class EvaluatorGateway:
    def __init__(self, runtime: Runtime, *, timeout_seconds: float) -> None:
        self.runtime = runtime
        self.deadline_ms = deadline_ms_for(timeout_seconds)

    async def evaluate(self, *, session_id: uuid.UUID, session_kind: str, user_id: uuid.UUID, audience: str,
                       locale: str, context: dict[str, Any]) -> EvaluatorResult:
        """EvaluatorBusy — вызов этой сессии ещё идёт (409 шлюза); остальные сбои → unavailable."""
        body = {"request_id": request_id_for(session_id), "session_id": str(session_id), "session_kind": session_kind,
                "user_id": str(user_id), "audience": audience, "locale": locale, "context": context,
                "deadline_ms": self.deadline_ms}
        try:
            data = await self.runtime.client(AI_GATEWAY).post(f"/internal/v1/agents/{EVALUATOR_AGENT}/invoke",
                                                              json=body, subject=str(user_id))
        except UpstreamError as exc:
            if exc.status == 409 and exc.code == "IDEMPOTENCY_IN_PROGRESS":
                log.info("evaluator call in progress elsewhere", extra={"status": exc.status})
                raise EvaluatorBusy() from None
            log.warning("evaluator call failed", extra={"error_type": type(exc).__name__, "status": exc.status})
            return unavailable_result("timeout" if exc.status == 504 else "provider_error")
        except Exception as exc:
            log.warning("evaluator call failed", extra={"error_type": type(exc).__name__})
            return unavailable_result("provider_error")
        if not isinstance(data, dict) or data.get("status") not in ("ok", "unavailable", "refused"):
            log.warning("evaluator response malformed")
            return unavailable_result("invalid_output")
        reason = data.get("reason") if isinstance(data.get("reason"), str) else None
        if data["status"] != "ok":
            return EvaluatorResult(str(data["status"]), (reason or "")[:32] or None, None, None)
        output, meta = data.get("output"), _meta(data)
        if not _valid_output(output) or meta is None:
            log.warning("evaluator output rejected", extra={"meta_ok": meta is not None})
            return unavailable_result("invalid_output")
        assert isinstance(output, dict)
        return EvaluatorResult("ok", None, output, meta)
