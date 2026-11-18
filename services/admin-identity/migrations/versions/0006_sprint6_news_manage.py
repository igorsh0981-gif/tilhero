"""Право спринта 6: news.manage — реестр лент новостей (CRUD, проверка ленты) и скрытие новостей из выдачи.
Матрица: super_admin и operations; прочим ролям не выдаётся (docs/sprint6/INTERNAL_API.md §3.1, §8).
Привилегированным право не является: роль, получившая его через four-eyes, MFA не требует.

Как 0005: справочника прав в БД нет — каталог в коде (domain/catalog.py), в БД — только матрица role_permissions.
Существующие права ролей не трогаются (матрица могла меняться через four-eyes) — только добавляется новое,
повторный прогон ничего не дублирует. Изменённым ролям обновляется updated_at (updated_by = NULL — система).
roles.privileged не пересчитывается: набор привилегированных прав не меняется.

downgrade: право удаляется у всех ролей (его могли выдать и другим ролям через four-eyes — после отката каталог
его не знает), открытые заявки role.permissions_change с ним истекают (иначе применение вернуло бы неизвестное
право). Привилегированность ролей от этого не меняется.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-11
"""
import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

NEW_PERMISSIONS = ["news.manage"]
GRANTS = {"super_admin": NEW_PERMISSIONS, "operations": NEW_PERMISSIONS}


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
