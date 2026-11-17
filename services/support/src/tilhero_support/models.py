"""Модели support-service. Таблицы без схемы — попадают в схему `support` через search_path.

Ограничения и индексы — зеркало миграций (пишутся руками, без autogenerate); сверка моделей с БД после
миграций — tests/test_support_schema.py (ревью спринта 1, P6).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    Sequence,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


STATUSES_SQL = "('NEW','IN_PROGRESS','WAITING_CUSTOMER','RESOLVED','CLOSED')"
PRIORITIES_SQL = "('low','normal','high','urgent')"
CATEGORIES_SQL = (
    "('LESSON','ASSESSMENT','SCHEDULE_REMINDERS','CHILD_PROFILE','ACCOUNT','SUBSCRIPTION_PAYMENT',"
    "'PERSONAL_DATA','BUG','OTHER')"
)


# Человекочитаемый номер TCK-NNNN: последовательность с 3000, значение — через nextval (не ORDER BY: дефект
# FinAdvisor «ID тикета через SELECT ORDER BY» не переносим).
ticket_number_seq = Sequence("ticket_number_seq", start=3000, metadata=Base.metadata)


class Ticket(Base):
    __tablename__ = "tickets"
    __table_args__ = (
        UniqueConstraint("number", name="uq_tickets_number"),
        # Idempotency-Key создания обращения: повтор возвращает тот же тикет (CONVENTIONS §2)
        UniqueConstraint("user_id", "idempotency_key", name="uq_tickets_user_idempotency"),
        CheckConstraint(f"status IN {STATUSES_SQL}", name="ck_tickets_status"),
        CheckConstraint(f"priority IN {PRIORITIES_SQL}", name="ck_tickets_priority"),
        CheckConstraint(f"category IN {CATEGORIES_SQL}", name="ck_tickets_category"),
        CheckConstraint("user_unread_operator_replies >= 0", name="ck_tickets_unread"),
        Index("ix_tickets_user_number", "user_id", "number"),
        Index("ix_tickets_status", "status"),
        Index("ix_tickets_assignee", "assignee_id"),
        Index("ix_tickets_category_priority", "category", "priority"),
    )

    ticket_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    number: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default=text("nextval('ticket_number_seq')")
    )
    # NULL после обезличивания по запросу удаления (TG-FR-006)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    channel: Mapped[str] = mapped_column(String(32), nullable=False)
    category: Mapped[str] = mapped_column(String(32), nullable=False)
    subject: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    priority: Mapped[str] = mapped_column(String(10), nullable=False)
    assignee_id: Mapped[str | None] = mapped_column(String(64))
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    request_fingerprint: Mapped[str | None] = mapped_column(String(64))
    context: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    correlation_id: Mapped[str | None] = mapped_column(String(64))
    sla_first_response_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    sla_resolution_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    first_response_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    anonymized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # updated_at/last_message_at меняются только видимыми клиенту действиями: внутренние заметки, назначение,
    # эскалации и приоритет их не трогают (метаданные не должны выдавать служебную работу, TG-FR-044).
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_message_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    user_unread_operator_replies: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        UniqueConstraint("seq", name="uq_messages_seq"),
        # Idempotency-Key отправки сообщения (повтор той же отправки не дублирует сообщение)
        UniqueConstraint("ticket_id", "client_key", name="uq_messages_client_key"),
        CheckConstraint("sender_type IN ('user','operator','system')", name="ck_messages_sender"),
        CheckConstraint("visibility IN ('public','internal')", name="ck_messages_visibility"),
        # Внутренняя заметка может быть только у сотрудника; клиентское сообщение всегда публичное
        CheckConstraint("visibility = 'public' OR sender_type = 'operator'", name="ck_messages_internal_staff"),
        Index("ix_messages_ticket_seq", "ticket_id", "seq"),
        # Лимит сообщений клиента в час: по обращениям пользователя, а не по всем сообщениям (миграция 0002)
        Index("ix_messages_ticket_sender_created", "ticket_id", "sender_type", "created_at"),
    )

    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), nullable=False)
    message_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    ticket_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tickets.ticket_id", ondelete="CASCADE"), nullable=False
    )
    sender_type: Mapped[str] = mapped_column(String(16), nullable=False)
    visibility: Mapped[str] = mapped_column(String(16), nullable=False)
    author_id: Mapped[str | None] = mapped_column(String(64))
    author_name: Mapped[str | None] = mapped_column(String(80))
    text: Mapped[str] = mapped_column(Text, nullable=False)
    client_key: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class StatusHistory(Base):
    __tablename__ = "status_history"
    __table_args__ = (
        CheckConstraint(f"to_status IN {STATUSES_SQL}", name="ck_status_history_to"),
        CheckConstraint("changed_by IN ('user','operator','system')", name="ck_status_history_by"),
        Index("ix_status_history_ticket", "ticket_id", "id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    ticket_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tickets.ticket_id", ondelete="CASCADE"), nullable=False
    )
    from_status: Mapped[str | None] = mapped_column(String(20))
    to_status: Mapped[str] = mapped_column(String(20), nullable=False)
    changed_by: Mapped[str] = mapped_column(String(16), nullable=False)
    actor_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Escalation(Base):
    __tablename__ = "escalations"
    __table_args__ = (
        UniqueConstraint("ticket_id", "idempotency_key", name="uq_escalations_idempotency"),
        CheckConstraint(
            "type IN ('billing_review','assessment_review','content_review','tech_issue','security_privacy')",
            name="ck_escalations_type",
        ),
        CheckConstraint("status IN ('OPEN','DONE')", name="ck_escalations_status"),
        Index("ix_escalations_ticket", "ticket_id", "created_at"),
    )

    escalation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    ticket_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tickets.ticket_id", ondelete="CASCADE"), nullable=False
    )
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="OPEN")
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class SlaPolicy(Base):
    """SLA по категории и приоритету; category='*' — значение для любой категории."""

    __tablename__ = "sla_policies"
    __table_args__ = (
        CheckConstraint(f"priority IN {PRIORITIES_SQL}", name="ck_sla_priority"),
        CheckConstraint(
            "first_response_minutes > 0 AND resolution_minutes > first_response_minutes", name="ck_sla_minutes"
        ),
    )

    category: Mapped[str] = mapped_column(String(32), primary_key=True)
    priority: Mapped[str] = mapped_column(String(10), primary_key=True)
    first_response_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    resolution_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_by: Mapped[str | None] = mapped_column(String(64))


class DeletedUser(Base):
    """Отметка исполненного удаления (TG-FR-006, ревью P3): после обезличивания клиентские команды этого
    user_id → 410 USER_DELETED, новые обращения не создаются. Только псевдонимный user_id и request_id саги."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
