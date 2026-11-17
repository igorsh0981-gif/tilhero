"""Журнал уведомлений. После перехода в конечный статус params очищаются (там может быть код сброса PIN)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, CheckConstraint, DateTime, Index, Integer, String, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Notification(Base):
    __tablename__ = "notifications"
    # Зеркало миграции 0001 (сверка — tests/test_notifications_schema.py)
    __table_args__ = (
        UniqueConstraint("dedup_key", name="uq_notifications_dedup_key"),  # AT-27: без дублей
        CheckConstraint("kind IN ('critical','transactional','standard','digest')", name="ck_notifications_kind"),
        CheckConstraint(
            "status IN ('queued','scheduled','sent','failed','skipped')", name="ck_notifications_status"
        ),
        CheckConstraint("attempts >= 0", name="ck_notifications_attempts"),
        # Код сброса PIN и прочие параметры не хранятся после конечного статуса
        CheckConstraint("status IN ('queued','scheduled') OR params IS NULL", name="ck_notifications_params_cleared"),
        Index("ix_notifications_user", "user_id"),
        Index(
            "ix_notifications_due", "next_attempt_at", postgresql_where=text("status IN ('queued','scheduled')")
        ),
    )

    notification_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # critical | transactional — сразу (в т.ч. в тихие часы); standard | digest — в тихие часы откладываются
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    template: Mapped[str] = mapped_column(String(64), nullable=False)
    params: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    startapp: Mapped[str | None] = mapped_column(String(64))
    dedup_key: Mapped[str] = mapped_column(String(200), nullable=False)
    # queued | scheduled | sent | failed | skipped
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    telegram_message_id: Mapped[int | None] = mapped_column(BigInteger)
    failure_reason: Mapped[str | None] = mapped_column(String(64))
    source_event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class DeletedUser(Base):
    """Отметка исполненного удаления (TG-FR-006, ревью P3): запоздавшие запросы уведомлений для удалённого
    пользователя не сохраняются (skipped без строки журнала). Только псевдонимный user_id и request_id саги."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class DigestItem(Base):
    """digest_queue (миграция 0003, спринт 6 §5): пункты kind=digest (watch.price_drop, news.digest) копятся до
    digest_time пользователя и уходят одним digest.daily. После сборки params очищаются, строка остаётся
    DIGEST_RETENTION_DAYS как отметка дедупликации (повтор события/перепроверки не даёт второго пункта)."""

    __tablename__ = "digest_queue"
    __table_args__ = (
        UniqueConstraint("dedup_key", name="uq_digest_queue_dedup_key"),
        CheckConstraint("section IN ('watch','news')", name="ck_digest_queue_section"),
        CheckConstraint("digest_id IS NULL OR params IS NULL", name="ck_digest_queue_params_cleared"),
        Index("ix_digest_queue_pending", "user_id", postgresql_where=text("digest_id IS NULL")),
        Index("ix_digest_queue_consumed", "consumed_at", postgresql_where=text("digest_id IS NOT NULL")),
    )

    item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)  # notification_id запроса
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    section: Mapped[str] = mapped_column(String(16), nullable=False)  # watch | news
    template: Mapped[str] = mapped_column(String(64), nullable=False)
    params: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    dedup_key: Mapped[str] = mapped_column(String(200), nullable=False)
    source_event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # Не проверять пользователя раньше этого момента (следующее digest_time, но не позже чем через час)
    not_before: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # notification_id дайджеста (digest.daily), в который вошёл пункт; NULL — ждёт
    digest_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class OpsDelivery(Base):
    """ops_deliveries (миграция 0004, спринт 8 §6): доставка оповещений операторам в Telegram.
    dedup_key = `ops:<alert_id>:<state>:<state_seq>[:<минута напоминания>]` — одно сообщение на переход оповещения
    и на каждое напоминание. Без PII: только
    id оповещения, вид, состояние, коды ошибок. pending — ждёт повтора (429/недоступность), остальные — конечные."""

    __tablename__ = "ops_deliveries"
    __table_args__ = (
        UniqueConstraint("dedup_key", name="uq_ops_deliveries_dedup_key"),
        CheckConstraint("status IN ('pending','sent','skipped','failed')", name="ck_ops_deliveries_status"),
        CheckConstraint("attempts >= 0", name="ck_ops_deliveries_attempts"),
        Index("ix_ops_deliveries_created", "created_at"),
    )

    delivery_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    dedup_key: Mapped[str] = mapped_column(String(200), nullable=False)
    alert_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    template: Mapped[str] = mapped_column(String(64), nullable=False)  # ops.alert.<kind>.<state>
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    last_error: Mapped[str | None] = mapped_column(String(64))  # код ошибки bot-gateway, не текст
    telegram_message_id: Mapped[int | None] = mapped_column(BigInteger)
    source_event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
