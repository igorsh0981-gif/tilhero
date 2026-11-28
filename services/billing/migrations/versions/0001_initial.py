"""billing: все таблицы INTERNAL_API спринта 8 §1.1 (в т. ч. таблицы адаптеров и Stars), общие idempotency,
deleted_users, tick_state, projection_loads, outbox/inbox; триггеры неизменяемости и переходов; каталог v1 черновиком.

Триггеры (роль сервиса `billing` их снять не может — только владелец схемы `billing_owner`):
- catalog_guard: черновик правится и удаляется; draft → active — только проверенный (validated_hash = payload_hash) и
  с activated_at; active → archived — только смена статуса; archived неизменяема; удаляется только черновик;
  вставка — черновиком или сразу активной проверенной версией (откат);
- txn_guard: вставка — `created` (Payme, Click, Uzum) или сразу `performed` (только telegram_stars); переходы
  created → performed | cancelled, performed → refunded; ключевые поля и суммы неизменны; DELETE запрещён;
- orders_guard: вставка — `pending` (продление Stars — сразу `fulfilled` или `paid`); переходы §1.4 (pending →
  paid | fulfilled | expired | cancelled, paid → fulfilled | refunded, fulfilled → refunded, expired → paid |
  fulfilled); снимок, деньги, канал, провайдер неизменны; account_id / beneficiary_id → NULL — только в саге
  (`SET LOCAL tilhero.deletion = 'on'`); DELETE запрещён;
- periods_guard: переходы §1.10 (scheduled → active | revoked, active → ended | superseded | revoked); снимок периода
  неизменен; DELETE — только в саге;
- ledger_guard (minute_ledger): только добавление; в саге — DELETE и обезличивание learner_id (→ NULL).

Каталог v1 (migrations/seed/catalog_v1.json) — черновик, одинаковый во всех средах: цены сайта из В2 и В5, цены в
Stars пусты (О1), фискальные реквизиты пусты (О4). В dev/test сервис при старте вписывает тестовые цены в Stars и
активирует каталог (domain/stand.py); в stage/prod — только сотрудник (проверка требует реквизиты сайта).

Revision ID: 0001
Revises:
Create Date: 2026-11-22
"""
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

from tilhero_common.migrations import create_messaging_tables, drop_messaging_tables

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
UID = pg.UUID(as_uuid=True)
NOW = sa.text("now()")
ZERO = sa.text("0")
SEED = Path(__file__).resolve().parents[1] / "seed" / "catalog_v1.json"


def _in(*values: str) -> str:
    return "IN (" + ",".join(f"'{v}'" for v in values) + ")"


PROVIDERS = _in("telegram_stars", "payme", "click", "uzum")


def upgrade() -> None:
    op.create_table(
        "learners",
        sa.Column("user_id", UID, primary_key=True),
        sa.Column("account_id", UID, nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("age_band", sa.Text()),
        sa.Column("guardian_consent", sa.Text()),
        sa.Column("profile_updated_at", TS),
        sa.Column("updated_at", TS, nullable=False, server_default=NOW),
        sa.CheckConstraint(f"kind {_in('account', 'child')}", name="ck_learners_kind"),
        sa.CheckConstraint(f"age_band IS NULL OR age_band {_in('6-9', '10-13', '14-17', '18+')}",
                           name="ck_learners_age_band"),
        sa.CheckConstraint("guardian_consent IS NULL OR guardian_consent "
                           f"{_in('not_required', 'pending', 'granted', 'declined')}", name="ck_learners_consent"),
        sa.CheckConstraint("(kind = 'account') = (account_id = user_id)", name="ck_learners_account"),
    )
    op.create_index("ix_learners_account", "learners", ["account_id"])

    op.create_table(
        "catalog_versions",
        sa.Column("version", sa.Integer(), primary_key=True, autoincrement=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("payload", pg.JSONB(), nullable=False),
        sa.Column("payload_hash", sa.Text(), nullable=False),
        sa.Column("validated_hash", sa.Text()),
        sa.Column("comment", sa.Text()),
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.Column("created_by_name", sa.Text()),
        sa.Column("created_at", TS, nullable=False, server_default=NOW),
        sa.Column("updated_at", TS, nullable=False, server_default=NOW),
        sa.Column("activated_by", sa.Text()),
        sa.Column("activated_by_name", sa.Text()),
        sa.Column("activated_at", TS),
        sa.CheckConstraint("version >= 1", name="ck_catalog_versions_version"),
        sa.CheckConstraint(f"status {_in('draft', 'active', 'archived')}", name="ck_catalog_versions_status"),
        sa.CheckConstraint("comment IS NULL OR char_length(comment) <= 500", name="ck_catalog_versions_comment"),
        sa.CheckConstraint("status = 'draft' OR activated_at IS NOT NULL", name="ck_catalog_versions_activated"),
    )
    op.create_index("uq_catalog_draft", "catalog_versions", ["status"], unique=True,
                    postgresql_where=sa.text("status = 'draft'"))
    op.create_index("uq_catalog_active", "catalog_versions", ["status"], unique=True,
                    postgresql_where=sa.text("status = 'active'"))

    op.create_table(
        "stars_subscriptions",
        sa.Column("subscription_id", UID, primary_key=True),
        sa.Column("account_id", UID),
        sa.Column("product_code", sa.Text(), nullable=False),
        sa.Column("first_order_id", UID, nullable=False, unique=True),
        sa.Column("first_charge_id", sa.Text(), nullable=False, unique=True),
        sa.Column("last_charge_id", sa.Text(), nullable=False),
        sa.Column("amount_stars", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("renewals", sa.Integer(), nullable=False, server_default=ZERO),
        sa.Column("created_at", TS, nullable=False, server_default=NOW),
        sa.Column("updated_at", TS, nullable=False, server_default=NOW),
        sa.CheckConstraint("amount_stars BETWEEN 1 AND 10000", name="ck_stars_subscriptions_amount"),
        sa.CheckConstraint(f"status {_in('active', 'canceled', 'failed', 'refunded', 'ended')}",
                           name="ck_stars_subscriptions_status"),
        sa.CheckConstraint("renewals >= 0", name="ck_stars_subscriptions_renewals"),
    )
    op.create_index("uq_stars_sub_live", "stars_subscriptions", ["account_id"], unique=True,
                    postgresql_where=sa.text("status IN ('active','canceled','failed')"))

    op.create_table(
        "orders",
        sa.Column("order_id", UID, primary_key=True),
        sa.Column("order_no", sa.BigInteger(), sa.Identity(always=True, start=100001), nullable=False, unique=True),
        sa.Column("account_id", UID),
        sa.Column("beneficiary_id", UID),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("product_code", sa.Text(), nullable=False),
        sa.Column("product_kind", sa.Text(), nullable=False),
        sa.Column("catalog_version", sa.Integer(),
                  sa.ForeignKey("catalog_versions.version", name="fk_orders_catalog_version"), nullable=False),
        sa.Column("product_snapshot", pg.JSONB(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("currency", sa.Text(), nullable=False),
        sa.Column("amount_tiyin", sa.BigInteger()),
        sa.Column("amount_stars", sa.Integer()),
        sa.Column("stars_mode", sa.Text()),
        sa.Column("stars_subscription_id", UID,
                  sa.ForeignKey("stars_subscriptions.subscription_id", name="fk_orders_stars_subscription")),
        sa.Column("invoice_link", sa.Text()),
        sa.Column("start_mode", sa.Text()),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("offer_version", sa.Text(), nullable=False),
        sa.Column("locale", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=NOW),
        sa.Column("paid_at", TS),
        sa.Column("fulfilled_at", TS),
        sa.Column("closed_at", TS),
        sa.CheckConstraint("channel IN ('miniapp','web','renewal')", name="ck_orders_channel"),
        sa.CheckConstraint("product_code ~ '^[a-z0-9_]{2,40}$'", name="ck_orders_product_code"),
        sa.CheckConstraint("product_kind IN ('subscription','til_pack')", name="ck_orders_product_kind"),
        sa.CheckConstraint(f"provider {PROVIDERS}", name="ck_orders_provider"),
        sa.CheckConstraint("currency IN ('UZS','XTR')", name="ck_orders_currency"),
        sa.CheckConstraint("amount_tiyin BETWEEN 100 AND 100000000000", name="ck_orders_amount_tiyin"),
        sa.CheckConstraint("amount_stars BETWEEN 1 AND 100000", name="ck_orders_amount_stars"),
        sa.CheckConstraint("stars_mode IN ('one_time','subscription')", name="ck_orders_stars_mode"),
        sa.CheckConstraint("invoice_link IS NULL OR invoice_link ~ '^https://t\\.me/'", name="ck_orders_invoice_link"),
        sa.CheckConstraint("start_mode IN ('after_current','now')", name="ck_orders_start_mode"),
        sa.CheckConstraint("status IN ('pending','paid','fulfilled','expired','cancelled','refunded')",
                           name="ck_orders_status"),
        sa.CheckConstraint("char_length(offer_version) BETWEEN 1 AND 20", name="ck_orders_offer_version"),
        sa.CheckConstraint("locale IN ('ru','uz')", name="ck_orders_locale"),
        sa.CheckConstraint("(currency = 'XTR') = (provider = 'telegram_stars')", name="ck_orders_currency_provider"),
        sa.CheckConstraint("(currency = 'UZS') = (amount_tiyin IS NOT NULL)", name="ck_orders_uzs_amount"),
        sa.CheckConstraint("(currency = 'XTR') = (amount_stars IS NOT NULL)", name="ck_orders_xtr_amount"),
        sa.CheckConstraint("(provider = 'telegram_stars') = (channel IN ('miniapp','renewal'))",
                           name="ck_orders_channel_provider"),
        sa.CheckConstraint("(currency = 'XTR') = (stars_mode IS NOT NULL)", name="ck_orders_xtr_mode"),
        sa.CheckConstraint("(channel = 'renewal') = (stars_subscription_id IS NOT NULL)", name="ck_orders_renewal"),
        sa.CheckConstraint("start_mode IS NULL OR product_kind = 'subscription'", name="ck_orders_start_kind"),
        sa.CheckConstraint("(status IN ('paid','fulfilled','refunded')) = (paid_at IS NOT NULL)",
                           name="ck_orders_paid"),
        sa.UniqueConstraint("account_id", "idempotency_key", name="uq_orders_idempotency"),
    )
    op.create_index("ix_orders_account", "orders", ["account_id", sa.text("created_at DESC")])
    op.create_index("ix_orders_pending", "orders", ["expires_at"], postgresql_where=sa.text("status = 'pending'"))
    op.create_index("ix_orders_paid_at", "orders", ["paid_at"], postgresql_where=sa.text("paid_at IS NOT NULL"))
    op.create_index("ix_orders_beneficiary", "orders", ["beneficiary_id"])
    op.create_foreign_key("fk_stars_subscriptions_first_order", "stars_subscriptions", "orders",
                          ["first_order_id"], ["order_id"])

    op.create_table(
        "provider_transactions",
        sa.Column("txn_id", UID, primary_key=True),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False, unique=True),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("provider_txn_id", sa.Text(), nullable=False),
        sa.Column("order_id", UID, sa.ForeignKey("orders.order_id", name="fk_txn_order"), nullable=False),
        sa.Column("amount_tiyin", sa.BigInteger()),
        sa.Column("amount_stars", sa.Integer()),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("cancel_reason", sa.Text()),
        sa.Column("provider_reason", sa.SmallInteger()),
        sa.Column("provider_time", TS),
        sa.Column("provider_meta", pg.JSONB(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("created_at", TS, nullable=False, server_default=NOW),
        sa.Column("performed_at", TS),
        sa.Column("cancelled_at", TS),
        sa.CheckConstraint(f"provider {PROVIDERS}", name="ck_txn_provider"),
        sa.CheckConstraint("char_length(provider_txn_id) BETWEEN 1 AND 128", name="ck_txn_provider_txn_id"),
        sa.CheckConstraint("amount_tiyin > 0", name="ck_txn_amount_tiyin"),
        sa.CheckConstraint("amount_stars > 0", name="ck_txn_amount_stars"),
        sa.CheckConstraint("state IN ('created','performed','cancelled','refunded')", name="ck_txn_state"),
        sa.CheckConstraint("cancel_reason IN ('receivers_not_found','debit_error','execution_error','timeout',"
                           "'refund','unknown','provider_error','order_closed')", name="ck_txn_cancel_reason"),
        sa.CheckConstraint("(amount_tiyin IS NULL) <> (amount_stars IS NULL)", name="ck_txn_one_amount"),
        sa.CheckConstraint("(provider = 'telegram_stars') = (amount_stars IS NOT NULL)", name="ck_txn_stars_amount"),
        sa.CheckConstraint("(state IN ('performed','refunded')) = (performed_at IS NOT NULL)",
                           name="ck_txn_performed"),
        sa.CheckConstraint("(state IN ('cancelled','refunded')) = (cancelled_at IS NOT NULL)",
                           name="ck_txn_cancelled"),
        sa.UniqueConstraint("provider", "provider_txn_id", name="uq_txn_provider_id"),
    )
    op.create_index("uq_txn_order_performed", "provider_transactions", ["order_id"], unique=True,
                    postgresql_where=sa.text("state = 'performed'"))
    op.create_index("ix_txn_created", "provider_transactions", ["created_at"],
                    postgresql_where=sa.text("state = 'created'"))
    op.create_index("ix_txn_order", "provider_transactions", ["order_id"])
    op.create_index("ix_txn_provider_time", "provider_transactions", ["provider", "provider_time"])

    op.create_table(
        "stars_pre_checkouts",
        sa.Column("query_id", sa.Text(), primary_key=True),
        sa.Column("order_id", UID),
        sa.Column("ok", sa.Boolean(), nullable=False),
        sa.Column("error_code", sa.Text()),
        sa.Column("answered_at", TS, nullable=False, server_default=NOW),
        sa.CheckConstraint("char_length(query_id) <= 128", name="ck_stars_pre_checkouts_query"),
    )
    op.create_index("ix_stars_pre_checkouts_answered", "stars_pre_checkouts", ["answered_at"])

    op.create_table(
        "fiscal_receipts",
        sa.Column("receipt_id", UID, primary_key=True),
        sa.Column("txn_id", UID, sa.ForeignKey("provider_transactions.txn_id", name="fk_fiscal_receipts_txn"),
                  nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("provider_receipt_id", sa.Text()),
        sa.Column("fiscal_receipt_id", sa.Text()),
        sa.Column("terminal_id", sa.Text()),
        sa.Column("fiscal_sign", sa.Text()),
        sa.Column("qr_code_url", sa.Text()),
        sa.Column("status_code", sa.Integer()),
        sa.Column("message", sa.Text()),
        sa.Column("registered_at", TS),
        sa.Column("attempts", sa.SmallInteger(), nullable=False, server_default=ZERO),
        sa.Column("next_attempt_at", TS),
        sa.Column("created_at", TS, nullable=False, server_default=NOW),
        sa.Column("updated_at", TS, nullable=False, server_default=NOW),
        sa.CheckConstraint("kind IN ('sale','refund')", name="ck_fiscal_receipts_kind"),
        sa.CheckConstraint("source IN ('payme_set_fiscal_data','click_ofd','uzum')", name="ck_fiscal_receipts_source"),
        sa.CheckConstraint("status IN ('pending','registered','failed')", name="ck_fiscal_receipts_status"),
        sa.CheckConstraint("qr_code_url IS NULL OR qr_code_url ~ '^https://'", name="ck_fiscal_receipts_qr"),
        sa.CheckConstraint("char_length(message) <= 500", name="ck_fiscal_receipts_message"),
        sa.UniqueConstraint("txn_id", "kind", name="uq_fiscal_receipts_txn_kind"),
    )
    op.create_index("ix_fiscal_receipts_retry", "fiscal_receipts", ["next_attempt_at"],
                    postgresql_where=sa.text("status = 'pending'"))

    op.create_table(
        "refunds",
        sa.Column("refund_id", UID, primary_key=True),
        sa.Column("order_id", UID, sa.ForeignKey("orders.order_id", name="fk_refunds_order"), nullable=False),
        sa.Column("txn_id", UID, sa.ForeignKey("provider_transactions.txn_id", name="fk_refunds_txn"),
                  nullable=False),
        sa.Column("amount_tiyin", sa.BigInteger()),
        sa.Column("amount_stars", sa.Integer()),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("initiated_by", sa.Text(), nullable=False),
        sa.Column("method", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text()),
        sa.Column("requested_by", sa.Text()),
        sa.Column("requested_by_name", sa.Text()),
        sa.Column("requested_at", TS, nullable=False, server_default=NOW),
        sa.Column("completed_at", TS),
        sa.Column("failure_code", sa.Text()),
        sa.Column("tils_check", pg.JSONB()),
        sa.Column("idempotency_key", sa.Text()),
        sa.CheckConstraint("amount_tiyin > 0", name="ck_refunds_amount_tiyin"),
        sa.CheckConstraint("amount_stars > 0", name="ck_refunds_amount_stars"),
        sa.CheckConstraint("status IN ('awaiting_provider','completed','failed')", name="ck_refunds_status"),
        sa.CheckConstraint("initiated_by IN ('staff','provider')", name="ck_refunds_initiated_by"),
        sa.CheckConstraint("method IN ('provider_api','provider_cabinet')", name="ck_refunds_method"),
        sa.CheckConstraint("char_length(reason) BETWEEN 10 AND 500", name="ck_refunds_reason"),
        sa.CheckConstraint("(amount_tiyin IS NULL) <> (amount_stars IS NULL)", name="ck_refunds_one_amount"),
        sa.CheckConstraint("(initiated_by = 'staff') = (requested_by IS NOT NULL AND reason IS NOT NULL)",
                           name="ck_refunds_staff"),
    )
    op.create_index("uq_refund_order_live", "refunds", ["order_id"], unique=True,
                    postgresql_where=sa.text("status IN ('awaiting_provider','completed')"))
    op.create_index("ix_refunds_status", "refunds", ["status", "requested_at"])

    op.create_table(
        "periods",
        sa.Column("period_id", UID, primary_key=True),
        sa.Column("account_id", UID, nullable=False),
        sa.Column("product_code", sa.Text(), nullable=False),
        sa.Column("catalog_version", sa.Integer(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("order_id", UID, sa.ForeignKey("orders.order_id", name="fk_periods_order"), unique=True),
        sa.Column("adjustment_id", UID, unique=True),
        sa.Column("stars_subscription_id", UID,
                  sa.ForeignKey("stars_subscriptions.subscription_id", name="fk_periods_stars_subscription")),
        sa.Column("features", pg.ARRAY(sa.Text()), nullable=False),
        sa.Column("minutes_granted", sa.Integer(), nullable=False),
        sa.Column("days", sa.SmallInteger(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("starts_at", TS),
        sa.Column("ends_at", TS),
        sa.Column("created_at", TS, nullable=False, server_default=NOW),
        sa.Column("closed_at", TS),
        sa.Column("close_reason", sa.Text()),
        sa.CheckConstraint("source IN ('order','trial','grant')", name="ck_periods_source"),
        sa.CheckConstraint("features <@ ARRAY['ai_lessons','pair_lessons']::text[]", name="ck_periods_features"),
        sa.CheckConstraint("minutes_granted BETWEEN 1 AND 100000", name="ck_periods_minutes"),
        sa.CheckConstraint("days BETWEEN 1 AND 366", name="ck_periods_days"),
        sa.CheckConstraint("status IN ('scheduled','active','ended','superseded','revoked')",
                           name="ck_periods_status"),
        sa.CheckConstraint("close_reason IN ('ended','superseded','refund','staff','deletion')",
                           name="ck_periods_close_reason"),
        sa.CheckConstraint("(status = 'scheduled') = (starts_at IS NULL)", name="ck_periods_scheduled"),
        sa.CheckConstraint("starts_at IS NULL OR ends_at > starts_at", name="ck_periods_range"),
        sa.CheckConstraint("(source = 'order') = (order_id IS NOT NULL)", name="ck_periods_order"),
        sa.CheckConstraint("(source = 'grant') = (adjustment_id IS NOT NULL)", name="ck_periods_grant"),
    )
    op.create_index("uq_period_active", "periods", ["account_id"], unique=True,
                    postgresql_where=sa.text("status = 'active'"))
    op.create_index("uq_period_trial", "periods", ["account_id"], unique=True,
                    postgresql_where=sa.text("source = 'trial'"))
    op.create_index("ix_period_ends", "periods", ["ends_at"], postgresql_where=sa.text("status = 'active'"))
    op.create_index("ix_periods_account", "periods", ["account_id", "created_at"])

    op.create_table(
        "period_balances",
        sa.Column("period_id", UID, sa.ForeignKey("periods.period_id", name="fk_period_balances_period"),
                  primary_key=True),
        sa.Column("account_id", UID, nullable=False),
        sa.Column("granted", sa.Integer(), nullable=False, server_default=ZERO),
        sa.Column("spent", sa.Integer(), nullable=False, server_default=ZERO),
        sa.Column("removed", sa.Integer(), nullable=False, server_default=ZERO),
        sa.Column("held", sa.Integer(), nullable=False, server_default=ZERO),
        sa.Column("overage", sa.Integer(), nullable=False, server_default=ZERO),
        sa.Column("low_notified", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("updated_at", TS, nullable=False, server_default=NOW),
        sa.CheckConstraint("granted - spent - removed >= 0", name="ck_period_balances_nonneg"),
        sa.CheckConstraint("held >= 0 AND held <= granted - spent - removed", name="ck_period_balances_held"),
        sa.CheckConstraint("overage >= 0", name="ck_period_balances_overage"),
    )

    op.create_table(
        "minute_ledger",
        sa.Column("entry_id", UID, primary_key=True),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False, unique=True),
        sa.Column("account_id", UID, nullable=False),
        sa.Column("period_id", UID, sa.ForeignKey("periods.period_id", name="fk_minute_ledger_period"),
                  nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("minutes", sa.Integer(), nullable=False),
        sa.Column("overage", sa.Integer(), nullable=False, server_default=ZERO),
        sa.Column("learner_id", UID),
        sa.Column("ref_kind", sa.Text(), nullable=False),
        sa.Column("ref_id", sa.Text(), nullable=False),
        sa.Column("actor", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False, unique=True),
        sa.Column("created_at", TS, nullable=False, server_default=NOW),
        sa.CheckConstraint("kind IN ('grant','debit','expire','revoke','adjust')", name="ck_minute_ledger_kind"),
        sa.CheckConstraint("minutes <> 0 AND minutes BETWEEN -100000 AND 100000", name="ck_minute_ledger_minutes"),
        sa.CheckConstraint("overage >= 0", name="ck_minute_ledger_overage"),
        sa.CheckConstraint("ref_kind IN ('order','trial','grant','session','room','period','hold','refund',"
                           "'adjustment','deletion')", name="ck_minute_ledger_ref_kind"),
        sa.CheckConstraint("char_length(ref_id) <= 64", name="ck_minute_ledger_ref_id"),
        sa.CheckConstraint("actor IN ('system','learner') OR actor LIKE 'staff:%'", name="ck_minute_ledger_actor"),
        sa.CheckConstraint("CASE kind WHEN 'grant' THEN minutes > 0 WHEN 'adjust' THEN true ELSE minutes < 0 END",
                           name="ck_minute_ledger_sign"),
    )
    op.create_index("ix_ledger_account", "minute_ledger", ["account_id", sa.text("seq DESC")])
    op.create_index("ix_ledger_period", "minute_ledger", ["period_id"])
    op.create_index("ix_ledger_created", "minute_ledger", ["created_at"])

    op.create_table(
        "minute_holds",
        sa.Column("hold_id", UID, primary_key=True),
        sa.Column("account_id", UID, nullable=False),
        sa.Column("period_id", UID, sa.ForeignKey("periods.period_id", name="fk_minute_holds_period"),
                  nullable=False),
        sa.Column("learner_id", UID),
        sa.Column("feature", sa.Text(), nullable=False),
        sa.Column("ref_kind", sa.Text(), nullable=False),
        sa.Column("ref_id", UID, nullable=False),
        sa.Column("minutes", sa.SmallInteger(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("settled_minutes", sa.SmallInteger()),
        sa.Column("overage", sa.SmallInteger()),
        sa.Column("created_at", TS, nullable=False, server_default=NOW),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("settled_at", TS),
        sa.CheckConstraint("feature IN ('ai_lessons','pair_lessons')", name="ck_minute_holds_feature"),
        sa.CheckConstraint("ref_kind IN ('session','room')", name="ck_minute_holds_ref_kind"),
        sa.CheckConstraint("minutes BETWEEN 1 AND 120", name="ck_minute_holds_minutes"),
        sa.CheckConstraint("status IN ('active','settled','expired')", name="ck_minute_holds_status"),
        sa.CheckConstraint("settled_minutes >= 0", name="ck_minute_holds_settled"),
        sa.CheckConstraint("overage >= 0", name="ck_minute_holds_overage"),
        sa.CheckConstraint("(status = 'active') = (settled_at IS NULL)", name="ck_minute_holds_active"),
        sa.UniqueConstraint("ref_kind", "ref_id", name="uq_minute_holds_ref"),
    )
    op.create_index("ix_holds_active", "minute_holds", ["expires_at"], postgresql_where=sa.text("status = 'active'"))
    op.create_index("ix_holds_account", "minute_holds", ["account_id", "status"])

    op.create_table(
        "adjustments",
        sa.Column("adjustment_id", UID, primary_key=True),
        sa.Column("account_id", UID, nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("minutes", sa.Integer()),
        sa.Column("days", sa.SmallInteger()),
        sa.Column("period_id", UID),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("requested_by", sa.Text(), nullable=False),
        sa.Column("requested_by_name", sa.Text()),
        sa.Column("requested_at", TS, nullable=False, server_default=NOW),
        sa.Column("decided_by", sa.Text()),
        sa.Column("decided_by_name", sa.Text()),
        sa.Column("decided_at", TS),
        sa.Column("decision_note", sa.Text()),
        sa.Column("before_value", pg.JSONB()),
        sa.Column("after_value", pg.JSONB()),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.CheckConstraint("kind IN ('minutes','grant_period','revoke_period')", name="ck_adjustments_kind"),
        sa.CheckConstraint("minutes <> 0 AND minutes BETWEEN -10000 AND 10000", name="ck_adjustments_minutes"),
        sa.CheckConstraint("days BETWEEN 1 AND 90", name="ck_adjustments_days"),
        sa.CheckConstraint("char_length(reason) BETWEEN 10 AND 500", name="ck_adjustments_reason"),
        sa.CheckConstraint("status IN ('pending','applied','rejected','expired','cancelled')",
                           name="ck_adjustments_status"),
        sa.CheckConstraint("char_length(decision_note) <= 500", name="ck_adjustments_note"),
        sa.CheckConstraint("decided_by IS NULL OR decided_by <> requested_by", name="ck_adjustments_four_eyes"),
        sa.CheckConstraint("kind <> 'minutes' OR (minutes IS NOT NULL AND period_id IS NOT NULL AND days IS NULL)",
                           name="ck_adjustments_minutes_kind"),
        sa.CheckConstraint("kind <> 'grant_period' OR (minutes > 0 AND days IS NOT NULL AND period_id IS NULL)",
                           name="ck_adjustments_grant_kind"),
        sa.CheckConstraint("kind <> 'revoke_period' OR (period_id IS NOT NULL AND minutes IS NULL AND days IS NULL)",
                           name="ck_adjustments_revoke_kind"),
        sa.UniqueConstraint("requested_by", "idempotency_key", name="uq_adjustments_idempotency"),
    )
    op.create_index("ix_adjustments_pending", "adjustments", ["requested_at"],
                    postgresql_where=sa.text("status = 'pending'"))
    op.create_index("ix_adjustments_account", "adjustments", ["account_id", "requested_at"])

    op.create_table(
        "reconciliation_runs",
        sa.Column("run_id", UID, primary_key=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("started_at", TS, nullable=False, server_default=NOW),
        sa.Column("finished_at", TS),
        sa.Column("checked", sa.Integer(), nullable=False, server_default=ZERO),
        sa.Column("found", sa.Integer(), nullable=False, server_default=ZERO),
        sa.Column("error", sa.Text()),
        sa.CheckConstraint("kind IN ('tick','daily','manual')", name="ck_reconciliation_runs_kind"),
    )
    op.create_table(
        "reconciliation_items",
        sa.Column("item_id", UID, primary_key=True),
        sa.Column("run_id", UID, sa.ForeignKey("reconciliation_runs.run_id", name="fk_reconciliation_items_run")),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text()),
        sa.Column("order_id", UID),
        sa.Column("txn_id", UID),
        sa.Column("period_id", UID),
        sa.Column("details", pg.JSONB(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("dedup_key", sa.Text(), nullable=False, unique=True),
        sa.Column("created_at", TS, nullable=False, server_default=NOW),
        sa.Column("resolved_by", sa.Text()),
        sa.Column("resolved_by_name", sa.Text()),
        sa.Column("resolved_at", TS),
        sa.Column("note", sa.Text()),
        sa.CheckConstraint("kind IN ('paid_not_fulfilled','stale_created','provider_mismatch','duplicate_payment',"
                           "'refund_without_request','refund_stuck','fiscal_missing','tils_spent_on_refund',"
                           "'paid_after_deletion','payer_mismatch','stars_unmatched','stars_subscription_desync',"
                           "'hold_expired','balance_drift','unmatched_settlement')",
                           name="ck_reconciliation_items_kind"),
        sa.CheckConstraint("status IN ('open','resolved','ignored')", name="ck_reconciliation_items_status"),
        sa.CheckConstraint("note IS NULL OR char_length(note) BETWEEN 10 AND 500",
                           name="ck_reconciliation_items_note"),
    )
    op.create_index("ix_recon_items_status", "reconciliation_items", ["status", "created_at"])

    op.create_table(
        "provider_calls",
        sa.Column("call_id", sa.BigInteger(), sa.Identity(always=True), primary_key=True),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("direction", sa.Text(), nullable=False),
        sa.Column("method", sa.Text(), nullable=False),
        sa.Column("provider_txn_id", sa.Text()),
        sa.Column("order_no", sa.BigInteger()),
        sa.Column("result_code", sa.Text(), nullable=False),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
        sa.Column("client_ip", pg.INET()),
        sa.Column("created_at", TS, nullable=False, server_default=NOW),
        sa.CheckConstraint("direction IN ('in','out')", name="ck_provider_calls_direction"),
        sa.CheckConstraint("char_length(method) <= 40", name="ck_provider_calls_method"),
        sa.CheckConstraint("latency_ms >= 0", name="ck_provider_calls_latency"),
    )
    op.create_index("ix_provider_calls_created", "provider_calls", ["created_at"])
    op.create_index("ix_provider_calls_provider", "provider_calls", ["provider", "direction", "created_at"])
    op.create_index("ix_provider_calls_order", "provider_calls", ["order_no"])

    op.create_table(
        "fx_rates",
        sa.Column("valid_from", sa.Date(), primary_key=True),
        sa.Column("usd_in_tiyin", sa.BigInteger(), nullable=False),
        sa.Column("set_by", sa.Text(), nullable=False),
        sa.Column("set_by_name", sa.Text()),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=NOW),
        sa.CheckConstraint("usd_in_tiyin BETWEEN 100000 AND 100000000", name="ck_fx_rates_usd"),
        sa.CheckConstraint("char_length(reason) BETWEEN 10 AND 500", name="ck_fx_rates_reason"),
    )
    op.create_table(
        "star_rates",
        sa.Column("valid_from", sa.Date(), primary_key=True),
        sa.Column("star_in_tiyin", sa.Integer(), nullable=False),
        sa.Column("set_by", sa.Text(), nullable=False),
        sa.Column("set_by_name", sa.Text()),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=NOW),
        sa.CheckConstraint("star_in_tiyin BETWEEN 1 AND 10000000", name="ck_star_rates_star"),
        sa.CheckConstraint("char_length(reason) BETWEEN 10 AND 500", name="ck_star_rates_reason"),
    )

    op.create_table(
        "idempotency",
        sa.Column("scope", sa.Text(), primary_key=True),
        sa.Column("actor", sa.Text(), primary_key=True),
        sa.Column("key", sa.Text(), primary_key=True),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column("status_code", sa.SmallInteger(), nullable=False),
        sa.Column("response", pg.JSONB(), nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=NOW),
    )
    op.create_index("ix_idempotency_created", "idempotency", ["created_at"])
    op.create_table(
        "deleted_users",
        sa.Column("user_id", UID, primary_key=True),
        sa.Column("request_id", UID, nullable=False),
        sa.Column("deleted_at", TS, nullable=False),
    )
    op.create_table(
        "tick_state",
        sa.Column("name", sa.Text(), primary_key=True),
        sa.Column("last_run_at", TS, nullable=False),
    )
    op.create_table(
        "projection_loads",
        sa.Column("name", sa.Text(), primary_key=True),
        sa.Column("cursor", sa.Text()),
        sa.Column("items", sa.Integer(), nullable=False, server_default=ZERO),
        sa.Column("attempted_at", TS),
        sa.Column("completed_at", TS),
        sa.Column("error", sa.Text()),
        sa.CheckConstraint("name IN ('profiles')", name="ck_projection_loads_name"),
    )

    _triggers()
    _seed()
    create_messaging_tables(op)


DENY = "USING ERRCODE = 'insufficient_privilege'"
SAGA = "coalesce(current_setting('tilhero.deletion', true), '') = 'on'"


def _triggers() -> None:
    op.execute(f"""
        CREATE OR REPLACE FUNCTION billing_catalog_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'INSERT' THEN
            IF NEW.status = 'draft' OR (NEW.status = 'active' AND NEW.validated_hash = NEW.payload_hash
                                        AND NEW.activated_at IS NOT NULL) THEN
              RETURN NEW;
            END IF;
            RAISE EXCEPTION 'catalog_versions: insert only a draft or a validated active version' {DENY};
          END IF;
          IF TG_OP = 'DELETE' THEN
            IF OLD.status = 'draft' THEN RETURN OLD; END IF;
            RAISE EXCEPTION 'catalog_versions: only a draft can be deleted' {DENY};
          END IF;
          IF NEW.version IS DISTINCT FROM OLD.version THEN
            RAISE EXCEPTION 'catalog_versions: version is immutable' {DENY};
          END IF;
          IF OLD.status = 'draft' THEN
            IF NEW.status = 'draft' THEN RETURN NEW; END IF;
            IF NEW.status = 'active' AND NEW.validated_hash = NEW.payload_hash AND NEW.activated_at IS NOT NULL
               AND NEW.payload_hash = OLD.payload_hash THEN
              RETURN NEW;
            END IF;
            RAISE EXCEPTION 'catalog_versions: draft becomes active only after validation' {DENY};
          END IF;
          IF OLD.status = 'active' AND NEW.status = 'archived'
             AND ROW(NEW.payload, NEW.payload_hash, NEW.validated_hash, NEW.comment, NEW.created_by,
                     NEW.created_by_name, NEW.created_at, NEW.updated_at, NEW.activated_by, NEW.activated_by_name,
                     NEW.activated_at)
                 IS NOT DISTINCT FROM
                 ROW(OLD.payload, OLD.payload_hash, OLD.validated_hash, OLD.comment, OLD.created_by,
                     OLD.created_by_name, OLD.created_at, OLD.updated_at, OLD.activated_by, OLD.activated_by_name,
                     OLD.activated_at) THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'catalog_versions: active and archived versions are immutable' {DENY};
        END;
        $$ LANGUAGE plpgsql;
    """)
    op.execute("CREATE TRIGGER catalog_guard BEFORE INSERT OR UPDATE OR DELETE ON catalog_versions "
               "FOR EACH ROW EXECUTE FUNCTION billing_catalog_guard()")

    op.execute(f"""
        CREATE OR REPLACE FUNCTION billing_txn_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'INSERT' THEN
            IF (NEW.state = 'created' AND NEW.provider <> 'telegram_stars')
               OR (NEW.state = 'performed' AND NEW.provider = 'telegram_stars') THEN
              RETURN NEW;
            END IF;
            RAISE EXCEPTION 'provider_transactions: [*] -> created (Stars: [*] -> performed) only' {DENY};
          END IF;
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'provider_transactions: delete is not allowed' {DENY};
          END IF;
          IF ROW(NEW.txn_id, NEW.seq, NEW.provider, NEW.provider_txn_id, NEW.order_id, NEW.amount_tiyin,
                 NEW.amount_stars, NEW.provider_time, NEW.created_at)
             IS DISTINCT FROM
             ROW(OLD.txn_id, OLD.seq, OLD.provider, OLD.provider_txn_id, OLD.order_id, OLD.amount_tiyin,
                 OLD.amount_stars, OLD.provider_time, OLD.created_at) THEN
            RAISE EXCEPTION 'provider_transactions: identity and amounts are immutable' {DENY};
          END IF;
          IF NEW.state = OLD.state AND OLD.state IN ('created', 'performed') THEN
            RETURN NEW;
          END IF;
          IF (OLD.state = 'created' AND NEW.state IN ('performed', 'cancelled'))
             OR (OLD.state = 'performed' AND NEW.state = 'refunded') THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'provider_transactions: transition % -> % is not allowed', OLD.state, NEW.state {DENY};
        END;
        $$ LANGUAGE plpgsql;
    """)
    op.execute("CREATE TRIGGER txn_guard BEFORE INSERT OR UPDATE OR DELETE ON provider_transactions "
               "FOR EACH ROW EXECUTE FUNCTION billing_txn_guard()")

    op.execute(f"""
        CREATE OR REPLACE FUNCTION billing_orders_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'INSERT' THEN
            IF NEW.status = 'pending' OR (NEW.channel = 'renewal' AND NEW.status IN ('fulfilled', 'paid')) THEN
              RETURN NEW;
            END IF;
            RAISE EXCEPTION 'orders: insert only pending (Stars renewal: paid or fulfilled)' {DENY};
          END IF;
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'orders: delete is not allowed (anonymize in the deletion saga)' {DENY};
          END IF;
          IF ROW(NEW.order_id, NEW.order_no, NEW.channel, NEW.product_code, NEW.product_kind, NEW.catalog_version,
                 NEW.product_snapshot, NEW.provider, NEW.currency, NEW.amount_tiyin, NEW.amount_stars, NEW.stars_mode,
                 NEW.stars_subscription_id, NEW.start_mode, NEW.offer_version, NEW.locale, NEW.idempotency_key,
                 NEW.expires_at, NEW.created_at)
             IS DISTINCT FROM
             ROW(OLD.order_id, OLD.order_no, OLD.channel, OLD.product_code, OLD.product_kind, OLD.catalog_version,
                 OLD.product_snapshot, OLD.provider, OLD.currency, OLD.amount_tiyin, OLD.amount_stars, OLD.stars_mode,
                 OLD.stars_subscription_id, OLD.start_mode, OLD.offer_version, OLD.locale, OLD.idempotency_key,
                 OLD.expires_at, OLD.created_at) THEN
            RAISE EXCEPTION 'orders: snapshot, money and channel are immutable' {DENY};
          END IF;
          IF (NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.beneficiary_id IS DISTINCT FROM OLD.beneficiary_id)
             AND NOT ({SAGA}
                      AND (NEW.account_id IS NULL OR NEW.account_id = OLD.account_id)
                      AND (NEW.beneficiary_id IS NULL OR NEW.beneficiary_id = OLD.beneficiary_id)) THEN
            RAISE EXCEPTION 'orders: payer and beneficiary change only to NULL in the deletion saga' {DENY};
          END IF;
          IF NEW.status = OLD.status
             OR (OLD.status = 'pending' AND NEW.status IN ('paid', 'fulfilled', 'expired', 'cancelled'))
             OR (OLD.status = 'paid' AND NEW.status IN ('fulfilled', 'refunded'))
             OR (OLD.status = 'fulfilled' AND NEW.status = 'refunded')
             OR (OLD.status = 'expired' AND NEW.status IN ('paid', 'fulfilled')) THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'orders: transition % -> % is not allowed', OLD.status, NEW.status {DENY};
        END;
        $$ LANGUAGE plpgsql;
    """)
    op.execute("CREATE TRIGGER orders_guard BEFORE INSERT OR UPDATE OR DELETE ON orders "
               "FOR EACH ROW EXECUTE FUNCTION billing_orders_guard()")

    op.execute(f"""
        CREATE OR REPLACE FUNCTION billing_periods_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF {SAGA} THEN RETURN OLD; END IF;
            RAISE EXCEPTION 'periods: delete only in the deletion saga' {DENY};
          END IF;
          IF ROW(NEW.period_id, NEW.account_id, NEW.product_code, NEW.catalog_version, NEW.source, NEW.order_id,
                 NEW.adjustment_id, NEW.stars_subscription_id, NEW.features, NEW.minutes_granted, NEW.days,
                 NEW.created_at)
             IS DISTINCT FROM
             ROW(OLD.period_id, OLD.account_id, OLD.product_code, OLD.catalog_version, OLD.source, OLD.order_id,
                 OLD.adjustment_id, OLD.stars_subscription_id, OLD.features, OLD.minutes_granted, OLD.days,
                 OLD.created_at) THEN
            RAISE EXCEPTION 'periods: period snapshot is immutable' {DENY};
          END IF;
          IF OLD.status = 'scheduled' AND NEW.status IN ('scheduled', 'active', 'revoked') THEN
            RETURN NEW;
          END IF;
          IF OLD.status = 'active' AND NEW.status IN ('ended', 'superseded', 'revoked')
             AND NEW.starts_at = OLD.starts_at AND NEW.ends_at = OLD.ends_at THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'periods: transition % -> % is not allowed', OLD.status, NEW.status {DENY};
        END;
        $$ LANGUAGE plpgsql;
    """)
    op.execute("CREATE TRIGGER periods_guard BEFORE UPDATE OR DELETE ON periods "
               "FOR EACH ROW EXECUTE FUNCTION billing_periods_guard()")

    op.execute(f"""
        CREATE OR REPLACE FUNCTION billing_ledger_guard() RETURNS trigger AS $$
        BEGIN
          IF {SAGA} THEN
            IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
            IF NEW.learner_id IS NULL
               AND ROW(NEW.entry_id, NEW.seq, NEW.account_id, NEW.period_id, NEW.kind, NEW.minutes, NEW.overage,
                       NEW.ref_kind, NEW.ref_id, NEW.actor, NEW.idempotency_key, NEW.created_at)
                   IS NOT DISTINCT FROM
                   ROW(OLD.entry_id, OLD.seq, OLD.account_id, OLD.period_id, OLD.kind, OLD.minutes, OLD.overage,
                       OLD.ref_kind, OLD.ref_id, OLD.actor, OLD.idempotency_key, OLD.created_at) THEN
              RETURN NEW;
            END IF;
          END IF;
          RAISE EXCEPTION 'minute_ledger is append-only (deletion saga: DELETE or learner_id -> NULL)' {DENY};
        END;
        $$ LANGUAGE plpgsql;
    """)
    op.execute("CREATE TRIGGER ledger_guard BEFORE UPDATE OR DELETE ON minute_ledger "
               "FOR EACH ROW EXECUTE FUNCTION billing_ledger_guard()")


def _canonical_hash(payload: dict) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _seed() -> None:
    payload = json.loads(SEED.read_text(encoding="utf-8"))
    now = datetime.now(UTC)
    versions = sa.table("catalog_versions", sa.column("version"), sa.column("status"),
                        sa.column("payload", pg.JSONB()), sa.column("payload_hash"), sa.column("validated_hash"),
                        sa.column("comment"), sa.column("created_by"), sa.column("created_by_name"),
                        sa.column("created_at"), sa.column("updated_at"))
    op.get_bind().execute(versions.insert().values(
        version=1, status="draft", payload=payload, payload_hash=_canonical_hash(payload), validated_hash=None,
        comment="Каталог v1 (миграция): цены сайта В2 и В5, цены в Stars — О1, реквизиты — О4",
        created_by="system", created_by_name="Система", created_at=now, updated_at=now))


def downgrade() -> None:
    drop_messaging_tables(op)
    for trigger, table in (("ledger_guard", "minute_ledger"), ("periods_guard", "periods"),
                           ("orders_guard", "orders"), ("txn_guard", "provider_transactions"),
                           ("catalog_guard", "catalog_versions")):
        op.execute(f"DROP TRIGGER IF EXISTS {trigger} ON {table}")
    op.drop_constraint("fk_stars_subscriptions_first_order", "stars_subscriptions", type_="foreignkey")
    for table in ("projection_loads", "tick_state", "deleted_users", "idempotency", "star_rates", "fx_rates",
                  "provider_calls", "reconciliation_items", "reconciliation_runs", "adjustments", "minute_holds",
                  "minute_ledger", "period_balances", "periods", "refunds", "fiscal_receipts", "stars_pre_checkouts",
                  "provider_transactions", "orders", "stars_subscriptions", "catalog_versions", "learners"):
        op.drop_table(table)
    for fn in ("billing_ledger_guard", "billing_periods_guard", "billing_orders_guard", "billing_txn_guard",
               "billing_catalog_guard"):
        op.execute(f"DROP FUNCTION IF EXISTS {fn}()")
