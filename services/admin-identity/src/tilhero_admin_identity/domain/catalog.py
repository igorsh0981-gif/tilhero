"""Каталог прав и ролей (зеркало packages/contracts/src/admin.ts). Матрица по умолчанию — сид миграции 0001
(+ права спринта 4 — миграция 0005, спринта 6 — миграция 0006, спринта 7 — миграция 0007, спринта 8 — 0008);
источник истины во время работы — таблицы roles/role_permissions."""

from __future__ import annotations

from typing import Literal, get_args

Permission = Literal[
    "dashboard.read",
    "users.read",
    "users.sensitive.read",
    "ai.content.read",
    "export.csv",
    "support.read",
    "support.reply",
    "support.manage",
    "subscriptions.override",
    "billing.refund",
    "skills.edit",
    "skills.publish",
    "audit.read",
    "config.read",
    "config.edit",
    "config.publish",
    "ops.kill_switch",
    "staff.manage",
    "roles.manage",
    # спринт 4: AI-поиск событий (docs/sprint4/INTERNAL_API.md §7)
    "events.review",
    "sources.manage",
    "discovery.manage",
    # спринт 6: реестр лент новостей и модерация новостей (docs/sprint6/INTERNAL_API.md §3.1, §8)
    "news.manage",
    # спринт 7: назначение пользователю уровня доступа к AI (docs/sprint7/INTERNAL_API.md §2.7, §4)
    "users.access.manage",
    # спринт 8: DLQ — просмотр маскированного payload, повтор и удаление сообщений (docs/sprint8/INTERNAL_API.md §7.6)
    "ops.queues.manage",
]
RoleCode = Literal[
    "super_admin", "operations", "support", "billing", "agent_manager", "analyst", "auditor", "read_only"
]

PERMISSIONS: tuple[str, ...] = get_args(Permission)
ROLE_CODES: tuple[str, ...] = get_args(RoleCode)
# MFA обязательна; назначение такой роли — four-eyes
PRIVILEGED_ROLES: frozenset[str] = frozenset({"super_admin", "operations", "billing", "agent_manager"})
# Права, наличие любого из которых делает роль привилегированной (MFA обязательна, назначение — four-eyes):
# доступ к PII/содержимому, деньгам, публикации/аварийным выключателям, выгрузкам, управлению доступом,
# allowlist источников AI-поиска (sources.manage: от него зависит, какие сайты загружаются и что публикуется).
# news.manage (спринт 6: ленты новостей, скрытие новостей) привилегированным не является: ленты читаются только
# через provider-gateway с его SSRF-защитой и бюджетом AI, новость без https-источника не сохраняется.
# users.access.manage (спринт 7) — тоже нет: меняет только лимит сообщений консьержа (потолок уровня 1000/сутки),
# всегда с причиной, сроком и синхронным аудитом в ai-control; PII и деньги не затрагивает.
# ops.queues.manage (спринт 8) — привилегированное: повтор и удаление сообщений шины (удаление необратимо) и просмотр
# payload DLQ (пусть маскированного).
# Роль привилегированна, если она в PRIVILEGED_ROLES (контракт admin.ts) ИЛИ содержит хотя бы одно из этих прав —
# расширение матрицы непривилегированной роли не обходит MFA и four-eyes.
PRIVILEGED_PERMISSIONS: frozenset[str] = frozenset({
    "staff.manage", "roles.manage", "users.sensitive.read", "billing.refund", "subscriptions.override",
    "config.publish", "ops.kill_switch", "ai.content.read", "export.csv", "sources.manage", "ops.queues.manage",
})
SUPER_ADMIN = "super_admin"


def privileged_by(role: str, permissions: set[str] | frozenset[str] | list[str]) -> bool:
    return role in PRIVILEGED_ROLES or bool(PRIVILEGED_PERMISSIONS.intersection(permissions))


DEFAULT_ROLE = "read_only"
