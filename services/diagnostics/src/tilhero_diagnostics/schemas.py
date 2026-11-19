"""Формы API diagnostics — 1:1 с packages/contracts/src/bff.ts (раздел «Спринт 3») и admin.ts
(«Диагностика (тесты, статистика)»). Ключи ответов в формы ученика не входят."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr

Band = Literal["A0", "A1", "A2", "B1", "B2"]
DiagnosticArea = Literal["vocabulary", "grammar", "reading", "listening", "speaking", "writing"]
TestArea = Literal["vocabulary", "grammar", "reading", "listening"]
ItemType = Literal["single_choice", "gap_choice", "order_words", "read_choice", "listen_choice"]
SkillStateName = Literal["not_started", "learning", "demonstrated", "retained"]
Segment = Literal["kids", "teens", "adults"]


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Localized(BaseModel):
    ru: str
    uz: str


# ---------------------------------------------------------------- ученик


class SessionCreateIn(_In):
    pair_id: str | None = Field(default=None, max_length=16)


class AnswerIn(_In):
    item_id: str = Field(min_length=1, max_length=64)
    answer: StrictInt | list[StrictStr] | None = Field(default=None)
    dont_know: StrictBool = False
    time_ms: StrictInt = Field(ge=0, le=3_600_000)


class FollowupIn(_In):
    area: TestArea


class DiagnosticSessionOut(BaseModel):
    session_id: uuid.UUID
    pair_id: str
    test_version: str
    status: Literal["in_progress", "finished", "abandoned"]
    answered: int
    total_estimate: int
    started_at: datetime
    expires_at: datetime
    followup_area: TestArea | None


class DiagnosticItemOut(BaseModel):
    item_id: str
    area: TestArea
    type: ItemType
    instruction: Localized
    prompt_en: str
    passage_en: str | None
    audio_text_en: str | None
    options: list[str]
    position: int


class DoneOut(BaseModel):
    done: Literal[True] = True


class AnswerResultOut(BaseModel):
    accepted: bool
    next: DiagnosticItemOut | None
    done: bool


class EvidenceOut(BaseModel):
    """Основания по полосе: без item_id и отметок по заданиям (bff.ts AreaResult.evidence)."""

    band: Band
    answered: int
    correct: int


class AreaResultOut(BaseModel):
    area: DiagnosticArea
    status: Literal["assessed", "not_assessed"]
    band: Band | None
    confidence: float | None
    reason: Literal["too_few_items", "no_speech_voice", "not_in_test_yet"] | None
    evidence: list[EvidenceOut]
    needs_followup: bool


class RecommendedStartOut(BaseModel):
    lesson_id: str
    title: Localized
    level: Band


class DiagnosticResultOut(BaseModel):
    result_id: uuid.UUID
    revision: int
    pair_id: str
    test_version: str
    provisional_level: Band | None
    areas: list[AreaResultOut]
    weak_areas: list[DiagnosticArea]
    recommended_start: RecommendedStartOut | None
    cefr_certificate: Literal[False] = False
    created_at: datetime


class DiagnosticStateOut(BaseModel):
    pair_id: str
    status: Literal["none", "in_progress", "completed"]
    session: DiagnosticSessionOut | None
    last_result: DiagnosticResultOut | None
    next_allowed_at: datetime | None
    audience: Literal["adults", "kids"]


class ResultListOut(BaseModel):
    items: list[DiagnosticResultOut]


class SkillHistoryOut(BaseModel):
    source: Literal["diagnostic", "lesson", "retention"]
    outcome: Literal["positive", "negative"]
    at: datetime


class SkillOut(BaseModel):
    skill_id: str
    # метаданные навыка — из снимка курса; без снимка null (BFF дополняет из своего снимка)
    area: str | None
    title: Localized | None
    level: Band | None
    state: SkillStateName
    confidence: float | None
    prerequisites: list[str]
    updated_at: datetime | None
    history: list[SkillHistoryOut]


class SkillMapOut(BaseModel):
    pair_id: str
    course_id: str
    counts: dict[SkillStateName, int]
    skills: list[SkillOut]


# ---------------------------------------------------------------- админка


class PublishIn(_In):
    reason: str = Field(min_length=3, max_length=500)


class TestVersionMetaOut(BaseModel):
    version: int
    status: Literal["draft", "published", "archived"]
    items: int
    published_at: datetime | None


class DiagnosticTestRowOut(BaseModel):
    test_id: str
    pair_id: str
    audience: Literal["adults", "kids"]
    published_version: int | None
    versions: list[TestVersionMetaOut]


class DiagnosticTestListOut(BaseModel):
    items: list[DiagnosticTestRowOut]


class DiagnosticTestVersionOut(BaseModel):
    test_id: str
    version: int
    status: Literal["draft", "published", "archived"]
    config: dict[str, Any]
    items: list[dict[str, Any]]
    coverage: dict[str, dict[Band, int]]


class DiagnosticStatsOut(BaseModel):
    period: Literal["today", "7d", "30d"]
    started: int
    finished: int
    median_minutes: float | None
    by_level: dict[Literal["A0", "A1", "A2", "B1", "B2", "none"], int]
    not_assessed_pct: dict[TestArea, float]
    followups: int


class PairLearnersOut(BaseModel):
    pair_id: str
    learners: int


class PairLearnersListOut(BaseModel):
    items: list[PairLearnersOut]
