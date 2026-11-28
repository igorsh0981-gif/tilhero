"""Спринт 8: конфигурация админки 1.8.0 (миграция 0010) — группа «Деньги» (tariffs, payments, adjustments,
reconciliation, finance) сразу после «Сообщества»; активируется поверх версии выкладки (1.7.0 от system:release),
версию сотрудника не подменяет (в т. ч. его откат на 1.0.0); событие активации и аудит — как у публикации
сотрудником; обратимость."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest
from conftest import SERVICE_DIR
from exp_actors import EDITOR, PUBLISHER, READER
from test_admin_menu_7 import COMMUNITY, GAME, admin_state, groups_in_order, nav_groups, version_status
from test_release_notes import _alembic

from tilhero_common.testing import assert_event_conforms
from tilhero_experience.domain.payload import ADMIN_MENU, MENU_ALIASES, validate_payload

BASE = "/admin/v1/experience"
MONEY = ["tariffs", "payments", "adjustments", "reconciliation", "finance"]


def migration() -> ModuleType:
    path = Path(SERVICE_DIR) / "migrations" / "versions" / "0010_admin_menu_money.py"
    spec = importlib.util.spec_from_file_location("exp_migration_0010", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def migration_0008() -> ModuleType:
    path = Path(SERVICE_DIR) / "migrations" / "versions" / "0008_admin_menu_social.py"
    spec = importlib.util.spec_from_file_location("exp_migration_0008b", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------- порядок меню


def test_money_group_right_after_community() -> None:
    m = migration()
    menu = [item["id"] for item in m.PAYLOAD["layout"]["menu"]]
    group_of = nav_groups()
    groups = groups_in_order(menu, group_of)
    assert [g for g, _ in groups] == ["product", "ai", "game", "social", "money", "comms", "manage"]
    assert sum(len(items) for _, items in groups) == len(menu)
    assert dict(groups)["money"] == MONEY and list(m.MONEY) == MONEY
    assert dict(groups)["social"] == COMMUNITY and dict(groups)["game"] == GAME
    assert menu.index("tariffs") == menu.index("pair_rooms") + 1 and menu.index("news") == menu.index("finance") + 1
    # все разделы admin-web на своих местах (каталог схемы и nav.ts), ничего не выключено
    assert {MENU_ALIASES.get(s, s) for s in menu} == {MENU_ALIASES.get(s, s) for s in ADMIN_MENU}
    assert set(group_of) == set(menu)
    assert all(item["enabled"] for item in m.PAYLOAD["layout"]["menu"])
    # остальное — как в 1.7.0: тема, плотность, флаги и порядок прежних разделов
    prev = migration_0008().PAYLOAD
    assert m.PAYLOAD["theme"] == prev["theme"] and m.PAYLOAD["flags"] == prev["flags"]
    assert m.PAYLOAD["layout"]["density"] == prev["layout"]["density"]
    assert [s for s in menu if s not in MONEY] == [i["id"] for i in prev["layout"]["menu"]]
    assert validate_payload("admin", m.PAYLOAD) == m.PAYLOAD


# ---------------------------------------------------------------- выкладка


async def test_version_180_active_after_deploy(env) -> None:
    state = await admin_state(env)
    assert (state["current"]["version"], state["previous_version"]) == ("1.8.0", "1.7.0")
    assert state["current"]["activated_by"] == "system:release" and state["current"]["kind"] == "activate"
    current = (await env.current("admin", issuer="admin-bff")).json()
    assert [item["id"] for item in current["layout"]["menu"]] == list(migration().MENU)
    detail = (await env.c.get(f"{BASE}/admin/versions/1.8.0", headers=env.h(READER))).json()
    assert detail["created_by"] == "system:release" and "Деньги" in detail["change_note"]
    assert (await env.current("miniapp")).json()["version"] == "1.0.0"  # Mini App не затронута
    events = [e for e in env.migration_events
              if (e.event_type == "experience.config.activated.v1" and e.payload["version"] == "1.8.0")
              or (e.event_type == "admin.audit.recorded.v1" and e.payload["object_type"] == "experience_config"
                  and e.payload["object_id"] == "admin@1.8.0")]
    assert sorted((e.event_type, e.payload.get("action") or "") for e in events) == [
        ("admin.audit.recorded.v1", "config.create"), ("admin.audit.recorded.v1", "config.publish"),
        ("experience.config.activated.v1", "")]
    by_action = {e.payload.get("action"): e for e in events}
    activated = by_action[None].payload
    assert (activated["app"], activated["version"], activated["previous_version"]) == ("admin", "1.8.0", "1.7.0")
    assert activated["activation_id"] == state["current"]["activation_id"]
    for e in (by_action["config.create"], by_action["config.publish"]):
        assert (e.payload["actor_type"], e.payload["actor_id"], e.payload["actor_role"]) == (
            "system", "system:release", None)
    assert by_action["config.publish"].payload["before"] == {"version": "1.7.0"}
    for e in events:
        assert_event_conforms(e)
    # откат сотрудником возвращает 1.7.0
    rb = await env.c.post(f"{BASE}/admin/rollback", json={"reason": "Вернуть меню спринта 7"},
                          headers=env.h(PUBLISHER))
    assert rb.status_code == 201 and (rb.json()["version"], rb.json()["previous_version"]) == ("1.7.0", "1.8.0")


async def test_staff_choice_is_not_replaced(env) -> None:
    """Админку переключил сотрудник (своя версия или откат на сидовую 1.0.0): 1.8.0 создаётся, но не активируется."""
    await _alembic(env, "downgrade", "0009")
    assert await version_status(env, "1.8.0") == 404
    payload = await env.seed_payload("admin", "1.7.0")
    payload["layout"]["density"] = "comfortable"
    created = await env.c.post(f"{BASE}/admin/versions",
                               json={"version": "1.7.5", "payload": payload, "change_note": "Просторнее"},
                               headers=env.h(EDITOR))
    assert created.status_code == 201, created.text
    act = await env.c.post(f"{BASE}/admin/activate", json={"version": "1.7.5", "reason": "Просторная админка"},
                           headers=env.h(PUBLISHER))
    assert act.status_code == 201, act.text
    await _alembic(env, "upgrade", "head")
    assert (await admin_state(env))["current"]["version"] == "1.7.5" and await version_status(env, "1.8.0") == 200
    # откат сотрудником на сидовую 1.0.0 — тоже выбор сотрудника
    await _alembic(env, "downgrade", "0009")
    rb = await env.c.post(f"{BASE}/admin/activate", json={"version": "1.0.0", "reason": "Старое меню"},
                          headers=env.h(PUBLISHER))
    assert rb.status_code == 201, rb.text
    await _alembic(env, "upgrade", "head")
    assert (await admin_state(env))["current"]["version"] == "1.0.0"
    # сотрудник активирует 1.8.0 сам — откат миграции её не трогает
    activate = await env.c.post(f"{BASE}/admin/activate", json={"version": "1.8.0", "reason": "Меню спринта 8"},
                                headers=env.h(PUBLISHER))
    assert activate.status_code == 201
    await _alembic(env, "downgrade", "0009")
    assert await version_status(env, "1.8.0") == 200
    assert (await admin_state(env))["current"]["version"] == "1.8.0"


async def test_downgrade_and_reapply(env) -> None:
    await _alembic(env, "downgrade", "0009")
    state = await admin_state(env)
    assert (state["current"]["version"], state["previous_version"]) == ("1.7.0", "1.0.0")
    assert await version_status(env, "1.8.0") == 404
    await _alembic(env, "upgrade", "head")
    state = await admin_state(env)
    assert (state["current"]["version"], state["previous_version"]) == ("1.8.0", "1.7.0")


async def test_upgrade_fails_when_version_is_taken(env) -> None:
    await _alembic(env, "downgrade", "0009")
    payload = await env.seed_payload("admin", "1.7.0")
    payload["layout"]["density"] = "comfortable"
    created = await env.c.post(f"{BASE}/admin/versions",
                               json={"version": "1.8.0", "payload": payload, "change_note": "Своя 1.8"},
                               headers=env.h(EDITOR))
    assert created.status_code == 201, created.text
    with pytest.raises(RuntimeError, match="version is taken"):
        await _alembic(env, "upgrade", "head")
    assert (await admin_state(env))["current"]["version"] == "1.7.0"
