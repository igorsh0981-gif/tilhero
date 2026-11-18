"""Challenge шага входа: 32 байта base64url, Redis (TTL 5 мин), привязан к staff_id, шагу и session_version.

В Redis лежит только хеш challenge (ключ), сам challenge не хранится и не логируется. Одноразовость —
атомарный DEL при успешном использовании: из двух параллельных запросов пройдёт один.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from redis.asyncio import Redis

from tilhero_admin_identity.domain.crypto import digest, new_challenge
from tilhero_common.errors import unauthorized

# HINCRBY по истёкшему ключу создал бы «вечный» ключ без TTL — инкремент только существующего
_INCR_IF_EXISTS = """
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
return redis.call('HINCRBY', KEYS[1], 'attempts', 1)
"""


def challenge_invalid():
    return unauthorized("CHALLENGE_INVALID", "Сессия входа истекла или недействительна — войдите заново")


@dataclass(frozen=True)
class ChallengeData:
    key: str
    staff_id: uuid.UUID
    step: str
    session_version: int
    attempts: int


class Challenges:
    def __init__(self, redis: Redis, namespace: str, ttl_seconds: int, max_attempts: int) -> None:
        self.redis = redis
        self.ns = namespace
        self.ttl = ttl_seconds
        self.max_attempts = max_attempts

    def _key(self, challenge: str) -> str:
        return f"{self.ns}:ch:{digest(challenge)}"

    async def issue(self, staff_id: uuid.UUID, step: str, session_version: int) -> str:
        challenge = new_challenge()
        key = self._key(challenge)
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.hset(key, mapping={"staff_id": str(staff_id), "step": step, "sv": session_version, "attempts": 0})
            pipe.expire(key, self.ttl)
            await pipe.execute()
        return challenge

    async def load(self, challenge: str, step: str) -> ChallengeData:
        key = self._key(challenge)
        raw = await self.redis.hgetall(key)
        if not raw or raw.get("step") != step:
            raise challenge_invalid()
        attempts = int(raw.get("attempts", 0))
        if attempts >= self.max_attempts:
            await self.redis.delete(key)
            raise challenge_invalid()
        # клиент Redis с decode_responses=True: значения — строки
        return ChallengeData(key, uuid.UUID(str(raw["staff_id"])), str(raw["step"]), int(raw["sv"]), attempts)

    async def fail(self, data: ChallengeData) -> int:
        """Неверный код: оставшиеся попытки. На последней — challenge удаляется."""
        used = await self.redis.eval(_INCR_IF_EXISTS, 1, data.key)
        if int(used) < 0:
            return 0
        remaining = max(self.max_attempts - int(used), 0)
        if remaining == 0:
            await self.redis.delete(data.key)
        return remaining

    async def consume(self, data: ChallengeData) -> None:
        if not await self.redis.delete(data.key):
            raise challenge_invalid()

    async def discard(self, data: ChallengeData) -> None:
        await self.redis.delete(data.key)
