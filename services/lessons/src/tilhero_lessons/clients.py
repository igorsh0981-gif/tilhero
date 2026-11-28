"""Клиенты доменов, которые вызывает lessons (INTERNAL_API §0): ai-gateway, assessment, learning-plan, diagnostics;
спринт 7 — social (связь учеников, member_id → user_id), identity-consent (согласие на голос), ai-gateway
`speech:transcribe` (голосовой ход парной комнаты).

Все вызовы — «мягкие»: недоступность домена не ломает урок.
- ai-gateway: любой сбой (сеть, 5xx, неверный ответ) → `unavailable` — вызывающий продолжает без ИИ; исключение —
  409 IDEMPOTENCY_IN_PROGRESS (тот же request_id ещё обрабатывается, ревью R1-04): это не «ИИ недоступен», а
  `AiBusy` → клиенту 409 AI_BUSY, сессия не меняется (повтор той же реплики отдаст сохранённый ответ шлюза);
  шлюзу передаётся deadline_ms = таймаут клиента − 1 с (ревью R1-03);
- assessment: сбой → None (итог без оценки, повторная отправка — tick);
- learning-plan, diagnostics: сбой → None (следующий урок / «было» навыка не показываются);
- social: недоступен → 503 UPSTREAM_UNAVAILABLE {service: social} (социальная команда не выполняется, учёба работает);
- identity-consent: сбой → None (голос недоступен — 503 SPEECH_UNAVAILABLE у вызывающего);
- speech:transcribe: 503/сеть → 503 SPEECH_UNAVAILABLE; 422 AUDIO_INVALID и 403 KIDS_NOT_ALLOWED — как у шлюза;
- спринт 8, billing (INTERNAL_API спринта 8 §0.3, §1.11): удержание минут `POST /internal/v1/holds` и доступ
  `GET /internal/v1/access/{user_id}` — не дольше BILLING_TIMEOUT_SECONDS (2 с) на весь вызов, без повторов в клиенте
  (удержание идемпотентно по (ref_kind, ref_id) — повтор делает следующая команда); сбой, таймаут, ответ не по
  контракту → «billing недоступен»: занятие без ИИ, приглашение в урок вдвоём — 503 BILLING_UNAVAILABLE.
Тексты учеников в логи не пишутся — только тип ошибки и код агента.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import uuid
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, forbidden, unavailable
from tilhero_common.http_client import UpstreamError

log = logging.getLogger("tilhero.lessons.clients")

AI_GATEWAY = "ai-gateway"
ASSESSMENT = "assessment"
LEARNING_PLAN = "learning-plan"
DIAGNOSTICS = "diagnostics"
SOCIAL = "social"
IDENTITY = "identity-consent"
BILLING = "billing"
AUDIENCES = frozenset({"kids", "teens", "adults"})

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
    # фактически оплаченная сумма вызова (ai.ts AgentInvokeResult.cost_usd) — расход ИИ парной комнаты
    cost_usd: Decimal = Decimal("0")


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
    return AgentResult(status, reason, output if status == "ok" else None, request_id, model, warnings,
                       _cost(data.get("cost_usd")))


def _cost(value: Any) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, int | float | str):
        return Decimal("0")
    try:
        cost = Decimal(str(value))
    except InvalidOperation:
        return Decimal("0")
    return cost if cost.is_finite() and Decimal("0") <= cost <= Decimal("100") else Decimal("0")


async def _ai_status(runtime: Runtime) -> dict[str, Any] | None:
    try:
        data = await runtime.client(AI_GATEWAY).get("/internal/v1/status")
    except Exception as exc:  # статус необязателен: урок не блокируется
        log.warning("ai-gateway status failed", extra={"error_type": type(exc).__name__})
        return None
    return data if isinstance(data, dict) else None


async def paid_ai_available(runtime: Runtime) -> bool:
    """Спринт 8: ИИ для подписчика (ai.ts AiStatus.paid_available — уровни normal | economy | paid_only); старый шлюз
    без поля — ai_available. Ошибка связи — True (как ai_available: деградация на первом вызове)."""
    data = await _ai_status(runtime)
    if data is None:
        return True
    value = data.get("paid_available", data.get("ai_available"))
    return value is not False


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


# ---------------------------------------------------------------- спринт 7: social, identity-consent, речь


def social_unavailable() -> ApiError:
    return unavailable("UPSTREAM_UNAVAILABLE", "Социальные функции временно недоступны", {"service": SOCIAL})


@dataclass(frozen=True)
class Relation:
    """GET social /internal/v1/relations/{a}/{b} (INTERNAL_API §1.2)."""

    friends: bool
    same_family: bool
    blocked_any: bool
    a_restricted: bool
    a_until: str | None
    b_restricted: bool
    b_until: str | None
    a_audience: str | None
    b_audience: str | None
    # доступ к друзьям (14–17 — с согласием родителя, цель social); None — social поле не прислал
    a_social_allowed: bool | None = None
    b_social_allowed: bool | None = None
    a_member_id: str | None = None
    b_member_id: str | None = None


def _restricted(data: dict[str, Any], prefix: str) -> tuple[bool, str | None]:
    """`a_restricted`: bool или объект {active?, until}; срок — `a_restricted_until` (social) / `a_social_ban_until`."""
    raw = data.get(f"{prefix}_restricted")
    until = data.get(f"{prefix}_restricted_until") or data.get(f"{prefix}_social_ban_until")
    if isinstance(raw, dict):
        active = raw.get("active", True) is not False
        until = raw.get("until", until)
    else:
        active = raw is True
    return active, until if isinstance(until, str) else None


async def relation(runtime: Runtime, a: uuid.UUID, b: uuid.UUID) -> Relation | None:
    """Связь двух учеников; None — ученика нет у social (404). Недоступность — 503 UPSTREAM_UNAVAILABLE."""
    try:
        data = await runtime.client(SOCIAL).get(f"/internal/v1/relations/{a}/{b}")
    except UpstreamError as exc:
        if exc.status == 404:
            return None
        log.warning("social relations unavailable", extra={"error_type": type(exc).__name__, "status": exc.status})
        raise social_unavailable() from None
    except Exception as exc:
        log.warning("social relations error", extra={"error_type": type(exc).__name__})
        raise social_unavailable() from None
    if not isinstance(data, dict):
        raise social_unavailable()
    a_r, a_until = _restricted(data, "a")
    b_r, b_until = _restricted(data, "b")
    a_aud, b_aud = data.get("a_audience"), data.get("b_audience")
    return Relation(friends=data.get("friends") is True, same_family=data.get("same_family") is True,
                    blocked_any=data.get("blocked_any") is True, a_restricted=a_r, a_until=a_until,
                    b_restricted=b_r, b_until=b_until, a_audience=a_aud if a_aud in AUDIENCES else None,
                    b_audience=b_aud if b_aud in AUDIENCES else None,
                    a_social_allowed=_flag(data.get("a_social_allowed")),
                    b_social_allowed=_flag(data.get("b_social_allowed")),
                    a_member_id=data.get("a_member_id") if isinstance(data.get("a_member_id"), str) else None,
                    b_member_id=data.get("b_member_id") if isinstance(data.get("b_member_id"), str) else None)


def _flag(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


async def member_user(runtime: Runtime, member_id: str) -> uuid.UUID | None:
    """GET social /internal/v1/members/{member_id} → {user_id}; 404 → None; недоступен — 503."""
    try:
        data = await runtime.client(SOCIAL).get(f"/internal/v1/members/{member_id}")
    except UpstreamError as exc:
        if exc.status == 404:
            return None
        log.warning("social members unavailable", extra={"error_type": type(exc).__name__, "status": exc.status})
        raise social_unavailable() from None
    except Exception as exc:
        log.warning("social members error", extra={"error_type": type(exc).__name__})
        raise social_unavailable() from None
    try:
        return uuid.UUID(str((data or {}).get("user_id")))
    except (ValueError, AttributeError):
        return None


async def public_profile(runtime: Runtime, user_id: uuid.UUID) -> dict[str, Any] | None:
    """identity-consent GET /internal/v1/users/{lrn}/public → {kind, age_band, guardian_consent, purposes, …}
    (как memory, спринт 5); 404 → {}; сбой → None."""
    try:
        data = await runtime.client(IDENTITY).get(f"/internal/v1/users/{user_id}/public")
    except UpstreamError as exc:
        if exc.status == 404:
            return {}
        log.warning("identity-consent public unavailable", extra={"error_type": type(exc).__name__,
                                                                  "status": exc.status})
        return None
    except Exception as exc:
        log.warning("identity-consent public error", extra={"error_type": type(exc).__name__})
        return None
    return data if isinstance(data, dict) else None


async def speech_available(runtime: Runtime) -> bool:
    """GET ai-gateway /internal/v1/status → speech_available (нет поля — как ai_available); сбой — False."""
    try:
        data = await runtime.client(AI_GATEWAY).get("/internal/v1/status")
    except Exception as exc:
        log.info("ai-gateway status failed (speech)", extra={"error_type": type(exc).__name__})
        return False
    if not isinstance(data, dict):
        return False
    value = data.get("speech_available", data.get("ai_available"))
    return value is True


def speech_unavailable() -> ApiError:
    return unavailable("SPEECH_UNAVAILABLE", "Распознавание речи сейчас недоступно — ответьте текстом")


def audio_invalid(reason: str) -> ApiError:
    return ApiError(422, "AUDIO_INVALID", "Запись не подходит: нужен WAV 16 кГц моно, от 0,5 до 15 секунд",
                    {"reason": reason})


async def transcribe(runtime: Runtime, audio: bytes, meta: dict[str, Any]) -> dict[str, Any]:
    """ai-gateway POST /internal/v1/speech:transcribe (ai.ts SpeechTranscribeMeta / SpeechTranscribeResult): тело —
    WAV, мета — заголовок X-Speech-Meta (base64url JSON). Аудио и текст в лог не пишутся."""
    header = base64.urlsafe_b64encode(json.dumps(meta, separators=(",", ":")).encode()).decode().rstrip("=")
    try:
        data = await runtime.client(AI_GATEWAY).post(
            "/internal/v1/speech:transcribe", content=audio, subject=str(meta["user_id"]),
            idempotency_key=str(meta["request_id"]),
            headers={"content-type": "audio/wav", "x-speech-meta": header})
    except UpstreamError as exc:
        log.info("speech transcribe failed", extra={"status": exc.status, "code": exc.code[:40]})
        if exc.status == 422 and exc.code == "AUDIO_INVALID":
            reason = exc.details.get("reason") if isinstance(exc.details, dict) else None
            raise audio_invalid(reason if reason in ("format", "too_short", "too_long", "too_large")
                                else "format") from None
        if exc.status == 403 and exc.code == "KIDS_NOT_ALLOWED":
            raise forbidden("KIDS_NOT_ALLOWED", "В детском профиле ответ выбирается из вариантов") from None
        raise speech_unavailable() from None
    except Exception as exc:
        log.info("speech transcribe error", extra={"error_type": type(exc).__name__})
        raise speech_unavailable() from None
    if not isinstance(data, dict) or not isinstance(data.get("text"), str):
        raise speech_unavailable()
    duration = data.get("duration_ms")
    return {"text": " ".join(data["text"].split())[:600],
            "duration_ms": int(duration) if isinstance(duration, int) and not isinstance(duration, bool)
            and 0 <= duration <= 60_000 else 0}


# ---------------------------------------------------------------- спринт 8: billing (удержания и доступ)

BILLING_FEATURES = frozenset({"ai_lessons", "pair_lessons"})
# причины отказа billing (bff.ts AiLockReason / SubscriptionRequiredReason); billing_unavailable — наша, при сбое
DENY_REASONS = frozenset({"no_subscription", "feature_not_in_plan", "minutes_exhausted", "kids"})
BILLING_UNAVAILABLE = "billing_unavailable"


@dataclass(frozen=True)
class Hold:
    """Ответ `POST /internal/v1/holds`: allowed — минуты удержаны (hold_id); иначе reason: no_subscription |
    feature_not_in_plan | minutes_exhausted | kids | billing_unavailable (сбой, таймаут, ответ не по контракту)."""

    allowed: bool
    reason: str | None = None
    hold_id: uuid.UUID | None = None
    minutes_held: int | None = None
    minutes_left: int | None = None


@dataclass(frozen=True)
class Access:
    """Ответ `GET /internal/v1/access/{user_id}?feature=…`."""

    allowed: bool
    reason: str | None
    minutes_left: int | None


def billing_unavailable() -> ApiError:
    return unavailable("BILLING_UNAVAILABLE", "Подписка сейчас недоступна — попробуйте позже, учёба работает")


def subscription_required(feature: str, reason: str) -> ApiError:
    """403 SUBSCRIPTION_REQUIRED {feature, reason} (bff.ts SubscriptionRequiredDetails)."""
    return forbidden("SUBSCRIPTION_REQUIRED", "Уроки вдвоём с ИИ-коучем — в подписке",
                     {"feature": feature, "reason": reason})


def _count(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 1_000_000 else None


async def _billing_call(runtime: Runtime, method: str, path: str, **kw: Any) -> Any:
    """Вызов billing с общим сроком BILLING_TIMEOUT_SECONDS (включая соединение); исключение — billing недоступен."""
    seconds = float(getattr(runtime.settings, "billing_timeout_seconds", 2.0))
    async with asyncio.timeout(seconds):
        return await runtime.client(BILLING).request(method, path, **kw)


async def create_hold(runtime: Runtime, *, user_id: uuid.UUID, feature: str, ref_kind: str, ref_id: uuid.UUID,
                      minutes_planned: int) -> Hold:
    """POST billing /internal/v1/holds (`sub` = user_id тела). Повтор по (ref_kind, ref_id) — тот же ответ billing:
    переподключение и повтор команды не создают второго удержания. Сбой — Hold(allowed=False, billing_unavailable)."""
    body = {"user_id": str(user_id), "feature": feature, "ref_kind": ref_kind, "ref_id": str(ref_id),
            "minutes_planned": max(1, min(120, int(minutes_planned)))}
    try:
        data = await _billing_call(runtime, "POST", "/internal/v1/holds", json=body, subject=str(user_id),
                                   idempotency_key=f"hold:{ref_kind}:{ref_id}")
    except UpstreamError as exc:
        log.warning("billing hold failed", extra={"status": exc.status, "code": exc.code[:40], "feature": feature})
        return Hold(False, BILLING_UNAVAILABLE)
    except Exception as exc:  # таймаут и прочее: занятие идёт без ИИ
        log.warning("billing hold error", extra={"error_type": type(exc).__name__, "feature": feature})
        return Hold(False, BILLING_UNAVAILABLE)
    if not isinstance(data, dict) or not isinstance(data.get("allowed"), bool):
        log.warning("billing hold response malformed")
        return Hold(False, BILLING_UNAVAILABLE)
    if data["allowed"] is False:
        reason = data.get("reason")
        return Hold(False, reason if reason in DENY_REASONS else "no_subscription")
    try:
        hold_id = uuid.UUID(str(data.get("hold_id")))
    except ValueError:
        log.warning("billing hold response malformed")
        return Hold(False, BILLING_UNAVAILABLE)
    held, left = _count(data.get("minutes_held")), _count(data.get("minutes_left"))
    return Hold(True, None, hold_id, held, left)


async def access(runtime: Runtime, user_id: uuid.UUID, feature: str) -> Access | None:
    """GET billing /internal/v1/access/{user_id}?feature= → Access; None — billing недоступен (сбой, таймаут, ответ не
    по контракту)."""
    try:
        data = await _billing_call(runtime, "GET", f"/internal/v1/access/{user_id}", params={"feature": feature},
                                   subject=str(user_id))
    except Exception as exc:
        log.warning("billing access failed", extra={"error_type": type(exc).__name__, "feature": feature})
        return None
    if not isinstance(data, dict) or not isinstance(data.get("allowed"), bool):
        log.warning("billing access response malformed")
        return None
    reason = data.get("reason")
    if data["allowed"]:
        return Access(True, None, _count(data.get("minutes_left")))
    return Access(False, reason if reason in DENY_REASONS else "no_subscription", _count(data.get("minutes_left")))
