"""Спринт 6: права игры и кошельков учеников (docs/sprint6/PLAN.md §«Права и роли», docs/sprint6/INTERNAL_API.md §5;
каталог — packages/contracts/src/admin.ts `Permission`).

Права: game.read (герои, правила, магазин, события, кошельки учеников — чтение), game.manage (черновики правил, герои и
картинки, предметы магазина, события недели; без step-up), game.publish (активация и откат правил, публикация героев,
предметов и событий; step-up в admin-bff), wallet.adjust (ручное начисление и списание, обратная запись, возврат
покупки; step-up и причина). Новых ролей нет. Матрица добавляется к уже действующей (INSERT … ON CONFLICT DO NOTHING):
изменения, внесённые через four-eyes после 0001/0003/0004/0005, не затираются. game.publish и wallet.adjust — права со
step-up и делают роль привилегированной (правило спринта 2, domain/catalog.py PRIVILEGED_PERMISSIONS); по матрице их
получают только operations (привилегирована по коду роли) и super_admin, поэтому ни одна роль по умолчанию не становится
привилегированной. Если такое право к этому моменту уже выдано через four-eyes непривилегированной роли — она
становится привилегированной при пересчёте, и сессии её сотрудников отзываются (как в 0004/0005): при следующем входе —
обязательное подключение TOTP. Значения зафиксированы здесь, а не импортируются из кода: миграция не меняется вместе с
каталогом.

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-20
"""
import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

NEW_PERMISSIONS = ["game.read", "game.manage", "game.publish", "wallet.adjust"]

# Новых ролей нет (admin.ts RoleCode не менялся)
NEW_ROLES: list[tuple[str, str, str]] = []

# Добавляемые права по ролям (PLAN.md спринта 6 «Права и роли»); super_admin — все новые; wallet.adjust — только
# super_admin и operations
GRANTS: dict[str, list[str]] = {
    "super_admin": NEW_PERMISSIONS,
    "content_manager": ["game.read", "game.manage"],
    "methodist": ["game.read"],
    "operations": ["game.read", "game.manage", "game.publish", "wallet.adjust"],
    "support": ["game.read"],
    "analyst": ["game.read"],
    "auditor": ["game.read"],
}

# admin.ts PRIVILEGED_ROLES (MFA по коду роли) и права со step-up после спринта 6 (domain/catalog.py)
PRIVILEGED_ROLES = ["super_admin", "operations", "communications"]
PRIVILEGED_PERMISSIONS = ["users.sensitive.read", "staff.manage", "roles.manage", "config.publish",
                          "whatsnew.publish", "notif.templates.manage", "notif.campaigns.send",
                          "content.publish", "media.rights", "lang.manage",
                          "ai.publish", "qa.review", "costs.manage",
                          "memory.manage",
                          "game.publish", "wallet.adjust"]
# до 0006 (0005_memory_permissions.PRIVILEGED_PERMISSIONS) — для отката
PRIVILEGED_PERMISSIONS_V5 = ["users.sensitive.read", "staff.manage", "roles.manage", "config.publish",
                             "whatsnew.publish", "notif.templates.manage", "notif.campaigns.send",
                             "content.publish", "media.rights", "lang.manage",
                             "ai.publish", "qa.review", "costs.manage",
                             "memory.manage"]


def _privileged_sql(perms: list[str]) -> sa.TextClause:
    """roles.privileged = код в PRIVILEGED_ROLES ИЛИ хотя бы одно право со step-up."""
    return sa.text(
        "UPDATE roles r SET privileged = (r.code = ANY(:codes) OR EXISTS ("
        " SELECT 1 FROM role_permissions rp WHERE rp.role = r.code AND rp.permission = ANY(:perms)))"
    ).bindparams(sa.bindparam("codes", PRIVILEGED_ROLES), sa.bindparam("perms", perms))


def upgrade() -> None:
    bind = op.get_bind()
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
    # незавершённые заявки, ссылающиеся на новые права, после отката неисполнимы
    bind.execute(sa.text(
        "UPDATE approvals SET status = 'REJECTED', decided_at = now(), decision_note = 'migration 0006 downgrade' "
        "WHERE status = 'PENDING' AND jsonb_typeof(payload->'permissions') = 'array'"
        " AND (payload->'permissions') ?| CAST(:perms AS text[])"
    ).bindparams(sa.bindparam("perms", NEW_PERMISSIONS)))
    bind.execute(sa.text("DELETE FROM role_permissions WHERE permission = ANY(:perms)")
                 .bindparams(sa.bindparam("perms", NEW_PERMISSIONS)))
    bind.execute(_privileged_sql(PRIVILEGED_PERMISSIONS_V5))
    bind.execute(sa.text("UPDATE roles SET updated_at = now() WHERE code = ANY(:roles)")
                 .bindparams(sa.bindparam("roles", sorted(GRANTS))))
