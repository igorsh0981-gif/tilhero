"""Спринт 7: права социального контура (docs/sprint7/PLAN.md §«Права», docs/sprint7/INTERNAL_API.md §6; каталог —
packages/contracts/src/admin.ts `Permission`).

Права: social.read (профиль сообщества, друзья, заявки, блокировки, дела и санкции ученика — без переписки),
moderation.manage (дела модерации, санкции, обжалования; step-up — social_ban больше 7 дней и бессрочный, проверяет
social), referral.read / referral.manage (кампании, очередь проверки; активация кампании — step-up), league.read /
league.manage (лиги и дуэли; переоценка — step-up), room.read / room.manage (парные комнаты; остановка — step-up).
Новых ролей нет. Матрица добавляется к действующей (INSERT … ON CONFLICT DO NOTHING): изменения, внесённые через
four-eyes после 0001–0006, не затираются.

moderation.manage, referral.manage, league.manage и room.manage — права со step-up: роль с любым из них
привилегированна (правило спринта 2, domain/catalog.py PRIVILEGED_PERMISSIONS). По матрице PLAN их получают operations
(привилегирована по коду роли), super_admin и **support** (moderation.manage) — support становится привилегированной:
MFA обязательна, назначение — four-eyes; сессии её сотрудников отзываются (при следующем входе — подключение TOTP), как
в 0004/0005. Значения зафиксированы здесь, а не импортируются из кода: миграция не меняется вместе с каталогом.

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-21
"""
import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

NEW_PERMISSIONS = ["social.read", "moderation.manage", "referral.read", "referral.manage", "league.read",
                   "league.manage", "room.read", "room.manage"]

# Новых ролей нет (admin.ts RoleCode не менялся)
NEW_ROLES: list[tuple[str, str, str]] = []

READS = ["social.read", "referral.read", "league.read", "room.read"]
# Добавляемые права по ролям (PLAN спринта 7 «Права»): support — + social.read, moderation.manage, referral.read,
# room.read; operations — + все; content_manager — + league.read; analyst, auditor — + *.read; super_admin — все
GRANTS: dict[str, list[str]] = {
    "super_admin": NEW_PERMISSIONS,
    "support": ["social.read", "moderation.manage", "referral.read", "room.read"],
    "operations": NEW_PERMISSIONS,
    "content_manager": ["league.read"],
    "analyst": READS,
    "auditor": READS,
}

# admin.ts PRIVILEGED_ROLES (MFA по коду роли) и права со step-up после спринта 7 (domain/catalog.py)
PRIVILEGED_ROLES = ["super_admin", "operations", "communications"]
PRIVILEGED_PERMISSIONS = ["users.sensitive.read", "staff.manage", "roles.manage", "config.publish",
                          "whatsnew.publish", "notif.templates.manage", "notif.campaigns.send",
                          "content.publish", "media.rights", "lang.manage",
                          "ai.publish", "qa.review", "costs.manage",
                          "memory.manage",
                          "game.publish", "wallet.adjust",
                          "moderation.manage", "referral.manage", "league.manage", "room.manage"]
# до 0007 (0006_game_permissions.PRIVILEGED_PERMISSIONS) — для отката
PRIVILEGED_PERMISSIONS_V6 = ["users.sensitive.read", "staff.manage", "roles.manage", "config.publish",
                             "whatsnew.publish", "notif.templates.manage", "notif.campaigns.send",
                             "content.publish", "media.rights", "lang.manage",
                             "ai.publish", "qa.review", "costs.manage",
                             "memory.manage",
                             "game.publish", "wallet.adjust"]


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
        "UPDATE approvals SET status = 'REJECTED', decided_at = now(), decision_note = 'migration 0007 downgrade' "
        "WHERE status = 'PENDING' AND jsonb_typeof(payload->'permissions') = 'array'"
        " AND (payload->'permissions') ?| CAST(:perms AS text[])"
    ).bindparams(sa.bindparam("perms", NEW_PERMISSIONS)))
    bind.execute(sa.text("DELETE FROM role_permissions WHERE permission = ANY(:perms)")
                 .bindparams(sa.bindparam("perms", NEW_PERMISSIONS)))
    bind.execute(_privileged_sql(PRIVILEGED_PERMISSIONS_V6))
    bind.execute(sa.text("UPDATE roles SET updated_at = now() WHERE code = ANY(:roles)")
                 .bindparams(sa.bindparam("roles", sorted(GRANTS))))
