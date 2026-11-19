"""Спринт 4: права ИИ-агентов, контроля диалогов и затрат, роль qa_analyst (docs/sprint4/PLAN.md §«Права и роли»,
docs/sprint4/INTERNAL_API.md §6; каталог — packages/contracts/src/admin.ts `Permission`, `RoleCode`).

Права: ai.read, ai.manage, ai.publish (step-up), qa.read, qa.transcripts, qa.review (step-up), costs.read,
costs.manage (step-up). Матрица добавляется к уже действующей (INSERT … ON CONFLICT DO NOTHING): изменения, внесённые
через four-eyes после 0001/0003, не затираются. Права со step-up делают роль привилегированной (MFA, four-eyes при
назначении — правило спринта 2, domain/catalog.py PRIVILEGED_PERMISSIONS): methodist (ai.publish, qa.review) уже
привилегирован по content.publish, operations — по PRIVILEGED_ROLES; qa_analyst (без прав со step-up) — нет; analyst и
auditor получают только чтение. Как при применении role.permissions_change (domain/approvals.py): у сотрудников роли,
ставшей привилегированной (например, methodist, у которого content.publish был снят через four-eyes), отзываются сессии
(session_version + 1) — при следующем входе обязательное подключение TOTP. Значения зафиксированы здесь, а не
импортируются из кода: миграция не меняется вместе с каталогом.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-19
"""
import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

NEW_PERMISSIONS = ["ai.read", "ai.manage", "ai.publish", "qa.read", "qa.transcripts", "qa.review", "costs.read",
                   "costs.manage"]

# (code, name_ru, name_en) — новая роль; порядок в каталоге — после content_manager (admin.ts RoleCode)
NEW_ROLES = [("qa_analyst", "QA-аналитик", "QA analyst")]

# Добавляемые права по ролям (PLAN.md спринта 4); super_admin — все новые
GRANTS: dict[str, list[str]] = {
    "super_admin": NEW_PERMISSIONS,
    "methodist": ["ai.read", "ai.manage", "ai.publish", "qa.read", "qa.transcripts", "qa.review"],
    "operations": ["ai.read", "qa.read", "costs.read", "costs.manage"],
    "qa_analyst": ["dashboard.read", "content.read", "ai.read", "qa.read", "qa.transcripts"],
    "analyst": ["ai.read", "qa.read", "costs.read"],
    "auditor": ["ai.read", "qa.read", "costs.read"],
}

# admin.ts PRIVILEGED_ROLES (MFA по коду роли) и права со step-up после спринта 4 (domain/catalog.py)
PRIVILEGED_ROLES = ["super_admin", "operations", "communications"]
PRIVILEGED_PERMISSIONS = ["users.sensitive.read", "staff.manage", "roles.manage", "config.publish",
                          "whatsnew.publish", "notif.templates.manage", "notif.campaigns.send",
                          "content.publish", "media.rights", "lang.manage",
                          "ai.publish", "qa.review", "costs.manage"]
# до 0004 (0003_content_permissions.PRIVILEGED_PERMISSIONS) — для отката
PRIVILEGED_PERMISSIONS_V3 = ["users.sensitive.read", "staff.manage", "roles.manage", "config.publish",
                             "whatsnew.publish", "notif.templates.manage", "notif.campaigns.send",
                             "content.publish", "media.rights", "lang.manage"]


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
    # сотрудники роли qa_analyst → read_only (роль удаляется), их сессии отзываются
    bind.execute(sa.text(
        "UPDATE staff SET role = 'read_only', session_version = session_version + 1, updated_at = now() "
        "WHERE role = 'qa_analyst'"
    ))
    # незавершённые заявки, ссылающиеся на новую роль или права, после отката неисполнимы
    bind.execute(sa.text(
        "UPDATE approvals SET status = 'REJECTED', decided_at = now(), decision_note = 'migration 0004 downgrade' "
        "WHERE status = 'PENDING' AND ("
        " payload->>'role' = 'qa_analyst' OR payload->>'to_role' = 'qa_analyst'"
        " OR payload->>'from_role' = 'qa_analyst'"
        " OR (jsonb_typeof(payload->'permissions') = 'array' AND (payload->'permissions') ?| CAST(:perms AS text[])))"
    ).bindparams(sa.bindparam("perms", NEW_PERMISSIONS)))
    bind.execute(sa.text("DELETE FROM role_permissions WHERE permission = ANY(:perms)")
                 .bindparams(sa.bindparam("perms", NEW_PERMISSIONS)))
    for code, _, _ in NEW_ROLES:
        bind.execute(sa.text("DELETE FROM role_permissions WHERE role = :code"), {"code": code})
        bind.execute(sa.text("DELETE FROM roles WHERE code = :code"), {"code": code})
    bind.execute(_privileged_sql(PRIVILEGED_PERMISSIONS_V3))
