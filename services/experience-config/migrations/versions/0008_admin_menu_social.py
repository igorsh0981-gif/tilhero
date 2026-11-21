"""Спринт 7: конфигурация админки 1.7.0 — группа «Сообщество» сразу после «Игры»

admin-web группирует разделы меню по порядку конфигурации (группа встаёт туда, где появился её первый раздел; разделы,
которых конфигурация не перечисляет, идут в конце в порядке по умолчанию). В сиде 1.0.0 разделов спринтов 5 и 7 нет,
поэтому «Сообщество» (friends, moderation, referrals, leagues, pair_rooms — INTERNAL_API спринта 7 §6) оказывалось
последней группой, после «Управления». Версия 1.7.0 = сид 1.0.0 (та же тема, плотность и флаги), в меню которого:
- memory («Память», спринт 5) — на своём месте в группе продукта, сразу после content;
- группа «Сообщество» — сразу после группы «Игра» (heroes, game, events), перед news.
Все разделы включены (видимость по правам решают admin-bff и admin-web). id «Событий и сезонов» — events, как в сиде
1.0.0 (game_events — тот же раздел, MENU_ALIASES).

Версия создаётся всегда; активируется, только если действующая версия админки — сидовая 1.0.0 (её никто не менял):
версию, которую выбрал сотрудник, миграция не подменяет — 1.7.0 тогда видна в «Конфигурации» и активируется там
(`config.publish` + TOTP). Как у сотрудника: версия проверяется той же схемой (`validate_payload`), контрольная сумма —
той же функцией; в outbox той же транзакции — `experience.config.activated.v1` и аудит `config.create` /
`config.publish` (`actor_type system`, `actor_id system:release`). Кэш текущей конфигурации (TTL 60 с) подхватывает
новую активацию по её seq. Версия 1.7.0 уже есть с другим содержимым — миграция падает с понятной ошибкой.

Обратима: downgrade удаляет активации и версию 1.7.0, созданные миграцией (только если после неё админку не
переключали), и ещё не отправленные события этой миграции.

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-21
"""
import copy
import uuid
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

from tilhero_common.messaging import make_envelope
from tilhero_experience.domain.payload import ConfigInvalid, checksum, validate_payload

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

SEED_NS = uuid.UUID("5a0c3e1d-7b2f-4c8e-9d61-711e7e000000")  # пространство id сида experience-config (0002)
ACTOR = "system:release"
APP = "admin"
VERSION = "1.7.0"
SEED_VERSION = "1.0.0"
PRODUCER = "experience-config"
ACTIVATED_EVENT = "experience.config.activated.v1"
AUDIT_EVENT = "admin.audit.recorded.v1"
CORRELATION = "release-7:admin-config"
VERSION_ID = uuid.uuid5(SEED_NS, f"version:{APP}:{VERSION}")
ACTIVATION_ID = uuid.uuid5(SEED_NS, f"activation:{APP}:{VERSION}")
CHANGE_NOTE = ("Админка 1.7: группа «Сообщество» (друзья и жалобы, модерация, рефералы, лиги и дуэли, парные комнаты) "
               "сразу после «Игры»; «Память» — после «Контента»")
REASON = "Спринт 7: разделы сообщества на своём месте в меню"

# Тема, плотность и флаги — как в сиде 1.0.0 (0002_seed.ADMIN_100); данные зафиксированы здесь
THEME = {"id": "admin_light", "version": "1.0.0", "tokens": {
    "--bg": "#F4F6FB", "--card": "#FFFFFF", "--ink": "#1C2340", "--ink2": "#4A5272", "--line": "#E1E6F2",
    "--pen": "#2F4BE0", "--pen-soft": "#E9EDFF", "--side": "#1C2340", "--side2": "#B9C0DA",
    "--ok": "#1E7A4F", "--ok-soft": "#E3F3EA", "--warn": "#8F5300", "--warn-soft": "#FFF1D6",
    "--err": "#C8323C", "--err-soft": "#FDECEE",
    "--r-card": "14px", "--r-btn": "10px", "--r-field": "10px", "--nav-w": "236px",
    "--font-ui": "Onest,system-ui,sans-serif",
    "--font-display": "Unbounded,sans-serif",
    "--font-mono": "ui-monospace,SFMono-Regular,Menlo,monospace",
}}
# Группы admin-web (apps/admin-web/src/state/nav.ts): продукт · ИИ · игра · СООБЩЕСТВО · коммуникации · управление
MENU = (
    "overview", "users", "content", "memory",
    "agents", "qa", "costs",
    "heroes", "game", "events",
    "friends", "moderation", "referrals", "leagues", "pair_rooms",
    "news", "support",
    "config", "langs", "roles", "audit",
)
COMMUNITY = ("friends", "moderation", "referrals", "leagues", "pair_rooms")
PAYLOAD: dict[str, Any] = {
    "theme": THEME,
    "layout": {"density": "compact", "menu": [{"id": m, "enabled": True} for m in MENU]},
    "flags": {},
}

versions_table = sa.table(
    "config_versions",
    sa.column("id", pg.UUID(as_uuid=True)), sa.column("app", sa.String), sa.column("version", sa.String),
    sa.column("payload", pg.JSONB), sa.column("checksum", sa.String), sa.column("change_note", sa.Text),
    sa.column("created_by", sa.String), sa.column("created_at", sa.DateTime(timezone=True)),
)
activations_table = sa.table(
    "activations",
    sa.column("id", pg.UUID(as_uuid=True)), sa.column("seq", sa.BigInteger), sa.column("app", sa.String),
    sa.column("version", sa.String), sa.column("previous_version", sa.String), sa.column("kind", sa.String),
    sa.column("reason", sa.Text), sa.column("activated_by", sa.String),
    sa.column("activated_at", sa.DateTime(timezone=True)),
)
outbox_table = sa.table(
    "outbox",
    sa.column("id", pg.UUID(as_uuid=False)), sa.column("event_type", sa.String), sa.column("envelope", pg.JSONB),
    sa.column("published_at", sa.DateTime(timezone=True)),
)


def checked() -> tuple[dict[str, Any], str]:
    """Payload версии через ту же проверку, что и версия из админки → (нормализованный payload, checksum)."""
    try:
        payload = validate_payload(APP, copy.deepcopy(PAYLOAD))
    except ConfigInvalid as exc:
        raise RuntimeError(f"admin config {VERSION}: invalid payload: {exc.errors}") from None
    if payload != PAYLOAD:
        raise RuntimeError(f"admin config {VERSION}: payload is not normalized")
    return payload, checksum(payload)


def _iso(at: datetime) -> str:
    return at.isoformat().replace("+00:00", "Z")


def _emit(event_type: str, payload: dict[str, Any]) -> None:
    env = make_envelope(event_type, payload, producer=PRODUCER, correlation_id=CORRELATION)
    op.bulk_insert(outbox_table, [{"id": env.event_id, "event_type": env.event_type,
                                   "envelope": env.model_dump(mode="json")}])


def _audit(action: str, before: dict | None, after: dict, reason: str, at: datetime) -> None:
    """Payload admin.audit.recorded.v1 — как service._audit, но от имени выкладки."""
    _emit(AUDIT_EVENT, {
        "record_id": str(uuid.uuid4()), "occurred_at": _iso(at), "actor_type": "system", "actor_id": ACTOR,
        "actor_role": None, "action": action, "object_type": "experience_config", "object_id": f"{APP}@{VERSION}",
        "before": before, "after": after, "reason": reason, "trace_id": None,
    })


def upgrade() -> None:
    bind = op.get_bind()
    payload, digest = checked()  # всё проверено до первой записи
    now = datetime.now(UTC)
    bind.execute(sa.text("SELECT pg_advisory_xact_lock(:c, :o)"), {"c": 0x45585043, "o": 2})  # service._lock_app

    existing = bind.execute(sa.select(versions_table.c.checksum).where(
        versions_table.c.app == APP, versions_table.c.version == VERSION)).first()
    if existing is not None and existing[0] != digest:
        raise RuntimeError(f"admin config {VERSION}: the version is taken by other content — create the community "
                           "menu in the admin panel or remove that version and deploy again")
    if existing is None:
        op.execute(versions_table.insert().values(
            id=VERSION_ID, app=APP, version=VERSION, payload=payload, checksum=digest, change_note=CHANGE_NOTE,
            created_by=ACTOR, created_at=now))
        _audit("config.create", None, {"version": VERSION, "checksum": digest}, CHANGE_NOTE, now)

    current = bind.execute(sa.select(activations_table.c.version).where(activations_table.c.app == APP)
                           .order_by(activations_table.c.seq.desc()).limit(1)).first()
    if current is None or current[0] != SEED_VERSION:
        return  # админку уже настроил сотрудник (или она уже на 1.7.0) — активирует 1.7.0 сам, если нужно
    op.execute(activations_table.insert().values(
        id=ACTIVATION_ID, app=APP, version=VERSION, previous_version=SEED_VERSION, kind="activate", reason=REASON,
        activated_by=ACTOR, activated_at=now))
    _emit(ACTIVATED_EVENT, {"app": APP, "version": VERSION, "previous_version": SEED_VERSION,
                            "activation_id": str(ACTIVATION_ID)})
    _audit("config.publish", {"version": SEED_VERSION}, {"version": VERSION, "activation_id": str(ACTIVATION_ID)},
           REASON, now)


def downgrade() -> None:
    bind = op.get_bind()
    op.execute(sa.text(
        "DELETE FROM outbox WHERE published_at IS NULL AND envelope ->> 'correlation_id' = :c"
    ).bindparams(c=CORRELATION))
    later = bind.execute(sa.text(
        "SELECT count(*) FROM activations WHERE app = :app AND (version = :v OR previous_version = :v) "
        "AND id <> :id"
    ), {"app": APP, "v": VERSION, "id": ACTIVATION_ID}).scalar_one()
    if later:
        return  # админку переключали на 1.7.0 / с 1.7.0 вручную — история активаций неизменна, версия остаётся
    for table in ("activations", "config_versions"):
        op.execute(f"ALTER TABLE {table} DISABLE TRIGGER {table}_no_update")
    op.execute(sa.text("DELETE FROM activations WHERE id = :id").bindparams(id=ACTIVATION_ID))
    op.execute(sa.text("DELETE FROM config_versions WHERE id = :id AND created_by = :a")
               .bindparams(id=VERSION_ID, a=ACTOR))
    for table in ("activations", "config_versions"):
        op.execute(f"ALTER TABLE {table} ENABLE TRIGGER {table}_no_update")
