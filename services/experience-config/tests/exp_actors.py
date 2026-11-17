"""Сотрудники для тестов experience-config (права — как в ТЗ Admin: config.read/edit/publish)."""

from tilhero_common.internal_auth import Actor

READER = Actor(id="staff-ops-1", role="operations", permissions=frozenset({"config.read"}))
EDITOR = Actor(id="staff-design-2", role="designer", permissions=frozenset({"config.read", "config.edit"}))
PUBLISHER = Actor(id="staff-admin-3", role="super_admin",
                  permissions=frozenset({"config.read", "config.edit", "config.publish"}))
SUPPORT = Actor(id="staff-support-4", role="support", permissions=frozenset({"support.reply"}))
