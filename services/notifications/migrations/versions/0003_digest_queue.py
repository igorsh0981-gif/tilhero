"""digest_queue — накопление дайджеста (спринт 6, docs/sprint6/INTERNAL_API.md §5)

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-11
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "digest_queue",
        sa.Column("item_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("section", sa.String(16), nullable=False),
        sa.Column("template", sa.String(64), nullable=False),
        sa.Column("params", pg.JSONB()),
        sa.Column("dedup_key", sa.String(200), nullable=False),
        sa.Column("source_event_id", pg.UUID(as_uuid=True)),
        sa.Column("not_before", sa.DateTime(timezone=True)),
        sa.Column("digest_id", pg.UUID(as_uuid=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("dedup_key", name="uq_digest_queue_dedup_key"),
        sa.CheckConstraint("section IN ('watch','news')", name="ck_digest_queue_section"),
        sa.CheckConstraint("digest_id IS NULL OR params IS NULL", name="ck_digest_queue_params_cleared"),
    )
    op.create_index(
        "ix_digest_queue_pending", "digest_queue", ["user_id"], postgresql_where=sa.text("digest_id IS NULL")
    )
    op.create_index(
        "ix_digest_queue_consumed",
        "digest_queue",
        ["consumed_at"],
        postgresql_where=sa.text("digest_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_table("digest_queue")
