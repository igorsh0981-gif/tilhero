"""Модели memory — зеркало миграции 0001 (UNIQUE, индексы и CHECK объявлены и здесь: тест schema_drift).

user_id везде — ученик (`lrn` внутреннего токена). PII сервис не хранит; текст ученика — только цитата ошибки
(`cards.error.evidence`, стирается через 90 дней) и ввод в повторении (`review_tasks.answer`, стирается через
90 дней после сессии). Аудио не хранится нигде (pronunciation_attempts — только баллы).
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
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

CARD_KINDS = ("word", "phrase", "error")
CARD_STATUSES = ("new", "learning", "review", "known", "frozen", "archived")
FSRS_STATES = ("new", "learning", "review")
GLOSS_SOURCES = ("course", "methodist", "ai")
ANSWER_MODES = ("choice", "typed", "assemble", "listen", "manual")
GRADES = ("again", "hard", "good")
SESSION_STATUSES = ("active", "completed", "expired", "cancelled")
TASK_TYPES = ("intro", "meaning_choice", "listen_choice", "typed", "cloze", "assemble", "error_fix", "check_item")
RESULTS = ("correct", "almost", "incorrect")
CHECK_STAGES = ("d7", "d30")
CHECK_STATUSES = ("scheduled", "in_session", "passed", "failed", "cancelled")
SKILL_STATES = ("not_started", "learning", "demonstrated", "retained")
PRON_STATUSES = ("ok", "insufficient_evidence", "unavailable")
INTELLIGIBILITY = ("clear", "mostly_clear", "needs_practice")
AGE_BANDS = ("6-9", "10-13", "14-17", "18+")


def _in(values: tuple[str, ...]) -> str:
    return "IN (" + ",".join(f"'{v}'" for v in values) + ")"


class Base(DeclarativeBase):
    pass


class Card(Base):
    """Карточка личного словаря (INTERNAL_API §1.1): слово, фраза или ошибка. Одна на (ученик, пара, вид, ключ).
    status — для ученика (known/frozen/archived — поверх состояния FSRS), fsrs_state — состояние планировщика
    (new | learning | review): после «Знаю это» / разморозки карточка возвращается в fsrs_state."""

    __tablename__ = "cards"
    __table_args__ = (
        CheckConstraint(f"kind {_in(CARD_KINDS)}", name="ck_cards_kind"),
        CheckConstraint(f"status {_in(CARD_STATUSES)}", name="ck_cards_status"),
        CheckConstraint(f"fsrs_state {_in(FSRS_STATES)}", name="ck_cards_fsrs_state"),
        CheckConstraint(f"gloss_source {_in(GLOSS_SOURCES)}", name="ck_cards_gloss_source"),
        CheckConstraint("archived_by IS NULL OR archived_by IN ('learner','system')", name="ck_cards_archived_by"),
        CheckConstraint("(kind = 'error') = (error IS NOT NULL)", name="ck_cards_error"),
        CheckConstraint("reps >= 0 AND lapses >= 0", name="ck_cards_counters"),
        CheckConstraint("fsrs_state = 'new' OR (stability IS NOT NULL AND difficulty IS NOT NULL)",
                        name="ck_cards_fsrs"),
        CheckConstraint("difficulty IS NULL OR difficulty BETWEEN 1 AND 10", name="ck_cards_difficulty"),
        CheckConstraint("stability IS NULL OR stability > 0", name="ck_cards_stability"),
        UniqueConstraint("user_id", "pair_id", "kind", "key", name="uq_cards_user_key"),
        Index("ix_cards_user_status_due", "user_id", "pair_id", "status", "due_at"),
        Index("ix_cards_user_created", "user_id", "created_at"),
        Index("ix_cards_error_created", "created_at",
              postgresql_where=sql_text("kind = 'error' AND status <> 'archived'")),
    )

    card_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    key: Mapped[str] = mapped_column(String(200), nullable=False)
    text_en: Mapped[str] = mapped_column(String(200), nullable=False)
    gloss: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    gloss_source: Mapped[str] = mapped_column(String(10), nullable=False)
    example_en: Mapped[str | None] = mapped_column(String(200))
    answers_en: Mapped[list[str]] = mapped_column(JSONB(), nullable=False, server_default=sql_text("'[]'::jsonb"))
    distractors: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False,
                                                              server_default=sql_text("'[]'::jsonb"))
    error: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    error_code: Mapped[str | None] = mapped_column(String(32))
    origin_lesson_id: Mapped[str | None] = mapped_column(String(64))
    sources: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False,
                                                          server_default=sql_text("'[]'::jsonb"))
    status: Mapped[str] = mapped_column(String(10), nullable=False)
    fsrs_state: Mapped[str] = mapped_column(String(10), nullable=False)
    stability: Mapped[float | None] = mapped_column(Float())
    difficulty: Mapped[float | None] = mapped_column(Float())
    reps: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    lapses: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    last_review_at: Mapped[datetime | None] = mapped_column(TS)
    due_at: Mapped[datetime | None] = mapped_column(TS)
    archived_by: Mapped[str | None] = mapped_column(String(8))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class ReviewLog(Base):
    """История планирования (неизменяема: UPDATE запрещён триггером; DELETE — только каскадом в саге удаления)."""

    __tablename__ = "review_log"
    __table_args__ = (
        CheckConstraint(f"answer_mode {_in(ANSWER_MODES)}", name="ck_review_log_mode"),
        CheckConstraint(f"grade IS NULL OR grade {_in(GRADES)}", name="ck_review_log_grade"),
        CheckConstraint("actor IN ('learner','system') OR actor LIKE 'staff:%'", name="ck_review_log_actor"),
        ForeignKeyConstraint(["card_id"], ["cards.card_id"], ondelete="CASCADE", name="fk_review_log_card"),
        Index("ix_review_log_card", "card_id", "created_at"),
        Index("ix_review_log_user", "user_id", "created_at"),
        Index("ix_review_log_created", "created_at"),
    )

    log_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    card_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    task_type: Mapped[str] = mapped_column(String(16), nullable=False)
    answer_mode: Mapped[str] = mapped_column(String(10), nullable=False)
    grade: Mapped[str | None] = mapped_column(String(6))
    hinted: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    revealed: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    elapsed_days: Mapped[float | None] = mapped_column(Float())
    before: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    after: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    algorithm: Mapped[str] = mapped_column(String(16), nullable=False)
    params_version: Mapped[str] = mapped_column(String(32), nullable=False)
    actor: Mapped[str] = mapped_column(String(80), nullable=False)
    actor_name: Mapped[str | None] = mapped_column(String(120))
    reason: Mapped[str | None] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class ReviewSession(Base):
    """«Повторение дня» (INTERNAL_API §1.3). plan — task_id по порядку (растёт на повторы карточек с again);
    у ученика не больше одной active (частичный UNIQUE)."""

    __tablename__ = "review_sessions"
    __table_args__ = (
        CheckConstraint(f"status {_in(SESSION_STATUSES)}", name="ck_review_sessions_status"),
        CheckConstraint("audience IN ('kids','teens','adults')", name="ck_review_sessions_audience"),
        CheckConstraint("locale IN ('ru','uz')", name="ck_review_sessions_locale"),
        CheckConstraint("minutes BETWEEN 0 AND 60 AND active_seconds >= 0", name="ck_review_sessions_counters"),
        CheckConstraint("(status = 'active') = (finished_at IS NULL)", name="ck_review_sessions_finished"),
        UniqueConstraint("user_id", "idempotency_key", name="uq_review_sessions_idempotency"),
        Index("uq_review_sessions_active", "user_id", unique=True, postgresql_where=sql_text("status = 'active'")),
        Index("ix_review_sessions_user_date", "user_id", "local_date"),
        Index("ix_review_sessions_status_activity", "status", "last_activity_at"),
        Index("ix_review_sessions_finished", "finished_at"),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False)
    local_date: Mapped[date] = mapped_column(Date(), nullable=False)
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    audience: Mapped[str] = mapped_column(String(8), nullable=False)
    age_band: Mapped[str | None] = mapped_column(String(8))
    locale: Mapped[str] = mapped_column(String(2), nullable=False)
    started_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    last_activity_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(TS)
    active_seconds: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    minutes: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("0"))
    plan: Mapped[list[str]] = mapped_column(JSONB(), nullable=False)
    stats: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    summary: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    idempotency_key: Mapped[str | None] = mapped_column(String(128))


class ReviewTask(Base):
    """Задание сессии: payload — что показано ученику (без ключа), key — у сервиса. Показанное задание неизменяемо,
    ответ записывается один раз; после ответа допустимо только стирание ввода по сроку (answer → NULL)."""

    __tablename__ = "review_tasks"
    __table_args__ = (
        CheckConstraint(f"type {_in(TASK_TYPES)}", name="ck_review_tasks_type"),
        CheckConstraint(f"result IS NULL OR result {_in(RESULTS)}", name="ck_review_tasks_result"),
        CheckConstraint(f"grade IS NULL OR grade {_in(GRADES)}", name="ck_review_tasks_grade"),
        CheckConstraint("(answered_at IS NULL) = (response IS NULL)", name="ck_review_tasks_answered"),
        CheckConstraint("(type = 'check_item') = (check_id IS NOT NULL)", name="ck_review_tasks_target"),
        ForeignKeyConstraint(["session_id"], ["review_sessions.session_id"], ondelete="CASCADE",
                             name="fk_review_tasks_session"),
        UniqueConstraint("session_id", "seq", name="uq_review_tasks_seq"),
        Index("ix_review_tasks_card", "card_id"),
        Index("ix_review_tasks_answered", "answered_at",
              postgresql_where=sql_text("answer IS NOT NULL AND redacted_at IS NULL")),
    )

    task_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    seq: Mapped[int] = mapped_column(Integer(), nullable=False)
    card_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    check_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    type: Mapped[str] = mapped_column(String(16), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    key: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    requeued_from: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    hints: Mapped[list[str]] = mapped_column(JSONB(), nullable=False, server_default=sql_text("'[]'::jsonb"))
    skipped: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    answer: Mapped[Any] = mapped_column(JSONB(none_as_null=True), nullable=True)
    result: Mapped[str | None] = mapped_column(String(10))
    grade: Mapped[str | None] = mapped_column(String(6))
    response: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    answered_at: Mapped[datetime | None] = mapped_column(TS)
    redacted_at: Mapped[datetime | None] = mapped_column(TS)


class RetentionCheck(Base):
    """Проверка удержания навыка (INTERNAL_API §1.5): цепочка d7 → d30 (chain_id), одна незавершённая на навык."""

    __tablename__ = "retention_checks"
    __table_args__ = (
        CheckConstraint(f"stage {_in(CHECK_STAGES)}", name="ck_retention_checks_stage"),
        CheckConstraint(f"status {_in(CHECK_STATUSES)}", name="ck_retention_checks_status"),
        CheckConstraint("consecutive_failures BETWEEN 0 AND 2 AND attempt >= 1 AND postponed >= 0",
                        name="ck_retention_checks_counters"),
        Index("uq_retention_checks_open", "user_id", "pair_id", "skill_id", unique=True,
              postgresql_where=sql_text("status IN ('scheduled','in_session')")),
        Index("ix_retention_checks_due", "status", "due_at"),
        Index("ix_retention_checks_user", "user_id", "created_at"),
        Index("ix_retention_checks_pair_checked", "pair_id", "checked_at"),
    )

    check_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    skill_id: Mapped[str] = mapped_column(String(64), nullable=False)
    chain_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    stage: Mapped[str] = mapped_column(String(4), nullable=False)
    demonstrated_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    evidence_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    due_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False)
    attempt: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("1"))
    consecutive_failures: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("0"))
    postponed: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("0"))
    items: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False,
                                                        server_default=sql_text("'[]'::jsonb"))
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    skill_title: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    cancel_reason: Mapped[str | None] = mapped_column(String(32))
    checked_at: Mapped[datetime | None] = mapped_column(TS)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class PronunciationAttempt(Base):
    """Попытка произношения — только баллы, без аудио (INTERNAL_API §1.9). Хранится 180 дней (tick)."""

    __tablename__ = "pronunciation_attempts"
    __table_args__ = (
        CheckConstraint(f"status {_in(PRON_STATUSES)}", name="ck_pron_status"),
        CheckConstraint(f"intelligibility IS NULL OR intelligibility {_in(INTELLIGIBILITY)}",
                        name="ck_pron_intelligibility"),
        CheckConstraint("audio_ms BETWEEN 0 AND 60000", name="ck_pron_audio_ms"),
        Index("ix_pron_user_card", "user_id", "card_id", "created_at"),
        Index("ix_pron_created", "created_at"),
    )

    attempt_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    target: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    card_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    reference_text: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    scores: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    intelligibility: Mapped[str | None] = mapped_column(String(16))
    words: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False)
    confidence: Mapped[float | None] = mapped_column(Float())
    tips: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False)
    audio_ms: Mapped[int] = mapped_column(Integer(), nullable=False)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class LearnerProjection(Base):
    """Проекция плана из learning.plan.updated.v1 (только от learning-plan) + возрастная полоса из claims
    (последний вызов ученика: детский режим в consumers — защита в глубину)."""

    __tablename__ = "learner_projection"
    __table_args__ = (
        CheckConstraint(f"age_band IS NULL OR age_band {_in(AGE_BANDS)}", name="ck_learner_projection_age_band"),
        CheckConstraint("ui_lang IS NULL OR ui_lang IN ('ru','uz')", name="ck_learner_projection_ui_lang"),
        Index("ix_learner_projection_reminders", "user_id", postgresql_where=sql_text("reminders_enabled")),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    timezone: Mapped[str | None] = mapped_column(String(64))
    course_pair: Mapped[str | None] = mapped_column(String(16))
    reminders_enabled: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    ui_lang: Mapped[str | None] = mapped_column(String(2))
    age_band: Mapped[str | None] = mapped_column(String(8))
    plan_updated_at: Mapped[datetime | None] = mapped_column(TS)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class SkillProjection(Base):
    """Состояние навыка из skills.state.changed.v1 (только от diagnostics)."""

    __tablename__ = "skill_projection"
    __table_args__ = (
        CheckConstraint(f"state {_in(SKILL_STATES)}", name="ck_skill_projection_state"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    pair_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    skill_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    state: Mapped[str] = mapped_column(String(16), nullable=False)
    changed_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class ReminderSent(Base):
    """Не больше одного вечернего напоминания в местный день."""

    __tablename__ = "reminders_sent"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    local_date: Mapped[date] = mapped_column(Date(), primary_key=True)
    due_count: Mapped[int] = mapped_column(Integer(), nullable=False)
    sent_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class ActivityDay(Base):
    """Дни с повторением или уроком (правило «нет активности 14 дней» для проверок удержания)."""

    __tablename__ = "activity_days"
    __table_args__ = (
        CheckConstraint("source IN ('review','lesson')", name="ck_activity_days_source"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    local_date: Mapped[date] = mapped_column(Date(), primary_key=True)
    source: Mapped[str] = mapped_column(String(8), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class FeedLog(Base):
    """Обработанные оценки (идемпотентность создания карточек по evaluation_id)."""

    __tablename__ = "feed_log"
    __table_args__ = (Index("ix_feed_log_user", "user_id"),)

    evaluation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    cards_added: Mapped[int] = mapped_column(Integer(), nullable=False)
    processed_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Idempotency(Base):
    """Idempotency-Key создающих команд ученика (добавление карточки): повтор — тот же ответ."""

    __tablename__ = "idempotency"
    __table_args__ = (Index("ix_idempotency_created", "created_at"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    scope: Mapped[str] = mapped_column(String(32), primary_key=True)
    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status_code: Mapped[int] = mapped_column(SmallInteger(), nullable=False)
    response: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class DeletedUser(Base):
    """Отметка исполненного удаления (сага TG-FR-006): события и запросы после удаления не воскрешают данные."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
