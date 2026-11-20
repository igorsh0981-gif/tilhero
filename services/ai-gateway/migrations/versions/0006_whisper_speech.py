"""релиз 5.1 (решение владельца 20.11.2026): оценка произношения на своём сервере — провайдер `whisper`

Распознавание — сервис tts (faster-whisper, модель в образе), сравнение с эталоном — ai-gateway. Провайдер `whisper`
в `models` и `usage` (речь: цена часа аудио, токенов нет), сид модели `whisper-base-en` (0 $ — бюджеты ИИ не тратит).
Azure (`azure-speech-pa`) остаётся запасным провайдером.

Откат: вызовы `whisper` из `usage` удаляются (прежней схемой их не выразить), модель — тоже.

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-20
"""
import sqlalchemy as sa
from alembic import op

from tilhero_ai_gateway.domain.registry import WHISPER_MODEL

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

SEED_ACTOR = "00000000-0000-4000-a000-000000005eed"
PROVIDERS_V5 = "'anthropic', 'fake', 'azure_speech', 'fake_speech'"
PROVIDERS_V6 = "'anthropic', 'fake', 'whisper', 'azure_speech', 'fake_speech'"
SPEECH_V5 = "'azure_speech', 'fake_speech'"
SPEECH_V6 = "'whisper', 'azure_speech', 'fake_speech'"

_models = sa.table("models", sa.column("model_id", sa.String), sa.column("provider", sa.String),
                   sa.column("input_usd_per_mtok", sa.Numeric), sa.column("output_usd_per_mtok", sa.Numeric),
                   sa.column("audio_usd_per_hour", sa.Numeric), sa.column("active", sa.Boolean),
                   sa.column("updated_by", sa.String))


def _models_kind(speech: str) -> str:
    return (f"(provider IN ({speech})) = (audio_usd_per_hour IS NOT NULL) "
            f"AND (provider NOT IN ({speech}) OR (input_usd_per_mtok = 0 AND output_usd_per_mtok = 0))")


def _usage_audio(speech: str) -> str:
    return f"audio_ms BETWEEN 0 AND 60000 AND (audio_ms = 0 OR provider IN ({speech}))"


def _replace_check(table: str, name: str, sql: str) -> None:
    op.drop_constraint(name, table, type_="check")
    op.create_check_constraint(name, table, sql)


def upgrade() -> None:
    _replace_check("models", "ck_models_provider", f"provider IN ({PROVIDERS_V6})")
    _replace_check("models", "ck_models_kind", _models_kind(SPEECH_V6))
    _replace_check("usage", "ck_usage_provider", f"provider IN ({PROVIDERS_V6})")
    _replace_check("usage", "ck_usage_audio", _usage_audio(SPEECH_V6))
    exists = op.get_bind().execute(sa.text("SELECT 1 FROM models WHERE model_id = :m"),
                                   {"m": WHISPER_MODEL["model_id"]}).first()
    if exists is None:
        op.bulk_insert(_models, [{**WHISPER_MODEL, "updated_by": SEED_ACTOR}])


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM usage WHERE provider = 'whisper'"))
    op.execute(sa.text("DELETE FROM models WHERE provider = 'whisper'"))
    _replace_check("usage", "ck_usage_audio", _usage_audio(SPEECH_V5))
    _replace_check("usage", "ck_usage_provider", f"provider IN ({PROVIDERS_V5})")
    _replace_check("models", "ck_models_kind", _models_kind(SPEECH_V5))
    _replace_check("models", "ck_models_provider", f"provider IN ({PROVIDERS_V5})")
