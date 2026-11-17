"""release_notes — заметки о релизах «Что нового» (доработка 9.4)

Правится только черновик. У опубликованной меняется лишь статус на archived (+ кто/когда архивировал); содержимое,
метка, аудитория и время публикации неизменны. Архивная заметка не меняется совсем. Удалить можно только черновик.
Это закрепляет триггер release_notes_guard: роль сервиса не может его снять (DDL — только у владельца схемы).

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-08
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
        "release_notes",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False, unique=True),
        sa.Column("slug", sa.String(32), nullable=False),
        sa.Column("title", pg.JSONB(), nullable=False),
        sa.Column("items", pg.JSONB(), nullable=False),
        sa.Column("audience", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_by", sa.String(64), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("published_by", sa.String(64)),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.Column("archived_by", sa.String(64)),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("status IN ('draft', 'published', 'archived')", name="ck_release_notes_status"),
        sa.CheckConstraint("audience IN ('all', 'existing')", name="ck_release_notes_audience"),
        sa.CheckConstraint("slug ~ '^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$'", name="ck_release_notes_slug"),
        sa.CheckConstraint("jsonb_typeof(title) = 'object'", name="ck_release_notes_title"),
        sa.CheckConstraint("jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 6",
                           name="ck_release_notes_items"),
        sa.CheckConstraint("status <> 'published' OR published_at IS NOT NULL", name="ck_release_notes_published"),
        sa.CheckConstraint("status <> 'draft' OR published_at IS NULL", name="ck_release_notes_draft"),
        sa.CheckConstraint("version >= 1", name="ck_release_notes_version"),
    )
    op.create_index("uq_release_notes_slug_active", "release_notes", ["slug"], unique=True,
                    postgresql_where=sa.text("status <> 'archived'"))
    op.create_index("ix_release_notes_status_published", "release_notes", ["status", "published_at"])
    op.execute(
        """
        CREATE OR REPLACE FUNCTION release_notes_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF OLD.status <> 'draft' THEN
              RAISE EXCEPTION 'release note % is %: delete is not allowed', OLD.id, OLD.status
                USING ERRCODE = 'insufficient_privilege';
            END IF;
            RETURN OLD;
          END IF;
          IF OLD.status = 'archived' THEN
            RAISE EXCEPTION 'release note % is archived: immutable', OLD.id USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF OLD.status = 'published' AND (
               NEW.status <> 'archived'
            OR NEW.slug IS DISTINCT FROM OLD.slug OR NEW.title IS DISTINCT FROM OLD.title
            OR NEW.items IS DISTINCT FROM OLD.items OR NEW.audience IS DISTINCT FROM OLD.audience
            OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.published_by IS DISTINCT FROM OLD.published_by
            OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by) THEN
            RAISE EXCEPTION 'release note % is published: only archiving is allowed', OLD.id
              USING ERRCODE = 'insufficient_privilege';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER release_notes_guard BEFORE UPDATE OR DELETE ON release_notes "
               "FOR EACH ROW EXECUTE FUNCTION release_notes_guard()")
    op.execute("CREATE TRIGGER release_notes_no_truncate BEFORE TRUNCATE ON release_notes "
               "FOR EACH STATEMENT EXECUTE FUNCTION experience_append_only()")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS release_notes_no_truncate ON release_notes")
    op.execute("DROP TRIGGER IF EXISTS release_notes_guard ON release_notes")
    op.execute("DROP FUNCTION IF EXISTS release_notes_guard()")
    op.drop_index("ix_release_notes_status_published", table_name="release_notes")
    op.drop_index("uq_release_notes_slug_active", table_name="release_notes")
    op.drop_table("release_notes")
