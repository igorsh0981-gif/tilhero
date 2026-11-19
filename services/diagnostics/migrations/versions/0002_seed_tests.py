"""seed: тесты диагностики из migrations/seed/*.json как опубликованные v1 (автор seed) + запись в аудит

Каждый файл проверяется тем же валидатором, что и публикация в админке (`tilhero_diagnostics.testdef`):
невалидный файл, повтор (test_id, version) или две версии на одну (пару, аудиторию) — миграция падает, ничего не
загружается. Банки заданий пишет тестолог (`dx-en-adult.v1.json` ~90 заданий, `dx-en-kids.v1.json` ~36);
сид — только авторские тексты TilHero, без ссылок.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-19
"""
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

from tilhero_common.messaging import make_envelope
from tilhero_diagnostics.testdef import TestInvalid, checksum, validate

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

SEED_DIR = Path(__file__).resolve().parents[1] / "seed"
SEED_ACTOR = "seed"
SEED_NS = uuid.UUID("5a0c3e1d-7b2f-4c8e-9d61-d1a900000000")  # детерминированные id сида diagnostics
AT = datetime(2026, 11, 19, 6, 0, tzinfo=UTC)


def load_seed(seed_dir: Path = SEED_DIR) -> list[dict]:
    """Файлы сида → проверенные тела тестов (порядок — по имени файла). Любая ошибка — RuntimeError."""
    files = sorted(seed_dir.glob("*.json"))
    if not files:
        raise RuntimeError(f"diagnostics seed: no *.json in {seed_dir}")
    tests: list[dict] = []
    seen: set[tuple[str, int]] = set()
    audiences: set[tuple[str, str]] = set()
    for path in files:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"diagnostics seed {path.name}: not a JSON file ({type(exc).__name__})") from None
        try:
            test = validate(raw)
        except TestInvalid as exc:
            head = "; ".join(f"{e['path']}: {e['code']}" for e in exc.errors[:10])
            raise RuntimeError(f"diagnostics seed {path.name}: {len(exc.errors)} error(s): {head}") from None
        if (test.test_id, test.version) in seen:
            raise RuntimeError(f"diagnostics seed {path.name}: duplicate {test.ref}")
        if (test.pair_id, test.audience) in audiences:
            raise RuntimeError(f"diagnostics seed {path.name}: second test for {test.pair_id}/{test.audience}")
        seen.add((test.test_id, test.version))
        audiences.add((test.pair_id, test.audience))
        tests.append(raw)
    return tests


def upgrade() -> None:
    tests = sa.table(
        "tests",
        sa.column("test_id", sa.String), sa.column("version", sa.Integer), sa.column("status", sa.String),
        sa.column("pair_id", sa.String), sa.column("audience", sa.String), sa.column("config", pg.JSONB),
        sa.column("items", pg.JSONB), sa.column("checksum", sa.String), sa.column("created_by", sa.String),
        sa.column("created_at", sa.DateTime(timezone=True)), sa.column("published_at", sa.DateTime(timezone=True)),
        sa.column("published_by", sa.String),
    )
    outbox = sa.table(
        "outbox",
        sa.column("id", pg.UUID(as_uuid=False)), sa.column("event_type", sa.String), sa.column("envelope", pg.JSONB),
    )
    for raw in load_seed():
        ref = f"{raw['test_id']}@{raw['version']}"
        digest = checksum({"config": raw["config"], "items": raw["items"]})
        op.bulk_insert(tests, [{
            "test_id": raw["test_id"], "version": raw["version"], "status": "published", "pair_id": raw["pair_id"],
            "audience": raw["audience"], "config": raw["config"], "items": raw["items"], "checksum": digest,
            "created_by": SEED_ACTOR, "created_at": AT, "published_at": AT, "published_by": SEED_ACTOR,
        }])
        env = make_envelope("admin.audit.recorded.v1", {
            "record_id": str(uuid.uuid5(SEED_NS, f"audit:{ref}")),
            "occurred_at": AT.isoformat().replace("+00:00", "Z"),
            "actor_type": "system",
            "actor_id": SEED_ACTOR,
            "actor_role": None,
            "action": "diagnostics.test_published",
            "object_type": "diagnostic_test",
            "object_id": ref,
            "before": None,
            "after": {"version": raw["version"], "items": len(raw["items"]), "checksum": digest},
            "reason": "Сид спринта 3",
        }, producer="diagnostics", correlation_id=f"seed-{raw['test_id']}"[:64])
        op.bulk_insert(outbox, [{"id": env.event_id, "event_type": env.event_type,
                                 "envelope": env.model_dump(mode="json")}])


def downgrade() -> None:
    # Опубликованные версии неизменяемы: триггер снимается на время удаления сида (только владелец схемы)
    op.execute("ALTER TABLE tests DISABLE TRIGGER tests_guard")
    op.execute(sa.text("DELETE FROM tests WHERE created_by = :a").bindparams(a=SEED_ACTOR))
    op.execute("ALTER TABLE tests ENABLE TRIGGER tests_guard")
