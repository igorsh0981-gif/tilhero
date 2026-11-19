"""seed: справочник языков (en, ru, uz, kk) и языковых пар (ru-en published с курсом en-core; остальные planned)

Данные самодостаточны (не импортируют код сервиса). Новая пара или язык добавляются записью в админке
(lang.manage) без изменения кода (ADM-LANG-01/02, AT-31).

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-19
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

SEED_ACTOR = "00000000-0000-4000-a000-000000005eed"

LANGUAGES = [
    {"code": "en", "name": {"ru": "Английский", "uz": "Ingliz tili", "en": "English"}, "script": "Latn",
     "variants": ["en-GB", "en-US"], "asr": None, "tts": {"provider": "device", "voices": ["en-GB", "en-US"]},
     "limitations": "Распознавание речи — со спринта 4; озвучка — синтез речи устройства (Web Speech API)",
     "status": "active"},
    {"code": "ru", "name": {"ru": "Русский", "uz": "Rus tili", "en": "Russian"}, "script": "Cyrl",
     "variants": [], "asr": None, "tts": None, "limitations": None, "status": "active"},
    {"code": "uz", "name": {"ru": "Узбекский", "uz": "Oʻzbek tili", "en": "Uzbek"}, "script": "Latn",
     "variants": [], "asr": None, "tts": None, "limitations": None, "status": "active"},
    {"code": "kk", "name": {"ru": "Казахский", "uz": "Qozoq tili", "en": "Kazakh"}, "script": "Cyrl",
     "variants": [], "asr": None, "tts": None, "limitations": "Курс в планах", "status": "planned"},
]

PAIRS = [
    {"pair_id": "ru-en", "source": "ru", "target": "en", "explanation_locales": ["ru"], "ui_locales": ["ru", "uz"],
     "title": {"ru": "Английский (объяснения на русском)", "uz": "Ingliz tili (izohlar rus tilida)"},
     "status": "published", "release_at": None, "course_id": "en-core"},
    {"pair_id": "ru-uz", "source": "ru", "target": "uz", "explanation_locales": ["ru"], "ui_locales": ["ru", "uz"],
     "title": {"ru": "Узбекский (объяснения на русском)", "uz": "Oʻzbek tili (izohlar rus tilida)"},
     "status": "planned", "release_at": None, "course_id": None},
    {"pair_id": "ru-kk", "source": "ru", "target": "kk", "explanation_locales": ["ru"], "ui_locales": ["ru", "uz"],
     "title": {"ru": "Казахский (объяснения на русском)", "uz": "Qozoq tili (izohlar rus tilida)"},
     "status": "planned", "release_at": None, "course_id": None},
    {"pair_id": "en-uz", "source": "en", "target": "uz", "explanation_locales": ["en"], "ui_locales": ["ru", "uz"],
     "title": {"ru": "Узбекский (объяснения на английском)", "uz": "Oʻzbek tili (izohlar ingliz tilida)"},
     "status": "planned", "release_at": None, "course_id": None},
    {"pair_id": "en-kk", "source": "en", "target": "kk", "explanation_locales": ["en"], "ui_locales": ["ru", "uz"],
     "title": {"ru": "Казахский (объяснения на английском)", "uz": "Qozoq tili (izohlar ingliz tilida)"},
     "status": "planned", "release_at": None, "course_id": None},
]


def upgrade() -> None:
    languages = sa.table(
        "languages",
        sa.column("code", sa.String), sa.column("name", pg.JSONB), sa.column("script", sa.String),
        sa.column("variants", pg.JSONB), sa.column("asr", pg.JSONB), sa.column("tts", pg.JSONB),
        sa.column("limitations", sa.Text), sa.column("status", sa.String), sa.column("updated_by", sa.String),
    )
    pairs = sa.table(
        "language_pairs",
        sa.column("pair_id", sa.String), sa.column("source", sa.String), sa.column("target", sa.String),
        sa.column("explanation_locales", pg.JSONB), sa.column("ui_locales", pg.JSONB), sa.column("title", pg.JSONB),
        sa.column("status", sa.String), sa.column("release_at", sa.String), sa.column("course_id", sa.String),
        sa.column("updated_by", sa.String),
    )
    op.bulk_insert(languages, [{**row, "updated_by": SEED_ACTOR} for row in LANGUAGES])
    op.bulk_insert(pairs, [{**row, "updated_by": SEED_ACTOR} for row in PAIRS])


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM language_pairs WHERE pair_id IN ('ru-en', 'ru-uz', 'ru-kk', 'en-uz', 'en-kk')"))
    op.execute(sa.text("DELETE FROM languages WHERE code IN ('en', 'ru', 'uz', 'kk')"))
