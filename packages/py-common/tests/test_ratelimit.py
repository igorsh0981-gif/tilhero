"""Единый лимитер (спринт 9, INTERNAL_API §2.1–2.3) на реальном Redis стенда: GCRA (общий тест-вектор с ts-common),
каталог, две реплики, переопределения, метрики, сбой Redis по режиму политики, int.caller в create_app."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from fastapi import APIRouter, Depends, Request
from redis.asyncio import Redis

from tilhero_common import ratelimit as rl
from tilhero_common.app import Runtime, create_app
from tilhero_common.errors import ApiError
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_common.settings import ServiceSettings
from tilhero_common.testing import TEST_REDIS_URL, internal_headers

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
SECRET = "test-secret-" + "x" * 32


@pytest.fixture
async def redis():
    r = Redis.from_url(TEST_REDIS_URL, decode_responses=True)
    yield r
    await r.aclose()


@pytest.fixture
def prefix() -> str:
    return f"rltest:{uuid.uuid4().hex[:8]}:"


@pytest.fixture
async def cleanup(redis: Redis, prefix: str):
    yield
    keys = [k async for k in redis.scan_iter(f"{prefix}*")]
    if keys:
        await redis.delete(*keys)


def limiter(redis: Redis, prefix: str, **kw) -> rl.RateLimiter:
    return rl.RateLimiter(redis, service="svc-test", key_prefix=prefix, **kw)


def policies(**over: tuple[int, int, str]) -> dict[str, rl.Policy]:
    """Каталог + тестовые политики `t.<имя>` = (limit, window_s, fail)."""
    out = dict(rl.POLICIES)
    for name, (limit, window, fail) in over.items():
        out[f"t.{name}"] = rl.Policy(f"t.{name}", "svc-test", "user", limit, window, None, fail)  # type: ignore[arg-type]
    return out


# ---------------------------------------------------------------- контракт: скрипт, каталог, тест-вектор

def test_lua_copy_matches_contract() -> None:
    assert rl.GCRA_LUA == (CONTRACTS / "rate-limit-gcra.lua").read_text("utf-8")


def test_policies_match_catalog() -> None:
    doc = json.loads((CONTRACTS / "rate-limit-policies.json").read_text("utf-8"))
    assert doc["version"] == 1
    catalog = {p["policy"]: p for p in doc["policies"]}
    assert list(catalog) == list(rl.POLICIES)
    for name, p in rl.POLICIES.items():
        c = catalog[name]
        assert (p.service, p.subject, p.limit, p.window_s, p.burst, p.fail, p.env, p.description) == (
            c["service"], c["subject"], c["limit"], c["window_s"], c["burst"], c["fail"], c["env"], c["description"]
        ), name
    # имена не пересекаются со служебными ключами rl:override:* / rl:policy:* / rl:salt:*
    assert all("." in n and n.split(".")[0] in ("tg", "adm", "int", "gw") for n in catalog)
    closed = {n for n, p in catalog.items() if p["fail"] == "closed"}
    assert closed == {"tg.session_ip", "tg.pin", "adm.login_ip", "adm.login_email", "adm.auth_step_ip", "adm.mfa",
                      "adm.command", "adm.dlq"}


async def test_gcra_vectors(redis: Redis, prefix: str, cleanup: None) -> None:
    doc = json.loads((CONTRACTS / "rate-limit-vectors.json").read_text("utf-8"))
    sha = await redis.script_load(rl.GCRA_LUA)
    for case in doc["cases"]:
        burst = case["burst"] or case["limit"]
        emission = (case["window_s"] * 1_000_000) // case["limit"]
        assert emission == case["emission_us"]
        key = f"{prefix}rl:vec:{uuid.uuid4().hex[:6]}"
        for step in case["steps"]:
            res = await redis.evalsha(sha, 3, key, f"{prefix}rlm:vec:1", f"{prefix}rlt:vec:1", emission, burst,
                                      (doc["t0_ms"] + step["at_ms"]) * 1000, "s", 60, 50)
            got = {"allowed": bool(res[0]), "retry_after_ms": int(res[1]), "remaining": int(res[2])}
            assert got == step["expect"], (case["name"], step)


# ---------------------------------------------------------------- поведение лимитера

async def test_two_replicas_share_limit_and_429_shape(redis: Redis, prefix: str, cleanup: None) -> None:
    pol = policies(share=(5, 60, "open"))
    a, b = limiter(redis, prefix, policies=pol), limiter(redis, prefix, policies=pol)
    user = str(uuid.uuid4())
    results = await asyncio.gather(*((a if i % 2 else b).check("t.share", user) for i in range(8)))
    assert sum(d.allowed for d in results) == 5  # гонка двух реплик: ровно limit, не 2 × limit
    rejected = [d for d in results if not d.allowed]
    assert all(1 <= d.retry_after <= 12 for d in rejected)
    with pytest.raises(ApiError) as e:
        await a.enforce("t.share", user)
    assert e.value.status == 429 and e.value.code == "RATE_LIMITED"
    assert e.value.details["policy"] == "t.share" and e.value.details["retry_after"] >= 1
    # другой субъект — свой ключ
    assert (await b.check("t.share", str(uuid.uuid4()))).allowed


async def test_window_boundary_no_double_burst(redis: Redis, prefix: str, cleanup: None) -> None:
    """Фиксированное окно пропускало 2 × limit на стыке минут; GCRA — нет (время — из Redis)."""
    lim = limiter(redis, prefix, policies=policies(edge=(10, 60, "open")))
    user = str(uuid.uuid4())
    first = [await lim.check("t.edge", user) for _ in range(10)]
    assert all(d.allowed for d in first) and first[-1].remaining == 0
    d = await lim.check("t.edge", user)
    assert not d.allowed and 5 <= d.retry_after <= 6  # интервал 6 с


async def test_metrics_top_and_read_metrics(redis: Redis, prefix: str, cleanup: None) -> None:
    lim = limiter(redis, prefix, policies=policies(m=(2, 60, "open")))
    users = [str(uuid.uuid4()) for _ in range(3)]
    for u in users:
        for _ in range(3 if u != users[2] else 5):
            await lim.check("t.m", u)
    minute = rl.epoch_minute(time.time() * 1000)
    rows = await rl.read_metrics(redis, since_minute=minute - 1, policies=["t.m", "tg.user"], prefix=prefix)
    assert [r.policy for r in rows] == ["t.m"]
    row = rows[0]
    assert (row.allowed, row.rejected, row.failopen, row.failclosed) == (6, 5, 0, 0)
    assert row.top[0] == (users[2], 3) and {s for s, _ in row.top} == set(users)
    assert await redis.ttl(rl.key_metrics("t.m", minute, prefix)) > 3 * 3600 - 10
    # в ключах — только имя политики и псевдоним субъекта
    keys = [k async for k in redis.scan_iter(f"{prefix}*")]
    assert all(k.split(":", 2)[2].startswith(("rl:t.m:", "rlm:t.m:", "rlt:t.m:", "rl:policy:")) for k in keys), keys
    assert not any("tg.user" in k or "adm." in k for k in keys), keys  # чужие политики процесс не публикует


async def test_top_subjects_capped(redis: Redis, prefix: str, cleanup: None) -> None:
    lim = limiter(redis, prefix, policies=policies(cap=(1, 3600, "open")))
    for i in range(60):
        s = f"s{i:02d}"
        await lim.check("t.cap", s)
        await lim.check("t.cap", s)
    minute = rl.epoch_minute(time.time() * 1000)
    assert await redis.zcard(rl.key_top("t.cap", minute, prefix)) <= rl.TOP_SUBJECTS


async def test_override_applied_within_refresh_and_reset(redis: Redis, prefix: str, cleanup: None) -> None:
    lim = limiter(redis, prefix, policies=policies(ov=(2, 60, "open")), override_refresh_seconds=1)
    user = str(uuid.uuid4())
    assert [(await lim.check("t.ov", user)).allowed for _ in range(3)] == [True, True, False]
    ov = rl.Override(limit=100, window_s=60, burst=None, by="staff-1", at=datetime.now(UTC).isoformat(),
                     reason="праздник")
    await rl.set_override(redis, "tg.user", ov, prefix=prefix)  # чужая политика — на t.ov не влияет
    await redis.set(rl.key_override("t.ov", prefix), ov.to_json())
    deadline = time.monotonic() + 5
    while not (await lim.check("t.ov", user)).allowed:  # переопределение действует ≤ refresh (здесь 1 с)
        assert time.monotonic() < deadline, "override not applied"
        await asyncio.sleep(0.2)
    assert lim.effective("t.ov")[1] == "override"
    pub = await rl.read_policies(redis, ["t.ov", "tg.user"], prefix=prefix)
    assert pub["t.ov"]["limit"] == 100 and pub["t.ov"]["source"] == "override" and pub["t.ov"]["service"] == "svc-test"
    assert "tg.user" not in pub  # политика telegram-bff — не своя для svc-test
    await rl.clear_override(redis, "t.ov", prefix=prefix)
    await asyncio.sleep(1.1)
    await lim.check("t.ov", user)  # запускает перечитывание
    await asyncio.sleep(0.3)
    assert lim.effective("t.ov") == (policies(ov=(2, 60, "open"))["t.ov"], "default")


async def test_invalid_or_expired_override_uses_defaults(redis: Redis, prefix: str, cleanup: None,
                                                         caplog: pytest.LogCaptureFixture) -> None:
    lim = limiter(redis, prefix, policies=policies(bad=(3, 60, "open"), exp=(3, 60, "open")))
    await redis.set(rl.key_override("t.bad", prefix), '{"v": 1, "limit": 0, "window_s": 60}')
    past = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
    await redis.set(rl.key_override("t.exp", prefix), json.dumps(
        {"v": 1, "limit": 999, "window_s": 60, "burst": None, "by": "s", "at": past, "reason": "r",
         "expires_at": past}))
    with caplog.at_level(logging.WARNING, logger="tilhero.ratelimit"):
        await lim.refresh()
    assert lim.effective("t.bad")[1] == "default" and lim.effective("t.exp")[1] == "default"
    assert any(r.getMessage() == "rate limit override invalid, defaults used" for r in caplog.records)
    with pytest.raises(ValueError):
        rl.parse_override("not json")
    assert rl.too_strict(rl.POLICIES["adm.mfa"], 1, 120) and not rl.too_strict(rl.POLICIES["adm.mfa"], 1, 60)
    assert not rl.too_strict(rl.POLICIES["tg.user"], 1, 86_400)


async def test_redis_down_fail_open_and_closed(redis: Redis, prefix: str, cleanup: None,
                                               caplog: pytest.LogCaptureFixture) -> None:
    dead = Redis.from_url("redis://127.0.0.1:1/0", decode_responses=True)
    pol = policies(o=(5, 60, "open"), c=(5, 60, "closed"))
    lim = limiter(dead, prefix, policies=pol)
    with caplog.at_level(logging.WARNING, logger="tilhero.ratelimit"):
        for _ in range(3):
            d = await lim.check("t.o", "u1")
            assert d.allowed and d.degraded
        with pytest.raises(ApiError) as e:
            await lim.enforce("t.c", "u1")
    assert e.value.status == 503 and e.value.code == "RATE_LIMIT_UNAVAILABLE" and e.value.details == {"policy": "t.c"}
    warnings = [r for r in caplog.records if r.getMessage() == "rate limit store unavailable"]
    assert len(warnings) == 2  # не чаще раза в минуту на политику
    # Redis вернулся — накопленные сбои дописываются в метрики
    lim.redis = redis
    await lim.check("t.o", "u2")
    await asyncio.sleep(0.2)
    minute = rl.epoch_minute(time.time() * 1000)
    rows = {r.policy: r for r in await rl.read_metrics(redis, since_minute=minute - 1, policies=["t.o", "t.c"],
                                                         prefix=prefix)}
    assert rows["t.o"].failopen == 3 and rows["t.o"].allowed == 1 and rows["t.c"].failclosed == 1
    await dead.aclose()


async def test_redis_timeout_is_failure(prefix: str) -> None:
    class Slow:
        async def script_load(self, _: str) -> str:
            await asyncio.sleep(5)
            return "x"

    lim = rl.RateLimiter(Slow(), service="s", key_prefix=prefix, policies=policies(s=(5, 60, "closed")),  # type: ignore[arg-type]
                         timeout_seconds=0.1)
    started = time.monotonic()
    with pytest.raises(ApiError) as e:
        await lim.enforce("t.s", "u")
    assert e.value.code == "RATE_LIMIT_UNAVAILABLE" and time.monotonic() - started < 1


async def test_disabled_passes_and_counts(redis: Redis, prefix: str, cleanup: None) -> None:
    lim = limiter(redis, prefix, policies=policies(off=(1, 60, "closed")), enabled=False)
    assert all([(await lim.check("t.off", "u")).allowed for _ in range(5)])
    await asyncio.sleep(0.2)
    minute = rl.epoch_minute(time.time() * 1000)
    (row,) = await rl.read_metrics(redis, since_minute=minute, policies=["t.off"], prefix=prefix)
    assert (row.allowed, row.rejected) == (5, 0)
    assert await redis.get(rl.key_rl("t.off", "u", prefix)) is None


# ---------------------------------------------------------------- int.caller в create_app

def _settings(**kw) -> ServiceSettings:
    base = {"service_name": "svc-rl", "env": "test", "internal_jwt_secret": SECRET, "redis_url": TEST_REDIS_URL}
    base.update(kw)
    return ServiceSettings(**base)


async def test_int_caller_limit_in_create_app(redis: Redis, prefix: str, cleanup: None) -> None:
    router = APIRouter()

    @router.get("/internal/v1/ping")
    async def ping(p: Principal = Depends(InternalAuth({"telegram-bff", "admin-bff"})),
                   _again: Principal = Depends(InternalAuth())) -> dict:
        return {"caller": p.issuer}

    @router.get("/internal/v1/llm")
    async def llm(request: Request, p: Principal = Depends(InternalAuth({"ai-concierge"}))) -> dict:
        await rl.enforce(request, "gw.llm.user", p.user_id)
        return {}

    s = _settings()
    runtime = Runtime(s)
    app = create_app(s, routers=[router], runtime=runtime)
    async with app.router.lifespan_context(app):
        lim = runtime.ratelimiter
        assert lim is not None and lim.service == "svc-rl"
        lim.prefix = prefix
        lim.defaults["int.caller"] = dataclasses.replace(rl.POLICIES["int.caller"], limit=3)
        lim.defaults["gw.llm.user"] = dataclasses.replace(rl.POLICIES["gw.llm.user"], limit=1)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            tg = internal_headers(s, issuer="telegram-bff")
            codes = [(await c.get("/internal/v1/ping", headers=tg)).status_code for _ in range(4)]
            assert codes == [200, 200, 200, 429]  # одна проверка на запрос, хоть зависимостей две
            r = await c.get("/internal/v1/ping", headers=tg)
            body = r.json()
            assert r.status_code == 429 and body["code"] == "RATE_LIMITED"
            assert body["message"] == "Слишком много запросов, повторите позже"
            assert body["details"]["policy"] == "int.caller"
            assert int(r.headers["retry-after"]) == body["details"]["retry_after"] >= 1
            # другой вызывающий — своя пара (вызывающий, сервис)
            adm = internal_headers(s, issuer="admin-bff")
            assert (await c.get("/internal/v1/ping", headers=adm)).status_code == 200
            assert await redis.exists(rl.key_rl("int.caller", "telegram-bff@svc-rl", prefix))
            # неверный токен не тратит лимит и не доходит до лимитера
            assert (await c.get("/internal/v1/ping")).status_code == 401
            user = str(uuid.uuid4())
            h = internal_headers(s, issuer="ai-concierge", subject=user)
            assert (await c.get("/internal/v1/llm", headers=h)).status_code == 200
            r = await c.get("/internal/v1/llm", headers=h)
            assert r.status_code == 429 and r.json()["details"]["policy"] == "gw.llm.user"
            assert await redis.exists(rl.key_rl("gw.llm.user", user, prefix))


async def test_service_without_redis_has_no_limiter() -> None:
    s = _settings(redis_url=None)
    runtime = Runtime(s)
    app = create_app(s, runtime=runtime)
    async with app.router.lifespan_context(app):
        assert runtime.ratelimiter is None


async def test_settings_switch_disables(redis: Redis) -> None:
    s = _settings(rate_limits_enabled=False, rate_limit_override_refresh_seconds=5)
    runtime = Runtime(s)
    app = create_app(s, runtime=runtime)
    async with app.router.lifespan_context(app):
        assert runtime.ratelimiter is not None
        assert runtime.ratelimiter.enabled is False and runtime.ratelimiter.refresh_seconds == 5


def test_closed_policies_cannot_be_loosened_beyond_factor_and_open_ones_can() -> None:
    """Ревью спринта 9 (ФРОНТ-3): fail: closed — не мягче MAX_CLOSED_FACTOR × каталог (по скорости и burst);
    ослабление определяется в целых (граница ×10 допустима); fail: open сверху не ограничен."""
    from tilhero_common import ratelimit as rl

    login = rl.POLICIES["adm.login_ip"]  # 10 / 60 с, closed
    assert rl.MAX_CLOSED_FACTOR == 10 and rl.MAX_CLOSED_LOOSE_HOURS == 24
    assert not rl.too_loose(login, 100, 60, None)            # ровно ×10
    assert rl.too_loose(login, 101, 60, None)
    assert not rl.too_loose(login, 10, 6, None) and rl.too_loose(login, 11, 6, None)  # 100 и 110 / мин
    # час с burst = limit пустил бы 6000 сразу — слишком мягко; с burst 100 — та же скорость ×10, допустимо
    assert rl.too_loose(login, 6000, 3600, None) and not rl.too_loose(login, 6000, 3600, 100)
    assert rl.too_loose(login, 6001, 3600, 100)
    assert rl.too_loose(login, 10, 60, 101) and not rl.too_loose(login, 10, 60, 100)
    assert rl.loosens(login, 11, 60, None) and rl.loosens(login, 10, 60, 11)
    assert not rl.loosens(login, 10, 60, None) and not rl.loosens(login, 5, 60, None)
    assert not rl.too_loose(rl.POLICIES["tg.user"], 1_000_000, 60, None)
