"""Право спринта 8: ops.queues.manage — DLQ: просмотр маскированного payload, повтор и удаление сообщений шины
(docs/sprint8/INTERNAL_API.md §3.3, §7.6). Матрица: super_admin и operations; прочим ролям не выдаётся.
Привилегированное (PRIVILEGED_PERMISSIONS): MFA обязательна, назначение роли с ним — four-eyes.

Как 0005: справочника прав в БД нет — каталог в коде (domain/catalog.py), в БД — только матрица role_permissions.
Существующие права ролей не трогаются (матрица могла меняться через four-eyes) — только добавляется новое,
повторный прогон ничего не дублирует. roles.privileged пересчитывается (роль из контракта или есть привилегированное
право); ставшей привилегированной роли — отзыв сессий её сотрудников. super_admin и operations привилегированы и так —
на стандартной матрице пересчёт ничего не меняет. Изменённым ролям обновляется updated_at (updated_by = NULL).

downgrade: право удаляется у всех ролей (его могли выдать и другим ролям через four-eyes — после отката каталог
его не знает), открытые заявки role.permissions_change с ним истекают, privileged пересчитывается.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-15
"""
import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

NEW_PERMISSIONS = ["ops.queues.manage"]
GRANTS = {"super_admin": NEW_PERMISSIONS, "operations": NEW_PERMISSIONS}

PRIVILEGED_ROLES = ["super_admin", "operations", "billing", "agent_manager"]
PRIVILEGED_BEFORE = ["staff.manage", "roles.manage", "users.sensitive.read", "billing.refund",
                     "subscriptions.override", "config.publish", "ops.kill_switch", "ai.content.read", "export.csv",
                     "sources.manage"]
PRIVILEGED_AFTER = [*PRIVILEGED_BEFORE, "ops.queues.manage"]


def _recompute_privileged(perms: list[str]) -> None:
    """privileged = роль из контракта или есть привилегированное право; ставшим привилегированными — отзыв сессий."""
    became = sa.text(
        "UPDATE roles SET privileged = true, updated_at = now(), updated_by = NULL "
        "WHERE privileged = false AND (code = ANY(:roles) OR EXISTS (SELECT 1 FROM role_permissions rp "
        "WHERE rp.role = roles.code AND rp.permission = ANY(:perms))) RETURNING code"
    ).bindparams(roles=PRIVILEGED_ROLES, perms=perms)
    codes = [r[0] for r in op.get_bind().execute(became)]
    if codes:
        op.execute(sa.text(
            "UPDATE staff SET session_version = session_version + 1, updated_at = now() WHERE role = ANY(:codes)"
        ).bindparams(codes=codes))
    op.execute(sa.text(
        "UPDATE roles SET privileged = false, updated_at = now(), updated_by = NULL "
        "WHERE privileged = true AND NOT (code = ANY(:roles) OR EXISTS (SELECT 1 FROM role_permissions rp "
        "WHERE rp.role = roles.code AND rp.permission = ANY(:perms)))"
    ).bindparams(roles=PRIVILEGED_ROLES, perms=perms))


def upgrade() -> None:
    bind = op.get_bind()
    for role, perms in GRANTS.items():
        added = bind.execute(sa.text(
            "INSERT INTO role_permissions (role, permission) "
            "SELECT :role, p FROM unnest(CAST(:perms AS varchar[])) AS p "
            "WHERE EXISTS (SELECT 1 FROM roles WHERE code = :role) "
            "ON CONFLICT DO NOTHING RETURNING permission"
        ).bindparams(role=role, perms=perms)).all()
        if added:
            op.execute(sa.text("UPDATE roles SET updated_at = now(), updated_by = NULL WHERE code = :role")
                       .bindparams(role=role))
    _recompute_privileged(PRIVILEGED_AFTER)


def downgrade() -> None:
    bind = op.get_bind()
    roles = [r[0] for r in bind.execute(sa.text(
        "DELETE FROM role_permissions WHERE permission = ANY(:perms) RETURNING role"
    ).bindparams(perms=NEW_PERMISSIONS))]
    if roles:
        op.execute(sa.text("UPDATE roles SET updated_at = now(), updated_by = NULL WHERE code = ANY(:codes)")
                   .bindparams(codes=sorted(set(roles))))
    op.execute(sa.text(
        "UPDATE approvals SET status = 'EXPIRED' "  # как expire_overdue: без decided_at
        "WHERE status = 'PENDING' AND kind = 'role.permissions_change' "
        "AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(payload -> 'permissions') AS p(v) "
        "WHERE p.v = ANY(:perms))"
    ).bindparams(perms=NEW_PERMISSIONS))
    _recompute_privileged(PRIVILEGED_BEFORE)
