"""Разовая загрузка проекций (ревью 🔴3): выгрузки social `families`, `friendships` и diagnostics `levels` → проекции
через те же обработчики в режиме «только вставка»: более свежее состояние из событий не перетирается, снятая дружба
не возвращается, удалённые пропускаются; постранично с курсором; сбой источника — повтор следующим tick без падения;
force — заново; доступ — только токен планировщика; фоновая загрузка при старте. Повторное ревью 🔴 Н1: social
`profiles` (возраст и согласие родителя) — пустое или более старое заполняется, событие новее не перетирается."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from typing import Any

import httpx
from conftest import (
    SCHEDULER_TOKEN,
    SERVICE_DIR,
    Env,
    FakeDiagnostics,
    FakeLessons,
    FakeSocial,
    RecordingBus,
    make_settings,
)
from conftest import transports as make_transports
from sqlalchemy import text
from test_social_leagues import learner, rows

from tilhero_common.app import Runtime
from tilhero_common.testing import TEST_ADMIN_URL, create_schema, drop_schema, migrate, unique_schema
from tilhero_gamification.main import build_app


def family_item(env: Env, family: uuid.UUID, owner: uuid.UUID, user: uuid.UUID, role: str,
                days_ago: int = 30) -> dict[str, Any]:
    return {"family_id": str(family), "owner_user_id": str(owner), "user_id": str(user), "role": role,
            "added_at": (env.now - timedelta(days=days_ago)).isoformat().replace("+00:00", "Z")}


def friend_item(env: Env, a: uuid.UUID, b: uuid.UUID, days_ago: int = 30) -> dict[str, Any]:
    x, y = sorted((a, b), key=str)
    return {"user_a": str(x), "user_b": str(y), "status": "added", "source": "request",
            "at": (env.now - timedelta(days=days_ago)).isoformat().replace("+00:00", "Z")}


def level_item(env: Env, user: uuid.UUID, level: str, pair: str = "ru-en", days_ago: int = 30) -> dict[str, Any]:
    return {"user_id": str(user), "pair_id": pair, "result_id": str(uuid.uuid4()), "revision": 1,
            "test_id": "placement", "test_version": 1, "provisional_level": level, "areas": {},
            "recommended_start_lesson_id": None,
            "completed_at": (env.now - timedelta(days=days_ago)).isoformat().replace("+00:00", "Z")}


async def test_bootstrap_loads_projections_without_overwriting(env: Env) -> None:
    parent = await learner(env, "Parent")
    kid = uuid.uuid4()
    friend = await learner(env, "Friend")
    ex_friend = await learner(env, "ExFriend")
    moved = await learner(env, "Moved")
    gone = uuid.uuid4()
    family = uuid.uuid4()
    # свежее состояние из событий: дружба снята, moved уже в другой семье, у friend свежая диагностика
    await env.befriend(parent, ex_friend)
    await env.befriend(parent, ex_friend, "removed")
    newer = await env.family(moved, (uuid.uuid4(), "adult"))
    await env.diag(friend, "B2")
    await env.publish("user.deletion.requested.v1", {"user_id": str(gone), "request_id": str(uuid.uuid4()),
                                                     "requested_at": env.ts()}, "identity-consent")
    env.social.exports["families"] = [family_item(env, family, parent, kid, "child"),
                                      family_item(env, family, parent, moved, "adult"),
                                      family_item(env, family, parent, gone, "adult")]
    env.social.exports["friendships"] = [friend_item(env, parent, friend), friend_item(env, parent, ex_friend),
                                         friend_item(env, parent, gone)]
    env.diagnostics.levels = [level_item(env, friend, "A1"), level_item(env, parent, "A2"),
                              level_item(env, gone, "B1")]
    env.settings.projection_page_size = 2  # постранично
    out = await env.bootstrap()
    assert out == {"families": {"status": "completed", "items": 3}, "friendships": {"status": "completed", "items": 3},
                   "levels": {"status": "completed", "items": 3}, "profiles": {"status": "completed", "items": 0}}
    assert sorted(await env.sql("SELECT user_id, role FROM family_members WHERE family_id = :f", f=family),
                  key=lambda r: r[1]) == [(kid, "child"), (parent, "owner")]  # moved не перенесён, gone пропущен
    assert await env.sql("SELECT family_id FROM family_members WHERE user_id = :u", u=moved) == [(newer,)]
    assert await env.sql("SELECT status FROM social_friends WHERE :u IN (user_a, user_b) AND :e IN (user_a, user_b)",
                         u=parent, e=ex_friend) == [("removed",)]  # снятая дружба не возвращается
    assert await env.sql("SELECT count(*) FROM social_friends WHERE :g IN (user_a, user_b)", g=gone) == [(0,)]
    assert dict(await env.sql("SELECT user_id, level_band FROM learner_levels")) == {friend: "B1+", parent: "A2"}
    # лиги: семья и друзья — по загруженным проекциям
    await env.xp(parent, 1)
    view = await env.get(parent, "leagues")
    assert rows(view["friends"]) == [("Parent", 30, 1, True), ("Friend", 0, 2, False)]
    assert view["family"]["participants"] == 2 and view["general"]["level_band"] == "A2"
    kid_view = await env.get(kid, "leagues", age_band="6-9", account=parent)
    assert kid_view["friends"] is None and kid_view["family"]["participants"] == 2
    # повтор — без загрузки (завершена); force — заново и безопасно
    calls = env.diagnostics.calls
    assert (await env.bootstrap())["levels"]["status"] == "skipped" and env.diagnostics.calls == calls
    assert (await env.bootstrap(force=True))["levels"] == {"status": "completed", "items": 3}
    assert dict(await env.sql("SELECT user_id, level_band FROM learner_levels")) == {friend: "B1+", parent: "A2"}


async def test_bootstrap_source_failure_retried_by_tick(env: Env) -> None:
    user = uuid.uuid4()
    env.diagnostics.levels = [level_item(env, user, "A2")]
    env.diagnostics.down = True
    out = await env.bootstrap()
    assert out["levels"] == {"status": "failed", "items": 0} and out["families"]["status"] == "completed"
    [(error, completed)] = await env.sql("SELECT error, completed_at FROM projection_loads WHERE name = 'levels'")
    assert error == "UpstreamError" and completed is None
    assert (await env.tick())["projections_loaded"] == 0  # всё ещё недоступен — сервис работает
    env.diagnostics.down = False
    assert (await env.tick())["projections_loaded"] == 1
    assert await env.sql("SELECT level_band FROM learner_levels WHERE user_id = :u", u=user) == [("A2",)]
    assert (await env.tick())["projections_loaded"] == 0
    # курсор продолжения: сбой на второй странице — загрузка продолжается с неё
    env.social.exports["friendships"] = [friend_item(env, uuid.uuid4(), uuid.uuid4()) for _ in range(3)]
    env.settings.projection_page_size = 1
    await env.bootstrap(force=True)
    assert await env.sql("SELECT count(*) FROM social_friends") == [(3,)]


async def test_bootstrap_auth(env: Env) -> None:
    r = await env.c.post("/internal/v1/projections/bootstrap")
    assert r.status_code == 401
    r = await env.c.post("/internal/v1/projections/bootstrap", headers=env.svc("telegram-bff"))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    r = await env.c.post("/internal/v1/projections/bootstrap", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


async def test_bootstrap_runs_in_background_on_start() -> None:
    schema = unique_schema("game_boot")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema, projection_bootstrap_on_start=True)
    await migrate(SERVICE_DIR, settings)
    social, lessons, diagnostics = FakeSocial(), FakeLessons(), FakeDiagnostics()
    a, b = uuid.uuid4(), uuid.uuid4()
    social.exports["friendships"] = [{"user_a": str(min(a, b, key=str)), "user_b": str(max(a, b, key=str)),
                                      "status": "added", "source": "invite", "at": "2026-11-01T00:00:00Z"}]
    runtime = Runtime(settings, bus=RecordingBus())
    app = build_app(settings, runtime, transports=make_transports(social, lessons, diagnostics))
    try:
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://g") as c:
                assert (await c.get("/health/live")).status_code == 200  # готовность не ждёт загрузку
                for _ in range(50):
                    async with runtime.transaction() as db:
                        done = (await db.execute(text(
                            "SELECT count(*) FROM projection_loads WHERE completed_at IS NOT NULL"))).scalar()
                    if done == 4:
                        break
                    await asyncio.sleep(0.2)
                assert done == 4
                async with runtime.transaction() as db:
                    n = (await db.execute(text("SELECT count(*) FROM social_friends"))
                         ).scalar()
                assert n == 1
                r = await c.post("/internal/v1/projections/bootstrap",
                                 headers={"Authorization": f"Bearer {SCHEDULER_TOKEN}"})
                assert r.json()["friendships"]["status"] == "skipped"
    finally:
        await drop_schema(schema)


def profile_item(env: Env, user: uuid.UUID, age_band: str | None, consent: str | None,
                 days_ago: int = 30) -> dict[str, Any]:
    """Элемент выгрузки identity-consent `profiles` (своя форма, не payload события)."""
    return {"user_id": str(user), "kind": "account", "age_band": age_band, "guardian_consent": consent,
            "updated_at": (env.now - timedelta(days=days_ago)).isoformat().replace("+00:00", "Z")}


async def test_bootstrap_profiles_teen_with_old_consent_joins_general_league(env: Env) -> None:
    """Подросток получил согласие родителя раньше окна стрима (события нет) → после загрузки `profiles` попадает в
    общую лигу. Событие новее выгрузки не перетирается, выгрузка новее события — применяется; удалённые и элементы
    без известных значений пропускаются; детский профиль возраст из выгрузки не получает."""
    teen = await learner(env, "Teen", age_band="14-17")  # возраст из токена, согласия в проекции нет
    out = await env.send("PATCH", teen, "settings", {"league_opt_in": True}, 403, age_band="14-17")
    assert out["details"] == {"reason": "guardian_consent"}
    fresh = await learner(env, "Fresh", age_band="14-17")
    await env.identity(fresh, "14-17", "declined")  # событие свежее выгрузки: отзыв не перетирается
    stale = await learner(env, "Stale", age_band="14-17")
    await env.identity(stale, "14-17", "pending")
    env.now += timedelta(days=1)
    gone, empty, newcomer = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await env.publish("user.deletion.requested.v1", {"user_id": str(gone), "request_id": str(uuid.uuid4()),
                                                     "requested_at": env.ts()}, "identity-consent")
    seen = dict(await env.sql("SELECT user_id, profile_updated_at FROM learners WHERE user_id IN (:a, :b)",
                              a=fresh, b=stale))  # время событий профиля (occurred_at конверта)

    def at(user: uuid.UUID, delta: timedelta) -> dict[str, Any]:
        item = profile_item(env, user, "14-17", "granted")
        item["updated_at"] = (seen[user] + delta).isoformat()
        return item

    env.idc.profiles = [
        profile_item(env, teen, "14-17", "granted", days_ago=60),
        at(fresh, -timedelta(days=3)),  # выгрузка старее события «declined»
        at(stale, timedelta(minutes=1)),  # выгрузка новее события «pending»
        profile_item(env, gone, "14-17", "granted"),
        profile_item(env, empty, None, None),
        profile_item(env, newcomer, "14-17", "granted"),  # ещё не открывал игру — строка ученика с согласием
    ]
    env.settings.projection_page_size = 4
    assert (await env.bootstrap())["profiles"] == {"status": "completed", "items": 6}
    got = dict((u, (b, c)) for u, b, c in await env.sql(
        "SELECT user_id, age_band, guardian_consent FROM learners WHERE user_id IN (:a, :b, :c, :d, :e, :f)",
        a=teen, b=fresh, c=stale, d=gone, e=empty, f=newcomer))
    assert got == {teen: ("14-17", "granted"), fresh: ("14-17", "declined"), stale: ("14-17", "granted"),
                   newcomer: ("14-17", "granted")}
    await env.send("PATCH", teen, "settings", {"league_opt_in": True}, age_band="14-17")
    g = (await env.get(teen, "leagues", age_band="14-17"))["general"]
    assert g["available"] is True and g["group"]["participants"] == 1
    out = await env.send("PATCH", fresh, "settings", {"league_opt_in": True}, 403, age_band="14-17")
    assert out["details"] == {"reason": "guardian_consent"}
    # повторная загрузка не перетирает событие, пришедшее после неё
    await env.identity(teen, "14-17", "declined")
    await env.bootstrap(force=True)
    assert await env.sql("SELECT guardian_consent FROM learners WHERE user_id = :u", u=teen) == [("declined",)]
