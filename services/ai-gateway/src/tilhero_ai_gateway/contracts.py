"""Контексты и выводы агентов спринта, золотые проверки, оценка произношения — pydantic-модели, повторяющие
`packages/contracts/src/ai.ts` 1:1 (контрактный тест tests/test_gw_contract.py сверяет поля и перечисления).

Контексты (вход вызова и золотого кейса) проверяются с `extra="forbid"`; длинная реплика ученика не отклоняется, а
обрезается до 500 символов при сборке сообщения (INTERNAL_API §1.2). Выводы — строгие (`strict`): то, что вернула
модель, не приводится к типам «по-доброму» («3» ≠ 3) — нарушение контракта = повтор с ограничениями.

`teaching_coach` (спринт 5) — два вида запроса с одним agent_id: `simpler_example | explain_again`
(TeachingCoachContext → TeachingCoachOutput) и `gloss_word` (TeachingCoachGlossContext → TeachingCoachGlossOutput).
Вид выбирается по `context.request`; контракт вывода — по виду запроса (схема версии v2 — объединённая, anyOf).

Спринт 7 (INTERNAL_API §4): `cooperative_lesson_coach` — CooperativeCoachContext → CooperativeCoachOutput (участники
только ролями A/B: ни user_id, ни ников, ни имён); распознавание голосового хода парной комнаты — SpeechTranscribeMeta
→ SpeechTranscribeResult; `SessionKind` + `duel` (ИИ не вызывается — для полноты), `AiSessionKind` + `pair`.
"""

from __future__ import annotations

import re
import unicodedata
import uuid
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
# спринт 7: + duel — задания дуэли (ИИ не вызывается, вид — для полноты контракта)
SessionKind = Literal["lesson", "scenario", "media", "review", "reading", "duel"]
# ai.ts AiSessionKind = SessionKind | "memory" | "pair" (memory — перевод по тапу и произношение; pair — парная комната,
# session_id = room_id, только cooperative_lesson_coach)
AiSessionKind = Literal["lesson", "scenario", "media", "review", "reading", "duel", "memory", "pair"]
PAIR_SESSION: Final = "pair"
# виды сессии, в которых ИИ не вызывается (дуэль — закрытые задания по ключу без подсказок и ИИ)
NO_AI_SESSION_KINDS: Final = frozenset({"duel"})
COACH_AGENT: Final = "cooperative_lesson_coach"
AgentImplementation = Literal["llm", "rules", "code"]
AgentVersionStatus = Literal["draft", "published", "archived"]
# спринт 8: + degraded — уровень paid_only, ученик без подписки (tier free) не обслуживается (до провайдера, $0)
AgentUnavailableReason = Literal["ai_disabled", "not_configured", "budget_exceeded", "cost_limit", "provider_error",
                                 "timeout", "invalid_output", "degraded"]
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


GLOSS_REQUEST: Final = "gloss_word"
PartOfSpeech = Literal["noun", "verb", "adjective", "adverb", "pronoun", "preposition", "conjunction", "interjection",
                       "determiner", "phrase", "other"]
_APOSTROPHES = str.maketrans({"’": "'", "‘": "'", "`": "'", "ʼ": "'", "ʻ": "'"})
WORD_EDGES: Final = " .,!?…:;\"'«»“”„()[]—–-"


def norm_text(value: str) -> str:
    """Нормализация для сравнения слова с предложением (как §1.6 memory): NFC, нижний регистр, апострофы → ',
    пробелы схлопнуты."""
    text = unicodedata.normalize("NFC", value).translate(_APOSTROPHES).lower()
    return " ".join(text.split())


class TeachingCoachGlossContext(BaseModel):
    """Перевод слова из опубликованного контента (вызывающий memory; INTERNAL_API §3.1). Слово обязано встречаться в
    sentence_en (защита в глубину: memory проверяет «слово есть в контенте» через catalog) — иначе 422."""

    model_config = _IN
    request: Literal["gloss_word"]
    word: Annotated[str, Field(min_length=1, max_length=60)]
    sentence_en: Annotated[str, Field(min_length=1, max_length=300)]
    level: Band
    content_kind: Literal["lesson", "media_asset", "reading", "scenario"]

    @model_validator(mode="after")
    def _word_in_sentence(self) -> TeachingCoachGlossContext:
        # как §1.6: концевая пунктуация и кавычки по краям слова не мешают («book.» в «… to book.»)
        word = norm_text(self.word).strip(WORD_EDGES)
        if not word or CONTROL_RE.search(self.word):
            raise ValueError("word — непустое слово без управляющих символов")
        if word not in norm_text(self.sentence_en):
            raise ValueError("word не встречается в sentence_en")
        return self


class GlossPair(BaseModel):
    model_config = _OUT
    ru: str = Field(min_length=1, max_length=80)
    uz: str = Field(min_length=1, max_length=80)


class TeachingCoachGlossOutput(BaseModel):
    model_config = _OUT
    lemma: str = Field(min_length=1, max_length=60)
    part_of_speech: PartOfSpeech
    gloss: GlossPair
    forms: list[Annotated[str, Field(min_length=1, max_length=60)]] = Field(max_length=6)
    confidence: float = Field(ge=0, le=1)


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


# ---------------------------------------------------------------- cooperative_lesson_coach (спринт 7, скилл 11)

CoachRole = Literal["A", "B"]
CoachTrigger = Literal["start", "turn", "silence", "partner_offline", "partner_back", "wrap_up", "end"]
COACH_TURNS_MAX: Final = 12  # последние ≤ 12 реплик комнаты (ai.ts)
SafetyFlag = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,31}$")]


class CoachScenario(BaseModel):
    model_config = _IN
    scenario_id: Id
    title_en: Short
    task_en: Line
    level: Band
    characters: list[Character] = Field(max_length=10)
    completion_criteria_en: Line


class CoachParticipant(BaseModel):
    model_config = _IN
    role: CoachRole
    turns: int = Field(ge=0, le=500)
    speaking_seconds: int = Field(ge=0, le=7200)
    network: Literal["online", "offline"]
    voice: bool


class CoachRoles(BaseModel):
    model_config = _IN
    A: Annotated[str, Field(min_length=1, max_length=120)]
    B: Annotated[str, Field(min_length=1, max_length=120)]


class CoachTurn(BaseModel):
    model_config = _IN
    turn_id: Id
    speaker: Literal["A", "B", "coach"]
    text: RawText
    mode: Literal["text", "voice", "choice"] | None


class CooperativeCoachContext(BaseModel):
    """Вход коуча парного урока (ai.ts CooperativeCoachContext). Участники — только роли A/B; роли уникальны;
    реплики — последние ≤ 12, turn_id уникальны, реплика участника — от роли, которая есть в комнате."""

    model_config = _IN
    room_id: uuid.UUID
    pair_id: Id
    scenario: CoachScenario
    mode: Literal["free", "choices"]
    trigger: CoachTrigger
    participants: list[CoachParticipant] = Field(min_length=1, max_length=2)
    roles: CoachRoles | None
    team_goal_en: Annotated[str, Field(min_length=1, max_length=200)] | None
    team_goal_progress: float = Field(ge=0, le=1)
    turns: list[CoachTurn] = Field(max_length=COACH_TURNS_MAX)
    remaining_minutes: float = Field(ge=0, le=120)
    safety_flags: list[SafetyFlag] = Field(max_length=10)

    @model_validator(mode="after")
    def _consistent(self) -> CooperativeCoachContext:
        roles = [p.role for p in self.participants]
        if len(set(roles)) != len(roles):
            raise ValueError("роли участников должны быть уникальны")
        ids = [t.turn_id for t in self.turns]
        if len(set(ids)) != len(ids):
            raise ValueError("turn_id реплик должны быть уникальны")
        if any(t.speaker != "coach" and t.speaker not in roles for t in self.turns):
            raise ValueError("реплика участника — только от роли, которая есть в комнате")
        return self


class CoachGloss(BaseModel):
    model_config = _OUT
    ru: str = Field(min_length=1, max_length=300)
    uz: str = Field(min_length=1, max_length=300)


class CoachOption(BaseModel):
    model_config = _OUT
    choice_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")
    text_en: str = Field(min_length=1, max_length=160)


class CoachRolesOut(BaseModel):
    model_config = _OUT
    A: str = Field(min_length=1, max_length=120)
    B: str = Field(min_length=1, max_length=120)


class CoachEvidence(BaseModel):
    model_config = _OUT
    role: CoachRole
    turn_id: str = Field(min_length=1, max_length=64)
    skill_id: str | None = Field(max_length=64)
    assist_used: bool


class CoachLocalized(BaseModel):
    model_config = _OUT
    ru: str = Field(min_length=1, max_length=200)
    uz: str = Field(min_length=1, max_length=200)


class CoachTipText(BaseModel):
    model_config = _OUT
    ru: str = Field(min_length=1, max_length=160)
    uz: str = Field(min_length=1, max_length=160)


class CoachTip(BaseModel):
    model_config = _OUT
    role: CoachRole
    text: CoachTipText


class CoachReport(BaseModel):
    model_config = _OUT
    team_summary: CoachLocalized
    tips: list[CoachTip] = Field(max_length=6)


class CooperativeCoachOutput(BaseModel):
    """Вывод коуча (ai.ts CooperativeCoachOutput) — строго; согласованность полей со статусом и триггером проверяет
    safety_quality_gate (domain/safety.py)."""

    model_config = _OUT
    room_id: str = Field(min_length=1, max_length=64)
    status: Literal["in_progress", "paused", "fallback_text", "finished"]
    next_speaker: Literal["A", "B", "both"] | None
    prompt: str = Field(min_length=1, max_length=300)
    prompt_gloss: CoachGloss | None
    options: list[CoachOption] | None = Field(max_length=3)
    roles: CoachRolesOut | None
    team_goal_en: str | None = Field(min_length=1, max_length=200)
    team_goal_progress: float = Field(ge=0, le=1)
    individual_evidence: list[CoachEvidence] = Field(max_length=24)
    escalation: Literal["safety", "abuse"] | None
    report: CoachReport | None


# ---------------------------------------------------------------- реестр контрактов по агенту

CONTEXT_MODELS: Final[dict[str, type[BaseModel]]] = {
    "conversation_partner": ConversationPartnerContext,
    "teaching_coach": TeachingCoachContext,
    "independent_evaluator": IndependentEvaluatorContext,
    "cooperative_lesson_coach": CooperativeCoachContext,
}
OUTPUT_MODELS: Final[dict[str, type[BaseModel]]] = {
    "conversation_partner": ConversationPartnerOutput,
    "teaching_coach": TeachingCoachOutput,
    "independent_evaluator": IndependentEvaluatorOutput,
    "cooperative_lesson_coach": CooperativeCoachOutput,
}
# Вид запроса агента с несколькими контрактами (agent_id, context.request) → контекст и вывод
REQUEST_MODELS: Final[dict[tuple[str, str], tuple[type[BaseModel], type[BaseModel]]]] = {
    ("teaching_coach", GLOSS_REQUEST): (TeachingCoachGlossContext, TeachingCoachGlossOutput),
}


def request_kind(agent_id: str, context: Any) -> str | None:
    """Вид запроса с отдельным контрактом (`gloss_word`) или None — основной контракт агента."""
    if isinstance(context, dict):
        request = context.get("request")
        if isinstance(request, str) and (agent_id, request) in REQUEST_MODELS:
            return request
    return None


def context_model(agent_id: str, context: Any) -> type[BaseModel] | None:
    kind = request_kind(agent_id, context)
    return REQUEST_MODELS[(agent_id, kind)][0] if kind is not None else CONTEXT_MODELS.get(agent_id)


def output_model(agent_id: str, context: Any) -> type[BaseModel] | None:
    kind = request_kind(agent_id, context)
    return REQUEST_MODELS[(agent_id, kind)][1] if kind is not None else OUTPUT_MODELS.get(agent_id)


def error_list(exc: ValidationError, prefix: str = "") -> list[dict[str, str]]:
    """Ошибки pydantic без входных значений (в них может быть текст ученика)."""
    out = []
    for e in exc.errors(include_url=False, include_input=False)[:30]:
        loc = ".".join(str(p) for p in e.get("loc", ()))
        out.append({"path": f"{prefix}{loc}" if loc else prefix.rstrip("."), "message": str(e.get("msg", ""))[:200]})
    return out


def validate_context(agent_id: str, context: Any) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    """Контекст агента по ai.ts → (нормализованный dict, ошибки). Агент без контракта — контекст как есть (объект).
    teaching_coach: `request: gloss_word` — TeachingCoachGlossContext, иначе TeachingCoachContext."""
    model = context_model(agent_id, context)
    if model is None:
        if isinstance(context, dict):
            return context, []
        return None, [{"path": "context", "message": "ожидается объект"}]
    try:
        return model.model_validate(context).model_dump(mode="json"), []
    except ValidationError as exc:
        return None, error_list(exc, "context.")


def output_contract_errors(agent_id: str, output: Any, context: Any = None) -> list[str]:
    """Вывод по контракту ai.ts для вида запроса (схема версии v2 teaching_coach — объединённая: вывод «не того» вида
    проходит схему, но не контракт → повтор с ограничениями)."""
    model = output_model(agent_id, context)
    if model is None:
        return []
    try:
        model.model_validate(output)
    except ValidationError as exc:
        return [f"{e['path']}: {e['message']}" for e in error_list(exc)]
    return []


# ---------------------------------------------------------------- оценка произношения (ai.ts SpeechAssessMeta, …)

PronunciationErrorType = Literal["none", "omission", "insertion", "mispronunciation"]


def _reference(value: str) -> str:
    text = " ".join(value.split())
    if not text or CONTROL_RE.search(text):
        raise ValueError("reference_text — 1..200 символов без управляющих символов")
    return text


class SpeechAssessMeta(BaseModel):
    """Заголовок X-Speech-Meta = base64url(JSON) — эталон и ученик (подставляет memory: текст только из контента или
    карточки)."""

    model_config = _IN
    request_id: uuid.UUID
    user_id: uuid.UUID
    audience: AudienceSegment
    locale: Literal["ru", "uz"]
    reference_text: Annotated[str, Field(min_length=1, max_length=200), AfterValidator(_reference)]
    language: Literal["en-US"]


class PronunciationScores(BaseModel):
    model_config = _OUT
    accuracy: float = Field(ge=0, le=100)
    fluency: float = Field(ge=0, le=100)
    completeness: float = Field(ge=0, le=100)
    pron: float = Field(ge=0, le=100)


class PronunciationWord(BaseModel):
    model_config = _OUT
    word: str = Field(min_length=1, max_length=60)
    accuracy: float | None = Field(ge=0, le=100)
    error_type: PronunciationErrorType


class PronunciationTip(BaseModel):
    model_config = _OUT
    word: str = Field(min_length=1, max_length=60)
    text: str = Field(min_length=1, max_length=200)


class PronunciationResult(BaseModel):
    """Ответ POST /internal/v1/speech/pronunciation (ai.ts PronunciationResult) — проверяется перед отдачей."""

    model_config = _OUT
    status: Literal["ok", "insufficient_evidence", "unavailable"]
    reason: str | None
    reference_text: str
    scores: PronunciationScores | None
    words: list[PronunciationWord] = Field(max_length=40)
    intelligibility: Literal["clear", "mostly_clear", "needs_practice"] | None
    tips: list[PronunciationTip] = Field(max_length=2)
    confidence: float | None = Field(ge=0, le=1)
    audio_ms: int = Field(ge=0)
    provider: Literal["whisper", "azure_speech", "fake_speech"] | None
    cost_usd: float = Field(ge=0)
    latency_ms: int = Field(ge=0)


# ---------------------------------------------------------------- контроль ИИ (спринт 8, ai.ts, INTERNAL_API §7)


def _plain_reason(value: str) -> str:
    value = value.strip()
    if CONTROL_RE.search(value):
        raise ValueError("недопустимые символы")
    if len(value) < 10:
        raise ValueError("причина — от 10 символов")
    return value


DegradationLevel = Literal["normal", "economy", "paid_only", "off"]
DegradationMode = Literal["auto", "manual"]
DegradationReason = Literal["threshold", "manual", "emergency_stop", "month_reset"]
LearnerTierLit = Literal["free", "paid"]


class AiStatus(BaseModel):
    """GET /internal/v1/status (ai.ts AiStatus); спринт 8 — действующий уровень деградации и доступность ИИ ученику
    без подписки (free_available: normal | economy) и подписчику (paid_available: + paid_only)."""

    model_config = _OUT
    ai_available: bool
    speech_available: bool
    level: DegradationLevel
    free_available: bool
    paid_available: bool


class DegradationEvent(BaseModel):
    """ai.ts DegradationEvent — смена действующего уровня (journal degradation_events)."""

    model_config = _OUT
    seq: int
    from_: DegradationLevel = Field(alias="from")
    to: DegradationLevel
    mode: DegradationMode
    reason: DegradationReason
    spent_percent: float = Field(ge=0, le=1000)
    actor: str | None
    at: str


class AiDegradation(BaseModel):
    """GET /admin/v1/ai/degradation (costs.read) → ai.ts AiDegradation."""

    model_config = _OUT
    mode: DegradationMode
    manual_level: DegradationLevel | None
    level: DegradationLevel
    economy_at_percent: int = Field(ge=1, le=100)
    paid_only_at_percent: int = Field(ge=1, le=100)
    spent_percent: float = Field(ge=0, le=1000)
    month: str
    events: list[DegradationEvent] = Field(max_length=20)
    updated_at: str


class AiDegradationUpdate(BaseModel):
    """PUT /admin/v1/ai/degradation (costs.manage, step-up) — ai.ts AiDegradationUpdate. Согласованность (пороги,
    manual_level при manual) проверяет домен: 422 DEGRADATION_INVALID {fields}."""

    model_config = _IN
    mode: DegradationMode
    manual_level: DegradationLevel | None
    economy_at_percent: int
    paid_only_at_percent: int
    reason: Annotated[str, AfterValidator(_plain_reason), Field(min_length=10, max_length=500)]


class AiUnitCostsKind(BaseModel):
    """ai.ts AiUnitCostsKind — стоимость занятий одного вида за период; USD — строки с 6 знаками."""

    model_config = _OUT
    sessions: int = Field(ge=0)
    ai_sessions: int = Field(ge=0)
    cost_usd: str
    cost_per_ai_session_p50_usd: str | None
    cost_per_ai_session_p95_usd: str | None
    billable_minutes: int = Field(ge=0)
    cost_per_billable_minute_usd: str | None


class AiUnitCostsByKind(BaseModel):
    model_config = _OUT
    lesson: AiUnitCostsKind
    scenario: AiUnitCostsKind
    pair: AiUnitCostsKind


class AiUnitCosts(BaseModel):
    """GET /admin/v1/ai/unit-costs?period=week|month (costs.read | dashboard.read) → ai.ts AiUnitCosts."""

    model_config = _OUT
    period: Literal["week", "month"]
    from_: str = Field(alias="from")
    to: str
    by_kind: AiUnitCostsByKind
    degraded_sessions_pct: float | None = Field(ge=0, le=100)


# ---------------------------------------------------------------- speech:transcribe (спринт 7, ai.ts)

TRANSCRIBE_TEXT_MAX: Final = 600
TRANSCRIBE_WORDS_MAX: Final = 120


class SpeechTranscribeMeta(BaseModel):
    """Заголовок X-Speech-Meta = base64url(JSON) голосового хода парной комнаты (вызывающий — только lessons)."""

    model_config = _IN
    request_id: uuid.UUID
    user_id: uuid.UUID
    room_id: uuid.UUID
    audience: AudienceSegment
    language: Literal["en-US"]


class TranscribeWord(BaseModel):
    model_config = _OUT
    word: str = Field(min_length=1, max_length=60)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)


class SpeechTranscribeResult(BaseModel):
    """Ответ POST /internal/v1/speech:transcribe (ai.ts SpeechTranscribeResult) — проверяется перед отдачей."""

    model_config = _OUT
    text: str = Field(max_length=TRANSCRIBE_TEXT_MAX)
    words: list[TranscribeWord] = Field(max_length=TRANSCRIBE_WORDS_MAX)
    duration_ms: int = Field(ge=0)
    provider: Literal["whisper", "fake_speech"]
    latency_ms: int = Field(ge=0)


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
