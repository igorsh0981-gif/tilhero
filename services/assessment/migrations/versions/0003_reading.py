"""спринт 5: оценка чтения — `evaluations.kind` + `reading` (вопросы к тексту по ключам версии, встроенная рубрика
`reading-comprehension`, practice_only)

Откат удаляет оценки чтения (и QA-флаги к ним): старый CHECK их не допускает. Апелляций у них нет (practice_only).

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-20
"""
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

KINDS_V1 = "kind IN ('lesson','scenario','media','review')"
KINDS_V2 = "kind IN ('lesson','scenario','media','review','reading')"


def upgrade() -> None:
    op.drop_constraint("ck_evaluations_kind", "evaluations", type_="check")
    op.create_check_constraint("ck_evaluations_kind", "evaluations", KINDS_V2)


def downgrade() -> None:
    op.execute("DELETE FROM flags WHERE evaluation_id IN (SELECT evaluation_id FROM evaluations WHERE kind = 'reading')")
    op.execute("DELETE FROM evaluations WHERE kind = 'reading'")
    op.drop_constraint("ck_evaluations_kind", "evaluations", type_="check")
    op.create_check_constraint("ck_evaluations_kind", "evaluations", KINDS_V1)
