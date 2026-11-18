"""Read-модель пользователей для админки (схема user_admin). Таблицы без схемы — search_path сервиса.

Данными не владеет: authoritative-источник — identity-consent (профиль, статус, согласие, безопасность),
preferences (онбординг) и support (обращения). PII — копия username/имени только для поиска; полного Telegram ID нет
(только маска «••••••789»). После удаления пользователя (user.domain.deleted.v1 от identity-consent) username/имя
стираются, связь с обращениями разрывается.

Порядок событий не гарантирован: у каждой группы полей своя «версия» (момент события/снимка, *_at; у уровня доступа —
версия назначения ai-control), более старое событие не перезаписывает более новое состояние.
Модели — зеркало миграций (tests: schema_drift).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

USER_STATUSES = ("ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED")
TICKET_STATUSES = ("NEW", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED")
OPEN_TICKET_STATUSES = ("NEW", "IN_PROGRESS", "WAITING_CUSTOMER")
MASK = "•"
MASK_NONE = MASK * 9
TS = DateTime(timezone=True)


class Base(DeclarativeBase):
    pass


class UserSummary(Base):
    __tablename__ = "admin_user_summary"
    __table_args__ = (
        CheckConstraint(
            "status IN ('ACTIVE','DISABLED','DELETION_REQUESTED','DELETED')", name="ck_summary_status"
        ),
        CheckConstraint("open_tickets >= 0 AND tickets_total >= open_tickets", name="ck_summary_tickets"),
        # Инвариант удаления: у удалённого пользователя в read-модели нет username и имени
        CheckConstraint(
            "status <> 'DELETED' OR (username IS NULL AND display_name IS NULL)", name="ck_summary_deleted_erased"
        ),
        Index("ix_summary_created", "created_at", "user_id"),
        Index("ix_summary_status", "status"),
        # спринт 7 (миграция 0002): уровень доступа к AI — проекция user.access_level.changed.v1 (ai-control)
        CheckConstraint("access_level_source IS NULL OR access_level_source IN ('default','manual')",
                        name="ck_summary_access_level_source"),
        CheckConstraint("access_level IS NULL OR access_level ~ '^[a-z][a-z0-9_]{1,31}$'",
                        name="ck_summary_access_level_code"),
        CheckConstraint("(access_level_source IS DISTINCT FROM 'manual' OR access_level IS NOT NULL) "
                        "AND (access_level_expires_at IS NULL OR access_level_source = 'manual')",
                        name="ck_summary_access_level_manual"),
        CheckConstraint("(access_level_version IS NULL) = (access_level_source IS NULL) AND "
                        "(access_level_version IS NULL OR access_level_version >= 1)",
                        name="ck_summary_access_level_version"),
        CheckConstraint("status <> 'DELETED' OR (access_level IS NULL AND access_level_source IS NULL "
                        "AND access_level_expires_at IS NULL)", name="ck_summary_deleted_access_level"),
        Index("ix_summary_access_level", "access_level", postgresql_where=text("access_level_source = 'manual'")),
        # спринт 8 (миграция 0003): активные за период — last_seen_at ≥ начала периода (дашборд)
        Index("ix_summary_last_seen", "last_seen_at"),
        # спринт 9 (миграция 0004): «удаление зависло» (user.deletion.stuck.v1) — только у незавершённого удаления
        CheckConstraint("status <> 'DELETED' OR deletion_stuck_at IS NULL", name="ck_summary_deleted_stuck"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    # --- профиль (снимок identity-consent; версия identity_version = users.updated_at источника)
    username: Mapped[str | None] = mapped_column(String(64))
    display_name: Mapped[str | None] = mapped_column(String(160))
    telegram_id_masked: Mapped[str] = mapped_column(String(16), nullable=False, server_default=MASK_NONE)
    locale: Mapped[str | None] = mapped_column(String(8))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    # false — строка создана событием другого домена раньше, чем пришёл профиль: created_at предварительный
    profile_known: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    last_seen_at: Mapped[datetime | None] = mapped_column(TS)
    identity_version: Mapped[datetime | None] = mapped_column(TS)
    # --- статус
    status: Mapped[str] = mapped_column(String(24), nullable=False, server_default="ACTIVE")
    status_at: Mapped[datetime | None] = mapped_column(TS)
    # --- согласие
    consent_policy_version: Mapped[str | None] = mapped_column(String(20))
    consent_purposes: Mapped[list[str]] = mapped_column(
        ARRAY(String(32)), nullable=False, server_default=text("'{}'::varchar[]")
    )
    consent_accepted_at: Mapped[datetime | None] = mapped_column(TS)
    consent_revoked_at: Mapped[datetime | None] = mapped_column(TS)
    age_confirmed_18_plus: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    consent_at: Mapped[datetime | None] = mapped_column(TS)
    # --- безопасность (поля меняются разными событиями — у каждого своя версия)
    pin_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    pin_at: Mapped[datetime | None] = mapped_column(TS)
    biometric_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    biometric_at: Mapped[datetime | None] = mapped_column(TS)
    # --- предпочтения (preferences)
    onboarding_completed: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    onboarding_at: Mapped[datetime | None] = mapped_column(TS)
    preferences_updated_at: Mapped[datetime | None] = mapped_column(TS)
    preferences_changed_fields: Mapped[list[str]] = mapped_column(
        ARRAY(String(64)), nullable=False, server_default=text("'{}'::varchar[]")
    )
    # --- обращения (support): пересчитываются из ticket_refs
    open_tickets: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    tickets_total: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    # --- уровень доступа к AI (ai-control; спринт 7). NULL — событий не было: уровень по умолчанию
    access_level: Mapped[str | None] = mapped_column(String(32))
    access_level_source: Mapped[str | None] = mapped_column(String(16))  # default | manual
    access_level_expires_at: Mapped[datetime | None] = mapped_column(TS)
    access_level_version: Mapped[int | None] = mapped_column(Integer)  # версия назначения в ai-control
    # --- сага удаления (спринт 9): момент «зависло» по user.deletion.stuck.v1; при DELETED стирается
    deletion_stuck_at: Mapped[datetime | None] = mapped_column(TS)
    # --- служебное
    refreshed_at: Mapped[datetime | None] = mapped_column(TS)  # последнее чтение из identity-consent
    erased_at: Mapped[datetime | None] = mapped_column(TS)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now(), onupdate=func.now())


class TicketRef(Base):
    """Проекция номеров обращений (support.ticket.*): поиск по TCK-номеру и счётчики open/total без вызова support."""

    __tablename__ = "ticket_refs"
    __table_args__ = (
        UniqueConstraint("number", name="uq_ticket_refs_number"),
        CheckConstraint(
            "status IN ('NEW','IN_PROGRESS','WAITING_CUSTOMER','RESOLVED','CLOSED')", name="ck_ticket_refs_status"
        ),
        CheckConstraint("NOT anonymized OR user_id IS NULL", name="ck_ticket_refs_anonymized"),
        Index("ix_ticket_refs_user", "user_id"),
    )

    ticket_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    number: Mapped[int] = mapped_column(BigInteger, nullable=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    status_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    # Обращение обезличено (удаление пользователя): связь с пользователем больше не восстанавливается
    anonymized: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))


class SyncState(Base):
    """Состояние курсорной сверки с identity-consent (водяной знак updated_at и последний исход)."""

    __tablename__ = "sync_state"

    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    watermark: Mapped[datetime | None] = mapped_column(TS)
    last_run_at: Mapped[datetime | None] = mapped_column(TS)
    last_success_at: Mapped[datetime | None] = mapped_column(TS)
    last_error_at: Mapped[datetime | None] = mapped_column(TS)
    last_error: Mapped[str | None] = mapped_column(String(64))  # только тип ошибки, без текста (PII)
    synced_total: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
