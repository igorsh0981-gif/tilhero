"""Каталог прав и ролей TilHero — зеркало packages/contracts/src/admin.ts (`Permission`, `RoleCode`,
`PRIVILEGED_ROLES`; тот же порядок — порядок выдачи в API). Матрица по умолчанию — сид миграции 0001 (таблица
docs/sprint2/PLAN.md §«Роли и права») плюс миграция 0003 (права контента и роль content_manager, docs/sprint3/PLAN.md
§«Права и роли») и миграция 0004 (права ИИ, контроля диалогов и затрат, роль qa_analyst, docs/sprint4/PLAN.md
§«Права и роли») и миграция 0005 (права памяти и словаря курса, docs/sprint5/PLAN.md §«Права и роли») и миграция 0006
(права игры и кошельков учеников, docs/sprint6/PLAN.md §«Права и роли»); источник истины во время работы — таблицы
roles/role_permissions (меняются только через four-eyes)."""

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
    # спринт 3 — контент, медиа, языки (миграция 0003)
    "content.read",
    "content.edit",
    "content.review",
    "content.publish",
    "media.rights",
    "lang.manage",
    # спринт 4 — ИИ-агенты, контроль диалогов, затраты (миграция 0004)
    "ai.read",
    "ai.manage",
    "ai.publish",
    "qa.read",
    "qa.transcripts",
    "qa.review",
    "costs.read",
    "costs.manage",
    # спринт 5 — память и повторения, словарь курса (миграция 0005)
    "memory.read",
    "memory.manage",
    "glossary.manage",
    # спринт 6 — игра и герои, кошельки учеников (миграция 0006)
    "game.read",
    "game.manage",
    "game.publish",
    "wallet.adjust",
]
RoleCode = Literal[
    "super_admin", "operations", "communications", "support", "methodist", "content_manager", "qa_analyst", "analyst",
    "auditor", "read_only",
]

PERMISSIONS: tuple[str, ...] = get_args(Permission)
ROLE_CODES: tuple[str, ...] = get_args(RoleCode)
# MFA обязательна; назначение такой роли — four-eyes (admin.ts PRIVILEGED_ROLES)
PRIVILEGED_ROLES: frozenset[str] = frozenset({"super_admin", "operations", "communications"})
# Права, наличие любого из которых делает роль привилегированной (MFA обязательна, назначение — four-eyes):
# раскрытие Telegram ID, управление сотрудниками и ролями и все права, чьи команды требуют step-up (повторный TOTP,
# PLAN §«Роли и права»): публикация конфигурации, публикация и снятие «Что нового», активация и сброс шаблона
# уведомления, расписание и остановка рассылки; спринт 3 — публикация, снятие и откат контента и тестов диагностики
# (content.publish), права медиа и решения по заявкам учеников (media.rights), языки и пары (lang.manage);
# спринт 4 — публикация, канарейка и откат версии агента, модели и цены (ai.publish), переоценка и решение по
# апелляции (qa.review), бюджет и аварийная остановка ИИ (costs.manage); спринт 5 — ручная правка карточки ученика
# (memory.manage; словарь курса glossary.manage — без step-up); спринт 6 — активация и откат правил игры, публикация
# героев, предметов магазина и событий недели (game.publish), ручные операции и обратная запись в кошельке ученика,
# возврат покупки (wallet.adjust; черновики game.manage — без step-up). Без MFA step-up невозможен, поэтому роль,
# получившая такое право через four-eyes, обязана подключить MFA (сессии её сотрудников отзываются). Роль
# привилегированна, если она в PRIVILEGED_ROLES ИЛИ содержит хотя бы одно из этих прав — расширение матрицы
# непривилегированной роли не обходит MFA и four-eyes.
PRIVILEGED_PERMISSIONS: frozenset[str] = frozenset({
    "users.sensitive.read", "staff.manage", "roles.manage", "config.publish", "whatsnew.publish",
    "notif.templates.manage", "notif.campaigns.send",
    "content.publish", "media.rights", "lang.manage",
    "ai.publish", "qa.review", "costs.manage",
    "memory.manage",
    "game.publish", "wallet.adjust",
})
SUPER_ADMIN = "super_admin"
DEFAULT_ROLE = "read_only"


def privileged_by(role: str, permissions: set[str] | frozenset[str] | list[str]) -> bool:
    return role in PRIVILEGED_ROLES or bool(PRIVILEGED_PERMISSIONS.intersection(permissions))
