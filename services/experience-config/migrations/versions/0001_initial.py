"""config_versions, activations (append-only) + outbox/inbox

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
        "config_versions",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False, unique=True),
        sa.Column("app", sa.String(16), nullable=False),
        sa.Column("version", sa.String(32), nullable=False),
        sa.Column("payload", pg.JSONB(), nullable=False),
        sa.Column("checksum", sa.String(64), nullable=False),
        sa.Column("change_note", sa.Text(), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("app", "version", name="uq_config_versions_app_version"),
        sa.CheckConstraint("app IN ('miniapp', 'admin')", name="ck_config_versions_app"),
        sa.CheckConstraint("version ~ '^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}$'", name="ck_config_versions_semver"),
        sa.CheckConstraint("checksum ~ '^[0-9a-f]{64}$'", name="ck_config_versions_checksum"),
    )
    op.create_table(
        "activations",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False, unique=True),
        sa.Column("app", sa.String(16), nullable=False),
        sa.Column("version", sa.String(32), nullable=False),
        sa.Column("previous_version", sa.String(32)),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("activated_by", sa.String(64), nullable=False),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["app", "version"], ["config_versions.app", "config_versions.version"],
                                name="fk_activations_version"),
        sa.CheckConstraint("kind IN ('activate', 'rollback')", name="ck_activations_kind"),
    )
    op.create_index("ix_activations_app_seq", "activations", ["app", sa.text("seq DESC")])
    # Версии и журнал активаций неизменяемы (ТЗ UI/CSS §8, Admin: rollback = новая activation-запись).
    op.execute(
        """
        CREATE OR REPLACE FUNCTION experience_append_only() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION '% is append-only (% is not allowed)', TG_TABLE_NAME, TG_OP
            USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    for table in ("config_versions", "activations"):
        op.execute(f"CREATE TRIGGER {table}_no_update BEFORE UPDATE OR DELETE ON {table} "
                   "FOR EACH ROW EXECUTE FUNCTION experience_append_only()")
        op.execute(f"CREATE TRIGGER {table}_no_truncate BEFORE TRUNCATE ON {table} "
                   "FOR EACH STATEMENT EXECUTE FUNCTION experience_append_only()")
    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    for table in ("activations", "config_versions"):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_no_truncate ON {table}")
        op.execute(f"DROP TRIGGER IF EXISTS {table}_no_update ON {table}")
    op.drop_index("ix_activations_app_seq", table_name="activations")
    op.drop_table("activations")
    op.drop_table("config_versions")
    op.execute("DROP FUNCTION IF EXISTS experience_append_only()")
