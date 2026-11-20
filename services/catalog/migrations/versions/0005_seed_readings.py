"""seed: тексты для чтения (спринт 5) — опубликованные v1 из migrations/seed/readings.json и статьи словаря курса

Как 0003: весь набор проверяется как опубликованный (схема ReadingPayload, 60–250 слов, предложения ≤ 30 слов,
глоссарий 3..20 и каждая статья в тексте, вопросы 3..8 с корректными ответами, переводы RU/UZ, детский текст — только
[kids], навыки опубликованы) и при ошибке миграция падает со списком. Автор и проверяющий — seed-UUID, локализации
«проверено: сид» (нужна вычитка UZ носителем); аудит `content.published` от system и событие
catalog.version.published.v1 (kind reading) — через outbox. Для каждого опубликованного текста строятся статьи course
из его глоссария (как при публикации). Нет файла `readings.json` (и каталога `readings/`) — ничего не загружается.
Повтор с тем же содержимым ничего не меняет.

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-20
"""
from pathlib import Path
from typing import Any

from alembic import op

from tilhero_catalog.domain.common import local_today, utcnow
from tilhero_catalog.domain.glossary_build import build_for_version
from tilhero_catalog.domain.seed import (
    READINGS_NOTE,
    READINGS_REASON,
    apply_seed,
    load_readings,
    remove_readings_seed,
)
from tilhero_catalog.settings import Settings, get_settings

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

SEED_DIR = Path(__file__).resolve().parents[1] / "seed"


def _settings() -> Settings:
    settings = op.get_context().config.attributes.get("settings")
    return settings if isinstance(settings, Settings) else get_settings()


def upgrade() -> None:
    settings = _settings()
    entries = load_readings(Path(settings.seed_dir) if settings.seed_dir else SEED_DIR)
    if not entries:
        return
    conn = op.get_bind()
    now = utcnow()

    def glossary(kind: str, key: str, version: int, payload: dict[str, Any]) -> None:
        build_for_version(conn, kind, key, version, payload, by=None, now=now, reason=READINGS_REASON)

    apply_seed(conn, entries, today=local_today(settings.timezone, now),
               external_sources=settings.media_external_sources, now=now, note=READINGS_NOTE,
               reason=READINGS_REASON, on_published=glossary)


def downgrade() -> None:
    remove_readings_seed(op.get_bind())
