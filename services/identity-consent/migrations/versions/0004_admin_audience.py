"""Админ-контур и аудитория рассылок (спринт 2, docs/sprint2/INTERNAL_API.md §3)

- learner_activity — проекция learning-plan (онбординг, последнее занятие) для фильтров аудитории `onboarded` и
  `active_days`; наполняется событиями `learning.plan.updated.v1` и `learning.activity.recorded.v1` (inbox).
- users(updated_at, user_id) — курсорная сверка read-модели user-admin (`GET /admin/v1/users?updated_after=`).
- Частичные индексы «базы» аудитории: users (аккаунт, ACTIVE, возраст выбран, категория product) и consents
  (действующее своё согласие с целью product_news).

Таблицы users и consents в prod пока малы (развёрнуты 18.11.2026): индексы строятся в транзакции миграции, как в
0002–0003.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-18
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

# те же фрагменты, что в models (запрос аудитории повторяет их буквально — audience.py)
AUDIENCE_USERS_SQL = (
    "kind = 'account' AND status = 'ACTIVE' AND age_band IS NOT NULL AND 'product' = ANY (notify_categories)"
)
PRODUCT_NEWS_CONSENT_SQL = "revoked_at IS NULL AND basis = 'self' AND 'product_news' = ANY (purposes)"


def upgrade() -> None:
    op.create_table(
        "learner_activity",
        sa.Column("user_id", pg.UUID(as_uuid=True),
                  sa.ForeignKey("users.user_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("onboarding_completed_at", sa.DateTime(timezone=True)),
        sa.Column("last_activity_at", sa.DateTime(timezone=True)),
        sa.Column("plan_event_at", sa.DateTime(timezone=True)),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_learner_activity_last_activity", "learner_activity", ["last_activity_at"])
    op.create_index("ix_learner_activity_onboarding", "learner_activity", ["onboarding_completed_at"])
    op.create_index("ix_users_updated_at", "users", ["updated_at", "user_id"])
    op.create_index("ix_users_audience", "users", ["user_id"], postgresql_where=sa.text(AUDIENCE_USERS_SQL))
    op.create_index("ix_consents_product_news", "consents", ["user_id"],
                    postgresql_where=sa.text(PRODUCT_NEWS_CONSENT_SQL))


def downgrade() -> None:
    op.drop_index("ix_consents_product_news", table_name="consents")
    op.drop_index("ix_users_audience", table_name="users")
    op.drop_index("ix_users_updated_at", table_name="users")
    op.drop_index("ix_learner_activity_onboarding", table_name="learner_activity")
    op.drop_index("ix_learner_activity_last_activity", table_name="learner_activity")
    op.drop_table("learner_activity")
