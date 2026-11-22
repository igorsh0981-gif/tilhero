"""Read-модель учеников для админки (схема user_admin). Таблицы без схемы — search_path сервиса.

Данными не владеет: authoritative-источники — identity-consent (профиль, вид ученика и опекун, возраст, статус,
согласие, безопасность, настройки уведомлений), learning-plan (цель, уровень, график, онбординг, занятия) и support
(обращения). PII — копия username и имени (поиск по части имени — `search_text`, только имя; username — только точное
`@username`); полного Telegram ID нет: только маска «••••••789» (CHECK формата). После удаления ученика
(user.domain.deleted.v1 от identity-consent) имя, username, маска, связь с опекуном, план и настройки стираются, связь
с обращениями разрывается.

Порядок событий не гарантирован: у каждой группы полей своя «версия» (момент события или `updated_at` снимка, *_at),
более старое событие не перезаписывает более новое состояние. Модели — зеркало миграций (tests: schema_drift).
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

KINDS = ("account", "child")
STATUSES = ("ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED")
AGE_BANDS = ("6-9", "10-13", "14-17", "18+")
GUARDIAN_CONSENTS = ("not_required", "pending", "granted", "declined")
LOCALES = ("ru", "uz")
GOALS = ("work", "career", "travel", "daily", "study", "exam")
LEVELS = ("zero", "beginner", "some", "confident")
PRESETS = ("daily", "weekdays", "three_per_week", "custom")
# категории настроек ученика (admin.ts NotificationCategory без service; спринт 7: + game, миграция 0003)
CATEGORIES = ("reminders", "missed", "social", "support", "product", "game")
TICKET_STATUSES = ("NEW", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED")
OPEN_TICKET_STATUSES = ("NEW", "IN_PROGRESS", "WAITING_CUSTOMER")
MASK = "•"
MASK_RE_SQL = "^•{6}[0-9]{3}$"
TS = DateTime(timezone=True)

EMPTY_CONSENT: dict[str, Any] = {"policy_version": None, "purposes": [], "accepted_at": None, "revoked_at": None,
                                 "basis": None}
EMPTY_SECURITY: dict[str, Any] = {"pin_enabled": False, "pin_reset_pending": False}
CONSENT_DEFAULT_SQL = ("'{\"policy_version\": null, \"purposes\": [], \"accepted_at\": null, \"revoked_at\": null, "
                       "\"basis\": null}'::jsonb")
SECURITY_DEFAULT_SQL = "'{\"pin_enabled\": false, \"pin_reset_pending\": false}'::jsonb"


def _in(values: tuple[str, ...]) -> str:
    return "(" + ",".join(f"'{v}'" for v in values) + ")"


class Base(DeclarativeBase):
    pass


class LearnerSummary(Base):
    """Строка на ученика (аккаунт Telegram или детский профиль) — поля AdminLearnerRow + служебные."""

    __tablename__ = "admin_learner_summary"
    __table_args__ = (
        CheckConstraint(f"kind IN {_in(KINDS)}", name="ck_learner_kind"),
        CheckConstraint(f"status IN {_in(STATUSES)}", name="ck_learner_status"),
        CheckConstraint(f"locale IS NULL OR locale IN {_in(LOCALES)}", name="ck_learner_locale"),
        CheckConstraint(f"age_band IS NULL OR age_band IN {_in(AGE_BANDS)}", name="ck_learner_age_band"),
        CheckConstraint(f"guardian_consent IN {_in(GUARDIAN_CONSENTS)}", name="ck_learner_guardian_consent"),
        CheckConstraint(f"goal IS NULL OR goal IN {_in(GOALS)}", name="ck_learner_goal"),
        CheckConstraint("open_tickets >= 0 AND tickets_total >= open_tickets", name="ck_learner_tickets"),
        # полного Telegram ID в схеме нет: только маска «••••••789»
        CheckConstraint(f"telegram_id_masked IS NULL OR telegram_id_masked ~ '{MASK_RE_SQL}'", name="ck_learner_mask"),
        # детский профиль 6–13 без своего Telegram; опекун — только у детского профиля и не он сам
        CheckConstraint("kind <> 'child' OR (telegram_id_masked IS NULL AND username IS NULL)",
                        name="ck_learner_child_no_telegram"),
        CheckConstraint("kind = 'child' OR guardian_user_id IS NULL", name="ck_learner_guardian_child_only"),
        CheckConstraint("guardian_user_id IS NULL OR guardian_user_id <> user_id", name="ck_learner_guardian_not_self"),
        # инвариант удаления: у удалённого ученика нет имени, username, маски, связи с опекуном и плана
        CheckConstraint(
            "status <> 'DELETED' OR (username IS NULL AND display_name IS NULL AND telegram_id_masked IS NULL "
            "AND search_text IS NULL AND guardian_user_id IS NULL AND plan IS NULL AND notifications IS NULL)",
            name="ck_learner_deleted_erased",
        ),
        Index("ix_learner_created", "created_at", "user_id"),
        Index("ix_learner_status", "status"),
        Index("ix_learner_guardian", "guardian_user_id", postgresql_where=text("guardian_user_id IS NOT NULL")),
        Index("ix_learner_activity", "last_activity_at"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    # --- профиль identity-consent (имя, username, маска, вид, опекун — только из снимка: версия source_updated_at)
    kind: Mapped[str] = mapped_column(String(8), nullable=False, server_default="account")
    guardian_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    display_name: Mapped[str | None] = mapped_column(String(160))
    username: Mapped[str | None] = mapped_column(String(64))
    telegram_id_masked: Mapped[str | None] = mapped_column(String(16))
    # lower(отображаемое имя) — ILIKE-поиск по части имени; username сюда не входит (ревью T2-3, миграция 0002 — P2-9)
    search_text: Mapped[str | None] = mapped_column(Text)
    source_updated_at: Mapped[datetime | None] = mapped_column(TS)  # users.updated_at последнего снимка
    # язык, возраст, согласие родителя: события user.profile.* и снимки (версия profile_at)
    locale: Mapped[str | None] = mapped_column(String(2))
    age_band: Mapped[str | None] = mapped_column(String(5))
    guardian_consent: Mapped[str] = mapped_column(String(16), nullable=False, server_default="not_required")
    profile_at: Mapped[datetime | None] = mapped_column(TS)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    # false — строка создана событием другого домена раньше, чем пришёл профиль: created_at предварительный,
    # в список и статистику строка не входит
    profile_known: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    # --- статус
    status: Mapped[str] = mapped_column(String(24), nullable=False, server_default="ACTIVE")
    status_at: Mapped[datetime | None] = mapped_column(TS)
    # --- согласие {policy_version, purposes, accepted_at, revoked_at, basis}
    consent: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=text(CONSENT_DEFAULT_SQL))
    consent_at: Mapped[datetime | None] = mapped_column(TS)
    # --- безопасность {pin_enabled, pin_reset_pending}: поля меняются разными событиями — у каждого своя версия
    security: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=text(SECURITY_DEFAULT_SQL))
    pin_at: Mapped[datetime | None] = mapped_column(TS)
    pin_reset_at: Mapped[datetime | None] = mapped_column(TS)
    # --- настройки уведомлений {enabled, categories{reminders, missed, social, support, product, game}}; NULL —
    # не известны
    # (none_as_null: None → SQL NULL, а не JSON null — CHECK ck_learner_deleted_erased)
    notifications: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    notifications_at: Mapped[datetime | None] = mapped_column(TS)
    # --- план learning-plan (AdminLearnerPlan) и производные поля строки; NULL — плана нет
    plan: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    plan_at: Mapped[datetime | None] = mapped_column(TS)
    goal: Mapped[str | None] = mapped_column(String(16))
    reminders_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    onboarding_completed: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    last_activity_at: Mapped[datetime | None] = mapped_column(TS)  # learning.activity.recorded.v1 (максимум)
    # --- обращения (support): пересчитываются из ticket_refs
    open_tickets: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    tickets_total: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    # --- служебное
    refreshed_at: Mapped[datetime | None] = mapped_column(TS)  # последнее чтение из identity-consent
    erased_at: Mapped[datetime | None] = mapped_column(TS)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now(), onupdate=func.now())


class TicketRef(Base):
    """Проекция номеров обращений (support.ticket.*): поиск по TCK-номеру и счётчики open/total без вызова support."""

    __tablename__ = "ticket_refs"
    __table_args__ = (
        UniqueConstraint("number", name="uq_ticket_refs_number"),
        CheckConstraint(f"status IN {_in(TICKET_STATUSES)}", name="ck_ticket_refs_status"),
        CheckConstraint("NOT anonymized OR user_id IS NULL", name="ck_ticket_refs_anonymized"),
        Index("ix_ticket_refs_user", "user_id"),
    )

    ticket_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    number: Mapped[int] = mapped_column(BigInteger, nullable=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    status_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    # Обращение обезличено (удаление ученика): связь с учеником больше не восстанавливается
    anonymized: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))


class ReconcileState(Base):
    """Сверка с источником (`identity` — identity-consent, `plans` — learning-plan): водяной знак `updated_after`
    (max updated_at применённых страниц) и последний исход."""

    __tablename__ = "reconcile_state"

    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    watermark: Mapped[datetime | None] = mapped_column(TS)
    last_run_at: Mapped[datetime | None] = mapped_column(TS)
    last_success_at: Mapped[datetime | None] = mapped_column(TS)
    last_error_at: Mapped[datetime | None] = mapped_column(TS)
    last_error: Mapped[str | None] = mapped_column(String(64))  # только тип ошибки, без текста (PII)
    synced_total: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
