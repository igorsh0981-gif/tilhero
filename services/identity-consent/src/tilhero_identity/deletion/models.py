"""Таблицы саги удаления (миграция 0001). Зеркало миграции: CHECK, UNIQUE и индексы объявлены и здесь
(tests: schema_drift).

- `deletion_requests` — запрос удаления ученика (аккаунта или детского профиля — у каждого свой request_id; запрос
  ребёнка ссылается на запрос аккаунта родителя `parent_request_id`): статус REQUESTED → (STUCK) → COMPLETED,
  ожидаемые и подтвердившие домены, расписание повторов (`attempts`, `last_sent_at`, `next_retry_at`), момент
  «зависло» (`stuck_at`).
- `deletion_domain_acks` — ACK домена со временем и режимом (вместе с `acked_domains`).
- `deletion_attempts` — история рассылок: первичная (by = user) и повторы таймера (system).

PII здесь нет: только `user_id` (псевдоним), домены и время.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from tilhero_identity.base import USER_FK, Base

TS = DateTime(timezone=True)
REQUEST_FK = "deletion_requests.request_id"
OPEN_SQL = "status IN ('REQUESTED','STUCK')"


class DeletionRequest(Base):
    __tablename__ = "deletion_requests"
    __table_args__ = (
        CheckConstraint("status IN ('REQUESTED','STUCK','COMPLETED')", name="ck_deletion_status"),
        CheckConstraint("attempts >= 1", name="ck_deletion_attempts"),
        CheckConstraint("(status = 'COMPLETED') = (completed_at IS NOT NULL)", name="ck_deletion_completed"),
        CheckConstraint("status <> 'STUCK' OR stuck_at IS NOT NULL", name="ck_deletion_stuck_at"),
        Index("ix_deletion_requests_user", "user_id"),
        Index("ix_deletion_requests_parent", "parent_request_id"),
        # не больше одного открытого (REQUESTED или STUCK) запроса на ученика
        Index("uq_deletion_requests_open", "user_id", unique=True, postgresql_where=text(OPEN_SQL)),
        # таймер: открытые запросы, у которых подошёл повтор
        Index("ix_deletion_requests_due", "next_retry_at", postgresql_where=text(OPEN_SQL)),
    )

    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey(USER_FK), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="REQUESTED")
    requested_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(TS)
    expected_domains: Mapped[list[str]] = mapped_column(ARRAY(String(64)), nullable=False)
    acked_domains: Mapped[list[str]] = mapped_column(
        ARRAY(String(64)), nullable=False, server_default=text("'{}'::varchar[]")
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")  # 1 — первичная рассылка
    last_sent_at: Mapped[datetime | None] = mapped_column(TS)
    next_retry_at: Mapped[datetime | None] = mapped_column(TS)
    stuck_at: Mapped[datetime | None] = mapped_column(TS)
    last_retry_by: Mapped[str | None] = mapped_column(String(64))  # system
    # удаление аккаунта запускает удаление каждого ребёнка: запрос ребёнка → запрос аккаунта
    parent_request_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey(REQUEST_FK))


class DeletionDomainAck(Base):
    __tablename__ = "deletion_domain_acks"
    __table_args__ = (
        CheckConstraint("mode IS NULL OR mode IN ('deleted','anonymized')", name="ck_deletion_ack_mode"),
    )

    request_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey(REQUEST_FK, ondelete="CASCADE"), primary_key=True
    )
    domain: Mapped[str] = mapped_column(String(64), primary_key=True)
    acked_at: Mapped[datetime | None] = mapped_column(TS)
    mode: Mapped[str | None] = mapped_column(String(16))
    event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))  # event_id ACK-события


class DeletionAttempt(Base):
    __tablename__ = "deletion_attempts"
    __table_args__ = (CheckConstraint("attempt >= 1", name="ck_deletion_attempt_positive"),)

    request_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey(REQUEST_FK, ondelete="CASCADE"), primary_key=True
    )
    attempt: Mapped[int] = mapped_column(Integer, primary_key=True)
    sent_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    sent_by: Mapped[str] = mapped_column(String(64), nullable=False)  # user | system
    event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
