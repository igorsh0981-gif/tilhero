"""Согласие родителя за подростка 14–17 как запись consents и отзыв родителем (INTERNAL_API §11, ревью P-4)

- consents: действующее согласие — одно на ученика и основание (`self` — своё, `guardian` — родителя). У подростка
  могут одновременно действовать своё согласие (выбранные цели) и согласие родителя (разрешение); у детского профиля
  только `guardian`, у взрослого только `self`. Причина закрытия `guardian` — отозвано родителем.
- guardian_consent_requests: `consent_id` — запись consents подростка, созданная решением `granted`; `revoked_at` —
  когда родитель отозвал согласие (строка переходит в `declined`). Не больше одного действующего `granted` на
  подростка; индекс по родителю — для списка «за кого я решал».

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-18
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_index("uq_consents_active", table_name="consents")
    op.create_index("uq_consents_active", "consents", ["user_id", "basis"], unique=True,
                    postgresql_where=sa.text("revoked_at IS NULL"))
    op.drop_constraint("ck_consents_revoke_reason", "consents", type_="check")
    op.create_check_constraint(
        "ck_consents_revoke_reason", "consents",
        "revoke_reason IS NULL OR revoke_reason IN ('user','superseded','deletion','guardian')",
    )

    op.add_column("guardian_consent_requests",
                  sa.Column("consent_id", pg.UUID(as_uuid=True), sa.ForeignKey("consents.consent_id")))
    op.add_column("guardian_consent_requests", sa.Column("revoked_at", sa.DateTime(timezone=True)))
    op.create_check_constraint("ck_guardian_consent_requests_revoked", "guardian_consent_requests",
                               "revoked_at IS NULL OR status = 'declined'")
    op.create_index("ix_guardian_consent_requests_guardian", "guardian_consent_requests", ["guardian_user_id"])
    op.create_index("uq_guardian_consent_requests_granted", "guardian_consent_requests", ["teen_user_id"],
                    unique=True, postgresql_where=sa.text("status = 'granted'"))


def downgrade() -> None:
    op.drop_index("uq_guardian_consent_requests_granted", table_name="guardian_consent_requests")
    op.drop_index("ix_guardian_consent_requests_guardian", table_name="guardian_consent_requests")
    op.drop_constraint("ck_guardian_consent_requests_revoked", "guardian_consent_requests", type_="check")
    op.drop_column("guardian_consent_requests", "revoked_at")
    op.drop_column("guardian_consent_requests", "consent_id")
    op.drop_constraint("ck_consents_revoke_reason", "consents", type_="check")
    op.create_check_constraint(
        "ck_consents_revoke_reason", "consents",
        "revoke_reason IS NULL OR revoke_reason IN ('user','superseded','deletion')",
    )
    op.drop_index("uq_consents_active", table_name="consents")
    op.create_index("uq_consents_active", "consents", ["user_id"], unique=True,
                    postgresql_where=sa.text("revoked_at IS NULL"))
