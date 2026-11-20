"""спринт 5: оценка произношения (модели речи с ценой часа аудио, учёт audio_ms), реестр агентов
(spaced_repetition_coach — code/memory, pronunciation_coach — code/ai-gateway), teaching_coach v2 с gloss_word
(черновик из накладки сида migrations/seed/0004/ + обязательные золотые кейсы)

- `models`: + `audio_usd_per_hour` (речь — $ за час аудио, LLM — NULL), провайдеры + `azure_speech | fake_speech`
  (у речи цены токенов 0); сид `azure-speech-pa` 1.32 (решение владельца 20.11.2026) и `fake-speech` 0.
- `usage`: + `audio_ms`; провайдеры речи; `session_kind` + `reading | memory`; причина + `not_configured`; вызов
  речи без оценки — `status ok` с причиной `not_recognized | low_confidence | incomplete` (insufficient_evidence).
- `agents`: два агента спринта 5 становятся `code`/`active`; их пустая маршрутизация версий (`agent_rollout`)
  удаляется (у кода версий инструкций нет; версии, если были, не трогаются).
- teaching_coach v2 — **черновик** автора seed (публикация — после прогона золотых тестов: prod — на anthropic
  сотрудником, dev/e2e-стенд — автоматически на fake при старте, domain/stand.py). Если у агента уже есть черновик
  сотрудника — v2 не создаётся (предупреждение; удалить черновик и повторить `alembic upgrade`). Кейсы gloss_word
  (6 обязательных) меняют набор обязательных кейсов — прежние прогоны teaching_coach устаревают.
- Накладка ищется в `<SEED_DIR>/0004` (по умолчанию — migrations/seed/0004); нет каталога — только схема и реестр.

Откат: черновик/версия v2 и кейсы накладки удаляются (опубликованной снова становится прежняя), агенты и их
маршрутизация — как в спринте 4; вызовы речи в `usage` удаляются (их нельзя выразить прежней схемой), прочие
приводятся к прежним значениям; модели речи и столбцы удаляются.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-20
"""
from datetime import UTC, datetime
from pathlib import Path

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

from tilhero_ai_gateway.domain.registry import AGENTS, AGENTS_SPRINT4, SPEECH_MODELS, SPRINT5_CODE_AGENTS
from tilhero_ai_gateway.domain.seed import apply_seed_drafts, load_seed_dir, revert_overlay
from tilhero_ai_gateway.settings import Settings, get_settings

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

SEED_DIR = Path(__file__).resolve().parents[1] / "seed"
SEED_ACTOR = "00000000-0000-4000-a000-000000005eed"
# снимки ограничений (миграция не зависит от будущих правок models.py)
REASONS_V3 = ("'ai_disabled', 'budget_exceeded', 'cost_limit', 'provider_error', 'timeout', 'invalid_output', "
              "'kids_not_allowed', 'agent_not_active'")
REASONS_V4 = ("'ai_disabled', 'not_configured', 'budget_exceeded', 'cost_limit', 'provider_error', 'timeout', "
              "'invalid_output', 'kids_not_allowed', 'agent_not_active'")
INSUFFICIENT = "'not_recognized', 'low_confidence', 'incomplete'"
PROVIDERS_V4 = "'anthropic', 'fake', 'azure_speech', 'fake_speech'"
SPEECH = "'azure_speech', 'fake_speech'"
KINDS_V3 = "'lesson', 'scenario', 'media', 'review', 'golden'"
KINDS_V4 = "'lesson', 'scenario', 'media', 'review', 'reading', 'memory', 'golden'"
STATUS_REASON_V3 = "(status IN ('pending', 'ok')) = (reason IS NULL)"
STATUS_REASON_V4 = (f"(status = 'pending' AND reason IS NULL) "
                    f"OR (status = 'ok' AND (reason IS NULL OR reason IN ({INSUFFICIENT}))) "
                    f"OR (status IN ('unavailable', 'refused') AND reason IN ({REASONS_V4}))")
MODELS_KIND = (f"(provider IN ({SPEECH})) = (audio_usd_per_hour IS NOT NULL) "
               f"AND (provider NOT IN ({SPEECH}) OR (input_usd_per_mtok = 0 AND output_usd_per_mtok = 0))")

_agents = sa.table("agents", sa.column("agent_id", sa.String), sa.column("title", pg.JSONB),
                   sa.column("purpose", pg.JSONB), sa.column("implementation", sa.String),
                   sa.column("availability", sa.String), sa.column("planned_sprint", sa.Integer),
                   sa.column("free_text", sa.Boolean), sa.column("implemented_in", sa.String))
_models = sa.table("models", sa.column("model_id", sa.String), sa.column("provider", sa.String),
                   sa.column("input_usd_per_mtok", sa.Numeric), sa.column("output_usd_per_mtok", sa.Numeric),
                   sa.column("audio_usd_per_hour", sa.Numeric), sa.column("active", sa.Boolean),
                   sa.column("updated_by", sa.String))


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
    # ---------------------------------------------------------------- модели речи
    op.add_column("models", sa.Column("audio_usd_per_hour", sa.Numeric(10, 4)))
    _replace_check("models", "ck_models_provider", f"provider IN ({PROVIDERS_V4})")
    op.create_check_constraint("ck_models_audio", "models",
                               "audio_usd_per_hour IS NULL OR (audio_usd_per_hour >= 0 AND audio_usd_per_hour <= 1000)")
    op.create_check_constraint("ck_models_kind", "models", MODELS_KIND)
    existing = set(op.get_bind().execute(sa.text("SELECT model_id FROM models")).scalars().all())
    rows = [{**m, "updated_by": SEED_ACTOR} for m in SPEECH_MODELS if m["model_id"] not in existing]
    if rows:
        op.bulk_insert(_models, rows)

    # ---------------------------------------------------------------- учёт вызовов
    op.add_column("usage", sa.Column("audio_ms", sa.Integer(), nullable=False, server_default="0"))
    _replace_check("usage", "ck_usage_reason", f"reason IS NULL OR reason IN ({REASONS_V4}, {INSUFFICIENT})")
    _replace_check("usage", "ck_usage_status_reason", STATUS_REASON_V4)
    _replace_check("usage", "ck_usage_provider", f"provider IN ({PROVIDERS_V4})")
    _replace_check("usage", "ck_usage_session_kind", f"session_kind IS NULL OR session_kind IN ({KINDS_V4})")
    op.create_check_constraint("ck_usage_audio", "usage",
                               f"audio_ms BETWEEN 0 AND 60000 AND (audio_ms = 0 OR provider IN ({SPEECH}))")

    # ---------------------------------------------------------------- реестр агентов
    _set_agents(tuple(a for a in AGENTS if a["agent_id"] in SPRINT5_CODE_AGENTS))
    op.execute(sa.text("DELETE FROM agent_rollout r WHERE r.agent_id IN ('spaced_repetition_coach', "
                       "'pronunciation_coach') AND NOT EXISTS (SELECT 1 FROM agent_versions v "
                       "WHERE v.agent_id = r.agent_id)"))

    # ---------------------------------------------------------------- teaching_coach v2 (черновик) и кейсы gloss_word
    apply_seed_drafts(op.get_bind(), load_seed_dir(_overlay_dir()), datetime.now(UTC))


def downgrade() -> None:
    revert_overlay(op.get_bind(), load_seed_dir(_overlay_dir()))

    _set_agents(AGENTS_SPRINT4)
    op.execute(sa.text(f"INSERT INTO agent_rollout (agent_id, canary_percent, updated_by) "  # noqa: S608 — константы
                       f"SELECT a.agent_id, 0, '{SEED_ACTOR}' FROM agents a "
                       f"WHERE a.agent_id IN ('spaced_repetition_coach', 'pronunciation_coach') "
                       f"AND NOT EXISTS (SELECT 1 FROM agent_rollout r WHERE r.agent_id = a.agent_id)"))

    op.execute(sa.text(f"DELETE FROM usage WHERE provider IN ({SPEECH})"))  # noqa: S608 — константы
    op.execute(sa.text("UPDATE usage SET session_kind = NULL WHERE session_kind IN ('reading', 'memory')"))
    op.execute(sa.text("UPDATE usage SET reason = 'ai_disabled' WHERE reason = 'not_configured'"))
    op.execute(sa.text(f"UPDATE usage SET reason = NULL WHERE reason IN ({INSUFFICIENT})"))  # noqa: S608
    op.drop_constraint("ck_usage_audio", "usage", type_="check")
    _replace_check("usage", "ck_usage_session_kind", f"session_kind IS NULL OR session_kind IN ({KINDS_V3})")
    _replace_check("usage", "ck_usage_provider", "provider IN ('anthropic', 'fake')")
    _replace_check("usage", "ck_usage_status_reason", STATUS_REASON_V3)
    _replace_check("usage", "ck_usage_reason", f"reason IS NULL OR reason IN ({REASONS_V3})")
    op.drop_column("usage", "audio_ms")

    op.execute(sa.text(f"DELETE FROM models WHERE provider IN ({SPEECH})"))  # noqa: S608 — константы
    op.drop_constraint("ck_models_kind", "models", type_="check")
    op.drop_constraint("ck_models_audio", "models", type_="check")
    _replace_check("models", "ck_models_provider", "provider IN ('anthropic', 'fake')")
    op.drop_column("models", "audio_usd_per_hour")
