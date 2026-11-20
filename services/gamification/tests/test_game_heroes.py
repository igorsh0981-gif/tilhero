"""Герои (§1.4, AT-65): выбор из опубликованных своей аудитории, смена бесплатна, ступень 2 — 5 подтверждённых
навыков, 3 — 15; ступень не понижается при откате навыка; повторное подтверждение — без второй награды; картинка
ступени меняется; дети — дракончики первыми."""

from __future__ import annotations

import uuid

from conftest import Env


async def test_hero_list_and_select(env: Env, user: uuid.UUID) -> None:
    out = await env.get(user, "heroes")
    assert out["selected"] is None and out["stage"] == 1
    assert [h["code"] for h in out["items"]][:3] == ["robot_0", "robot_1", "robot_2"]
    hero = out["items"][0]
    assert hero["name"] == {"ru": "Робот Вольт", "uz": "Robot Volt"}
    assert [s["skills_required"] for s in hero["stages"]] == [0, 5, 15]
    assert [s["name"]["ru"] for s in hero["stages"]] == ["Сборка", "Запуск", "Полёт"]
    img = hero["stages"][0]["image"]
    assert img["url"] == f"/v1/game/assets/{img['asset_id']}/{img['sha256']}" and img["height"] == 460
    assert (await env.get(user, "summary"))["hero"] is None
    await env.lesson(user, passed=True)
    before = await env.wallet(user)
    s = await env.send("PUT", user, "hero", {"hero_code": "pet_1"})
    assert s["hero"]["code"] == "pet_1" and s["hero"]["stage"] == 1 and s["hero"]["next_stage_at"] == 5
    assert s["hero"]["stage_name"]["ru"] == "Яйцо"
    s = await env.send("PUT", user, "hero", {"hero_code": "human_2"})  # смена бесплатна
    assert s["hero"]["code"] == "human_2" and await env.wallet(user) == before
    assert await env.ops(user) == [op for op in await env.ops(user) if op.reason in ("lesson", "quest")]
    await env.send("PUT", user, "hero", {"hero_code": "robot_9"}, 404)
    await env.send("PUT", user, "hero", {"hero_code": "dragon_1"}, 422)


async def test_stage_grows_by_confirmed_skills_and_never_down(env: Env, user: uuid.UUID) -> None:
    await env.send("PUT", user, "hero", {"hero_code": "pet_0"})
    sid = await env.lesson(user)
    await env.demonstrate(user, 4)
    assert (await env.get(user, "summary"))["hero"]["stage"] == 1
    await env.demonstrate(user, 1, start=4)
    s = await env.get(user, "summary")
    # next_stage_at — сколько навыков осталось до следующей ступени (15 − 5)
    assert s["hero"]["stage"] == 2 and s["hero"]["confirmed_skills"] == 5 and s["hero"]["next_stage_at"] == 10
    assert s["hero"]["stage_name"]["ru"] == "Малыш"
    [ev] = await env.events("game.hero.stage_reached.v1", user)
    assert ev.payload["stage"] == 2 and ev.payload["hero_code"] == "pet_0" and ev.payload["confirmed_skills"] == 5
    # рост ступени — в наградах занятия (навыки пришли сразу после урока)
    r = await env.get(user, "rewards", params={"source_session_id": str(sid)})
    assert r["status"] == "ready" and r["hero_stage_up"] == {"from": 1, "to": 2}
    # навык вернулся в learning — ступень не отнимается; повторное подтверждение — без второй награды
    await env.skills(user, [("en.skill.0", "demonstrated", "learning")], source="retention")
    s = await env.get(user, "summary")
    assert s["hero"]["stage"] == 2 and s["hero"]["confirmed_skills"] == 4 and s["hero"]["next_stage_at"] == 11
    skill_ops = len([op for op in await env.ops(user) if op.reason == "skill_demonstrated"])
    await env.skills(user, [("en.skill.0", "learning", "demonstrated")])
    assert len([op for op in await env.ops(user) if op.reason == "skill_demonstrated"]) == skill_ops
    assert (await env.get(user, "summary"))["hero"]["confirmed_skills"] == 5
    assert len(await env.events("game.hero.stage_reached.v1", user)) == 1
    await env.demonstrate(user, 10, start=5)
    s = await env.get(user, "summary")
    assert s["hero"]["stage"] == 3 and s["hero"]["next_stage_at"] is None
    assert s["hero"]["image"]["asset_id"] != (await env.get(user, "heroes"))["items"][0]["stages"][0]["image"][
        "asset_id"]
    # смена героя ступень сохраняет
    s = await env.send("PUT", user, "hero", {"hero_code": "robot_1"})
    assert s["hero"]["stage"] == 3 and s["hero"]["stage_name"]["ru"] == "Полёт"


async def test_skill_rewards_rules(env: Env, user: uuid.UUID) -> None:
    await env.send("PATCH", user, "settings", {"quests_hidden": True})
    await env.skills(user, [("en.d1", "not_started", "demonstrated")], source="diagnostic")  # диагностика — без XP
    await env.skills(user, [("en.l1", "learning", "demonstrated"), ("en.l1", "demonstrated", "retained")])
    ops = await env.ops(user)
    assert sorted((op.reason, op.currency, op.amount) for op in ops) == [
        ("skill_demonstrated", "til", 5), ("skill_demonstrated", "xp", 15),
        ("skill_retained", "til", 10), ("skill_retained", "xp", 25)]
    assert {op.idempotency_key.rsplit(":", 1)[0] for op in ops} == {
        f"skill:{user}:en.l1:demonstrated", f"skill:{user}:en.l1:retained"}
    # отметка диагностики в ступень не идёт: считается только навык, подтверждённый в учёбе
    [(confirmed,)] = await env.sql("SELECT confirmed_skills FROM learners WHERE user_id = :u", u=user)
    assert confirmed == 1
    # не больше skill_max_per_event навыков за событие
    await env.skills(user, [(f"en.m{i}", "learning", "demonstrated") for i in range(14)])
    assert len([op for op in await env.ops(user) if op.reason == "skill_demonstrated" and op.currency == "xp"]) == 11
    # запоздавшее событие не откатывает более новое состояние
    from datetime import timedelta

    await env.skills(user, [("en.l1", "retained", "learning")], occurred_at=env.now - timedelta(hours=1))
    [(state,)] = await env.sql("SELECT state FROM skill_states WHERE user_id = :u AND skill_id = 'en.l1'", u=user)
    assert state == "retained"


async def test_diagnostic_marks_do_not_grow_stage(env: Env, user: uuid.UUID) -> None:
    """Решение владельца: после диагностики с 10 demonstrated — ступень 1; урок или проверка удержания подтверждает
    навык — счёт растёт; confirmed_skills в API и событиях — это же число."""
    await env.send("PUT", user, "hero", {"hero_code": "robot_0"})
    await env.skills(user, [(f"en.d{i}", "not_started", "demonstrated") for i in range(10)], source="diagnostic")
    s = await env.get(user, "summary")
    assert (s["hero"]["stage"], s["hero"]["confirmed_skills"], s["hero"]["next_stage_at"]) == (1, 0, 5)
    assert await env.events("game.hero.stage_reached.v1", user) == []
    assert [op for op in await env.ops(user) if op.reason.startswith("skill_")] == []
    # урок подтверждает навык, отмеченный диагностикой; проверка удержания переводит в retained
    await env.skills(user, [("en.d0", "demonstrated", "demonstrated")])
    await env.skills(user, [("en.d1", "demonstrated", "retained")], source="retention")
    s = await env.get(user, "summary")
    assert (s["hero"]["confirmed_skills"], s["hero"]["next_stage_at"]) == (2, 3)
    # повторная отметка диагностики подтверждения не снимает; возврат в learning — снимает
    await env.skills(user, [("en.d0", "demonstrated", "demonstrated")], source="diagnostic")
    await env.skills(user, [("en.d1", "retained", "learning")], source="retention")
    assert (await env.get(user, "summary"))["hero"]["confirmed_skills"] == 1
    await env.skills(user, [("en.d1", "learning", "demonstrated")], source="diagnostic")
    assert (await env.get(user, "summary"))["hero"]["confirmed_skills"] == 1
    for i in range(2, 6):
        await env.skills(user, [(f"en.d{i}", "demonstrated", "demonstrated")])
    s = await env.get(user, "summary")
    assert (s["hero"]["stage"], s["hero"]["confirmed_skills"], s["hero"]["next_stage_at"]) == (2, 5, 10)
    [ev] = await env.events("game.hero.stage_reached.v1", user)
    assert ev.payload["confirmed_skills"] == 5 and ev.payload["stage"] == 2


async def test_kids_pets_first_and_hidden_hero(env: Env, user: uuid.UUID) -> None:
    kid, parent = uuid.uuid4(), uuid.uuid4()
    out = await env.get(kid, "heroes", age_band="6-9", account=parent)
    assert [h["line"] for h in out["items"]][:3] == ["pet", "pet", "pet"]
    # скрыть героя из выбора: audiences = [] — у выбравших остаётся
    await env.send("PUT", user, "hero", {"hero_code": "robot_2"})
    hero = next(h for h in (await env.adm("GET", "heroes"))["items"] if h["code"] == "robot_2")
    assert hero["learners"] == 1
    draft = {"name": hero["name"], "tagline": hero["tagline"], "audiences": [], "stages": hero["stages"]}
    await env.adm("PUT", "heroes/robot_2/draft", draft)
    await env.adm("POST", "heroes/robot_2/publish", {"comment": "скрыть"})
    other = uuid.uuid4()
    assert "robot_2" not in [h["code"] for h in (await env.get(other, "heroes"))["items"]]
    await env.send("PUT", other, "hero", {"hero_code": "robot_2"}, 409)
    assert (await env.get(user, "summary"))["hero"]["code"] == "robot_2"
    assert "robot_2" in [h["code"] for h in (await env.get(user, "heroes"))["items"]]
