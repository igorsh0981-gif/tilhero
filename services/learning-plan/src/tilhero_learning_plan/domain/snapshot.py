"""Снимок курса catalog — `CourseSnapshot` (packages/contracts/src/bff.ts, раздел «Спринт 3»).

Читатель терпимый к новым полям (extra="ignore"), строгий к обязательным: снимок, не прошедший проверку, считается
ответом недоступного catalog (траектория — по кешу или 503). Ключей контрольных заданий в снимке нет по контракту;
learning-plan их и не читает.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Band = Literal["A0", "A1", "A2", "B1", "B2"]
BANDS: tuple[Band, ...] = ("A0", "A1", "A2", "B1", "B2")
Audience = Literal["kids", "teens", "adults"]
AUDIENCES: tuple[Audience, ...] = ("kids", "teens", "adults")
SkillArea = Literal["vocabulary", "grammar", "reading", "listening", "speaking", "writing", "function"]
StageType = Literal["retrieval", "explanation", "roleplay", "assessment", "summary"]
LessonKind = Literal["core", "optional"]

_ID = Field(min_length=1, max_length=64)


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)


class Localized(_Model):
    ru: str = Field(min_length=1, max_length=2000)
    uz: str = Field(min_length=1, max_length=2000)


class Stage(_Model):
    type: StageType
    minutes: int = Field(ge=1, le=60)


class SnapModule(_Model):
    module_id: str = _ID
    title: Localized
    goal: Localized
    theme: str = Field(max_length=32)
    lesson_ids: list[str] = Field(default_factory=list, max_length=500)


class SnapSkill(_Model):
    skill_id: str = _ID
    area: SkillArea
    title: Localized
    level: Band
    prerequisites: list[str] = Field(default_factory=list, max_length=50)
    diagnostic_tags: list[str] = Field(default_factory=list, max_length=100)


class SnapLesson(_Model):
    lesson_id: str = _ID
    module_id: str = _ID
    title: Localized
    goal: Localized
    level: Band
    kind: LessonKind
    duration_min: int = Field(ge=1, le=120)
    primary_skill_id: str = _ID
    scenario_id: str | None = Field(default=None, max_length=64)
    stages: list[Stage] = Field(max_length=10)
    audience: list[Audience] = Field(min_length=1, max_length=3)
    goals: list[str] = Field(default_factory=list, max_length=10)
    topics: list[str] = Field(default_factory=list, max_length=20)
    secondary_skill_ids: list[str] = Field(default_factory=list, max_length=10)
    prerequisite_skill_ids: list[str] = Field(default_factory=list, max_length=50)

    def card(self) -> dict[str, object]:
        """LessonCard (bff.ts) — то, что видит ученик: без аудитории, тем и предпосылок."""
        return {
            "lesson_id": self.lesson_id,
            "module_id": self.module_id,
            "title": self.title.model_dump(),
            "goal": self.goal.model_dump(),
            "level": self.level,
            "kind": self.kind,
            "duration_min": self.duration_min,
            "primary_skill_id": self.primary_skill_id,
            "scenario_id": self.scenario_id,
            "stages": [{"type": s.type, "minutes": s.minutes} for s in self.stages],
        }


class CourseSnapshot(_Model):
    course_id: str = _ID
    pair_id: str = Field(min_length=1, max_length=32)
    snapshot_version: str = Field(min_length=1, max_length=200)
    title: Localized
    level_start: Band
    level_end: Band
    modules: list[SnapModule] = Field(max_length=200)
    skills: list[SnapSkill] = Field(max_length=2000)
    lessons: list[SnapLesson] = Field(max_length=2000)
