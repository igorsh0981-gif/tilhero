"""Модели diagnostics — зеркало миграций 0001 и 0003 (UNIQUE, индексы и CHECK объявлены и здесь: тест schema_drift).

user_id везде — ученик (learner) из `sub` внутреннего токена; PII сервис не хранит (только ответы на задания,
псевдонимный user_id и возрастной сегмент из событий identity-consent).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKeyConstraint,
    Index,
    Integer,
    SmallInteger,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TS = DateTime(timezone=True)
BAND_CHECK = "IN ('A0','A1','A2','B1','B2')"
AREA_CHECK = "IN ('vocabulary','grammar','reading','listening')"


class Base(DeclarativeBase):
    pass


class Test(Base):
    """Версия теста диагностики (INTERNAL_API §2.1). Опубликованная и архивная версии неизменяемы (триггер
    tests_guard): меняется только статус published ↔ archived. На (пара, аудитория) — не больше одной published."""

    __test__ = False  # не тестовый класс pytest
    __tablename__ = "tests"
    __table_args__ = (
        CheckConstraint("status IN ('draft','published','archived')", name="ck_tests_status"),
        CheckConstraint("audience IN ('adults','kids')", name="ck_tests_audience"),
        CheckConstraint("version >= 1", name="ck_tests_version"),
        Index("uq_tests_published_audience", "pair_id", "audience", unique=True,
              postgresql_where=text("status = 'published'")),
    )

    test_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    version: Mapped[int] = mapped_column(Integer(), primary_key=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    audience: Mapped[str] = mapped_column(String(8), nullable=False)
    config: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    items: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    published_at: Mapped[datetime | None] = mapped_column(TS)
    published_by: Mapped[str | None] = mapped_column(String(64))
    archived_at: Mapped[datetime | None] = mapped_column(TS)


class Session(Base):
    """Сессия диагностики. followup_area/result_id — уточнение области результата (новая ревизия).
    Сессия живёт 24 ч (expires_at); у ученика по паре не больше одной in_progress (частичный UNIQUE)."""

    __tablename__ = "sessions"
    __table_args__ = (
        CheckConstraint("status IN ('in_progress','finished','abandoned')", name="ck_sessions_status"),
        CheckConstraint("segment IN ('kids','teens','adults')", name="ck_sessions_segment"),
        CheckConstraint(f"followup_area IS NULL OR followup_area {AREA_CHECK}", name="ck_sessions_followup_area"),
        CheckConstraint("(followup_area IS NULL) = (result_id IS NULL)", name="ck_sessions_followup_pair"),
        ForeignKeyConstraint(["test_id", "test_version"], ["tests.test_id", "tests.version"],
                             name="fk_sessions_test"),
        UniqueConstraint("user_id", "idempotency_key", name="uq_sessions_user_idempotency"),
        Index("uq_sessions_in_progress", "user_id", "pair_id", unique=True,
              postgresql_where=text("status = 'in_progress'")),
        Index("ix_sessions_user_pair", "user_id", "pair_id", "started_at"),
        Index("ix_sessions_result", "result_id"),
        Index("ix_sessions_started", "started_at"),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    test_id: Mapped[str] = mapped_column(String(64), nullable=False)
    test_version: Mapped[int] = mapped_column(Integer(), nullable=False)
    seed: Mapped[str] = mapped_column(String(64), nullable=False)
    segment: Mapped[str] = mapped_column(String(8), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    listening_available: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=text("true"))
    followup_area: Mapped[str | None] = mapped_column(String(16))
    result_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    started_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(TS)


class Answer(Base):
    """Ответ на задание (неизменяем — триггер answers_immutable; удаляется только сагой вместе с сессией)."""

    __tablename__ = "answers"
    __table_args__ = (
        CheckConstraint(f"area {AREA_CHECK}", name="ck_answers_area"),
        CheckConstraint(f"band {BAND_CHECK}", name="ck_answers_band"),
        CheckConstraint("time_ms BETWEEN 0 AND 3600000", name="ck_answers_time"),
        CheckConstraint("NOT dont_know OR (answer IS NULL AND NOT correct)", name="ck_answers_dont_know"),
        ForeignKeyConstraint(["session_id"], ["sessions.session_id"], ondelete="CASCADE",
                             name="fk_answers_session"),
        UniqueConstraint("session_id", "item_id", name="uq_answers_session_item"),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(SmallInteger(), primary_key=True)
    item_id: Mapped[str] = mapped_column(String(64), nullable=False)
    area: Mapped[str] = mapped_column(String(16), nullable=False)
    band: Mapped[str] = mapped_column(String(2), nullable=False)
    # «не знаю» — SQL NULL (none_as_null), а не JSON null: CHECK ck_answers_dont_know
    answer: Mapped[Any] = mapped_column(JSONB(none_as_null=True), nullable=True)
    correct: Mapped[bool] = mapped_column(Boolean(), nullable=False)
    dont_know: Mapped[bool] = mapped_column(Boolean(), nullable=False)
    time_ms: Mapped[int] = mapped_column(Integer(), nullable=False)
    answered_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Result(Base):
    """Результат диагностики: ревизия 1 — завершение сессии, далее — уточнения (followup). Неизменяем (триггер
    results_immutable запрещает UPDATE); удаляется только сагой удаления ученика."""

    __tablename__ = "results"
    __table_args__ = (
        CheckConstraint("revision >= 1", name="ck_results_revision"),
        CheckConstraint(f"provisional_level IS NULL OR provisional_level {BAND_CHECK}", name="ck_results_level"),
        ForeignKeyConstraint(["session_id"], ["sessions.session_id"], name="fk_results_session"),
        UniqueConstraint("session_id", name="uq_results_session"),
        Index("ix_results_user_pair", "user_id", "pair_id", "created_at"),
        Index("ix_results_created", "created_at"),
    )

    result_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    revision: Mapped[int] = mapped_column(SmallInteger(), primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    test_id: Mapped[str] = mapped_column(String(64), nullable=False)
    test_version: Mapped[int] = mapped_column(Integer(), nullable=False)
    profile: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    provisional_level: Mapped[str | None] = mapped_column(String(2))
    recommended_start_lesson_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class SkillState(Base):
    """Состояние навыка ученика по паре (AT-35, AT-46). Меняется только механизмом оценки: диагностика и (спринт 4)
    оценки уроков assessment. state_ref — ref_id свидетельства, установившего текущее состояние (result_id
    диагностики | evaluation_id оценки урока; null — до спринта 4)."""

    __tablename__ = "skill_states"
    __table_args__ = (
        CheckConstraint("state IN ('not_started','learning','demonstrated','retained')", name="ck_skill_states_state"),
        CheckConstraint("source IN ('diagnostic','lesson','retention')", name="ck_skill_states_source"),
        CheckConstraint("confidence IS NULL OR confidence BETWEEN 0 AND 1", name="ck_skill_states_confidence"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    pair_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    skill_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    state: Mapped[str] = mapped_column(String(16), nullable=False)
    confidence: Mapped[float | None] = mapped_column(Float())
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    state_ref: Mapped[str | None] = mapped_column(String(64))


class SkillEvidence(Base):
    """Свидетельство по навыку (история подтверждений): не изменяется и не удаляется, кроме саги удаления."""

    __tablename__ = "skill_evidence"
    __table_args__ = (
        CheckConstraint("source IN ('diagnostic','lesson','retention')", name="ck_skill_evidence_source"),
        CheckConstraint("outcome IN ('positive','negative')", name="ck_skill_evidence_outcome"),
        CheckConstraint(f"band IS NULL OR band {BAND_CHECK}", name="ck_skill_evidence_band"),
        Index("ix_skill_evidence_skill", "user_id", "pair_id", "skill_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    skill_id: Mapped[str] = mapped_column(String(64), nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    ref_id: Mapped[str] = mapped_column(String(64), nullable=False)
    outcome: Mapped[str] = mapped_column(String(8), nullable=False)
    band: Mapped[str | None] = mapped_column(String(2))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class LessonEvaluation(Base):
    """Полученная оценка урока (assessment.completed.v1 / assessment.reevaluated.v1, спринт 4): повтор оценки — без
    изменений; цепочка переоценок (supersedes) — какие оценки заменены; practice_only — навыки не меняются.
    outcomes — skill_outcomes события [{skill_id, outcome}]. Неизменяема (UPDATE запрещён; DELETE — сага)."""

    __tablename__ = "lesson_evaluations"
    __table_args__ = (
        CheckConstraint("jsonb_typeof(outcomes) = 'array'", name="ck_lesson_evaluations_outcomes"),
        Index("ix_lesson_evaluations_supersedes", "user_id", "supersedes"),
    )

    evaluation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    supersedes: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    practice_only: Mapped[bool] = mapped_column(Boolean(), nullable=False)
    outcomes: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    received_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class LearnerProfile(Base):
    """Проекция user.profile.created/updated.v1 (только от identity-consent): вид профиля и возрастная полоса —
    защита в глубину для выбора детского теста, если BFF не передал сегмент. Без имени и даты рождения."""

    __tablename__ = "learner_profiles"
    __table_args__ = (
        CheckConstraint("kind IS NULL OR kind IN ('account','child')", name="ck_learner_profiles_kind"),
        CheckConstraint("age_band IS NULL OR age_band IN ('6-9','10-13','14-17','18+')",
                        name="ck_learner_profiles_age_band"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    kind: Mapped[str | None] = mapped_column(String(8))
    age_band: Mapped[str | None] = mapped_column(String(8))
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class DeletedUser(Base):
    """Отметка исполненного удаления (сага TG-FR-006): запросы и события после удаления не воскрешают данные.
    Только псевдонимный user_id и request_id саги — без персональных данных."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
