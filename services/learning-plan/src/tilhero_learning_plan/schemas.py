"""Pydantic-модели API learning-plan. Формы ответов = типы bff.ts (BFF проксирует без перекладывания).

Вход PATCH плана намеренно «широкий» по типам значений: правила (enum, HH:MM, дни, зона, темы) проверяет домен
и отвечает 422 PLAN_INVALID {field, reason}; лишние поля запрещены (extra="forbid").
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr

Goal = Literal["work", "career", "travel", "daily", "study", "exam"]
LevelSelf = Literal["zero", "beginner", "some", "confident"]
UiLang = Literal["ru", "uz"]
SchedulePreset = Literal["daily", "weekdays", "three_per_week", "custom"]
ActivityKind = Literal["lesson", "review", "practice", "diagnostic"]


class SchedulePatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preset: StrictStr | None = Field(default=None, max_length=32)
    days: list[StrictInt] | None = Field(default=None, max_length=14)
    preferred_time: StrictStr | None = Field(default=None, max_length=8)
    duration_min: StrictInt | None = None
    reminders_enabled: StrictBool | None = None
    timezone: StrictStr | None = Field(default=None, max_length=64)


class PlanPatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    goal: StrictStr | None = Field(default=None, max_length=32)
    level_self: StrictStr | None = Field(default=None, max_length=32)
    topics: list[StrictStr] | None = Field(default=None, max_length=20)
    ui_lang: StrictStr | None = Field(default=None, max_length=8)
    explain_lang: StrictStr | None = Field(default=None, max_length=8)
    schedule: SchedulePatchIn | None = None


class ScheduleOut(BaseModel):
    preset: SchedulePreset
    days: list[int]
    preferred_time: str
    duration_min: Literal[10, 15, 20, 30]
    reminders_enabled: bool
    timezone: str


class LearningPlanOut(BaseModel):
    learner_id: str
    goal: Goal | None
    level_self: LevelSelf | None
    topics: list[str]
    ui_lang: UiLang
    explain_lang: UiLang
    course_pair: Literal["ru-en"]
    schedule: ScheduleOut
    onboarding_completed_at: datetime | None
    updated_at: datetime
    version: int


class NextSlotOut(BaseModel):
    local_date: str
    time: str


class WeekDayOut(BaseModel):
    local_date: str
    scheduled: bool
    done: bool
    missed: bool


class TodayPlanOut(BaseModel):
    local_date: str
    is_scheduled_today: bool
    slot_time: str | None
    duration_min: Literal[10, 15, 20, 30]
    minutes_today: int
    done_today: bool
    next_slot: NextSlotOut | None
    streak_days: int
    week: list[WeekDayOut]


class ActivityIn(BaseModel):
    """BFF присылает kind=practice (ActivityRequest); lesson/review/diagnostic — для доменов спринтов 3–5."""

    model_config = ConfigDict(extra="forbid")

    kind: ActivityKind
    minutes: int = Field(ge=1, le=240)
    occurred_at: AwareDatetime | None = None


class DirectoryLabelOut(BaseModel):
    ru: str
    uz: str


class DirectoryItemOut(BaseModel):
    code: str
    label: DirectoryLabelOut
    icon: str | None


class DirectoryOut(BaseModel):
    items: list[DirectoryItemOut]


class TickOut(BaseModel):
    plans_checked: int
    reminders: int
    missed: int
    # true — предыдущий tick ещё идёт, этот вызов ничего не делал (повтор n8n не ждёт блокировку)
    skipped: bool = False


class AdminPlanOut(BaseModel):
    """Элемент GET /admin/v1/plans (INTERNAL_API §3, вызывающий — user-admin): AdminLearnerPlan + user_id."""

    user_id: str
    goal: Goal | None
    level_self: LevelSelf | None
    ui_lang: UiLang
    schedule: ScheduleOut
    onboarding_completed_at: datetime | None
    updated_at: datetime


class AdminPlanPage(BaseModel):
    items: list[AdminPlanOut]
    next_cursor: str | None


# ---------------------------------------------------------------- спринт 3: траектория уроков (bff.ts Trajectory)

Band = Literal["A0", "A1", "A2", "B1", "B2"]
ReasonCode = Literal[
    "start_after_diagnostic", "no_diagnostic", "prerequisite_missing", "weak_area", "goal_match", "topic_match",
    "next_in_course",
]
LessonStageType = Literal["retrieval", "explanation", "roleplay", "assessment", "summary"]
AudienceSegment = Literal["kids", "teens", "adults"]


class LocalizedOut(BaseModel):
    ru: str
    uz: str


class LessonStageOut(BaseModel):
    type: LessonStageType
    minutes: int


class LessonCardOut(BaseModel):
    lesson_id: str
    module_id: str
    title: LocalizedOut
    goal: LocalizedOut
    level: Band
    kind: Literal["core", "optional"]
    duration_min: int
    primary_skill_id: str
    scenario_id: str | None
    stages: list[LessonStageOut]


class PlannedLessonOut(LessonCardOut):
    reason_codes: list[ReasonCode]


class NextLessonOut(PlannedLessonOut):
    explanation: LocalizedOut


class TrajectoryBasisOut(BaseModel):
    diagnostic_result_id: str | None
    goal: Goal | None
    computed_at: datetime


class TrajectoryOut(BaseModel):
    pair_id: str
    course_id: str
    revision: int
    basis: TrajectoryBasisOut
    next: NextLessonOut | None
    mandatory: list[PlannedLessonOut]
    optional: list[PlannedLessonOut]
    completed: list[LessonCardOut]
    lessons_available: bool
