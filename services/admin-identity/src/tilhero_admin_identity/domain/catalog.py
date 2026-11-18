"""Каталог прав и ролей TilHero — зеркало packages/contracts/src/admin.ts (`Permission`, `RoleCode`,
`PRIVILEGED_ROLES`; тот же порядок — порядок выдачи в API). Матрица по умолчанию — сид миграции 0001 (таблица
docs/sprint2/PLAN.md §«Роли и права»); источник истины во время работы — таблицы roles/role_permissions
(меняются только через four-eyes)."""

from __future__ import annotations

from typing import Literal, get_args

Permission = Literal[
    "dashboard.read",
    "users.read",
    "users.sensitive.read",
    "support.read",
    "support.reply",
    "support.manage",
    "audit.read",
    "config.read",
    "config.edit",
    "config.publish",
    "whatsnew.manage",
    "whatsnew.publish",
    "notif.templates.manage",
    "notif.campaigns.manage",
    "notif.campaigns.send",
    "staff.manage",
    "roles.manage",
]
RoleCode = Literal[
    "super_admin", "operations", "communications", "support", "methodist", "analyst", "auditor", "read_only"
]

PERMISSIONS: tuple[str, ...] = get_args(Permission)
ROLE_CODES: tuple[str, ...] = get_args(RoleCode)
# MFA обязательна; назначение такой роли — four-eyes (admin.ts PRIVILEGED_ROLES)
PRIVILEGED_ROLES: frozenset[str] = frozenset({"super_admin", "operations", "communications"})
# Права, наличие любого из которых делает роль привилегированной (MFA обязательна, назначение — four-eyes):
# раскрытие Telegram ID, управление сотрудниками и ролями и все права, чьи команды требуют step-up (повторный TOTP,
# PLAN §«Роли и права»): публикация конфигурации, публикация и снятие «Что нового», активация и сброс шаблона
# уведомления, расписание и остановка рассылки. Без MFA step-up невозможен, поэтому роль, получившая такое право
# через four-eyes, обязана подключить MFA (сессии её сотрудников отзываются). Роль привилегированна, если она
# в PRIVILEGED_ROLES ИЛИ содержит хотя бы одно из этих прав — расширение матрицы непривилегированной роли не обходит
# MFA и four-eyes.
PRIVILEGED_PERMISSIONS: frozenset[str] = frozenset({
    "users.sensitive.read", "staff.manage", "roles.manage", "config.publish", "whatsnew.publish",
    "notif.templates.manage", "notif.campaigns.send",
})
SUPER_ADMIN = "super_admin"
DEFAULT_ROLE = "read_only"


def privileged_by(role: str, permissions: set[str] | frozenset[str] | list[str]) -> bool:
    return role in PRIVILEGED_ROLES or bool(PRIVILEGED_PERMISSIONS.intersection(permissions))
