"""Формы API assessment.

- Вход оценки (`EvaluationRequest`, INTERNAL_API §3.2) — от lessons: ссылки на версии контента и ответы ученика
  **без правильности** (поле `correct` и подобные отклоняются — extra="forbid").
- Ученику — `EvaluationView`, `Appeal` (bff.ts «Спринт 4»); админке — формы `EvaluationCard`, `AdminAppeal`,
  `Reevaluation`, `AppealDecision` (admin.ts «ИИ, контроль диалогов, затраты»), но имена сотрудников — id
  (`created_by`, `taken_by`, `decided_by`, `flags[].by`): имена подставляет admin-bff.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    field_validator,
)

Kind = Literal["lesson", "scenario", "media", "review"]
RefKind = Literal["lesson", "scenario", "rubric", "media_asset", "media_exercise"]
Audience = Literal["kids", "teens", "adults"]
Outcome = Literal["success", "alt_success", "fail"]
CriterionCode = Literal["task", "vocabulary", "grammar", "independence", "pronunciation", "fluency", "comprehension"]
EvalStatus = Literal["ok", "partial", "insufficient_evidence", "pending_review"]
AppealStatus = Literal["new", "in_review", "upheld", "corrected"]
SkillOutcomeName = Literal["demonstrated", "learning", "not_assessed"]
Severity = Literal["low", "medium", "high"]
Score = Annotated[StrictInt, Field(ge=0, le=3)]

CONTENT_ID = r"^[a-z0-9][a-z0-9._-]{1,63}$"
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _clean(value: str) -> str:
    """Текст сотрудника/ученика: без управляющих символов (кроме переводов строк и табуляции), без краевых пробелов."""
    if _CONTROL.search(value):
        raise ValueError("control characters are not allowed")
    value = value.strip()
    if not value:
        raise ValueError("must not be blank")
    return value


CleanText = Annotated[str, AfterValidator(_clean)]


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------- оценка (lessons)


class ContentRefIn(_In):
    kind: RefKind
    key: str = Field(min_length=2, max_length=64, pattern=CONTENT_ID)
    version: StrictInt = Field(ge=1, le=1_000_000)


class AnswerIn(_In):
    item_id: str = Field(min_length=1, max_length=64, pattern=CONTENT_ID)
    # индекс | строка для пропуска | слова/реплики (или индексы вариантов) по порядку | null («не знаю»)
    answer: StrictInt | Annotated[StrictStr, Field(max_length=300)] | Annotated[
        list[StrictInt | Annotated[StrictStr, Field(max_length=300)]], Field(max_length=40)] | None = None
    hinted: StrictBool = False
    dont_know: StrictBool = False


class TurnIn(_In):
    turn_id: str = Field(pattern=r"^T[0-9]{1,4}$")
    speaker: Literal["learner", "character"]
    text: str = Field(max_length=500)
    # реплика ученика: выбор варианта или свободный текст (ai_mode full); у персонажа — null
    mode: Literal["choice", "text"] | None = None
    hinted: StrictBool = False
    node_id: str | None = Field(default=None, max_length=64)


class RoleplayIn(_In):
    outcome: Outcome | None = None  # null — сценарий не дошёл до конца
    hints: StrictInt = Field(default=0, ge=0, le=100)


class OpenAnswerIn(_In):
    text: str = Field(max_length=500)
    prompt: str | None = Field(default=None, max_length=300)


class EvaluationRequestIn(_In):
    session_id: uuid.UUID
    user_id: uuid.UUID | None = None  # если передан — должен совпадать с sub токена
    kind: Kind
    pair_id: str = Field(min_length=3, max_length=16, pattern=r"^[a-z]{2,3}-[a-z]{2,3}$")
    audience: Audience
    locale: Literal["ru", "uz"] = "ru"
    content_refs: list[ContentRefIn] = Field(min_length=1, max_length=40)
    answers: list[AnswerIn] = Field(default_factory=list, max_length=60)
    turns: list[TurnIn] = Field(default_factory=list, max_length=120)
    roleplay: RoleplayIn | None = None
    open_answer: OpenAnswerIn | None = None
    practice_only: StrictBool = False

    @field_validator("content_refs", mode="before")
    @classmethod
    def _refs_from_mapping(cls, value: Any) -> Any:
        """Допускается и словарь `{lesson: {key, version}, rubric: {…}, media_exercises: [{key, version}]}`."""
        if not isinstance(value, dict):
            return value
        out: list[Any] = []
        for kind, refs in value.items():
            name = "media_exercise" if kind == "media_exercises" else kind
            for ref in refs if isinstance(refs, list) else [refs]:
                if ref is None:
                    continue
                out.append({"kind": name, **ref} if isinstance(ref, dict) else ref)
        return out


# ---------------------------------------------------------------- общие формы вывода


class LocalizedOut(BaseModel):
    ru: str
    uz: str


class ConfirmedErrorOut(BaseModel):
    turn_id: str
    evidence: str
    correction: str
    error_code: str
    severity: Severity


class SkillOutcomeOut(BaseModel):
    skill_id: str
    outcome: SkillOutcomeName


# ---------------------------------------------------------------- ученик (bff.ts)


class ScoreViewOut(BaseModel):
    code: CriterionCode
    title: LocalizedOut
    score: int | None


class ItemViewOut(BaseModel):
    item_id: str
    prompt_en: str
    your_answer: str | None
    correct: bool
    hinted: bool
    correct_answer: str | None  # только если ответ неверен


class EvaluatorViewOut(BaseModel):
    model_id: str
    prompt_version: str


class AppealOut(BaseModel):
    appeal_id: uuid.UUID
    evaluation_id: uuid.UUID
    status: AppealStatus
    reason: str | None  # null — стёрт по сроку хранения (90 дней после решения)
    decision_note: str | None
    new_evaluation_id: uuid.UUID | None
    created_at: datetime
    decided_at: datetime | None


class EvaluationViewOut(BaseModel):
    evaluation_id: uuid.UUID
    status: EvalStatus
    passed: bool | None
    task_completed: bool | None
    scores: list[ScoreViewOut]
    key_errors: list[ConfirmedErrorOut]
    items: list[ItemViewOut]
    practice_only: bool
    rubric_version: str
    evaluator: EvaluatorViewOut | None
    superseded_by: uuid.UUID | None
    appeal: AppealOut | None
    created_at: datetime


class EvaluationResultOut(EvaluationViewOut):
    """Ответ lessons: EvaluationView + исходы навыков (пусто для practice_only) + признак ручной проверки."""

    session_id: uuid.UUID
    skill_outcomes: list[SkillOutcomeOut]
    requires_human_review: bool


class AppealIn(_In):
    reason: Annotated[CleanText, Field(max_length=500)]


class AppealListOut(BaseModel):
    items: list[AppealOut]
    next_cursor: str | None


# ---------------------------------------------------------------- админка (admin.ts)


class RubricRefOut(BaseModel):
    rubric_id: str
    version: int


class ScoreCardOut(BaseModel):
    code: CriterionCode
    score: int | None


class ItemCardOut(BaseModel):
    item_id: str
    skill_id: str
    correct: bool
    hinted: bool


class EvaluatorCardOut(BaseModel):
    agent_id: str
    agent_version: int
    prompt_version: str
    model_id: str
    schema_version: str
    canary: bool


class FlagOut(BaseModel):
    reason: str
    by: str
    at: datetime


class AdminAppealOut(BaseModel):
    appeal_id: uuid.UUID
    evaluation_id: uuid.UUID
    session_id: uuid.UUID
    status: AppealStatus
    reason: str | None  # текст ученика — сотрудникам с qa.read (без PII ученика); null — стёрт по сроку хранения
    reason_redacted: bool  # «текст стёрт по сроку хранения» (90 дней после решения, ревью R1-14)
    decision_note: str | None
    taken_by: str | None
    decided_by: str | None
    new_evaluation_id: uuid.UUID | None
    created_at: datetime
    taken_at: datetime | None
    decided_at: datetime | None


class EvaluationCardOut(BaseModel):
    evaluation_id: uuid.UUID
    session_id: uuid.UUID
    kind: Kind
    status: EvalStatus
    rubric: RubricRefOut
    scores: list[ScoreCardOut]
    weighted: float | None
    passed: bool | None
    task_completed: bool | None
    outcome: Outcome | None
    confirmed_errors: list[ConfirmedErrorOut]
    items: list[ItemCardOut]
    skill_outcomes: list[SkillOutcomeOut]
    evaluator: EvaluatorCardOut | None
    ai_status: Literal["not_used", "ok", "unavailable", "refused"]
    requires_human_review: bool
    practice_only: bool
    supersedes: uuid.UUID | None
    superseded_by: uuid.UUID | None
    created_by: str | None  # null — система; имя подставляет admin-bff
    reason: str | None
    appeal_id: uuid.UUID | None  # переоценка по апелляции
    flags: list[FlagOut]
    appeal: AdminAppealOut | None  # апелляция по цепочке оценки сессии
    created_at: datetime


class EvaluationChainOut(BaseModel):
    items: list[EvaluationCardOut]
    next_cursor: str | None


class ConfirmedErrorIn(_In):
    turn_id: str = Field(min_length=1, max_length=64)
    evidence: Annotated[CleanText, Field(max_length=120)]
    correction: Annotated[CleanText, Field(max_length=200)]
    error_code: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    severity: Severity


class SkillOutcomeIn(_In):
    skill_id: str = Field(min_length=2, max_length=64, pattern=CONTENT_ID)
    outcome: SkillOutcomeName


class ReevaluationIn(_In):
    scores: dict[CriterionCode, Score | None]
    skill_outcomes: list[SkillOutcomeIn] = Field(max_length=100)
    confirmed_errors: list[ConfirmedErrorIn] = Field(max_length=5)
    reason: Annotated[CleanText, Field(min_length=10, max_length=500)]
    appeal_id: uuid.UUID | None = None


class FlagIn(_In):
    reason: Annotated[CleanText, Field(min_length=3, max_length=500)]


class AppealDecisionIn(_In):
    decision: Literal["upheld", "corrected"]
    note: Annotated[CleanText, Field(min_length=10, max_length=500)]
    new_evaluation_id: uuid.UUID | None = None


class AdminAppealListOut(BaseModel):
    items: list[AdminAppealOut]
    next_cursor: str | None


class SessionSummaryOut(BaseModel):
    session_id: uuid.UUID
    evaluation_id: uuid.UUID  # актуальная запись цепочки
    status: EvalStatus
    passed: bool | None
    requires_human_review: bool
    reevaluated: bool
    flagged: bool
    appeal_status: AppealStatus | None


class SessionSummaryListOut(BaseModel):
    items: list[SessionSummaryOut]


class AssessmentStatsOut(BaseModel):
    period: Literal["today", "7d", "30d"]
    evaluations: int  # исходные оценки за период (без practice_only)
    passed: int
    insufficient_evidence: int
    partial: int
    reevaluations: int
    appeals_new: int  # поданные за период
    appeals_open: int  # сейчас: new + in_review
    human_review_open: int  # сейчас: актуальные оценки, ждущие ручной проверки


class TickOut(BaseModel):
    """Ответ `assessment-tick`: сколько текстов апелляций стёрто по сроку хранения."""

    redacted_appeal_reasons: int
