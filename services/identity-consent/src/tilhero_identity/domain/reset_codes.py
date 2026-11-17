"""Одноразовые коды сброса кода родителя (PIN): код присылает бот в Telegram-чат аккаунта.

- код из `secrets.randbelow`, а не `random`;
- хранится только HMAC-SHA256 с секретом сервиса (ключ выводится из INTERNAL_JWT_SECRET с разделением доменов)
  и привязкой к user_id — перебор 10^6 вариантов по утёкшему дампу Redis без секрета невозможен;
- сравнение за постоянное время; попытки считаются атомарно (Lua) ДО сравнения — параллельные запросы
  не дают лишних попыток; код одноразовый (DEL с проверкой результата);
- частота: не чаще 1 раза в N секунд и не более M раз в сутки.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass

from redis.asyncio import Redis

from tilhero_common.errors import ApiError

_CONSUME_LUA = """
local h = redis.call('HGET', KEYS[1], 'h')
if not h then return false end
local a = redis.call('HINCRBY', KEYS[1], 'a', 1)
return {h, a}
"""

DAY_SECONDS = 24 * 3600


@dataclass(frozen=True)
class ConsumeResult:
    ok: bool
    expired: bool = False
    remaining: int = 0


def too_often(retry_after: int) -> ApiError:
    return ApiError(429, "PIN_RESET_TOO_OFTEN", "Код уже отправлен. Повторить можно позже",
                    {"retry_after": max(int(retry_after), 1)})


class ResetCodeStore:
    def __init__(
        self,
        redis: Redis,
        secret: str,
        *,
        ttl_seconds: int = 600,
        max_attempts: int = 5,
        min_interval_seconds: int = 60,
        daily_limit: int = 5,
    ) -> None:
        self.redis = redis
        self._key = hmac.new(
            secret.encode("utf-8"), b"tilhero:identity:pin-reset-code:v1", hashlib.sha256
        ).digest()
        self.ttl = ttl_seconds
        self.max_attempts = max_attempts
        self.min_interval = min_interval_seconds
        self.daily_limit = daily_limit
        self._consume = redis.register_script(_CONSUME_LUA)

    @staticmethod
    def code_key(user_id: uuid.UUID) -> str:
        return f"pin_reset:code:{user_id}"

    @staticmethod
    def cooldown_key(user_id: uuid.UUID) -> str:
        return f"pin_reset:cooldown:{user_id}"

    @staticmethod
    def daily_key(user_id: uuid.UUID) -> str:
        return f"pin_reset:daily:{user_id}"

    def mac(self, user_id: uuid.UUID, code: str) -> str:
        return hmac.new(self._key, f"{user_id}:{code}".encode(), hashlib.sha256).hexdigest()

    async def throttle(self, user_id: uuid.UUID) -> None:
        """Резервирует отправку.

        429 PIN_RESET_TOO_OFTEN — если чаще min_interval или больше daily_limit в сутки.
        """
        cooldown = self.cooldown_key(user_id)
        if not await self.redis.set(cooldown, "1", nx=True, ex=self.min_interval):
            raise too_often(await self.redis.ttl(cooldown))
        daily = self.daily_key(user_id)
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.incr(daily)
            pipe.expire(daily, DAY_SECONDS, nx=True)
            pipe.ttl(daily)
            count, _, ttl = await pipe.execute()
        if int(count) > self.daily_limit:
            raise too_often(ttl)

    async def release(self, user_id: uuid.UUID) -> None:
        """Отмена резерва throttle(): код не доставлен (notifications недоступен) — лимит не расходуется."""
        daily = self.daily_key(user_id)
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.delete(self.cooldown_key(user_id))
            pipe.decr(daily)
            _, count = await pipe.execute()
        if int(count) <= 0:
            await self.redis.delete(daily)

    async def discard(self, user_id: uuid.UUID) -> None:
        await self.redis.delete(self.code_key(user_id))

    async def issue(self, user_id: uuid.UUID) -> str:
        """Новый код заменяет предыдущий (старый перестаёт действовать), счётчик попыток обнуляется."""
        code = f"{secrets.randbelow(10**6):06d}"
        key = self.code_key(user_id)
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.delete(key)
            pipe.hset(key, mapping={"h": self.mac(user_id, code), "a": 0})
            pipe.expire(key, self.ttl)
            await pipe.execute()
        return code

    async def consume(self, user_id: uuid.UUID, code: str) -> ConsumeResult:
        key = self.code_key(user_id)
        found = await self._consume(keys=[key])
        if not found:
            return ConsumeResult(ok=False, expired=True)
        stored, attempts = str(found[0]), int(found[1])
        if attempts > self.max_attempts:
            await self.redis.delete(key)
            return ConsumeResult(ok=False, expired=True)
        if hmac.compare_digest(stored, self.mac(user_id, code)):
            # DEL возвращает 0, если код уже погашен параллельным запросом — второй раз не принимаем.
            if await self.redis.delete(key) == 0:
                return ConsumeResult(ok=False, expired=True)
            return ConsumeResult(ok=True)
        remaining = self.max_attempts - attempts
        if remaining <= 0:
            await self.redis.delete(key)
        return ConsumeResult(ok=False, remaining=max(remaining, 0))

    async def clear(self, user_id: uuid.UUID) -> None:
        await self.redis.delete(self.code_key(user_id), self.cooldown_key(user_id), self.daily_key(user_id))
