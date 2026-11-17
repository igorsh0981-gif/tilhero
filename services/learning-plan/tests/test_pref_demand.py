"""GET /internal/v1/demand — агрегат спроса для discovery (спринт 3)."""

from __future__ import annotations

import json
import uuid

from tilhero_common.internal_auth import issue_token
from tilhero_learning_plan.domain.demand import city_country

DEMAND = "/internal/v1/demand"
PREFS = "/internal/v1/me/preferences"
DONE = "/internal/v1/me/onboarding/complete"


async def _profile(env, *, geos, cats=(), formats=("offline",), complete=True) -> uuid.UUID:
    user = uuid.uuid4()
    body = {"geographies": [dict(g) for g in geos], "interests": {"categories": list(cats), "entities": []},
            "event_formats": list(formats)}
    r = await env.c.patch(PREFS, json=body, headers=env.h(user))
    assert r.status_code == 200, r.text
    if complete:
        assert (await env.c.post(DONE, headers=env.h(user))).status_code == 200
    return user


def _discovery(env) -> dict[str, str]:
    return env.h(issuer="discovery")


async def test_demand_aggregates_completed_profiles(env) -> None:
    u1 = await _profile(env, geos=[{"level": "country", "code": "AE"}, {"level": "city", "code": "Abu Dhabi"}],
                        cats=["sport.motorsport", "music.concerts"], formats=["offline", "online"])
    await _profile(env, geos=[{"level": "country", "code": "ae"}, {"level": "region", "code": "europe"}],
                   cats=["sport.motorsport"])
    await _profile(env, geos=[{"level": "world"}], cats=["business.ai"], formats=["online"])
    await _profile(env, geos=[{"level": "city", "code": "abu dhabi"}, {"level": "city", "code": "Springfield"}])
    # онбординг не завершён — не учитывается
    await _profile(env, geos=[{"level": "country", "code": "US"}], cats=["sport.football"], complete=False)

    r = await env.c.get(DEMAND, headers=_discovery(env))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["generated_at"].endswith("Z")
    assert body["users"] == 4
    assert body["countries"] == [{"code": "AE", "users": 2}]
    assert body["regions"] == [{"code": "europe", "users": 1}]
    assert body["world_users"] == 1
    assert body["online_users"] == 2
    # города группируются без учёта регистра; страна — из справочника, неизвестный город → null
    assert body["cities"] == [{"name": "Abu Dhabi", "country_code": "AE", "users": 2},
                              {"name": "Springfield", "country_code": None, "users": 1}]
    assert body["categories"] == [{"code": "sport.motorsport", "users": 2},
                                  {"code": "business.ai", "users": 1},
                                  {"code": "music.concerts", "users": 1}]
    # приватность: в ответе нет user_id ни в каком виде
    raw = json.dumps(body)
    assert "user_id" not in raw and str(u1) not in raw


async def test_demand_hides_small_groups(env) -> None:
    for _ in range(2):
        await _profile(env, geos=[{"level": "country", "code": "TR"}], cats=["sport.football"])
    await _profile(env, geos=[{"level": "country", "code": "KZ"}], cats=["music.jazz"], formats=["online"])
    env.settings.demand_min_group = 2
    try:
        body = (await env.c.get(DEMAND, headers=_discovery(env))).json()
    finally:
        env.settings.demand_min_group = 1
    assert body["countries"] == [{"code": "TR", "users": 2}]
    assert body["categories"] == [{"code": "sport.football", "users": 2}]
    assert body["online_users"] == 0  # 1 < порога
    assert body["users"] == 3


async def test_demand_top_n(env) -> None:
    for code in ("AE", "TR", "KZ"):
        await _profile(env, geos=[{"level": "country", "code": code}])
    env.settings.demand_top_n = 2
    try:
        body = (await env.c.get(DEMAND, headers=_discovery(env))).json()
    finally:
        env.settings.demand_top_n = 50
    assert [c["code"] for c in body["countries"]] == ["AE", "KZ"]  # равные группы — по коду


async def test_demand_empty_database(env) -> None:
    body = (await env.c.get(DEMAND, headers=_discovery(env))).json()
    body.pop("generated_at")
    assert body == {"users": 0, "countries": [], "cities": [], "categories": [], "online_users": 0,
                    "regions": [], "world_users": 0}


async def test_demand_auth(env) -> None:
    assert (await env.c.get(DEMAND)).status_code == 401
    bad = await env.c.get(DEMAND, headers={"x-internal-token": "not-a-jwt"})
    assert bad.status_code == 401 and bad.json()["code"] == "INTERNAL_TOKEN_INVALID"
    # токен discovery, подписанный чужим ключом
    forged = issue_token("x" * 40, issuer="discovery", audience="preferences")
    assert (await env.c.get(DEMAND, headers={"x-internal-token": forged})).status_code == 401
    # токен для другого сервиса (aud)
    other_aud = {"x-internal-token": issue_token(env.settings.internal_jwt_secret.get_secret_value(),
                                                 issuer="discovery", audience="events")}
    assert (await env.c.get(DEMAND, headers=other_aud)).status_code == 401
    for issuer in ("telegram-bff", "admin-bff", "provider-gateway"):
        r = await env.c.get(DEMAND, headers=env.h(issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    # клиентский /me недоступен discovery
    assert (await env.c.get(PREFS, headers=env.h(uuid.uuid4(), issuer="discovery"))).status_code == 403


def test_city_country_lookup() -> None:
    assert city_country("Abu Dhabi") == "AE"
    assert city_country("abu-dhabi") == "AE"
    assert city_country("Tashkent") == "UZ"
    assert city_country("Nowhere City") is None
