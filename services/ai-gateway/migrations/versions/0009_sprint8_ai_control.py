"""спринт 8 (INTERNAL_API §7): контроль ИИ — бюджет по тарифу, уровни деградации, стоимость занятий

- `budget`:
  - `paid_learner_daily_cap_usd` — дневной лимит ученика с подпиской (В14, 0,30 $; не больше потолка месяца — CHECK;
    `learner_daily_cap_usd ≤ paid` проверяет домен при правке: прежняя правка сотрудника могла сделать дневной лимит
    больше потолка месяца, и CHECK на неё упал бы при подъёме);
  - `degradation_mode` (`auto | manual`), `degradation_level` (уровень, заданный вручную; NULL в `auto`),
    `economy_at_percent` (80), `paid_only_at_percent` (90): `1 ≤ economy ≤ paid_only ≤ 100`;
  - `last_level`, `last_level_at` — действующий уровень на момент последней проверки (смена → `degradation_events` и
    событие `ai.degradation.changed.v1`); `degradation_updated_at` — время последней ручной правки настроек уровней
    (`AiDegradation.updated_at`).
- `learner_tiers` — проекция `billing.access.changed.v1` (тариф ученика: `free | paid`, `paid_until`).
- `session_costs` — завершённые занятия с ИИ (`lesson.session.completed.v1` kind `lesson | scenario`,
  `lesson.pair.completed.v1` → `pair`, session_id = room_id) для отчёта «стоимость урока и минуты».
- `degradation_events` — журнал смен действующего уровня.
- `usage.reason` + `degraded` (уровень `paid_only`, ученик без подписки — до провайдера, $0).

Откат: таблицы и столбцы удаляются; вызовы с причиной `degraded` получают `budget_exceeded` (прежней схемой её не
выразить — ближайшая по смыслу: «не обслужен из-за бюджета»).

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-22
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

# снимки ограничений (миграция не зависит от будущих правок models.py)
REASONS_V4 = ("'ai_disabled', 'not_configured', 'budget_exceeded', 'cost_limit', 'provider_error', 'timeout', "
              "'invalid_output', 'kids_not_allowed', 'agent_not_active'")
REASONS_V9 = ("'ai_disabled', 'not_configured', 'budget_exceeded', 'cost_limit', 'provider_error', 'timeout', "
              "'invalid_output', 'degraded', 'kids_not_allowed', 'agent_not_active'")
INSUFFICIENT = "'not_recognized', 'low_confidence', 'incomplete'"


def _status_reason(reasons: str) -> str:
    return (f"(status = 'pending' AND reason IS NULL) "
            f"OR (status = 'ok' AND (reason IS NULL OR reason IN ({INSUFFICIENT}))) "
            f"OR (status IN ('unavailable', 'refused') AND reason IN ({reasons}))")


LEVELS = "'normal', 'economy', 'paid_only', 'off'"
MODES = "'auto', 'manual'"
DEGRADATION_REASONS = "'threshold', 'manual', 'emergency_stop', 'month_reset'"
TS = sa.DateTime(timezone=True)


def _replace_check(table: str, name: str, sql: str) -> None:
    op.drop_constraint(name, table, type_="check")
    op.create_check_constraint(name, table, sql)


def upgrade() -> None:
    # ---------------------------------------------------------------- бюджет по тарифу и уровни деградации
    op.add_column("budget", sa.Column("paid_learner_daily_cap_usd", sa.Numeric(10, 4), nullable=False,
                                      server_default="0.3000"))
    op.execute("UPDATE budget SET paid_learner_daily_cap_usd = "
               "LEAST(GREATEST(paid_learner_daily_cap_usd, learner_daily_cap_usd), monthly_cap_usd)")
    op.create_check_constraint("ck_budget_paid_daily", "budget",
                               "paid_learner_daily_cap_usd >= 0 AND paid_learner_daily_cap_usd <= monthly_cap_usd")
    op.add_column("budget", sa.Column("degradation_mode", sa.String(8), nullable=False, server_default="auto"))
    op.add_column("budget", sa.Column("degradation_level", sa.String(16)))
    op.add_column("budget", sa.Column("economy_at_percent", sa.SmallInteger(), nullable=False, server_default="80"))
    op.add_column("budget", sa.Column("paid_only_at_percent", sa.SmallInteger(), nullable=False, server_default="90"))
    op.add_column("budget", sa.Column("last_level", sa.String(16), nullable=False, server_default="normal"))
    op.add_column("budget", sa.Column("last_level_at", TS))
    op.add_column("budget", sa.Column("degradation_updated_at", TS, nullable=False, server_default=sa.func.now()))
    op.create_check_constraint("ck_budget_degradation_mode", "budget", f"degradation_mode IN ({MODES})")
    op.create_check_constraint(
        "ck_budget_degradation_level", "budget",
        f"(degradation_mode = 'manual') = (degradation_level IS NOT NULL) "
        f"AND (degradation_level IS NULL OR degradation_level IN ({LEVELS}))")
    op.create_check_constraint(
        "ck_budget_thresholds", "budget",
        "economy_at_percent >= 1 AND economy_at_percent <= paid_only_at_percent AND paid_only_at_percent <= 100")
    op.create_check_constraint("ck_budget_last_level", "budget", f"last_level IN ({LEVELS})")

    # ---------------------------------------------------------------- тариф ученика (проекция billing)
    op.create_table(
        "learner_tiers",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("tier", sa.String(8), nullable=False),
        sa.Column("paid_until", TS),
        sa.Column("changed_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("tier IN ('free', 'paid')", name="ck_learner_tiers_tier"),
    )

    # ---------------------------------------------------------------- стоимость занятий
    op.create_table(
        "session_costs",
        sa.Column("session_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("user_id", pg.UUID(as_uuid=True)),
        sa.Column("minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("billable_minutes", sa.SmallInteger()),
        sa.Column("completed_at", TS, nullable=False),
        sa.CheckConstraint("kind IN ('lesson', 'scenario', 'pair')", name="ck_session_costs_kind"),
        sa.CheckConstraint("minutes BETWEEN 0 AND 600", name="ck_session_costs_minutes"),
        sa.CheckConstraint("billable_minutes IS NULL OR billable_minutes BETWEEN 0 AND 240",
                           name="ck_session_costs_billable"),
    )
    op.create_index("ix_session_costs_completed", "session_costs", ["completed_at"])
    op.create_index("ix_session_costs_user", "session_costs", ["user_id"])

    # ---------------------------------------------------------------- журнал уровней
    op.create_table(
        "degradation_events",
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), primary_key=True),
        sa.Column("from_level", sa.String(16), nullable=False),
        sa.Column("to_level", sa.String(16), nullable=False),
        sa.Column("mode", sa.String(8), nullable=False),
        sa.Column("reason", sa.String(16), nullable=False),
        sa.Column("spent_percent", sa.Numeric(7, 2), nullable=False),
        sa.Column("actor", sa.String(64)),
        sa.Column("at", TS, nullable=False),
        sa.CheckConstraint(f"from_level IN ({LEVELS}) AND to_level IN ({LEVELS}) AND from_level <> to_level",
                           name="ck_degradation_events_levels"),
        sa.CheckConstraint(f"mode IN ({MODES})", name="ck_degradation_events_mode"),
        sa.CheckConstraint(f"reason IN ({DEGRADATION_REASONS})", name="ck_degradation_events_reason"),
        sa.CheckConstraint("spent_percent >= 0 AND spent_percent <= 1000", name="ck_degradation_events_spent"),
    )

    # ---------------------------------------------------------------- причина degraded
    _replace_check("usage", "ck_usage_reason", f"reason IS NULL OR reason IN ({REASONS_V9}, {INSUFFICIENT})")
    _replace_check("usage", "ck_usage_status_reason", _status_reason(REASONS_V9))


def downgrade() -> None:
    op.execute("UPDATE usage SET reason = 'budget_exceeded' WHERE reason = 'degraded'")
    _replace_check("usage", "ck_usage_status_reason", _status_reason(REASONS_V4))
    _replace_check("usage", "ck_usage_reason", f"reason IS NULL OR reason IN ({REASONS_V4}, {INSUFFICIENT})")

    op.drop_table("degradation_events")
    op.drop_index("ix_session_costs_user", table_name="session_costs")
    op.drop_index("ix_session_costs_completed", table_name="session_costs")
    op.drop_table("session_costs")
    op.drop_table("learner_tiers")

    for name in ("ck_budget_last_level", "ck_budget_thresholds", "ck_budget_degradation_level",
                 "ck_budget_degradation_mode", "ck_budget_paid_daily"):
        op.drop_constraint(name, "budget", type_="check")
    for column in ("degradation_updated_at", "last_level_at", "last_level", "paid_only_at_percent",
                   "economy_at_percent", "degradation_level", "degradation_mode", "paid_learner_daily_cap_usd"):
        op.drop_column("budget", column)
