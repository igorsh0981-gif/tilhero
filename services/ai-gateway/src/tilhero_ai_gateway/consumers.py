"""Потребители событий ai-gateway (inbox и outbox — в одной транзакции, см. Runtime.add_consumer)."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import cast

from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_ai_gateway.api.common import InvokeCache, now_of
from tilhero_ai_gateway.domain import tiers, unit_costs
from tilhero_ai_gateway.domain.common import DELETION_REQUESTED
from tilhero_ai_gateway.domain.users import anonymize_user
from tilhero_ai_gateway.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.messaging import Envelope

CONSUMER_USER_DELETED = "ai-gateway.user_deleted"
# Сагу удаления ведёт только identity-consent: запрос от другого издателя не исполняется (защита в глубину)
DELETION_PRODUCERS = frozenset({"identity-consent"})
# Спринт 8 (INTERNAL_API §7): тариф ученика — только от billing; стоимость занятий — только от lessons
CONSUMER_TIERS = "ai-gateway.learner_tiers"
CONSUMER_SESSION_COSTS = "ai-gateway.session_costs"
TIER_EVENTS = (tiers.EVENT,)
SESSION_EVENTS = (unit_costs.SESSION_COMPLETED, unit_costs.PAIR_COMPLETED)

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


def tiers_handler(runtime: Runtime) -> Handler:
    async def on_access_changed(session: AsyncSession, env: Envelope) -> None:
        """billing.access.changed.v1 → learner_tiers (дневной лимит по тарифу, уровень paid_only)."""
        if env.producer not in tiers.PRODUCERS:
            log.warning("access change from unexpected producer ignored",
                        extra={"event_type": env.event_type, "producer": env.producer[:64]})
            return
        await tiers.apply_access(session, env.payload, now_of(runtime))

    return on_access_changed


def session_costs_handler(runtime: Runtime) -> Handler:
    async def on_completed(session: AsyncSession, env: Envelope) -> None:
        """lesson.session.completed.v1 (lesson | scenario), lesson.pair.completed.v1 → session_costs."""
        if env.producer not in unit_costs.PRODUCERS:
            log.warning("session completion from unexpected producer ignored",
                        extra={"event_type": env.event_type, "producer": env.producer[:64]})
            return
        if env.event_type == unit_costs.PAIR_COMPLETED:
            await unit_costs.on_pair_completed(session, env.payload)
        else:
            await unit_costs.on_session_completed(session, env.payload)

    return on_completed


def configure(rt: Runtime) -> None:
    rt.add_consumer(CONSUMER_USER_DELETED, [DELETION_REQUESTED], deletion_handler(rt))
    rt.add_consumer(CONSUMER_TIERS, list(TIER_EVENTS), tiers_handler(rt))
    rt.add_consumer(CONSUMER_SESSION_COSTS, list(SESSION_EVENTS), session_costs_handler(rt))


__all__ = ["CONSUMER_SESSION_COSTS", "CONSUMER_TIERS", "CONSUMER_USER_DELETED", "DELETION_REQUESTED", "configure",
           "deletion_handler", "session_costs_handler", "tiers_handler"]
