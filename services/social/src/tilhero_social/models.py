"""Модели social — зеркало миграции 0001 (UNIQUE, индексы, FK и CHECK объявлены и здесь: тест schema_drift).

user_id — аккаунт (sub внутреннего токена для social) или детский профиль (член семьи опекуна). PII не хранится:
имена берутся у identity-consent при выдаче ответа.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TS = DateTime(timezone=True)


class Base(DeclarativeBase):
    pass


class Invite(Base):
    """Приглашение по deep link `startapp=inv_<token>`. Токен не хранится: token_hash = sha256(token),
    token = base64url(HMAC-SHA256(INVITE_TOKEN_KEY, invite_id))[:32] — создатель видит ссылку повторно."""

    __tablename__ = "invites"
    __table_args__ = (
        UniqueConstraint("inviter_user_id", "idempotency_key", name="uq_invites_inviter_idempotency"),
        CheckConstraint("kind IN ('family','friend','referral')", name="ck_invites_kind"),
        CheckConstraint("status IN ('active','accepted','revoked','expired')", name="ck_invites_status"),
        CheckConstraint("max_uses IS NULL OR max_uses >= 1", name="ck_invites_max_uses"),
        CheckConstraint("uses >= 0", name="ck_invites_uses"),
        Index("ix_invites_inviter_created", "inviter_user_id", "created_at"),
        Index("ix_invites_status_expires", "status", "expires_at"),
    )

    invite_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    inviter_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    max_uses: Mapped[int | None] = mapped_column(Integer())
    uses: Mapped[int] = mapped_column(Integer(), nullable=False, server_default="0")
    expires_at: Mapped[datetime | None] = mapped_column(TS)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class InviteRedemption(Base):
    """Получатель открыл приглашение (строка появляется при первом :open) и ответил на него."""

    __tablename__ = "invite_redemptions"
    __table_args__ = (
        Index("ix_redemptions_invitee", "invitee_user_id"),
        Index("ix_redemptions_opened", "opened_at"),
    )

    invite_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("invites.invite_id", ondelete="CASCADE", name="fk_redemptions_invite"),
        primary_key=True)
    invitee_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    opened_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(TS)
    declined_at: Mapped[datetime | None] = mapped_column(TS)
    reminded_at: Mapped[datetime | None] = mapped_column(TS)


class Family(Base):
    __tablename__ = "families"

    family_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class FamilyMember(Base):
    """Пользователь состоит не больше чем в одной семье (user_id UNIQUE)."""

    __tablename__ = "family_members"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_family_members_user"),
        CheckConstraint("role IN ('owner','adult','teen','child')", name="ck_family_members_role"),
    )

    family_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("families.family_id", ondelete="CASCADE", name="fk_family_members_family"),
        primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    role: Mapped[str] = mapped_column(String(8), nullable=False)
    joined_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Friendship(Base):
    """Дружба — упорядоченная пара (user_a < user_b). Спринт 1 — только создание через приглашение."""

    __tablename__ = "friendships"
    __table_args__ = (
        CheckConstraint("user_a < user_b", name="ck_friendships_order"),
        Index("ix_friendships_user_b", "user_b"),
    )

    user_a: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_b: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    invite_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Profile(Base):
    """Проекция из user.profile.created/updated.v1: вид профиля и согласие родителя (14–17) — запасной источник,
    если в ответе identity-consent `/users/{id}/public` нет `guardian_consent`. Возраст и опекуна social не хранит
    (CONVENTIONS §8, ревью P-6): решения по возрасту — по ответу `/public`, опекун ребёнка берётся из события
    user.profile.created.v1 в момент добавления в семью. Без имени и даты рождения."""

    __tablename__ = "profiles"
    __table_args__ = (
        CheckConstraint("kind IS NULL OR kind IN ('account','child')", name="ck_profiles_kind"),
        CheckConstraint("guardian_consent IS NULL OR guardian_consent IN "
                        "('not_required','pending','granted','declined')", name="ck_profiles_guardian_consent"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    kind: Mapped[str | None] = mapped_column(String(8))
    guardian_consent: Mapped[str | None] = mapped_column(String(16))
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class DeletedUser(Base):
    """Отметка исполненного удаления: запоздавшие события профиля не воскрешают данные. Без PII."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
