from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Role(Base):
    __tablename__ = "roles"

    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    name_ru: Mapped[str] = mapped_column(String(80), nullable=False)
    name_en: Mapped[str] = mapped_column(String(80), nullable=False)
    privileged: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class RolePermission(Base):
    __tablename__ = "role_permissions"

    role: Mapped[str] = mapped_column(String(32), ForeignKey("roles.code", ondelete="CASCADE"), primary_key=True)
    permission: Mapped[str] = mapped_column(String(64), primary_key=True)


class Staff(Base):
    """Учётка сотрудника. email хранится нормализованным (lower) — уникальность без citext."""

    __tablename__ = "staff"
    __table_args__ = (
        CheckConstraint("email = lower(email)", name="ck_staff_email_lower"),
        CheckConstraint("auth_provider IN ('local','ad')", name="ck_staff_auth_provider"),
        CheckConstraint("status IN ('ACTIVE','LOCKED','DISABLED')", name="ck_staff_status"),
        Index("ix_staff_role", "role"),
        Index("ix_staff_created_at", "created_at"),
    )

    staff_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    email: Mapped[str] = mapped_column(String(254), nullable=False, unique=True)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    role: Mapped[str] = mapped_column(String(32), ForeignKey("roles.code"), nullable=False)
    auth_provider: Mapped[str] = mapped_column(String(8), nullable=False, server_default="local")
    password_hash: Mapped[str | None] = mapped_column(Text)
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    temp_password_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    must_change_password: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    # nonce(12) || AES-256-GCM(secret, AAD=staff_id); до подтверждения mfa_enabled=false
    mfa_secret_enc: Mapped[bytes | None] = mapped_column(LargeBinary)
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    mfa_last_step: Mapped[int | None] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="ACTIVE")
    session_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class Approval(Base):
    """Four-eyes заявка. target — объект заявки (staff:<id> / role:<code>): не больше одной PENDING на объект."""

    __tablename__ = "approvals"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('staff.role_grant','staff.create_privileged','role.permissions_change',"
            "'staff.privileged_revoke','staff.privileged_reset')", name="ck_approval_kind"
        ),
        CheckConstraint(
            "status IN ('PENDING','APPROVED','REJECTED','EXPIRED','APPLIED')", name="ck_approval_status"
        ),
        CheckConstraint("waived IS NULL OR waived = 'single_super_admin'", name="ck_approval_waived"),
        Index("ix_approvals_status_requested_at", "status", "requested_at"),
        Index("ux_approvals_pending_target", "target", unique=True, postgresql_where=text("status = 'PENDING'")),
    )

    approval_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    target: Mapped[str] = mapped_column(String(80), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    summary: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="PENDING")
    requested_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("staff.staff_id"), nullable=False)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    decided_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("staff.staff_id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_note: Mapped[str | None] = mapped_column(Text)
    waived: Mapped[str | None] = mapped_column(String(32))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
