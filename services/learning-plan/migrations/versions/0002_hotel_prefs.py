"""preference_profiles.hotel_prefs — настройки отеля в профиле (исправление 6.3)

Минимальная оценка гостей, максимальное расстояние до площадки, минимальные звёзды. null в поле — значение по
умолчанию (оценка — из experience-config, расстояние — 5 км, звёзды — любые): существующие профили получают все null,
расчёт поездки у них не меняется.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-12
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

_DEFAULT = '{"rating_min": null, "max_distance_km": null, "min_stars": null}'


def upgrade() -> None:
    op.add_column(
        "preference_profiles",
        sa.Column("hotel_prefs", pg.JSONB(), nullable=False, server_default=sa.text(f"'{_DEFAULT}'::jsonb")),
    )
    op.create_check_constraint("ck_pref_hotel", "preference_profiles", "jsonb_typeof(hotel_prefs) = 'object'")


def downgrade() -> None:
    op.drop_constraint("ck_pref_hotel", "preference_profiles", type_="check")
    op.drop_column("preference_profiles", "hotel_prefs")
