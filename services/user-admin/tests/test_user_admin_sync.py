"""Сверка с identity-consent и learning-plan: курсор и водяной знак, новые ученики появляются, сбой источника не
роняет сервис, события новее снимка не затираются; POST /internal/v1/reconcile (n8n, SCHEDULER_TOKEN)."""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta

import asyncpg
import pytest
from sqlalchemy import select
from user_admin_testkit import ID, LP, MASK, SCHEDULER_TOKEN, fake_identity, fake_plans, iso, now, plan, snapshot

from tilhero_common.http_client import UpstreamError
from tilhero_common.testing import TEST_ADMIN_URL, internal_headers
from tilhero_user_admin.domain.sync import RECONCILE_LOCK_CLASS, lock_object
from tilhero_user_admin.models import LearnerSummary, ReconcileState

SCHED = {"authorization": f"Bearer {SCHEDULER_TOKEN}"}


async def summary(env, uid) -> LearnerSummary | None:
    async with env.runtime.transaction() as s:
        return await s.get(LearnerSummary, uuid.UUID(str(uid)))


async def state(env, name: str = "identity") -> ReconcileState | None:
    async with env.runtime.transaction() as s:
        return await s.get(ReconcileState, name)


def parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


async def test_identity_sync_pages_and_keeps_watermark(make_env) -> None:
    identity = fake_identity()
    base = now() - timedelta(hours=1)
    snaps = [identity.put(snapshot(n=n, updated_at=base + timedelta(seconds=n))) for n in range(5)]
    env = await make_env(identity, reconcile_page_size=2)
    assert await env.reconciler.identity.run_once() == 5
    list_calls = [c for c in identity.calls if c.url.path == "/admin/v1/users"]
    assert len(list_calls) == 3 and "updated_after" not in list_calls[0].url.params  # первый прогон — полный
    assert list_calls[1].url.params["cursor"] and list_calls[0].url.params["limit"] == "2"
    for n, snap in enumerate(snaps):
        r = await summary(env, snap["user_id"])
        assert r.username == f"tester_{n}" and r.display_name == f"Тестовый Ученик {n}"
        assert r.search_text == f"тестовый ученик {n}"  # username — не в поиске по подстроке (T2-3)
        assert r.telegram_id_masked == MASK * 6 + f"{n:03d}" and r.refreshed_at and r.profile_known
        assert r.consent["policy_version"] == "1.0" and r.notifications["enabled"] is True
    st = await state(env)
    assert st.watermark == parse(snaps[-1]["updated_at"]) and st.last_success_at
    assert st.synced_total == 5 and st.last_error is None

    # новый ученик появляется на следующем прогоне; окно — от водяного знака с перекрытием
    identity.calls.clear()
    fresh = identity.put(snapshot(n=7, updated_at=now()))
    await env.reconciler.identity.run_once()
    call = identity.calls[0]
    after = datetime.fromisoformat(call.url.params["updated_after"])
    assert after == st.watermark - timedelta(seconds=env.settings.reconcile_overlap_seconds)
    assert call.url.params["limit"] == "2"
    assert (await summary(env, fresh["user_id"])).username == "tester_7"


async def test_plans_sync_pages_and_applies_by_version(make_env) -> None:
    plans = fake_plans()
    users = [str(uuid.uuid4()) for _ in range(3)]
    base = now() - timedelta(hours=1)
    for n, uid in enumerate(users):
        plans.put(plan(uid, updated_at=base + timedelta(seconds=n), goal="work" if n else "exam",
                       onboarding_completed_at=None if n == 2 else iso(base)))
    env = await make_env(plans=plans, reconcile_page_size=2)
    assert await env.reconciler.plans.run_once() == 3
    calls = [c for c in plans.calls if c.url.path == "/admin/v1/plans"]
    assert len(calls) == 2 and calls[0].url.params["limit"] == "2"
    r0, r2 = await summary(env, users[0]), await summary(env, users[2])
    assert r0.goal == "exam" and r0.onboarding_completed and r0.reminders_enabled
    assert r0.plan["schedule"]["preset"] == "weekdays" and r0.plan["level_self"] == "beginner"
    assert not r2.onboarding_completed and not r0.profile_known  # профиль — от identity-consent
    st = await state(env, "plans")
    assert st.watermark == base + timedelta(seconds=2) and st.synced_total == 3

    # событие новее снимка не затирается; снимок новее события — побеждает
    t = now()
    await env.emit("learning.plan.updated.v1", {"user_id": users[0], "changed_fields": ["goal"], "goal": "daily",
                                                "ui_lang": "ru", "days": [1, 2, 3, 4, 5], "preferred_time": "19:00",
                                                "duration_min": 20, "reminders_enabled": False,
                                                "timezone": "Asia/Tashkent", "onboarding_completed": True},
                   producer=LP, occurred_at=t)
    plans.put(plan(users[0], updated_at=t - timedelta(seconds=5), goal="exam"))
    await env.reconciler.plans.run_once()
    r0 = await summary(env, users[0])
    assert r0.goal == "daily" and not r0.reminders_enabled and r0.plan["level_self"] == "beginner"
    plans.put(plan(users[0], updated_at=t + timedelta(seconds=5), goal="career", level_self="confident"))
    await env.reconciler.plans.run_once()
    r0 = await summary(env, users[0])
    assert r0.goal == "career" and r0.plan["level_self"] == "confident"


async def test_sync_does_not_overwrite_newer_events(env) -> None:
    uid = str(uuid.uuid4())
    t = now()
    await env.emit("user.status.changed.v1", {"user_id": uid, "status": "DISABLED", "previous_status": "ACTIVE"},
                   producer=ID, occurred_at=t)
    await env.emit("user.security.changed.v1", {"user_id": uid, "change": "pin_set"}, producer=ID, occurred_at=t)
    await env.emit("user.profile.updated.v1", {"user_id": uid, "changed_fields": ["age_band"], "age_band": "14-17",
                                               "guardian_consent": "pending"}, producer=ID, occurred_at=t)
    # снимок старше событий (прочитан до их фиксации)
    env.identity.put(snapshot(uid, n=1, updated_at=t - timedelta(seconds=5)))
    await env.reconciler.identity.run_once()
    r = await summary(env, uid)
    assert r.status == "DISABLED" and r.security["pin_enabled"] and r.username == "tester_1"
    assert (r.age_band, r.guardian_consent) == ("14-17", "pending")
    # снимок новее — побеждает
    env.identity.put(snapshot(uid, n=1, updated_at=t + timedelta(seconds=5), status="ACTIVE",
                              security={"pin_enabled": False, "pin_reset_pending": False}))
    await env.reconciler.identity.run_once()
    r = await summary(env, uid)
    assert r.status == "ACTIVE" and not r.security["pin_enabled"] and r.age_band == "18+"


async def test_sync_learns_deletion_and_erases_pii(env) -> None:
    uid = str(uuid.uuid4())
    env.identity.put(snapshot(uid, n=3, updated_at=now() - timedelta(minutes=1)))
    env.plans.put(plan(uid))
    await env.reconciler.identity.run_once()
    await env.reconciler.plans.run_once()
    assert (await summary(env, uid)).plan is not None
    env.identity.put(snapshot(uid, n=3, updated_at=now(), status="DELETED", username=None, display_name=None,
                              telegram_id_masked=None))
    await env.reconciler.identity.run_once()
    r = await summary(env, uid)
    assert r.status == "DELETED" and r.username is None and r.display_name is None and r.erased_at
    assert r.plan is None and r.search_text is None
    # поздний снимок плана ничего не возвращает
    env.plans.put(plan(uid, updated_at=now() + timedelta(seconds=1)))
    await env.reconciler.plans.run_once()
    assert (await summary(env, uid)).plan is None


async def test_source_failure_keeps_service_alive(make_env) -> None:
    identity, plans = fake_identity(), fake_plans()
    identity.down = plans.down = True
    env = await make_env(identity, plans, reconcile_enabled=True, reconcile_interval_seconds=3600)

    async def failed() -> bool:
        a, b = await state(env), await state(env, "plans")
        return a is not None and a.last_error is not None and b is not None and b.last_error is not None

    await env.wait_for(failed)
    st = await state(env)
    assert st.last_error in ("UpstreamError", "CircuitOpen") and st.last_success_at is None
    assert (await env.client.get("/health/ready")).status_code == 200
    assert (await env.client.get("/health/live")).status_code == 200
    listing = await env.get("/admin/v1/learners")
    assert listing.status_code == 200 and listing.json() == {"items": [], "next_cursor": None}
    # события продолжают обрабатываться
    uid = str(uuid.uuid4())
    await env.emit("user.status.changed.v1", {"user_id": uid, "status": "DISABLED", "previous_status": "ACTIVE"},
                   producer=ID)
    assert (await summary(env, uid)).status == "DISABLED"

    with pytest.raises(UpstreamError):
        await env.reconciler.identity.run_once()
    # источник поднялся: досрочный прогон по новому ученику (user.profile.created.v1 будит сверку)
    identity.down = False
    env.runtime.client(ID).breaker.success()
    fresh = identity.put(snapshot(n=9))

    async def appeared() -> bool:
        r = await summary(env, fresh["user_id"])
        return r is not None and r.username == "tester_9"

    await env.emit("user.profile.created.v1", {"user_id": fresh["user_id"], "kind": "account",
                                               "created_at": iso(now())}, producer=ID)
    await env.wait_for(appeared)

    # learning-plan поднялся: правка уровня в событии будит сверку планов
    plans.down = False
    env.runtime.client(LP).breaker.success()
    plans.put(plan(fresh["user_id"], level_self="confident", updated_at=now() + timedelta(seconds=30)))

    async def level_known() -> bool:
        r = await summary(env, fresh["user_id"])
        return r is not None and r.plan is not None and r.plan.get("level_self") == "confident"

    await env.emit("learning.plan.updated.v1", {"user_id": fresh["user_id"], "changed_fields": ["level_self"],
                                                "goal": "travel", "days": [1], "preferred_time": "10:00",
                                                "duration_min": 10, "reminders_enabled": False,
                                                "timezone": "Asia/Tashkent", "onboarding_completed": False},
                   producer=LP)
    await env.wait_for(level_known)


async def test_startup_reconcile_runs_in_background(make_env) -> None:
    identity, plans = fake_identity(), fake_plans()
    snaps = [identity.put(snapshot(n=n)) for n in range(3)]
    plans.put(plan(snaps[0]["user_id"]))
    env = await make_env(identity, plans, reconcile_enabled=True, reconcile_interval_seconds=3600)

    async def synced() -> bool:
        async with env.runtime.transaction() as s:
            rows = (await s.execute(select(LearnerSummary))).scalars().all()
        return len(rows) == 3 and any(r.plan for r in rows) and all(r.profile_known for r in rows)

    await env.wait_for(synced)
    page = (await env.get("/admin/v1/learners")).json()
    assert {i["user_id"] for i in page["items"]} == {s["user_id"] for s in snaps}


async def test_invalid_snapshot_is_skipped(env) -> None:
    good = env.identity.put(snapshot(n=1))
    for bad_field in ({"status": "HACKED"}, {"kind": "robot"}, {"updated_at": "2026-11-18T10:00:00"},
                      {"age_band": "5-6"}):
        env.identity.put({**snapshot(n=2), **bad_field})
    assert await env.reconciler.identity.run_once() == 1
    assert await summary(env, good["user_id"]) is not None
    env.plans.put(plan(uuid.uuid4(), goal="hack"))
    env.plans.put(plan(uuid.uuid4(), schedule={"preset": "daily", "days": [9], "preferred_time": "10:00",
                                               "duration_min": 10, "reminders_enabled": True, "timezone": "UTC"}))
    ok = env.plans.put(plan(uuid.uuid4()))
    assert await env.reconciler.plans.run_once() == 1
    assert (await summary(env, ok["user_id"])).plan is not None


async def test_concurrent_run_is_skipped_not_queued(env) -> None:
    """Прогон источника уже идёт — второй не ждёт (повтор n8n по таймауту не копит ожидающих) и ничего не делает."""
    for n in range(4):
        env.identity.put(snapshot(n=n))
    results = await asyncio.gather(env.reconciler.identity.run_once(), env.reconciler.identity.run_once())
    assert sorted(results, key=lambda r: r is None) == [4, None]
    assert (await state(env)).synced_total == 4
    # источники независимы: прогон identity не мешает прогону планов
    env.plans.put(plan(uuid.uuid4()))
    results = await asyncio.gather(env.reconciler.identity.run_once(), env.reconciler.plans.run_once())
    assert results == [4, 1]


async def test_run_on_other_replica_is_skipped(env) -> None:
    """Межрепликовая блокировка: advisory-блокировку держит другое соединение (другая реплика) — прогон пропускается
    без ожидания; после её снятия — идёт. Соединение прогона возвращается в пул без блокировки."""
    env.identity.put(snapshot(n=1))
    key = {"c": RECONCILE_LOCK_CLASS, "o": lock_object(env.settings.db_schema, "identity")}
    conn = await asyncpg.connect(TEST_ADMIN_URL)
    try:
        assert await conn.fetchval("SELECT pg_try_advisory_lock($1, $2)", key["c"], key["o"])
        assert await env.reconciler.identity.run_once() is None
        assert await env.reconciler.plans.run_once() == 0  # другой источник — другой ключ
        r = await env.client.post("/internal/v1/reconcile", headers=SCHED)
        assert r.status_code == 200 and r.json()["identity"] == {"ok": True, "applied": 0, "skipped": True,
                                                                 "error": None}
        assert await conn.fetchval("SELECT pg_advisory_unlock($1, $2)", key["c"], key["o"])
        assert await env.reconciler.identity.run_once() == 1
        # блокировка прогона снята: другая «реплика» берёт её сразу
        assert await conn.fetchval("SELECT pg_try_advisory_lock($1, $2)", key["c"], key["o"])
    finally:
        await conn.close()


async def test_lock_released_after_source_failure(env) -> None:
    env.identity.down = True
    with pytest.raises(UpstreamError):
        await env.reconciler.identity.run_once()
    env.identity.down = False
    env.runtime.client(ID).breaker.success()
    env.identity.put(snapshot(n=1))
    assert await env.reconciler.identity.run_once() == 1


async def test_page_is_applied_with_bounded_number_of_statements(make_env) -> None:
    """Пачка вместо N+1 (ревью P2-6): число SQL-вызовов на страницу не растёт с её размером (UPDATE строк —
    executemany одним вызовом на набор изменённых колонок)."""
    from sqlalchemy import event

    async def statements(n: int, **kw) -> int:
        identity = fake_identity()
        for i in range(n):
            identity.put(snapshot(n=i, **kw))
        env = await make_env(identity, reconcile_page_size=500)
        count = 0

        def on_execute(*_args) -> None:
            nonlocal count
            count += 1

        engine = env.runtime.db.engine.sync_engine
        event.listen(engine, "before_cursor_execute", on_execute)
        try:
            assert await env.reconciler.identity.run_once() == n
        finally:
            event.remove(engine, "before_cursor_execute", on_execute)
        return count

    small, large = await statements(5), await statements(150)
    assert large <= small + 2, (small, large)
    # повторная сверка тех же учеников (строки уже есть) — тоже без N+1
    deleted_small = await statements(5, status="DELETED", username=None, display_name=None, telegram_id_masked=None)
    deleted_large = await statements(150, status="DELETED", username=None, display_name=None,
                                     telegram_id_masked=None)
    assert deleted_large <= deleted_small + 2, (deleted_small, deleted_large)


# ---------------------------------------------------------------- POST /internal/v1/reconcile

async def test_reconcile_endpoint_runs_both_sources(env) -> None:
    snap = env.identity.put(snapshot(n=1))
    env.plans.put(plan(snap["user_id"]))
    r = await env.client.post("/internal/v1/reconcile", headers=SCHED)
    assert r.status_code == 200, r.text
    assert r.json() == {"identity": {"ok": True, "applied": 1, "skipped": False, "error": None},
                        "plans": {"ok": True, "applied": 1, "skipped": False, "error": None}}
    row = await summary(env, snap["user_id"])
    assert row.username == "tester_1" and row.goal == "travel"
    # повтор безопасен
    again = await env.client.post("/internal/v1/reconcile", headers=SCHED)
    assert again.status_code == 200 and (await summary(env, snap["user_id"])).goal == "travel"


async def test_reconcile_endpoint_reports_failed_source(env) -> None:
    env.identity.put(snapshot(n=1))
    env.plans.down = True
    r = await env.client.post("/internal/v1/reconcile", headers=SCHED)
    assert r.status_code == 503 and r.json()["code"] == "RECONCILE_FAILED"
    assert r.json()["details"] == {"failed": ["plans"], "applied": {"identity": 1, "plans": 0}}
    assert (await state(env, "plans")).last_error == "UpstreamError"


async def test_reconcile_endpoint_auth(make_env) -> None:
    env = await make_env()
    path = "/internal/v1/reconcile"
    assert (await env.client.post(path)).status_code == 401
    for header in (f"Bearer {'x' * 43}", f"Basic {SCHEDULER_TOKEN}", SCHEDULER_TOKEN, "Bearer "):
        r = await env.client.post(path, headers={"authorization": header})
        assert r.status_code == 401 and r.json()["code"] == "SCHEDULER_TOKEN_INVALID", header
    # внутренний JWT сервиса (в т.ч. admin-bff со staff-контекстом) — не планировщик
    for issuer in ("admin-bff", "identity-consent", "telegram-bff"):
        r = await env.client.post(path, headers=internal_headers(env.settings, issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    assert (await env.client.get(path, headers=SCHED)).status_code == 405
    # пустой SCHEDULER_TOKEN выключает вход
    off = await make_env(scheduler_token="")
    r = await off.client.post(path, headers={"authorization": "Bearer "})
    assert r.status_code == 401
    r = await off.client.post(path, headers=SCHED)
    assert r.status_code == 401 and r.json()["code"] == "SCHEDULER_TOKEN_INVALID"


def test_short_scheduler_token_rejected_in_prod() -> None:
    from pydantic import ValidationError

    from tilhero_user_admin.settings import Settings

    common = {"env": "prod", "internal_jwt_secret": "p" * 40, "internal_jwt_private_key": "k" * 43}
    with pytest.raises(ValidationError):
        Settings(**common, scheduler_token="short")
    assert Settings(**common, scheduler_token="").scheduler_token.get_secret_value() == ""
    assert Settings(**common, scheduler_token=" " + "t" * 40 + " ").scheduler_token.get_secret_value() == "t" * 40
