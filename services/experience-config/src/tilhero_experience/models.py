from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Identity,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TS = DateTime(timezone=True)


class Base(DeclarativeBase):
    pass


class ConfigVersion(Base):
    """Версия конфигурации (тема + секции + флаги).

    Неизменяема: UPDATE/DELETE запрещены триггером (ТЗ UI/CSS §8).
    """

    __tablename__ = "config_versions"
    __table_args__ = (
        UniqueConstraint("app", "version", name="uq_config_versions_app_version"),
        CheckConstraint("app IN ('miniapp', 'admin')", name="ck_config_versions_app"),
        CheckConstraint("version ~ '^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}$'", name="ck_config_versions_semver"),
        CheckConstraint("checksum ~ '^[0-9a-f]{64}$'", name="ck_config_versions_checksum"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), unique=True)
    app: Mapped[str] = mapped_column(String(16), nullable=False)
    version: Mapped[str] = mapped_column(String(32), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    change_note: Mapped[str] = mapped_column(Text, nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class Activation(Base):
    """Журнал активаций (append-only). Текущая версия = последняя активация приложения (max seq);
    previous = её previous_version. Откат — новая запись kind=rollback, история не меняется."""

    __tablename__ = "activations"
    __table_args__ = (
        ForeignKeyConstraint(["app", "version"], ["config_versions.app", "config_versions.version"],
                             name="fk_activations_version"),
        CheckConstraint("kind IN ('activate', 'rollback')", name="ck_activations_kind"),
        Index("ix_activations_app_seq", "app", text("seq DESC")),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), unique=True)
    app: Mapped[str] = mapped_column(String(16), nullable=False)
    version: Mapped[str] = mapped_column(String(32), nullable=False)
    previous_version: Mapped[str | None] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    activated_by: Mapped[str] = mapped_column(String(64), nullable=False)
    activated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class ReleaseNote(Base):
    """Заметка «Что нового» с текстами RU/UZ, аудиторией (new — знакомство при первой регистрации, existing — новое
    для тех, кто уже занимается, all — всем) и сегментами (возраст, язык интерфейса; пусто — все).

    Правится только черновик (version — оптимистическая блокировка). У опубликованной меняется лишь статус на
    archived — триггер release_notes_guard (миграция 0003) запрещает остальное, DELETE — только черновиков.
    """

    __tablename__ = "release_notes"
    __table_args__ = (
        CheckConstraint("status IN ('draft', 'published', 'archived')", name="ck_release_notes_status"),
        CheckConstraint("audience IN ('new', 'existing', 'all')", name="ck_release_notes_audience"),
        CheckConstraint("slug ~ '^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$'", name="ck_release_notes_slug"),
        CheckConstraint("jsonb_typeof(title) = 'object'", name="ck_release_notes_title"),
        CheckConstraint("jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 6",
                        name="ck_release_notes_items"),
        CheckConstraint("jsonb_typeof(segments) = 'object'", name="ck_release_notes_segments"),
        CheckConstraint("status <> 'published' OR published_at IS NOT NULL", name="ck_release_notes_published"),
        CheckConstraint("status <> 'draft' OR published_at IS NULL", name="ck_release_notes_draft"),
        CheckConstraint("version >= 1", name="ck_release_notes_version"),
        # одна действующая (не архивная) заметка на метку
        Index("uq_release_notes_slug_active", "slug", unique=True, postgresql_where=text("status <> 'archived'")),
        Index("ix_release_notes_status_published", "status", "published_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), unique=True)
    slug: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    items: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False)
    audience: Mapped[str] = mapped_column(String(16), nullable=False)
    segments: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    updated_by: Mapped[str] = mapped_column(String(64), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    published_by: Mapped[str | None] = mapped_column(String(64))
    published_at: Mapped[datetime | None] = mapped_column(TS)
    archived_by: Mapped[str | None] = mapped_column(String(64))
    archived_at: Mapped[datetime | None] = mapped_column(TS)


class ReleaseNoteView(Base):
    """Отметка «ученик видел заметку» (AT-11): хранится на сервере и переживает переустановку Mini App.
    Только псевдонимный user_id ученика; удаляется сагой удаления (user.deletion.requested.v1)."""

    __tablename__ = "release_note_views"
    __table_args__ = (
        Index("ix_release_note_views_note", "release_note_id"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    release_note_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("release_notes.id", ondelete="CASCADE", name="fk_release_note_views_note"),
        primary_key=True,
    )
    seen_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class DeletedUser(Base):
    """Исполненное удаление ученика: после ACK саги отметки просмотра этого user_id больше не принимаются
    (410 USER_DELETED) — иначе повтор запроса «просмотрено» после удаления оставил бы данные навсегда."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
