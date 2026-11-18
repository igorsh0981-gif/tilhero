"""seed: miniapp 1.0.0 (текущая, тема «Тетрадь»), admin 1.0.0

Данные самодостаточны (не импортируют код сервиса): миграция не должна меняться при эволюции кода.
Значения токенов Mini App — согласованный прототип TilHero (Main.dc.html, `.app`: бумага, сетка, чернила, ручка,
маркер, поля; радиусы карточки 14px, кнопки и поля 12px, шторки 22px, поле экрана 18px; шрифты Onest / Unbounded /
Caveat), набор — allowlist санитайзера Mini App (packages/ui-tokens/token-names.json). Admin — Admin.dc.html (`.ad`),
разделы меню — NAV прототипа.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-18
"""
import hashlib
import json
import uuid
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

SEED_NS = uuid.UUID("5a0c3e1d-7b2f-4c8e-9d61-711e7e000000")  # детерминированные id сида TilHero
SEED_ACTOR = "system:seed"
AT = datetime(2026, 11, 17, 6, 0, tzinfo=UTC)

# «Тетрадь» 1.0.0 (светлая): бумага в клетку, синяя ручка, жёлтый маркер, розовые поля
MINIAPP_TOKENS = {
    "--paper": "#FBFCFE", "--grid": "#E8ECF5", "--ink": "#1C2340", "--ink2": "#4A5272", "--line": "#E1E6F2",
    "--card": "#FFFFFF", "--pen": "#2F4BE0", "--pen-ink": "#FFFFFF", "--pen-soft": "#E9EDFF", "--mark": "#FFE45C",
    "--margin": "#F2A7B0", "--err": "#C8323C", "--err-soft": "#FDECEE", "--ok": "#1E7A4F", "--ok-soft": "#E3F3EA",
    "--warn": "#8F5300", "--warn-soft": "#FFF1D6", "--scrim": "rgba(18,22,44,.45)",
    "--r-card": "14px", "--r-btn": "12px", "--r-field": "12px", "--r-sheet": "22px", "--gutter": "18px",
    "--font-display": "Unbounded", "--font-body": "Onest", "--font-hand": "Caveat",
}
SECTIONS = [
    {"type": "today_plan", "key": "today_plan", "variant": "large", "enabled": True},
    {"type": "lesson_of_day", "key": "lesson_of_day", "variant": "large", "enabled": True},
    {"type": "review", "key": "review", "variant": "compact", "enabled": True},
    {"type": "whats_new", "key": "whats_new", "variant": "compact", "enabled": True},
    {"type": "family", "key": "family", "variant": "compact", "enabled": True},
    {"type": "news", "key": "news", "variant": "compact", "enabled": True},
]
# whats_new_on_login — шторка «Что нового» при входе; voice_lesson — голосовой урок (спринт 4)
FLAGS = {"whats_new_on_login": True, "news": True, "family_invites": True, "uz_ui": True, "voice_lesson": False}

MINIAPP_100 = {
    "theme": {"id": "notebook", "version": "1.0.0", "tokens": MINIAPP_TOKENS},
    "home": {"sections": SECTIONS},
    "flags": FLAGS,
}

ADMIN_100 = {
    "theme": {"id": "admin_light", "version": "1.0.0", "tokens": {
        "--bg": "#F4F6FB", "--card": "#FFFFFF", "--ink": "#1C2340", "--ink2": "#4A5272", "--line": "#E1E6F2",
        "--pen": "#2F4BE0", "--pen-soft": "#E9EDFF", "--side": "#1C2340", "--side2": "#B9C0DA",
        "--ok": "#1E7A4F", "--ok-soft": "#E3F3EA", "--warn": "#8F5300", "--warn-soft": "#FFF1D6",
        "--err": "#C8323C", "--err-soft": "#FDECEE",
        "--r-card": "14px", "--r-btn": "10px", "--r-field": "10px", "--nav-w": "236px",
        "--font-ui": "Onest,system-ui,sans-serif",
        "--font-display": "Unbounded,sans-serif",
        "--font-mono": "ui-monospace,SFMono-Regular,Menlo,monospace",
    }},
    "layout": {
        "density": "compact",
        "menu": [{"id": m, "enabled": True} for m in (
            "overview", "users", "content", "agents", "qa", "costs", "heroes", "game", "events", "news", "support",
            "config", "langs", "roles", "audit")],
    },
    "flags": {},
}

# (app, version, payload, change_note, activation reason)
SEED = [
    ("miniapp", "1.0.0", MINIAPP_100, "Тема «Тетрадь» 1.0: бумага в клетку, синяя ручка, главная с планом на сегодня",
     "Первая версия TilHero"),
    ("admin", "1.0.0", ADMIN_100, "Админка 1.0: светлая тема, компактная плотность, все разделы меню",
     "Первая версия админки TilHero"),
]


def _checksum(payload: dict) -> str:
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def upgrade() -> None:
    versions = sa.table(
        "config_versions",
        sa.column("id", pg.UUID(as_uuid=True)), sa.column("app", sa.String), sa.column("version", sa.String),
        sa.column("payload", pg.JSONB), sa.column("checksum", sa.String), sa.column("change_note", sa.Text),
        sa.column("created_by", sa.String), sa.column("created_at", sa.DateTime(timezone=True)),
    )
    activations = sa.table(
        "activations",
        sa.column("id", pg.UUID(as_uuid=True)), sa.column("app", sa.String), sa.column("version", sa.String),
        sa.column("previous_version", sa.String), sa.column("kind", sa.String), sa.column("reason", sa.Text),
        sa.column("activated_by", sa.String), sa.column("activated_at", sa.DateTime(timezone=True)),
    )
    for app, version, payload, note, reason in SEED:
        op.bulk_insert(versions, [{
            "id": uuid.uuid5(SEED_NS, f"version:{app}:{version}"), "app": app, "version": version,
            "payload": payload, "checksum": _checksum(payload), "change_note": note, "created_by": SEED_ACTOR,
            "created_at": AT,
        }])
        op.bulk_insert(activations, [{
            "id": uuid.uuid5(SEED_NS, f"activation:{app}:{version}"), "app": app, "version": version,
            "previous_version": None, "kind": "activate", "reason": reason, "activated_by": SEED_ACTOR,
            "activated_at": AT,
        }])


def downgrade() -> None:
    # Таблицы append-only: снимаем триггеры на время удаления сида (только владелец схемы).
    for table in ("activations", "config_versions"):
        op.execute(f"ALTER TABLE {table} DISABLE TRIGGER {table}_no_update")
    op.execute(sa.text("DELETE FROM activations WHERE activated_by = :a").bindparams(a=SEED_ACTOR))
    op.execute(sa.text("DELETE FROM config_versions WHERE created_by = :a").bindparams(a=SEED_ACTOR))
    for table in ("activations", "config_versions"):
        op.execute(f"ALTER TABLE {table} ENABLE TRIGGER {table}_no_update")
