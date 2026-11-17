"""Redis-примитивы: rate limit, idempotency HTTP-команд, счётчик попыток с блокировкой."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from redis.asyncio import Redis

from tilhero_common.errors import conflict, unprocessable


@dataclass(frozen=True)
class RateResult:
    allowed: bool
    remaining: int
    reset_seconds: int


async def rate_limit(redis: Redis, key: str, limit: int, window_seconds: int) -> RateResult:
    """Фиксированное окно: INCR + EXPIRE атомарно в pipeline."""
    full = f"rl:{key}"
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(full)
        pipe.expire(full, window_seconds, nx=True)
        pipe.ttl(full)
        count, _, ttl = await pipe.execute()
    return RateResult(allowed=count <= limit, remaining=max(limit - count, 0), reset_seconds=max(int(ttl), 0))


def fingerprint(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


class IdempotencyStore:
    """Idempotency-Key для команд: повтор с тем же ключом и телом возвращает сохранённый ответ.

    begin() → None, если команду нужно выполнить; dict — сохранённый ответ (replay).
    Тот же ключ с другим телом → 422 IDEMPOTENCY_KEY_REUSED; параллельный дубль → 409 IDEMPOTENCY_IN_PROGRESS.
    """

    def __init__(self, redis: Redis, namespace: str, ttl_seconds: int = 24 * 3600) -> None:
        self.redis = redis
        self.namespace = namespace
        self.ttl = ttl_seconds

    def _key(self, scope: str, key: str) -> str:
        return f"idem:{self.namespace}:{scope}:{key}"

    async def begin(self, scope: str, key: str, request_fp: str) -> dict[str, Any] | None:
        full = self._key(scope, key)
        created = await self.redis.set(full, json.dumps({"state": "pending", "fp": request_fp}), nx=True, ex=60)
        if created:
            return None
        raw = await self.redis.get(full)
        if raw is None:
            return await self.begin(scope, key, request_fp)
        stored = json.loads(raw)
        if stored.get("fp") != request_fp:
            raise unprocessable("IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными")
        if stored.get("state") == "pending":
            raise conflict("IDEMPOTENCY_IN_PROGRESS", "Запрос с этим ключом уже выполняется")
        return stored["response"]

    async def complete(self, scope: str, key: str, request_fp: str, response: dict[str, Any]) -> None:
        await self.redis.set(
            self._key(scope, key),
            json.dumps({"state": "done", "fp": request_fp, "response": response}, default=str),
            ex=self.ttl,
        )

    async def abort(self, scope: str, key: str) -> None:
        await self.redis.delete(self._key(scope, key))


@dataclass(frozen=True)
class AttemptState:
    locked: bool
    remaining: int
    retry_after: int


# Спринт 9: проверка блокировки, INCR и установка блокировки — один Lua-скрипт. Раньше state()/fail() были отдельными
# командами: запрос, прочитавший «не заблокировано» до блокировки соседом, делал INCR уже после того, как сосед
# поставил блокировку и удалил счётчик, — и получал попытку с полным запасом (обход блокировки).
# KEYS: lock, fail; ARGV: max_attempts, lock_seconds, fail_ttl → {1, retry_after} (заблокировано) | {0, remaining}
_RESERVE = """
local ttl = redis.call('TTL', KEYS[1])
if ttl > 0 then return {1, ttl} end
local used = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
if used > tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], '1', 'EX', ARGV[2])
  redis.call('DEL', KEYS[2])
  return {1, tonumber(ARGV[2])}
end
return {0, tonumber(ARGV[1]) - used}
"""
# Неудача без резервирования: уже заблокировано — счётчик не трогаем; иначе INCR и на max_attempts — блокировка.
_FAIL = """
local ttl = redis.call('TTL', KEYS[1])
if ttl > 0 then return {1, ttl} end
local used = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
if used >= tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], '1', 'EX', ARGV[2])
  redis.call('DEL', KEYS[2])
  return {1, tonumber(ARGV[2])}
end
return {0, tonumber(ARGV[1]) - used}
"""


class AttemptLimiter:
    """Попытки с блокировкой (PIN: 5 попыток → блок 5 мин, ТЗ TG-FR-003).

    Безопасный порядок проверки секрета — **резервирование** (спринт 9): `reserve()` атомарно проверяет блокировку и
    занимает попытку ДО проверки, `failed()` — неудача (на последней — блокировка), `reset()` — успех. Из
    параллельного «залпа» проверяются не более `max_attempts` вариантов, остальные сразу получают блокировку.
    `fail()` — неудача без резервирования (атомарно: при уже стоящей блокировке счётчик не меняется).
    """

    def __init__(self, redis: Redis, namespace: str, max_attempts: int = 5, lock_seconds: int = 300) -> None:
        self.redis = redis
        self.ns = namespace
        self.max_attempts = max_attempts
        self.lock_seconds = lock_seconds

    def _keys(self, subject: str) -> tuple[str, str]:
        return f"{self.ns}:lock:{subject}", f"{self.ns}:fail:{subject}"

    async def _script(self, script: str, subject: str) -> AttemptState:
        locked, value = await self.redis.eval(script, 2, *self._keys(subject),
                                              self.max_attempts, self.lock_seconds, self.lock_seconds * 6)
        if int(locked):
            return AttemptState(True, 0, int(value))
        return AttemptState(False, int(value), 0)

    async def state(self, subject: str) -> AttemptState:
        lock_ttl = await self.redis.ttl(f"{self.ns}:lock:{subject}")
        if lock_ttl and lock_ttl > 0:
            return AttemptState(True, 0, int(lock_ttl))
        used = int(await self.redis.get(f"{self.ns}:fail:{subject}") or 0)
        return AttemptState(False, max(self.max_attempts - used, 0), 0)

    async def reserve(self, subject: str) -> AttemptState:
        """Занять попытку. locked=True — проверять секрет нельзя; иначе remaining — сколько останется, если эта
        попытка окажется неудачной."""
        return await self._script(_RESERVE, subject)

    async def failed(self, subject: str, reserved: AttemptState) -> AttemptState:
        """Зарезервированная попытка оказалась неудачной: на последней — блокировка."""
        if reserved.remaining <= 0:
            lock, fail = self._keys(subject)
            await self.redis.set(lock, "1", ex=self.lock_seconds)
            await self.redis.delete(fail)
            return AttemptState(True, 0, self.lock_seconds)
        return reserved

    async def fail(self, subject: str) -> AttemptState:
        return await self._script(_FAIL, subject)

    async def reset(self, subject: str) -> None:
        await self.redis.delete(*self._keys(subject))
