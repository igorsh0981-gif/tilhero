"""Контексты и выводы агентов спринта, золотые проверки — pydantic-модели, повторяющие `packages/contracts/src/ai.ts`
1:1 (контрактный тест tests/test_gw_contract.py сверяет поля и перечисления).

Контексты (вход вызова и золотого кейса) проверяются с `extra="forbid"`; длинная реплика ученика не отклоняется, а
обрезается до 500 символов при сборке сообщения (INTERNAL_API §1.2). Выводы — строгие (`strict`): то, что вернула
модель, не приводится к типам «по-доброму» («3» ≠ 3) — нарушение контракта = повтор с ограничениями.
"""

from __future__ import annotations

import re
from typing import Annotated, Any, Final, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, model_validator

_IN = ConfigDict(extra="forbid")
_OUT = ConfigDict(extra="forbid", strict=True)

AgentIdLit = Literal[
    "learning_orchestrator", "diagnostic_assessor", "curriculum_planner", "teaching_coach", "conversation_partner",
    "independent_evaluator", "error_analyst", "spaced_repetition_coach", "pronunciation_coach", "evening_review_coach",
    "safety_quality_gate", "cooperative_lesson_coach", "gameplay_director", "duel_host", "referral_integrity_reviewer",
    "media_lesson_designer", "language_pathway_advisor",
]
Band = Literal["A0", "A1", "A2", "B1", "B2"]
AudienceSegment = Literal["kids", "teens", "adults"]
SessionKind = Literal["lesson", "scenario", "media", "review"]
AgentImplementation = Literal["llm", "rules", "code"]
AgentVersionStatus = Literal["draft", "published", "archived"]
AgentUnavailableReason = Literal["ai_disabled", "budget_exceeded", "cost_limit", "provider_error", "timeout",
                                 "invalid_output"]
AgentRefusedReason = Literal["kids_not_allowed", "agent_not_active"]
RubricCriterionCode = Literal["task", "vocabulary", "grammar", "independence", "pronunciation", "fluency",
                              "comprehension"]
RESERVED_INTENTS: Final = frozenset({"unclear", "off_topic"})
LEARNER_TURN_MAX: Final = 500  # реплика ученика уходит модели не длиннее (INTERNAL_API §1.2)
RAW_TEXT_MAX: Final = 4000  # больше — уже не реплика, а вброс: 422
CONTROL_RE: Final = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f​-‏‪-‮⁠-⁩﻿]")

Id = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")]
Short = Annotated[str, Field(min_length=1, max_length=200)]
Line = Annotated[str, Field(min_length=1, max_length=600)]
RawText = Annotated[str, Field(max_length=RAW_TEXT_MAX)]


# ---------------------------------------------------------------- conversation_partner


class Character(BaseModel):
    model_config = _IN
    id: Id
    name: Short
    role_en: Short


class ScenarioRef(BaseModel):
    model_config = _IN
    scenario_id: Id
    title_en: Short
    task_en: Line
    level: Band
    characters: list[Character] = Field(max_length=10)


def _intent(value: str) -> str:
    if value in RESERVED_INTENTS:
        raise ValueError("unclear и off_topic зарезервированы для вывода агента")
    return value


class Transition(BaseModel):
    model_config = _IN
    intent: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9_.-]{0,63}$"), AfterValidator(_intent)]
    description_en: Line
    examples_en: list[Line] = Field(min_length=1, max_length=12)


class NodeRef(BaseModel):
    model_config = _IN
    node_id: Id
    speaker: Short
    line_en: Line
    transitions: list[Transition] = Field(min_length=1, max_length=12)

    @model_validator(mode="after")
    def _unique_intents(self) -> NodeRef:
        intents = [t.intent for t in self.transitions]
        if len(set(intents)) != len(intents):
            raise ValueError("intent переходов узла должны быть уникальны")
        return self


class HistoryTurn(BaseModel):
    model_config = _IN
    speaker: Literal["learner", "character"]
    text: RawText


class ConversationPartnerContext(BaseModel):
    model_config = _IN
    scenario: ScenarioRef
    node: NodeRef
    history: list[HistoryTurn] = Field(max_length=6)
    learner_turn: Annotated[str, Field(min_length=1, max_length=RAW_TEXT_MAX)]
    attempts_on_node: int = Field(ge=0, le=100)


class ConversationPartnerOutput(BaseModel):
    model_config = _OUT
    intent: str = Field(min_length=1, max_length=64)
    reply_en: str = Field(min_length=1, max_length=240)
    hint_offered: bool


# ---------------------------------------------------------------- teaching_coach


class LessonRef(BaseModel):
    model_config = _IN
    lesson_id: Id
    title_en: Short
    goal_en: Line
    level: Band
    key_words: list[Short] = Field(max_length=30)
    examples_en: list[Line] = Field(min_length=1, max_length=30)


class TeachingCoachContext(BaseModel):
    model_config = _IN
    lesson: LessonRef
    request: Literal["simpler_example", "explain_again"]
    explain_locale: Literal["ru", "uz"]
    already_shown: list[Line] = Field(max_length=30)


class TeachingCoachOutput(BaseModel):
    model_config = _OUT
    explanation: str = Field(min_length=1, max_length=400)
    example_en: str = Field(min_length=1, max_length=160)
    example_gloss: str = Field(min_length=1, max_length=200)


# ---------------------------------------------------------------- independent_evaluator


class Band4(BaseModel):
    model_config = _IN
    score: Literal[0, 1, 2, 3]
    descriptor_en: Line


class Criterion(BaseModel):
    model_config = _IN
    code: RubricCriterionCode
    weight: float = Field(ge=0, le=10)
    bands: list[Band4] = Field(min_length=1, max_length=4)


class PassRule(BaseModel):
    model_config = _IN
    min_weighted: float = Field(ge=0, le=3)
    min_per_criterion: Literal[0, 1, 2]


class RubricRef(BaseModel):
    model_config = _IN
    rubric_id: Id
    version: int = Field(ge=1)
    criteria: list[Criterion] = Field(min_length=1, max_length=7)
    pass_rule: PassRule

    @model_validator(mode="after")
    def _unique_codes(self) -> RubricRef:
        codes = [c.code for c in self.criteria]
        if len(set(codes)) != len(codes):
            raise ValueError("критерии рубрики должны быть уникальны")
        return self


class TaskRef(BaseModel):
    model_config = _IN
    goal_en: Line
    completion_criteria_en: Line
    outcome: Literal["success", "alt_success", "fail"] | None


class EvalTurn(BaseModel):
    model_config = _IN
    turn_id: Id
    speaker: Literal["learner", "character", "task"]
    text: RawText


class HintUsage(BaseModel):
    model_config = _IN
    count: int = Field(ge=0, le=100)
    turn_ids: list[Id] = Field(max_length=100)


class IndependentEvaluatorContext(BaseModel):
    model_config = _IN
    rubric: RubricRef
    task: TaskRef
    turns: list[EvalTurn] = Field(max_length=80)
    hint_usage: HintUsage
    cefr_target: Band

    @model_validator(mode="after")
    def _unique_turns(self) -> IndependentEvaluatorContext:
        ids = [t.turn_id for t in self.turns]
        if len(set(ids)) != len(ids):
            raise ValueError("turn_id реплик должны быть уникальны")
        return self


class ConfirmedError(BaseModel):
    model_config = _OUT
    turn_id: str = Field(min_length=1, max_length=64)
    evidence: str = Field(min_length=1, max_length=120)
    correction: str = Field(min_length=1, max_length=200)
    error_code: str = Field(pattern=r"^[a-z0-9][a-z0-9_]{0,47}$")
    severity: Literal["low", "medium", "high"]


class IndependentEvaluatorOutput(BaseModel):
    model_config = _OUT
    status: Literal["ok", "insufficient_evidence"]
    scores: dict[RubricCriterionCode, Literal[0, 1, 2, 3] | None]
    task_completed: bool | None
    confirmed_errors: list[ConfirmedError] = Field(max_length=5)
    support_used: bool
    confidence: float = Field(ge=0, le=1)
    pronunciation_score: None
    cefr_certificate: Literal[False]
    requires_human_review: bool


# ---------------------------------------------------------------- реестр контрактов по агенту

CONTEXT_MODELS: Final[dict[str, type[BaseModel]]] = {
    "conversation_partner": ConversationPartnerContext,
    "teaching_coach": TeachingCoachContext,
    "independent_evaluator": IndependentEvaluatorContext,
}
OUTPUT_MODELS: Final[dict[str, type[BaseModel]]] = {
    "conversation_partner": ConversationPartnerOutput,
    "teaching_coach": TeachingCoachOutput,
    "independent_evaluator": IndependentEvaluatorOutput,
}


def error_list(exc: ValidationError, prefix: str = "") -> list[dict[str, str]]:
    """Ошибки pydantic без входных значений (в них может быть текст ученика)."""
    out = []
    for e in exc.errors(include_url=False, include_input=False)[:30]:
        loc = ".".join(str(p) for p in e.get("loc", ()))
        out.append({"path": f"{prefix}{loc}" if loc else prefix.rstrip("."), "message": str(e.get("msg", ""))[:200]})
    return out


def validate_context(agent_id: str, context: Any) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    """Контекст агента по ai.ts → (нормализованный dict, ошибки). Агент без контракта — контекст как есть (объект)."""
    model = CONTEXT_MODELS.get(agent_id)
    if model is None:
        if isinstance(context, dict):
            return context, []
        return None, [{"path": "context", "message": "ожидается объект"}]
    try:
        return model.model_validate(context).model_dump(mode="json"), []
    except ValidationError as exc:
        return None, error_list(exc, "context.")


def output_contract_errors(agent_id: str, output: Any) -> list[str]:
    model = OUTPUT_MODELS.get(agent_id)
    if model is None:
        return []
    try:
        model.model_validate(output)
    except ValidationError as exc:
        return [f"{e['path']}: {e['message']}" for e in error_list(exc)]
    return []


# ---------------------------------------------------------------- тело версии (ai.ts AgentVersion, AgentVersionPatch)

ModelId = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]{1,63}$")]


class AgentVersionBody(BaseModel):
    """Поля версии, задаваемые автором (сид `agents/<agent_id>.v1.json` и черновик)."""

    model_config = _IN
    instructions: str = Field(max_length=20_000)
    rules: str = Field(max_length=10_000)
    output_schema: dict[str, Any]
    schema_version: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$")
    model_id: ModelId
    fallback_model_id: ModelId | None = None
    temperature: float = Field(ge=0, le=1)
    max_output_tokens: int = Field(ge=1, le=2000)
    timeout_ms: int = Field(ge=2000, le=30_000)
    max_cost_usd: float = Field(ge=0, le=10)
    notes: str | None = Field(default=None, max_length=2000)


class AgentVersionPatch(BaseModel):
    """admin.ts AgentVersionPatch — любое подмножество полей тела версии."""

    model_config = _IN
    instructions: str | None = Field(default=None, max_length=20_000)
    rules: str | None = Field(default=None, max_length=10_000)
    output_schema: dict[str, Any] | None = None
    schema_version: str | None = Field(default=None, pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$")
    model_id: ModelId | None = None
    fallback_model_id: ModelId | None = None
    temperature: float | None = Field(default=None, ge=0, le=1)
    max_output_tokens: int | None = Field(default=None, ge=1, le=2000)
    timeout_ms: int | None = Field(default=None, ge=2000, le=30_000)
    max_cost_usd: float | None = Field(default=None, ge=0, le=10)
    notes: str | None = Field(default=None, max_length=2000)


# ---------------------------------------------------------------- золотые тесты (ai.ts GoldenCheck, GoldenCase.input)

_SEGMENT = re.compile(r"^(?:[A-Za-z0-9_]{1,64}|\*)$")
Scalar = str | int | float | bool | None


def _path(value: str) -> str:
    """dot-path от корня AgentInvokeResult (ai.ts GoldenCheck): `status`, `reason`, `output.intent`,
    `output.confirmed_errors.0.evidence`; элемент массива — индекс; `*` — все элементы (расширение админки)."""
    parts = value.split(".")
    if len(parts) > 8 or not all(_SEGMENT.match(p) for p in parts):
        raise ValueError("путь — сегменты [A-Za-z0-9_] (или *) через точку, не больше 8")
    return value


CheckPath = Annotated[str, Field(min_length=1, max_length=200), AfterValidator(_path)]


class CheckSchemaValid(BaseModel):
    model_config = _IN
    kind: Literal["schema_valid"]


class CheckFieldEquals(BaseModel):
    model_config = _IN
    kind: Literal["field_equals"]
    path: CheckPath
    value: Scalar


class CheckFieldIn(BaseModel):
    model_config = _IN
    kind: Literal["field_in"]
    path: CheckPath
    values: list[Scalar] = Field(min_length=1, max_length=50)


class CheckFieldAbsent(BaseModel):
    model_config = _IN
    kind: Literal["field_absent"]
    path: CheckPath


class CheckTextNotContains(BaseModel):
    model_config = _IN
    kind: Literal["text_not_contains"]
    path: CheckPath
    values: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(min_length=1, max_length=50)


class CheckMaxLength(BaseModel):
    model_config = _IN
    kind: Literal["max_length"]
    path: CheckPath
    n: int = Field(ge=0, le=100_000)


GoldenCheck = Annotated[
    CheckSchemaValid | CheckFieldEquals | CheckFieldIn | CheckFieldAbsent | CheckTextNotContains | CheckMaxLength,
    Field(discriminator="kind"),
]
CHECKS_ADAPTER: Final = TypeAdapter(list[GoldenCheck])


class GoldenInput(BaseModel):
    model_config = _IN
    audience: AudienceSegment
    context: dict[str, Any]


def validate_golden(agent_id: str, raw_input: Any, raw_checks: Any) -> tuple[dict[str, Any] | None,
                                                                              list[dict[str, Any]] | None,
                                                                              list[dict[str, str]]]:
    """Вход и проверки золотого кейса → (input, checks, ошибки): контекст — по ai.ts агента, проверки — GoldenCheck."""
    errors: list[dict[str, str]] = []
    norm_input: dict[str, Any] | None = None
    norm_checks: list[dict[str, Any]] | None = None
    try:
        gi = GoldenInput.model_validate(raw_input)
        context, ctx_errors = validate_context(agent_id, gi.context)
        if ctx_errors:
            errors.extend({"path": f"input.{e['path']}", "message": e["message"]} for e in ctx_errors)
        else:
            norm_input = {"audience": gi.audience, "context": context}
    except ValidationError as exc:
        errors.extend(error_list(exc, "input."))
    if not isinstance(raw_checks, list) or not 1 <= len(raw_checks) <= 50:
        errors.append({"path": "checks", "message": "от 1 до 50 проверок"})
    else:
        try:
            norm_checks = [c.model_dump(mode="json") for c in CHECKS_ADAPTER.validate_python(raw_checks)]
        except ValidationError as exc:
            errors.extend(error_list(exc, "checks."))
    if errors:
        return None, None, errors
    return norm_input, norm_checks, []
