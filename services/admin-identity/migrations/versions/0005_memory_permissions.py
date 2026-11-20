"""Спринт 5: права памяти и словаря курса (docs/sprint5/PLAN.md §«Права и роли», docs/sprint5/INTERNAL_API.md §7;
каталог — packages/contracts/src/admin.ts `Permission`).

Права: memory.read (очередь, история планирования, проверки удержания, аналитика забывания), memory.manage (ручная
правка одной карточки — перенос срока, сброс, заморозка; step-up в admin-bff), glossary.manage (словарь курса и
модерация переводов ИИ; без step-up — правка действует сразу, каждая — в истории статьи и в аудите). Новых ролей нет.
Матрица добавляется к уже действующей (INSERT … ON CONFLICT DO NOTHING): изменения, внесённые через four-eyes после
0001/0003/0004, не затираются. memory.manage — право со step-up и делает роль привилегированной (правило спринта 2,
domain/catalog.py PRIVILEGED_PERMISSIONS); по матрице его получают только operations (привилегирована по коду роли) и
super_admin, поэтому ни одна роль по умолчанию не становится привилегированной. Но если у роли через four-eyes уже
было снято то, что делало её привилегированной, логика та же, что в 0004: у сотрудников роли, ставшей
привилегированной, отзываются сессии (session_version + 1) — при следующем входе обязательное подключение TOTP.
Значения зафиксированы здесь, а не импортируются из кода: миграция не меняется вместе с каталогом.

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-20
"""
import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

NEW_PERMISSIONS = ["memory.read", "memory.manage", "glossary.manage"]

# Новых ролей нет (admin.ts RoleCode не менялся)
NEW_ROLES: list[tuple[str, str, str]] = []

# Добавляемые права по ролям (PLAN.md спринта 5); super_admin — все новые
GRANTS: dict[str, list[str]] = {
    "super_admin": NEW_PERMISSIONS,
    "methodist": ["memory.read", "glossary.manage"],
    "content_manager": ["glossary.manage"],
    "qa_analyst": ["memory.read"],
    "analyst": ["memory.read"],
    "operations": ["memory.read", "memory.manage"],
    "auditor": ["memory.read"],
}

# admin.ts PRIVILEGED_ROLES (MFA по коду роли) и права со step-up после спринта 5 (domain/catalog.py)
PRIVILEGED_ROLES = ["super_admin", "operations", "communications"]
PRIVILEGED_PERMISSIONS = ["users.sensitive.read", "staff.manage", "roles.manage", "config.publish",
                          "whatsnew.publish", "notif.templates.manage", "notif.campaigns.send",
                          "content.publish", "media.rights", "lang.manage",
                          "ai.publish", "qa.review", "costs.manage",
                          "memory.manage"]
# до 0005 (0004_ai_qa_permissions.PRIVILEGED_PERMISSIONS) — для отката
PRIVILEGED_PERMISSIONS_V4 = ["users.sensitive.read", "staff.manage", "roles.manage", "config.publish",
                             "whatsnew.publish", "notif.templates.manage", "notif.campaigns.send",
                             "content.publish", "media.rights", "lang.manage",
                             "ai.publish", "qa.review", "costs.manage"]


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
        "UPDATE approvals SET status = 'REJECTED', decided_at = now(), decision_note = 'migration 0005 downgrade' "
        "WHERE status = 'PENDING' AND jsonb_typeof(payload->'permissions') = 'array'"
        " AND (payload->'permissions') ?| CAST(:perms AS text[])"
    ).bindparams(sa.bindparam("perms", NEW_PERMISSIONS)))
    bind.execute(sa.text("DELETE FROM role_permissions WHERE permission = ANY(:perms)")
                 .bindparams(sa.bindparam("perms", NEW_PERMISSIONS)))
    bind.execute(_privileged_sql(PRIVILEGED_PERMISSIONS_V4))
    bind.execute(sa.text("UPDATE roles SET updated_at = now() WHERE code = ANY(:roles)")
                 .bindparams(sa.bindparam("roles", sorted(GRANTS))))
