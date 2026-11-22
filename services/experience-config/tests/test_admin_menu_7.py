"""Спринт 7: конфигурация админки 1.7.0 (миграция 0008) — группа «Сообщество» (friends, moderation, referrals, leagues,
pair_rooms) сразу после группы «Игра» (heroes, game, events); активируется вместо нетронутой сидовой 1.0.0, версию
сотрудника не подменяет; событие активации и аудит — как у публикации сотрудником; обратимость."""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from conftest import SERVICE_DIR
from exp_actors import EDITOR, PUBLISHER, READER
from test_release_notes import _alembic

from tilhero_common.testing import assert_event_conforms
from tilhero_experience.domain.payload import ADMIN_MENU, MENU_ALIASES, validate_payload

BASE = "/admin/v1/experience"
NAV_TS = Path(SERVICE_DIR).parents[1] / "apps" / "admin-web" / "src" / "state" / "nav.ts"
GAME = ["heroes", "game", "events"]
COMMUNITY = ["friends", "moderation", "referrals", "leagues", "pair_rooms"]


def migration() -> ModuleType:
    path = Path(SERVICE_DIR) / "migrations" / "versions" / "0008_admin_menu_social.py"
    spec = importlib.util.spec_from_file_location("exp_migration_0008", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def nav_groups() -> dict[str, str]:
    """Раздел → группа меню admin-web (NAV_ITEMS в apps/admin-web/src/state/nav.ts)."""
    pairs = re.findall(r'\{ id: "([a-z_]+)", group: "([a-z]+)"', NAV_TS.read_text(encoding="utf-8"))
    assert pairs, NAV_TS
    return dict(pairs)


def groups_in_order(menu: list[str], group_of: dict[str, str]) -> list[tuple[str, list[str]]]:
    """Как visibleNav admin-web: группа встаёт туда, где появился её первый раздел; внутри — порядок конфигурации."""
    out: list[tuple[str, list[str]]] = []
    for section in menu:
        group = group_of[{"game_events": "events"}.get(section, section)]
        if not out or all(g != group for g, _ in out):
            out.append((group, []))
        next(items for g, items in out if g == group).append(section)
    return out


async def admin_state(env) -> dict[str, Any]:
    r = await env.c.get(f"{BASE}/admin/state", headers=env.h(READER))
    assert r.status_code == 200, r.text
    return r.json()


async def version_status(env, version: str) -> int:
    return (await env.c.get(f"{BASE}/admin/versions/{version}", headers=env.h(READER))).status_code


# ---------------------------------------------------------------- порядок меню


def test_community_group_right_after_game() -> None:
    m = migration()
    menu = [item["id"] for item in m.PAYLOAD["layout"]["menu"]]
    group_of = nav_groups()
    groups = groups_in_order(menu, group_of)
    assert [g for g, _ in groups] == ["product", "ai", "game", "social", "comms", "manage"]
    # каждая группа — подряд, «Сообщество» — сразу за последним разделом «Игры»
    assert sum(len(items) for _, items in groups) == len(menu)
    assert dict(groups)["game"] == GAME and dict(groups)["social"] == COMMUNITY
    assert menu.index("friends") == menu.index("events") + 1
    assert menu[menu.index("heroes"):menu.index("pair_rooms") + 1] == GAME + COMMUNITY
    # все разделы admin-web на своих местах, ничего не выключено; memory — сразу после content (группа продукта)
    assert {MENU_ALIASES.get(s, s) for s in menu} == {MENU_ALIASES.get(s, s) for s in ADMIN_MENU}
    assert set(group_of) == set(menu)
    assert menu.index("memory") == menu.index("content") + 1
    assert all(item["enabled"] for item in m.PAYLOAD["layout"]["menu"])
    # остальное — как в сиде 1.0.0
    seed = importlib.util.spec_from_file_location("exp_seed_0002", Path(SERVICE_DIR) / "migrations" / "versions"
                                                  / "0002_seed.py")
    assert seed is not None and seed.loader is not None
    seed_mod = importlib.util.module_from_spec(seed)
    seed.loader.exec_module(seed_mod)
    assert m.PAYLOAD["theme"] == seed_mod.ADMIN_100["theme"] and m.PAYLOAD["flags"] == seed_mod.ADMIN_100["flags"]
    assert m.PAYLOAD["layout"]["density"] == seed_mod.ADMIN_100["layout"]["density"]
    assert validate_payload("admin", m.PAYLOAD) == m.PAYLOAD


def test_seed_100_puts_community_last() -> None:
    """Почему нужна новая версия: в 1.0.0 разделов «Сообщества» нет — admin-web дописывает их в конец (после
    «Управления»)."""
    seed = importlib.util.spec_from_file_location("exp_seed_0002b", Path(SERVICE_DIR) / "migrations" / "versions"
                                                  / "0002_seed.py")
    assert seed is not None and seed.loader is not None
    mod = importlib.util.module_from_spec(seed)
    seed.loader.exec_module(mod)
    menu = [item["id"] for item in mod.ADMIN_100["layout"]["menu"]]
    assert not set(COMMUNITY) & set(menu)
    group_of = nav_groups()
    # orderedItems: разделы конфигурации, затем не упомянутые — в порядке по умолчанию
    full = menu + [s for s in group_of if s not in menu]
    assert [g for g, _ in groups_in_order(full, group_of)][-1] == "social"


# ---------------------------------------------------------------- выкладка


async def test_version_170_active_after_deploy(env) -> None:
    state = await admin_state(env)
    assert (state["current"]["version"], state["previous_version"]) == ("1.7.0", "1.0.0")
    assert state["current"]["activated_by"] == "system:release" and state["current"]["kind"] == "activate"
    current = (await env.current("admin", issuer="admin-bff")).json()
    menu = [item["id"] for item in current["layout"]["menu"]]
    assert menu == list(migration().MENU)
    detail = (await env.c.get(f"{BASE}/admin/versions/1.7.0", headers=env.h(READER))).json()
    assert detail["created_by"] == "system:release" and "Сообщество" in detail["change_note"]
    # Mini App не затронута
    assert (await env.current("miniapp")).json()["version"] == "1.0.0"
    # событие активации и аудит — как у сотрудника, от имени выкладки
    events = [e for e in env.migration_events
              if e.event_type == "experience.config.activated.v1"
              or (e.event_type == "admin.audit.recorded.v1" and e.payload["object_type"] == "experience_config")]
    assert sorted((e.event_type, e.payload.get("action") or "") for e in events) == [
        ("admin.audit.recorded.v1", "config.create"), ("admin.audit.recorded.v1", "config.publish"),
        ("experience.config.activated.v1", "")]
    by_action = {e.payload.get("action"): e for e in events}
    activated = by_action[None].payload
    assert (activated["app"], activated["version"], activated["previous_version"]) == ("admin", "1.7.0", "1.0.0")
    assert activated["activation_id"] == state["current"]["activation_id"]
    for e in (by_action["config.create"], by_action["config.publish"]):
        p = e.payload
        assert (p["actor_type"], p["actor_id"], p["actor_role"], p["object_id"]) == (
            "system", "system:release", None, "admin@1.7.0")
    assert by_action["config.publish"].payload["before"] == {"version": "1.0.0"}
    for e in events:
        assert_event_conforms(e)
    # откат сотрудником возвращает сидовую 1.0.0
    rb = await env.c.post(f"{BASE}/admin/rollback", json={"reason": "Вернуть прежнее меню"},
                          headers=env.h(PUBLISHER))
    assert rb.status_code == 201 and (rb.json()["version"], rb.json()["previous_version"]) == ("1.0.0", "1.7.0")


async def test_staff_choice_is_not_replaced(env) -> None:
    """Админку уже переключил сотрудник: 1.7.0 создаётся, но не активируется — сотрудник активирует её сам."""
    await _alembic(env, "downgrade", "0007")
    assert await version_status(env, "1.7.0") == 404
    assert (await admin_state(env))["current"]["version"] == "1.0.0"
    payload = await env.seed_payload("admin", "1.0.0")
    payload["layout"]["density"] = "comfortable"
    created = await env.c.post(f"{BASE}/admin/versions",
                               json={"version": "1.1.0", "payload": payload, "change_note": "Просторнее"},
                               headers=env.h(EDITOR))
    assert created.status_code == 201, created.text
    act = await env.c.post(f"{BASE}/admin/activate", json={"version": "1.1.0", "reason": "Просторная админка"},
                           headers=env.h(PUBLISHER))
    assert act.status_code == 201, act.text
    await _alembic(env, "upgrade", "head")
    state = await admin_state(env)
    assert state["current"]["version"] == "1.1.0" and await version_status(env, "1.7.0") == 200
    versions = (await env.c.get(f"{BASE}/admin/versions", headers=env.h(READER))).json()["items"]
    assert {v["version"]: v["status"] for v in versions}["1.7.0"] != "current"
    # повторный подъём после отката безопасен; откат версии без активаций удаляет её
    await _alembic(env, "downgrade", "0007")
    assert await version_status(env, "1.7.0") == 404
    assert (await admin_state(env))["current"]["version"] == "1.1.0"
    await _alembic(env, "upgrade", "head")
    activate = await env.c.post(f"{BASE}/admin/activate", json={"version": "1.7.0", "reason": "Меню спринта 7"},
                                headers=env.h(PUBLISHER))
    assert activate.status_code == 201
    # 1.7.0 активировал сотрудник — откат миграции версию и историю не трогает
    await _alembic(env, "downgrade", "0007")
    assert await version_status(env, "1.7.0") == 200
    assert (await admin_state(env))["current"]["version"] == "1.7.0"


async def test_downgrade_and_reapply(env) -> None:
    await _alembic(env, "downgrade", "0007")
    state = await admin_state(env)
    assert (state["current"]["version"], state["previous_version"]) == ("1.0.0", None)
    assert await version_status(env, "1.7.0") == 404
    await _alembic(env, "upgrade", "head")
    state = await admin_state(env)
    assert (state["current"]["version"], state["previous_version"]) == ("1.7.0", "1.0.0")


async def test_upgrade_fails_when_version_is_taken(env) -> None:
    """Версию 1.7.0 с другим содержимым уже создал сотрудник — выкладка падает с понятной ошибкой, ничего не меняя."""
    await _alembic(env, "downgrade", "0007")
    payload = await env.seed_payload("admin", "1.0.0")
    payload["layout"]["density"] = "comfortable"
    created = await env.c.post(f"{BASE}/admin/versions",
                               json={"version": "1.7.0", "payload": payload, "change_note": "Своя 1.7"},
                               headers=env.h(EDITOR))
    assert created.status_code == 201, created.text
    with pytest.raises(RuntimeError, match="version is taken"):
        await _alembic(env, "upgrade", "head")
    state = await admin_state(env)
    assert state["current"]["version"] == "1.0.0"
