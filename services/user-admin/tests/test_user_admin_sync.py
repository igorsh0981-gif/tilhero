"""Сверка с identity-consent: курсор и водяной знак, новый пользователь появляется, сбой источника не роняет сервис,
события новее снимка не затираются."""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta

import pytest
from sqlalchemy import select
from user_admin_testkit import MASK, FakeIdentity, now, snapshot

from tilhero_common.http_client import UpstreamError
from tilhero_user_admin.models import SyncState, UserSummary

ID = "identity-consent"


async def summary(env, uid) -> UserSummary | None:
    async with env.runtime.transaction() as s:
        return await s.get(UserSummary, uuid.UUID(str(uid)))


async def state(env) -> SyncState | None:
    async with env.runtime.transaction() as s:
        return await s.get(SyncState, "identity")


async def test_sync_pages_through_identity_and_keeps_watermark(make_env) -> None:
    identity = FakeIdentity()
    base = now() - timedelta(hours=1)
    snaps = [identity.put(snapshot(n=n, updated_at=base + timedelta(seconds=n))) for n in range(5)]
    env = await make_env(identity, sync_page_size=2)
    assert await env.sync.run_once() == 5
    list_calls = [c for c in identity.calls if c.url.path == "/admin/v1/users"]
    assert len(list_calls) == 3 and "updated_after" not in list_calls[0].url.params  # первый прогон — полный
    assert list_calls[1].url.params["cursor"] and list_calls[0].url.params["limit"] == "2"
    for n, snap in enumerate(snaps):
        r = await summary(env, snap["user_id"])
        assert r.username == f"tester_{n}" and r.display_name == f"Тестовый Пользователь {n}"
        assert r.telegram_id_masked == MASK * 6 + f"{n:03d}" and r.refreshed_at and r.profile_known
        assert r.consent_policy_version == "1.0" and r.age_confirmed_18_plus
    st = await state(env)
    assert st.watermark == datetime.fromisoformat(snaps[-1]["updated_at"]) and st.last_success_at
    assert st.synced_total == 5 and st.last_error is None

    # новый пользователь в identity появляется на следующем прогоне; окно — от водяного знака с перекрытием
    identity.calls.clear()
    fresh = identity.put(snapshot(n=7, updated_at=now()))
    await env.sync.run_once()
    call = identity.calls[0]
    after = datetime.fromisoformat(call.url.params["updated_after"])
    assert after == st.watermark - timedelta(seconds=env.settings.sync_overlap_seconds)
    assert (await summary(env, fresh["user_id"])).username == "tester_7"


async def test_sync_does_not_overwrite_newer_events(env) -> None:
    uid = str(uuid.uuid4())
    t = now()
    await env.emit("user.status.changed.v1", {"user_id": uid, "status": "DISABLED", "previous_status": "ACTIVE"},
                   producer=ID, occurred_at=t)
    await env.emit("user.security.changed.v1", {"user_id": uid, "change": "pin_set"}, producer=ID, occurred_at=t)
    # снимок старше событий (прочитан до их фиксации)
    env.identity.put(snapshot(uid, n=1, updated_at=t - timedelta(seconds=5)))
    await env.sync.run_once()
    r = await summary(env, uid)
    assert r.status == "DISABLED" and r.pin_enabled and r.username == "tester_1"
    # снимок новее — побеждает
    env.identity.put(snapshot(uid, n=1, updated_at=t + timedelta(seconds=5), status="ACTIVE",
                              security={"pin_enabled": False, "biometric_enabled": False}))
    await env.sync.run_once()
    r = await summary(env, uid)
    assert r.status == "ACTIVE" and not r.pin_enabled


async def test_sync_learns_deletion_and_erases_pii(env) -> None:
    uid = str(uuid.uuid4())
    env.identity.put(snapshot(uid, n=3, updated_at=now() - timedelta(minutes=1)))
    await env.sync.run_once()
    assert (await summary(env, uid)).username == "tester_3"
    env.identity.put(snapshot(uid, n=3, updated_at=now(), status="DELETED", username=None, display_name=None,
                              telegram_id_masked=MASK * 9))
    await env.sync.run_once()
    r = await summary(env, uid)
    assert r.status == "DELETED" and r.username is None and r.display_name is None and r.erased_at


async def test_identity_failure_keeps_service_alive(make_env) -> None:
    identity = FakeIdentity(down=True)
    env = await make_env(identity, sync_enabled=True, sync_interval_seconds=3600)

    async def failed() -> bool:
        st = await state(env)
        return st is not None and st.last_error is not None

    await env.wait_for(failed)
    st = await state(env)
    assert st.last_error in ("UpstreamError", "CircuitOpen") and st.last_success_at is None
    assert (await env.client.get("/health/ready")).status_code == 200
    assert (await env.client.get("/health/live")).status_code == 200
    listing = await env.get("/admin/v1/users")
    assert listing.status_code == 200 and listing.json() == {"items": [], "next_cursor": None}
    # события продолжают обрабатываться
    uid = str(uuid.uuid4())
    await env.emit("user.status.changed.v1", {"user_id": uid, "status": "DISABLED", "previous_status": "ACTIVE"},
                   producer=ID)
    assert (await summary(env, uid)).status == "DISABLED"

    with pytest.raises(UpstreamError):
        await env.sync.run_once()
    # источник поднялся: досрочный прогон по новому пользователю (user.profile.created.v1 будит сверку)
    identity.down = False
    env.sync._wake.set()  # прерываем ожидание после сбоя (circuit breaker мог открыться — ждём пробу)
    env.identity.calls.clear()
    fresh = identity.put(snapshot(n=9))
    env.sync.rt.client("identity-consent").breaker.success()

    async def appeared() -> bool:
        r = await summary(env, fresh["user_id"])
        return r is not None and r.username == "tester_9"

    await env.emit("user.profile.created.v1", {"user_id": fresh["user_id"], "created_at": now().isoformat()},
                   producer=ID)
    await env.wait_for(appeared)


async def test_startup_sync_runs_in_background(make_env) -> None:
    identity = FakeIdentity()
    snaps = [identity.put(snapshot(n=n)) for n in range(3)]
    env = await make_env(identity, sync_enabled=True, sync_interval_seconds=3600)

    async def synced() -> bool:
        async with env.runtime.transaction() as s:
            return len((await s.execute(select(UserSummary.user_id))).all()) == 3

    await env.wait_for(synced)
    page = (await env.get("/admin/v1/users")).json()
    assert {i["user_id"] for i in page["items"]} == {s["user_id"] for s in snaps}


async def test_invalid_snapshot_is_skipped(env) -> None:
    good = env.identity.put(snapshot(n=1))
    bad = snapshot(n=2)
    bad["status"] = "HACKED"
    env.identity.put(bad)
    assert await env.sync.run_once() == 1
    assert await summary(env, good["user_id"]) is not None
    assert await summary(env, bad["user_id"]) is None


async def test_concurrent_runs_are_serialized(env) -> None:
    for n in range(4):
        env.identity.put(snapshot(n=n))
    results = await asyncio.gather(env.sync.run_once(), env.sync.run_once())
    assert sorted(results) == [4, 4]
    assert (await state(env)).synced_total == 8
