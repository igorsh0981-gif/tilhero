"""Спринт 7 (INTERNAL_API §5, §6): категория уведомлений `game` — в настройках ученика (bff.ts NotificationCategories),
по умолчанию включена (новым аккаунтам и детским профилям), выключается и включается как остальные; в доставке
(DeliveryInfo.categories) — без цели согласия. Миграция 0005 добавляет её действующим ученикам; откат убирает."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text

from tilhero_identity.domain.notify import CATEGORIES, DEFAULT_CATEGORIES, apply_categories, normalize_categories

SERVICE_DIR = Path(__file__).resolve().parents[1]


def test_categories_and_defaults() -> None:
    assert CATEGORIES == ("reminders", "missed", "social", "support", "product", "game")
    assert DEFAULT_CATEGORIES == ("support", "game")
    assert normalize_categories(["game", "support", "game"]) == ["support", "game"]
    assert apply_categories(["support", "game"], {"game": False}) == ["support"]


async def test_game_default_on_switchable_and_delivered(env) -> None:
    uid = await env.adult()
    me = (await env.call("GET", "/internal/v1/me", uid)).json()
    assert me["settings"]["categories"]["game"] is True
    assert "game" in (await env.delivery(uid)).json()["categories"]  # цели согласия не нужно
    r = await env.call("PATCH", "/internal/v1/me/settings", uid, {"notifications": {"categories": {"game": False}}})
    assert r.status_code == 200 and r.json()["settings"]["categories"]["game"] is False
    assert "game" not in (await env.delivery(uid)).json()["categories"]
    [*_, last] = await env.events("user.notification_settings.changed.v1", uid)
    assert "game" not in last.payload["categories"]
    r = await env.call("PATCH", "/internal/v1/me/settings", uid, {"notifications": {"categories": {"game": True}}})
    assert r.json()["settings"]["categories"]["game"] is True
    r = await env.call("PATCH", "/internal/v1/me/settings", uid, {"notifications": {"categories": {"game": "yes"}}})
    assert r.status_code == 422
    # детский профиль — тоже включена (опекуну «в сводке», notifications — только центр)
    guardian = await env.parent()
    child = await env.child(guardian)
    assert "game" in (await env.delivery(child["learner_id"])).json()["categories"]


async def test_migration_0005_backfills_and_reverts(env) -> None:
    uid = await env.adult()
    cfg = Config(str(SERVICE_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVICE_DIR / "migrations"))
    cfg.attributes["settings"] = env.settings
    await env.runtime.db.dispose()  # отпускаем соединения пула перед DDL

    async def categories() -> list[str]:
        async with env.runtime.transaction() as s:
            return list((await s.execute(text("SELECT notify_categories FROM users WHERE user_id = :u"),
                                         {"u": uid})).scalar_one())

    assert await categories() == ["support", "game"]
    await asyncio.to_thread(command.downgrade, cfg, "0004")
    assert await categories() == ["support"]
    async with env.runtime.transaction() as s:
        await s.execute(text("UPDATE users SET notify_categories = '{reminders,support}' WHERE user_id = :u"),
                        {"u": uid})
    with pytest.raises(Exception, match="ck_users_notify_categories"):
        async with env.runtime.transaction() as s:
            await s.execute(text("UPDATE users SET notify_categories = '{support,game}' WHERE user_id = :u"),
                            {"u": uid})
    await asyncio.to_thread(command.upgrade, cfg, "head")
    assert await categories() == ["reminders", "support", "game"]  # действующим ученикам — включена
    await asyncio.to_thread(command.upgrade, cfg, "head")  # повтор — без изменений
    assert await categories() == ["reminders", "support", "game"]
