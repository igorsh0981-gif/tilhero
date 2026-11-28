"""спринт 8: деньги и контроль ИИ (INTERNAL_API спринта 8 §5).

- sessions: + `ai_active_seconds` (активное время, пока ИИ работает: ai_mode full и нет деградации/отказа),
  `ai_lock_reason` (урок без ИИ по тарифу: no_subscription | feature_not_in_plan | minutes_exhausted |
  billing_unavailable), `billing_hold_id` (удержание минут billing при старте), `billable_minutes`
  (⌈ai_active_seconds / 60⌉ ≤ minutes — в событии завершения);
- pair_rooms: + `billing_payer_user_id` (пригласивший — его подписка и минуты), `billing_hold_id` (удержание при старте
  с коучем), `coach_active_seconds` (время с работающим коучем: in_progress, engine ai, без деградации),
  `billable_minutes` (⌈coach_active_seconds / 60⌉ — в событии завершения комнаты).

Откат удаляет колонки (сведения об удержаниях теряются; минуты учитывает billing).

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-22
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

LOCK_REASONS = "('no_subscription','feature_not_in_plan','minutes_exhausted','billing_unavailable')"


def upgrade() -> None:
    op.add_column("sessions", sa.Column("ai_active_seconds", sa.Integer(), nullable=False,
                                        server_default=sa.text("0")))
    op.add_column("sessions", sa.Column("ai_lock_reason", sa.String(24)))
    op.add_column("sessions", sa.Column("billing_hold_id", pg.UUID(as_uuid=True)))
    op.add_column("sessions", sa.Column("billable_minutes", sa.SmallInteger()))
    op.create_check_constraint("ck_sessions_ai_seconds", "sessions", "ai_active_seconds >= 0")
    op.create_check_constraint("ck_sessions_ai_lock_reason", "sessions",
                               f"ai_lock_reason IS NULL OR ai_lock_reason IN {LOCK_REASONS}")
    op.create_check_constraint("ck_sessions_billable_minutes", "sessions",
                               "billable_minutes IS NULL OR billable_minutes BETWEEN 0 AND 240")

    op.add_column("pair_rooms", sa.Column("billing_payer_user_id", pg.UUID(as_uuid=True)))
    op.add_column("pair_rooms", sa.Column("billing_hold_id", pg.UUID(as_uuid=True)))
    op.add_column("pair_rooms", sa.Column("coach_active_seconds", sa.Integer(), nullable=False,
                                          server_default=sa.text("0")))
    op.add_column("pair_rooms", sa.Column("billable_minutes", sa.SmallInteger()))
    op.create_check_constraint("ck_pair_rooms_coach_seconds", "pair_rooms", "coach_active_seconds >= 0")
    op.create_check_constraint("ck_pair_rooms_billable_minutes", "pair_rooms",
                               "billable_minutes IS NULL OR billable_minutes BETWEEN 0 AND 240")
    # удержание бывает только у комнаты с плательщиком
    op.create_check_constraint("ck_pair_rooms_billing", "pair_rooms",
                               "billing_hold_id IS NULL OR billing_payer_user_id IS NOT NULL")


def downgrade() -> None:
    for name in ("ck_pair_rooms_billing", "ck_pair_rooms_billable_minutes", "ck_pair_rooms_coach_seconds"):
        op.drop_constraint(name, "pair_rooms", type_="check")
    for col in ("billable_minutes", "coach_active_seconds", "billing_hold_id", "billing_payer_user_id"):
        op.drop_column("pair_rooms", col)
    for name in ("ck_sessions_billable_minutes", "ck_sessions_ai_lock_reason", "ck_sessions_ai_seconds"):
        op.drop_constraint(name, "sessions", type_="check")
    for col in ("billable_minutes", "billing_hold_id", "ai_lock_reason", "ai_active_seconds"):
        op.drop_column("sessions", col)
