"""Таблицы саги удаления (ADR-009, миграции 0001 и 0003). Зеркало миграций: CHECK, UNIQUE и индексы объявлены и здесь
(tests: schema_drift).

- `deletion_requests` — запрос удаления: статус REQUESTED → (STUCK) → COMPLETED, ожидаемые и подтвердившие домены,
  расписание повторов (`attempts`, `last_sent_at`, `next_retry_at`), момент «зависло» (`stuck_at`).
- `deletion_domain_acks` — ACK домена со временем и режимом; заполняется вместе с `acked_domains` (массив остаётся для
  совместимости).
- `deletion_attempts` — история рассылок: первичная (by = user), повторы таймера (system) и сотрудника (staff_id).
- `deletion_idempotency_keys` — Idempotency-Key ручного повтора (сотрудник, ключ) с сохранённым ответом.

PII здесь нет: только `user_id` (псевдоним), домены и время.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
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
        # «открытый ждёт повтора, завершённый — нет» — инвариант кода, не CHECK: код спринта 8 (раскатка, откат) создаёт
        # запрос без next_retry_at и не обнуляет его при завершении (миграция 0003, ревью БЭК-1)
        CheckConstraint("status <> 'STUCK' OR stuck_at IS NOT NULL", name="ck_deletion_stuck_at"),
        Index("ix_deletion_requests_user", "user_id"),
        # не больше одного открытого (REQUESTED или STUCK) запроса на пользователя
        Index("uq_deletion_requests_open", "user_id", unique=True, postgresql_where=text(OPEN_SQL)),
        # таймер: открытые запросы, у которых подошёл повтор
        Index("ix_deletion_requests_due", "next_retry_at", postgresql_where=text(OPEN_SQL)),
        # админ-список «новые сверху» и курсор (requested_at, request_id)
        Index("ix_deletion_requests_requested", "requested_at", "request_id"),
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
    # --- спринт 9 (миграция 0003)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")  # 1 — первичная рассылка
    last_sent_at: Mapped[datetime | None] = mapped_column(TS)
    next_retry_at: Mapped[datetime | None] = mapped_column(TS)
    stuck_at: Mapped[datetime | None] = mapped_column(TS)
    last_retry_by: Mapped[str | None] = mapped_column(String(64))  # system | staff_id


class DeletionDomainAck(Base):
    __tablename__ = "deletion_domain_acks"
    __table_args__ = (
        CheckConstraint("mode IS NULL OR mode IN ('deleted','anonymized')", name="ck_deletion_ack_mode"),
    )

    request_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey(REQUEST_FK, ondelete="CASCADE"), primary_key=True
    )
    domain: Mapped[str] = mapped_column(String(64), primary_key=True)
    acked_at: Mapped[datetime | None] = mapped_column(TS)  # NULL — ACK до спринта 9 (время неизвестно)
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
    sent_by: Mapped[str] = mapped_column(String(64), nullable=False)  # user | system | staff_id
    event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))  # NULL — рассылка до спринта 9


class DeletionIdempotencyKey(Base):
    __tablename__ = "deletion_idempotency_keys"

    actor_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    status_code: Mapped[int | None] = mapped_column(Integer)
    response: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
