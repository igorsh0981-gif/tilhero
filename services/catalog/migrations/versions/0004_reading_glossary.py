"""спринт 5: вид контента reading, словарь курса (glossary_entries, glossary_forms, glossary_history) и его
построение по всему опубликованному контенту

- `content_versions.kind` / `content_pointers.kind` дополняются `reading` (тот же жизненный цикл и триггер).
- Словарь курса (INTERNAL_API §2.2): статьи course | methodist | ai; формы действующих статей уникальны в паре
  (glossary_forms, первичный ключ (pair_id, form_key)); история правок — только добавление (триггер, как у прогонов
  сценариев).
- Построение: статьи course по всем опубликованным версиям уроков (key_words), медиа (phrases при allowed_uses ∋
  dictionary) и текстов (glossary) — в порядке публикации; события не публикуются (кешей переводов ещё нет).

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-20
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

from tilhero_catalog.domain.common import utcnow
from tilhero_catalog.domain.glossary_build import MIGRATION_REASON, build_all_published

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
OLD_KINDS = "'course', 'skill', 'module', 'lesson', 'rubric', 'scenario', 'media_asset', 'media_exercise'"
NEW_KINDS = OLD_KINDS + ", 'reading'"


def _kinds(kinds: str) -> None:
    for table in ("content_versions", "content_pointers"):
        op.drop_constraint(f"ck_{table}_kind", table, type_="check")
        op.create_check_constraint(f"ck_{table}_kind", table, f"kind IN ({kinds})")


def upgrade() -> None:
    _kinds(NEW_KINDS)
    op.create_table(
        "glossary_entries",
        sa.Column("entry_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False, unique=True),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("lemma", sa.String(60), nullable=False),
        sa.Column("forms", pg.JSONB(), nullable=False),
        sa.Column("part_of_speech", sa.String(16)),
        sa.Column("gloss", pg.JSONB(), nullable=False),
        sa.Column("example_en", sa.String(200)),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("review_status", sa.String(16), nullable=False),
        sa.Column("confidence", sa.Float()),
        sa.Column("agent_version", sa.String(64)),
        sa.Column("refs", pg.JSONB(), nullable=False),
        sa.Column("override", pg.JSONB()),
        sa.Column("corrected", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_by", sa.String(64)),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_by", sa.String(64)),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("archived_at", TS),
        sa.CheckConstraint("source IN ('course', 'methodist', 'ai')", name="ck_glossary_entries_source"),
        sa.CheckConstraint("review_status IN ('not_required', 'pending', 'approved', 'rejected')",
                           name="ck_glossary_entries_review_status"),
        sa.CheckConstraint("(source = 'ai') = (review_status <> 'not_required')",
                           name="ck_glossary_entries_review_ai"),
        sa.CheckConstraint("override IS NULL OR source = 'course'", name="ck_glossary_entries_override_course"),
        sa.CheckConstraint("confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
                           name="ck_glossary_entries_confidence"),
        sa.CheckConstraint("char_length(lemma) BETWEEN 1 AND 60", name="ck_glossary_entries_lemma"),
        sa.CheckConstraint("jsonb_typeof(forms) = 'array' AND jsonb_array_length(forms) BETWEEN 1 AND 8",
                           name="ck_glossary_entries_forms"),
        sa.CheckConstraint("jsonb_typeof(refs) = 'array' AND jsonb_array_length(refs) <= 50",
                           name="ck_glossary_entries_refs"),
        sa.CheckConstraint("jsonb_typeof(gloss) = 'object'", name="ck_glossary_entries_gloss"),
        sa.CheckConstraint("example_en IS NULL OR char_length(example_en) <= 200",
                           name="ck_glossary_entries_example"),
    )
    op.create_index("ix_glossary_entries_pair_status", "glossary_entries", ["pair_id", "source", "review_status"])
    op.create_table(
        "glossary_forms",
        sa.Column("pair_id", sa.String(16), primary_key=True),
        sa.Column("form_key", sa.String(120), primary_key=True),
        sa.Column("form", sa.String(120), nullable=False),
        sa.Column("entry_id", pg.UUID(as_uuid=True),
                  sa.ForeignKey("glossary_entries.entry_id", name="fk_glossary_forms_entry", ondelete="CASCADE"),
                  nullable=False),
    )
    op.create_index("ix_glossary_forms_entry", "glossary_forms", ["entry_id"])
    op.create_table(
        "glossary_history",
        sa.Column("history_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False, unique=True),
        sa.Column("entry_id", pg.UUID(as_uuid=True),
                  sa.ForeignKey("glossary_entries.entry_id", name="fk_glossary_history_entry"), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("before", pg.JSONB()),
        sa.Column("after", pg.JSONB()),
        sa.Column("by", sa.String(64)),
        sa.Column("reason", sa.Text()),
        sa.Column("at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("action IN ('created', 'updated', 'reviewed', 'archived', 'overridden')",
                           name="ck_glossary_history_action"),
        sa.CheckConstraint("reason IS NULL OR char_length(reason) <= 500", name="ck_glossary_history_reason"),
    )
    op.create_index("ix_glossary_history_entry_seq", "glossary_history", ["entry_id", "seq"])
    # история неизменяема (функция catalog_append_only — миграция 0001)
    op.execute("CREATE TRIGGER glossary_history_append_only BEFORE UPDATE OR DELETE ON glossary_history "
               "FOR EACH ROW EXECUTE FUNCTION catalog_append_only()")
    op.execute("CREATE TRIGGER glossary_history_no_truncate BEFORE TRUNCATE ON glossary_history "
               "FOR EACH STATEMENT EXECUTE FUNCTION catalog_append_only()")
    build_all_published(op.get_bind(), now=utcnow(), reason=MIGRATION_REASON)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS glossary_history_no_truncate ON glossary_history")
    op.execute("DROP TRIGGER IF EXISTS glossary_history_append_only ON glossary_history")
    op.drop_index("ix_glossary_history_entry_seq", table_name="glossary_history")
    op.drop_table("glossary_history")
    op.drop_index("ix_glossary_forms_entry", table_name="glossary_forms")
    op.drop_table("glossary_forms")
    op.drop_index("ix_glossary_entries_pair_status", table_name="glossary_entries")
    op.drop_table("glossary_entries")
    # тексты для чтения, созданные после миграции, мешают вернуть прежнее ограничение вида — удаляются (владелец)
    op.execute("ALTER TABLE content_versions DISABLE TRIGGER content_versions_guard")
    op.execute("DELETE FROM content_versions WHERE kind = 'reading'")
    op.execute("ALTER TABLE content_versions ENABLE TRIGGER content_versions_guard")
    op.execute("DELETE FROM content_pointers WHERE kind = 'reading'")
    _kinds(OLD_KINDS)
