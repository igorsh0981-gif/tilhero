"""ревью R1-02/R1-15: причина `cost_limit` в учёте вызовов; independent_evaluator v2 (параметры вызова) и золотой
кейс «ребёнок → refused» из накладки сида migrations/seed/0003/

- `usage.reason` дополнен `cost_limit` (лимит версии на вызов отличается от бюджета — ai.ts AgentUnavailableReason).
- v1 оценщика опубликована миграцией 0002 и неизменяема (триггер agent_versions_guard) → новые параметры
  (max_output_tokens 600, max_cost_usd 0.03, timeout_ms 12 000; тексты — как у v1) публикуются новой версией тем же
  загрузчиком сида (проверка набора, автор seed, аудит `ai.version_published`); v1 → archived, откат сотрудником —
  `POST /agents/independent_evaluator/rollback`. Версии сотрудников сид не трогает.
- Кейс `ie-19-kids-refused` (обязательный) — набор обязательных кейсов меняется, прежние прогоны оценщика устаревают.
- Накладка ищется в `<SEED_DIR>/0003` (по умолчанию — migrations/seed/0003); нет каталога — только CHECK.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-19
"""
from datetime import UTC, datetime
from pathlib import Path

from alembic import op

from tilhero_ai_gateway.domain.seed import apply_seed, load_seed_dir, revert_overlay
from tilhero_ai_gateway.settings import Settings, get_settings

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

SEED_DIR = Path(__file__).resolve().parents[1] / "seed"
REASONS_V2 = ("'ai_disabled', 'budget_exceeded', 'cost_limit', 'provider_error', 'timeout', 'invalid_output', "
              "'kids_not_allowed', 'agent_not_active'")
REASONS_V1 = ("'ai_disabled', 'budget_exceeded', 'provider_error', 'timeout', 'invalid_output', 'kids_not_allowed', "
              "'agent_not_active'")


def _overlay_dir() -> Path:
    settings = op.get_context().config.attributes.get("settings")
    settings = settings if isinstance(settings, Settings) else get_settings()
    root = Path(settings.seed_dir) if settings.seed_dir else SEED_DIR
    return root / revision


def upgrade() -> None:
    op.drop_constraint("ck_usage_reason", "usage", type_="check")
    op.create_check_constraint("ck_usage_reason", "usage", f"reason IS NULL OR reason IN ({REASONS_V2})")
    apply_seed(op.get_bind(), load_seed_dir(_overlay_dir()), datetime.now(UTC))


def downgrade() -> None:
    revert_overlay(op.get_bind(), load_seed_dir(_overlay_dir()))
    op.execute("UPDATE usage SET reason = 'budget_exceeded' WHERE reason = 'cost_limit'")
    op.drop_constraint("ck_usage_reason", "usage", type_="check")
    op.create_check_constraint("ck_usage_reason", "usage", f"reason IS NULL OR reason IN ({REASONS_V1})")
