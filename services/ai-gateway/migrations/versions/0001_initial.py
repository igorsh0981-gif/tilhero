"""ai-gateway: реестр агентов (сид 17), версии инструкций (+ триггер неизменяемости), канарейка и откат, золотые
тесты и прогоны, модели и цены (сид), бюджет (singleton), учёт вызовов без текстов, deleted_users, outbox/inbox

Неизменяемость (защита в глубину, INTERNAL_API §1.1): тело версии правится только в черновике не под канарейкой;
у опубликованной и архивной версии тело и идентичность неизменны, допустимы лишь переходы статуса
draft → published, published → archived, archived → published (откат); удалить можно только черновик не под
канарейкой; TRUNCATE запрещён. Завершённый прогон золотых тестов не меняется.

Revision ID: 0001
Revises:
Create Date: 2026-11-19
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

from tilhero_ai_gateway.domain.registry import AGENT_IDS, AGENTS, BUDGET_DEFAULTS, LLM_AGENT_IDS, MODELS
from tilhero_common.migrations import create_messaging_tables, drop_messaging_tables

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
SEED_ACTOR = "00000000-0000-4000-a000-000000005eed"
AGENT_IDS_SQL = ", ".join(f"'{a}'" for a in AGENT_IDS)
ID_SQL = "'^[a-z0-9][a-z0-9._-]{1,63}$'"
HEX64_SQL = "'^[0-9a-f]{64}$'"
REASONS_SQL = ("'ai_disabled', 'budget_exceeded', 'provider_error', 'timeout', 'invalid_output', 'kids_not_allowed', "
               "'agent_not_active'")


def upgrade() -> None:
    agents = op.create_table(
        "agents",
        sa.Column("agent_id", sa.String(64), primary_key=True),
        sa.Column("title", pg.JSONB(), nullable=False),
        sa.Column("purpose", pg.JSONB(), nullable=False),
        sa.Column("owner_role", sa.String(32), nullable=False),
        sa.Column("implementation", sa.String(8), nullable=False),
        sa.Column("availability", sa.String(8), nullable=False),
        sa.Column("planned_sprint", sa.Integer()),
        sa.Column("free_text", sa.Boolean(), nullable=False),
        sa.Column("implemented_in", sa.String(32)),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint(f"agent_id IN ({AGENT_IDS_SQL})", name="ck_agents_id"),
        sa.CheckConstraint("jsonb_typeof(title) = 'object'", name="ck_agents_title"),
        sa.CheckConstraint("jsonb_typeof(purpose) = 'object'", name="ck_agents_purpose"),
        sa.CheckConstraint("implementation IN ('llm', 'rules', 'code')", name="ck_agents_implementation"),
        sa.CheckConstraint("availability IN ('active', 'planned')", name="ck_agents_availability"),
        sa.CheckConstraint("(availability = 'planned') = (planned_sprint IS NOT NULL)", name="ck_agents_planned"),
        sa.CheckConstraint("planned_sprint IS NULL OR planned_sprint BETWEEN 1 AND 30",
                           name="ck_agents_planned_sprint"),
    )
    models = op.create_table(
        "models",
        sa.Column("model_id", sa.String(64), primary_key=True),
        sa.Column("provider", sa.String(16), nullable=False),
        sa.Column("input_usd_per_mtok", sa.Numeric(10, 4), nullable=False),
        sa.Column("output_usd_per_mtok", sa.Numeric(10, 4), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("updated_by", sa.String(64), nullable=False),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint(f"model_id ~ {ID_SQL}", name="ck_models_id"),
        sa.CheckConstraint("provider IN ('anthropic', 'fake')", name="ck_models_provider"),
        sa.CheckConstraint("input_usd_per_mtok >= 0 AND input_usd_per_mtok <= 1000", name="ck_models_input"),
        sa.CheckConstraint("output_usd_per_mtok >= 0 AND output_usd_per_mtok <= 1000", name="ck_models_output"),
    )
    op.create_table(
        "agent_versions",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False, unique=True),
        sa.Column("agent_id", sa.String(64), sa.ForeignKey("agents.agent_id", name="fk_agent_versions_agent"),
                  nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("instructions", sa.Text(), nullable=False),
        sa.Column("rules", sa.Text(), nullable=False),
        sa.Column("output_schema", pg.JSONB(), nullable=False),
        sa.Column("schema_version", sa.String(64), nullable=False),
        sa.Column("model_id", sa.String(64), sa.ForeignKey("models.model_id", name="fk_agent_versions_model"),
                  nullable=False),
        sa.Column("fallback_model_id", sa.String(64),
                  sa.ForeignKey("models.model_id", name="fk_agent_versions_fallback")),
        sa.Column("temperature", sa.Numeric(3, 2), nullable=False),
        sa.Column("max_output_tokens", sa.Integer(), nullable=False),
        sa.Column("timeout_ms", sa.Integer(), nullable=False),
        sa.Column("max_cost_usd", sa.Numeric(10, 6), nullable=False),
        sa.Column("notes", sa.Text()),
        sa.Column("body_hash", sa.String(64), nullable=False),
        sa.Column("author_id", sa.String(64), nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_by", sa.String(64), nullable=False),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("published_by", sa.String(64)),
        sa.Column("published_at", TS),
        sa.Column("archived_at", TS),
        sa.UniqueConstraint("agent_id", "version", name="uq_agent_versions_agent_version"),
        sa.CheckConstraint("version >= 1", name="ck_agent_versions_version"),
        sa.CheckConstraint("status IN ('draft', 'published', 'archived')", name="ck_agent_versions_status"),
        sa.CheckConstraint("char_length(instructions) <= 20000", name="ck_agent_versions_instructions"),
        sa.CheckConstraint("char_length(rules) <= 10000", name="ck_agent_versions_rules"),
        sa.CheckConstraint("jsonb_typeof(output_schema) = 'object'", name="ck_agent_versions_output_schema"),
        sa.CheckConstraint("schema_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'", name="ck_agent_versions_schema_version"),
        sa.CheckConstraint("temperature >= 0 AND temperature <= 1", name="ck_agent_versions_temperature"),
        sa.CheckConstraint("max_output_tokens BETWEEN 1 AND 2000", name="ck_agent_versions_max_output_tokens"),
        sa.CheckConstraint("timeout_ms BETWEEN 2000 AND 30000", name="ck_agent_versions_timeout"),
        sa.CheckConstraint("max_cost_usd >= 0 AND max_cost_usd <= 10", name="ck_agent_versions_max_cost"),
        sa.CheckConstraint("notes IS NULL OR char_length(notes) <= 2000", name="ck_agent_versions_notes"),
        sa.CheckConstraint(f"body_hash ~ {HEX64_SQL}", name="ck_agent_versions_body_hash"),
        sa.CheckConstraint("status <> 'published' OR published_at IS NOT NULL", name="ck_agent_versions_published"),
        sa.CheckConstraint("status <> 'archived' OR archived_at IS NOT NULL", name="ck_agent_versions_archived"),
    )
    op.create_index("uq_agent_versions_published", "agent_versions", ["agent_id"], unique=True,
                    postgresql_where=sa.text("status = 'published'"))
    op.create_index("uq_agent_versions_draft", "agent_versions", ["agent_id"], unique=True,
                    postgresql_where=sa.text("status = 'draft'"))

    rollout = op.create_table(
        "agent_rollout",
        sa.Column("agent_id", sa.String(64), sa.ForeignKey("agents.agent_id", name="fk_agent_rollout_agent"),
                  primary_key=True),
        sa.Column("published_version", sa.Integer()),
        sa.Column("canary_version", sa.Integer()),
        sa.Column("canary_percent", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("previous_version", sa.Integer()),
        sa.Column("updated_by", sa.String(64), nullable=False),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["agent_id", "published_version"],
                                ["agent_versions.agent_id", "agent_versions.version"],
                                name="fk_agent_rollout_published"),
        sa.ForeignKeyConstraint(["agent_id", "canary_version"], ["agent_versions.agent_id", "agent_versions.version"],
                                name="fk_agent_rollout_canary"),
        sa.ForeignKeyConstraint(["agent_id", "previous_version"],
                                ["agent_versions.agent_id", "agent_versions.version"],
                                name="fk_agent_rollout_previous"),
        sa.CheckConstraint("canary_percent BETWEEN 0 AND 50", name="ck_agent_rollout_percent"),
        sa.CheckConstraint("(canary_version IS NULL) = (canary_percent = 0)", name="ck_agent_rollout_canary"),
        sa.CheckConstraint("canary_version IS NULL OR canary_version IS DISTINCT FROM published_version",
                           name="ck_agent_rollout_canary_distinct"),
    )

    op.create_table(
        "golden_cases",
        sa.Column("case_id", sa.String(64), primary_key=True),
        sa.Column("agent_id", sa.String(64), sa.ForeignKey("agents.agent_id", name="fk_golden_cases_agent"),
                  nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("input", pg.JSONB(), nullable=False),
        sa.Column("checks", pg.JSONB(), nullable=False),
        sa.Column("mandatory", sa.Boolean(), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("archived_at", TS),
        sa.CheckConstraint(f"case_id ~ {ID_SQL}", name="ck_golden_cases_id"),
        sa.CheckConstraint("char_length(title) BETWEEN 1 AND 200", name="ck_golden_cases_title"),
        sa.CheckConstraint("jsonb_typeof(input) = 'object'", name="ck_golden_cases_input"),
        sa.CheckConstraint("jsonb_typeof(checks) = 'array'", name="ck_golden_cases_checks"),
    )
    op.create_index("ix_golden_cases_agent", "golden_cases", ["agent_id", "case_id"])

    op.create_table(
        "test_runs",
        sa.Column("run_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False, unique=True),
        sa.Column("agent_id", sa.String(64), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("provider", sa.String(16), nullable=False),
        sa.Column("body_hash", sa.String(64), nullable=False),
        sa.Column("cases_hash", sa.String(64), nullable=False),
        sa.Column("started_by", sa.String(64), nullable=False),
        sa.Column("started_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("finished_at", TS),
        sa.Column("results", pg.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("passed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("passed_mandatory", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("cost_usd", sa.Numeric(12, 6), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["agent_id", "version"], ["agent_versions.agent_id", "agent_versions.version"],
                                name="fk_test_runs_version", ondelete="CASCADE"),
        sa.CheckConstraint("status IN ('running', 'finished', 'failed')", name="ck_test_runs_status"),
        sa.CheckConstraint("provider IN ('anthropic', 'fake')", name="ck_test_runs_provider"),
        sa.CheckConstraint(f"body_hash ~ {HEX64_SQL}", name="ck_test_runs_body_hash"),
        sa.CheckConstraint(f"cases_hash ~ {HEX64_SQL}", name="ck_test_runs_cases_hash"),
        sa.CheckConstraint("jsonb_typeof(results) = 'array'", name="ck_test_runs_results"),
        sa.CheckConstraint("passed >= 0 AND failed >= 0", name="ck_test_runs_counts"),
        sa.CheckConstraint("cost_usd >= 0", name="ck_test_runs_cost"),
        sa.CheckConstraint("(status = 'running') = (finished_at IS NULL)", name="ck_test_runs_finished"),
    )
    op.create_index("ix_test_runs_version", "test_runs", ["agent_id", "version", "seq"])

    budget = op.create_table(
        "budget",
        sa.Column("id", sa.SmallInteger(), primary_key=True),
        sa.Column("ai_enabled", sa.Boolean(), nullable=False),
        sa.Column("monthly_cap_usd", sa.Numeric(10, 2), nullable=False),
        sa.Column("learner_daily_cap_usd", sa.Numeric(10, 4), nullable=False),
        sa.Column("lesson_cap_usd", sa.Numeric(10, 4), nullable=False),
        sa.Column("alert_percent", sa.Integer(), nullable=False),
        sa.Column("updated_by", sa.String(64), nullable=False),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("id = 1", name="ck_budget_singleton"),
        sa.CheckConstraint("monthly_cap_usd >= 0 AND monthly_cap_usd <= 100000", name="ck_budget_monthly"),
        sa.CheckConstraint("learner_daily_cap_usd >= 0 AND learner_daily_cap_usd <= 1000", name="ck_budget_daily"),
        sa.CheckConstraint("lesson_cap_usd >= 0 AND lesson_cap_usd <= 1000", name="ck_budget_lesson"),
        sa.CheckConstraint("alert_percent BETWEEN 1 AND 100", name="ck_budget_alert"),
    )

    op.create_table(
        "usage",
        sa.Column("call_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False, unique=True),
        sa.Column("request_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("caller", sa.String(32), nullable=False),
        sa.Column("agent_id", sa.String(64), sa.ForeignKey("agents.agent_id", name="fk_usage_agent"),
                  nullable=False),
        sa.Column("version", sa.Integer()),
        sa.Column("model_id", sa.String(64)),
        sa.Column("provider", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("reason", sa.String(32)),
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Numeric(12, 6), nullable=False, server_default="0"),
        sa.Column("reserved_usd", sa.Numeric(12, 6), nullable=False, server_default="0"),
        sa.Column("latency_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("attempts", sa.SmallInteger(), nullable=False, server_default="0"),
        sa.Column("session_id", pg.UUID(as_uuid=True)),
        sa.Column("session_kind", sa.String(16)),
        sa.Column("user_id", pg.UUID(as_uuid=True)),
        sa.Column("canary", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("finished_at", TS),
        sa.CheckConstraint("status IN ('pending', 'ok', 'unavailable', 'refused')", name="ck_usage_status"),
        sa.CheckConstraint(f"reason IS NULL OR reason IN ({REASONS_SQL})", name="ck_usage_reason"),
        sa.CheckConstraint("(status IN ('pending', 'ok')) = (reason IS NULL)", name="ck_usage_status_reason"),
        sa.CheckConstraint("provider IN ('anthropic', 'fake')", name="ck_usage_provider"),
        sa.CheckConstraint(
            "session_kind IS NULL OR session_kind IN ('lesson', 'scenario', 'media', 'review', 'golden')",
            name="ck_usage_session_kind"),
        sa.CheckConstraint("input_tokens >= 0 AND output_tokens >= 0", name="ck_usage_tokens"),
        sa.CheckConstraint("cost_usd >= 0 AND reserved_usd >= 0", name="ck_usage_cost"),
        sa.CheckConstraint("latency_ms >= 0", name="ck_usage_latency"),
        sa.CheckConstraint("attempts BETWEEN 0 AND 5", name="ck_usage_attempts"),
        sa.CheckConstraint("(status = 'pending') = (finished_at IS NULL)", name="ck_usage_finished"),
        sa.CheckConstraint("status = 'pending' OR reserved_usd = 0", name="ck_usage_reserved"),
    )
    op.create_index("ix_usage_created", "usage", ["created_at"])
    op.create_index("ix_usage_user_created", "usage", ["user_id", "created_at"])
    op.create_index("ix_usage_session", "usage", ["session_id"])
    op.create_index("ix_usage_agent_seq", "usage", ["agent_id", "seq"])
    op.create_index("ix_usage_request", "usage", ["request_id"])
    op.create_index("ix_usage_pending", "usage", ["created_at"], postgresql_where=sa.text("status = 'pending'"))

    op.create_table(
        "deleted_users",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("request_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("deleted_at", TS, nullable=False, server_default=sa.func.now()),
    )

    # ---------------------------------------------------------------- неизменяемость (защита в глубину)
    op.execute(
        """
        CREATE OR REPLACE FUNCTION ai_gateway_agent_versions_guard() RETURNS trigger AS $$
        DECLARE
          in_canary boolean;
        BEGIN
          SELECT EXISTS (SELECT 1 FROM agent_rollout r WHERE r.agent_id = OLD.agent_id
                                                         AND r.canary_version = OLD.version) INTO in_canary;
          IF TG_OP = 'DELETE' THEN
            IF OLD.status <> 'draft' OR in_canary THEN
              RAISE EXCEPTION 'agent version %@% is % (canary=%): delete is not allowed',
                OLD.agent_id, OLD.version, OLD.status, in_canary USING ERRCODE = 'insufficient_privilege';
            END IF;
            RETURN OLD;
          END IF;
          IF NEW.id <> OLD.id OR NEW.agent_id <> OLD.agent_id OR NEW.version <> OLD.version
             OR NEW.author_id <> OLD.author_id OR NEW.created_at <> OLD.created_at THEN
            RAISE EXCEPTION 'agent version identity is immutable' USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF NEW.status <> OLD.status AND NOT (
               (OLD.status = 'draft' AND NEW.status = 'published')
            OR (OLD.status = 'published' AND NEW.status = 'archived')
            OR (OLD.status = 'archived' AND NEW.status = 'published')
          ) THEN
            RAISE EXCEPTION 'agent version %@%: transition % -> % is not allowed',
              OLD.agent_id, OLD.version, OLD.status, NEW.status USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF (OLD.status <> 'draft' OR in_canary) AND (
               NEW.instructions IS DISTINCT FROM OLD.instructions OR NEW.rules IS DISTINCT FROM OLD.rules
            OR NEW.output_schema IS DISTINCT FROM OLD.output_schema
            OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
            OR NEW.model_id IS DISTINCT FROM OLD.model_id OR NEW.fallback_model_id IS DISTINCT FROM OLD.fallback_model_id
            OR NEW.temperature IS DISTINCT FROM OLD.temperature
            OR NEW.max_output_tokens IS DISTINCT FROM OLD.max_output_tokens
            OR NEW.timeout_ms IS DISTINCT FROM OLD.timeout_ms OR NEW.max_cost_usd IS DISTINCT FROM OLD.max_cost_usd
            OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.body_hash IS DISTINCT FROM OLD.body_hash
            OR NEW.updated_by IS DISTINCT FROM OLD.updated_by OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
          ) THEN
            RAISE EXCEPTION 'agent version %@% is % (canary=%): body is immutable',
              OLD.agent_id, OLD.version, OLD.status, in_canary USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF NEW.status = OLD.status AND OLD.status <> 'draft' AND (
               NEW.published_by IS DISTINCT FROM OLD.published_by OR NEW.published_at IS DISTINCT FROM OLD.published_at
            OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
          ) THEN
            RAISE EXCEPTION 'agent version %@% is %: immutable', OLD.agent_id, OLD.version, OLD.status
              USING ERRCODE = 'insufficient_privilege';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER agent_versions_guard BEFORE UPDATE OR DELETE ON agent_versions "
               "FOR EACH ROW EXECUTE FUNCTION ai_gateway_agent_versions_guard()")
    op.execute(
        """
        CREATE OR REPLACE FUNCTION ai_gateway_no_truncate() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION '% is protected (% is not allowed)', TG_TABLE_NAME, TG_OP
            USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER agent_versions_no_truncate BEFORE TRUNCATE ON agent_versions "
               "FOR EACH STATEMENT EXECUTE FUNCTION ai_gateway_no_truncate()")
    op.execute(
        """
        CREATE OR REPLACE FUNCTION ai_gateway_test_runs_guard() RETURNS trigger AS $$
        BEGIN
          IF OLD.status <> 'running' THEN
            RAISE EXCEPTION 'test run % is %: immutable', OLD.run_id, OLD.status
              USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF NEW.run_id <> OLD.run_id OR NEW.agent_id <> OLD.agent_id OR NEW.version <> OLD.version
             OR NEW.body_hash <> OLD.body_hash OR NEW.cases_hash <> OLD.cases_hash
             OR NEW.started_by <> OLD.started_by OR NEW.started_at <> OLD.started_at
             OR NEW.provider <> OLD.provider THEN
            RAISE EXCEPTION 'test run identity is immutable' USING ERRCODE = 'insufficient_privilege';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER test_runs_guard BEFORE UPDATE ON test_runs "
               "FOR EACH ROW EXECUTE FUNCTION ai_gateway_test_runs_guard()")

    create_messaging_tables(op)

    # ---------------------------------------------------------------- справочные данные
    op.bulk_insert(agents, [dict(a) for a in AGENTS])
    op.bulk_insert(models, [{**m, "updated_by": SEED_ACTOR} for m in MODELS])
    op.bulk_insert(rollout, [{"agent_id": a, "published_version": None, "canary_version": None, "canary_percent": 0,
                              "previous_version": None, "updated_by": SEED_ACTOR}
                             for a in AGENT_IDS if a in LLM_AGENT_IDS])
    op.bulk_insert(budget, [{"id": 1, **BUDGET_DEFAULTS, "updated_by": SEED_ACTOR}])


def downgrade() -> None:
    drop_messaging_tables(op)
    op.execute("DROP TRIGGER IF EXISTS test_runs_guard ON test_runs")
    op.execute("DROP TRIGGER IF EXISTS agent_versions_no_truncate ON agent_versions")
    op.execute("DROP TRIGGER IF EXISTS agent_versions_guard ON agent_versions")
    op.drop_table("deleted_users")
    for name in ("ix_usage_pending", "ix_usage_request", "ix_usage_agent_seq", "ix_usage_session",
                 "ix_usage_user_created", "ix_usage_created"):
        op.drop_index(name, table_name="usage")
    op.drop_table("usage")
    op.drop_table("budget")
    op.drop_index("ix_test_runs_version", table_name="test_runs")
    op.drop_table("test_runs")
    op.drop_index("ix_golden_cases_agent", table_name="golden_cases")
    op.drop_table("golden_cases")
    op.drop_table("agent_rollout")
    op.drop_index("uq_agent_versions_draft", table_name="agent_versions")
    op.drop_index("uq_agent_versions_published", table_name="agent_versions")
    op.drop_table("agent_versions")
    op.drop_table("models")
    op.drop_table("agents")
    op.execute("DROP FUNCTION IF EXISTS ai_gateway_test_runs_guard()")
    op.execute("DROP FUNCTION IF EXISTS ai_gateway_no_truncate()")
    op.execute("DROP FUNCTION IF EXISTS ai_gateway_agent_versions_guard()")
