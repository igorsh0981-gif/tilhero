"""спринт 7 (INTERNAL_API §4): агенты социального контура, бюджет парной комнаты, виды сессий duel и pair

- `agents`: `cooperative_lesson_coach` → `llm`/`active` (свободный текст: детям — отказ); `duel_host` → `code`/`active`,
  `implemented_in = lessons` (набор дуэли кодом); `referral_integrity_reviewer` → `rules`/`active`,
  `implemented_in = social` (квалификация реферала правилами). Пустая маршрутизация версий двух не-LLM агентов
  удаляется (версии, если были, не трогаются) — как у code-агентов 0004/0007.
- `cooperative_lesson_coach` v1 — **черновик** автора seed из накладки `<SEED_DIR>/0008` (инструкции по скиллу 11,
  схема вывода `CooperativeCoachOutput`) и 8 обязательных золотых кейсов. Публикует владелец после прогона на
  anthropic; на dev/e2e-стенде (fake + AI_ALLOW_FAKE_TEST_PUBLISH) — сам шлюз при старте (domain/stand.py). До
  публикации вызов → `refused: agent_not_active` (lessons ведёт комнату по сценарию с выбором реплик). Черновик
  сотрудника у агента уже есть — v1 сида не создаётся (предупреждение в лог миграции).
- `budget.room_cap_usd` — потолок вызовов коуча на одну парную комнату, 0,10 $ (не больше потолка месяца; CHECK).
- `usage.session_kind` + `duel` (для полноты: ИИ в дуэли не вызывается), `pair` (коуч и распознавание голосового
  хода комнаты, session_id = room_id).

Откат: черновик/версия и кейсы накладки удаляются, строки реестра и маршрутизация — как в спринте 6, вызовы с видом
`duel`/`pair` получают `session_kind = NULL` (прежней схемой их не выразить), столбец потолка комнаты удаляется.

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-21
"""
from datetime import UTC, datetime
from pathlib import Path

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

from tilhero_ai_gateway.domain.registry import AGENTS, AGENTS_SPRINT6, ROOM_CAP_DEFAULT, SPRINT7_AGENTS
from tilhero_ai_gateway.domain.seed import apply_seed_drafts, load_seed_dir, revert_overlay
from tilhero_ai_gateway.settings import Settings, get_settings

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

SEED_DIR = Path(__file__).resolve().parents[1] / "seed"
SEED_ACTOR = "00000000-0000-4000-a000-000000005eed"
# снимки ограничений (миграция не зависит от будущих правок models.py)
KINDS_V7 = "'lesson', 'scenario', 'media', 'review', 'reading', 'memory', 'golden'"
KINDS_V8 = "'lesson', 'scenario', 'media', 'review', 'reading', 'duel', 'memory', 'pair', 'golden'"
NOT_LLM = ("duel_host", "referral_integrity_reviewer")

_agents = sa.table("agents", sa.column("agent_id", sa.String), sa.column("title", pg.JSONB),
                   sa.column("purpose", pg.JSONB), sa.column("implementation", sa.String),
                   sa.column("availability", sa.String), sa.column("planned_sprint", sa.Integer),
                   sa.column("free_text", sa.Boolean), sa.column("implemented_in", sa.String))


def _overlay_dir() -> Path:
    settings = op.get_context().config.attributes.get("settings")
    settings = settings if isinstance(settings, Settings) else get_settings()
    root = Path(settings.seed_dir) if settings.seed_dir else SEED_DIR
    return root / revision


def _replace_check(table: str, name: str, sql: str) -> None:
    op.drop_constraint(name, table, type_="check")
    op.create_check_constraint(name, table, sql)


def _set_agents(rows: tuple[dict, ...]) -> None:
    for row in rows:
        op.get_bind().execute(_agents.update().where(_agents.c.agent_id == row["agent_id"]).values(
            title=row["title"], purpose=row["purpose"], implementation=row["implementation"],
            availability=row["availability"], planned_sprint=row["planned_sprint"], free_text=row["free_text"],
            implemented_in=row["implemented_in"]))


def upgrade() -> None:
    # ---------------------------------------------------------------- бюджет комнаты
    op.add_column("budget", sa.Column("room_cap_usd", sa.Numeric(10, 4), nullable=False,
                                      server_default=ROOM_CAP_DEFAULT))
    # потолок месяца меньше 0,10 $ (правка сотрудника) — потолок комнаты не больше него
    op.execute("UPDATE budget SET room_cap_usd = LEAST(room_cap_usd, monthly_cap_usd)")
    op.create_check_constraint("ck_budget_room", "budget", "room_cap_usd >= 0 AND room_cap_usd <= monthly_cap_usd")

    # ---------------------------------------------------------------- виды сессий
    _replace_check("usage", "ck_usage_session_kind", f"session_kind IS NULL OR session_kind IN ({KINDS_V8})")

    # ---------------------------------------------------------------- реестр агентов
    _set_agents(tuple(a for a in AGENTS if a["agent_id"] in SPRINT7_AGENTS))
    op.execute(sa.text("DELETE FROM agent_rollout r WHERE r.agent_id IN ('duel_host', 'referral_integrity_reviewer') "
                       "AND NOT EXISTS (SELECT 1 FROM agent_versions v WHERE v.agent_id = r.agent_id)"))

    # ---------------------------------------------------------------- cooperative_lesson_coach v1 (черновик) и кейсы
    apply_seed_drafts(op.get_bind(), load_seed_dir(_overlay_dir()), datetime.now(UTC))


def downgrade() -> None:
    revert_overlay(op.get_bind(), load_seed_dir(_overlay_dir()))

    _set_agents(AGENTS_SPRINT6)
    op.execute(sa.text(f"INSERT INTO agent_rollout (agent_id, canary_percent, updated_by) "  # noqa: S608 — константы
                       f"SELECT a.agent_id, 0, '{SEED_ACTOR}' FROM agents a "
                       f"WHERE a.agent_id IN ('duel_host', 'referral_integrity_reviewer') "
                       f"AND NOT EXISTS (SELECT 1 FROM agent_rollout r WHERE r.agent_id = a.agent_id)"))

    op.execute(sa.text("UPDATE usage SET session_kind = NULL WHERE session_kind IN ('duel', 'pair')"))
    _replace_check("usage", "ck_usage_session_kind", f"session_kind IS NULL OR session_kind IN ({KINDS_V7})")

    op.drop_constraint("ck_budget_room", "budget", type_="check")
    op.drop_column("budget", "room_cap_usd")
