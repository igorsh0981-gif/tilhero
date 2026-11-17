"""seed: черновик первой заметки «Что нового» — «Ноябрь 2026» (доработка 9.4)

Только ЧЕРНОВИК: пользователи его не видят, пока сотрудник не опубликует заметку в админке
(«Конфигурация интерфейса» → «Что нового» → «Опубликовать»). Данные самодостаточны (не импортируют код сервиса).
Тексты: изменения ноября для пользователя — исправления 9.1–9.3 (источники Алматы), 9.4 (иконка на главном экране),
новые источники Астаны и Бишкека.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-08
"""
import uuid
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

SEED_ID = uuid.uuid5(uuid.UUID("6f1d7c2e-3b0a-4f4e-9a51-a1e7e0000000"), "release_note:2026.11")
SEED_ACTOR = "system:seed"
AT = datetime(2026, 11, 8, 6, 0, tzinfo=UTC)

TITLE = {"ru": "Ноябрь 2026", "en": "November 2026"}
ITEMS = [
    {
        "icon": "pin",
        "link": "catalog",
        "title": {"ru": "Больше событий в Алматы", "en": "More events in Almaty"},
        "text": {
            "ru": "Собираем афишу с сайтов площадок и театров, из билетных касс и городских Telegram-каналов.",
            "en": "We now collect listings from venue and theatre websites, ticket offices and the city's "
                  "Telegram channels.",
        },
    },
    {
        "icon": "globe",
        "link": "catalog",
        "title": {"ru": "Новые источники в Астане и Бишкеке", "en": "New sources in Astana and Bishkek"},
        "text": {
            "ru": "Концерты, спектакли и выставки этих городов теперь тоже попадают в подборку.",
            "en": "Concerts, plays and exhibitions in these cities now show up in your picks too.",
        },
    },
    {
        "icon": "phone",
        "link": "profile",
        "title": {"ru": "TilHero на главном экране", "en": "TilHero on your Home Screen"},
        "text": {
            "ru": "Добавьте иконку на экран телефона и открывайте TilHero одной кнопкой. Кнопка — в Профиле, "
                  "нужна свежая версия Telegram.",
            "en": "Add the icon to your phone's Home Screen and open TilHero in one tap. It's in Profile; "
                  "requires an up-to-date Telegram.",
        },
    },
]


def upgrade() -> None:
    notes = sa.table(
        "release_notes",
        sa.column("id", pg.UUID(as_uuid=True)), sa.column("slug", sa.String), sa.column("title", pg.JSONB),
        sa.column("items", pg.JSONB), sa.column("audience", sa.String), sa.column("status", sa.String),
        sa.column("version", sa.Integer), sa.column("created_by", sa.String),
        sa.column("created_at", sa.DateTime(timezone=True)), sa.column("updated_by", sa.String),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )
    # ON CONFLICT DO NOTHING (тот же id или занятая метка 2026.11): после отката 0004 опубликованный сид остаётся
    # в таблице (триггер не даёт удалить не-черновик), повторный upgrade не должен падать на дубле (ревью 9.4)
    op.execute(pg.insert(notes).values(
        id=SEED_ID, slug="2026.11", title=TITLE, items=ITEMS, audience="existing", status="draft", version=1,
        created_by=SEED_ACTOR, created_at=AT, updated_by=SEED_ACTOR, updated_at=AT,
    ).on_conflict_do_nothing())


def downgrade() -> None:
    # Только если сид так и остался черновиком: опубликованную/архивную заметку триггер удалить не даст,
    # её снимет откат 0003 вместе с таблицей.
    op.execute(sa.text("DELETE FROM release_notes WHERE id = :id AND status = 'draft'").bindparams(id=SEED_ID))
