"""Модели assessment — зеркало миграции 0001 (UNIQUE, индексы и CHECK объявлены и здесь: тест schema_drift).

user_id — ученик (`lrn`) из `sub` внутреннего токена; PII сервис не хранит. Тексты ученика хранятся минимально:
ответы на закрытые задания (для итогов ученика), цитаты-доказательства ошибок (≤ 120) и причина апелляции;
реплики ролевой ситуации целиком не хранятся (только метаданные: turn_id, режим, подсказка).
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
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TS = DateTime(timezone=True)


class Base(DeclarativeBase):
    pass


class Evaluation(Base):
    """Оценка сессии (INTERNAL_API §3.1). Неизменяема (триггер evaluations_immutable запрещает UPDATE; DELETE —
    только сага удаления ученика). Переоценка — новая запись `supersedes = <id>`: у сессии одна исходная (системная)
    запись и линейная цепочка переоценок; актуальна последняя (без преемника)."""

    __tablename__ = "evaluations"
    __table_args__ = (
        CheckConstraint("kind IN ('lesson','scenario','media','review')", name="ck_evaluations_kind"),
        CheckConstraint("audience IN ('kids','teens','adults')", name="ck_evaluations_audience"),
        CheckConstraint("status IN ('ok','partial','insufficient_evidence','pending_review')",
                        name="ck_evaluations_status"),
        CheckConstraint("outcome IS NULL OR outcome IN ('success','alt_success','fail')",
                        name="ck_evaluations_outcome"),
        CheckConstraint("ai_status IN ('not_used','ok','unavailable','refused')", name="ck_evaluations_ai_status"),
        CheckConstraint("rubric_version >= 1", name="ck_evaluations_rubric_version"),
        CheckConstraint("weighted IS NULL OR weighted BETWEEN 0 AND 3", name="ck_evaluations_weighted"),
        CheckConstraint("(weighted IS NULL) = (passed IS NULL)", name="ck_evaluations_verdict"),
        CheckConstraint("passed IS NULL OR status IN ('ok','partial')", name="ck_evaluations_passed_status"),
        CheckConstraint(
            "(supersedes IS NULL AND created_by IS NULL AND reason IS NULL AND appeal_id IS NULL "
            "AND idempotency_key IS NULL) "
            "OR (supersedes IS NOT NULL AND created_by IS NOT NULL AND reason IS NOT NULL)",
            name="ck_evaluations_origin"),
        CheckConstraint("supersedes IS DISTINCT FROM evaluation_id", name="ck_evaluations_not_self"),
        ForeignKeyConstraint(["supersedes"], ["evaluations.evaluation_id"], name="fk_evaluations_supersedes"),
        UniqueConstraint("supersedes", name="uq_evaluations_supersedes"),
        UniqueConstraint("created_by", "idempotency_key", name="uq_evaluations_staff_idempotency"),
        Index("uq_evaluations_session_root", "session_id", unique=True, postgresql_where=text("supersedes IS NULL")),
        Index("ix_evaluations_session", "session_id", "created_at"),
        Index("ix_evaluations_user", "user_id", "created_at"),
        Index("ix_evaluations_created", "created_at"),
    )

    evaluation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    audience: Mapped[str] = mapped_column(String(8), nullable=False)
    # [{kind, key, version}] — версии контента, по которым оценено (ключи и рубрика — из catalog по ним)
    content_refs: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False)
    rubric_id: Mapped[str] = mapped_column(String(64), nullable=False)
    rubric_version: Mapped[int] = mapped_column(Integer(), nullable=False)
    # снимок рубрики версии: {criteria: [{code, weight, title}], pass_rule} — для итогов и переоценки без catalog
    rubric: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    scores: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    weighted: Mapped[float | None] = mapped_column(Float())
    passed: Mapped[bool | None] = mapped_column(Boolean())
    task_completed: Mapped[bool | None] = mapped_column(Boolean())
    outcome: Mapped[str | None] = mapped_column(String(12))
    confirmed_errors: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False)
    # [{item_id, skill_id, type, correct, hinted, answered, prompt_en, your_answer, correct_answer}]
    items: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False)
    # метаданные реплик ученика без текста: [{turn_id, mode, hinted}] (для проверки turn_id ошибок при переоценке)
    turns: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False)
    # [{skill_id, outcome, evidence_refs}]; practice_only → []
    skill_outcomes: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False)
    practice_only: Mapped[bool] = mapped_column(Boolean(), nullable=False)
    support_used: Mapped[bool] = mapped_column(Boolean(), nullable=False)
    # {agent_id, agent_version, prompt_version, model_id, schema_version, canary} | null — оценено только правилами
    evaluator: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    ai_status: Mapped[str] = mapped_column(String(16), nullable=False)
    ai_reason: Mapped[str | None] = mapped_column(String(32))
    requires_human_review: Mapped[bool] = mapped_column(Boolean(), nullable=False)
    supersedes: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    appeal_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_by: Mapped[str | None] = mapped_column(String(64))  # null — система; иначе staff_id
    reason: Mapped[str | None] = mapped_column(String(500))  # основание переоценки (≥ 10)
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Appeal(Base):
    """Апелляция ученика: одна на оценку сессии (цепочку), в течение окна. Решённая — неизменяема (триггер
    appeals_guard: переходы new → in_review → upheld | corrected, поля подачи не меняются) — кроме стирания текста
    ученика через 90 дней после решения (reason → NULL, reason_redacted_at; ревью R1-14)."""

    __tablename__ = "appeals"
    __table_args__ = (
        CheckConstraint("status IN ('new','in_review','upheld','corrected')", name="ck_appeals_status"),
        CheckConstraint(
            "(reason IS NOT NULL AND reason_redacted_at IS NULL AND char_length(reason) BETWEEN 1 AND 500) "
            "OR (reason IS NULL AND reason_redacted_at IS NOT NULL AND status IN ('upheld','corrected'))",
            name="ck_appeals_reason"),
        CheckConstraint("status = 'new' OR (taken_by IS NOT NULL AND taken_at IS NOT NULL)", name="ck_appeals_taken"),
        CheckConstraint(
            "(status IN ('upheld','corrected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL "
            "AND decision_note IS NOT NULL)", name="ck_appeals_decision"),
        CheckConstraint("(status = 'corrected') = (new_evaluation_id IS NOT NULL)", name="ck_appeals_corrected"),
        ForeignKeyConstraint(["evaluation_id"], ["evaluations.evaluation_id"], name="fk_appeals_evaluation"),
        ForeignKeyConstraint(["new_evaluation_id"], ["evaluations.evaluation_id"], name="fk_appeals_new_evaluation"),
        UniqueConstraint("session_id", name="uq_appeals_session"),
        UniqueConstraint("evaluation_id", name="uq_appeals_evaluation"),
        UniqueConstraint("user_id", "idempotency_key", name="uq_appeals_user_idempotency"),
        Index("ix_appeals_status_created", "status", "created_at"),
        Index("ix_appeals_user_created", "user_id", "created_at"),
        Index("ix_appeals_reason_retention", "decided_at",
              postgresql_where=text("reason IS NOT NULL AND decided_at IS NOT NULL")),
    )

    appeal_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    evaluation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(500))  # NULL — стёрт по сроку хранения
    status: Mapped[str] = mapped_column(String(12), nullable=False)
    taken_by: Mapped[str | None] = mapped_column(String(64))
    taken_at: Mapped[datetime | None] = mapped_column(TS)
    decided_by: Mapped[str | None] = mapped_column(String(64))
    decision_note: Mapped[str | None] = mapped_column(String(500))
    decided_at: Mapped[datetime | None] = mapped_column(TS)
    new_evaluation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    reason_redacted_at: Mapped[datetime | None] = mapped_column(TS)


class Flag(Base):
    """QA-флаг спорной оценки (без изменения оценки). Append-only (триггер flags_immutable)."""

    __tablename__ = "flags"
    __table_args__ = (
        CheckConstraint("char_length(reason) BETWEEN 1 AND 500", name="ck_flags_reason"),
        ForeignKeyConstraint(["evaluation_id"], ["evaluations.evaluation_id"], name="fk_flags_evaluation"),
        UniqueConstraint("created_by", "idempotency_key", name="uq_flags_staff_idempotency"),
        Index("ix_flags_evaluation", "evaluation_id", "created_at"),
        Index("ix_flags_user", "user_id"),
    )

    flag_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    evaluation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)  # ученик — для саги удаления
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class DeletedUser(Base):
    """Отметка исполненного удаления (сага TG-FR-006): запросы после удаления не воскрешают данные."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
