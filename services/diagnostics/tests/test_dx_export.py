"""Выгрузка `levels` (спринт 7, ревью 🔴3): payload diagnostics.completed.v1 последнего результата каждой пары каждого
неудалённого ученика — ровно как в событии; курсор и limit; доступ — только gamification и lessons."""

from __future__ import annotations

import uuid
from datetime import timedelta

from dx_testkit import always, up_to

from tilhero_common.messaging import make_envelope
from tilhero_common.testing import assert_event_conforms, internal_headers


async def export(env, params: dict | None = None, issuer: str = "gamification", expect: int = 200) -> dict:
    r = await env.c.get("/internal/v1/export/levels", params=params,
                        headers=internal_headers(env.settings, issuer=issuer))
    assert r.status_code == expect, r.text
    return r.json()


async def test_levels_export_matches_events(env) -> None:
    a, b, gone = sorted((uuid.uuid4(), uuid.uuid4(), uuid.uuid4()), key=str)
    for u in (a, b, gone):
        await env.complete(u, up_to("A1"))
    env.now += timedelta(days=15)
    await env.complete(a, always("correct"))  # повтор: в выгрузке — последний результат
    await env.bus.publish(make_envelope("user.deletion.requested.v1", {
        "user_id": str(gone), "request_id": str(uuid.uuid4()), "requested_at": "2026-12-04T09:00:00Z"},
        producer="identity-consent"))
    events = await env.events("diagnostics.completed.v1")
    latest = {}
    for e in events:  # по времени публикации: последний результат ученика
        latest[e.payload["user_id"]] = e.payload
    out = await export(env)
    assert out["next_cursor"] is None
    assert out["items"] == [latest[str(a)], latest[str(b)]]  # удалённого нет, порядок — по user_id
    assert out["items"][0]["result_id"] != events[0].payload["result_id"]
    for item in out["items"]:
        assert_event_conforms(make_envelope("diagnostics.completed.v1", item, producer="diagnostics"))
    # постранично: limit=1 → курсор
    first = await export(env, {"limit": 1})
    assert first["items"] == [latest[str(a)]] and first["next_cursor"]
    second = await export(env, {"limit": 1, "cursor": first["next_cursor"]})
    assert second["items"] == [latest[str(b)]] and second["next_cursor"] is None
    # доступ: lessons — да; telegram-bff и без токена — нет; неверный курсор и limit
    assert (await export(env, issuer="lessons"))["items"] == out["items"]
    assert (await export(env, issuer="telegram-bff", expect=403))["code"] == "CALLER_NOT_ALLOWED"
    r = await env.c.get("/internal/v1/export/levels")
    assert r.status_code == 401
    assert (await export(env, {"cursor": "!!"}, expect=400))["code"] == "INVALID_CURSOR"
    await export(env, {"limit": 501}, expect=422)
    await export(env, {"limit": 0}, expect=422)


async def test_levels_export_empty(env) -> None:
    assert await export(env) == {"items": [], "next_cursor": None}
