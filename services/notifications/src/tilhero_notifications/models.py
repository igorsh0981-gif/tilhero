"""Модели notifications — зеркало миграций 0001–0003 (сверка — tests/test_notifications_schema.py).

`notifications` — журнал доставки и одновременно центр уведомлений в приложении (INTERNAL_API §4): каждая запись
хранит категорию, отрисованные title/body на языке ученика, startapp, telegram_status и read_at; срок — 90 дней.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

CATEGORIES = ("reminders", "missed", "social", "support", "product", "service")
# cancelled (спринт 2) — запись рассылки, остановленной до отправки: не отправляется и не видна в центре
TELEGRAM_STATUSES = ("scheduled", "sent", "in_app_only", "failed", "skipped", "cancelled")
KINDS = ("standard", "transactional", "campaign")
TEMPLATE_VERSION_STATUSES = ("draft", "active", "archived")
CAMPAIGN_STATUSES = ("draft", "scheduled", "sending", "done", "stopped")
RECIPIENT_STATUSES = ("pending", "created", "skipped_frequency", "cancelled")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ",".join(f"'{v}'" for v in values) + ")"


class Base(DeclarativeBase):
    pass


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        UniqueConstraint("dedup_key", name="uq_notifications_dedup_key"),
        CheckConstraint(_in("category", CATEGORIES), name="ck_notifications_category"),
        CheckConstraint(_in("kind", KINDS), name="ck_notifications_kind"),
        CheckConstraint(_in("telegram_status", TELEGRAM_STATUSES), name="ck_notifications_telegram_status"),
        CheckConstraint("attempts >= 0", name="ck_notifications_attempts"),
        # Параметры (в т.ч. код сброса PIN) не хранятся после конечного статуса
        CheckConstraint("telegram_status = 'scheduled' OR params IS NULL", name="ck_notifications_params_cleared"),
        CheckConstraint(
            "telegram_status <> 'scheduled' OR scheduled_for IS NOT NULL", name="ck_notifications_scheduled_for"
        ),
        # Центр: новые первыми (keyset по created_at, notification_id)
        Index("ix_notifications_inbox", "user_id", "created_at", "notification_id"),
        Index("ix_notifications_due", "scheduled_for", postgresql_where=text("telegram_status = 'scheduled'")),
        Index("ix_notifications_limit", "user_id", "limit_day", postgresql_where=text("limit_day IS NOT NULL")),
        Index(
            "ix_notifications_subject", "subject_user_id", postgresql_where=text("subject_user_id IS NOT NULL")
        ),
        Index("ix_notifications_created", "created_at"),
        # Сводка рассылок (доставлено за период)
        Index("ix_notifications_campaign_sent", "sent_at", postgresql_where=text("kind = 'campaign'")),
    )

    notification_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    # Ученик — владелец записи центра (для детского профиля — ребёнок; адресат Telegram — опекун)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    category: Mapped[str] = mapped_column(String(16), nullable=False)
    # transactional — сразу, мимо настроек (код сброса PIN); standard — по политике; campaign — рассылка (спринт 2,
    # категория product, тексты — campaigns, params {campaign_id})
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    template: Mapped[str] = mapped_column(String(64), nullable=False)
    params: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    # Другой пользователь, чьё имя попадает в текст (пригласивший/принявший/новый участник семьи): при его удалении
    # запись удаляется (имя не переживает удаление владельца имени)
    subject_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # Отрисованные для центра тексты на языке ученика; NULL — ещё не отрисовано или шаблон не для центра
    title: Mapped[str | None] = mapped_column(String(200))
    body: Mapped[str | None] = mapped_column(String(1000))
    startapp: Mapped[str | None] = mapped_column(String(64))
    dedup_key: Mapped[str] = mapped_column(String(200), nullable=False)
    # scheduled — ждёт отправки (сейчас или позже, в т.ч. повтор); sent; in_app_only — только центр;
    # failed — доставка не удалась; skipped — не показывается нигде (категория выключена, пользователь неактивен)
    telegram_status: Mapped[str] = mapped_column(String(16), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(64))  # код причины (без текста ошибок)
    center_only: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    not_before: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # пропуск: слот следующего дня
    stale_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # позже — только центр
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # следующая обработка
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    limit_day: Mapped[date | None] = mapped_column(Date)  # местные сутки, в лимит которых засчитано сообщение
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    telegram_message_id: Mapped[int | None] = mapped_column(BigInteger)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source_event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class DeletedUser(Base):
    """Отметка исполненного удаления (TG-FR-006): запоздавшие события для удалённого ученика не создают записей.
    Только псевдонимный user_id и request_id саги."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class MissedState(Base):
    """Последний принятый к отправке «пропуск» ученика (местная дата слота): consecutive_missed ≥ 4 —
    lesson.comeback не чаще раза в COMEBACK_MIN_DAYS дней."""

    __tablename__ = "missed_state"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    last_notified_date: Mapped[date] = mapped_column(Date, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class FamilyOwner(Base):
    """Проекция social: семья → владелец (из social.family.member_added.v1 с role=owner). Нужна, чтобы адресовать
    family.joined владельцу: в payload события владельца нет."""

    __tablename__ = "family_owners"
    __table_args__ = (Index("ix_family_owners_owner", "owner_user_id"),)

    family_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Broadcast(Base):
    """Опубликованные заметки «Что нового» (experience.release_note.published.v1) — только центр уведомлений.
    Адресатов в событии нет: запись центра создаётся ученику при его чтении центра (inbox), если категория
    product включена и сегмент совпадает. Без PII."""

    __tablename__ = "broadcasts"
    __table_args__ = (
        CheckConstraint("audience IN ('new','existing','all')", name="ck_broadcasts_audience"),
        Index("ix_broadcasts_received", "received_at"),
    )

    broadcast_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)  # release_note_id
    slug: Mapped[str] = mapped_column(String(200), nullable=False)
    audience: Mapped[str] = mapped_column(String(16), nullable=False)
    segments: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class InboxState(Base):
    """Водяной знак рассылок центра на ученика: заметки, полученные позже broadcasts_seen_at, ещё не разобраны.
    Создаётся при первом чтении центра (без заметок, опубликованных раньше — их показывает «Что нового»)."""

    __tablename__ = "inbox_state"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    broadcasts_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


# ---------------------------------------------------------------- спринт 2: версии шаблонов, рассылки (миграция 0002)


class TemplateVersion(Base):
    """Версия текстов шаблона (INTERNAL_API спринта 2 §3): код — тексты по умолчанию, версия сотрудника — поверх.
    Одна активная версия на ключ (частичный уникальный индекс). Тексты — {ru|uz: {title, body, button|null}}."""

    __tablename__ = "notification_template_versions"
    __table_args__ = (
        CheckConstraint(_in("status", TEMPLATE_VERSION_STATUSES), name="ck_template_versions_status"),
        CheckConstraint("version >= 1", name="ck_template_versions_version"),
        Index("uq_template_versions_active", "key", unique=True, postgresql_where=text("status = 'active'")),
        # Idempotency-Key создания версии — на сотрудника
        Index(
            "uq_template_versions_idempotency",
            "created_by",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
    )

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    texts: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    note: Mapped[str] = mapped_column(String(300), nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    activated_by: Mapped[str | None] = mapped_column(String(64))
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    request_hash: Mapped[str | None] = mapped_column(String(64))


class Campaign(Base):
    """Рассылка (admin.ts «Рассылки»): категория product, тексты RU/UZ (плейсхолдер — только {learner_name}),
    сегмент аудитории identity-consent. `version` — оптимистическая блокировка черновика; `cursor` — курсор
    выборки аудитории (повтор dispatch безопасен); `audience_count` — оценка аудитории на момент запуска."""

    __tablename__ = "campaigns"
    __table_args__ = (
        CheckConstraint(_in("status", CAMPAIGN_STATUSES), name="ck_campaigns_status"),
        CheckConstraint("version >= 1", name="ck_campaigns_version"),
        CheckConstraint("error_attempts >= 0", name="ck_campaigns_error_attempts"),
        Index("ix_campaigns_created", "created_at", "campaign_id"),
        Index("ix_campaigns_status_send_at", "status", "send_at"),
        Index(
            "uq_campaigns_idempotency",
            "created_by",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
    )

    campaign_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    texts: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    route: Mapped[str | None] = mapped_column(String(32))
    segment: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    send_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    audience_count: Mapped[int | None] = mapped_column(Integer)
    cursor: Mapped[str | None] = mapped_column(String(512))
    audience_complete: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    scheduled_by: Mapped[str | None] = mapped_column(String(64))
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    stopped_by: Mapped[str | None] = mapped_column(String(64))
    stopped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    stop_reason: Mapped[str | None] = mapped_column(String(300))
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    request_hash: Mapped[str | None] = mapped_column(String(64))
    # Ревью P2-7 (миграция 0003): серия неудач шага отправки (запуск, выборка аудитории) — код последней ошибки,
    # начало серии, число неудач подряд; error_reported — аудит campaign.failed для серии уже записан
    error_code: Mapped[str | None] = mapped_column(String(64))
    error_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    error_reported: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))


class CampaignRecipient(Base):
    """Получатель рассылки: pending (выбран из аудитории) → created (создана запись уведомления) |
    skipped_frequency (лимит частоты) | cancelled (остановка, ученик удалён). Лимит частоты — по `created` за
    CAMPAIGN_MIN_INTERVAL_DAYS (`processed_at`), чья запись журнала дошла до ученика или ещё в пути (ревью P2-8)."""

    __tablename__ = "campaign_recipients"
    __table_args__ = (
        CheckConstraint(_in("status", RECIPIENT_STATUSES), name="ck_campaign_recipients_status"),
        Index(
            "ix_campaign_recipients_pending",
            "campaign_id",
            "user_id",
            postgresql_where=text("status = 'pending'"),
        ),
        Index(
            "ix_campaign_recipients_user_created",
            "user_id",
            "processed_at",
            postgresql_where=text("status = 'created'"),
        ),
        Index("ix_campaign_recipients_user", "user_id"),
    )

    campaign_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("campaigns.campaign_id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    notification_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
