"""release_notes.illustration: иллюстрация заметки «Что нового» (релиз 6.1)

Ключ из каталога packages/contracts/release-notes.json (`welcome`, `s6-heroes`, …) — картинка 16:9 сверху первой
карточки заметки в Mini App; NULL — без картинки (как раньше). Проверку по каталогу делает сервис (422
VALIDATION_ERROR), в БД — только формат ключа. Иллюстрация — часть содержимого: у опубликованной заметки она
неизменна, как тексты (триггер release_notes_guard дополнен полем illustration).

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-20
"""
import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

KEY_CHECK = "illustration IS NULL OR illustration ~ '^[a-z0-9][a-z0-9-]{0,31}$'"


def guard_function(with_illustration: bool) -> str:
    """release_notes_guard (миграция 0003); with_illustration — у опубликованной неизменна и иллюстрация."""
    illustration = "OR NEW.illustration IS DISTINCT FROM OLD.illustration" if with_illustration else ""
    return f"""
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
            OR NEW.segments IS DISTINCT FROM OLD.segments {illustration}
            OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.published_by IS DISTINCT FROM OLD.published_by
            OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by) THEN
            RAISE EXCEPTION 'release note % is published: only archiving is allowed', OLD.id
              USING ERRCODE = 'insufficient_privilege';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """


def upgrade() -> None:
    op.add_column("release_notes", sa.Column("illustration", sa.String(32), nullable=True))
    op.create_check_constraint("ck_release_notes_illustration", "release_notes", KEY_CHECK)
    op.execute(guard_function(with_illustration=True))


def downgrade() -> None:
    op.execute(guard_function(with_illustration=False))
    op.drop_constraint("ck_release_notes_illustration", "release_notes", type_="check")
    op.drop_column("release_notes", "illustration")
