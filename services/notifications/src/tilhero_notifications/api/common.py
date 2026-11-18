"""Общее для staff API notifications: вызывающий — только admin-bff с контекстом сотрудника (actor), права
проверяются здесь же (защита в глубину); Idempotency-Key команд-переходов — Redis (повтор → сохранённый ответ)."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any, cast

from fastapi import Header
from fastapi.responses import JSONResponse
from redis.exceptions import RedisError

from tilhero_common.app import Runtime
from tilhero_common.errors import forbidden
from tilhero_common.internal_auth import Actor, InternalAuth, Principal
from tilhero_common.redis_tools import IdempotencyStore, fingerprint
from tilhero_notifications.settings import Settings

log = logging.getLogger("tilhero.notifications.staff")
staff = InternalAuth({"admin-bff"})

IDEMPOTENCY_PATTERN = r"^[A-Za-z0-9_\-:.]+$"
IdempotencyKey = Header(
    default=None, alias="Idempotency-Key", min_length=8, max_length=128, pattern=IDEMPOTENCY_PATTERN
)


def require_any(principal: Principal, *permissions: str) -> Actor:
    """Хотя бы одно из прав (первое — в details отказа)."""
    actor = principal.actor
    if actor is None:
        raise forbidden("STAFF_CONTEXT_REQUIRED", "Команда доступна только сотрудникам")
    if not set(permissions) & actor.permissions:
        raise forbidden("PERMISSION_DENIED", "Недостаточно прав", {"permission": permissions[0]})
    return actor


async def idempotent(
    rt: Runtime,
    *,
    scope: str,
    key: str | None,
    request: Any,
    run: Callable[[], Awaitable[tuple[int, dict[str, Any]]]],
) -> JSONResponse:
    """Повтор команды с тем же Idempotency-Key и телом — сохранённый ответ (заголовок Idempotent-Replayed);
    тот же ключ с другим телом — 422 IDEMPOTENCY_KEY_REUSED. Без ключа или без Redis — просто выполняется."""
    store = None
    fp = fingerprint(request)
    if key is not None and rt.redis is not None:
        s = cast(Settings, rt.settings)
        store = IdempotencyStore(rt.redis, f"{s.redis_key_prefix}:idem")
        try:
            replay = await store.begin(scope, key, fp)
        except RedisError:
            log.warning("idempotency store unavailable, executing without it")
            store, replay = None, None
        if replay is not None:
            return JSONResponse(replay["body"], status_code=replay["status"], headers={"Idempotent-Replayed": "true"})
    try:
        status, body = await run()
    except BaseException:
        if store is not None and key is not None:
            try:
                await store.abort(scope, key)
            except RedisError:
                log.warning("idempotency abort failed")
        raise
    if store is not None and key is not None:
        try:
            await store.complete(scope, key, fp, {"status": status, "body": body})
        except RedisError:
            log.warning("idempotency complete failed")
    return JSONResponse(body, status_code=status)
