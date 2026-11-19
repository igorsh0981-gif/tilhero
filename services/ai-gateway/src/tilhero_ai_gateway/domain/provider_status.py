"""Последняя ошибка провайдера для `GET /admin/v1/ai/provider` — только код и время (без тела ответа и ключа).
Общая для реплик через Redis; без Redis — в памяти процесса."""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import RedisError

from tilhero_ai_gateway.domain.common import iso_z

log = logging.getLogger("tilhero.ai_gateway.provider")


class ProviderStatus:
    def __init__(self, redis: Redis | None, namespace: str) -> None:
        self.redis = redis
        self.key = f"{namespace}:provider:last_error"
        self._memory: dict[str, Any] | None = None

    async def record_error(self, code: str, at: datetime) -> None:
        value = {"code": code[:64], "at": iso_z(at)}
        self._memory = value
        if self.redis is not None:
            try:
                await self.redis.set(self.key, json.dumps(value), ex=30 * 24 * 3600)
            except RedisError:
                log.warning("provider status store unavailable")

    async def last_error(self) -> dict[str, Any] | None:
        if self.redis is not None:
            try:
                raw = await self.redis.get(self.key)
                if raw:
                    data = json.loads(raw)
                    if isinstance(data, dict) and isinstance(data.get("code"), str):
                        return {"code": data["code"], "at": data.get("at")}
                return self._memory
            except (RedisError, ValueError):
                log.warning("provider status store unavailable")
        return self._memory
