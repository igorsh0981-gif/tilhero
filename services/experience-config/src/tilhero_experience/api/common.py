"""Общие зависимости API: проверка приложения, кэш, Idempotency-Key для staff-команд."""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Path
from fastapi.responses import JSONResponse
from redis.exceptions import RedisError

from tilhero_common.app import Runtime
from tilhero_common.errors import not_found
from tilhero_common.redis_tools import IdempotencyStore, fingerprint
from tilhero_experience.domain.cache import ConfigCache
from tilhero_experience.domain.payload import APPS
from tilhero_experience.settings import Settings

log = logging.getLogger("tilhero.experience.api")


def app_param(app: str = Path(max_length=16, description="miniapp | admin")) -> str:
    if app not in APPS:
        raise not_found("EXPERIENCE_APP_UNKNOWN", "Неизвестное приложение")
    return app


def cache_of(rt: Runtime) -> ConfigCache:
    s: Settings = rt.settings  # type: ignore[assignment]
    return ConfigCache(rt.redis, s.cache_namespace, s.cache_ttl_seconds)


def dumps(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


async def idempotent(rt: Runtime, *, scope: str, key: str | None, request: Any,
                     run: Callable[[], Awaitable[tuple[int, dict[str, Any]]]]) -> JSONResponse:
    """Повтор команды с тем же Idempotency-Key и телом возвращает сохранённый ответ (без повторного отката/
    публикации при двойном клике). Без ключа или без Redis команда просто выполняется."""
    store = None
    fp = fingerprint(request)
    if key is not None and rt.redis is not None:
        s: Settings = rt.settings  # type: ignore[assignment]
        store = IdempotencyStore(rt.redis, f"{s.cache_namespace}:idem")
        try:
            replay = await store.begin(scope, key, fp)
        except RedisError:
            log.warning("idempotency store unavailable, executing without it", exc_info=True)
            store, replay = None, None
        if replay is not None:
            return JSONResponse(replay["body"], status_code=replay["status"],
                                headers={"idempotent-replay": "true"})
    try:
        status, body = await run()
    except BaseException:
        if store is not None:
            try:
                await store.abort(scope, key)  # type: ignore[arg-type]
            except RedisError:
                log.warning("idempotency abort failed", exc_info=True)
        raise
    if store is not None:
        try:
            await store.complete(scope, key, fp, {"status": status, "body": body})  # type: ignore[arg-type]
        except RedisError:
            log.warning("idempotency complete failed", exc_info=True)
    return JSONResponse(body, status_code=status)
