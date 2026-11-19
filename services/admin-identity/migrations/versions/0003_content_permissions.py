"""Спринт 3: права контента, медиа и языков, роль content_manager (docs/sprint3/PLAN.md §«Права и роли»,
docs/sprint3/INTERNAL_API.md §5; каталог — packages/contracts/src/admin.ts `Permission`, `RoleCode`).

Права: content.read, content.edit, content.review, content.publish (step-up), media.rights (step-up), lang.manage
(step-up). Матрица добавляется к уже действующей (INSERT … ON CONFLICT DO NOTHING): изменения, внесённые через
four-eyes после 0001, не затираются. Права со step-up делают роль привилегированной (MFA, four-eyes при назначении —
правило спринта 2, domain/catalog.py PRIVILEGED_PERMISSIONS): methodist (content.publish) и content_manager
(media.rights) становятся привилегированными. Как при применении role.permissions_change (domain/approvals.py): у
сотрудников роли, ставшей привилегированной, отзываются сессии (session_version + 1) — при следующем входе обязательное
подключение TOTP. Значения зафиксированы здесь, а не импортируются из кода: миграция не меняется вместе с каталогом.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-19
"""
import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

NEW_PERMISSIONS = ["content.read", "content.edit", "content.review", "content.publish", "media.rights", "lang.manage"]

# (code, name_ru, name_en) — новая роль; порядок в каталоге — после methodist (admin.ts RoleCode)
NEW_ROLES = [("content_manager", "Контент-менеджер", "Content manager")]

# Добавляемые права по ролям (PLAN.md спринта 3); super_admin — все новые
GRANTS: dict[str, list[str]] = {
    "super_admin": NEW_PERMISSIONS,
    "methodist": ["content.read", "content.edit", "content.review", "content.publish"],
    "content_manager": ["content.read", "content.edit", "media.rights", "dashboard.read"],
    "operations": ["content.read"],
    "analyst": ["content.read"],
    "auditor": ["content.read"],
}

# admin.ts PRIVILEGED_ROLES (MFA по коду роли) и права со step-up после спринта 3 (domain/catalog.py)
PRIVILEGED_ROLES = ["super_admin", "operations", "communications"]
PRIVILEGED_PERMISSIONS = ["users.sensitive.read", "staff.manage", "roles.manage", "config.publish",
                          "whatsnew.publish", "notif.templates.manage", "notif.campaigns.send",
                          "content.publish", "media.rights", "lang.manage"]
# до 0003 (0001_initial.PRIVILEGED_PERMISSIONS) — для отката
PRIVILEGED_PERMISSIONS_V2 = ["users.sensitive.read", "staff.manage", "roles.manage", "config.publish",
                             "whatsnew.publish", "notif.templates.manage", "notif.campaigns.send"]


def _privileged_sql(perms: list[str]) -> sa.TextClause:
    """roles.privileged = код в PRIVILEGED_ROLES ИЛИ хотя бы одно право со step-up."""
    return sa.text(
        "UPDATE roles r SET privileged = (r.code = ANY(:codes) OR EXISTS ("
        " SELECT 1 FROM role_permissions rp WHERE rp.role = r.code AND rp.permission = ANY(:perms)))"
    ).bindparams(sa.bindparam("codes", PRIVILEGED_ROLES), sa.bindparam("perms", perms))


def upgrade() -> None:
    bind = op.get_bind()
    for code, ru, en in NEW_ROLES:
        bind.execute(sa.text(
            "INSERT INTO roles (code, name_ru, name_en, privileged) VALUES (:code, :ru, :en, false) "
            "ON CONFLICT (code) DO NOTHING"
        ), {"code": code, "ru": ru, "en": en})
    for role, perms in GRANTS.items():
        for perm in perms:
            bind.execute(sa.text(
                "INSERT INTO role_permissions (role, permission) SELECT code, CAST(:perm AS varchar) FROM roles "
                "WHERE code = CAST(:role AS varchar) ON CONFLICT DO NOTHING"
            ), {"role": role, "perm": perm})
    was = {r[0] for r in bind.execute(sa.text("SELECT code FROM roles WHERE privileged")).all()}
    bind.execute(_privileged_sql(PRIVILEGED_PERMISSIONS))
    now = {r[0] for r in bind.execute(sa.text("SELECT code FROM roles WHERE privileged")).all()}
    became = sorted(now - was)
    if became:
        # роль стала привилегированной: сессии её сотрудников отзываются, при входе — подключение MFA
        bind.execute(sa.text(
            "UPDATE staff SET session_version = session_version + 1, updated_at = now() WHERE role = ANY(:roles)"
        ).bindparams(sa.bindparam("roles", became)))
    bind.execute(sa.text("UPDATE roles SET updated_at = now() WHERE code = ANY(:roles)")
                 .bindparams(sa.bindparam("roles", sorted(GRANTS))))


def downgrade() -> None:
    bind = op.get_bind()
    # сотрудники роли content_manager → read_only (роль удаляется), их сессии отзываются
    bind.execute(sa.text(
        "UPDATE staff SET role = 'read_only', session_version = session_version + 1, updated_at = now() "
        "WHERE role = 'content_manager'"
    ))
    # незавершённые заявки, ссылающиеся на новую роль или права, после отката неисполнимы
    bind.execute(sa.text(
        "UPDATE approvals SET status = 'REJECTED', decided_at = now(), decision_note = 'migration 0003 downgrade' "
        "WHERE status = 'PENDING' AND ("
        " payload->>'role' = 'content_manager' OR payload->>'to_role' = 'content_manager'"
        " OR payload->>'from_role' = 'content_manager'"
        " OR (jsonb_typeof(payload->'permissions') = 'array' AND (payload->'permissions') ?| CAST(:perms AS text[])))"
    ).bindparams(sa.bindparam("perms", NEW_PERMISSIONS)))
    bind.execute(sa.text("DELETE FROM role_permissions WHERE permission = ANY(:perms)")
                 .bindparams(sa.bindparam("perms", NEW_PERMISSIONS)))
    for code, _, _ in NEW_ROLES:
        bind.execute(sa.text("DELETE FROM role_permissions WHERE role = :code"), {"code": code})
        bind.execute(sa.text("DELETE FROM roles WHERE code = :code"), {"code": code})
    bind.execute(_privileged_sql(PRIVILEGED_PERMISSIONS_V2))
