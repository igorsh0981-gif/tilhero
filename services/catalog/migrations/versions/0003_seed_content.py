"""seed: контент курса RU→EN (en-core) — опубликованные версии из migrations/seed/*.json с полной проверкой

Сид пишут методисты (форматы content.ts); миграция проверяет весь набор как опубликованный (схема, локализации,
ссылки, циклы предпосылок, графы сценариев, права медиа) и падает со списком ошибок, если он невалиден. Автор и
проверяющий — системный seed-UUID, локализации «проверено: сид», права медиа подтверждены сидом, сценарии — с
тестовым прогоном; аудит `content.published` от system и события catalog.version.published.v1 — через outbox.
Повторный прогон с тем же содержимым ничего не меняет (см. tilhero_catalog.domain.seed).

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-19
"""
from pathlib import Path

from alembic import op

from tilhero_catalog.domain.common import local_today, utcnow
from tilhero_catalog.domain.seed import apply_seed, load_seed_dir, remove_seed
from tilhero_catalog.settings import Settings, get_settings

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

SEED_DIR = Path(__file__).resolve().parents[1] / "seed"


def _settings() -> Settings:
    settings = op.get_context().config.attributes.get("settings")
    return settings if isinstance(settings, Settings) else get_settings()


def upgrade() -> None:
    settings = _settings()
    now = utcnow()
    seed_dir = Path(settings.seed_dir) if settings.seed_dir else SEED_DIR
    apply_seed(op.get_bind(), load_seed_dir(seed_dir), today=local_today(settings.timezone, now),
               external_sources=settings.media_external_sources, now=now)


def downgrade() -> None:
    remove_seed(op.get_bind())
