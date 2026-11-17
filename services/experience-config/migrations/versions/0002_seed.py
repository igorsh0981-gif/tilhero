"""seed: miniapp 2.0.2 (previous) → 2.0.3 (current, «тёмный премиум»), admin 1.0.0

Данные самодостаточны (не импортируют код сервиса): миграция не должна меняться при эволюции кода.
Значения токенов Mini App — тема default (packages/ui-tokens, выведена из proto/miniapp/src/01-base.css .tg),
2.0.2 — демо отката прототипа (02-screens.css .tg.cfg-old: мятный акцент, радиус карточек 14px);
Admin — proto/admin/src/02-style.css :root.
Флаги и hotel_rating_min — как CONFIG в proto/admin/src/12-data.js.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-08
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

SEED_NS = uuid.UUID("6f1d7c2e-3b0a-4f4e-9a51-a1e7e0000000")  # детерминированные id сида
SEED_ACTOR = "system:seed"

# «Тёмный премиум» 2.0.3: лайм #DFFF56 на navy. Значения = тема default Mini App (packages/ui-tokens
# themes/default.css + tokens.css, выведены из прототипа .tg), набор = allowlist санитайзера Mini App.
MINIAPP_203_TOKENS = {
    "--bg": "#090C16", "--bg-2": "#0C1120", "--surface": "#11172A", "--surface-2": "#18203A",
    "--surface-3": "#232D4E", "--line": "rgba(154,170,230,.12)", "--line-2": "rgba(154,170,230,.22)",
    "--ink": "#EEF1F8", "--ink-2": "#B3BACB", "--muted": "#8891A9",
    "--accent": "#DFFF56", "--accent-ink": "#1A2200", "--accent-tx": "#DFFF56",
    "--accent-soft": "rgba(223,255,86,.11)", "--accent-line": "rgba(223,255,86,.34)", "--focus": "#DFFF56",
    "--btn-bg": "#DFFF56", "--btn-tx": "#1A2200",
    "--good": "#59E3A0", "--good-soft": "rgba(89,227,160,.13)", "--warn": "#FFC061",
    "--warn-soft": "rgba(255,192,97,.13)", "--bad": "#FF7B7B", "--bad-soft": "rgba(255,123,123,.13)",
    "--info": "#8EAAFF", "--info-soft": "rgba(142,170,255,.14)",
    "--chrome": "#0A0E1A", "--tabbar": "rgba(10,14,26,.94)", "--scrim": "rgba(2,4,10,.66)",
    "--sheet-bg": "#0C1120", "--card-border": "rgba(154,170,230,.12)", "--knob-on": "#1A2200",
    "--match-bg": "#DFFF56", "--match-ink": "#1A2200",
    "--r-card": "22px", "--r-btn": "14px", "--r-field": "14px", "--r-chip-grid": "13px", "--r-sheet": "26px",
    "--gutter": "16px", "--sp-1": "4px", "--sp-2": "8px", "--sp-3": "12px", "--sp-4": "16px", "--sp-5": "20px",
    "--sp-6": "24px", "--sp-8": "32px", "--ec-media-h": "188px",
    "--rail-w": "0.86", "--rail-w-compact": "0.72",
    "--font-display": "Unbounded", "--font-body": "Manrope",
}
# Предыдущая 2.0.2: мятный акцент и компактные радиусы — демо отката прототипа (02-screens.css .tg.cfg-old)
MINIAPP_202_TOKENS = {
    **MINIAPP_203_TOKENS,
    "--accent": "#8EF5C2", "--accent-ink": "#00261A", "--accent-tx": "#8EF5C2",
    "--accent-soft": "rgba(142,245,194,.13)", "--accent-line": "rgba(142,245,194,.38)", "--focus": "#8EF5C2",
    "--btn-bg": "#8EF5C2", "--btn-tx": "#00261A", "--knob-on": "#00261A", "--match-bg": "#8EF5C2",
    "--match-ink": "#00261A", "--r-card": "14px", "--r-btn": "10px", "--r-chip-grid": "9px",
}
FONT_BODY = '"Manrope",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif'
FONT_MONO = '"JetBrains Mono",ui-monospace,Menlo,monospace'
SECTIONS = [
    {"type": "event_carousel", "key": "best_for_you", "variant": "large", "enabled": True},
    {"type": "watch_changes", "key": "watch", "variant": "compact", "enabled": True},
    {"type": "event_carousel", "key": "sales_soon", "variant": "compact", "enabled": True},
    {"type": "news_carousel", "key": "news", "variant": "compact", "enabled": True},
]
FLAGS = {"ai_concierge": True, "group_trip": True, "calendar_export": False, "premium_teaser": True}


def miniapp(theme_version: str, tokens: dict) -> dict:
    return {
        "theme": {"id": "default", "version": theme_version, "tokens": tokens},
        "home": {"welcome_mode": "first_visit_only", "sections": SECTIONS},
        "flags": FLAGS,
        "hotel_rating_min": 8.5,
    }


ADMIN_100 = {
    "theme": {"id": "default", "version": "1.0.0", "tokens": {
        "--bg": "#F5F6F9", "--surface": "#FFFFFF", "--surface-2": "#F0F2F6", "--surface-3": "#E7EAF0",
        "--surface-sunk": "#F8F9FB", "--line": "#E4E7EE", "--line-strong": "#D2D7E1", "--ink": "#0E1324",
        "--ink-2": "#4A5168", "--muted": "#646B80", "--faint": "#A0A7B8", "--field-line": "#858EA1",
        "--nav": "#0B1020", "--nav-2": "#161D33", "--nav-3": "#1E263F", "--nav-ink": "#AEB7CA",
        "--nav-ink-strong": "#FFFFFF", "--nav-muted": "#808BA6", "--nav-line": "rgba(174,183,202,.12)",
        "--accent": "#DFFF56", "--accent-press": "#CDEE3C", "--accent-ink": "#1A2200", "--primary": "#0E1324",
        "--primary-ink": "#FFFFFF", "--primary-hover": "#262D45", "--info": "#315EFB", "--info-bg": "#EDF2FF",
        "--info-ink": "#1D45D1", "--info-line": "#C9D6FF", "--good": "#0F9F6E", "--good-bg": "#E5F6EF",
        "--good-ink": "#0A7552", "--good-line": "#BDE8D6", "--warn": "#C27803", "--warn-bg": "#FDF2DE",
        "--warn-ink": "#8F5800", "--warn-line": "#F2D49B", "--bad": "#D92D20", "--bad-bg": "#FDECEA",
        "--bad-ink": "#B42318", "--bad-line": "#F7C3BE", "--neutral-bg": "#EEF0F4", "--neutral-ink": "#4A5168",
        "--note-bg": "#FFF7DB", "--note-line": "#EED98C", "--note-ink": "#6B5300", "--focus": "#315EFB",
        "--scrim": "rgba(11,16,32,.42)",
        "--shadow-pop": "0 14px 36px -10px rgba(14,19,36,.28),0 2px 6px rgba(14,19,36,.08)",
        "--shadow-drawer": "-24px 0 48px -12px rgba(14,19,36,.24)",
        "--chart-grid": "#ECEEF3", "--chart-axis": "#8D96A8", "--chart-label": "#646B80", "--s1": "#2A78D6",
        "--s2": "#D9541F", "--s3": "#178A61", "--s4": "#A86F00", "--s-other": "#7D8699", "--s-single": "#315EFB",
        "--s-ghost": "#E4E7EE", "--code-key": "#1D45D1", "--code-str": "#0A7552", "--code-num": "#9A4A00",
        "--code-bool": "#8A2BB0", "--diff-add": "#E5F6EF", "--diff-add-ink": "#0A7552", "--diff-del": "#FDECEA",
        "--diff-del-ink": "#B42318", "--r-xs": "4px", "--r-sm": "6px", "--r": "8px", "--r-lg": "12px",
        "--nav-w": "248px", "--top-h": "56px",
        "--font-ui": FONT_BODY,
        "--font-display": '"Unbounded","Manrope",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif',
        "--font-mono": FONT_MONO,
    }},
    "layout": {
        "density": "compact",
        "table_presets": {"users": "support", "audit": "security"},
        "dashboard_widgets": [{"id": w, "enabled": True} for w in (
            "kpi_users", "kpi_ai", "kpi_support", "kpi_system", "kpi_commerce", "budget", "hourly",
            "cost_agents", "dau", "agents_table")],
    },
    "flags": {},
}

# (app, version, payload, change_note, created/activated at, activation reason)
SEED = [
    ("miniapp", "2.0.2", miniapp("2.0.2", MINIAPP_202_TOKENS), "Тема default 2.0.2: мятный акцент, радиус карточек 14px",
     datetime(2026, 9, 21, 5, 0, tzinfo=UTC), "Начальная тема Mini App 2.0"),
    ("miniapp", "2.0.3", miniapp("2.0.3", MINIAPP_203_TOKENS),
     "Тёмный премиум: лайм #DFFF56 на navy, радиус карточек 22px", datetime(2026, 10, 5, 6, 0, tzinfo=UTC),
     "Переход на тёмный премиум"),
    ("admin", "1.0.0", ADMIN_100, "Admin default 1.0: navy + lime, компактная плотность",
     datetime(2026, 10, 5, 6, 0, tzinfo=UTC), "Начальная конфигурация Admin"),
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
    previous: dict[str, str | None] = {}
    for app, version, payload, note, at, reason in SEED:
        op.bulk_insert(versions, [{
            "id": uuid.uuid5(SEED_NS, f"version:{app}:{version}"), "app": app, "version": version,
            "payload": payload, "checksum": _checksum(payload), "change_note": note, "created_by": SEED_ACTOR,
            "created_at": at,
        }])
        op.bulk_insert(activations, [{
            "id": uuid.uuid5(SEED_NS, f"activation:{app}:{version}"), "app": app, "version": version,
            "previous_version": previous.get(app), "kind": "activate", "reason": reason,
            "activated_by": SEED_ACTOR, "activated_at": at,
        }])
        previous[app] = version


def downgrade() -> None:
    # Таблицы append-only: снимаем триггеры на время удаления сида.
    for table in ("activations", "config_versions"):
        op.execute(f"ALTER TABLE {table} DISABLE TRIGGER {table}_no_update")
    op.execute(sa.text("DELETE FROM activations WHERE activated_by = :a").bindparams(a=SEED_ACTOR))
    op.execute(sa.text("DELETE FROM config_versions WHERE created_by = :a").bindparams(a=SEED_ACTOR))
    for table in ("activations", "config_versions"):
        op.execute(f"ALTER TABLE {table} ENABLE TRIGGER {table}_no_update")
