"""release_note_views: сегмент ученика на момент показа (ui_lang, age_segment) — разрезы статистики «Что нового»

Спринт 2 (AT-18, INTERNAL_API §3 experience-config): статистика показов заметки по языку интерфейса и возрасту.
Колонки допускают NULL: у отметок до этой миграции (и у отметок, для которых telegram-bff не передал сегмент) разрез
неизвестен — в views_by_lang / views_by_age они не учитываются, в views_total — учитываются. Без бэкфилла: сегмент
«задним числом» был бы неверным (язык и возраст ученика могли измениться).

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-18
"""
import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("release_note_views", sa.Column("ui_lang", sa.String(2), nullable=True))
    op.add_column("release_note_views", sa.Column("age_segment", sa.String(8), nullable=True))
    op.create_check_constraint("ck_release_note_views_ui_lang", "release_note_views",
                               "ui_lang IS NULL OR ui_lang IN ('ru', 'uz')")
    op.create_check_constraint("ck_release_note_views_age_segment", "release_note_views",
                               "age_segment IS NULL OR age_segment IN ('kids', 'teens', 'adults')")


def downgrade() -> None:
    op.drop_constraint("ck_release_note_views_age_segment", "release_note_views", type_="check")
    op.drop_constraint("ck_release_note_views_ui_lang", "release_note_views", type_="check")
    op.drop_column("release_note_views", "age_segment")
    op.drop_column("release_note_views", "ui_lang")
