"""Кэш текущей конфигурации в Redis (TTL 60 с).

Значение хранится как "<seq активации>|<json>" и записывается Lua-скриптом «только если новее»:
  * читатель после промаха кладёт то, что прочитал из БД;
  * публикация/откат после commit кладёт свою, более новую активацию.
Порядок записей не важен — в кэше всегда остаётся самая новая из известных активаций, поэтому ни запоздавший
читатель, ни запоздавшая параллельная публикация не вернут устаревшую тему (инвалидация без гонок).
Недоступность Redis не ломает чтение — сервис отвечает из БД.
"""

from __future__ import annotations

import logging

from redis.asyncio import Redis

log = logging.getLogger("tilhero.experience.cache")

_PUT_IF_NEWER = """
local cur = redis.call('GET', KEYS[1])
if cur then
  local seq = tonumber(string.match(cur, '^(%d+)|'))
  if seq and seq >= tonumber(ARGV[1]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1] .. '|' .. ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
"""


class ConfigCache:
    def __init__(self, redis: Redis | None, namespace: str, ttl_seconds: int) -> None:
        self.redis = redis
        self.namespace = namespace
        self.ttl = ttl_seconds

    def key(self, app: str) -> str:
        return f"{self.namespace}:current:{app}"

    async def get(self, app: str) -> str | None:
        """JSON текущей конфигурации или None (промах / Redis недоступен / повреждённое значение)."""
        if self.redis is None:
            return None
        try:
            raw = await self.redis.get(self.key(app))
        except Exception:
            log.warning("config cache read failed", exc_info=True)
            return None
        if raw is None:
            return None
        text = raw.decode() if isinstance(raw, bytes) else str(raw)
        seq, sep, body = text.partition("|")
        return body if sep and seq.isdigit() and body.startswith("{") else None

    async def put(self, app: str, seq: int, body: str) -> bool:
        """Записать конфигурацию активации seq, если в кэше нет более новой. True — записано."""
        if self.redis is None:
            return False
        try:
            return bool(await self.redis.eval(_PUT_IF_NEWER, 1, self.key(app), str(seq), body, str(self.ttl)))
        except Exception:
            log.error("config cache write failed", exc_info=True)
            await self.invalidate(app)
            return False

    async def invalidate(self, app: str) -> None:
        if self.redis is None:
            return
        try:
            await self.redis.delete(self.key(app))
        except Exception:
            # Ключ живёт не дольше TTL (60 с) — устаревшая тема максимум на минуту.
            log.error("config cache invalidation failed", exc_info=True)
