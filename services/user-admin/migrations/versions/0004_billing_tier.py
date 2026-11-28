"""спринт 8 (INTERNAL_API спринта 8 §9, admin.ts AdminLearnerRow.tier, ADM-USR-01): тариф ученика в read-модели

`admin_learner_summary` + `tier` (`free | paid`, NULL — событий billing ещё не было: «считать free»), `paid_until`
(конец оплаченного доступа; NULL у free и у бессрочного) и `tier_at` — версия группы полей (`changed_at` последнего
применённого billing.access.changed.v1): поздние события тариф не откатывают. Индекс по `tier` — фильтр списка
`?tier=free|paid`. Удаление ученика (DELETED) стирает тариф вместе с прочими полями (_erase_fields).

Существующие строки получают NULL (billing ещё не публиковал событий) — фильтр `tier=free` включает их.

Откат: столбцы и индекс удаляются.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-22
"""
import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.add_column("admin_learner_summary", sa.Column("tier", sa.String(8)))
    op.add_column("admin_learner_summary", sa.Column("paid_until", TS))
    op.add_column("admin_learner_summary", sa.Column("tier_at", TS))
    op.create_check_constraint("ck_learner_tier", "admin_learner_summary", "tier IS NULL OR tier IN ('free','paid')")
    op.create_index("ix_learner_tier", "admin_learner_summary", ["tier"])


def downgrade() -> None:
    op.drop_index("ix_learner_tier", table_name="admin_learner_summary")
    op.drop_constraint("ck_learner_tier", "admin_learner_summary", type_="check")
    for column in ("tier_at", "paid_until", "tier"):
        op.drop_column("admin_learner_summary", column)
