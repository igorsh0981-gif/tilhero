"""Потребители событий ai-gateway (inbox и outbox — в одной транзакции, см. Runtime.add_consumer)."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import cast

from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_ai_gateway.api.common import InvokeCache
from tilhero_ai_gateway.domain.common import DELETION_REQUESTED
from tilhero_ai_gateway.domain.users import anonymize_user
from tilhero_ai_gateway.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.messaging import Envelope

CONSUMER_USER_DELETED = "ai-gateway.user_deleted"
# Сагу удаления ведёт только identity-consent: запрос от другого издателя не исполняется (защита в глубину)
DELETION_PRODUCERS = frozenset({"identity-consent"})

log = logging.getLogger("tilhero.ai_gateway.consumers")
Handler = Callable[[AsyncSession, Envelope], Awaitable[None]]


def deletion_handler(runtime: Runtime) -> Handler:
    async def on_user_deleted(session: AsyncSession, env: Envelope) -> None:
        """user.deletion.requested.v1 → usage.user_id = NULL (вызовы агентов и оценки произношения), кеш результатов
        ученика стёрт (вызовы агентов и оценки произношения — в них эталон и слова) → ACK user.domain.deleted.v1
        (ai-gateway, anonymized). Аудио нигде не хранилось — удалять нечего."""
        if env.producer not in DELETION_PRODUCERS:
            log.warning("deletion request from unexpected producer ignored",
                        extra={"event_type": env.event_type, "producer": env.producer[:64]})
            return
        user_id = uuid.UUID(str(env.payload["user_id"]))
        await anonymize_user(session, user_id, uuid.UUID(str(env.payload["request_id"])), causation_id=env.event_id)
        if runtime.redis is not None:
            settings = cast(Settings, runtime.settings)
            for kind in InvokeCache.KINDS:
                try:
                    await InvokeCache(runtime.redis, settings.cache_namespace, settings.invoke_cache_ttl_seconds,
                                      60, kind=kind).purge_user(str(user_id))
                except RedisError:
                    log.warning("result cache purge failed (results expire within 24 h)", extra={"kind": kind})

    return on_user_deleted


__all__ = ["CONSUMER_USER_DELETED", "DELETION_REQUESTED", "deletion_handler"]
