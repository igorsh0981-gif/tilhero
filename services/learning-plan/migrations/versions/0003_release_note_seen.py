"""preference_profiles.last_seen_release_note_* — «Что нового» просмотрено (доработка 9.4)

Последняя просмотренная заметка о релизе (id + время её публикации в experience-config): шторка «Что нового»
не показывается повторно на любом устройстве пользователя. Поля живут в строке профиля, поэтому сага удаления
(ADR-009, `delete_user_data`) стирает их вместе с профилем — отдельного шага удаления не нужно.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-08
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("preference_profiles", sa.Column("last_seen_release_note_id", pg.UUID(as_uuid=True)))
    op.add_column("preference_profiles", sa.Column("last_seen_release_note_at", sa.DateTime(timezone=True)))
    op.create_check_constraint(
        "ck_pref_release_seen", "preference_profiles",
        "(last_seen_release_note_id IS NULL) = (last_seen_release_note_at IS NULL)",
    )


def downgrade() -> None:
    op.drop_constraint("ck_pref_release_seen", "preference_profiles", type_="check")
    op.drop_column("preference_profiles", "last_seen_release_note_at")
    op.drop_column("preference_profiles", "last_seen_release_note_id")
