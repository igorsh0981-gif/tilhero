"""Вызов агента (INTERNAL_API §1.2) — порядок проверок и попыток.

1. Агент `llm` + `active` (иначе 404 — в API); свободный текст и аудитория kids → `refused: kids_not_allowed`.
2. `budget.ai_enabled = false` (аварийная остановка) или провайдер без ключа → `unavailable: ai_disabled`. Золотой
   прогон аварийной остановкой не блокируется (проверка сотрудником перед включением ИИ; ревью R1-11).
3. Версия: опубликованная или канареечная (`sha256(user_id + agent_id) mod 100 < canary_percent`); нет
   опубликованной → `refused: agent_not_active`.
4. Попытки: основная модель → при нарушении один повтор с ограничениями (коды нарушений в rules) на той же модели →
   резервная модель; ошибка или таймаут провайдера → сразу резервная. Перед каждой попыткой (ревью R1-02, R1-03):
   - дедлайн вызывающего: осталось < 1,5 с → попытка не начинается, `unavailable: timeout`; таймаут попытки =
     min(timeout_ms версии, остаток − 0,5 с);
   - `max_cost_usd` версии — накопительно по вызову (фактически оплачено попытками + оценка следующей); не
     помещается → следующая попытка — резервная модель (обычно дешевле), не помещается и она → `cost_limit`;
   - резерв бюджета (месяц, ученик в день, урок): не помещается → тоже резервная модель, и только если не помещается
     и она → `budget_exceeded`. Всё это — **до** вызова провайдера.
5. Ответ — ровно один JSON-объект → JSON-схема версии → контракт ai.ts → правила безопасности (§1.3). Итог —
   `ok` | `unavailable: invalid_output | provider_error | timeout | cost_limit | budget_exceeded`.
6. Учёт — строка usage на вызов (токены и стоимость по usage провайдера, задержка, попытки) без текстов. Таймаут
   клиента или неразбираемый ответ после HTTP 200 — провайдер мог выставить счёт: в стоимость идёт оценка попытки
   (консервативно, ревью R1-08); ошибка HTTP/сети — 0.
Вызывающий обязан продолжить без ИИ при unavailable/refused.

Вид запроса (спринт 5): `teaching_coach` с `context.request = gloss_word` — свой контракт вывода и лимиты вызова
(`REQUEST_LIMITS`: ≤ 200 выходных токенов и ≤ 6 с — меньшее из лимитов версии и запроса; оценка стоимости — по этому
лимиту). Версия, чья схема вывода не принимает вид запроса (v1 teaching_coach и черновики из неё), его не обслуживает:
`refused: agent_not_active` без вызова провайдера (`supports_request`) — до публикации v2 memory получает «перевода
нет».

Контроль ИИ (спринт 8, INTERNAL_API §7, domain/degradation.py): вызов ученика (не золотой прогон) проверяет
действующий уровень после аварийной остановки — `off` → `ai_disabled` (ручной) / `budget_exceeded` (авто), `paid_only`
и ученик без подписки → `unavailable: degraded` (до провайдера, $0); `economy` (и `paid_only` у подписчика) — попытки
сразу резервной моделью версии (основная → резервная, без дальнейшего отката). Дневной лимит ученика — по тарифу
(domain/tiers.py). Смена уровня, замеченная вызовом, записывается (degradation_events + событие).

Парная комната (спринт 7, INTERNAL_API §4): `cooperative_lesson_coach` — `session_kind pair`, `session_id = room_id`;
бюджет — потолок комнаты `room_cap_usd` и месяц (budget.Scope.room), дневной лимит ученика и лимит урока не
применяются. До публикации версии (черновик сида) — `refused: agent_not_active`: lessons ведёт комнату по сценарию с
выбором реплик.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import datetime
from decimal import Decimal
from typing import Any, Final

from sqlalchemy import select, update

from tilhero_ai_gateway.contracts import PAIR_SESSION, output_contract_errors, request_kind
from tilhero_ai_gateway.domain import budget as budgets
from tilhero_ai_gateway.domain import degradation, jsonschema_lite, tiers
from tilhero_ai_gateway.domain.common import usd
from tilhero_ai_gateway.domain.messages import Prompt, build_prompt, first_json_object, sanitize_context
from tilhero_ai_gateway.domain.provider_status import ProviderStatus
from tilhero_ai_gateway.domain.safety import check_output
from tilhero_ai_gateway.models import AgentRollout, AgentRow, AgentVersion, BudgetRow, DeletedUser, ModelRow, UsageRow
from tilhero_ai_gateway.providers import Provider, ProviderError, ProviderRequest, ProviderTimeout
from tilhero_ai_gateway.settings import Settings
from tilhero_common.app import Runtime

log = logging.getLogger("tilhero.ai_gateway.invoke")
MAX_ATTEMPTS = 3
MIN_ATTEMPT_S: Final = 1.5  # до дедлайна вызывающего осталось меньше — попытка не начинается (timeout)
DEADLINE_MARGIN_S: Final = 0.5  # таймаут попытки = min(timeout_ms версии, остаток − 0,5 с): ответ успевает дойти
BILLED_ERRORS: Final = frozenset({"bad_response"})  # HTTP 200, но тело не разобрать — запрос, скорее всего, оплачен

NO_LESSON_CAP_KINDS: Final = frozenset({"memory"})
# Лимиты вида запроса поверх лимитов версии (INTERNAL_API §3.1): (agent_id, request) → (max_output_tokens, timeout_ms)
REQUEST_LIMITS: Final[dict[tuple[str, str], tuple[int, int]]] = {("teaching_coach", "gloss_word"): (200, 6000)}
# Образцовый вывод вида запроса: версия обслуживает вид, только если её схема вывода принимает образец
REQUEST_SAMPLES: Final[dict[tuple[str, str], dict[str, Any]]] = {
    ("teaching_coach", "gloss_word"): {"lemma": "go", "part_of_speech": "verb", "gloss": {"ru": "идти", "uz": "bormoq"},
                                       "forms": ["go", "went"], "confidence": 0.9},
}


@dataclass
class Deps:
    rt: Runtime
    settings: Settings
    provider: Provider
    clock: Callable[[], datetime]
    status: ProviderStatus


@dataclass(frozen=True)
class InvokeRequest:
    agent_id: str
    request_id: uuid.UUID
    session_id: uuid.UUID | None
    session_kind: str | None
    user_id: uuid.UUID | None
    audience: str
    locale: str
    context: dict[str, Any]
    deadline: float | None = None  # time.monotonic() дедлайна вызывающего (deadline_ms от приёма запроса)

    def remaining(self) -> float | None:
        return self.deadline - time.monotonic() if self.deadline is not None else None


@dataclass(frozen=True)
class VersionSnapshot:
    agent_id: str
    version: int
    instructions: str
    rules: str
    output_schema: dict[str, Any]
    schema_version: str
    model_id: str
    fallback_model_id: str | None
    temperature: float
    max_output_tokens: int
    timeout_ms: int
    max_cost_usd: Decimal

    @classmethod
    def of(cls, row: AgentVersion) -> VersionSnapshot:
        return cls(row.agent_id, row.version, row.instructions, row.rules, dict(row.output_schema),
                   row.schema_version, row.model_id, row.fallback_model_id, float(row.temperature),
                   row.max_output_tokens, row.timeout_ms, Decimal(row.max_cost_usd))

    def economy(self) -> VersionSnapshot:
        """Уровень economy (спринт 8): основная модель вызова — резервная модель версии, дальнейшего отката нет; у
        версии без резервной модели — без изменений."""
        if not self.fallback_model_id:
            return self
        return replace(self, model_id=self.fallback_model_id, fallback_model_id=None)

    def for_request(self, context: dict[str, Any]) -> VersionSnapshot:
        """Лимиты вызова с учётом вида запроса: меньшее из лимитов версии и REQUEST_LIMITS."""
        kind = request_kind(self.agent_id, context)
        limits = REQUEST_LIMITS.get((self.agent_id, kind)) if kind is not None else None
        if limits is None:
            return self
        return replace(self, max_output_tokens=min(self.max_output_tokens, limits[0]),
                       timeout_ms=min(self.timeout_ms, limits[1]))


def supports_request(agent_id: str, output_schema: dict[str, Any], context: dict[str, Any]) -> bool:
    """Обслуживает ли версия вид запроса: схема вывода версии принимает образцовый вывод вида (gloss_word)."""
    kind = request_kind(agent_id, context)
    sample = REQUEST_SAMPLES.get((agent_id, kind)) if kind is not None else None
    return sample is None or not jsonschema_lite.validate(sample, output_schema)


@dataclass
class Outcome:
    """Накопленное состояние вызова (попытки, токены, стоимость, нарушения)."""

    attempts: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost: Decimal = Decimal(0)
    violations: list[str] = field(default_factory=list)
    model_id: str | None = None
    output: dict[str, Any] | None = None
    redactions: list[str] = field(default_factory=list)
    failure: str = "provider_error"  # причина последней неудачной попытки у провайдера: provider_error | timeout


def canary_bucket(user_id: str, agent_id: str) -> int:
    """Детерминированная доля ученика 0..99 (INTERNAL_API §1.2)."""
    return int.from_bytes(hashlib.sha256((user_id + agent_id).encode("utf-8")).digest(), "big") % 100


def select_version(rollout: AgentRollout | None, user_id: uuid.UUID | None, agent_id: str) -> tuple[int | None, bool]:
    if rollout is None:
        return None, False
    if rollout.canary_version is not None and rollout.canary_percent > 0 and user_id is not None \
            and canary_bucket(str(user_id), agent_id) < rollout.canary_percent:
        return rollout.canary_version, True
    return rollout.published_version, False


def result(agent_id: str, status: str, reason: str | None, *, version: VersionSnapshot | None = None,
           output: dict[str, Any] | None = None, model_id: str | None = None, canary: bool = False,
           cost: Decimal = Decimal(0), latency_ms: int = 0, warnings: list[str] | None = None) -> dict[str, Any]:
    """AgentInvokeResult (ai.ts)."""
    return {
        "status": status,
        "reason": reason,
        "output": output,
        "agent_id": agent_id,
        "agent_version": version.version if version else None,
        "prompt_version": f"{agent_id}@{version.version}" if version else None,
        "schema_version": version.schema_version if version else None,
        "model_id": model_id,
        "canary": canary,
        "cost_usd": usd(cost),
        "latency_ms": latency_ms,
        "warnings": warnings or [],
    }


def evaluate_text(agent_id: str, text: str, version: VersionSnapshot, context: dict[str, Any],
                  secrets: tuple[str, ...], provider: str | None = None
                  ) -> tuple[dict[str, Any] | None, list[str], list[str]]:
    """Ответ модели → (проверенный вывод | None, нарушения, исправления без повтора). Контракт ai.ts — по виду
    запроса (объединённая схема v2 teaching_coach пропускает обе формы)."""
    data = first_json_object(text)
    if data is None:
        return None, ["not_json"], []
    if jsonschema_lite.validate(data, version.output_schema):
        return None, ["schema_invalid"], []
    if output_contract_errors(agent_id, data, context):
        return None, ["contract_mismatch"], []
    gate = check_output(agent_id, data, context, secrets=secrets, provider=provider)
    if gate.violations:
        return None, gate.violations, []
    return gate.output, [], gate.redactions


def _ms(started: float) -> int:
    return max(0, int((time.perf_counter() - started) * 1000))


async def _record_early(deps: Deps, base: dict[str, Any], status: str, reason: str, started: float,
                        version: int | None = None) -> None:
    async with deps.rt.transaction() as s:
        s.add(UsageRow(**base, version=version, status=status, reason=reason, latency_ms=_ms(started),
                       finished_at=deps.clock()))


async def invoke(deps: Deps, req: InvokeRequest, *, caller: str, version_override: int | None = None,
                 learner_limits: bool = True, emergency_stop_applies: bool = True) -> dict[str, Any]:
    """emergency_stop_applies=False — золотой прогон: аварийная остановка его не блокирует (месячный потолок и
    готовность провайдера — да)."""
    started = time.perf_counter()
    now = deps.clock()
    provider = deps.provider
    call_id = uuid.uuid4()
    async with deps.rt.transaction() as s:
        agent = await s.get(AgentRow, req.agent_id)
        if agent is None:
            raise LookupError(req.agent_id)
        user_id = req.user_id
        if user_id is not None and await s.get(DeletedUser, user_id) is not None:
            user_id = None  # удалённый ученик: учёт без идентификатора
        base: dict[str, Any] = {
            "call_id": call_id, "request_id": req.request_id, "caller": caller[:32], "agent_id": req.agent_id,
            "provider": provider.name, "session_id": req.session_id, "session_kind": req.session_kind,
            "user_id": user_id, "created_at": now,
        }
        budget = await s.get(BudgetRow, 1)
        rollout = await s.get(AgentRollout, req.agent_id)
        version_no, canary = (version_override, False) if version_override is not None \
            else select_version(rollout, req.user_id, req.agent_id)
        row = None
        if version_no is not None:
            row = (await s.execute(select(AgentVersion).where(AgentVersion.agent_id == req.agent_id,
                                                              AgentVersion.version == version_no))).scalar_one_or_none()
        models = {m.model_id: m for m in (await s.execute(select(ModelRow))).scalars().all()}
        free_text = agent.free_text
        # спринт 8: уровень деградации и тариф — только у вызовов учеников (золотой прогон — только потолок месяца)
        level: degradation.LevelState | None = None
        paid = False
        if budget is not None and learner_limits:
            level = await degradation.sync(s, now, budget=budget)
            paid = await tiers.is_paid(s, user_id, now)
    if free_text and req.audience == "kids":
        await _record_early(deps, base, "refused", "kids_not_allowed", started)
        return result(req.agent_id, "refused", "kids_not_allowed", latency_ms=_ms(started))
    if budget is None or (emergency_stop_applies and not budget.ai_enabled) or not provider.ready():
        await _record_early(deps, base, "unavailable", "ai_disabled", started)
        return result(req.agent_id, "unavailable", "ai_disabled", latency_ms=_ms(started))
    refusal = level.refusal(paid) if level is not None else None
    if refusal is not None:
        await _record_early(deps, base, "unavailable", refusal, started)
        return result(req.agent_id, "unavailable", refusal, latency_ms=_ms(started))
    if row is None:
        await _record_early(deps, base, "refused", "agent_not_active", started)
        return result(req.agent_id, "refused", "agent_not_active", latency_ms=_ms(started))

    if not supports_request(req.agent_id, dict(row.output_schema), req.context):
        # версия не обслуживает вид запроса (gloss_word до публикации teaching_coach v2) — без вызова провайдера
        await _record_early(deps, base, "refused", "agent_not_active", started, version=row.version)
        return result(req.agent_id, "refused", "agent_not_active", latency_ms=_ms(started))
    version = VersionSnapshot.of(row).for_request(req.context)
    if level is not None and level.economy_for(paid):
        version = version.economy()
    context = sanitize_context(req.agent_id, req.context)
    async with deps.rt.transaction() as s:
        s.add(UsageRow(**base, version=version.version, status="pending", canary=canary))
    # лимит урока — сумма по session_id занятия; у memory (перевод по тапу) занятия нет: месяц и ученик в день
    # (решение владельца 20.11.2026), дневной session_id memory под лимит урока не попадает; парная комната
    # (спринт 7) — потолок комнаты по session_id = room_id и месяц, без лимитов ученика и урока
    if req.session_kind == PAIR_SESSION:
        scope = budgets.Scope(call_id=call_id, user_id=user_id, session_id=req.session_id,
                              learner_limits=learner_limits, room=learner_limits)
    else:
        lesson_session = req.session_id if req.session_kind not in NO_LESSON_CAP_KINDS else None
        scope = budgets.Scope(call_id=call_id, user_id=user_id, session_id=lesson_session,
                              learner_limits=learner_limits, daily_cap=tiers.daily_cap(budget, paid))
    outcome = Outcome()
    status, reason = await _attempts(deps, req, version, context, models, budget, scope, outcome)
    latency = _ms(started)
    async with deps.rt.transaction() as s:
        await s.execute(update(UsageRow).where(UsageRow.call_id == call_id).values(
            status=status, reason=reason, model_id=outcome.model_id, input_tokens=outcome.input_tokens,
            output_tokens=outcome.output_tokens, cost_usd=outcome.cost, reserved_usd=0, latency_ms=latency,
            attempts=outcome.attempts, finished_at=deps.clock()).execution_options(synchronize_session=False))
    log.info("agent invoked", extra={"agent_id": req.agent_id, "agent_version": version.version, "status": status,
                                     "reason": reason, "attempts": outcome.attempts, "model": outcome.model_id,
                                     "canary": canary, "latency_ms": latency, "caller": caller})
    warnings = [*dict.fromkeys(outcome.violations), *outcome.redactions] if status == "ok" else []
    return result(req.agent_id, status, reason, version=version, output=outcome.output if status == "ok" else None,
                  model_id=outcome.model_id, canary=canary, cost=outcome.cost, latency_ms=latency, warnings=warnings)


def _next_stage(stage: str, *, invalid: bool, has_fallback: bool) -> str | None:
    """primary → retry (только после нарушения в ответе) → fallback; ошибка/таймаут провайдера или лимит → сразу
    fallback; после fallback попыток нет."""
    if stage == "primary" and invalid:
        return "retry"
    if stage != "fallback" and has_fallback:
        return "fallback"
    return None


async def _attempts(deps: Deps, req: InvokeRequest, version: VersionSnapshot, context: dict[str, Any],
                    models: dict[str, ModelRow], budget: BudgetRow, scope: budgets.Scope,
                    outcome: Outcome) -> tuple[str, str | None]:
    provider = deps.provider
    secrets = tuple(s for s in (deps.settings.api_key,) if s)
    constraints: list[str] = []
    stage: str | None = "primary"
    last_failure = "provider_error"
    blocked: str | None = None  # cost_limit | budget_exceeded — последняя попытка не поместилась в лимит
    while stage is not None and outcome.attempts < MAX_ATTEMPTS:
        remaining = req.remaining()
        if remaining is not None and remaining < MIN_ATTEMPT_S:
            return "unavailable", "timeout"  # дедлайн вызывающего: попытку не начинаем
        model_id = version.fallback_model_id if stage == "fallback" else version.model_id
        outcome.attempts += 1
        effective = "fake" if provider.name == "fake" else str(model_id)
        model = models.get(effective)
        invalid = False
        blocked = None
        if model is None or not model.active or model.provider != provider.name:
            last_failure = "provider_error"
        else:
            prompt: Prompt = build_prompt(instructions=version.instructions, rules=version.rules,
                                          output_schema=version.output_schema, schema_version=version.schema_version,
                                          locale=req.locale, context=context, constraints=constraints or None)
            estimate = budgets.estimate_cost(model, input_chars=len(prompt.system) + len(prompt.user),
                                             max_output_tokens=version.max_output_tokens)
            if outcome.cost + estimate > version.max_cost_usd:
                blocked = "cost_limit"  # лимит версии на вызов — накопительно (ревью R1-02)
            else:
                async with deps.rt.transaction() as s:
                    if not await budgets.try_reserve(s, budget, scope, actual=outcome.cost, estimate=estimate,
                                                     now=deps.clock(), tz=deps.settings.timezone):
                        blocked = "budget_exceeded"
            if blocked is None:
                invalid = await _call(deps, req, version, context, model, effective, prompt, estimate, secrets,
                                      outcome)
                if outcome.output is not None:
                    return "ok", None
                if invalid:
                    last_failure = "invalid_output"
                    constraints = list(dict.fromkeys([*constraints, *outcome.violations]))
                else:
                    last_failure = outcome.failure
        stage = _next_stage(stage, invalid=invalid, has_fallback=bool(version.fallback_model_id))
    return "unavailable", blocked or last_failure


async def _call(deps: Deps, req: InvokeRequest, version: VersionSnapshot, context: dict[str, Any], model: ModelRow,
                effective: str, prompt: Prompt, estimate: Decimal, secrets: tuple[str, ...],
                outcome: Outcome) -> bool:
    """Одна попытка у провайдера. True — ответ получен, но отклонён проверками (повод для повтора с ограничениями);
    False — ok (outcome.output) или ошибка провайдера (outcome.failure)."""
    timeout_s = version.timeout_ms / 1000
    remaining = req.remaining()
    if remaining is not None:
        timeout_s = max(0.1, min(timeout_s, remaining - DEADLINE_MARGIN_S))
    outcome.model_id = effective
    try:
        async with asyncio.timeout(timeout_s):
            response = await deps.provider.complete(ProviderRequest(
                agent_id=req.agent_id, model_id=effective, system=prompt.system, user=prompt.user,
                max_tokens=version.max_output_tokens, temperature=version.temperature, timeout_s=timeout_s))
    except (TimeoutError, ProviderTimeout):
        outcome.failure = "timeout"
        outcome.cost += estimate  # запрос мог быть обработан и оплачен — консервативно оценка (ревью R1-08)
        await deps.status.record_error("timeout", deps.clock())
        return False
    except ProviderError as exc:
        outcome.failure = "provider_error"
        if exc.code in BILLED_ERRORS:
            outcome.cost += estimate  # HTTP 200 с неразборчивым телом — оплачено (ревью R1-08)
        await deps.status.record_error(exc.code, deps.clock())
        return False
    except Exception as exc:  # провайдер не должен ронять вызов: ученик продолжает без ИИ
        outcome.failure = "provider_error"
        log.warning("provider failed", extra={"error_type": type(exc).__name__})
        await deps.status.record_error("unexpected", deps.clock())
        return False
    outcome.input_tokens += response.input_tokens
    outcome.output_tokens += response.output_tokens
    outcome.cost += budgets.actual_cost(model, response.input_tokens, response.output_tokens)
    output, violations, redactions = evaluate_text(req.agent_id, response.text, version, context, secrets,
                                                   deps.provider.name)
    if output is not None:
        outcome.output = output
        outcome.redactions = redactions
        return False
    outcome.violations.extend(violations)
    return True
