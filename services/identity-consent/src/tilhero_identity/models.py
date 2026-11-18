"""Модели identity-consent. Таблицы без схемы — попадают в схему сервиса через search_path.

PII (Telegram ID, username, имя аккаунта, имя ребёнка) хранит только этот сервис; после завершения удаления строка
users обезличивается, consents остаются как юридическое доказательство (без PII), секреты (PIN, биометрия)
удаляются физически.

Ученик (learner) = строка users: `kind=account` — аккаунт Telegram (сам ученик 14+ или родитель), `kind=child` —
детский профиль 6–13 на аккаунте родителя (без своего Telegram, связь — guardian_links). У каждого ученика свои
настройки уведомлений (категории, тихие часы, часовой пояс); адресат сообщений ребёнка — опекун.
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
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from tilhero_identity.base import USER_FK, Base

USER_STATUSES = ("ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED")
TS = DateTime(timezone=True)

# SQL-фрагменты CHECK — общие для моделей и миграции 0001 (сверка schema_drift сравнивает имена ограничений)
AGE_BANDS_SQL = "('6-9','10-13','14-17','18+')"
CATEGORIES_SQL = "ARRAY['reminders','missed','social','support','product']::text[]"


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("kind IN ('account','child')", name="ck_users_kind"),
        CheckConstraint("locale IN ('ru','uz')", name="ck_users_locale"),
        CheckConstraint(
            "status IN ('ACTIVE','DISABLED','DELETION_REQUESTED','DELETED')", name="ck_users_status"
        ),
        CheckConstraint(f"age_band IS NULL OR age_band IN {AGE_BANDS_SQL}", name="ck_users_age_band"),
        CheckConstraint(
            "guardian_consent IN ('not_required','pending','granted','declined')", name="ck_users_guardian_consent"
        ),
        # аккаунт Telegram — только 14-17 или 18+ (ребёнок 6–13 — детский профиль у родителя)
        CheckConstraint("kind <> 'account' OR age_band IS NULL OR age_band IN ('14-17','18+')",
                        name="ck_users_account_age"),
        # детский профиль: без своего Telegram, возраст 6–13 (после обезличивания возраст стирается)
        CheckConstraint("kind <> 'child' OR (telegram_user_id IS NULL AND username IS NULL)",
                        name="ck_users_child_no_telegram"),
        CheckConstraint("kind <> 'child' OR status = 'DELETED' OR age_band IN ('6-9','10-13')",
                        name="ck_users_child_age"),
        CheckConstraint(f"notify_categories <@ {CATEGORIES_SQL}", name="ck_users_notify_categories"),
        CheckConstraint(
            "(quiet_hours_start IS NULL) = (quiet_hours_end IS NULL)", name="ck_users_quiet_hours_pair"
        ),
        # Инвариант обезличивания: у удалённого ученика не остаётся Telegram-идентичности и имени.
        CheckConstraint(
            "status <> 'DELETED' OR (telegram_user_id IS NULL AND username IS NULL AND display_name IS NULL)",
            name="ck_users_deleted_anonymized",
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    kind: Mapped[str] = mapped_column(String(8), nullable=False, server_default="account")
    telegram_user_id: Mapped[int | None] = mapped_column(BigInteger, unique=True)
    username: Mapped[str | None] = mapped_column(String(64))
    display_name: Mapped[str | None] = mapped_column(String(160))
    locale: Mapped[str] = mapped_column(String(2), nullable=False, server_default="ru")
    status: Mapped[str] = mapped_column(String(24), nullable=False, server_default="ACTIVE")
    age_band: Mapped[str | None] = mapped_column(String(5))
    age_set_at: Mapped[datetime | None] = mapped_column(TS)
    guardian_consent: Mapped[str] = mapped_column(String(16), nullable=False, server_default="not_required")
    notifications_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    notify_categories: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default=text("'{support}'::text[]")
    )
    quiet_hours_start: Mapped[time | None] = mapped_column(Time, server_default=text("'22:00'"))
    quiet_hours_end: Mapped[time | None] = mapped_column(Time, server_default=text("'08:00'"))
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, server_default="Asia/Tashkent")
    bot_blocked: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        TS, nullable=False, server_default=func.now(), onupdate=func.now()
    )


class GuardianLink(Base):
    """Опекунство: у ребёнка один опекун (PK child_user_id); ≤ MAX_CHILDREN детей на аккаунт (проверка в домене под
    блокировкой строки родителя). Idempotency-Key создания детского профиля — UNIQUE (guardian_user_id, key)."""

    __tablename__ = "guardian_links"
    __table_args__ = (
        CheckConstraint("child_user_id <> guardian_user_id", name="ck_guardian_links_not_self"),
        Index("ix_guardian_links_guardian", "guardian_user_id"),
        UniqueConstraint("guardian_user_id", "idempotency_key", name="uq_guardian_links_idempotency"),
    )

    child_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey(USER_FK, ondelete="CASCADE"), primary_key=True
    )
    guardian_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey(USER_FK), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    request_fingerprint: Mapped[str | None] = mapped_column(String(64))


class GuardianConsentRequest(Base):
    """Ссылка согласия родителя для подростка 14–17. Хранится только sha256 токена; у подростка не больше одной
    действующей (pending) ссылки — новая отзывает прежнюю (revoked). Истечение — по expires_at (в строке остаётся
    pending, наружу — expired).

    Решение `granted` создаёт запись consents подростка с основанием guardian (`consent_id`); у подростка не больше
    одного действующего `granted`. Отзыв родителем: строка → `declined` + `revoked_at` (`decided_at` — время
    исходного решения)."""

    __tablename__ = "guardian_consent_requests"
    __table_args__ = (
        CheckConstraint("status IN ('pending','granted','declined','expired','revoked')",
                        name="ck_guardian_consent_requests_status"),
        CheckConstraint("(status IN ('granted','declined')) = (guardian_user_id IS NOT NULL)",
                        name="ck_guardian_consent_requests_guardian"),
        CheckConstraint("(status IN ('granted','declined')) = (decided_at IS NOT NULL)",
                        name="ck_guardian_consent_requests_decided"),
        CheckConstraint("expires_at > created_at", name="ck_guardian_consent_requests_expiry"),
        CheckConstraint("revoked_at IS NULL OR status = 'declined'", name="ck_guardian_consent_requests_revoked"),
        Index("ix_guardian_consent_requests_teen", "teen_user_id"),
        Index("ix_guardian_consent_requests_guardian", "guardian_user_id"),
        Index("uq_guardian_consent_requests_pending", "teen_user_id", unique=True,
              postgresql_where=text("status = 'pending'")),
        Index("uq_guardian_consent_requests_granted", "teen_user_id", unique=True,
              postgresql_where=text("status = 'granted'")),
        UniqueConstraint("teen_user_id", "idempotency_key", name="uq_guardian_consent_requests_idempotency"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    teen_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey(USER_FK), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="pending")
    guardian_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey(USER_FK))
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    decided_at: Mapped[datetime | None] = mapped_column(TS)
    expires_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    consent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("consents.consent_id"))
    revoked_at: Mapped[datetime | None] = mapped_column(TS)


class Consent(Base):
    """История согласий. Строки неизменяемы (триггер), кроме однократной фиксации отзыва.

    Действующее согласие — одно на ученика и основание: `self` — своё (аккаунт; цели, которые выбрал сам),
    `guardian` — родителя (детский профиль — единственное основание; подросток 14–17 — разрешение родителя,
    действует рядом со своим). Причины закрытия: user — отозвал сам, superseded — заменено новой записью,
    deletion — удаление, guardian — отозвано родителем."""

    __tablename__ = "consents"
    __table_args__ = (
        CheckConstraint("revoke_reason IS NULL OR revoke_reason IN ('user','superseded','deletion','guardian')",
                        name="ck_consents_revoke_reason"),
        CheckConstraint("(revoked_at IS NULL) = (revoke_reason IS NULL)", name="ck_consents_revoke_pair"),
        CheckConstraint("locale IN ('ru','uz')", name="ck_consents_locale"),
        CheckConstraint(f"age_band IS NULL OR age_band IN {AGE_BANDS_SQL}", name="ck_consents_age_band"),
        # основание: сам пользователь или родитель за ребёнка / подростка (granted_by — аккаунт родителя)
        CheckConstraint("basis IN ('self','guardian')", name="ck_consents_basis"),
        CheckConstraint("(basis = 'guardian') = (granted_by_user_id IS NOT NULL)", name="ck_consents_granted_by"),
        Index("ix_consents_user_accepted", "user_id", "accepted_at"),
        # Не больше одного действующего согласия на ученика и основание.
        Index("uq_consents_active", "user_id", "basis", unique=True, postgresql_where=text("revoked_at IS NULL")),
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
    age_band: Mapped[str | None] = mapped_column(String(5))
    basis: Mapped[str] = mapped_column(String(16), nullable=False, server_default="self")
    granted_by_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey(USER_FK))
    policy_text_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    evidence_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)


PIN_RESET_COMPLETE_SQL = (
    "(reset_pin_hash IS NULL) = (reset_pin_length IS NULL) AND (reset_pin_hash IS NULL) = (reset_requested_at IS NULL)"
    " AND (reset_pin_hash IS NULL) = (reset_effective_at IS NULL)"
)
PIN_RESET_LENGTH_SQL = "reset_pin_length IS NULL OR reset_pin_length IN (4, 6)"


class PinCredential(Base):
    """Код родителя (PIN 4/6 цифр) аккаунта.

    `reset_*` — ожидающий сброс кодом из бота (ревью T-8): новый код (Argon2id) начинает действовать с
    `reset_effective_at` (через PIN_RESET_DELAY_HOURS); до этого действует прежний `pin_hash`, любой верный ввод
    прежнего кода сброс отменяет. Все четыре поля заданы вместе или все NULL.
    """

    __tablename__ = "pin_credentials"
    __table_args__ = (
        CheckConstraint("pin_length IN (4, 6)", name="ck_pin_length"),
        CheckConstraint(PIN_RESET_COMPLETE_SQL, name="ck_pin_reset_complete"),
        CheckConstraint(PIN_RESET_LENGTH_SQL, name="ck_pin_reset_length"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="CASCADE"), primary_key=True
    )
    pin_hash: Mapped[str] = mapped_column(Text, nullable=False)  # Argon2id (PHC-строка с солью и параметрами)
    pin_length: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    reset_pin_hash: Mapped[str | None] = mapped_column(Text)  # Argon2id нового кода, ещё не действующего
    reset_pin_length: Mapped[int | None] = mapped_column(SmallInteger)
    reset_requested_at: Mapped[datetime | None] = mapped_column(TS)
    reset_effective_at: Mapped[datetime | None] = mapped_column(TS)


class BiometricCredential(Base):
    __tablename__ = "biometric_credentials"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="CASCADE"), primary_key=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)  # sha256(biometric_token)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


# Сага удаления: таблицы deletion_* живут в модуле deletion/ — импорт регистрирует их в Base.metadata
# (Alembic env и сверка моделей с миграциями видят все таблицы сервиса).
from tilhero_identity.deletion.models import (  # noqa: E402
    DeletionAttempt,
    DeletionDomainAck,
    DeletionRequest,
)

__all__ = [
    "USER_FK", "USER_STATUSES", "Base", "BiometricCredential", "Consent", "DeletionAttempt", "DeletionDomainAck",
    "DeletionRequest", "GuardianConsentRequest", "GuardianLink", "PinCredential", "User",
]
