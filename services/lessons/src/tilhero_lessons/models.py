"""Модели lessons — зеркало миграции 0001 (UNIQUE, индексы и CHECK объявлены и здесь: тест schema_drift).

user_id везде — ученик (`lrn` внутреннего токена), account_id — аккаунт (`sub`). PII сервис не хранит; тексты
учеников (свободные реплики и открытые ответы) хранятся 90 дней и стираются `lessons-tick` (redacted_at).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKeyConstraint,
    Index,
    Integer,
    SmallInteger,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TS = DateTime(timezone=True)
BAND_CHECK = "IN ('A0','A1','A2','B1','B2')"
KINDS = ("lesson", "scenario", "media", "review")
STATUSES = ("ready", "in_progress", "paused", "completed", "failed", "cancelled")
ACTIVE_STATUSES = ("ready", "in_progress", "paused")
STAGES = ("retrieval", "explanation", "roleplay", "assessment", "summary", "listen", "exercises")
STEP_TYPES = ("notice", "explanation", "item", "roleplay", "roleplay_end", "listen", "open_answer", "done")
HISTORY_REASONS = ("started", "pause", "resume", "auto_pause", "finish", "fail", "cancel", "expired",
                   "content_unpublished")


def _in(values: tuple[str, ...]) -> str:
    return "IN (" + ",".join(f"'{v}'" for v in values) + ")"


class Base(DeclarativeBase):
    pass


class Session(Base):
    """Сессия урока, сценария, медиа или повтора (INTERNAL_API §2.1). Статус меняет только сервер (машина
    состояний domain/machine.py); у ученика не больше одной незавершённой сессии (частичный UNIQUE).
    content_versions — версии контента, зафиксированные при старте; plan — этапы и задания (без ключей);
    state — положение в плане и ролевой ситуации."""

    __tablename__ = "sessions"
    __table_args__ = (
        CheckConstraint(f"kind {_in(KINDS)}", name="ck_sessions_kind"),
        CheckConstraint(f"status {_in(STATUSES)}", name="ck_sessions_status"),
        CheckConstraint(f"stage IS NULL OR stage {_in(STAGES)}", name="ck_sessions_stage"),
        CheckConstraint("audience IN ('kids','teens','adults')", name="ck_sessions_audience"),
        CheckConstraint("locale IN ('ru','uz')", name="ck_sessions_locale"),
        CheckConstraint("ai_mode IN ('full','choices')", name="ck_sessions_ai_mode"),
        CheckConstraint("outcome IS NULL OR outcome IN ('success','alt_success','fail')", name="ck_sessions_outcome"),
        CheckConstraint(f"level IS NULL OR level {BAND_CHECK}", name="ck_sessions_level"),
        CheckConstraint("evaluation_status IN ('none','pending','done','failed')", name="ck_sessions_evaluation"),
        CheckConstraint("minutes BETWEEN 0 AND 600", name="ck_sessions_minutes"),
        CheckConstraint("active_seconds >= 0 AND hints_used >= 0 AND step_index >= 0", name="ck_sessions_counters"),
        CheckConstraint("(kind <> 'lesson' OR lesson_id IS NOT NULL) AND (kind <> 'scenario' OR scenario_id IS NOT "
                        "NULL) AND (kind <> 'media' OR asset_id IS NOT NULL) AND (kind <> 'review' OR "
                        "source_session_id IS NOT NULL)", name="ck_sessions_target"),
        UniqueConstraint("user_id", "idempotency_key", name="uq_sessions_user_idempotency"),
        Index("uq_sessions_active", "user_id", unique=True,
              postgresql_where=sql_text("status IN ('ready','in_progress','paused')")),
        Index("ix_sessions_user_created", "user_id", "created_at"),
        Index("ix_sessions_account", "account_id"),
        Index("ix_sessions_created", "created_at"),
        Index("ix_sessions_status_activity", "status", "last_activity_at"),
        Index("ix_sessions_evaluation_pending", "finished_at",
              postgresql_where=sql_text("evaluation_status = 'pending'")),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    account_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    course_id: Mapped[str | None] = mapped_column(String(64))
    lesson_id: Mapped[str | None] = mapped_column(String(64))
    scenario_id: Mapped[str | None] = mapped_column(String(64))
    asset_id: Mapped[str | None] = mapped_column(String(64))
    source_session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    title: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    level: Mapped[str | None] = mapped_column(String(2))
    audience: Mapped[str] = mapped_column(String(8), nullable=False)
    locale: Mapped[str] = mapped_column(String(2), nullable=False, server_default=sql_text("'ru'"))
    ai_mode: Mapped[str] = mapped_column(String(8), nullable=False)
    ai_degraded: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    ai_used: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    hints_used: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    seed: Mapped[str] = mapped_column(String(64), nullable=False)
    content_versions: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    plan: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    state: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False)
    stage: Mapped[str | None] = mapped_column(String(16))
    step_index: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    duration_min: Mapped[int] = mapped_column(SmallInteger(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(TS)
    paused_at: Mapped[datetime | None] = mapped_column(TS)
    finished_at: Mapped[datetime | None] = mapped_column(TS)
    last_activity_at: Mapped[datetime | None] = mapped_column(TS)
    active_seconds: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    minutes: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("0"))
    outcome: Mapped[str | None] = mapped_column(String(12))
    practice_only: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    evaluation_status: Mapped[str] = mapped_column(String(12), nullable=False, server_default=sql_text("'none'"))
    evaluation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    evaluation: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    evaluation_attempts: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("0"))
    summary: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    fail_reason: Mapped[str | None] = mapped_column(String(32))
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    request_hash: Mapped[str | None] = mapped_column(String(64))


class StatusHistory(Base):
    """История смены статусов (AT-41): append-only (UPDATE запрещён триггером; DELETE — только с сессией в саге)."""

    __tablename__ = "status_history"
    __table_args__ = (
        CheckConstraint(f"from_status IS NULL OR from_status {_in(STATUSES)}", name="ck_status_history_from"),
        CheckConstraint(f"to_status {_in(STATUSES)}", name="ck_status_history_to"),
        CheckConstraint(f"reason {_in(HISTORY_REASONS)}", name="ck_status_history_reason"),
        ForeignKeyConstraint(["session_id"], ["sessions.session_id"], ondelete="CASCADE",
                             name="fk_status_history_session"),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(SmallInteger(), primary_key=True)
    from_status: Mapped[str | None] = mapped_column(String(12))
    to_status: Mapped[str] = mapped_column(String(12), nullable=False)
    reason: Mapped[str] = mapped_column(String(24), nullable=False)
    at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Step(Base):
    """Шаг урока s{n} (INTERNAL_API §2.1): payload — что показано ученику (без ключей), ref — служебная ссылка на
    задание/узел (не уходит наружу), response — feedback/reply ответа для идемпотентного повтора.
    Показанный шаг неизменяем; ответ записывается один раз; после ответа меняется только стирание текста."""

    __tablename__ = "steps"
    __table_args__ = (
        CheckConstraint(f"stage {_in(STAGES)}", name="ck_steps_stage"),
        CheckConstraint(f"type {_in(STEP_TYPES)}", name="ck_steps_type"),
        CheckConstraint("result IS NULL OR result IN ('correct','incorrect','skipped')", name="ck_steps_result"),
        CheckConstraint("hints >= 0", name="ck_steps_hints"),
        CheckConstraint("(answered_at IS NULL) = (response IS NULL)", name="ck_steps_answered"),
        ForeignKeyConstraint(["session_id"], ["sessions.session_id"], ondelete="CASCADE", name="fk_steps_session"),
        UniqueConstraint("session_id", "step_id", name="uq_steps_session_step"),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(Integer(), primary_key=True)
    step_id: Mapped[str] = mapped_column(String(8), nullable=False)
    stage: Mapped[str] = mapped_column(String(16), nullable=False)
    type: Mapped[str] = mapped_column(String(16), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    ref: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    answer: Mapped[Any] = mapped_column(JSONB(none_as_null=True), nullable=True)
    result: Mapped[str | None] = mapped_column(String(12))
    hints: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("0"))
    response: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    answered_at: Mapped[datetime | None] = mapped_column(TS)
    redacted_at: Mapped[datetime | None] = mapped_column(TS)


class Turn(Base):
    """Реплика ролевой ситуации T{n}: ученик (выбор или свободный текст) или персонаж (реплика графа или ИИ).
    Текст свободных реплик стирается через 90 дней (redacted_at); остальные поля неизменяемы (триггер)."""

    __tablename__ = "turns"
    __table_args__ = (
        CheckConstraint("speaker IN ('learner','character')", name="ck_turns_speaker"),
        CheckConstraint("mode IN ('choice','text')", name="ck_turns_mode"),
        CheckConstraint("attempt IN (1, 2)", name="ck_turns_attempt"),
        CheckConstraint("text IS NOT NULL OR redacted_at IS NOT NULL", name="ck_turns_text"),
        ForeignKeyConstraint(["session_id"], ["sessions.session_id"], ondelete="CASCADE", name="fk_turns_session"),
        UniqueConstraint("session_id", "turn_id", name="uq_turns_session_turn"),
        Index("ix_turns_redact", "created_at", postgresql_where=sql_text("mode = 'text' AND redacted_at IS NULL")),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(Integer(), primary_key=True)
    turn_id: Mapped[str] = mapped_column(String(8), nullable=False)
    step_seq: Mapped[int] = mapped_column(Integer(), nullable=False)
    attempt: Mapped[int] = mapped_column(SmallInteger(), nullable=False)
    node_id: Mapped[str] = mapped_column(String(64), nullable=False)
    speaker: Mapped[str] = mapped_column(String(10), nullable=False)
    character_id: Mapped[str | None] = mapped_column(String(64))
    mode: Mapped[str] = mapped_column(String(8), nullable=False)
    text: Mapped[str | None] = mapped_column(String(500))
    intent: Mapped[str | None] = mapped_column(String(64))
    hinted: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    ai_call_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    redacted_at: Mapped[datetime | None] = mapped_column(TS)


class ReviewItem(Base):
    """Очередь повторения до спринта 5 (memory): задание урока с ошибкой или подсказкой возвращается в этапе
    «повторение» после due_at. На (ученик, пара, урок, задание) — одна нерешённая запись."""

    __tablename__ = "review_items"
    __table_args__ = (
        CheckConstraint("reason IN ('wrong','hinted')", name="ck_review_items_reason"),
        CheckConstraint("lesson_version >= 1", name="ck_review_items_version"),
        Index("uq_review_items_open", "user_id", "pair_id", "lesson_id", "item_id", unique=True,
              postgresql_where=sql_text("resolved_at IS NULL")),
        Index("ix_review_items_due", "user_id", "pair_id", "due_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    lesson_id: Mapped[str] = mapped_column(String(64), nullable=False)
    lesson_version: Mapped[int] = mapped_column(Integer(), nullable=False)
    item_id: Mapped[str] = mapped_column(String(64), nullable=False)
    skill_id: Mapped[str] = mapped_column(String(64), nullable=False)
    reason: Mapped[str] = mapped_column(String(8), nullable=False)
    due_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    resolved_at: Mapped[datetime | None] = mapped_column(TS)
    source_session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class LearnerProfile(Base):
    """Проекция user.profile.created/updated.v1 (только от identity-consent): вид профиля и возрастная полоса —
    «липкий» детский режим (защита в глубину, если BFF не передал claims). Без имени и даты рождения."""

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
    """Отметка исполненного удаления (сага TG-FR-006): запросы и события после удаления не воскрешают данные."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
