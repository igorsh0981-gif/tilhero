"""Модели identity-consent. Таблицы без схемы — попадают в схему сервиса через search_path.

PII (Telegram ID, username, имя) хранит только этот сервис; после завершения удаления строка users
обезличивается,
consents остаются как юридическое доказательство (без PII), секреты (PIN, биометрия) удаляются физически.
"""

from __future__ import annotations

import uuid
from datetime import datetime, time

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    SmallInteger,
    String,
    Text,
    Time,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from tilhero_identity.base import USER_FK, Base

USER_STATUSES = ("ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED")
TS = DateTime(timezone=True)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("locale IN ('ru','en')", name="ck_users_locale"),
        CheckConstraint(
            "status IN ('ACTIVE','DISABLED','DELETION_REQUESTED','DELETED')", name="ck_users_status"
        ),
        CheckConstraint(
            "(quiet_hours_start IS NULL) = (quiet_hours_end IS NULL)", name="ck_users_quiet_hours_pair"
        ),
        # Инвариант обезличивания: у удалённого пользователя не остаётся Telegram-идентичности.
        CheckConstraint(
            "status <> 'DELETED' OR (telegram_user_id IS NULL AND username IS NULL AND display_name IS NULL)",
            name="ck_users_deleted_anonymized",
        ),
        # Курсорная сверка user-admin: GET /admin/v1/users?updated_after= (миграция 0002)
        Index("ix_users_updated_at", "updated_at", "user_id"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    telegram_user_id: Mapped[int | None] = mapped_column(BigInteger, unique=True)
    username: Mapped[str | None] = mapped_column(String(64))
    display_name: Mapped[str | None] = mapped_column(String(160))
    locale: Mapped[str] = mapped_column(String(2), nullable=False, server_default="ru")
    status: Mapped[str] = mapped_column(String(24), nullable=False, server_default="ACTIVE")
    age_confirmed_18_plus: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    age_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notifications_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    quiet_hours_start: Mapped[time | None] = mapped_column(Time)
    quiet_hours_end: Mapped[time | None] = mapped_column(Time)
    digest_time: Mapped[time] = mapped_column(Time, nullable=False, server_default=text("'09:00'"))
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, server_default="Asia/Tashkent")
    bot_blocked: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        TS, nullable=False, server_default=func.now(), onupdate=func.now()
    )


class Consent(Base):
    """История согласий. Строки неизменяемы (триггер), кроме однократной фиксации отзыва."""

    __tablename__ = "consents"
    __table_args__ = (
        CheckConstraint("revoke_reason IS NULL OR revoke_reason IN ('user','superseded','deletion')",
                        name="ck_consents_revoke_reason"),
        CheckConstraint("(revoked_at IS NULL) = (revoke_reason IS NULL)", name="ck_consents_revoke_pair"),
        Index("ix_consents_user_accepted", "user_id", "accepted_at"),
        # Не больше одного действующего согласия на пользователя.
        Index("uq_consents_active", "user_id", unique=True, postgresql_where=text("revoked_at IS NULL")),
    )

    consent_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey(USER_FK), nullable=False)
    policy_version: Mapped[str] = mapped_column(String(20), nullable=False)
    purposes: Mapped[list[str]] = mapped_column(ARRAY(String(32)), nullable=False)
    accepted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoke_reason: Mapped[str | None] = mapped_column(String(16))
    channel: Mapped[str] = mapped_column(String(16), nullable=False, server_default="telegram")
    locale: Mapped[str] = mapped_column(String(2), nullable=False)
    age_confirmed_18_plus: Mapped[bool] = mapped_column(Boolean, nullable=False)
    policy_text_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    evidence_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)


class PinCredential(Base):
    __tablename__ = "pin_credentials"
    __table_args__ = (CheckConstraint("pin_length IN (4, 6)", name="ck_pin_length"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="CASCADE"), primary_key=True
    )
    pin_hash: Mapped[str] = mapped_column(Text, nullable=False)  # Argon2id (PHC-строка с солью и параметрами)
    pin_length: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class BiometricCredential(Base):
    __tablename__ = "biometric_credentials"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="CASCADE"), primary_key=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)  # sha256(biometric_token)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


# Сага удаления (ADR-009): таблицы deletion_* живут в модуле deletion/ — импорт регистрирует их в Base.metadata
# (Alembic env и сверка моделей с миграциями видят все таблицы сервиса).
from tilhero_identity.deletion.models import (  # noqa: E402
    DeletionAttempt,
    DeletionDomainAck,
    DeletionIdempotencyKey,
    DeletionRequest,
)

__all__ = [
    "USER_FK", "USER_STATUSES", "Base", "BiometricCredential", "Consent", "DeletionAttempt", "DeletionDomainAck",
    "DeletionIdempotencyKey", "DeletionRequest", "PinCredential", "User",
]
