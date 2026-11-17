from __future__ import annotations

import asyncio
import re
import uuid
from typing import Any

import pytest
from sqlalchemy import text

from tilhero_common.internal_auth import issue_token

PREFS = "/internal/v1/me/preferences"
DEPS = "/internal/v1/me/departures"
DONE = "/internal/v1/me/onboarding/complete"
ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

# Профиль демо-пользователя из прототипа (U-12846), переведённый в контракт.
IGOR = {
    "interests": {"categories": ["sport.motorsport", "business.ai", "business.fintech", "music.concerts"],
                  "entities": ["Formula 1"]},
    "geographies": [{"level": "country", "code": "AE"}, {"level": "country", "code": "TR"},
                    {"level": "region", "code": "europe"}],
    "strong_events_outside_geo": True,
    "event_formats": ["offline", "online"],
    "budget": {"currency": "USD", "preset": None, "min": 500, "max": 2000, "custom_amount": None},
    "search_horizon_months": 12,
    "notification_points_months": [3, 6],
    "flight_prefs": {"direct": True, "connecting": True, "alternative_departure": True},
}


async def test_default_profile_created_on_first_get(env, user) -> None:
    r = await env.c.get(PREFS, headers=env.h(user))
    assert r.status_code == 200
    body = r.json()
    assert ISO_Z.match(body.pop("updated_at"))
    assert body == {
        "interests": {"categories": [], "entities": []},
        "geographies": [],
        "strong_events_outside_geo": False,
        "event_formats": ["offline"],
        "budget": {"currency": "USD", "preset": None, "min": None, "max": None, "custom_amount": None},
        "search_horizon_months": 12,
        "notification_points_months": [3, 6],
        "departures": [],  # BR-TG-004: город вылета без действия пользователя не выбирается
        "flight_prefs": {"direct": True, "connecting": True, "alternative_departure": True},
        "hotel_prefs": {"rating_min": None, "max_distance_km": None, "min_stars": None},  # 6.3: по умолчанию
        "onboarding_completed_at": None,
        "version": 1,
    }
    again = await env.c.get(PREFS, headers=env.h(user))
    assert again.json()["version"] == 1  # повторный GET не создаёт и не меняет профиль
    async with env.runtime.transaction() as s:
        assert (await s.execute(text("SELECT count(*) FROM preference_profiles"))).scalar() == 1
    await env.flush()
    assert env.events("user.preferences.updated.v1") == []  # создание по умолчанию — не изменение


async def test_patch_full_profile(env, user) -> None:
    r = await env.c.patch(PREFS, json={**IGOR, "version": 1}, headers=env.h(user))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["version"] == 2
    assert body["budget"] == {"currency": "USD", "preset": None, "min": 500, "max": 2000,
                              "custom_amount": None}
    assert body["geographies"] == IGOR["geographies"]
    assert body["interests"] == IGOR["interests"]
    assert body["event_formats"] == ["offline", "online"]
    got = (await env.c.get(PREFS, headers=env.h(user))).json()
    assert got == body


async def test_patch_is_partial_and_idempotent(env, user) -> None:
    h = env.h(user)
    first = await env.c.patch(PREFS, json={"search_horizon_months": 6}, headers=h)
    assert first.json()["version"] == 2
    assert first.json()["event_formats"] == ["offline"]  # не переданные поля не меняются
    repeat = await env.c.patch(PREFS, json={"search_horizon_months": 6}, headers=h)
    assert repeat.status_code == 200 and repeat.json()["version"] == 2  # no-op: версия не растёт
    assert repeat.json()["updated_at"] == first.json()["updated_at"]
    await env.flush()
    events = env.events("user.preferences.updated.v1")
    assert len(events) == 1 and events[0].payload["changed_fields"] == ["search_horizon_months"]


async def test_optimistic_locking(env, user) -> None:
    h = env.h(user)
    await env.c.get(PREFS, headers=h)
    ok = await env.c.patch(PREFS, json={"strong_events_outside_geo": True, "version": 1}, headers=h)
    assert ok.status_code == 200 and ok.json()["version"] == 2
    stale = await env.c.patch(PREFS, json={"strong_events_outside_geo": False, "version": 1}, headers=h)
    assert stale.status_code == 409
    assert stale.json()["code"] == "PREFERENCES_VERSION_CONFLICT"
    assert stale.json()["details"] == {"current_version": 2}
    assert (await env.c.get(PREFS, headers=h)).json()["strong_events_outside_geo"] is True
    # без version — последняя запись выигрывает (version в контракте необязателен)
    lww = await env.c.patch(PREFS, json={"strong_events_outside_geo": False}, headers=h)
    assert lww.status_code == 200 and lww.json()["version"] == 3


async def test_budget_presets_and_custom(env, user) -> None:
    h = env.h(user)

    async def budget(b: dict[str, Any]) -> dict[str, Any]:
        r = await env.c.patch(PREFS, json={"budget": b}, headers=h)
        assert r.status_code == 200, r.text
        return r.json()["budget"]

    expect = {"under_500": (0, 500), "500_1000": (500, 1000), "1000_2000": (1000, 2000),
              "2000_5000": (2000, 5000)}
    for preset, (lo, hi) in expect.items():
        assert await budget({"preset": preset}) == {"currency": "USD", "preset": preset, "min": lo, "max": hi,
                                                     "custom_amount": None}
    # min/max пресета вычисляет сервис — присланные значения не важны (GET → PATCH round-trip)
    assert (await budget({"preset": "500_1000", "min": 1, "max": 2}))["min"] == 500
    assert await budget({"preset": "custom", "custom_amount": 1500}) == {
        "currency": "USD", "preset": "custom", "min": 0, "max": 1500, "custom_amount": 1500}
    assert (await budget({"preset": "custom", "custom_amount": 50}))["custom_amount"] == 50
    assert (await budget({"preset": "custom", "custom_amount": 100000}))["custom_amount"] == 100000
    # объединение соседних диапазонов (мультивыбор чипов в прототипе) и нормализация в пресет
    assert (await budget({"min": 500, "max": 2000}))["preset"] is None
    assert (await budget({"min": 1000, "max": 2000}))["preset"] == "1000_2000"
    assert await budget({}) == {"currency": "USD", "preset": None, "min": None, "max": None,
                                "custom_amount": None}


async def test_horizon_trims_points_like_prototype(env, user) -> None:
    h = env.h(user)
    r = await env.c.patch(PREFS, json={"search_horizon_months": 3}, headers=h)
    assert r.json()["notification_points_months"] == [3]
    await env.flush()
    assert env.events("user.preferences.updated.v1")[-1].payload["changed_fields"] == [
        "search_horizon_months", "notification_points_months"]
    r = await env.c.patch(PREFS, json={"search_horizon_months": 24, "notification_points_months": [12, 1, 6]},
                          headers=h)
    assert r.json()["notification_points_months"] == [1, 6, 12]
    r = await env.c.patch(PREFS, json={"notification_points_months": []}, headers=h)
    assert r.status_code == 200 and r.json()["notification_points_months"] == []


async def test_normalization(env, user) -> None:
    r = await env.c.patch(PREFS, headers=env.h(user), json={
        "interests": {"categories": ["festivals"], "entities": ["  Coldplay  ", "Web   Summit"]},
        "geographies": [{"level": "country", "code": "uz"}, {"level": "city", "code": "  São   Paulo "},
                        {"level": "world", "code": None}][:2],
        "event_formats": ["online", "offline"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["interests"]["entities"] == ["Coldplay", "Web Summit"]
    assert body["geographies"] == [{"level": "country", "code": "UZ"}, {"level": "city", "code": "São Paulo"}]
    assert body["event_formats"] == ["offline", "online"]
    world = await env.c.patch(PREFS, json={"geographies": [{"level": "world"}]}, headers=env.h(user))
    assert world.json()["geographies"] == [{"level": "world"}]  # code отсутствует, а не null (bff.ts)


# 31 страна > лимита 30
MANY_COUNTRIES = ["AE", "AT", "AU", "AZ", "BE", "BR", "CA", "CH", "CN", "CY", "CZ", "DE", "DK", "EG", "ES",
                  "FI", "FR", "GB", "GE", "GR", "HK", "HU", "ID", "IE", "IL", "IN", "IT", "JP", "KG", "KR",
                  "KZ"]

INVALID: list[tuple[dict[str, Any], str, str]] = [
    # interests
    ({"interests": {"categories": ["sport.chess"], "entities": []}}, "interests.categories",
     "unknown_category"),
    ({"interests": {"categories": ["sport", "sport"], "entities": []}}, "interests.categories", "duplicate"),
    ({"interests": {"categories": [], "entities": [f"E{i}" for i in range(21)]}}, "interests.entities",
     "too_many"),
    ({"interests": {"categories": [], "entities": ["   "]}}, "interests.entities", "length"),
    ({"interests": {"categories": [], "entities": ["x" * 61]}}, "interests.entities", "length"),
    ({"interests": {"categories": [], "entities": ["Coldplay", "coldplay "]}}, "interests.entities",
     "duplicate"),
    ({"interests": {"categories": [], "entities": ["bad\u0000name"]}}, "interests.entities", "invalid_chars"),
    ({"interests": {"categories": []}}, "interests.entities", "required"),
    ({"interests": {"categories": [1], "entities": []}}, "interests.categories", "invalid_type"),
    # geographies
    ({"geographies": [{"level": "region", "code": "mars"}]}, "geographies.code", "unknown_region"),
    ({"geographies": [{"level": "country", "code": "XX"}]}, "geographies.code", "unknown_country"),
    ({"geographies": [{"level": "country"}]}, "geographies.code", "unknown_country"),
    ({"geographies": [{"level": "city", "code": ""}]}, "geographies.code", "length"),
    ({"geographies": [{"level": "city", "code": "y" * 61}]}, "geographies.code", "length"),
    ({"geographies": [{"level": "city", "code": "Москва"}]}, "geographies.code", "english_name_required"),
    ({"geographies": [{"level": "world", "code": "UZ"}]}, "geographies.code", "not_allowed"),
    ({"geographies": [{"level": "world"}, {"level": "country", "code": "UZ"}]}, "geographies",
     "world_exclusive"),
    ({"geographies": [{"level": "country", "code": "UZ"}, {"level": "country", "code": "uz"}]}, "geographies",
     "duplicate"),
    ({"geographies": [{"level": "planet", "code": "earth"}]}, "geographies.level", "not_allowed"),
    ({"geographies": [{"level": "country", "code": c} for c in MANY_COUNTRIES]}, "geographies", "too_many"),
    # формат
    ({"event_formats": []}, "event_formats", "empty"),
    ({"event_formats": ["offline", "offline"]}, "event_formats", "duplicate"),
    ({"event_formats": ["hybrid"]}, "event_formats", "not_allowed"),
    # бюджет
    ({"budget": {"preset": "custom"}}, "budget.custom_amount", "required"),
    ({"budget": {"preset": "custom", "custom_amount": 49}}, "budget.custom_amount", "out_of_range"),
    ({"budget": {"preset": "custom", "custom_amount": 100001}}, "budget.custom_amount", "out_of_range"),
    ({"budget": {"preset": "custom", "custom_amount": "1500"}}, "budget.custom_amount", "integer_required"),
    ({"budget": {"preset": "custom", "custom_amount": 1500.5}}, "budget.custom_amount", "integer_required"),
    ({"budget": {"preset": "custom", "custom_amount": "$1500"}}, "budget.custom_amount", "integer_required"),
    ({"budget": {"preset": "custom", "custom_amount": True}}, "budget.custom_amount", "integer_required"),
    ({"budget": {"preset": "500_1000", "custom_amount": 700}}, "budget.custom_amount", "not_allowed"),
    ({"budget": {"custom_amount": 700}}, "budget.custom_amount", "not_allowed"),
    ({"budget": {"preset": "cheap"}}, "budget.preset", "not_allowed"),
    ({"budget": {"currency": "EUR", "preset": "under_500"}}, "budget.currency", "not_allowed"),
    ({"budget": {"min": 500}}, "budget.max", "required"),
    ({"budget": {"min": 700, "max": 2000}}, "budget.min", "not_preset_boundary"),
    ({"budget": {"min": 2000, "max": 500}}, "budget.max", "invalid_range"),
    # горизонт и точки
    ({"search_horizon_months": 9}, "search_horizon_months", "not_allowed"),
    ({"search_horizon_months": "12"}, "search_horizon_months", "not_allowed"),
    ({"notification_points_months": [2]}, "notification_points_months", "not_allowed"),
    ({"notification_points_months": [3, 3]}, "notification_points_months", "duplicate"),
    ({"search_horizon_months": 3, "notification_points_months": [6]}, "notification_points_months",
     "exceeds_horizon"),
    # рейсы
    ({"flight_prefs": {"direct": False, "connecting": False, "alternative_departure": True}}, "flight_prefs",
     "at_least_one"),
    ({"flight_prefs": {"direct": True, "connecting": True}}, "flight_prefs.alternative_departure",
     "required"),
    ({"flight_prefs": {"direct": "yes", "connecting": True, "alternative_departure": True}},
     "flight_prefs.direct", "invalid_type"),
    # общее
    ({"strong_events_outside_geo": None}, "strong_events_outside_geo", "null_not_allowed"),
    ({"departures": [{"airport_iata": "TAS"}]}, "departures", "unknown_field"),
    ({"user_id": str(uuid.uuid4())}, "user_id", "unknown_field"),  # user_id только из токена
    ({"onboarding_completed_at": "2026-10-08T00:00:00Z"}, "onboarding_completed_at", "unknown_field"),
    ({"version": 0}, "version", "out_of_range"),
]


@pytest.mark.parametrize(("body", "field", "reason"), INVALID, ids=[f"{f}:{r}" for _, f, r in INVALID])
async def test_patch_validation(env, user, body, field, reason) -> None:
    r = await env.c.patch(PREFS, json=body, headers=env.h(user))
    assert r.status_code == 422, r.text
    err = r.json()
    assert err["code"] == "PREFERENCES_INVALID"
    assert (err["details"]["field"], err["details"]["reason"]) == (field, reason)
    assert err["message"] == "Некорректные предпочтения"
    # профиль не изменился
    assert (await env.c.get(PREFS, headers=env.h(user))).json()["version"] == 1


async def test_patch_rejects_non_object_body(env, user) -> None:
    r = await env.c.patch(PREFS, json=["interests"], headers=env.h(user))
    assert r.status_code == 422 and r.json()["code"] == "PREFERENCES_INVALID"


async def test_entities_limit_boundary_ok(env, user) -> None:
    ents = ["x" * 60] + [f"Entity {i}" for i in range(19)]
    body = {"interests": {"categories": ["music", "music.jazz"], "entities": ents}}
    r = await env.c.patch(PREFS, json=body, headers=env.h(user))
    assert r.status_code == 200 and len(r.json()["interests"]["entities"]) == 20


async def test_departures(env, user) -> None:
    h = env.h(user)
    r = await env.c.put(DEPS, json={"airports": ["TAS", "skd"]}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["departures"] == [{"airport_iata": "TAS", "city": "Tashkent", "country_code": "UZ"},
                                      {"airport_iata": "SKD", "city": "Samarkand", "country_code": "UZ"}]
    assert r.json()["version"] == 2
    same = await env.c.put(DEPS, json={"airports": ["TAS", "SKD"]}, headers=h)
    assert same.json()["version"] == 2  # повтор — no-op
    unknown = await env.c.put(DEPS, json={"airports": ["TAS", "QQQ"]}, headers=h)
    assert unknown.status_code == 422
    assert unknown.json()["code"] == "AIRPORT_UNKNOWN" and unknown.json()["details"] == {"iata": "QQQ"}
    bad_format = await env.c.put(DEPS, json={"airports": ["T1"]}, headers=h)
    assert bad_format.json()["code"] == "AIRPORT_UNKNOWN"
    eleven = ["TAS", "SKD", "BHK", "NMA", "FEG", "UGC", "NCU", "TMJ", "KSQ", "NVI", "AZN"]
    too_many = await env.c.put(DEPS, json={"airports": eleven}, headers=h)
    assert too_many.status_code == 422
    assert too_many.json()["details"] == {"field": "airports", "reason": "too_many", "max": 10}
    dup = await env.c.put(DEPS, json={"airports": ["TAS", "tas"]}, headers=h)
    assert dup.json()["details"]["reason"] == "duplicate"
    shape = await env.c.put(DEPS, json={"airports": "TAS"}, headers=h)
    assert shape.status_code == 422
    assert shape.json()["details"] == {"field": "airports", "reason": "invalid_type"}
    extra = await env.c.put(DEPS, json={"airports": [], "version": 2}, headers=h)
    assert extra.json()["details"] == {"field": "version", "reason": "unknown_field"}
    ten = ["TAS", "SKD", "BHK", "NMA", "FEG", "UGC", "NCU", "TMJ", "KSQ", "NVI"]
    assert len((await env.c.put(DEPS, json={"airports": ten}, headers=h)).json()["departures"]) == 10
    cleared = await env.c.put(DEPS, json={"airports": []}, headers=h)
    assert cleared.status_code == 200 and cleared.json()["departures"] == []
    # PATCH не меняет departures
    assert (await env.c.patch(PREFS, json={"departures": []}, headers=h)).status_code == 422


async def test_onboarding_complete_is_idempotent(env, user) -> None:
    h = env.h(user)
    first = await env.c.post(DONE, headers=h)
    assert first.status_code == 200
    ts = first.json()["onboarding_completed_at"]
    assert ISO_Z.match(ts) and first.json()["version"] == 2
    second = await env.c.post(DONE, headers=h)
    assert second.json()["onboarding_completed_at"] == ts and second.json()["version"] == 2
    await env.flush()
    done = [e for e in env.events("user.preferences.updated.v1") if e.payload["onboarding_completed"]]
    assert len(done) == 1 and done[0].payload["changed_fields"] == ["onboarding_completed_at"]


async def test_user_isolation(env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    await env.c.patch(PREFS, json={"search_horizon_months": 24}, headers=env.h(a))
    await env.c.put(DEPS, json={"airports": ["DXB"]}, headers=env.h(a))
    other = (await env.c.get(PREFS, headers=env.h(b))).json()
    assert other["search_horizon_months"] == 12 and other["departures"] == [] and other["version"] == 1
    # чужая версия не даёт доступа: B правит только свой профиль
    r = await env.c.patch(PREFS, json={"search_horizon_months": 3, "version": 1}, headers=env.h(b))
    assert r.status_code == 200
    assert (await env.c.get(PREFS, headers=env.h(a))).json()["search_horizon_months"] == 24


async def test_auth(env, user) -> None:
    endpoints = [("GET", PREFS, None), ("PATCH", PREFS, {"search_horizon_months": 6}),
                 ("PUT", DEPS, {"airports": ["TAS"]}), ("POST", DONE, None)]
    for method, path, body in endpoints:
        none = await env.c.request(method, path, json=body)
        assert none.status_code == 401 and none.json()["code"] == "INTERNAL_TOKEN_MISSING"
        forged = issue_token("x" * 40, issuer="telegram-bff", audience="preferences", subject=str(user))
        bad = await env.c.request(method, path, json=body, headers={"x-internal-token": forged})
        assert bad.status_code == 401 and bad.json()["code"] == "INTERNAL_TOKEN_INVALID"
        expired = issue_token("t" * 40, issuer="telegram-bff", audience="preferences", subject=str(user),
                              ttl_seconds=-10)
        exp = await env.c.request(method, path, json=body, headers={"x-internal-token": expired})
        assert exp.status_code == 401 and exp.json()["code"] == "INTERNAL_TOKEN_EXPIRED"
        wrong_aud = issue_token("t" * 40, issuer="telegram-bff", audience="support", subject=str(user))
        assert (await env.c.request(method, path, json=body,
                                    headers={"x-internal-token": wrong_aud})).status_code == 401
        caller = await env.c.request(method, path, json=body, headers=env.h(user, issuer="admin-bff"))
        assert caller.status_code == 403 and caller.json()["code"] == "CALLER_NOT_ALLOWED"
        no_user = await env.c.request(method, path, json=body, headers=env.h(None))
        assert no_user.status_code == 401 and no_user.json()["code"] == "USER_CONTEXT_REQUIRED"
        bad_user = await env.c.request(method, path, json=body, headers=env.h("not-a-uuid"))
        assert bad_user.status_code == 401 and bad_user.json()["code"] == "USER_CONTEXT_INVALID"
    async with env.runtime.transaction() as s:
        assert (await s.execute(text("SELECT count(*) FROM preference_profiles"))).scalar() == 0


async def test_unknown_route_404(env, user) -> None:
    r = await env.c.get("/internal/v1/me/preferences/other", headers=env.h(user))
    assert r.status_code == 404 and r.json()["code"] == "NOT_FOUND"


async def test_concurrent_patches_with_same_version(env, user) -> None:
    h = env.h(user)
    await env.c.get(PREFS, headers=h)
    bodies = [{"search_horizon_months": hz, "version": 1} for hz in (3, 6, 24, 3, 6)]
    results = await asyncio.gather(*[env.c.patch(PREFS, json=b, headers=h) for b in bodies])
    codes = sorted(r.status_code for r in results)
    assert codes == [200, 409, 409, 409, 409]  # выигрывает ровно один, остальные получают конфликт версии
    assert (await env.c.get(PREFS, headers=h)).json()["version"] == 2


async def test_concurrent_first_access_creates_single_profile(env, user) -> None:
    results = await asyncio.gather(*[env.c.get(PREFS, headers=env.h(user)) for _ in range(5)],
                                   env.c.put(DEPS, json={"airports": ["TAS"]}, headers=env.h(user)))
    assert all(r.status_code == 200 for r in results)
    async with env.runtime.transaction() as s:
        assert (await s.execute(text("SELECT count(*) FROM preference_profiles"))).scalar() == 1
