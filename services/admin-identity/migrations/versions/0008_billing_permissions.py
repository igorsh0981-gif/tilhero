"""Спринт 8: права денег и роль finance (docs/sprint8/PLAN.md §«Права и роли», docs/sprint8/INTERNAL_API.md §9; каталог —
packages/contracts/src/admin.ts `Permission`, `RoleCode`).

Права: billing.read (каталог, заказы, платежи, подписка и минуты ученика, сверка, отчёты), billing.manage (черновик
каталога и проверка, курсы USD и Stars, разбор сверки, ручной прогон), billing.publish (активация и откат каталога,
массовая выдача пробного — step-up), billing.approve (решение по заявке «четыре глаза» — step-up), billing.refund
(возврат — step-up), subscriptions.override (заявка на корректировку минут, выдачу или отзыв периода — step-up).

Новая роль `finance` («Финансы»): billing.* кроме subscriptions.override, costs.read, dashboard.read, users.read.
`PRIVILEGED_ROLES` admin.ts не расширяется: finance привилегирована составом прав (billing.publish, billing.approve,
billing.refund — со step-up; правило спринта 2, domain/catalog.py PRIVILEGED_PERMISSIONS) — MFA обязательна, назначение
— four-eyes. support — + billing.read, subscriptions.override (уже привилегирована с 0007 — moderation.manage);
operations — + все права денег; analyst, auditor — + billing.read (без step-up — не привилегированы); super_admin — все.
Матрица добавляется к действующей (INSERT … ON CONFLICT DO NOTHING): изменения four-eyes после 0001–0007 не
затираются. Роль, ставшая привилегированной, — сессии её сотрудников отзываются (session_version + 1; при следующем
входе — подключение TOTP), как в 0004/0005/0007. Значения зафиксированы здесь, а не импортируются из кода: миграция не
меняется вместе с каталогом.

Step-up самих команд (каталог, корректировки и их решения, возвраты, массовый пробный, деградация ИИ) проверяют
admin-bff (повторный TOTP) и домены (заголовок X-Step-Up) — admin-identity только делает права со step-up признаком
привилегированной роли.

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-22
"""
import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

NEW_PERMISSIONS = ["billing.read", "billing.manage", "billing.publish", "billing.approve", "billing.refund",
                   "subscriptions.override"]

# (code, name_ru, name_en) — новая роль; порядок в каталоге — после qa_analyst (admin.ts RoleCode)
NEW_ROLES = [("finance", "Финансы", "Finance")]

BILLING = ["billing.read", "billing.manage", "billing.publish", "billing.approve", "billing.refund"]
# Добавляемые права по ролям (PLAN спринта 8 «Права и роли»); super_admin — все новые
GRANTS: dict[str, list[str]] = {
    "super_admin": NEW_PERMISSIONS,
    "finance": [*BILLING, "costs.read", "dashboard.read", "users.read"],
    "support": ["billing.read", "subscriptions.override"],
    "operations": NEW_PERMISSIONS,
    "analyst": ["billing.read"],
    "auditor": ["billing.read"],
}

# admin.ts PRIVILEGED_ROLES (MFA по коду роли) и права со step-up после спринта 8 (domain/catalog.py)
PRIVILEGED_ROLES = ["super_admin", "operations", "communications"]
PRIVILEGED_PERMISSIONS = ["users.sensitive.read", "staff.manage", "roles.manage", "config.publish",
                          "whatsnew.publish", "notif.templates.manage", "notif.campaigns.send",
                          "content.publish", "media.rights", "lang.manage",
                          "ai.publish", "qa.review", "costs.manage",
                          "memory.manage",
                          "game.publish", "wallet.adjust",
                          "moderation.manage", "referral.manage", "league.manage", "room.manage",
                          "billing.publish", "billing.approve", "billing.refund", "subscriptions.override"]
# до 0008 (0007_social_permissions.PRIVILEGED_PERMISSIONS) — для отката
PRIVILEGED_PERMISSIONS_V7 = ["users.sensitive.read", "staff.manage", "roles.manage", "config.publish",
                             "whatsnew.publish", "notif.templates.manage", "notif.campaigns.send",
                             "content.publish", "media.rights", "lang.manage",
                             "ai.publish", "qa.review", "costs.manage",
                             "memory.manage",
                             "game.publish", "wallet.adjust",
                             "moderation.manage", "referral.manage", "league.manage", "room.manage"]


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
    # сотрудники роли finance → read_only (роль удаляется), их сессии отзываются
    bind.execute(sa.text(
        "UPDATE staff SET role = 'read_only', session_version = session_version + 1, updated_at = now() "
        "WHERE role = 'finance'"
    ))
    # незавершённые заявки, ссылающиеся на новую роль или права, после отката неисполнимы
    bind.execute(sa.text(
        "UPDATE approvals SET status = 'REJECTED', decided_at = now(), decision_note = 'migration 0008 downgrade' "
        "WHERE status = 'PENDING' AND ("
        " payload->>'role' = 'finance' OR payload->>'to_role' = 'finance'"
        " OR payload->>'from_role' = 'finance'"
        " OR (jsonb_typeof(payload->'permissions') = 'array' AND (payload->'permissions') ?| CAST(:perms AS text[])))"
    ).bindparams(sa.bindparam("perms", NEW_PERMISSIONS)))
    bind.execute(sa.text("DELETE FROM role_permissions WHERE permission = ANY(:perms)")
                 .bindparams(sa.bindparam("perms", NEW_PERMISSIONS)))
    for code, _, _ in NEW_ROLES:
        bind.execute(sa.text("DELETE FROM role_permissions WHERE role = :code"), {"code": code})
        bind.execute(sa.text("DELETE FROM roles WHERE code = :code"), {"code": code})
    bind.execute(_privileged_sql(PRIVILEGED_PERMISSIONS_V7))
    bind.execute(sa.text("UPDATE roles SET updated_at = now() WHERE code = ANY(:roles)")
                 .bindparams(sa.bindparam("roles", sorted(GRANTS))))
