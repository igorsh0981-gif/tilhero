"""Сотрудники для тестов experience-config.

Конфигурация интерфейса — config.read/edit/publish (роль operations, super_admin); «Что нового» — whatsnew.manage
(список, черновик, статистика) и whatsnew.publish (публикация и снятие) — роль communications (PLAN «Роли и права»).
"""

from tilhero_common.internal_auth import Actor

READER = Actor(id="staff-ops-1", role="operations", permissions=frozenset({"config.read"}))
EDITOR = Actor(id="staff-design-2", role="designer", permissions=frozenset({"config.read", "config.edit"}))
PUBLISHER = Actor(id="staff-admin-3", role="operations",
                  permissions=frozenset({"dashboard.read", "config.read", "config.edit", "config.publish"}))
SUPPORT = Actor(id="staff-support-4", role="support", permissions=frozenset({"support.reply"}))

# «Что нового»
WN_EDITOR = Actor(id="staff-comms-5", role="communications", permissions=frozenset({"whatsnew.manage"}))
WN_PUBLISHER = Actor(id="staff-comms-6", role="communications",
                     permissions=frozenset({"dashboard.read", "whatsnew.manage", "whatsnew.publish"}))
DASHBOARD = Actor(id="staff-analyst-7", role="analyst", permissions=frozenset({"dashboard.read", "users.read"}))
