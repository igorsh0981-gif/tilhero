"""catalog: языки и пары, версии контента (+ триггер неизменяемости), указатели, аудио, заявки, прогоны сценариев,
deleted_users, outbox/inbox

Неизменяемость (защита в глубину, INTERNAL_API §1.1): тело версии правится только в черновике; у опубликованной,
приостановленной и архивной версии неизменны тело, сведения о проверке, локализациях и правах; допустимы лишь
переходы статуса жизненного цикла. Прогоны сценариев — только добавление; аудио — без UPDATE.

Revision ID: 0001
Revises:
Create Date: 2026-11-19
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

from tilhero_common.migrations import create_messaging_tables, drop_messaging_tables

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

KINDS_SQL = "'course', 'skill', 'module', 'lesson', 'rubric', 'scenario', 'media_asset', 'media_exercise'"
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "languages",
        sa.Column("code", sa.String(16), primary_key=True),
        sa.Column("name", pg.JSONB(), nullable=False),
        sa.Column("script", sa.String(4), nullable=False),
        sa.Column("variants", pg.JSONB(), nullable=False),
        sa.Column("asr", pg.JSONB()),
        sa.Column("tts", pg.JSONB()),
        sa.Column("limitations", sa.Text()),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_by", sa.String(64), nullable=False),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("code ~ '^[a-z]{2,3}(-[A-Z]{2})?$'", name="ck_languages_code"),
        sa.CheckConstraint("script IN ('Latn', 'Cyrl')", name="ck_languages_script"),
        sa.CheckConstraint("status IN ('active', 'planned')", name="ck_languages_status"),
    )
    op.create_table(
        "language_pairs",
        sa.Column("pair_id", sa.String(16), primary_key=True),
        sa.Column("source", sa.String(16), sa.ForeignKey("languages.code", name="fk_language_pairs_source"),
                  nullable=False),
        sa.Column("target", sa.String(16), sa.ForeignKey("languages.code", name="fk_language_pairs_target"),
                  nullable=False),
        sa.Column("explanation_locales", pg.JSONB(), nullable=False),
        sa.Column("ui_locales", pg.JSONB(), nullable=False),
        sa.Column("title", pg.JSONB(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("release_at", sa.String(40)),
        sa.Column("course_id", sa.String(64)),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_by", sa.String(64), nullable=False),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("pair_id ~ '^[a-z]{2,3}-[a-z]{2,3}$'", name="ck_language_pairs_id"),
        sa.CheckConstraint("status IN ('planned', 'development', 'review', 'pilot', 'published', 'archived')",
                           name="ck_language_pairs_status"),
        sa.CheckConstraint("source <> target", name="ck_language_pairs_distinct"),
    )

    op.create_table(
        "content_versions",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False, unique=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("payload", pg.JSONB(), nullable=False),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column("author_id", sa.String(64), nullable=False),
        sa.Column("editors", pg.JSONB(), nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_by", sa.String(64), nullable=False),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("submitted_at", TS),
        sa.Column("reviewer_id", sa.String(64)),
        sa.Column("reviewed_at", TS),
        sa.Column("review_note", sa.Text()),
        sa.Column("locale_checks", pg.JSONB(), nullable=False),
        sa.Column("rights_approved_by", sa.String(64)),
        sa.Column("rights_approved_at", TS),
        sa.Column("rights_note", sa.Text()),
        sa.Column("published_by", sa.String(64)),
        sa.Column("published_at", TS),
        sa.Column("archived_at", TS),
        sa.Column("suspended_at", TS),
        sa.Column("suspend_reason", sa.String(32)),
        sa.UniqueConstraint("kind", "key", "version", name="uq_content_versions_kind_key_version"),
        sa.CheckConstraint(f"kind IN ({KINDS_SQL})", name="ck_content_versions_kind"),
        sa.CheckConstraint("key ~ '^[a-z0-9][a-z0-9._-]{1,63}$'", name="ck_content_versions_key"),
        sa.CheckConstraint("version >= 1", name="ck_content_versions_version"),
        sa.CheckConstraint("status IN ('draft', 'in_review', 'approved', 'published', 'suspended', 'archived')",
                           name="ck_content_versions_status"),
        sa.CheckConstraint("payload_hash ~ '^[0-9a-f]{64}$'", name="ck_content_versions_hash"),
        sa.CheckConstraint("jsonb_typeof(payload) = 'object'", name="ck_content_versions_payload"),
        sa.CheckConstraint("jsonb_typeof(locale_checks) = 'object'", name="ck_content_versions_locale_checks"),
        sa.CheckConstraint("jsonb_typeof(editors) = 'array'", name="ck_content_versions_editors"),
        sa.CheckConstraint("status <> 'suspended' OR kind = 'media_asset'",
                           name="ck_content_versions_suspended_kind"),
        sa.CheckConstraint("rights_approved_at IS NULL OR kind = 'media_asset'", name="ck_content_versions_rights_kind"),
        sa.CheckConstraint("suspend_reason IS NULL OR suspend_reason IN ('rights_expired', 'rights_revoked')",
                           name="ck_content_versions_suspend_reason"),
        sa.CheckConstraint("status <> 'published' OR published_at IS NOT NULL", name="ck_content_versions_published"),
    )
    op.create_index("uq_content_versions_published", "content_versions", ["kind", "key"], unique=True,
                    postgresql_where=sa.text("status = 'published'"))
    op.create_index("uq_content_versions_open", "content_versions", ["kind", "key"], unique=True,
                    postgresql_where=sa.text("status IN ('draft', 'in_review')"))
    op.create_index("ix_content_versions_status", "content_versions", ["status", "kind"])

    op.create_table(
        "content_pointers",
        sa.Column("kind", sa.String(16), primary_key=True),
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("published_version", sa.Integer()),
        sa.Column("previous_version", sa.Integer()),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint(f"kind IN ({KINDS_SQL})", name="ck_content_pointers_kind"),
    )

    op.create_table(
        "scenario_test_runs",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False, unique=True),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column("ok", sa.Boolean(), nullable=False),
        sa.Column("result", pg.JSONB(), nullable=False),
        sa.Column("run_by", sa.String(64), nullable=False),
        sa.Column("checked_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("payload_hash ~ '^[0-9a-f]{64}$'", name="ck_scenario_test_runs_hash"),
    )
    op.create_index("ix_scenario_test_runs_version", "scenario_test_runs", ["key", "version", "seq"])

    op.create_table(
        "media_blobs",
        sa.Column("blob_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("content_type", sa.String(16), nullable=False),
        sa.Column("bytes", sa.LargeBinary(), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("uploaded_by", sa.String(64), nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("content_type IN ('audio/mpeg', 'audio/ogg', 'audio/mp4')", name="ck_media_blobs_type"),
        sa.CheckConstraint("size > 0 AND size <= 3145728 AND size = octet_length(bytes)", name="ck_media_blobs_size"),
        sa.CheckConstraint("sha256 ~ '^[0-9a-f]{64}$'", name="ck_media_blobs_sha256"),
    )
    op.create_index("ix_media_blobs_sha256", "media_blobs", ["sha256"])

    op.create_table(
        "media_requests",
        sa.Column("request_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False, unique=True),
        sa.Column("user_id", pg.UUID(as_uuid=True)),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("title_norm", sa.String(200), nullable=False),
        sa.Column("link", sa.String(500)),
        sa.Column("comment", sa.String(500)),
        sa.Column("ui_locale", sa.String(2), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("decision_note", sa.String(500)),
        sa.Column("linked_asset_id", sa.String(64)),
        sa.Column("taken_by", sa.String(64)),
        sa.Column("taken_at", TS),
        sa.Column("decided_by", sa.String(64)),
        sa.Column("decided_at", TS),
        sa.Column("idempotency_key", sa.String(128)),
        sa.Column("anonymized_at", TS),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("kind IN ('song', 'movie', 'series', 'other')", name="ck_media_requests_kind"),
        sa.CheckConstraint(
            "status IN ('new', 'in_review', 'authored_alternative', 'licensed', 'rejected', 'duplicate')",
            name="ck_media_requests_status"),
        sa.CheckConstraint("ui_locale IN ('ru', 'uz')", name="ck_media_requests_ui_locale"),
        sa.CheckConstraint("char_length(title) BETWEEN 2 AND 200", name="ck_media_requests_title"),
        sa.CheckConstraint("link IS NULL OR (char_length(link) <= 500 AND link LIKE 'https://%')",
                           name="ck_media_requests_link"),
        sa.CheckConstraint("comment IS NULL OR char_length(comment) <= 500", name="ck_media_requests_comment"),
        sa.CheckConstraint("decision_note IS NULL OR char_length(decision_note) <= 500",
                           name="ck_media_requests_decision_note"),
        sa.CheckConstraint("(status IN ('new', 'in_review')) = (decided_at IS NULL)",
                           name="ck_media_requests_decided"),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_media_requests_idempotency"),
    )
    op.create_index("ix_media_requests_user_created", "media_requests", ["user_id", "created_at"])
    op.create_index("ix_media_requests_title_norm", "media_requests", ["title_norm"])
    op.create_index("ix_media_requests_status_seq", "media_requests", ["status", "seq"])

    op.create_table(
        "deleted_users",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("request_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("deleted_at", TS, nullable=False, server_default=sa.func.now()),
    )

    # ---------------------------------------------------------------- неизменяемость (защита в глубину)
    op.execute(
        """
        CREATE OR REPLACE FUNCTION catalog_content_versions_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF OLD.status <> 'draft' THEN
              RAISE EXCEPTION 'content version %:%@% is %: delete is not allowed',
                OLD.kind, OLD.key, OLD.version, OLD.status USING ERRCODE = 'insufficient_privilege';
            END IF;
            RETURN OLD;
          END IF;
          IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.key <> OLD.key OR NEW.version <> OLD.version
             OR NEW.author_id <> OLD.author_id OR NEW.created_at <> OLD.created_at THEN
            RAISE EXCEPTION 'content version identity is immutable' USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF NEW.status <> OLD.status AND NOT (
               (OLD.status = 'draft' AND NEW.status = 'in_review')
            OR (OLD.status = 'in_review' AND NEW.status IN ('approved', 'draft'))
            OR (OLD.status = 'approved' AND NEW.status IN ('published', 'archived'))
            OR (OLD.status = 'published' AND NEW.status IN ('archived', 'suspended'))
            OR (OLD.status = 'archived' AND NEW.status = 'published')
            OR (OLD.status = 'suspended' AND NEW.status = 'archived')
          ) THEN
            RAISE EXCEPTION 'content version %:%@%: transition % -> % is not allowed',
              OLD.kind, OLD.key, OLD.version, OLD.status, NEW.status USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF OLD.status <> 'draft' AND (
               NEW.payload IS DISTINCT FROM OLD.payload OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
            OR NEW.editors IS DISTINCT FROM OLD.editors OR NEW.updated_by IS DISTINCT FROM OLD.updated_by
            OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
          ) THEN
            RAISE EXCEPTION 'content version %:%@% is %: body is immutable',
              OLD.kind, OLD.key, OLD.version, OLD.status USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF OLD.status IN ('published', 'suspended', 'archived') AND (
               NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id
            OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.review_note IS DISTINCT FROM OLD.review_note
            OR NEW.locale_checks IS DISTINCT FROM OLD.locale_checks
            OR NEW.rights_approved_by IS DISTINCT FROM OLD.rights_approved_by
            OR NEW.rights_approved_at IS DISTINCT FROM OLD.rights_approved_at
            OR NEW.rights_note IS DISTINCT FROM OLD.rights_note
            OR (NEW.status = OLD.status AND (
                 NEW.published_by IS DISTINCT FROM OLD.published_by
              OR NEW.published_at IS DISTINCT FROM OLD.published_at
              OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
              OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
              OR NEW.suspend_reason IS DISTINCT FROM OLD.suspend_reason))
          ) THEN
            RAISE EXCEPTION 'content version %:%@% is %: immutable',
              OLD.kind, OLD.key, OLD.version, OLD.status USING ERRCODE = 'insufficient_privilege';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER content_versions_guard BEFORE UPDATE OR DELETE ON content_versions "
               "FOR EACH ROW EXECUTE FUNCTION catalog_content_versions_guard()")
    op.execute(
        """
        CREATE OR REPLACE FUNCTION catalog_append_only() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION '% is append-only (% is not allowed)', TG_TABLE_NAME, TG_OP
            USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER content_versions_no_truncate BEFORE TRUNCATE ON content_versions "
               "FOR EACH STATEMENT EXECUTE FUNCTION catalog_append_only()")
    op.execute("CREATE TRIGGER scenario_test_runs_append_only BEFORE UPDATE OR DELETE ON scenario_test_runs "
               "FOR EACH ROW EXECUTE FUNCTION catalog_append_only()")
    op.execute("CREATE TRIGGER media_blobs_no_update BEFORE UPDATE ON media_blobs "
               "FOR EACH ROW EXECUTE FUNCTION catalog_append_only()")

    create_messaging_tables(op)


def downgrade() -> None:
    drop_messaging_tables(op)
    op.execute("DROP TRIGGER IF EXISTS media_blobs_no_update ON media_blobs")
    op.execute("DROP TRIGGER IF EXISTS scenario_test_runs_append_only ON scenario_test_runs")
    op.execute("DROP TRIGGER IF EXISTS content_versions_no_truncate ON content_versions")
    op.execute("DROP TRIGGER IF EXISTS content_versions_guard ON content_versions")
    op.drop_table("deleted_users")
    op.drop_index("ix_media_requests_status_seq", table_name="media_requests")
    op.drop_index("ix_media_requests_title_norm", table_name="media_requests")
    op.drop_index("ix_media_requests_user_created", table_name="media_requests")
    op.drop_table("media_requests")
    op.drop_index("ix_media_blobs_sha256", table_name="media_blobs")
    op.drop_table("media_blobs")
    op.drop_index("ix_scenario_test_runs_version", table_name="scenario_test_runs")
    op.drop_table("scenario_test_runs")
    op.drop_table("content_pointers")
    op.drop_index("ix_content_versions_status", table_name="content_versions")
    op.drop_index("uq_content_versions_open", table_name="content_versions")
    op.drop_index("uq_content_versions_published", table_name="content_versions")
    op.drop_table("content_versions")
    op.drop_table("language_pairs")
    op.drop_table("languages")
    op.execute("DROP FUNCTION IF EXISTS catalog_append_only()")
    op.execute("DROP FUNCTION IF EXISTS catalog_content_versions_guard()")
