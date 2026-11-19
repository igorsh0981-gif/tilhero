"""ревью R1-14: срок хранения текста апелляции — через 90 дней после решения `appeals.reason` → NULL,
`reason_redacted_at` — когда стёрт (сотрудник видит «стёрт по сроку хранения»)

Триггер appeals_guard разрешает решённой апелляции единственное изменение — стирание текста (reason → NULL при
reason_redacted_at из NULL в время стирания), всё остальное в ней по-прежнему неизменно; поля подачи (в т. ч. reason)
нерешённой апелляции — тоже. Стирает tick assessment (`POST /internal/v1/assessment:tick`, n8n).

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-19
"""
import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)

GUARD_V1 = """
CREATE OR REPLACE FUNCTION appeals_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.appeal_id IS DISTINCT FROM OLD.appeal_id OR NEW.evaluation_id IS DISTINCT FROM OLD.evaluation_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'appeals: submitted fields are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('upheld', 'corrected') THEN
    RAISE EXCEPTION 'appeals: decided appeal is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'new' AND NEW.status IN ('in_review', 'upheld', 'corrected'))
    OR (OLD.status = 'in_review' AND NEW.status IN ('upheld', 'corrected'))) THEN
    RAISE EXCEPTION 'appeals: transition % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""

GUARD_V2 = """
CREATE OR REPLACE FUNCTION appeals_guard() RETURNS trigger AS $$
DECLARE
  redaction boolean;
BEGIN
  -- стирание текста по сроку хранения: только решённая апелляция, только reason → NULL с отметкой времени
  redaction := OLD.status IN ('upheld', 'corrected') AND OLD.reason IS NOT NULL AND NEW.reason IS NULL
    AND OLD.reason_redacted_at IS NULL AND NEW.reason_redacted_at IS NOT NULL;
  IF NEW.appeal_id IS DISTINCT FROM OLD.appeal_id OR NEW.evaluation_id IS DISTINCT FROM OLD.evaluation_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (NOT redaction AND (NEW.reason IS DISTINCT FROM OLD.reason
                           OR NEW.reason_redacted_at IS DISTINCT FROM OLD.reason_redacted_at)) THEN
    RAISE EXCEPTION 'appeals: submitted fields are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('upheld', 'corrected') THEN
    IF redaction AND NEW.status = OLD.status AND NEW.taken_by IS NOT DISTINCT FROM OLD.taken_by
       AND NEW.taken_at IS NOT DISTINCT FROM OLD.taken_at AND NEW.decided_by IS NOT DISTINCT FROM OLD.decided_by
       AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note
       AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
       AND NEW.new_evaluation_id IS NOT DISTINCT FROM OLD.new_evaluation_id THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'appeals: decided appeal is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'new' AND NEW.status IN ('in_review', 'upheld', 'corrected'))
    OR (OLD.status = 'in_review' AND NEW.status IN ('upheld', 'corrected'))) THEN
    RAISE EXCEPTION 'appeals: transition % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""


def upgrade() -> None:
    op.add_column("appeals", sa.Column("reason_redacted_at", TS))
    op.alter_column("appeals", "reason", existing_type=sa.String(500), nullable=True)
    op.drop_constraint("ck_appeals_reason", "appeals", type_="check")
    op.create_check_constraint(
        "ck_appeals_reason", "appeals",
        "(reason IS NOT NULL AND reason_redacted_at IS NULL AND char_length(reason) BETWEEN 1 AND 500) "
        "OR (reason IS NULL AND reason_redacted_at IS NOT NULL AND status IN ('upheld','corrected'))")
    op.create_index("ix_appeals_reason_retention", "appeals", ["decided_at"],
                    postgresql_where=sa.text("reason IS NOT NULL AND decided_at IS NOT NULL"))
    op.execute(GUARD_V2)


def downgrade() -> None:
    # стёртый текст не восстановить: откат помечает его заглушкой (NOT NULL прежней схемы)
    op.drop_constraint("ck_appeals_reason", "appeals", type_="check")
    op.execute("ALTER TABLE appeals DISABLE TRIGGER appeals_guard")
    op.execute("UPDATE appeals SET reason = '—' WHERE reason IS NULL")
    op.execute("ALTER TABLE appeals ENABLE TRIGGER appeals_guard")
    op.execute(GUARD_V1)
    op.drop_index("ix_appeals_reason_retention", table_name="appeals")
    op.create_check_constraint("ck_appeals_reason", "appeals", "char_length(reason) BETWEEN 1 AND 500")
    op.alter_column("appeals", "reason", existing_type=sa.String(500), nullable=False)
    op.drop_column("appeals", "reason_redacted_at")
