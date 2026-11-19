"""Модели catalog — зеркало миграций (tests/test_catalog_schema.py сверяет schema_drift).

Версии контента (`content_versions`) — тело сущности (JSONB по схеме вида из content.ts) и статус жизненного цикла
draft → in_review → approved → published → archived (+ suspended у медиа). Опубликованные, приостановленные и
архивные версии неизменяемы: триггер `content_versions_guard` (миграция 0001) запрещает менять тело и сведения о
проверке, допускает только переходы статуса published → archived | suspended, archived → published (откат),
approved → archived (вытеснена более новой публикацией). Роль сервиса не может снять триггер (DDL — у владельца).
"""

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
    Identity,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TS = DateTime(timezone=True)

KINDS_SQL = ("'course', 'skill', 'module', 'lesson', 'rubric', 'scenario', 'media_asset', 'media_exercise'")
KEY_SQL = "'^[a-z0-9][a-z0-9._-]{1,63}$'"


class Base(DeclarativeBase):
    pass


class LanguageRow(Base):
    """Справочник языков (Language, ADM-LANG-01): новый язык — запись, без изменения кода."""

    __tablename__ = "languages"
    __table_args__ = (
        CheckConstraint("code ~ '^[a-z]{2,3}(-[A-Z]{2})?$'", name="ck_languages_code"),
        CheckConstraint("script IN ('Latn', 'Cyrl')", name="ck_languages_script"),
        CheckConstraint("status IN ('active', 'planned')", name="ck_languages_status"),
    )

    code: Mapped[str] = mapped_column(String(16), primary_key=True)
    name: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    script: Mapped[str] = mapped_column(String(4), nullable=False)
    variants: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    asr: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    tts: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    limitations: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    updated_by: Mapped[str] = mapped_column(String(64), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class LanguagePairRow(Base):
    """Языковая пара (LanguagePair, ADM-LANG-02): planned → development → review → pilot → published → archived."""

    __tablename__ = "language_pairs"
    __table_args__ = (
        CheckConstraint("pair_id ~ '^[a-z]{2,3}-[a-z]{2,3}$'", name="ck_language_pairs_id"),
        CheckConstraint("status IN ('planned', 'development', 'review', 'pilot', 'published', 'archived')",
                        name="ck_language_pairs_status"),
        CheckConstraint("source <> target", name="ck_language_pairs_distinct"),
    )

    pair_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    source: Mapped[str] = mapped_column(String(16), ForeignKey("languages.code", name="fk_language_pairs_source"),
                                        nullable=False)
    target: Mapped[str] = mapped_column(String(16), ForeignKey("languages.code", name="fk_language_pairs_target"),
                                        nullable=False)
    explanation_locales: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    ui_locales: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    title: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    release_at: Mapped[str | None] = mapped_column(String(40))
    course_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    updated_by: Mapped[str] = mapped_column(String(64), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class ContentVersion(Base):
    """Версия сущности контента. Уникальность (kind, key, version); не больше одной published и одного открытого
    черновика (draft | in_review) на (kind, key) — частичные уникальные индексы."""

    __tablename__ = "content_versions"
    __table_args__ = (
        UniqueConstraint("kind", "key", "version", name="uq_content_versions_kind_key_version"),
        CheckConstraint(f"kind IN ({KINDS_SQL})", name="ck_content_versions_kind"),
        CheckConstraint(f"key ~ {KEY_SQL}", name="ck_content_versions_key"),
        CheckConstraint("version >= 1", name="ck_content_versions_version"),
        CheckConstraint("status IN ('draft', 'in_review', 'approved', 'published', 'suspended', 'archived')",
                        name="ck_content_versions_status"),
        CheckConstraint("payload_hash ~ '^[0-9a-f]{64}$'", name="ck_content_versions_hash"),
        CheckConstraint("jsonb_typeof(payload) = 'object'", name="ck_content_versions_payload"),
        CheckConstraint("jsonb_typeof(locale_checks) = 'object'", name="ck_content_versions_locale_checks"),
        CheckConstraint("jsonb_typeof(editors) = 'array'", name="ck_content_versions_editors"),
        CheckConstraint("status <> 'suspended' OR kind = 'media_asset'", name="ck_content_versions_suspended_kind"),
        CheckConstraint("rights_approved_at IS NULL OR kind = 'media_asset'", name="ck_content_versions_rights_kind"),
        CheckConstraint("suspend_reason IS NULL OR suspend_reason IN ('rights_expired', 'rights_revoked')",
                        name="ck_content_versions_suspend_reason"),
        CheckConstraint("status <> 'published' OR published_at IS NOT NULL", name="ck_content_versions_published"),
        Index("uq_content_versions_published", "kind", "key", unique=True,
              postgresql_where=text("status = 'published'")),
        Index("uq_content_versions_open", "kind", "key", unique=True,
              postgresql_where=text("status IN ('draft', 'in_review')")),
        Index("ix_content_versions_status", "status", "kind"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), unique=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    key: Mapped[str] = mapped_column(String(64), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    author_id: Mapped[str] = mapped_column(String(64), nullable=False)
    # все, кто правил версию (автор — первый): никто из них не проверяет её (SELF_REVIEW, four-eyes)
    editors: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    updated_by: Mapped[str] = mapped_column(String(64), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    submitted_at: Mapped[datetime | None] = mapped_column(TS)
    reviewer_id: Mapped[str | None] = mapped_column(String(64))
    reviewed_at: Mapped[datetime | None] = mapped_column(TS)
    review_note: Mapped[str | None] = mapped_column(Text)
    locale_checks: Mapped[dict[str, str]] = mapped_column(JSONB, nullable=False)
    rights_approved_by: Mapped[str | None] = mapped_column(String(64))
    rights_approved_at: Mapped[datetime | None] = mapped_column(TS)
    rights_note: Mapped[str | None] = mapped_column(Text)
    published_by: Mapped[str | None] = mapped_column(String(64))
    published_at: Mapped[datetime | None] = mapped_column(TS)
    archived_at: Mapped[datetime | None] = mapped_column(TS)
    suspended_at: Mapped[datetime | None] = mapped_column(TS)
    suspend_reason: Mapped[str | None] = mapped_column(String(32))


class ContentPointer(Base):
    """«Что видит ученик»: опубликованная версия ключа (null — снят с публикации или приостановлен) и прежняя."""

    __tablename__ = "content_pointers"
    __table_args__ = (
        CheckConstraint(f"kind IN ({KINDS_SQL})", name="ck_content_pointers_kind"),
    )

    kind: Mapped[str] = mapped_column(String(16), primary_key=True)
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    published_version: Mapped[int | None] = mapped_column(Integer)
    previous_version: Mapped[int | None] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class ScenarioTestRunRow(Base):
    """Тестовый прогон сценария (AT-28) — на версию и хеш тела: после правки черновика прогон устаревает."""

    __tablename__ = "scenario_test_runs"
    __table_args__ = (
        CheckConstraint("payload_hash ~ '^[0-9a-f]{64}$'", name="ck_scenario_test_runs_hash"),
        Index("ix_scenario_test_runs_version", "key", "version", "seq"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), unique=True)
    key: Mapped[str] = mapped_column(String(64), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    ok: Mapped[bool] = mapped_column(Boolean, nullable=False)
    result: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    run_by: Mapped[str] = mapped_column(String(64), nullable=False)
    checked_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class MediaBlob(Base):
    """Аудио авторских сценок (≤ 3 МБ, mp3/ogg/m4a). Перенос в объектное хранилище — спринт 4."""

    __tablename__ = "media_blobs"
    __table_args__ = (
        CheckConstraint("content_type IN ('audio/mpeg', 'audio/ogg', 'audio/mp4')", name="ck_media_blobs_type"),
        CheckConstraint("size > 0 AND size <= 3145728 AND size = octet_length(bytes)", name="ck_media_blobs_size"),
        CheckConstraint("sha256 ~ '^[0-9a-f]{64}$'", name="ck_media_blobs_sha256"),
        Index("ix_media_blobs_sha256", "sha256"),
    )

    blob_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    content_type: Mapped[str] = mapped_column(String(16), nullable=False)
    bytes: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    uploaded_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class MediaRequest(Base):
    """Заявка ученика на песню или фильм (APP-MEDIA-04, ADM-MEDIA-04). Ссылка ученика сервером НЕ открывается.
    Удаление ученика — обезличивание: user_id, link, comment → NULL (сага удаления)."""

    __tablename__ = "media_requests"
    __table_args__ = (
        CheckConstraint("kind IN ('song', 'movie', 'series', 'other')", name="ck_media_requests_kind"),
        CheckConstraint("status IN ('new', 'in_review', 'authored_alternative', 'licensed', 'rejected', 'duplicate')",
                        name="ck_media_requests_status"),
        CheckConstraint("ui_locale IN ('ru', 'uz')", name="ck_media_requests_ui_locale"),
        CheckConstraint("char_length(title) BETWEEN 2 AND 200", name="ck_media_requests_title"),
        CheckConstraint("link IS NULL OR (char_length(link) <= 500 AND link LIKE 'https://%')",
                        name="ck_media_requests_link"),
        CheckConstraint("comment IS NULL OR char_length(comment) <= 500", name="ck_media_requests_comment"),
        CheckConstraint("decision_note IS NULL OR char_length(decision_note) <= 500",
                        name="ck_media_requests_decision_note"),
        CheckConstraint("(status IN ('new', 'in_review')) = (decided_at IS NULL)", name="ck_media_requests_decided"),
        UniqueConstraint("user_id", "idempotency_key", name="uq_media_requests_idempotency"),
        Index("ix_media_requests_user_created", "user_id", "created_at"),
        Index("ix_media_requests_title_norm", "title_norm"),
        Index("ix_media_requests_status_seq", "status", "seq"),
    )

    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), unique=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    title_norm: Mapped[str] = mapped_column(String(200), nullable=False)
    link: Mapped[str | None] = mapped_column(String(500))
    comment: Mapped[str | None] = mapped_column(String(500))
    ui_locale: Mapped[str] = mapped_column(String(2), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    decision_note: Mapped[str | None] = mapped_column(String(500))
    linked_asset_id: Mapped[str | None] = mapped_column(String(64))
    taken_by: Mapped[str | None] = mapped_column(String(64))
    taken_at: Mapped[datetime | None] = mapped_column(TS)
    decided_by: Mapped[str | None] = mapped_column(String(64))
    decided_at: Mapped[datetime | None] = mapped_column(TS)
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    anonymized_at: Mapped[datetime | None] = mapped_column(TS)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class DeletedUser(Base):
    """Исполненное удаление: после ACK саги новые заявки этого user_id не принимаются (410 USER_DELETED)."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
