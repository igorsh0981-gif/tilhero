"""gamification: ledger, wallets, learners, skill_states, referrals, ownership, purchases, quests, badges,
badge_templates, rules_versions, heroes, assets, shop_items, game_events, daily_stats, session_rewards,
evidence_rewards, idempotency, deleted_users, tick_state + outbox/inbox.

Неизменяемость (роль сервиса не может снять триггеры — только владелец схемы):
- ledger: UPDATE — только `confirmed → reversed` вместе с `reversed_by`; DELETE — только в саге удаления
  (`SET LOCAL tilhero.deletion = 'on'`);
- badges: UPDATE запрещён; DELETE — только в саге удаления;
- rules_versions: активная и архивные не меняются (допустим только перевод active → archived), удалить можно только
  черновик; одна draft и одна active — частичными UNIQUE;
- assets: UPDATE запрещён.

Сид (migrations/seed/game_seed.json + seed/heroes/*.webp): версия правил 1 (active), 9 героев по 3 ступени с
картинками (27 webp: sha256 и размеры читаются из заголовка своим кодом), заморозка и 6 предметов косметики
(published), шаблоны значков RU/UZ.

Revision ID: 0001
Revises:
Create Date: 2026-11-20
"""
import hashlib
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

from tilhero_common.migrations import create_messaging_tables, drop_messaging_tables
from tilhero_gamification.images import inspect_image

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
EMPTY = sa.text("'[]'::jsonb")
SEED_DIR = Path(__file__).resolve().parents[1] / "seed"
SYSTEM = "system"
AUDIENCES = ["kids", "teens", "adults"]
REASONS = ("'lesson','scenario','media','reading','review','skill_demonstrated','skill_retained','quest',"
           "'quest_bonus','registration_bonus','referral_bonus','streak_freeze','shop','manual','reversal','purchase'")
QUEST_KINDS = ("'lesson_complete','review_cards','reading_complete','scenario_complete','media_complete',"
               "'xp_earned','skill_confirmed','all_done'")
BADGE_METRICS = "'lessons','streak','skills','skill_retained','reviews_cards','readings','freeze'"


def upgrade() -> None:
    op.create_table(
        "ledger",
        sa.Column("op_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("currency", sa.String(6), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(24), nullable=False),
        sa.Column("source_kind", sa.String(8), nullable=False),
        sa.Column("source_ref", sa.String(200), nullable=False),
        sa.Column("source_session_id", pg.UUID(as_uuid=True)),
        sa.Column("rules_version", sa.Integer()),
        sa.Column("multiplier", sa.Numeric(4, 2), nullable=False, server_default=sa.text("1")),
        sa.Column("capped", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("local_date", sa.Date(), nullable=False),
        sa.Column("status", sa.String(10), nullable=False, server_default=sa.text("'confirmed'")),
        sa.Column("reversed_by", pg.UUID(as_uuid=True)),
        sa.Column("reversal_of", pg.UUID(as_uuid=True)),
        sa.Column("actor", sa.String(80), nullable=False),
        sa.Column("comment", sa.String(300)),
        sa.Column("idempotency_key", sa.String(200), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.CheckConstraint("currency IN ('xp','til','freeze')", name="ck_ledger_currency"),
        sa.CheckConstraint("amount <> 0", name="ck_ledger_amount"),
        sa.CheckConstraint(f"reason IN ({REASONS})", name="ck_ledger_reason"),
        sa.CheckConstraint("source_kind IN ('event','command','staff')", name="ck_ledger_source_kind"),
        sa.CheckConstraint("status IN ('confirmed','reversed')", name="ck_ledger_status"),
        sa.CheckConstraint("(status = 'reversed') = (reversed_by IS NOT NULL)", name="ck_ledger_reversed"),
        sa.CheckConstraint("(reason = 'reversal') = (reversal_of IS NOT NULL)", name="ck_ledger_reversal"),
        sa.CheckConstraint("actor IN ('system','learner') OR actor LIKE 'staff:%'", name="ck_ledger_actor"),
        sa.CheckConstraint("multiplier >= 1 AND multiplier <= 3", name="ck_ledger_multiplier"),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_ledger_idempotency"),
    )
    op.create_index("ix_ledger_user_created", "ledger", ["user_id", "created_at", "op_id"])
    op.create_index("ix_ledger_user_day", "ledger", ["user_id", "local_date", "currency"])
    op.create_index("ix_ledger_session", "ledger", ["user_id", "source_session_id"],
                    postgresql_where=sa.text("source_session_id IS NOT NULL"))
    op.create_index("uq_ledger_reversal_of", "ledger", ["reversal_of"], unique=True,
                    postgresql_where=sa.text("reversal_of IS NOT NULL"))

    op.create_table(
        "wallets",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("xp_total", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("til_balance", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("freeze_stock", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("level", sa.SmallInteger(), nullable=False, server_default=sa.text("1")),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint("xp_total >= 0", name="ck_wallets_xp"),
        sa.CheckConstraint("til_balance >= 0", name="ck_wallets_til"),
        sa.CheckConstraint("freeze_stock >= 0", name="ck_wallets_freeze"),
        sa.CheckConstraint("level BETWEEN 1 AND 100", name="ck_wallets_level"),
    )

    op.create_table(
        "learners",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("account_id", pg.UUID(as_uuid=True)),
        sa.Column("kind", sa.String(8), nullable=False, server_default=sa.text("'account'")),
        sa.Column("age_band", sa.String(8)),
        sa.Column("timezone", sa.String(64)),
        sa.Column("plan_updated_at", TS),
        sa.Column("hero_code", sa.String(16)),
        sa.Column("hero_stage", sa.SmallInteger(), nullable=False, server_default=sa.text("1")),
        sa.Column("confirmed_skills", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("auto_freeze", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("quests_hidden", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("celebrations", sa.String(5), nullable=False, server_default=sa.text("'full'")),
        sa.Column("game_notifications", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("settings_customized", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("background_code", sa.String(40)),
        sa.Column("frame_code", sa.String(40)),
        sa.Column("lessons_completed", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("reviews_cards", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("readings_completed", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("streak_best", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("freezes_used", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("skills_retained", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("registered_at", TS),
        sa.Column("registration_bonus_at", TS),
        sa.Column("last_session_id", pg.UUID(as_uuid=True)),
        sa.Column("last_session_at", TS),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint("kind IN ('account','child')", name="ck_learners_kind"),
        sa.CheckConstraint("age_band IS NULL OR age_band IN ('6-9','10-13','14-17','18+')",
                           name="ck_learners_age_band"),
        sa.CheckConstraint("hero_stage BETWEEN 1 AND 3", name="ck_learners_stage"),
        sa.CheckConstraint("celebrations IN ('full','quiet')", name="ck_learners_celebrations"),
        sa.CheckConstraint("confirmed_skills >= 0 AND lessons_completed >= 0 AND reviews_cards >= 0 "
                           "AND readings_completed >= 0 AND streak_best >= 0 AND freezes_used >= 0 "
                           "AND skills_retained >= 0", name="ck_learners_counters"),
    )
    op.create_index("ix_learners_hero", "learners", ["hero_code"], postgresql_where=sa.text("hero_code IS NOT NULL"))

    op.create_table(
        "skill_states",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("pair_id", sa.String(16), primary_key=True),
        sa.Column("skill_id", sa.String(200), primary_key=True),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("confirmed", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("changed_at", TS, nullable=False),
        sa.CheckConstraint("state IN ('not_started','learning','demonstrated','retained')",
                           name="ck_skill_states_state"),
    )

    op.create_table(
        "referrals",
        sa.Column("invitee_user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("inviter_user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("invite_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("status", sa.String(8), nullable=False),
        sa.Column("accepted_at", TS, nullable=False),
        sa.Column("rewarded_at", TS),
        sa.Column("op_id", pg.UUID(as_uuid=True)),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint("status IN ('pending','rewarded','capped','void')", name="ck_referrals_status"),
        sa.CheckConstraint("inviter_user_id <> invitee_user_id", name="ck_referrals_self"),
    )
    op.create_index("ix_referrals_inviter", "referrals", ["inviter_user_id", "status", "rewarded_at"])
    op.create_index("ix_referrals_pending", "referrals", ["accepted_at"],
                    postgresql_where=sa.text("status = 'pending'"))

    op.create_table(
        "ownership",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("item_code", sa.String(40), primary_key=True),
        sa.Column("purchase_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("price_til", sa.Integer(), nullable=False),
        sa.Column("purchased_at", TS, nullable=False),
    )
    op.create_index("ix_ownership_item", "ownership", ["item_code"])

    op.create_table(
        "purchases",
        sa.Column("purchase_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("item_code", sa.String(40), nullable=False),
        sa.Column("item_kind", sa.String(16), nullable=False),
        sa.Column("price_til", sa.Integer(), nullable=False),
        sa.Column("op_ids", pg.JSONB(), nullable=False),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("response", pg.JSONB(), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("refunded_at", TS),
        sa.CheckConstraint("status IN ('completed','refunded')", name="ck_purchases_status"),
        sa.CheckConstraint("price_til BETWEEN 1 AND 10000", name="ck_purchases_price"),
        sa.CheckConstraint("item_kind IN ('background','hero_frame','streak_freeze')", name="ck_purchases_kind"),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_purchases_idempotency"),
    )
    op.create_index("ix_purchases_user_created", "purchases", ["user_id", "created_at"])
    op.create_index("ix_purchases_item", "purchases", ["item_code", "status"])

    op.create_table(
        "quests",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("local_date", sa.Date(), primary_key=True),
        sa.Column("slot", sa.SmallInteger(), primary_key=True),
        sa.Column("template_code", sa.String(40), nullable=False),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("target", sa.Integer(), nullable=False),
        sa.Column("progress", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("reward_xp", sa.Integer(), nullable=False),
        sa.Column("reward_til", sa.Integer(), nullable=False),
        sa.Column("completed_at", TS),
        sa.Column("rules_version", sa.Integer(), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.CheckConstraint("slot BETWEEN 0 AND 3", name="ck_quests_slot"),
        sa.CheckConstraint(f"kind IN ({QUEST_KINDS})", name="ck_quests_kind"),
        sa.CheckConstraint("status IN ('active','completed','expired')", name="ck_quests_status"),
        sa.CheckConstraint("target >= 1 AND progress >= 0 AND reward_xp >= 0 AND reward_til >= 0",
                           name="ck_quests_numbers"),
        sa.CheckConstraint("(status = 'completed') = (completed_at IS NOT NULL)", name="ck_quests_completed"),
    )
    op.create_index("ix_quests_active", "quests", ["local_date"], postgresql_where=sa.text("status = 'active'"))

    op.create_table(
        "badges",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("badge_code", sa.String(40), primary_key=True),
        sa.Column("metric", sa.String(16), nullable=False),
        sa.Column("value", sa.Integer(), nullable=False),
        sa.Column("threshold", sa.Integer(), nullable=False),
        sa.Column("event_id", sa.String(64)),
        sa.Column("earned_at", TS, nullable=False),
        sa.CheckConstraint(f"metric IN ({BADGE_METRICS})", name="ck_badges_metric"),
    )
    op.create_index("ix_badges_earned", "badges", ["earned_at"])

    op.create_table(
        "badge_templates",
        sa.Column("code", sa.String(40), primary_key=True),
        sa.Column("metric", sa.String(16), nullable=False),
        sa.Column("title", pg.JSONB(), nullable=False),
        sa.Column("description", pg.JSONB(), nullable=False),
        sa.Column("unit", pg.JSONB()),
        sa.Column("asset_id", pg.UUID(as_uuid=True)),
        sa.Column("order", sa.SmallInteger(), nullable=False),
        sa.CheckConstraint(f"metric IN ({BADGE_METRICS})", name="ck_badge_templates_metric"),
    )

    op.create_table(
        "rules_versions",
        sa.Column("version", sa.Integer(), primary_key=True, autoincrement=False),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("payload", pg.JSONB(), nullable=False),
        sa.Column("comment", sa.String(300)),
        sa.Column("based_on", sa.Integer()),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_by_name", sa.String(120)),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.Column("validated_at", TS),
        sa.Column("activated_by", sa.String(64)),
        sa.Column("activated_by_name", sa.String(120)),
        sa.Column("activated_at", TS),
        sa.CheckConstraint("status IN ('draft','active','archived')", name="ck_rules_versions_status"),
        sa.CheckConstraint("version >= 1", name="ck_rules_versions_version"),
        sa.CheckConstraint("status = 'draft' OR activated_at IS NOT NULL", name="ck_rules_versions_activated"),
    )
    op.create_index("uq_rules_versions_draft", "rules_versions", ["status"], unique=True,
                    postgresql_where=sa.text("status = 'draft'"))
    op.create_index("uq_rules_versions_active", "rules_versions", ["status"], unique=True,
                    postgresql_where=sa.text("status = 'active'"))

    op.create_table(
        "heroes",
        sa.Column("code", sa.String(16), primary_key=True),
        sa.Column("line", sa.String(8), nullable=False),
        sa.Column("order", sa.SmallInteger(), nullable=False),
        sa.Column("name", pg.JSONB(), nullable=False),
        sa.Column("tagline", pg.JSONB(), nullable=False),
        sa.Column("audiences", pg.JSONB(), nullable=False),
        sa.Column("stages", pg.JSONB(), nullable=False),
        sa.Column("draft", pg.JSONB()),
        sa.Column("draft_updated_at", TS),
        sa.Column("version", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("published_at", TS),
        sa.Column("published_by", sa.String(64)),
        sa.Column("published_by_name", sa.String(120)),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint("line IN ('robot','pet','human')", name="ck_heroes_line"),
        sa.CheckConstraint("code ~ '^(robot|pet|human)_[0-9]$'", name="ck_heroes_code"),
    )

    op.create_table(
        "assets",
        sa.Column("asset_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("mime", sa.String(10), nullable=False),
        sa.Column("bytes", sa.LargeBinary(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("purpose", sa.String(10), nullable=False),
        sa.Column("uploaded_by", sa.String(64)),
        sa.Column("created_at", TS, nullable=False),
        sa.CheckConstraint("mime IN ('image/webp','image/png')", name="ck_assets_mime"),
        sa.CheckConstraint("purpose IN ('hero_stage','shop_item','badge')", name="ck_assets_purpose"),
        sa.CheckConstraint("width BETWEEN 1 AND 4096 AND height BETWEEN 1 AND 4096 AND size >= 1",
                           name="ck_assets_dims"),
        sa.UniqueConstraint("sha256", "purpose", name="uq_assets_sha_purpose"),
    )

    op.create_table(
        "shop_items",
        sa.Column("code", sa.String(40), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("title", pg.JSONB(), nullable=False),
        sa.Column("description", pg.JSONB(), nullable=False),
        sa.Column("asset_id", pg.UUID(as_uuid=True)),
        sa.Column("theme", pg.JSONB()),
        sa.Column("price_til", sa.Integer(), nullable=False),
        sa.Column("audiences", pg.JSONB(), nullable=False),
        sa.Column("available_from", TS),
        sa.Column("available_until", TS),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("order", sa.SmallInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_by", sa.String(64)),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint("kind IN ('background','hero_frame','streak_freeze')", name="ck_shop_items_kind"),
        sa.CheckConstraint("status IN ('draft','published','retired')", name="ck_shop_items_status"),
        sa.CheckConstraint("price_til BETWEEN 1 AND 10000", name="ck_shop_items_price"),
        sa.CheckConstraint("(kind = 'streak_freeze') = (code = 'streak_freeze')", name="ck_shop_items_freeze"),
        sa.CheckConstraint("available_until IS NULL OR available_from IS NULL OR available_until > available_from",
                           name="ck_shop_items_window"),
        sa.CheckConstraint("code ~ '^[a-z0-9_]{3,40}$'", name="ck_shop_items_code"),
    )

    op.create_table(
        "game_events",
        sa.Column("event_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("code", sa.String(40), nullable=False),
        sa.Column("title", pg.JSONB(), nullable=False),
        sa.Column("description", pg.JSONB(), nullable=False),
        sa.Column("starts_at", TS, nullable=False),
        sa.Column("ends_at", TS, nullable=False),
        sa.Column("audiences", pg.JSONB(), nullable=False),
        sa.Column("multipliers", pg.JSONB(), nullable=False),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_by_name", sa.String(120)),
        sa.Column("published_by", sa.String(64)),
        sa.Column("published_by_name", sa.String(120)),
        sa.Column("published_at", TS),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint("status IN ('draft','published','cancelled','finished')", name="ck_game_events_status"),
        sa.CheckConstraint("ends_at > starts_at", name="ck_game_events_period"),
        sa.CheckConstraint("code ~ '^[a-z0-9_]{3,40}$'", name="ck_game_events_code"),
        sa.UniqueConstraint("code", name="uq_game_events_code"),
    )
    op.create_index("ix_game_events_status", "game_events", ["status", "starts_at"])

    op.create_table(
        "daily_stats",
        sa.Column("local_date", sa.Date(), primary_key=True),
        sa.Column("audience", sa.String(8), primary_key=True),
        sa.Column("metric", sa.String(24), primary_key=True),
        sa.Column("value", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        sa.CheckConstraint("audience IN ('kids','teens','adults')", name="ck_daily_stats_audience"),
    )

    op.create_table(
        "session_rewards",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("session_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("evaluation_id", pg.UUID(as_uuid=True)),
        sa.Column("op_ids", pg.JSONB(), nullable=False, server_default=EMPTY),
        sa.Column("level_from", sa.SmallInteger()),
        sa.Column("level_to", sa.SmallInteger()),
        sa.Column("stage_from", sa.SmallInteger()),
        sa.Column("stage_to", sa.SmallInteger()),
        sa.Column("badges", pg.JSONB(), nullable=False, server_default=EMPTY),
        sa.Column("quests", pg.JSONB(), nullable=False, server_default=EMPTY),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
    )
    op.create_index("ix_session_rewards_session", "session_rewards", ["session_id"])
    op.create_index("ix_session_rewards_evaluation", "session_rewards", ["user_id", "evaluation_id"],
                    postgresql_where=sa.text("evaluation_id IS NOT NULL"))

    op.create_table(
        "evidence_rewards",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("evidence_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("level_from", sa.SmallInteger()),
        sa.Column("level_to", sa.SmallInteger()),
        sa.Column("stage_from", sa.SmallInteger()),
        sa.Column("stage_to", sa.SmallInteger()),
        sa.Column("badges", pg.JSONB(), nullable=False, server_default=EMPTY),
        sa.Column("quests", pg.JSONB(), nullable=False, server_default=EMPTY),
        sa.Column("op_ids", pg.JSONB(), nullable=False, server_default=EMPTY),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
    )
    op.create_index("ix_evidence_rewards_created", "evidence_rewards", ["created_at"])

    op.create_table(
        "idempotency",
        sa.Column("scope", sa.String(48), primary_key=True),
        sa.Column("actor", sa.String(80), primary_key=True),
        sa.Column("key", sa.String(128), primary_key=True),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("status_code", sa.SmallInteger(), nullable=False),
        sa.Column("response", pg.JSONB(), nullable=False),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_index("ix_idempotency_created", "idempotency", ["created_at"])

    op.create_table(
        "deleted_users",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("request_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("deleted_at", TS, nullable=False),
    )

    op.create_table(
        "tick_state",
        sa.Column("name", sa.String(32), primary_key=True),
        sa.Column("last_run_at", TS, nullable=False),
    )

    _triggers()
    _seed()
    create_messaging_tables(op)


def _triggers() -> None:
    # Реестр: только добавление. UPDATE — лишь confirmed → reversed с reversed_by (остальные поля неизменны);
    # DELETE — только в саге удаления (SET LOCAL tilhero.deletion = 'on').
    op.execute(
        """
        CREATE OR REPLACE FUNCTION gamification_ledger_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF coalesce(current_setting('tilhero.deletion', true), '') = 'on' THEN
              RETURN OLD;
            END IF;
            RAISE EXCEPTION 'ledger is append-only (DELETE only in the deletion saga)'
              USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF OLD.status = 'confirmed' AND NEW.status = 'reversed' AND OLD.reversed_by IS NULL
             AND NEW.reversed_by IS NOT NULL
             AND ROW(NEW.op_id, NEW.user_id, NEW.currency, NEW.amount, NEW.reason, NEW.source_kind, NEW.source_ref,
                     NEW.source_session_id, NEW.rules_version, NEW.multiplier, NEW.capped, NEW.local_date,
                     NEW.reversal_of, NEW.actor, NEW.comment, NEW.idempotency_key, NEW.created_at)
                 IS NOT DISTINCT FROM
                 ROW(OLD.op_id, OLD.user_id, OLD.currency, OLD.amount, OLD.reason, OLD.source_kind, OLD.source_ref,
                     OLD.source_session_id, OLD.rules_version, OLD.multiplier, OLD.capped, OLD.local_date,
                     OLD.reversal_of, OLD.actor, OLD.comment, OLD.idempotency_key, OLD.created_at) THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'ledger is append-only (only confirmed -> reversed)'
            USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER ledger_guard BEFORE UPDATE OR DELETE ON ledger "
               "FOR EACH ROW EXECUTE FUNCTION gamification_ledger_guard()")
    # Значки: выданный значок неизменяем; DELETE — только в саге удаления
    op.execute(
        """
        CREATE OR REPLACE FUNCTION gamification_badges_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' AND coalesce(current_setting('tilhero.deletion', true), '') = 'on' THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'badges are immutable' USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER badges_guard BEFORE UPDATE OR DELETE ON badges "
               "FOR EACH ROW EXECUTE FUNCTION gamification_badges_guard()")
    # Правила: черновик правится и удаляется; активная — только перевод в archived (остальное неизменно);
    # архивная — неизменяема и не удаляется
    op.execute(
        """
        CREATE OR REPLACE FUNCTION gamification_rules_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF OLD.status = 'draft' THEN
              RETURN OLD;
            END IF;
            RAISE EXCEPTION 'rules_versions: only a draft can be deleted' USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF NEW.version IS DISTINCT FROM OLD.version THEN
            RAISE EXCEPTION 'rules_versions: version is immutable' USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF OLD.status = 'draft' THEN
            RETURN NEW;
          END IF;
          IF OLD.status = 'active' AND NEW.status = 'archived'
             AND ROW(NEW.payload, NEW.comment, NEW.based_on, NEW.created_by, NEW.created_by_name, NEW.created_at,
                     NEW.updated_at, NEW.validated_at, NEW.activated_by, NEW.activated_by_name, NEW.activated_at)
                 IS NOT DISTINCT FROM
                 ROW(OLD.payload, OLD.comment, OLD.based_on, OLD.created_by, OLD.created_by_name, OLD.created_at,
                     OLD.updated_at, OLD.validated_at, OLD.activated_by, OLD.activated_by_name, OLD.activated_at)
          THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'rules_versions: active and archived versions are immutable'
            USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER rules_versions_guard BEFORE UPDATE OR DELETE ON rules_versions "
               "FOR EACH ROW EXECUTE FUNCTION gamification_rules_guard()")
    # Картинки не изменяются (замена — новая картинка)
    op.execute(
        """
        CREATE OR REPLACE FUNCTION gamification_assets_guard() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'assets are immutable' USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER assets_guard BEFORE UPDATE ON assets "
               "FOR EACH ROW EXECUTE FUNCTION gamification_assets_guard()")


def _seed() -> None:
    seed = json.loads((SEED_DIR / "game_seed.json").read_text(encoding="utf-8"))
    now = datetime.now(UTC)
    bind = op.get_bind()
    rules = sa.table("rules_versions", sa.column("version"), sa.column("status"), sa.column("payload", pg.JSONB()),
                     sa.column("comment"), sa.column("based_on"), sa.column("created_by"),
                     sa.column("created_by_name"), sa.column("created_at"), sa.column("updated_at"),
                     sa.column("validated_at"), sa.column("activated_by"), sa.column("activated_by_name"),
                     sa.column("activated_at"))
    bind.execute(rules.insert().values(
        version=1, status="active", payload=seed["rules_v1"], comment="Начальные правила (сид миграции)",
        based_on=None, created_by=SYSTEM, created_by_name=None, created_at=now, updated_at=now, validated_at=now,
        activated_by=SYSTEM, activated_by_name=None, activated_at=now))

    assets = sa.table("assets", sa.column("asset_id"), sa.column("sha256"), sa.column("mime"),
                      sa.column("bytes", sa.LargeBinary()), sa.column("width"), sa.column("height"),
                      sa.column("size"), sa.column("purpose"), sa.column("uploaded_by"), sa.column("created_at"))
    heroes = sa.table("heroes", sa.column("code"), sa.column("line"), sa.column("order"),
                      sa.column("name", pg.JSONB()), sa.column("tagline", pg.JSONB()),
                      sa.column("audiences", pg.JSONB()), sa.column("stages", pg.JSONB()), sa.column("version"),
                      sa.column("published_at"), sa.column("published_by"), sa.column("updated_at"))
    for hero in seed["heroes"]:
        line, n = hero["code"].split("_")
        stages = []
        for stage in (1, 2, 3):
            data = (SEED_DIR / "heroes" / f"{line}_{n}_{stage}.webp").read_bytes()
            info = inspect_image(data, "image/webp")
            # детерминированный asset_id: повтор миграции на чистой схеме даёт те же ссылки
            asset_id = uuid.uuid5(uuid.NAMESPACE_URL, f"tilhero:gamification:asset:{info.sha256}:hero_stage")
            assert info.sha256 == hashlib.sha256(data).hexdigest()
            bind.execute(assets.insert().values(
                asset_id=asset_id, sha256=info.sha256, mime=info.mime, bytes=data, width=info.width,
                height=info.height, size=info.size, purpose="hero_stage", uploaded_by=SYSTEM, created_at=now))
            stages.append({"stage": stage, "name": seed["stage_names"][line][stage - 1], "asset_id": str(asset_id)})
        bind.execute(heroes.insert().values(
            code=hero["code"], line=line, order=hero["order"], name=hero["name"], tagline=hero["tagline"],
            audiences=list(AUDIENCES), stages=stages, version=1, published_at=now, published_by=SYSTEM,
            updated_at=now))

    items = sa.table("shop_items", sa.column("code"), sa.column("kind"), sa.column("title", pg.JSONB()),
                     sa.column("description", pg.JSONB()), sa.column("asset_id"), sa.column("theme", pg.JSONB()),
                     sa.column("price_til"), sa.column("audiences", pg.JSONB()), sa.column("status"),
                     sa.column("order"), sa.column("created_by"), sa.column("created_at"), sa.column("updated_at"))
    for item in seed["shop_items"]:
        bind.execute(items.insert().values(
            code=item["code"], kind=item["kind"], title=item["title"], description=item["description"],
            asset_id=None, theme=item["theme"], price_til=item["price_til"], audiences=list(AUDIENCES),
            status="published", order=item["order"], created_by=SYSTEM, created_at=now, updated_at=now))

    templates = sa.table("badge_templates", sa.column("code"), sa.column("metric"), sa.column("title", pg.JSONB()),
                         sa.column("description", pg.JSONB()), sa.column("unit", pg.JSONB()),
                         sa.column("asset_id"), sa.column("order"))
    for t in seed["badge_templates"]:
        bind.execute(templates.insert().values(code=t["code"], metric=t["metric"], title=t["title"],
                                               description=t["description"], unit=t["unit"], asset_id=None,
                                               order=t["order"]))


def downgrade() -> None:
    drop_messaging_tables(op)
    op.execute("DROP TRIGGER IF EXISTS assets_guard ON assets")
    op.execute("DROP TRIGGER IF EXISTS rules_versions_guard ON rules_versions")
    op.execute("DROP TRIGGER IF EXISTS badges_guard ON badges")
    op.execute("DROP TRIGGER IF EXISTS ledger_guard ON ledger")
    for table in ("tick_state", "deleted_users", "idempotency", "evidence_rewards", "session_rewards", "daily_stats", "game_events",
                  "shop_items", "assets", "heroes", "rules_versions", "badge_templates", "badges", "quests",
                  "purchases", "ownership", "referrals", "skill_states", "learners", "wallets", "ledger"):
        op.drop_table(table)
    for fn in ("gamification_assets_guard", "gamification_rules_guard", "gamification_badges_guard",
               "gamification_ledger_guard"):
        op.execute(f"DROP FUNCTION IF EXISTS {fn}()")
