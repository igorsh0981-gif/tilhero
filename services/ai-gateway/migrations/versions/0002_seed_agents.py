"""seed: версии v1 (опубликованные) и золотые тесты LLM-агентов спринта из migrations/seed/ с полной проверкой

Файлы пишет автор инструкций (PLAN поток G): `agents/<agent_id>.v1.json` (тело версии ai.ts AgentVersion) и
`golden/<agent_id>.json` (массив кейсов). Миграция проверяет весь набор (поля и пределы, JSON Schema вывода —
поддерживаемое подмножество, модели, контексты по ai.ts, проверки GoldenCheck) и падает со списком ошибок, если он
невалиден. Публикует системный автор seed с аудитом `ai.version_published` через outbox. Повторный прогон с тем же
содержимым ничего не меняет; откат удаляет только записи сида (см. tilhero_ai_gateway.domain.seed).

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-19
"""
from datetime import UTC, datetime
from pathlib import Path

from alembic import op

from tilhero_ai_gateway.domain.seed import apply_seed, load_seed_dir, remove_seed
from tilhero_ai_gateway.settings import Settings, get_settings

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

SEED_DIR = Path(__file__).resolve().parents[1] / "seed"


def _settings() -> Settings:
    settings = op.get_context().config.attributes.get("settings")
    return settings if isinstance(settings, Settings) else get_settings()


def upgrade() -> None:
    settings = _settings()
    seed_dir = Path(settings.seed_dir) if settings.seed_dir else SEED_DIR
    apply_seed(op.get_bind(), load_seed_dir(seed_dir), datetime.now(UTC))


def downgrade() -> None:
    remove_seed(op.get_bind())
