"""preference_profiles, deleted_users + outbox/inbox

Revision ID: 0001
Revises:
Create Date: 2026-10-08
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

from tilhero_common.migrations import create_messaging_tables, drop_messaging_tables

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "preference_profiles",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("interests", pg.JSONB(), nullable=False),
        sa.Column("geographies", pg.JSONB(), nullable=False),
        sa.Column("strong_events_outside_geo", sa.Boolean(), nullable=False),
        sa.Column("event_formats", pg.JSONB(), nullable=False),
        sa.Column("budget", pg.JSONB(), nullable=False),
        sa.Column("search_horizon_months", sa.Integer(), nullable=False),
        sa.Column("notification_points_months", pg.JSONB(), nullable=False),
        sa.Column("departures", pg.JSONB(), nullable=False),
        sa.Column("flight_prefs", pg.JSONB(), nullable=False),
        sa.Column("onboarding_completed_at", sa.DateTime(timezone=True)),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        # Вторая линия защиты после валидации в домене: правка в обход сервиса не сломает форму данных.
        sa.CheckConstraint("version >= 1", name="ck_pref_version"),
        sa.CheckConstraint("search_horizon_months IN (3, 6, 12, 24)", name="ck_pref_horizon"),
        sa.CheckConstraint("jsonb_typeof(interests) = 'object'", name="ck_pref_interests"),
        sa.CheckConstraint("jsonb_typeof(geographies) = 'array'", name="ck_pref_geographies"),
        sa.CheckConstraint(
            "jsonb_typeof(event_formats) = 'array' AND jsonb_array_length(event_formats) BETWEEN 1 AND 2",
            name="ck_pref_formats",
        ),
        sa.CheckConstraint("jsonb_typeof(budget) = 'object'", name="ck_pref_budget"),
        sa.CheckConstraint("jsonb_typeof(notification_points_months) = 'array'", name="ck_pref_points"),
        sa.CheckConstraint(
            "jsonb_typeof(departures) = 'array' AND jsonb_array_length(departures) <= 10", name="ck_pref_departures"
        ),
        sa.CheckConstraint("jsonb_typeof(flight_prefs) = 'object'", name="ck_pref_flights"),
    )
    op.create_table(
        "deleted_users",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("request_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    op.drop_table("deleted_users")
    op.drop_table("preference_profiles")
