"""Модели learning-plan — зеркало миграции 0001 (UNIQUE, индексы и CHECK объявлены и здесь: тест schema_drift).

user_id везде — ученик (learner) из `sub` внутреннего токена; PII сервис не хранит.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, time

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
from sqlalchemy.dialects.postgresql import ARRAY, UUID
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
    """Учёт занятий (спринт 1 — практика из Mini App; со спринта 4 — события уроков и повторений).

    local_date — дата занятия в часовом поясе плана на момент записи. Повтор с тем же Idempotency-Key — та же запись.
    """

    __tablename__ = "activities"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="uq_activities_user_idempotency"),
        CheckConstraint("kind IN ('lesson','review','practice','diagnostic')", name="ck_activities_kind"),
        CheckConstraint("minutes BETWEEN 0 AND 240", name="ck_activities_minutes"),
        Index("ix_activities_user_date", "user_id", "local_date"),
    )

    activity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    local_date: Mapped[date] = mapped_column(Date(), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    minutes: Mapped[int] = mapped_column(SmallInteger(), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(TS, nullable=False)


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


class DeletedUser(Base):
    """Отметка исполненного удаления (сага TG-FR-006): запросы и события после удаления не воскрешают план.
    Только псевдонимный user_id и request_id саги — без персональных данных."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
