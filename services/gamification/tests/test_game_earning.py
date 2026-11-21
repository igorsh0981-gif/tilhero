"""Начисления по событиям (§1.2, AT-63/64): урок, сценарий, медиа, чтение, повторение; повтор события без дубля
(inbox и ключ операции); дневной лимит урезает и ставит capped; множитель события недели; версия правил в операции;
активация и откат не меняют проведённые операции; уровни; проверка издателя; порядок событий."""

from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal
from typing import Any

from conftest import Env

from tilhero_gamification.domain import earning


def by_reason(ops: list[Any], reason: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for op in ops:
        if op.reason == reason:
            out[op.currency] = out.get(op.currency, 0) + int(op.amount)
    return out


async def hide_quests(env: Env, user: uuid.UUID) -> None:
    await env.send("PATCH", user, "settings", {"quests_hidden": True})


async def test_lesson_kinds_amounts_and_rules_version(env: Env, user: uuid.UUID) -> None:
    await hide_quests(env, user)
    sid = await env.lesson(user, passed=True)
    await env.lesson(user, practice_only=True)
    for kind in ("scenario", "media", "reading", "review"):
        await env.lesson(user, kind)
    await env.lesson(user, status="cancelled")
    ops = await env.ops(user)
    assert by_reason(ops, "lesson") == {"xp": 30 + 10, "til": 5 + 2}  # урок с passed + практика
    assert by_reason(ops, "scenario") == {"xp": 15, "til": 4}
    assert by_reason(ops, "media") == {"xp": 10, "til": 3}
    assert by_reason(ops, "reading") == {"xp": 10, "til": 3}
    assert {op.reason for op in ops} == {"lesson", "scenario", "media", "reading"}  # review и cancelled — без наград
    assert all(op.rules_version == 2 and op.multiplier == Decimal("1") and not op.capped for op in ops)
    w = await env.wallet(user)
    assert w["xp"] == 75 and w["til"] == 17
    rows = await env.sql("SELECT source_session_id FROM ledger WHERE user_id = :u AND reason = 'lesson' "
                         "AND amount = 30", u=user)
    assert rows[0][0] == sid
    # учёба не меняется: gamification ничего не публикует для учебных доменов
    published = {e.event_type for e in env.bus.published if e.producer == "gamification"}
    assert published <= {"game.level.reached.v1", "game.badge.earned.v1", "admin.audit.recorded.v1"}


async def test_review_rules(env: Env, user: uuid.UUID) -> None:
    await hide_quests(env, user)
    await env.review(user, reviewed=10, correct=8)
    await env.review(user, reviewed=4, correct=4)  # меньше min_cards — без наград
    await env.review(user, reviewed=40, correct=35)  # correct сверх cap — не больше 20
    await env.review(user, reviewed=10, correct=10, status="expired")
    ops = await env.ops(user)
    assert [(op.currency, op.amount) for op in ops if op.reason == "review"] == [
        ("xp", 18), ("til", 3), ("xp", 30), ("til", 3)]
    [(cards,)] = await env.sql("SELECT reviews_cards FROM learners WHERE user_id = :u", u=user)
    assert cards == 64  # и карточки истёкшей сессии


async def test_repeat_event_no_duplicate(env: Env, user: uuid.UUID) -> None:
    await hide_quests(env, user)
    from tilhero_common.messaging import make_envelope

    ev = make_envelope("lesson.session.completed.v1", {
        "session_id": str(uuid.uuid4()), "user_id": str(user), "kind": "lesson", "pair_id": "ru-en",
        "status": "completed", "minutes": 10, "practice_only": False, "passed": False,
        "finished_at": env.ts()}, producer="lessons")
    await env.publish(ev.event_type, {}, "lessons", env=ev)
    before = await env.ops(user)
    # повторная доставка: inbox отсекает
    [spec] = [s for s in env.bus.specs if s.durable == "gamification.lessons"]
    await spec.handler(ev)
    # и даже в обход inbox — ключ операции lesson:<event_id>:<валюта> не даёт дубля
    async with env.runtime.transaction() as db:
        await earning.on_lesson(db, env.settings, env.now, dict(ev.payload), ev.event_id)
    assert await env.ops(user) == before
    assert (await env.wallet(user))["xp"] == 20
    assert {op.idempotency_key for op in before} == {f"lesson:{ev.event_id}:xp", f"lesson:{ev.event_id}:til"}


async def test_daily_cap_trims_and_marks_capped(env: Env, user: uuid.UUID) -> None:
    def small_caps(p: dict[str, Any]) -> None:
        p["caps"] = {"xp_per_day": 50, "til_per_day": 12}

    version = await env.activate(small_caps)
    await hide_quests(env, user)
    await env.lesson(user, passed=True)  # 30 xp, 5 til
    await env.lesson(user, passed=True)  # остаток 20 xp (capped), 5 til
    await env.lesson(user, passed=True)  # xp 0 — без операции; til 2 из 5 (capped)
    await env.lesson(user, passed=True)  # ничего
    ops = [op for op in await env.ops(user) if op.reason == "lesson"]
    assert [(op.currency, op.amount, op.capped) for op in ops] == [
        ("xp", 30, False), ("til", 5, False), ("xp", 20, True), ("til", 5, False), ("til", 2, True)]
    assert all(op.rules_version == version for op in ops)
    # ручные операции лимитом не ограничены
    await env.grant(user, "xp", 500)
    assert (await env.wallet(user))["xp"] == 550
    # новый местный день — лимит заново
    env.now += timedelta(days=1)
    await env.lesson(user, passed=True)
    assert by_reason([op for op in await env.ops(user) if op.reason == "lesson"], "lesson")["xp"] == 80


async def test_week_event_multiplier(env: Env, user: uuid.UUID) -> None:
    await hide_quests(env, user)
    await env.week_event([{"action": "lesson", "currency": "xp", "factor": 2},
                          {"action": "lesson", "currency": "til", "factor": 1.5}])
    await env.week_event([{"action": "reading", "currency": "xp", "factor": 3}], audiences=("kids",))
    await env.lesson(user, passed=False)  # 20 xp ×2, 5 til ×1.5 → 7 (вниз)
    await env.lesson(user, "reading")  # событие детей — взрослому без множителя
    ops = await env.ops(user)
    assert [(op.reason, op.currency, op.amount, op.multiplier) for op in ops] == [
        ("lesson", "xp", 40, Decimal("2.00")), ("lesson", "til", 7, Decimal("1.50")),
        ("reading", "xp", 10, Decimal("1.00")), ("reading", "til", 3, Decimal("1.00"))]
    summary = await env.get(user, "summary")
    assert [m["factor"] for e in summary["events"] for m in e["multipliers"]] == [2, 1.5]
    # множитель не применяется к бонусам и заморозкам
    await env.profile(user)
    assert [op.amount for op in await env.ops(user, bonus=True) if op.reason == "registration_bonus"] == [2]


async def test_activation_and_rollback_keep_posted_operations(env: Env, user: uuid.UUID) -> None:
    await hide_quests(env, user)
    await env.lesson(user)

    def richer(p: dict[str, Any]) -> None:
        p["earn"]["lesson"] = {"xp": 40, "til": 6}

    v2 = await env.activate(richer)
    await env.lesson(user)
    # откат на версию 1 (до спринта 7): разделы league / duel / pair_lesson берутся из активной версии
    rollback = await env.adm("POST", "rules/1/rollback", {"comment": "откат на первую версию"})
    v3 = rollback["version"]
    assert rollback["based_on"] == 1 and rollback["status"] == "active" and rollback["diff"] == []
    assert rollback["payload"]["duel"] == {"win": 30, "draw": 15, "participation": 10, "daily_cap": 3}
    await env.lesson(user)
    ops = [(op.currency, op.amount, op.rules_version) for op in await env.ops(user) if op.reason == "lesson"]
    assert ops == [("xp", 20, 2), ("til", 5, 2), ("xp", 40, v2), ("til", 6, v2), ("xp", 20, v3), ("til", 5, v3)]
    statuses = {v["version"]: v["status"] for v in (await env.adm("GET", "rules"))["items"]}
    assert statuses == {1: "archived", 2: "archived", v2: "archived", v3: "active"}
    [ev2, ev3] = await env.events("game.rules.activated.v1")
    assert ev2.payload["version"] == v2 and ev3.payload == {**ev3.payload, "version": v3, "based_on": 1}


async def test_levels_up_and_never_down(env: Env, user: uuid.UUID) -> None:
    await hide_quests(env, user)
    for _ in range(4):  # 4 × 30 = 120 XP → уровень 2
        await env.lesson(user, passed=True)
    w = await env.wallet(user)
    assert w["xp"] == 120 and w["level"] == 2
    [ev] = await env.events("game.level.reached.v1", user)
    assert ev.payload["level"] == 2 and ev.payload["xp_total"] == 120
    summary = await env.get(user, "summary")
    assert (summary["level"], summary["xp_level_start"], summary["xp_next_level"]) == (2, 100, 250)
    # обратная запись XP уровень не трогает
    [op] = [o for o in await env.ops(user) if o.currency == "xp"][:1]
    await env.adm("POST", f"wallets/{user}/ledger/{op.op_id}/reverse", {"reason": "ошибочное начисление"})
    await env.adm("POST", f"wallets/{user}/ledger/{[o for o in await env.ops(user) if o.currency == 'xp'][1].op_id}"
                  "/reverse", {"reason": "ошибочное начисление"})
    w = await env.wallet(user)
    assert w["xp"] == 60 and w["level"] == 2
    # уровень игры не меняет учёбу: событий для учебных доменов нет
    assert not [e for e in env.bus.published if e.producer == "gamification" and e.event_type.startswith(
        ("learning.", "skills.", "lesson.", "memory.", "assessment."))]


async def _pg_without_legacy_zones(env, monkeypatch) -> None:
    """Сборки PostgreSQL отличаются tzdata (в CI postgres:16-alpine знает America/Godthab, на стенде — нет):
    «неизвестные PostgreSQL» пояса задаём явно — кеш поясов процесса без них."""
    from tilhero_gamification.domain import engine as engine_mod
    names = {n for (n,) in await env.sql("SELECT name FROM pg_timezone_names")}
    monkeypatch.setattr(engine_mod, "_PG_ZONES", frozenset(names - {"America/Godthab", "Asia/Rangoon"}))


async def test_plan_timezone_sets_learner_day(env: Env, user: uuid.UUID, monkeypatch) -> None:
    await _pg_without_legacy_zones(env, monkeypatch)
    await env.plan(user, tz="Pacific/Honolulu")  # T0 05:00 UTC → 19:00 предыдущего дня
    q = await env.get(user, "quests")
    assert q["local_date"] == (env.today - timedelta(days=1)).isoformat()
    await env.lesson(user)
    days = await env.sql("SELECT DISTINCT local_date FROM ledger WHERE user_id = :u AND reason <> "
                         "'registration_bonus'", u=user)
    assert [d.isoformat() for (d,) in days] == [q["local_date"]]
    # пояс, неизвестный Python или PostgreSQL, — пояс по умолчанию (Asia/Tashkent)
    for tz in ("Mars/Base", "America/Godthab"):
        await env.publish("learning.plan.updated.v1", {"user_id": str(user), "changed_fields": ["timezone"],
                                                       "timezone": tz}, "learning-plan")
        assert await env.sql("SELECT timezone FROM learners WHERE user_id = :u", u=user) == [(None,)]
        assert (await env.get(user, "quests"))["local_date"] == env.today.isoformat()


async def test_foreign_producer_ignored_and_order_independent(env: Env, user: uuid.UUID) -> None:
    await env.publish("lesson.session.completed.v1", {
        "session_id": str(uuid.uuid4()), "user_id": str(user), "kind": "lesson", "pair_id": "ru-en",
        "status": "completed", "minutes": 10, "practice_only": False, "finished_at": env.ts()}, "social")
    await env.publish("user.profile.created.v1", {"user_id": str(user), "kind": "account", "age_band": "18+",
                                                  "created_at": env.ts()}, "lessons")
    assert await env.ops(user) == []
    # урок раньше регистрации: ученик создаётся по умолчанию (adults), бонус приходит своим событием, один раз
    await env.lesson(user)
    [(audience_band, kind)] = await env.sql("SELECT age_band, kind FROM learners WHERE user_id = :u", u=user)
    assert (audience_band, kind) == (None, "account")
    await env.profile(user, age_band="14-17")
    await env.profile(user, age_band="14-17")  # повтор регистрации другим событием — без второго бонуса
    assert [op.amount for op in await env.ops(user, bonus=True) if op.reason == "registration_bonus"] == [2]
    [(band,)] = await env.sql("SELECT age_band FROM learners WHERE user_id = :u", u=user)
    assert band == "14-17"
