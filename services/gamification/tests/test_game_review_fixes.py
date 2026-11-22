"""Исправления по независимому ревью спринта 6 (по одному тесту на пункт)."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from conftest import Env
from sqlalchemy import event

from tilhero_gamification.domain import saga
from tilhero_gamification.domain.common import lock_user


async def counts(env: Env, user: uuid.UUID) -> dict[str, int]:
    out = {}
    for t in ("ledger", "wallets", "learners", "quests", "badges", "session_rewards"):
        out[t] = (await env.sql(f"SELECT count(*) FROM {t} WHERE user_id = :u", u=user))[0][0]  # noqa: S608
    return out


async def test_saga_holds_lock_and_parallel_work_does_not_resurrect(env: Env, user: uuid.UUID) -> None:
    """🔴 1: отметка удаления проверяется после блокировки ученика. Сага держит блокировку и удаляет; параллельные
    событие урока, GET /summary (пишущий путь: задания нового дня ещё не выпущены), профиль сообщества (спринт 7)
    и план ждут, а после фиксации саги ничего не создают заново."""
    await env.profile(user)
    await env.lesson(user)
    assert all(v > 0 for k, v in (await counts(env, user)).items() if k not in ("badges",))
    env.now += timedelta(days=1)  # задания нового дня не выпущены — GET /summary идёт пишущим ходом
    tasks: list[asyncio.Task[Any]] = []
    try:
        async with env.runtime.transaction() as db:
            await saga.delete_user_data(db, user, uuid.uuid4(), env.now, None)
            tasks = [asyncio.create_task(env.lesson(user, passed=True)),
                     asyncio.create_task(env.c.get("/internal/v1/game/summary", headers=env.h(user))),
                     asyncio.create_task(env.community(user, "Nick_saga")),
                     asyncio.create_task(env.plan(user, tz="Europe/Moscow"))]
            await asyncio.sleep(0.6)
            assert not any(t.done() for t in tasks), "должны ждать блокировку саги"
    finally:
        results = await asyncio.gather(*tasks, return_exceptions=True)
    assert not [r for r in results if isinstance(r, BaseException)], results
    r = results[1]
    assert r.status_code == 410 and r.json()["code"] == "USER_DELETED"
    assert all(v == 0 for v in (await counts(env, user)).values())
    assert await env.sql("SELECT count(*) FROM community") == [(0,)]
    # чтение без блокировки после фиксации саги — тоже 410, данные не создаются
    r = await env.c.get("/internal/v1/game/shop", headers=env.h(user))
    assert r.status_code == 410 and await env.sql("SELECT count(*) FROM learners WHERE user_id = :u", u=user) == [(0,)]


async def test_manual_freeze_limit_and_large_freeze_left(env: Env, user: uuid.UUID) -> None:
    """🟡 2: ручное начисление заморозок — не больше ±100 за операцию; событие уходит с любым freeze_left."""
    await env.ensure(user)
    body = {"currency": "freeze", "amount": 101, "reason": "перенос заморозок"}
    await env.adm("POST", f"wallets/{user}/adjustments", body, 422, key="k-freeze-101")
    await env.adm("POST", f"wallets/{user}/adjustments", {**body, "amount": 100}, 201, key="k-freeze-100")
    await env.profile(user)  # бонус регистрации не ограничен запасом
    await env.missed(user)
    [ev] = await env.events("game.streak.frozen.v1", user)  # assert_event_conforms внутри
    assert ev.payload["freeze_left"] == 101


async def test_parallel_publish_of_overlapping_events(env: Env) -> None:
    """🟡 3: две одновременные публикации пересекающихся событий — ровно одна успешна."""
    ids = []
    for code in ("week_one", "week_two"):
        starts = env.now + timedelta(hours=1)
        ev = await env.adm("POST", "events", {
            "code": code, "title": {"ru": "Неделя", "uz": "Hafta"}, "description": {"ru": "x2", "uz": "x2"},
            "starts_at": starts.isoformat(), "ends_at": (starts + timedelta(days=3)).isoformat(),
            "audiences": ["adults"], "multipliers": [{"action": "lesson", "currency": "xp", "factor": 2}]},
            201, key=f"k-event-{code}")
        ids.append(ev["event_id"])
    results = await asyncio.gather(*[
        env.c.post(f"/internal/v1/admin/game/events/{i}/publish", json={"comment": None}, headers=env.staff())
        for i in ids])
    assert sorted(r.status_code for r in results) == [200, 409], [r.text for r in results]
    assert [r.json()["code"] for r in results if r.status_code == 409] == ["EVENT_OVERLAP"]
    published = await env.adm("GET", "events?status=published")
    assert len(published["items"]) == 1


def lesson_at(user: uuid.UUID, finished: datetime, kind: str = "lesson") -> Any:
    from tilhero_common.messaging import make_envelope

    return make_envelope("lesson.session.completed.v1", {
        "session_id": str(uuid.uuid4()), "user_id": str(user), "kind": kind, "pair_id": "ru-en",
        "status": "completed", "minutes": 10, "practice_only": False, "passed": False,
        "finished_at": finished.isoformat().replace("+00:00", "Z")}, producer="lessons")


async def test_event_time_decides_day_cap_and_multiplier(env: Env, user: uuid.UUID) -> None:
    """🟢 4: день ученика, дневной лимит, множитель и задания — по времени события, а не по времени обработки."""
    await env.send("PATCH", user, "settings", {"quests_hidden": True})

    def caps(p: dict[str, Any]) -> None:
        p["caps"] = {"xp_per_day": 50, "til_per_day": 20}

    await env.activate(caps)
    ev = await env.week_event([{"action": "lesson", "currency": "xp", "factor": 2}], days=1)
    ends = datetime.fromisoformat(ev["ends_at"].replace("Z", "+00:00"))
    # урок за минуту до конца события, обработан уже после него — множитель есть
    env.now = ends + timedelta(minutes=20)
    a = lesson_at(user, ends - timedelta(minutes=1))
    await env.publish(a.event_type, {}, "lessons", env=a)
    # 23:59 по Ташкенту 21.11, обработан после полуночи — день 21.11: лимит дня урезает (40 + 10 из 20)
    late = datetime(2026, 11, 21, 18, 59, tzinfo=UTC)
    env.now = late + timedelta(minutes=2)
    b = lesson_at(user, late)
    await env.publish(b.event_type, {}, "lessons", env=b)
    await env.lesson(user)  # 22.11 — новый день, лимит заново
    rows = [(op.amount, str(op.multiplier), op.capped) for op in await env.ops(user) if op.currency == "xp"]
    assert rows == [(40, "2.00", False), (10, "1.00", True), (20, "1.00", False)]
    days = [d.isoformat() for (d,) in await env.sql(
        "SELECT local_date FROM ledger WHERE user_id = :u AND currency = 'xp' ORDER BY created_at", u=user)]
    assert days == ["2026-11-21", "2026-11-21", "2026-11-22"]
    # задания на прошедший день по запоздавшему событию не выпускаются
    await env.send("PATCH", user, "settings", {"quests_hidden": False})
    c = lesson_at(user, late - timedelta(hours=1), kind="reading")
    await env.publish(c.event_type, {}, "lessons", env=c)
    assert await env.sql("SELECT count(*) FROM quests WHERE user_id = :u AND local_date = '2026-11-21'",
                         u=user) == [(0,)]


async def test_saga_deletes_wallet_idempotency_keys(env: Env, user: uuid.UUID) -> None:
    """🟢 5: сага удаляет ключи идемпотентности ручных операций над кошельком ученика."""
    await env.grant(user, "til", 10)
    assert await env.sql("SELECT count(*) FROM idempotency WHERE scope = :s", s=f"adjust:{user}") == [(1,)]
    await env.publish("user.deletion.requested.v1", {"user_id": str(user), "request_id": str(uuid.uuid4()),
                                                     "requested_at": env.ts()}, "identity-consent")
    assert await env.sql("SELECT count(*) FROM idempotency WHERE scope = :s", s=f"adjust:{user}") == [(0,)]


async def test_reads_do_not_lock_or_write(env: Env, user: uuid.UUID) -> None:
    """🟢 6: GET без блокировки ученика, FOR UPDATE кошелька и записи learners (если ученик есть и задания
    выпущены); первый GET дня по-прежнему выпускает задания."""
    await env.lesson(user)
    await env.get(user, "summary")
    [(updated,)] = await env.sql("SELECT updated_at FROM learners WHERE user_id = :u", u=user)
    async with env.runtime.transaction() as db:
        await lock_user(db, user)
        await db.execute(__import__("sqlalchemy").text("SELECT 1 FROM wallets WHERE user_id = :u FOR UPDATE"),
                         {"u": user})
        for path in ("summary", "heroes", "quests", "badges", "shop", "history", "settings",
                     f"rewards?source_session_id={uuid.uuid4()}"):
            r = await asyncio.wait_for(env.c.get(f"/internal/v1/game/{path}", headers=env.h(user)), 3)
            assert r.status_code == 200, (path, r.text)
    assert await env.sql("SELECT updated_at FROM learners WHERE user_id = :u", u=user) == [(updated,)]
    # новый день: задания не выпущены → пишущий ход (ждёт блокировку ученика)
    env.now += timedelta(days=1)
    async with env.runtime.transaction() as db:
        await lock_user(db, user)
        task = asyncio.create_task(env.c.get("/internal/v1/game/quests", headers=env.h(user)))
        await asyncio.sleep(0.4)
        assert not task.done()
    q = (await task).json()
    assert q["local_date"] == env.today.isoformat() and len(q["items"]) == 3
    # новый ученик (строки ещё нет) — тоже пишущий ход
    fresh = uuid.uuid4()
    assert (await env.get(fresh, "shop"))["til_balance"] == 0
    assert await env.sql("SELECT count(*) FROM learners WHERE user_id = :u", u=fresh) == [(1,)]


async def test_admin_lists_without_n_plus_one(env: Env, user: uuid.UUID) -> None:
    """🟢 7: списки магазина и героев — фиксированным числом запросов (картинки и владельцы — пачкой)."""
    await env.grant(user, "til", 300)
    for code in ("bg_sunrise", "frame_gold", "streak_freeze"):
        await env.buy(user, code)
    statements: list[str] = []

    def count(conn: Any, cursor: Any, stmt: str, *args: Any) -> None:
        statements.append(stmt)

    engine = env.runtime.db.engine.sync_engine  # type: ignore[union-attr]
    event.listen(engine, "before_cursor_execute", count)
    try:
        items = (await env.adm("GET", "shop/items", perms=("game.read",)))["items"]
        shop_queries = len([s for s in statements if s.lstrip().upper().startswith("SELECT")])
        statements.clear()
        heroes = (await env.adm("GET", "heroes", perms=("game.read",)))["items"]
        hero_queries = len([s for s in statements if s.lstrip().upper().startswith("SELECT")])
    finally:
        event.remove(engine, "before_cursor_execute", count)
    owners = {i["code"]: i["owners"] for i in items}
    assert owners["bg_sunrise"] == 1 and owners["streak_freeze"] == 1 and owners["bg_ink_sky"] == 0
    assert len(items) == 7 and len(heroes) == 9
    assert shop_queries <= 5 and hero_queries <= 4, (shop_queries, hero_queries)
    [(indexdef,)] = await env.sql("SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_ownership_item' "
                                  "AND schemaname = current_schema()")
    assert "item_code" in indexdef


async def test_rollback_blocked_by_draft_and_validates_payload(env: Env) -> None:
    """🟢 8: откат при существующем черновике — 409 RULES_STATE {draft_version}; payload архивной версии снова
    проходит валидатор — ошибки → 422 RULES_INVALID."""
    def richer(p: dict[str, Any]) -> None:
        p["earn"]["lesson"]["xp"] = 25

    await env.activate(richer)
    active = await env.active_rules()
    draft = await env.adm("PUT", "rules/draft", {"payload": active["payload"], "comment": None, "based_on": 2})
    out = await env.adm("POST", "rules/1/rollback", {"comment": "откат на первую версию"}, 409)
    assert out["code"] == "RULES_STATE" and out["details"] == {"draft_version": draft["version"]}
    await env.adm("DELETE", "rules/draft", expect=204)
    # архивная версия, не проходящая нынешний валидатор (вставлена напрямую — INSERT триггером не запрещён)
    broken = {**active["payload"], "levels": [0, 50, 40]}
    await env.sql("INSERT INTO rules_versions (version, status, payload, created_by, created_at, updated_at, "
                  "activated_at) VALUES (50, 'archived', CAST(:p AS jsonb), 'system', now(), now(), now())",
                  p=__import__("json").dumps(broken))
    out = await env.adm("POST", "rules/50/rollback", {"comment": "откат на сломанную версию"}, 422)
    assert out["code"] == "RULES_INVALID" and {"path": "levels", "code": "not_increasing"} in out["details"]["errors"]
    ok = await env.adm("POST", "rules/1/rollback", {"comment": "откат на первую версию"})
    assert ok["status"] == "active" and ok["based_on"] == 1


async def test_manual_repeat_after_key_purge(env: Env, user: uuid.UUID) -> None:
    """🟢 9: повтор ручной операции после очистки ключей идемпотентности — 422 IDEMPOTENCY_KEY_REUSED."""
    await env.ensure(user)
    body = {"currency": "til", "amount": 5, "reason": "компенсация сбоя"}
    staff = str(uuid.uuid4())
    await env.adm("POST", f"wallets/{user}/adjustments", body, 201, key="k-adjust-purge", staff_id=staff)
    env.now += timedelta(days=8)
    assert (await env.tick())["idempotency_purged"] == 1
    out = await env.adm("POST", f"wallets/{user}/adjustments", body, 422, key="k-adjust-purge", staff_id=staff)
    assert out["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert (await env.wallet(user))["til"] == 5

