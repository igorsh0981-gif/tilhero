"""Задания дня (§1.5, AT-68) и значки (§1.6, AT-70)."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any

from conftest import Env

from tilhero_gamification.domain.quests import choose

TEMPLATES = [
    {"code": "a_1", "kind": "lesson_complete", "weight": 3}, {"code": "b_1", "kind": "review_cards", "weight": 3},
    {"code": "c_1", "kind": "reading_complete", "weight": 2}, {"code": "d_1", "kind": "xp_earned", "weight": 2},
    {"code": "e_1", "kind": "skill_confirmed", "weight": 1}]


def test_choose_is_deterministic_without_repeats() -> None:
    day = date(2026, 11, 20)
    first = choose("u1", day, 1, TEMPLATES, 3)
    assert first == choose("u1", day, 1, list(reversed(TEMPLATES)), 3)
    assert len({t["code"] for t in first}) == 3
    assert choose("u1", day, 1, TEMPLATES, 10) and len(choose("u1", day, 1, TEMPLATES, 10)) == 5
    # разные дни и ученики — разные наборы (на выборке), веса влияют на частоту
    seen = [tuple(t["code"] for t in choose(f"u{i}", day, 1, TEMPLATES, 1)) for i in range(400)]
    counts = {c: sum(1 for s in seen if s == (c,)) for c in ("a_1", "e_1")}
    assert counts["a_1"] > counts["e_1"] * 1.5


async def play(env: Env, user: uuid.UUID, quest: dict[str, Any], **hk: Any) -> None:
    """Выполнить задание событиями учёбы."""
    kind = quest["kind"]
    if kind == "lesson_complete":
        await env.lesson(user)
    elif kind == "review_cards":
        await env.review(user, reviewed=quest["target"], correct=1)
    elif kind in ("reading_complete", "scenario_complete", "media_complete"):
        await env.lesson(user, kind.split("_")[0])
    elif kind == "xp_earned":
        for _ in range(3):
            await env.lesson(user, passed=True)
    elif kind == "skill_confirmed":
        await env.skills(user, [(f"en.q.{uuid.uuid4().hex[:6]}", "learning", "demonstrated")])


async def test_quests_progress_rewards_and_bonus(env: Env, user: uuid.UUID) -> None:
    q = await env.get(user, "quests")
    assert q["local_date"] == env.today.isoformat() and not q["hidden"] and len(q["items"]) == 3
    assert [i["slot"] for i in q["items"]] == [1, 2, 3] and q["all_done_bonus"] == {"xp": 10, "til": 10}
    assert q == await env.get(user, "quests")  # повторный запрос — те же задания
    rows = await env.sql("SELECT count(*) FROM quests WHERE user_id = :u", u=user)
    assert rows[0][0] == 3
    for quest in q["items"]:
        await play(env, user, quest)
    q = await env.get(user, "quests")
    assert all(i["status"] == "completed" and i["progress"] == i["target"] for i in q["items"]), q
    assert q["bonus_received"] is True
    ops = await env.ops(user)
    quest_ops = [op for op in ops if op.reason == "quest"]
    expected = sum(i["reward"]["xp"] for i in q["items"])
    assert sum(op.amount for op in quest_ops if op.currency == "xp") == expected
    assert sorted((op.currency, op.amount) for op in ops if op.reason == "quest_bonus") == [("til", 10), ("xp", 10)]
    assert all(op.rules_version == 2 for op in quest_ops)
    # повторные события после выполнения — без второй награды за задания
    for quest in q["items"]:
        await play(env, user, quest)
    assert len([op for op in await env.ops(user) if op.reason in ("quest", "quest_bonus")]) == len(quest_ops) + 2


async def test_quests_audience_hidden_and_expiry(env: Env, user: uuid.UUID) -> None:
    kid = uuid.uuid4()
    q = await env.get(kid, "quests", age_band="6-9")
    assert {i["code"] for i in q["items"]} <= {"lesson_1", "review_10", "reading_1", "skill_1"}
    # скрыть: не выпускаются и не продвигаются, наказаний нет
    await env.send("PATCH", user, "settings", {"quests_hidden": True})
    q = await env.get(user, "quests")
    assert q["hidden"] is True and q["items"] == []
    await env.lesson(user)
    assert (await env.sql("SELECT count(*) FROM quests WHERE user_id = :u", u=user))[0][0] == 0
    # невыполненные сгорают после полуночи ученика (tick), без операций
    await env.get(kid, "summary", age_band="6-9")
    env.now += timedelta(days=1)
    out = await env.tick()
    assert out["quests_expired"] == 3
    statuses = await env.sql("SELECT status FROM quests WHERE user_id = :u", u=kid)
    assert {s for (s,) in statuses} == {"expired"}
    assert [op for op in await env.ops(kid) if op.reason.startswith("quest")] == []
    assert (await env.tick())["quests_expired"] == 0  # повтор безопасен
    q = await env.get(kid, "quests", age_band="6-9")  # новый день — новые задания
    assert q["local_date"] == env.today.isoformat() and all(i["status"] == "active" for i in q["items"])


async def test_quest_multiplier_and_version_of_day(env: Env, user: uuid.UUID) -> None:
    q = await env.get(user, "quests")
    await env.week_event([{"action": "quest", "currency": "xp", "factor": 2}])

    def new_quests(p: dict[str, Any]) -> None:
        for t in p["quests"]["templates"]:
            t["reward"] = {"xp": 12, "til": 6}

    v2 = await env.activate(new_quests)
    quest = q["items"][0]
    await play(env, user, quest)
    [xp_op] = [op for op in await env.ops(user) if op.reason == "quest" and op.currency == "xp"
               and op.idempotency_key.endswith(":1:xp")] or [None]
    if quest["reward"]["xp"]:
        assert xp_op is not None and xp_op.amount == quest["reward"]["xp"] * 2 and xp_op.rules_version == 2
    # задания дня доигрываются по своей версии; следующий день — по новой
    env.now += timedelta(days=1)
    q2 = await env.get(user, "quests")
    assert all(i["reward"] == {"xp": 12, "til": 6} for i in q2["items"])
    rows = await env.sql("SELECT DISTINCT rules_version FROM quests WHERE user_id = :u AND local_date = :d",
                         u=user, d=env.today)
    assert rows == [(v2,)]


# ---------------------------------------------------------------- значки


async def test_badges_earned_once_with_basis(env: Env, user: uuid.UUID) -> None:
    def small(p: dict[str, Any]) -> None:
        p["badges"] = {"streak": [3, 7], "skills": [2], "reviews_cards": [20], "readings": [2]}

    await env.activate(small)
    await env.send("PATCH", user, "settings", {"game_notifications": False})
    await env.lesson(user)
    await env.lesson(user, "reading")
    await env.lesson(user, "reading")
    await env.activity(user, 3)
    await env.activity(user, 2)  # серия меньше лучшей — без изменений
    await env.review(user, reviewed=20, correct=10)
    await env.skills(user, [("en.a", "learning", "demonstrated"), ("en.b", "not_started", "demonstrated")])
    await env.skills(user, [("en.a", "demonstrated", "retained")], source="retention")
    await env.profile(user)
    await env.missed(user)
    earned = {e.payload["badge_code"]: e for e in await env.events("game.badge.earned.v1", user)}
    assert set(earned) == {"first_lesson", "readings_2", "streak_3", "reviews_20", "skills_2", "skill_retained",
                           "first_freeze"}
    assert all(e.payload["notify"] is False for e in earned.values())
    rows = dict(await env.sql("SELECT badge_code, event_id FROM badges WHERE user_id = :u", u=user))
    assert rows["first_lesson"] and len(rows) == 7
    # повтор метрик — без второй выдачи
    await env.activity(user, 4)
    await env.lesson(user)
    assert len(await env.events("game.badge.earned.v1", user)) == 7
    view = (await env.get(user, "badges"))["items"]
    got = {b["code"]: b for b in view}
    assert [b["earned_at"] is not None for b in view][:7] == [True] * 7  # выданные первыми
    assert got["streak_3"]["basis"] == {"metric": "streak", "value": 3, "threshold": 3}
    assert got["streak_7"]["earned_at"] is None and got["streak_7"]["basis"] == {
        "metric": "streak", "value": 4, "threshold": 7}
    assert got["streak_3"]["title"] == {"ru": "Серия 3 дня", "uz": "3 kunlik seriya"}
    assert got["skills_2"]["title"]["ru"] == "2 навыка"
    assert got["reviews_20"]["title"]["ru"] == "20 карточек повторено"


async def test_badge_from_previous_rules_stays(env: Env, user: uuid.UUID) -> None:
    await env.activity(user, 7)

    def other(p: dict[str, Any]) -> None:
        p["badges"]["streak"] = [10]

    await env.activate(other)
    codes = [b["code"] for b in (await env.get(user, "badges"))["items"]]
    assert codes[0] == "streak_7" and "streak_10" in codes
    assert date.fromisoformat(env.today.isoformat())
