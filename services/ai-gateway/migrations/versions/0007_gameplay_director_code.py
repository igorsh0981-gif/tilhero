"""спринт 6 (INTERNAL_API спринта 6 §7, PLAN «Требования LinguaFlow 1.2»): реестр агентов — `gameplay_director`
становится `code`/`active`, реализован в gamification (правила игры кодом: XP и тилы за подтверждённые действия,
задания дня, значки, ступени героя). Вызовов модели нет: версий инструкций у агента нет, его пустая маршрутизация
версий (`agent_rollout`) удаляется (версии, если были, не трогаются) — как у code-агентов спринта 5 (0004).

Откат: строка реестра — как в спринте 5 (`llm`/`planned`, спринт 6), пустая маршрутизация версий возвращается.

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-20
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

from tilhero_ai_gateway.domain.registry import AGENTS, AGENTS_SPRINT5, SPRINT6_CODE_AGENTS

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

SEED_ACTOR = "00000000-0000-4000-a000-000000005eed"

_agents = sa.table("agents", sa.column("agent_id", sa.String), sa.column("title", pg.JSONB),
                   sa.column("purpose", pg.JSONB), sa.column("implementation", sa.String),
                   sa.column("availability", sa.String), sa.column("planned_sprint", sa.Integer),
                   sa.column("free_text", sa.Boolean), sa.column("implemented_in", sa.String))


def _set_agents(rows: tuple[dict, ...]) -> None:
    for row in rows:
        op.get_bind().execute(_agents.update().where(_agents.c.agent_id == row["agent_id"]).values(
            title=row["title"], purpose=row["purpose"], implementation=row["implementation"],
            availability=row["availability"], planned_sprint=row["planned_sprint"], free_text=row["free_text"],
            implemented_in=row["implemented_in"]))


def upgrade() -> None:
    _set_agents(tuple(a for a in AGENTS if a["agent_id"] in SPRINT6_CODE_AGENTS))
    op.execute(sa.text("DELETE FROM agent_rollout r WHERE r.agent_id = 'gameplay_director' "
                       "AND NOT EXISTS (SELECT 1 FROM agent_versions v WHERE v.agent_id = r.agent_id)"))


def downgrade() -> None:
    _set_agents(AGENTS_SPRINT5)
    op.execute(sa.text(f"INSERT INTO agent_rollout (agent_id, canary_percent, updated_by) "  # noqa: S608 — константы
                       f"SELECT a.agent_id, 0, '{SEED_ACTOR}' FROM agents a WHERE a.agent_id = 'gameplay_director' "
                       f"AND NOT EXISTS (SELECT 1 FROM agent_rollout r WHERE r.agent_id = a.agent_id)"))
