"""Исправление 6.3: настройки отеля в профиле (оценка гостей, расстояние до площадки, звёзды)."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from tilhero_common.messaging import make_envelope
from tilhero_common.testing import assert_event_conforms

PREFS = "/internal/v1/me/preferences"
DEFAULT = {"rating_min": None, "max_distance_km": None, "min_stars": None}


async def test_hotel_prefs_patch_roundtrip_and_event(env, user) -> None:
    h = env.h(user)
    body = {"hotel_prefs": {"rating_min": 9.0, "max_distance_km": 1, "min_stars": 4}, "version": 1}
    r = await env.c.patch(PREFS, json=body, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["hotel_prefs"] == {"rating_min": 9.0, "max_distance_km": 1, "min_stars": 4}
    assert r.json()["version"] == 2
    again = (await env.c.get(PREFS, headers=h)).json()
    assert again["hotel_prefs"] == {"rating_min": 9.0, "max_distance_km": 1, "min_stars": 4}
    await env.flush()
    events = env.events("user.preferences.updated.v1")
    assert [e.payload["changed_fields"] for e in events] == [["hotel_prefs"]]
    assert_event_conforms(events[0])

    # тот же PATCH — без изменения версии и без события
    r = await env.c.patch(PREFS, json={"hotel_prefs": {"rating_min": 9, "max_distance_km": 1, "min_stars": 4}},
                          headers=h)
    assert r.status_code == 200 and r.json()["version"] == 2
    await env.flush()
    assert len(env.events("user.preferences.updated.v1")) == 1


async def test_hotel_prefs_any_and_reset_to_defaults(env, user) -> None:
    h = env.h(user)
    # «любая» оценка — 0, «любые» звёзды — 0 → хранится как null; целое 7 — то же, что 7.0
    r = await env.c.patch(PREFS, json={"hotel_prefs": {"rating_min": 0, "max_distance_km": 15, "min_stars": 0}},
                          headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["hotel_prefs"] == {"rating_min": 0.0, "max_distance_km": 15, "min_stars": None}
    r = await env.c.patch(PREFS, json={"hotel_prefs": {"rating_min": 7}}, headers=h)
    assert r.json()["hotel_prefs"] == {"rating_min": 7.0, "max_distance_km": None, "min_stars": None}
    # вложенный объект передаётся целиком: {} — всё по умолчанию
    r = await env.c.patch(PREFS, json={"hotel_prefs": {}}, headers=h)
    assert r.json()["hotel_prefs"] == DEFAULT


async def test_hotel_prefs_other_fields_untouched(env, user) -> None:
    h = env.h(user)
    await env.c.patch(PREFS, json={"hotel_prefs": {"rating_min": 8.0, "max_distance_km": 10}}, headers=h)
    r = await env.c.patch(PREFS, json={"search_horizon_months": 6}, headers=h)
    assert r.json()["hotel_prefs"] == {"rating_min": 8.0, "max_distance_km": 10, "min_stars": None}


INVALID = [
    ({"rating_min": 6.5}, "hotel_prefs.rating_min", "not_allowed"),
    ({"rating_min": 9.5}, "hotel_prefs.rating_min", "not_allowed"),
    ({"rating_min": "8.5"}, "hotel_prefs.rating_min", "invalid_type"),
    ({"max_distance_km": 2}, "hotel_prefs.max_distance_km", "not_allowed"),
    ({"max_distance_km": 20}, "hotel_prefs.max_distance_km", "not_allowed"),
    ({"max_distance_km": 5.5}, "hotel_prefs.max_distance_km", "invalid_type"),
    ({"min_stars": 2}, "hotel_prefs.min_stars", "not_allowed"),
    ({"min_stars": 6}, "hotel_prefs.min_stars", "not_allowed"),
    ({"radius_m": 5000}, "hotel_prefs.radius_m", "unknown_field"),
]


@pytest.mark.parametrize(("value", "field", "reason"), INVALID, ids=[f"{f}:{r}" for _, f, r in INVALID])
async def test_hotel_prefs_validation(env, user, value, field, reason) -> None:
    r = await env.c.patch(PREFS, json={"hotel_prefs": value}, headers=env.h(user))
    assert r.status_code == 422, r.text
    err = r.json()
    assert err["code"] == "PREFERENCES_INVALID"
    assert (err["details"]["field"], err["details"]["reason"]) == (field, reason)
    assert (await env.c.get(PREFS, headers=env.h(user))).json()["version"] == 1


async def test_deletion_saga_removes_hotel_prefs(env, user) -> None:
    h = env.h(user)
    await env.c.patch(PREFS, json={"hotel_prefs": {"rating_min": 9.0, "max_distance_km": 1}}, headers=h)
    await env.bus.publish(make_envelope(
        "user.deletion.requested.v1",
        {"user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": "2026-10-12T10:00:00Z"},
        producer="identity-consent"))
    await env.flush()
    async with env.runtime.transaction() as s:
        n = (await s.execute(text("SELECT count(*) FROM preference_profiles WHERE user_id = :u"),
                             {"u": user})).scalar()
    assert n == 0
    assert [e.payload["domain"] for e in env.events("user.domain.deleted.v1")] == ["preferences"]
