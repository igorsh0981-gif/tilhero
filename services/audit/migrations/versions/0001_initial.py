"""audit_records (append-only, hash chain) + outbox/inbox

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
        "audit_records",
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), primary_key=True),
        sa.Column("record_id", pg.UUID(as_uuid=True), nullable=False, unique=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("source", sa.String(64), nullable=False),
        sa.Column("actor_type", sa.String(16), nullable=False),
        sa.Column("actor_id", sa.String(64)),
        sa.Column("actor_role", sa.String(64)),
        sa.Column("action", sa.String(80), nullable=False),
        sa.Column("object_type", sa.String(64)),
        sa.Column("object_id", sa.String(128)),
        sa.Column("before", pg.JSONB()),
        sa.Column("after", pg.JSONB()),
        sa.Column("reason", sa.Text()),
        sa.Column("ip", sa.String(64)),
        sa.Column("session_id", sa.String(64)),
        sa.Column("trace_id", sa.String(64)),
        sa.Column("prev_hash", sa.String(64), nullable=False),
        sa.Column("hash", sa.String(64), nullable=False, unique=True),
        sa.CheckConstraint("actor_type IN ('staff','user','system','service')", name="ck_audit_actor_type"),
    )
    op.create_index("ix_audit_records_action", "audit_records", ["action"])
    op.create_index("ix_audit_records_object_id", "audit_records", ["object_id"])
    op.create_index("ix_audit_records_occurred_at", "audit_records", ["occurred_at"])
    # Append-only: обычный администратор (и сам сервис) не может изменить или удалить запись (ТЗ Admin §10).
    op.execute(
        """
        CREATE OR REPLACE FUNCTION audit_records_immutable() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'audit_records is append-only (% is not allowed)', TG_OP
            USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        "CREATE TRIGGER audit_records_no_update BEFORE UPDATE OR DELETE ON audit_records "
        "FOR EACH ROW EXECUTE FUNCTION audit_records_immutable()"
    )
    op.execute(
        "CREATE TRIGGER audit_records_no_truncate BEFORE TRUNCATE ON audit_records "
        "FOR EACH STATEMENT EXECUTE FUNCTION audit_records_immutable()"
    )

    create_messaging_tables(op)

def downgrade() -> None:
    drop_messaging_tables(op)
    op.execute("DROP TRIGGER IF EXISTS audit_records_no_truncate ON audit_records")
    op.execute("DROP TRIGGER IF EXISTS audit_records_no_update ON audit_records")
    op.drop_table("audit_records")
    op.execute("DROP FUNCTION IF EXISTS audit_records_immutable()")
