"""Модели learning-plan — зеркало миграций 0001–0005 (UNIQUE, индексы и CHECK объявлены и здесь: тест schema_drift).

user_id везде — ученик (learner) из `sub` внутреннего токена; PII сервис не хранит.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, time
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    Time,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TS = DateTime(timezone=True)


class Base(DeclarativeBase):
    pass


class Plan(Base):
    """Учебный план и график ученика (INTERNAL_API §2). Один на ученика.

    version — оптимистическая блокировка (If-Match): каждая видимая правка +1.
    schedule_set_at — момент, когда ученик впервые выбрал график или позже изменил его время/дни/зону:
    по нему онбординг понимает, что шаг графика пройден, а tick — с какого момента действует текущий график
    (слоты раньше него не напоминаются и не считаются пропущенными).
    """

    __tablename__ = "plans"
    __table_args__ = (
        CheckConstraint(
            "goal IS NULL OR goal IN ('work','career','travel','daily','study','exam')", name="ck_plans_goal"
        ),
        CheckConstraint(
            "level_self IS NULL OR level_self IN ('zero','beginner','some','confident')", name="ck_plans_level"
        ),
        CheckConstraint("cardinality(topics) <= 5", name="ck_plans_topics"),
        CheckConstraint("ui_lang IN ('ru','uz')", name="ck_plans_ui_lang"),
        CheckConstraint("explain_lang IN ('ru','uz')", name="ck_plans_explain_lang"),
        CheckConstraint("course_pair IN ('ru-en')", name="ck_plans_course_pair"),
        CheckConstraint("preset IN ('daily','weekdays','three_per_week','custom')", name="ck_plans_preset"),
        CheckConstraint(
            "cardinality(days) BETWEEN 1 AND 7 AND days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]", name="ck_plans_days"
        ),
        CheckConstraint("duration_min IN (10,15,20,30)", name="ck_plans_duration"),
        CheckConstraint("version >= 1", name="ck_plans_version"),
        # спринт 2 (миграция 0002): сверка read-модели админки — GET /admin/v1/plans?updated_after=&cursor=
        Index("ix_plans_updated", "updated_at", "user_id"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    goal: Mapped[str | None] = mapped_column(String(16))
    level_self: Mapped[str | None] = mapped_column(String(16))
    topics: Mapped[list[str]] = mapped_column(ARRAY(Text()), nullable=False, server_default=text("'{}'::text[]"))
    ui_lang: Mapped[str] = mapped_column(String(2), nullable=False)
    explain_lang: Mapped[str] = mapped_column(String(2), nullable=False)
    course_pair: Mapped[str] = mapped_column(String(8), nullable=False)
    preset: Mapped[str] = mapped_column(String(16), nullable=False)
    days: Mapped[list[int]] = mapped_column(ARRAY(SmallInteger()), nullable=False)
    preferred_time: Mapped[time] = mapped_column(Time(), nullable=False)
    duration_min: Mapped[int] = mapped_column(SmallInteger(), nullable=False)
    reminders_enabled: Mapped[bool] = mapped_column(Boolean(), nullable=False)
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    schedule_set_at: Mapped[datetime | None] = mapped_column(TS)
    onboarding_completed_at: Mapped[datetime | None] = mapped_column(TS)
    version: Mapped[int] = mapped_column(Integer(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class Activity(Base):
    """Учёт занятий (спринт 1 — практика из Mini App; со спринта 4 — события уроков и практики lessons).

    local_date — дата занятия в часовом поясе плана на момент записи (у события урока — его local_date). Повтор с тем
    же Idempotency-Key — та же запись. session_id — сессия lessons (спринт 4): одно занятие на сессию; ключ таких
    записей `lesson/<session_id>` — с «/», которого нет в ключах клиента, поэтому ручной ключ его не займёт.
    """

    __tablename__ = "activities"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="uq_activities_user_idempotency"),
        CheckConstraint("kind IN ('lesson','review','practice','diagnostic')", name="ck_activities_kind"),
        CheckConstraint("minutes BETWEEN 0 AND 240", name="ck_activities_minutes"),
        Index("ix_activities_user_date", "user_id", "local_date"),
        Index("uq_activities_session", "session_id", unique=True, postgresql_where=text("session_id IS NOT NULL")),
    )

    activity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    local_date: Mapped[date] = mapped_column(Date(), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    minutes: Mapped[int] = mapped_column(SmallInteger(), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class SlotMark(Base):
    """Отметка «событие по слоту уже выпущено» — идемпотентность tick (одно reminder и одно missed на дату)."""

    __tablename__ = "slot_marks"
    __table_args__ = (CheckConstraint("kind IN ('reminder','missed')", name="ck_slot_marks_kind"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    local_date: Mapped[date] = mapped_column(Date(), primary_key=True)
    kind: Mapped[str] = mapped_column(String(8), primary_key=True)
    emitted_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class TickState(Base):
    """Одна строка: конец окна предыдущего tick. Строка блокируется на время tick — запуски сериализуются."""

    __tablename__ = "tick_state"
    __table_args__ = (CheckConstraint("id = 1", name="ck_tick_state_single"),)

    id: Mapped[int] = mapped_column(SmallInteger(), primary_key=True, autoincrement=False)
    last_tick_at: Mapped[datetime] = mapped_column(TS, nullable=False)


# ---------------------------------------------------------------- спринт 3: траектория уроков (INTERNAL_API §3)


class Trajectory(Base):
    """Ревизии траектории уроков ученика по паре (AT-36): история хранится, текущая — последняя ревизия.

    basis — входы расчёта {diagnostic_result_id, diagnostic_revision, goal, topics, audience,
    course_snapshot_version, skills_hash, algorithm}: новая ревизия создаётся, только когда входы изменились.
    items — самодостаточный результат {next, mandatory, optional} с карточками уроков на момент расчёта
    (история читается без каталога). Ревизии неизменяемы (только INSERT; удаление — сага удаления ученика)."""

    __tablename__ = "trajectories"
    __table_args__ = (CheckConstraint("revision >= 1", name="ck_trajectories_revision"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    pair_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer(), primary_key=True, autoincrement=False)
    course_id: Mapped[str] = mapped_column(String(64), nullable=False)
    basis: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    next_lesson_id: Mapped[str | None] = mapped_column(String(64))
    items: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    computed_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class CourseSnapshotCache(Base):
    """Кеш снимка курса catalog (GET /internal/v1/courses/{id}/snapshot) по ETag — общий для реплик и переживает
    рестарт: catalog недоступен — траектория считается по кешу. stale_since — пометка событием
    catalog.version.published.v1: следующее чтение перепроверяет снимок (If-None-Match)."""

    __tablename__ = "course_snapshots"

    course_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    pair_id: Mapped[str] = mapped_column(String(64), nullable=False)
    etag: Mapped[str] = mapped_column(String(200), nullable=False)
    snapshot_version: Mapped[str] = mapped_column(String(200), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    checked_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    stale_since: Mapped[datetime | None] = mapped_column(TS)


class LearnerDiagnostic(Base):
    """Проекция последнего результата диагностики ученика по паре (diagnostics.completed.v1): уточнение —
    та же или новая result_id с большей revision; старое событие, пришедшее позже, не перезаписывает новое."""

    __tablename__ = "learner_diagnostics"
    __table_args__ = (CheckConstraint("revision >= 1", name="ck_learner_diagnostics_revision"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    pair_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    result_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    revision: Mapped[int] = mapped_column(Integer(), nullable=False)
    test_id: Mapped[str] = mapped_column(String(200), nullable=False)
    test_version: Mapped[int] = mapped_column(Integer(), nullable=False)
    provisional_level: Mapped[str | None] = mapped_column(String(2))
    areas: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    recommended_start_lesson_id: Mapped[str | None] = mapped_column(String(200))
    completed_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class SkillStateProjection(Base):
    """Локальная проекция карты навыков ученика (skills.state.changed.v1; владелец — diagnostics). updated_at —
    occurred_at события: опоздавшее старое изменение не откатывает новое."""

    __tablename__ = "skill_states"
    __table_args__ = (
        CheckConstraint("state IN ('not_started','learning','demonstrated','retained')", name="ck_skill_states_state"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    pair_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    skill_id: Mapped[str] = mapped_column(String(200), primary_key=True)
    state: Mapped[str] = mapped_column(String(16), nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class LearnerAudience(Base):
    """Сегмент аудитории ученика для подбора уроков (kids 6–13 | teens 14–17 | adults) — проекция
    user.profile.created/updated.v1 от identity-consent. Возраст (age_band) и дата рождения не хранятся."""

    __tablename__ = "learner_audience"
    __table_args__ = (CheckConstraint("audience IN ('kids','teens','adults')", name="ck_learner_audience_audience"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    audience: Mapped[str] = mapped_column(String(8), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


# ---------------------------------------------------------------- спринт 4: пройденные уроки (INTERNAL_API §5)


class CompletedLesson(Base):
    """Завершённая сессия урока (lesson.session.completed.v1, kind lesson, status completed): строка на сессию,
    актуальна последняя сессия урока (по completed_at). passed/evaluation_id — исход оценки: из события сессии, затем
    актуальная оценка сессии из проекции `lesson_evaluations` (оценка, полученная позже, и переоценка)."""

    __tablename__ = "completed_lessons"
    __table_args__ = (
        Index("ix_completed_lessons_user_lesson", "user_id", "pair_id", "lesson_id", "completed_at"),
        Index("ix_completed_lessons_user_evaluation", "user_id", "evaluation_id"),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(64), nullable=False)
    lesson_id: Mapped[str] = mapped_column(String(200), nullable=False)
    passed: Mapped[bool | None] = mapped_column(Boolean())
    evaluation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    completed_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class LessonEvaluation(Base):
    """Проекция оценок уроков (R1-05): `assessment.completed.v1` (kind lesson — session_id из события) и
    `assessment.reevaluated.v1` (session_id — по заменённой оценке; пришла раньше неё — null, заполняется, когда
    придёт звено цепочки). Актуальная оценка сессии — последняя по created_at; она же — в completed_lessons.
    События приходят в любом порядке: оценка раньше lesson.session.completed.v1 применяется при его записи."""

    __tablename__ = "lesson_evaluations"
    __table_args__ = (
        Index("ix_lesson_evaluations_user_session", "user_id", "session_id", "created_at"),
        Index("ix_lesson_evaluations_user_supersedes", "user_id", "supersedes"),
    )

    evaluation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    supersedes: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    passed: Mapped[bool | None] = mapped_column(Boolean())
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class DeletedUser(Base):
    """Отметка исполненного удаления (сага TG-FR-006): запросы и события после удаления не воскрешают план.
    Только псевдонимный user_id и request_id саги — без персональных данных."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
