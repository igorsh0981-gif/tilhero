"""Единый лимитер запросов (спринт 9, INTERNAL_API §2.1–2.3) — та же семантика, что ts-common `src/rateLimit.ts`.

- **GCRA** на одном ключе субъекта `rl:<policy>:<subject>` (Lua, `EVALSHA`; две реплики делят ключ, время — Redis).
  Эталон скрипта — `packages/contracts/rate-limit-gcra.lua`, общий тест-вектор — `rate-limit-vectors.json`.
- **Каталог политик** — `packages/contracts/rate-limit-policies.json` (копия — `POLICIES`, тест сверяет).
- **Переопределение без деплоя** — `rl:override:<policy>` (JSON `{v: 1, limit, window_s, burst|null, by, at, reason,
  expires_at|null}`), перечитывается раз в `RATE_LIMIT_OVERRIDE_REFRESH_SECONDS`; повреждённая запись — значения
  по умолчанию + WARNING. Пишет ops-monitor (`set_override` / `clear_override`).
- **Метрики** — `rlm:<policy>:<epoch_minute>` hash `{allowed, rejected, failopen, failclosed}` и `rlt:<policy>:<minute>`
  ZSET отказов по субъекту (≤ 50), TTL 3 ч; читает только ops-monitor (`read_metrics`, `read_policies`).
  Действующие параметры каждого процесса — `rl:policy:<policy>` (JSON, TTL 10 мин).
- **Сбой Redis** — `fail: open` пропускает (метрика `failopen` + WARNING не чаще раза в минуту), `fail: closed` —
  503 `RATE_LIMIT_UNAVAILABLE`. Счётчики сбоев копятся в процессе и дописываются в Redis после восстановления.
- **Выключатель** `RATE_LIMITS_ENABLED=false` — лимитер пропускает всё и считает только `allowed`.

Субъект — псевдоним: `user_id`, `staff_id`, `<caller>@<service>`; IP и e-mail — только хеш с суточной солью (BFF).
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import Request
from redis.asyncio import Redis
from redis.exceptions import NoScriptError

from tilhero_common.errors import ApiError

log = logging.getLogger("tilhero.ratelimit")

FailMode = Literal["open", "closed"]
METRICS_TTL_SECONDS = 3 * 3600
TOP_SUBJECTS = 50
POLICY_TTL_SECONDS = 600
METRIC_FIELDS = ("allowed", "rejected", "failopen", "failclosed")

GCRA_LUA = """-- TilHero: единый лимитер запросов (спринт 9, INTERNAL_API §2.1) — GCRA на одном ключе субъекта.
-- Эталон; копии — py-common tilhero_common/ratelimit.py (GCRA_LUA) и ts-common src/rateLimit.ts (GCRA_LUA),
-- тесты обеих сторон сверяют копию с этим файлом и прогоняют packages/contracts/rate-limit-vectors.json.
-- KEYS[1] rl:<policy>:<subject>   — TAT (theoretical arrival time), мкс
-- KEYS[2] rlm:<policy>:<minute>   — метрики минуты {allowed, rejected}
-- KEYS[3] rlt:<policy>:<minute>   — ZSET отказов по субъекту (псевдоним), ≤ ARGV[6]
-- ARGV[1] интервал между запросами, мкс (window_s * 1e6 / limit, целое)
-- ARGV[2] burst (≥ 1)
-- ARGV[3] now, мкс ("" — время Redis: реплики делят одни часы)
-- ARGV[4] субъект для топа отказов
-- ARGV[5] TTL метрик, с
-- ARGV[6] размер топа отказов
-- → {allowed 0|1, retry_after_ms, remaining}
local t = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
if not now then
  local tm = redis.call('TIME')
  now = tonumber(tm[1]) * 1000000 + tonumber(tm[2])
end
local tat = tonumber(redis.call('GET', KEYS[1]))
if not tat or tat < now then
  tat = now
end
local new_tat = tat + t
local allow_at = new_tat - burst * t
local ttl = tonumber(ARGV[5])
if now < allow_at then
  redis.call('HINCRBY', KEYS[2], 'rejected', 1)
  redis.call('EXPIRE', KEYS[2], ttl)
  local top = tonumber(ARGV[6])
  redis.call('ZINCRBY', KEYS[3], 1, ARGV[4])
  if redis.call('ZCARD', KEYS[3]) > top then
    redis.call('ZREMRANGEBYRANK', KEYS[3], 0, -(top + 1))
  end
  redis.call('EXPIRE', KEYS[3], ttl)
  return {0, math.ceil((allow_at - now) / 1000), 0}
end
redis.call('SET', KEYS[1], string.format('%d', new_tat), 'PX', math.ceil((new_tat - now) / 1000))
redis.call('HINCRBY', KEYS[2], 'allowed', 1)
redis.call('EXPIRE', KEYS[2], ttl)
return {1, 0, math.floor((now - allow_at) / t)}
"""


@dataclass(frozen=True)
class Policy:
    policy: str
    service: str
    subject: str
    limit: int
    window_s: int
    burst: int | None
    fail: FailMode
    env: str | None = None
    description: str = ""

    @property
    def effective_burst(self) -> int:
        return self.burst or self.limit

    @property
    def emission_us(self) -> int:
        return max(1, (self.window_s * 1_000_000) // self.limit)


def _p(policy: str, service: str, subject: str, limit: int, window_s: int, fail: FailMode, env: str | None,
       description: str) -> Policy:
    return Policy(policy, service, subject, limit, window_s, None, fail, env, description)


# Копия packages/contracts/rate-limit-policies.json (тест test_ratelimit.py сверяет поле в поле)
POLICIES: dict[str, Policy] = {p.policy: p for p in (
    _p("tg.user", "telegram-bff", "user", 120, 60, "open", "RATE_LIMIT_USER_PER_MIN",
       "Все авторизованные запросы Mini App — на пользователя"),
    _p("tg.session_ip", "telegram-bff", "ip", 10, 60, "closed", "RATE_LIMIT_SESSION_IP_PER_MIN",
       "Вход по initData (POST /v1/session/telegram) — с одного IP"),
    _p("tg.pin", "telegram-bff", "user", 5, 60, "closed", "RATE_LIMIT_PIN_PER_MIN",
       "Проверка и сброс PIN / биометрии — на пользователя (сброс — отдельный счётчик reset:<user_id>)"),
    _p("tg.public_ip", "telegram-bff", "ip", 120, 60, "open", "RATE_LIMIT_PUBLIC_IP_PER_MIN",
       "Публичные эндпоинты Mini App (refresh, config, policy) — с одного IP"),
    _p("tg.support_create", "telegram-bff", "user", 10, 3600, "open", None,
       "Создание обращения в поддержку — на пользователя в час (новая)"),
    _p("tg.speech", "telegram-bff", "user", 120, 600, "open", None,
       "Озвучка фраз контента (POST /v1/speech) — на пользователя за 10 минут (новая, релиз 4.1)"),
    _p("adm.login_ip", "admin-bff", "ip", 10, 60, "closed", "RATE_LIMIT_LOGIN_IP_PER_MIN",
       "Вход сотрудника (POST /admin/v1/auth/login) — с одного IP"),
    _p("adm.login_email", "admin-bff", "email", 5, 60, "closed", "RATE_LIMIT_LOGIN_EMAIL_PER_MIN",
       "Вход сотрудника — на один e-mail (в ключе только хеш с суточной солью)"),
    _p("adm.auth_step_ip", "admin-bff", "ip", 30, 60, "closed", "RATE_LIMIT_AUTH_STEP_IP_PER_MIN",
       "Шаги входа по challenge (MFA, enroll, пароль) — с одного IP"),
    _p("adm.mfa", "admin-bff", "staff", 5, 60, "closed", "RATE_LIMIT_MFA_PER_MIN",
       "Ввод TOTP и смена пароля — на challenge входа (хеш) и на сотрудника (step-up, пароль — отдельные счётчики)"),
    _p("adm.staff", "admin-bff", "staff", 300, 60, "open", "RATE_LIMIT_STAFF_PER_MIN",
       "Все запросы сотрудника"),
    _p("adm.command", "admin-bff", "staff", 60, 60, "closed", None,
       "Команды сотрудника (POST / PUT / PATCH / DELETE) (новая)"),
    _p("adm.dlq", "admin-bff", "staff", 10, 60, "closed", None,
       "Команды DLQ и повтор удаления профиля (новая)"),
    _p("int.caller", "*", "caller", 10_000, 60, "open", None,
       "Внутренние вызовы Python-сервисов — на пару (вызывающий, сервис): защита от зацикливания (новая)"),
    _p("gw.llm.user", "ai-gateway", "user", 40, 60, "open", None,
       "Потоковый LLM (ai-gateway, спринт 4) — на пользователя"),
)}

# Защитный минимум для политик fail: closed (вход, PIN, команды): не реже 1 запроса в минуту
MIN_CLOSED_PER_MINUTE = 1.0


# ---------------------------------------------------------------- ошибки (INTERNAL_API §2.2, §9)

def rate_limited(policy: str, retry_after: int) -> ApiError:
    return ApiError(429, "RATE_LIMITED", "Слишком много запросов, повторите позже",
                    {"policy": policy, "retry_after": max(1, int(retry_after))})


def rate_limit_unavailable(policy: str) -> ApiError:
    return ApiError(503, "RATE_LIMIT_UNAVAILABLE", "Проверка лимита временно недоступна, повторите позже",
                    {"policy": policy})


# ---------------------------------------------------------------- ключи

def key_rl(policy: str, subject: str, prefix: str = "") -> str:
    return f"{prefix}rl:{policy}:{subject}"


def key_metrics(policy: str, minute: int, prefix: str = "") -> str:
    return f"{prefix}rlm:{policy}:{minute}"


def key_top(policy: str, minute: int, prefix: str = "") -> str:
    return f"{prefix}rlt:{policy}:{minute}"


def key_override(policy: str, prefix: str = "") -> str:
    return f"{prefix}rl:override:{policy}"


def key_policy(policy: str, prefix: str = "") -> str:
    return f"{prefix}rl:policy:{policy}"


def epoch_minute(ms: float) -> int:
    return int(ms // 60_000)


# ---------------------------------------------------------------- переопределения

@dataclass(frozen=True)
class Override:
    limit: int
    window_s: int
    burst: int | None
    by: str
    at: str
    reason: str
    expires_at: str | None = None

    def to_json(self) -> str:
        return json.dumps({"v": 1, "limit": self.limit, "window_s": self.window_s, "burst": self.burst,
                           "by": self.by, "at": self.at, "reason": self.reason, "expires_at": self.expires_at},
                          ensure_ascii=False)


def parse_override(raw: str | bytes | None, now: datetime | None = None) -> Override | None:
    """None — записи нет или она истекла; повреждённая — ValueError."""
    if raw is None:
        return None
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get("v") != 1:
        raise ValueError("override version")
    limit, window_s, burst = data.get("limit"), data.get("window_s"), data.get("burst")
    if not (isinstance(limit, int) and not isinstance(limit, bool) and 1 <= limit <= 100_000):
        raise ValueError("override limit")
    if not (isinstance(window_s, int) and not isinstance(window_s, bool) and 1 <= window_s <= 86_400):
        raise ValueError("override window_s")
    if burst is not None and not (isinstance(burst, int) and not isinstance(burst, bool) and 1 <= burst <= 100_000):
        raise ValueError("override burst")
    expires = data.get("expires_at")
    if expires is not None:
        exp = datetime.fromisoformat(str(expires).replace("Z", "+00:00"))
        if exp.tzinfo is None:
            raise ValueError("override expires_at without zone")
        if exp <= (now or datetime.now(UTC)):
            return None
    return Override(limit, window_s, burst, str(data.get("by") or ""), str(data.get("at") or ""),
                    str(data.get("reason") or ""), None if expires is None else str(expires))


def too_strict(policy: Policy, limit: int, window_s: int) -> bool:
    """Переопределение политики fail: closed реже 1 запроса в минуту → 422 RATE_LIMIT_TOO_STRICT (ops-monitor)."""
    return policy.fail == "closed" and limit * 60 / window_s < MIN_CLOSED_PER_MINUTE


# Политики fail: closed — защита входа, MFA, PIN, сессий и команд от перебора. Ослабить их переопределением можно
# не больше чем в MAX_CLOSED_FACTOR раз от значения каталога и только на срок ≤ MAX_CLOSED_LOOSE_HOURS
# (ревью спринта 9, ФРОНТ-3): 422 RATE_LIMIT_TOO_LOOSE
MAX_CLOSED_FACTOR = 10
MAX_CLOSED_LOOSE_HOURS = 24


def loosens(policy: Policy, limit: int, window_s: int, burst: int | None) -> bool:
    """Переопределение пропускает больше, чем каталог (по скорости или по запасу burst)."""
    # скорости сравниваются в целых (limit / window_s против каталога) — без ошибок округления на границе
    return limit * policy.window_s > policy.limit * window_s or (burst or limit) > policy.effective_burst


def too_loose(policy: Policy, limit: int, window_s: int, burst: int | None) -> bool:
    """fail: closed и больше MAX_CLOSED_FACTOR × каталог по скорости или по burst."""
    if policy.fail != "closed":
        return False
    return (limit * policy.window_s > MAX_CLOSED_FACTOR * policy.limit * window_s
            or (burst or limit) > MAX_CLOSED_FACTOR * policy.effective_burst)


async def set_override(redis: Redis, policy: str, override: Override, *, prefix: str = "") -> None:
    if policy not in POLICIES:
        raise KeyError(policy)
    await redis.set(key_override(policy, prefix), override.to_json())


async def clear_override(redis: Redis, policy: str, *, prefix: str = "") -> None:
    await redis.delete(key_override(policy, prefix))


async def read_overrides(redis: Redis, policies: Iterable[str] | None = None, *,
                         prefix: str = "") -> dict[str, Override | None]:
    """Действующие переопределения (повреждённые и истёкшие — None)."""
    names = list(policies) if policies is not None else list(POLICIES)
    raws = await redis.mget([key_override(n, prefix) for n in names]) if names else []
    out: dict[str, Override | None] = {}
    for name, raw in zip(names, raws, strict=True):
        try:
            out[name] = parse_override(raw)
        except (ValueError, TypeError):
            out[name] = None
    return out


# ---------------------------------------------------------------- чтение метрик (ops-monitor, пакет Q3)

@dataclass(frozen=True)
class MinuteMetrics:
    policy: str
    minute: int  # epoch-минута (UTC): начало = minute * 60 с
    allowed: int = 0
    rejected: int = 0
    failopen: int = 0
    failclosed: int = 0
    top: tuple[tuple[str, int], ...] = ()  # (субъект-псевдоним, отказов), по убыванию


async def read_metrics(redis: Redis, *, since_minute: int, until_minute: int | None = None,
                       policies: Iterable[str] | None = None, prefix: str = "",
                       with_top: bool = True) -> list[MinuteMetrics]:
    """Минутные метрики политик за [since_minute, until_minute] (включительно; по умолчанию — до текущей минуты).
    Пустые минуты не возвращаются. Хранение в Redis — 3 ч: ops-monitor переносит их в свои корзины."""
    until = until_minute if until_minute is not None else epoch_minute(time.time() * 1000)
    names = list(policies) if policies is not None else list(POLICIES)
    minutes = range(since_minute, until + 1)
    pairs = [(n, m) for n in names for m in minutes]
    if not pairs:
        return []
    async with redis.pipeline(transaction=False) as pipe:
        for n, m in pairs:
            pipe.hgetall(key_metrics(n, m, prefix))
            if with_top:
                pipe.zrevrange(key_top(n, m, prefix), 0, TOP_SUBJECTS - 1, withscores=True)
        raw = await pipe.execute()
    step = 2 if with_top else 1
    out: list[MinuteMetrics] = []
    for i, (n, m) in enumerate(pairs):
        h = raw[i * step] or {}
        top = tuple((str(s), int(c)) for s, c in raw[i * step + 1]) if with_top else ()
        if not h and not top:
            continue
        c = {f: int(h.get(f, 0) or 0) for f in METRIC_FIELDS}
        out.append(MinuteMetrics(n, m, allowed=c["allowed"], rejected=c["rejected"], failopen=c["failopen"],
                                 failclosed=c["failclosed"], top=top))
    return out


async def read_policies(redis: Redis, policies: Iterable[str] | None = None, *,
                        prefix: str = "") -> dict[str, dict[str, Any]]:
    """Параметры, с которыми политики работают сейчас (публикует каждый процесс лимитера, TTL 10 мин):
    `{limit, window_s, burst, fail, service, subject, source: default|override, enabled}`. Нет записи — процесс с
    этой политикой не запущен (или старше спринта 9): ops-monitor показывает значение каталога."""
    names = list(policies) if policies is not None else list(POLICIES)
    raws = await redis.mget([key_policy(n, prefix) for n in names]) if names else []
    out: dict[str, dict[str, Any]] = {}
    for name, raw in zip(names, raws, strict=True):
        if raw:
            try:
                out[name] = json.loads(raw)
            except ValueError:
                continue
    return out


# ---------------------------------------------------------------- лимитер

@dataclass(frozen=True)
class Decision:
    allowed: bool
    retry_after: int  # секунды, ≥ 1 при отказе
    remaining: int
    policy: str
    degraded: bool = False  # Redis недоступен, политика fail: open — пропущено без проверки


@dataclass
class _Pending:
    counts: dict[tuple[str, int, str], int] = field(default_factory=lambda: defaultdict(int))


class RateLimiter:
    """Лимитер процесса. `enforce(policy, subject)` бросает 429 `RATE_LIMITED` / 503 `RATE_LIMIT_UNAVAILABLE`."""

    def __init__(
        self,
        redis: Redis,
        *,
        service: str,
        policies: Mapping[str, Policy] | None = None,
        enabled: bool = True,
        override_refresh_seconds: float = 30.0,
        key_prefix: str = "",
        timeout_seconds: float = 0.5,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.redis = redis
        self.service = service
        self.defaults: dict[str, Policy] = dict(policies or POLICIES)
        self.enabled = enabled
        self.refresh_seconds = override_refresh_seconds
        self.prefix = key_prefix
        self.timeout = timeout_seconds
        self.clock = clock
        self._overrides: dict[str, Override | None] = {}
        self._refreshed_at = -math.inf
        self._refreshing: asyncio.Task[None] | None = None
        self._sha: str | None = None
        self._pending = _Pending()
        self._warned: dict[str, float] = {}

    # ---- параметры
    def effective(self, policy: str) -> tuple[Policy, str]:
        base = self.defaults[policy]
        ov = self._overrides.get(policy)
        if ov is None:
            return base, "default"
        return replace(base, limit=ov.limit, window_s=ov.window_s, burst=ov.burst), "override"

    async def refresh(self) -> None:
        """Перечитать переопределения и опубликовать действующие параметры (`rl:policy:*`)."""
        names = list(self.defaults)
        raws = await self.redis.mget([key_override(n, self.prefix) for n in names])
        fresh: dict[str, Override | None] = {}
        for name, raw in zip(names, raws, strict=True):
            try:
                fresh[name] = parse_override(raw)
            except (ValueError, TypeError):
                log.warning("rate limit override invalid, defaults used", extra={"policy": name})
                fresh[name] = None
        self._overrides = fresh
        self._refreshed_at = time.monotonic()
        own = [n for n in names if self.defaults[n].service in (self.service, "*")]
        if not own:
            return
        async with self.redis.pipeline(transaction=False) as pipe:
            for name in own:  # публикует только свои политики: чужие значения env процесс не знает
                p, source = self.effective(name)
                pipe.set(key_policy(name, self.prefix), json.dumps(
                    {"limit": p.limit, "window_s": p.window_s, "burst": p.burst, "fail": p.fail,
                     "service": p.service, "subject": p.subject, "source": source, "enabled": self.enabled}),
                    ex=POLICY_TTL_SECONDS)
            await pipe.execute()

    def _maybe_refresh(self) -> None:
        if time.monotonic() - self._refreshed_at < self.refresh_seconds:
            return
        if self._refreshing is not None and not self._refreshing.done():
            return

        async def run() -> None:
            try:
                await asyncio.wait_for(self.refresh(), max(self.timeout, 1.0))
            except Exception as exc:  # Redis недоступен — прежние значения, повтор при следующей проверке
                self._refreshed_at = time.monotonic() - self.refresh_seconds + 5
                log.debug("rate limit refresh failed", extra={"error_type": type(exc).__name__})

        self._refreshing = asyncio.get_running_loop().create_task(run())

    # ---- проверка
    async def _eval(self, keys: list[str], args: list[Any]) -> list[int]:
        if self._sha is None:
            self._sha = await self.redis.script_load(GCRA_LUA)
        try:
            res = await self.redis.evalsha(self._sha, len(keys), *keys, *args)
        except NoScriptError:
            self._sha = await self.redis.script_load(GCRA_LUA)
            res = await self.redis.evalsha(self._sha, len(keys), *keys, *args)
        return [int(x) for x in res]

    async def check(self, policy: str, subject: str) -> Decision:
        p, _ = self.effective(policy)
        now_ms = self.clock() * 1000
        minute = epoch_minute(now_ms)
        self._maybe_refresh()
        if not self.enabled:
            self._fire(self._count(policy, minute, "allowed"))
            return Decision(True, 0, p.effective_burst, policy)
        try:
            allowed, retry_ms, remaining = await asyncio.wait_for(self._eval(
                [key_rl(policy, subject, self.prefix), key_metrics(policy, minute, self.prefix),
                 key_top(policy, minute, self.prefix)],
                [p.emission_us, p.effective_burst, "", subject, METRICS_TTL_SECONDS, TOP_SUBJECTS],
            ), self.timeout)
        except Exception as exc:
            return self._failed(p, minute, exc)
        if self._pending.counts:
            self._fire(self._flush_pending())
        if allowed:
            return Decision(True, 0, remaining, policy)
        return Decision(False, max(1, math.ceil(retry_ms / 1000)), 0, policy)

    async def enforce(self, policy: str, subject: str) -> Decision:
        d = await self.check(policy, subject)
        if not d.allowed:
            raise rate_limited(policy, d.retry_after)
        return d

    def _failed(self, p: Policy, minute: int, exc: BaseException) -> Decision:
        field_ = "failclosed" if p.fail == "closed" else "failopen"
        self._pending.counts[(p.policy, minute, field_)] += 1
        now = time.monotonic()
        if now - self._warned.get(p.policy, -math.inf) >= 60:
            self._warned[p.policy] = now
            log.warning("rate limit store unavailable", extra={"policy": p.policy, "fail": p.fail,
                                                                "error_type": type(exc).__name__})
        if p.fail == "closed":
            raise rate_limit_unavailable(p.policy)
        return Decision(True, 0, 0, p.policy, degraded=True)

    async def _count(self, policy: str, minute: int, field_: str, n: int = 1) -> None:
        key = key_metrics(policy, minute, self.prefix)
        async with self.redis.pipeline(transaction=False) as pipe:
            pipe.hincrby(key, field_, n)
            pipe.expire(key, METRICS_TTL_SECONDS)
            await pipe.execute()

    async def _flush_pending(self) -> None:
        counts, self._pending.counts = self._pending.counts, defaultdict(int)
        try:
            for (policy, minute, field_), n in counts.items():
                await self._count(policy, minute, field_, n)
        except Exception:
            for k, n in counts.items():  # не дописали — вернуть в очередь
                self._pending.counts[k] += n

    def _fire(self, coro: Any) -> None:
        """Метрики — fire-and-forget: ответ не ждёт записи, ошибка записи не влияет на запрос."""
        task = asyncio.get_running_loop().create_task(coro)
        task.add_done_callback(lambda t: t.cancelled() or t.exception())


def runtime_limiter(request: Request) -> RateLimiter | None:
    return getattr(request.app.state.runtime, "ratelimiter", None)


async def enforce(request: Request, policy: str, subject: str) -> None:
    """Проверка политики в обработчике Python-сервиса (например, `gw.llm.user` в ai-gateway).
    У сервиса без Redis лимитера нет — проверка пропускается."""
    limiter = runtime_limiter(request)
    if limiter is not None:
        await limiter.enforce(policy, subject)
