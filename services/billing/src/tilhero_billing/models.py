"""Модели billing — зеркало миграции 0001 (тест schema_drift): таблицы INTERNAL_API спринта 8 §1.1, UNIQUE, индексы и
CHECK объявлены и в `__table_args__`. Таблицы без схемы (search_path = `billing`).

Деньги — только целые (ADR-0001): тийины `BigInteger` (`amount_tiyin`), Stars `Integer` (`amount_stars`); в заказе,
транзакции и возврате заполнено ровно одно из них (CHECK). `Numeric` и float для денег не используются.

Неизменяемость (триггеры миграции; роль сервиса снять их не может):
- `catalog_versions` — `catalog_guard`: черновик правится и удаляется; активная — только перевод в archived;
  архивная неизменяема; активной становится только проверенная версия (validated_hash = payload_hash);
- `provider_transactions` — `txn_guard`: переходы §1.4 (Stars создаётся сразу performed), удалять нельзя;
- `orders` — `orders_guard`: переходы заказа §1.4, деньги и снимок неизменны, обезличивание — только в саге;
- `periods` — `periods_guard`: переходы §1.10, удаление — только в саге;
- `minute_ledger` — `ledger_guard`: только добавление; в саге (`SET LOCAL tilhero.deletion = 'on'`) — DELETE и
  обезличивание `learner_id`.

Отступление от §1.1 (аддитивно): имена сотрудников (`*_by_name`) рядом с их id — для `StaffRef` админки (admin.ts),
как в gamification; ученики и их ПДн сюда не попадают.
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
    Identity,
    Index,
    Integer,
    SmallInteger,
    Text,
    UniqueConstraint,
)
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import ARRAY, INET, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TS = DateTime(timezone=True)
UID = UUID(as_uuid=True)

AGE_BANDS = ("6-9", "10-13", "14-17", "18+")
GUARDIAN_CONSENTS = ("not_required", "pending", "granted", "declined")
CHANNELS = ("miniapp", "web", "renewal")
PROVIDERS = ("telegram_stars", "payme", "click", "uzum")
ORDER_STATUSES = ("pending", "paid", "fulfilled", "expired", "cancelled", "refunded")
TXN_STATES = ("created", "performed", "cancelled", "refunded")
CANCEL_REASONS = ("receivers_not_found", "debit_error", "execution_error", "timeout", "refund", "unknown",
                  "provider_error", "order_closed")
STARS_SUB_STATUSES = ("active", "canceled", "failed", "refunded", "ended")
STARS_SUB_LIVE = ("active", "canceled", "failed")
PERIOD_STATUSES = ("scheduled", "active", "ended", "superseded", "revoked")
PERIOD_SOURCES = ("order", "trial", "grant")
CLOSE_REASONS = ("ended", "superseded", "refund", "staff", "deletion")
LEDGER_KINDS = ("grant", "debit", "expire", "revoke", "adjust")
LEDGER_REFS = ("order", "trial", "grant", "session", "room", "period", "hold", "refund", "adjustment", "deletion")
FEATURES = ("ai_lessons", "pair_lessons")
HOLD_STATUSES = ("active", "settled", "expired")
ADJUSTMENT_KINDS = ("minutes", "grant_period", "revoke_period")
ADJUSTMENT_STATUSES = ("pending", "applied", "rejected", "expired", "cancelled")
REFUND_STATUSES = ("awaiting_provider", "completed", "failed")
RECON_KINDS = ("paid_not_fulfilled", "stale_created", "provider_mismatch", "duplicate_payment",
               "refund_without_request", "refund_stuck", "fiscal_missing", "tils_spent_on_refund",
               "paid_after_deletion", "payer_mismatch", "stars_unmatched", "stars_subscription_desync",
               "hold_expired", "balance_drift", "unmatched_settlement")
RECON_STATUSES = ("open", "resolved", "ignored")
RUN_KINDS = ("tick", "daily", "manual")
FISCAL_SOURCES = ("payme_set_fiscal_data", "click_ofd", "uzum")
FISCAL_STATUSES = ("pending", "registered", "failed")
PROJECTIONS = ("profiles",)


def _in(values: tuple[str, ...]) -> str:
    return "IN (" + ",".join(f"'{v}'" for v in values) + ")"


class Base(DeclarativeBase):
    pass


# ---------------------------------------------------------------- проекция учеников (identity-consent)

class Learner(Base):
    """Проекция профилей: аккаунт (kind account, account_id = user_id) и его детские профили (account_id опекуна)."""

    __tablename__ = "learners"
    __table_args__ = (
        CheckConstraint(f"kind {_in(('account', 'child'))}", name="ck_learners_kind"),
        CheckConstraint(f"age_band IS NULL OR age_band {_in(AGE_BANDS)}", name="ck_learners_age_band"),
        CheckConstraint(f"guardian_consent IS NULL OR guardian_consent {_in(GUARDIAN_CONSENTS)}",
                        name="ck_learners_consent"),
        CheckConstraint("(kind = 'account') = (account_id = user_id)", name="ck_learners_account"),
        Index("ix_learners_account", "account_id"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UID, primary_key=True)
    account_id: Mapped[uuid.UUID] = mapped_column(UID, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    age_band: Mapped[str | None] = mapped_column(Text)
    guardian_consent: Mapped[str | None] = mapped_column(Text)
    profile_updated_at: Mapped[datetime | None] = mapped_column(TS)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))


# ---------------------------------------------------------------- каталог (версии)

class CatalogVersion(Base):
    __tablename__ = "catalog_versions"
    __table_args__ = (
        CheckConstraint("version >= 1", name="ck_catalog_versions_version"),
        CheckConstraint(f"status {_in(('draft', 'active', 'archived'))}", name="ck_catalog_versions_status"),
        CheckConstraint("comment IS NULL OR char_length(comment) <= 500", name="ck_catalog_versions_comment"),
        CheckConstraint("status = 'draft' OR activated_at IS NOT NULL", name="ck_catalog_versions_activated"),
        Index("uq_catalog_draft", "status", unique=True, postgresql_where=sql_text("status = 'draft'")),
        Index("uq_catalog_active", "status", unique=True, postgresql_where=sql_text("status = 'active'")),
    )

    version: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    payload_hash: Mapped[str] = mapped_column(Text, nullable=False)
    validated_hash: Mapped[str | None] = mapped_column(Text)
    comment: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    created_by_name: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))
    activated_by: Mapped[str | None] = mapped_column(Text)
    activated_by_name: Mapped[str | None] = mapped_column(Text)
    activated_at: Mapped[datetime | None] = mapped_column(TS)


# ---------------------------------------------------------------- подписки Stars

class StarsSubscription(Base):
    """Нативная подписка Telegram Stars (§1.5): первый платёж и продления; account_id — NULL после саги."""

    __tablename__ = "stars_subscriptions"
    __table_args__ = (
        CheckConstraint("amount_stars BETWEEN 1 AND 10000", name="ck_stars_subscriptions_amount"),
        CheckConstraint(f"status {_in(STARS_SUB_STATUSES)}", name="ck_stars_subscriptions_status"),
        CheckConstraint("renewals >= 0", name="ck_stars_subscriptions_renewals"),
        Index("uq_stars_sub_live", "account_id", unique=True,
              postgresql_where=sql_text("status IN ('active','canceled','failed')")),
    )

    subscription_id: Mapped[uuid.UUID] = mapped_column(UID, primary_key=True)
    account_id: Mapped[uuid.UUID | None] = mapped_column(UID)
    product_code: Mapped[str] = mapped_column(Text, nullable=False)
    first_order_id: Mapped[uuid.UUID] = mapped_column(
        UID, ForeignKey("orders.order_id", name="fk_stars_subscriptions_first_order", use_alter=True),
        nullable=False, unique=True)
    first_charge_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    last_charge_id: Mapped[str] = mapped_column(Text, nullable=False)
    amount_stars: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    renewals: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))


# ---------------------------------------------------------------- заказы и транзакции

class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (
        CheckConstraint(f"channel {_in(CHANNELS)}", name="ck_orders_channel"),
        CheckConstraint("product_code ~ '^[a-z0-9_]{2,40}$'", name="ck_orders_product_code"),
        CheckConstraint(f"product_kind {_in(('subscription', 'til_pack'))}", name="ck_orders_product_kind"),
        CheckConstraint(f"provider {_in(PROVIDERS)}", name="ck_orders_provider"),
        CheckConstraint(f"currency {_in(('UZS', 'XTR'))}", name="ck_orders_currency"),
        CheckConstraint("amount_tiyin BETWEEN 100 AND 100000000000", name="ck_orders_amount_tiyin"),
        CheckConstraint("amount_stars BETWEEN 1 AND 100000", name="ck_orders_amount_stars"),
        CheckConstraint(f"stars_mode {_in(('one_time', 'subscription'))}", name="ck_orders_stars_mode"),
        CheckConstraint("invoice_link IS NULL OR invoice_link ~ '^https://t\\.me/'", name="ck_orders_invoice_link"),
        CheckConstraint(f"start_mode {_in(('after_current', 'now'))}", name="ck_orders_start_mode"),
        CheckConstraint(f"status {_in(ORDER_STATUSES)}", name="ck_orders_status"),
        CheckConstraint("char_length(offer_version) BETWEEN 1 AND 20", name="ck_orders_offer_version"),
        CheckConstraint(f"locale {_in(('ru', 'uz'))}", name="ck_orders_locale"),
        CheckConstraint("(currency = 'XTR') = (provider = 'telegram_stars')", name="ck_orders_currency_provider"),
        CheckConstraint("(currency = 'UZS') = (amount_tiyin IS NOT NULL)", name="ck_orders_uzs_amount"),
        CheckConstraint("(currency = 'XTR') = (amount_stars IS NOT NULL)", name="ck_orders_xtr_amount"),
        CheckConstraint("(provider = 'telegram_stars') = (channel IN ('miniapp','renewal'))",
                        name="ck_orders_channel_provider"),
        CheckConstraint("(currency = 'XTR') = (stars_mode IS NOT NULL)", name="ck_orders_xtr_mode"),
        CheckConstraint("(channel = 'renewal') = (stars_subscription_id IS NOT NULL)", name="ck_orders_renewal"),
        CheckConstraint("start_mode IS NULL OR product_kind = 'subscription'", name="ck_orders_start_kind"),
        CheckConstraint("(status IN ('paid','fulfilled','refunded')) = (paid_at IS NOT NULL)", name="ck_orders_paid"),
        UniqueConstraint("account_id", "idempotency_key", name="uq_orders_idempotency"),
        Index("ix_orders_account", "account_id", sql_text("created_at DESC")),
        Index("ix_orders_pending", "expires_at", postgresql_where=sql_text("status = 'pending'")),
        Index("ix_orders_paid_at", "paid_at", postgresql_where=sql_text("paid_at IS NOT NULL")),
        Index("ix_orders_beneficiary", "beneficiary_id"),
    )

    order_id: Mapped[uuid.UUID] = mapped_column(UID, primary_key=True)
    order_no: Mapped[int] = mapped_column(BigInteger, Identity(always=True, start=100001), unique=True)
    account_id: Mapped[uuid.UUID | None] = mapped_column(UID)
    beneficiary_id: Mapped[uuid.UUID | None] = mapped_column(UID)
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    product_code: Mapped[str] = mapped_column(Text, nullable=False)
    product_kind: Mapped[str] = mapped_column(Text, nullable=False)
    catalog_version: Mapped[int] = mapped_column(
        Integer, ForeignKey("catalog_versions.version", name="fk_orders_catalog_version"), nullable=False)
    product_snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    currency: Mapped[str] = mapped_column(Text, nullable=False)
    amount_tiyin: Mapped[int | None] = mapped_column(BigInteger)
    amount_stars: Mapped[int | None] = mapped_column(Integer)
    stars_mode: Mapped[str | None] = mapped_column(Text)
    stars_subscription_id: Mapped[uuid.UUID | None] = mapped_column(
        UID, ForeignKey("stars_subscriptions.subscription_id", name="fk_orders_stars_subscription"))
    invoice_link: Mapped[str | None] = mapped_column(Text)
    start_mode: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    offer_version: Mapped[str] = mapped_column(Text, nullable=False)
    locale: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))
    paid_at: Mapped[datetime | None] = mapped_column(TS)
    fulfilled_at: Mapped[datetime | None] = mapped_column(TS)
    closed_at: Mapped[datetime | None] = mapped_column(TS)


class ProviderTransaction(Base):
    __tablename__ = "provider_transactions"
    __table_args__ = (
        CheckConstraint(f"provider {_in(PROVIDERS)}", name="ck_txn_provider"),
        CheckConstraint("char_length(provider_txn_id) BETWEEN 1 AND 128", name="ck_txn_provider_txn_id"),
        CheckConstraint("amount_tiyin > 0", name="ck_txn_amount_tiyin"),
        CheckConstraint("amount_stars > 0", name="ck_txn_amount_stars"),
        CheckConstraint(f"state {_in(TXN_STATES)}", name="ck_txn_state"),
        CheckConstraint(f"cancel_reason {_in(CANCEL_REASONS)}", name="ck_txn_cancel_reason"),
        CheckConstraint("(amount_tiyin IS NULL) <> (amount_stars IS NULL)", name="ck_txn_one_amount"),
        CheckConstraint("(provider = 'telegram_stars') = (amount_stars IS NOT NULL)", name="ck_txn_stars_amount"),
        CheckConstraint("(state IN ('performed','refunded')) = (performed_at IS NOT NULL)", name="ck_txn_performed"),
        CheckConstraint("(state IN ('cancelled','refunded')) = (cancelled_at IS NOT NULL)", name="ck_txn_cancelled"),
        UniqueConstraint("provider", "provider_txn_id", name="uq_txn_provider_id"),
        Index("uq_txn_order_performed", "order_id", unique=True, postgresql_where=sql_text("state = 'performed'")),
        Index("ix_txn_created", "created_at", postgresql_where=sql_text("state = 'created'")),
        Index("ix_txn_order", "order_id"),
        Index("ix_txn_provider_time", "provider", "provider_time"),
    )

    txn_id: Mapped[uuid.UUID] = mapped_column(UID, primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), unique=True)
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    provider_txn_id: Mapped[str] = mapped_column(Text, nullable=False)
    order_id: Mapped[uuid.UUID] = mapped_column(UID, ForeignKey("orders.order_id", name="fk_txn_order"),
                                                nullable=False)
    amount_tiyin: Mapped[int | None] = mapped_column(BigInteger)
    amount_stars: Mapped[int | None] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    cancel_reason: Mapped[str | None] = mapped_column(Text)
    provider_reason: Mapped[int | None] = mapped_column(SmallInteger)
    provider_time: Mapped[datetime | None] = mapped_column(TS)
    provider_meta: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=sql_text("'{}'"))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))
    performed_at: Mapped[datetime | None] = mapped_column(TS)
    cancelled_at: Mapped[datetime | None] = mapped_column(TS)


class StarsPreCheckout(Base):
    """Ответы на pre_checkout_query (повтор query_id — тот же ответ); хранение 30 дней (tick)."""

    __tablename__ = "stars_pre_checkouts"
    __table_args__ = (
        CheckConstraint("char_length(query_id) <= 128", name="ck_stars_pre_checkouts_query"),
        Index("ix_stars_pre_checkouts_answered", "answered_at"),
    )

    query_id: Mapped[str] = mapped_column(Text, primary_key=True)
    order_id: Mapped[uuid.UUID | None] = mapped_column(UID)
    ok: Mapped[bool] = mapped_column(Boolean, nullable=False)
    error_code: Mapped[str | None] = mapped_column(Text)
    answered_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))


class FiscalReceipt(Base):
    __tablename__ = "fiscal_receipts"
    __table_args__ = (
        CheckConstraint(f"kind {_in(('sale', 'refund'))}", name="ck_fiscal_receipts_kind"),
        CheckConstraint(f"source {_in(FISCAL_SOURCES)}", name="ck_fiscal_receipts_source"),
        CheckConstraint(f"status {_in(FISCAL_STATUSES)}", name="ck_fiscal_receipts_status"),
        CheckConstraint("qr_code_url IS NULL OR qr_code_url ~ '^https://'", name="ck_fiscal_receipts_qr"),
        CheckConstraint("char_length(message) <= 500", name="ck_fiscal_receipts_message"),
        UniqueConstraint("txn_id", "kind", name="uq_fiscal_receipts_txn_kind"),
        Index("ix_fiscal_receipts_retry", "next_attempt_at", postgresql_where=sql_text("status = 'pending'")),
    )

    receipt_id: Mapped[uuid.UUID] = mapped_column(UID, primary_key=True)
    txn_id: Mapped[uuid.UUID] = mapped_column(
        UID, ForeignKey("provider_transactions.txn_id", name="fk_fiscal_receipts_txn"), nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    provider_receipt_id: Mapped[str | None] = mapped_column(Text)
    fiscal_receipt_id: Mapped[str | None] = mapped_column(Text)
    terminal_id: Mapped[str | None] = mapped_column(Text)
    fiscal_sign: Mapped[str | None] = mapped_column(Text)
    qr_code_url: Mapped[str | None] = mapped_column(Text)
    status_code: Mapped[int | None] = mapped_column(Integer)
    message: Mapped[str | None] = mapped_column(Text)
    registered_at: Mapped[datetime | None] = mapped_column(TS)
    attempts: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default=sql_text("0"))
    next_attempt_at: Mapped[datetime | None] = mapped_column(TS)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))


class Refund(Base):
    __tablename__ = "refunds"
    __table_args__ = (
        CheckConstraint("amount_tiyin > 0", name="ck_refunds_amount_tiyin"),
        CheckConstraint("amount_stars > 0", name="ck_refunds_amount_stars"),
        CheckConstraint(f"status {_in(REFUND_STATUSES)}", name="ck_refunds_status"),
        CheckConstraint(f"initiated_by {_in(('staff', 'provider'))}", name="ck_refunds_initiated_by"),
        CheckConstraint(f"method {_in(('provider_api', 'provider_cabinet'))}", name="ck_refunds_method"),
        CheckConstraint("char_length(reason) BETWEEN 10 AND 500", name="ck_refunds_reason"),
        CheckConstraint("(amount_tiyin IS NULL) <> (amount_stars IS NULL)", name="ck_refunds_one_amount"),
        CheckConstraint("(initiated_by = 'staff') = (requested_by IS NOT NULL AND reason IS NOT NULL)",
                        name="ck_refunds_staff"),
        Index("uq_refund_order_live", "order_id", unique=True,
              postgresql_where=sql_text("status IN ('awaiting_provider','completed')")),
        Index("ix_refunds_status", "status", "requested_at"),
    )

    refund_id: Mapped[uuid.UUID] = mapped_column(UID, primary_key=True)
    order_id: Mapped[uuid.UUID] = mapped_column(UID, ForeignKey("orders.order_id", name="fk_refunds_order"),
                                                nullable=False)
    txn_id: Mapped[uuid.UUID] = mapped_column(
        UID, ForeignKey("provider_transactions.txn_id", name="fk_refunds_txn"), nullable=False)
    amount_tiyin: Mapped[int | None] = mapped_column(BigInteger)
    amount_stars: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    initiated_by: Mapped[str] = mapped_column(Text, nullable=False)
    method: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    requested_by: Mapped[str | None] = mapped_column(Text)
    requested_by_name: Mapped[str | None] = mapped_column(Text)
    requested_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))
    completed_at: Mapped[datetime | None] = mapped_column(TS)
    failure_code: Mapped[str | None] = mapped_column(Text)
    tils_check: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    idempotency_key: Mapped[str | None] = mapped_column(Text)


# ---------------------------------------------------------------- периоды и минуты

class Period(Base):
    __tablename__ = "periods"
    __table_args__ = (
        CheckConstraint(f"source {_in(PERIOD_SOURCES)}", name="ck_periods_source"),
        CheckConstraint("features <@ ARRAY['ai_lessons','pair_lessons']::text[]", name="ck_periods_features"),
        CheckConstraint("minutes_granted BETWEEN 1 AND 100000", name="ck_periods_minutes"),
        CheckConstraint("days BETWEEN 1 AND 366", name="ck_periods_days"),
        CheckConstraint(f"status {_in(PERIOD_STATUSES)}", name="ck_periods_status"),
        CheckConstraint(f"close_reason {_in(CLOSE_REASONS)}", name="ck_periods_close_reason"),
        CheckConstraint("(status = 'scheduled') = (starts_at IS NULL)", name="ck_periods_scheduled"),
        CheckConstraint("starts_at IS NULL OR ends_at > starts_at", name="ck_periods_range"),
        CheckConstraint("(source = 'order') = (order_id IS NOT NULL)", name="ck_periods_order"),
        CheckConstraint("(source = 'grant') = (adjustment_id IS NOT NULL)", name="ck_periods_grant"),
        Index("uq_period_active", "account_id", unique=True, postgresql_where=sql_text("status = 'active'")),
        Index("uq_period_trial", "account_id", unique=True, postgresql_where=sql_text("source = 'trial'")),
        Index("ix_period_ends", "ends_at", postgresql_where=sql_text("status = 'active'")),
        Index("ix_periods_account", "account_id", "created_at"),
    )

    period_id: Mapped[uuid.UUID] = mapped_column(UID, primary_key=True)
    account_id: Mapped[uuid.UUID] = mapped_column(UID, nullable=False)
    product_code: Mapped[str] = mapped_column(Text, nullable=False)
    catalog_version: Mapped[int] = mapped_column(Integer, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    order_id: Mapped[uuid.UUID | None] = mapped_column(UID, ForeignKey("orders.order_id", name="fk_periods_order"),
                                                       unique=True)
    adjustment_id: Mapped[uuid.UUID | None] = mapped_column(UID, unique=True)
    stars_subscription_id: Mapped[uuid.UUID | None] = mapped_column(
        UID, ForeignKey("stars_subscriptions.subscription_id", name="fk_periods_stars_subscription"))
    features: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    minutes_granted: Mapped[int] = mapped_column(Integer, nullable=False)
    days: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    starts_at: Mapped[datetime | None] = mapped_column(TS)
    ends_at: Mapped[datetime | None] = mapped_column(TS)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))
    closed_at: Mapped[datetime | None] = mapped_column(TS)
    close_reason: Mapped[str | None] = mapped_column(Text)


class PeriodBalance(Base):
    """Итоги реестра по периоду (обновляются в той же транзакции, что и запись реестра; сверка раз в сутки)."""

    __tablename__ = "period_balances"
    __table_args__ = (
        CheckConstraint("granted - spent - removed >= 0", name="ck_period_balances_nonneg"),
        CheckConstraint("held >= 0 AND held <= granted - spent - removed", name="ck_period_balances_held"),
        CheckConstraint("overage >= 0", name="ck_period_balances_overage"),
    )

    period_id: Mapped[uuid.UUID] = mapped_column(
        UID, ForeignKey("periods.period_id", name="fk_period_balances_period"), primary_key=True)
    account_id: Mapped[uuid.UUID] = mapped_column(UID, nullable=False)
    granted: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    spent: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    removed: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    held: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    overage: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    low_notified: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sql_text("false"))
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))


class MinuteLedger(Base):
    __tablename__ = "minute_ledger"
    __table_args__ = (
        CheckConstraint(f"kind {_in(LEDGER_KINDS)}", name="ck_minute_ledger_kind"),
        CheckConstraint("minutes <> 0 AND minutes BETWEEN -100000 AND 100000", name="ck_minute_ledger_minutes"),
        CheckConstraint("overage >= 0", name="ck_minute_ledger_overage"),
        CheckConstraint(f"ref_kind {_in(LEDGER_REFS)}", name="ck_minute_ledger_ref_kind"),
        CheckConstraint("char_length(ref_id) <= 64", name="ck_minute_ledger_ref_id"),
        CheckConstraint("actor IN ('system','learner') OR actor LIKE 'staff:%'", name="ck_minute_ledger_actor"),
        CheckConstraint("CASE kind WHEN 'grant' THEN minutes > 0 WHEN 'adjust' THEN true ELSE minutes < 0 END",
                        name="ck_minute_ledger_sign"),
        Index("ix_ledger_account", "account_id", sql_text("seq DESC")),
        Index("ix_ledger_period", "period_id"),
        Index("ix_ledger_created", "created_at"),
    )

    entry_id: Mapped[uuid.UUID] = mapped_column(UID, primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), unique=True)
    account_id: Mapped[uuid.UUID] = mapped_column(UID, nullable=False)
    period_id: Mapped[uuid.UUID] = mapped_column(UID, ForeignKey("periods.period_id", name="fk_minute_ledger_period"),
                                                 nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    overage: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    learner_id: Mapped[uuid.UUID | None] = mapped_column(UID)
    ref_kind: Mapped[str] = mapped_column(Text, nullable=False)
    ref_id: Mapped[str] = mapped_column(Text, nullable=False)
    actor: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))


class MinuteHold(Base):
    __tablename__ = "minute_holds"
    __table_args__ = (
        CheckConstraint(f"feature {_in(FEATURES)}", name="ck_minute_holds_feature"),
        CheckConstraint(f"ref_kind {_in(('session', 'room'))}", name="ck_minute_holds_ref_kind"),
        CheckConstraint("minutes BETWEEN 1 AND 120", name="ck_minute_holds_minutes"),
        CheckConstraint(f"status {_in(HOLD_STATUSES)}", name="ck_minute_holds_status"),
        CheckConstraint("settled_minutes >= 0", name="ck_minute_holds_settled"),
        CheckConstraint("overage >= 0", name="ck_minute_holds_overage"),
        CheckConstraint("(status = 'active') = (settled_at IS NULL)", name="ck_minute_holds_active"),
        UniqueConstraint("ref_kind", "ref_id", name="uq_minute_holds_ref"),
        Index("ix_holds_active", "expires_at", postgresql_where=sql_text("status = 'active'")),
        Index("ix_holds_account", "account_id", "status"),
    )

    hold_id: Mapped[uuid.UUID] = mapped_column(UID, primary_key=True)
    account_id: Mapped[uuid.UUID] = mapped_column(UID, nullable=False)
    period_id: Mapped[uuid.UUID] = mapped_column(UID, ForeignKey("periods.period_id", name="fk_minute_holds_period"),
                                                 nullable=False)
    learner_id: Mapped[uuid.UUID | None] = mapped_column(UID)
    feature: Mapped[str] = mapped_column(Text, nullable=False)
    ref_kind: Mapped[str] = mapped_column(Text, nullable=False)
    ref_id: Mapped[uuid.UUID] = mapped_column(UID, nullable=False)
    minutes: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    settled_minutes: Mapped[int | None] = mapped_column(SmallInteger)
    overage: Mapped[int | None] = mapped_column(SmallInteger)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))
    expires_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    settled_at: Mapped[datetime | None] = mapped_column(TS)


# ---------------------------------------------------------------- «четыре глаза»

class Adjustment(Base):
    __tablename__ = "adjustments"
    __table_args__ = (
        CheckConstraint(f"kind {_in(ADJUSTMENT_KINDS)}", name="ck_adjustments_kind"),
        CheckConstraint("minutes <> 0 AND minutes BETWEEN -10000 AND 10000", name="ck_adjustments_minutes"),
        CheckConstraint("days BETWEEN 1 AND 90", name="ck_adjustments_days"),
        CheckConstraint("char_length(reason) BETWEEN 10 AND 500", name="ck_adjustments_reason"),
        CheckConstraint(f"status {_in(ADJUSTMENT_STATUSES)}", name="ck_adjustments_status"),
        CheckConstraint("char_length(decision_note) <= 500", name="ck_adjustments_note"),
        CheckConstraint("decided_by IS NULL OR decided_by <> requested_by", name="ck_adjustments_four_eyes"),
        CheckConstraint("kind <> 'minutes' OR (minutes IS NOT NULL AND period_id IS NOT NULL AND days IS NULL)",
                        name="ck_adjustments_minutes_kind"),
        CheckConstraint("kind <> 'grant_period' OR (minutes > 0 AND days IS NOT NULL AND period_id IS NULL)",
                        name="ck_adjustments_grant_kind"),
        CheckConstraint("kind <> 'revoke_period' OR (period_id IS NOT NULL AND minutes IS NULL AND days IS NULL)",
                        name="ck_adjustments_revoke_kind"),
        UniqueConstraint("requested_by", "idempotency_key", name="uq_adjustments_idempotency"),
        Index("ix_adjustments_pending", "requested_at", postgresql_where=sql_text("status = 'pending'")),
        Index("ix_adjustments_account", "account_id", "requested_at"),
    )

    adjustment_id: Mapped[uuid.UUID] = mapped_column(UID, primary_key=True)
    account_id: Mapped[uuid.UUID] = mapped_column(UID, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    minutes: Mapped[int | None] = mapped_column(Integer)
    days: Mapped[int | None] = mapped_column(SmallInteger)
    period_id: Mapped[uuid.UUID | None] = mapped_column(UID)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    requested_by: Mapped[str] = mapped_column(Text, nullable=False)
    requested_by_name: Mapped[str | None] = mapped_column(Text)
    requested_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))
    decided_by: Mapped[str | None] = mapped_column(Text)
    decided_by_name: Mapped[str | None] = mapped_column(Text)
    decided_at: Mapped[datetime | None] = mapped_column(TS)
    decision_note: Mapped[str | None] = mapped_column(Text)
    before_value: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    after_value: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    expires_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)


# ---------------------------------------------------------------- сверка, журнал вызовов, курсы

class ReconciliationRun(Base):
    __tablename__ = "reconciliation_runs"
    __table_args__ = (CheckConstraint(f"kind {_in(RUN_KINDS)}", name="ck_reconciliation_runs_kind"),)

    run_id: Mapped[uuid.UUID] = mapped_column(UID, primary_key=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    started_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))
    finished_at: Mapped[datetime | None] = mapped_column(TS)
    checked: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    found: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    error: Mapped[str | None] = mapped_column(Text)


class ReconciliationItem(Base):
    __tablename__ = "reconciliation_items"
    __table_args__ = (
        CheckConstraint(f"kind {_in(RECON_KINDS)}", name="ck_reconciliation_items_kind"),
        CheckConstraint(f"status {_in(RECON_STATUSES)}", name="ck_reconciliation_items_status"),
        CheckConstraint("note IS NULL OR char_length(note) BETWEEN 10 AND 500", name="ck_reconciliation_items_note"),
        Index("ix_recon_items_status", "status", "created_at"),
    )

    item_id: Mapped[uuid.UUID] = mapped_column(UID, primary_key=True)
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        UID, ForeignKey("reconciliation_runs.run_id", name="fk_reconciliation_items_run"))
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    provider: Mapped[str | None] = mapped_column(Text)
    order_id: Mapped[uuid.UUID | None] = mapped_column(UID)
    txn_id: Mapped[uuid.UUID | None] = mapped_column(UID)
    period_id: Mapped[uuid.UUID | None] = mapped_column(UID)
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=sql_text("'{}'"))
    status: Mapped[str] = mapped_column(Text, nullable=False)
    dedup_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))
    resolved_by: Mapped[str | None] = mapped_column(Text)
    resolved_by_name: Mapped[str | None] = mapped_column(Text)
    resolved_at: Mapped[datetime | None] = mapped_column(TS)
    note: Mapped[str | None] = mapped_column(Text)


class ProviderCall(Base):
    """Журнал вызовов провайдеров и bot-gateway — только метаданные (без тел, подписей, учётных данных); 90 дней."""

    __tablename__ = "provider_calls"
    __table_args__ = (
        CheckConstraint(f"direction {_in(('in', 'out'))}", name="ck_provider_calls_direction"),
        CheckConstraint("char_length(method) <= 40", name="ck_provider_calls_method"),
        CheckConstraint("latency_ms >= 0", name="ck_provider_calls_latency"),
        Index("ix_provider_calls_created", "created_at"),
        Index("ix_provider_calls_provider", "provider", "direction", "created_at"),
        Index("ix_provider_calls_order", "order_no"),
    )

    call_id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    method: Mapped[str] = mapped_column(Text, nullable=False)
    provider_txn_id: Mapped[str | None] = mapped_column(Text)
    order_no: Mapped[int | None] = mapped_column(BigInteger)
    result_code: Mapped[str] = mapped_column(Text, nullable=False)
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    client_ip: Mapped[str | None] = mapped_column(INET)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))


class FxRate(Base):
    __tablename__ = "fx_rates"
    __table_args__ = (
        CheckConstraint("usd_in_tiyin BETWEEN 100000 AND 100000000", name="ck_fx_rates_usd"),
        CheckConstraint("char_length(reason) BETWEEN 10 AND 500", name="ck_fx_rates_reason"),
    )

    valid_from: Mapped[date] = mapped_column(Date, primary_key=True)
    usd_in_tiyin: Mapped[int] = mapped_column(BigInteger, nullable=False)
    set_by: Mapped[str] = mapped_column(Text, nullable=False)
    set_by_name: Mapped[str | None] = mapped_column(Text)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))


class StarRate(Base):
    __tablename__ = "star_rates"
    __table_args__ = (
        CheckConstraint("star_in_tiyin BETWEEN 1 AND 10000000", name="ck_star_rates_star"),
        CheckConstraint("char_length(reason) BETWEEN 10 AND 500", name="ck_star_rates_reason"),
    )

    valid_from: Mapped[date] = mapped_column(Date, primary_key=True)
    star_in_tiyin: Mapped[int] = mapped_column(Integer, nullable=False)
    set_by: Mapped[str] = mapped_column(Text, nullable=False)
    set_by_name: Mapped[str | None] = mapped_column(Text)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))


# ---------------------------------------------------------------- общие таблицы

class Idempotency(Base):
    """Ответы команд с Idempotency-Key (пробный период ученика, команды сотрудников): повтор — тот же ответ."""

    __tablename__ = "idempotency"
    __table_args__ = (Index("ix_idempotency_created", "created_at"),)

    scope: Mapped[str] = mapped_column(Text, primary_key=True)
    actor: Mapped[str] = mapped_column(Text, primary_key=True)
    key: Mapped[str] = mapped_column(Text, primary_key=True)
    request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    status_code: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    response: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=sql_text("now()"))


class DeletedUser(Base):
    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UID, primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UID, nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class TickState(Base):
    __tablename__ = "tick_state"

    name: Mapped[str] = mapped_column(Text, primary_key=True)
    last_run_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class ProjectionLoad(Base):
    __tablename__ = "projection_loads"
    __table_args__ = (CheckConstraint(f"name {_in(PROJECTIONS)}", name="ck_projection_loads_name"),)

    name: Mapped[str] = mapped_column(Text, primary_key=True)
    cursor: Mapped[str | None] = mapped_column(Text)
    items: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    attempted_at: Mapped[datetime | None] = mapped_column(TS)
    completed_at: Mapped[datetime | None] = mapped_column(TS)
    error: Mapped[str | None] = mapped_column(Text)
