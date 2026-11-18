"""Право спринта 7: users.access.manage — назначение пользователю уровня доступа к AI (лимит сообщений консьержа),
с причиной, сроком и синхронным аудитом в ai-control (docs/sprint7/INTERNAL_API.md §2.7, §4, §6).
Матрица: super_admin и operations; прочим ролям не выдаётся. Привилегированным право не является: оно меняет только
лимит сообщений (потолок уровня — 1000 в сутки), всегда с причиной и аудитом; роль, получившая его через four-eyes,
MFA не требует.

Права AI-экранов спринта 7 используются как есть (решение 12.10, §4): dashboard.read (запросы, стоимость, бюджеты,
skills — чтение), skills.edit (agent_manager, super_admin), skills.publish (super_admin), ops.kill_switch (operations,
super_admin), ai.content.read (super_admin; привилегированное — раскрытие переписки с причиной и аудитом).
Миграция их не выдаёт и не отзывает.

Как 0005/0006: справочника прав в БД нет — каталог в коде (domain/catalog.py), в БД — только матрица
role_permissions. Существующие права ролей не трогаются (матрица могла меняться через four-eyes) — только добавляется
новое, повторный прогон ничего не дублирует. Изменённым ролям обновляется updated_at (updated_by = NULL — система).
roles.privileged не пересчитывается: набор привилегированных прав не меняется.

downgrade: право удаляется у всех ролей (его могли выдать и другим ролям через four-eyes — после отката каталог
его не знает), открытые заявки role.permissions_change с ним истекают (иначе применение вернуло бы неизвестное
право). Привилегированность ролей от этого не меняется.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-12
"""
import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

NEW_PERMISSIONS = ["users.access.manage"]
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
