"""Потребители событий support (inbox и outbox — в одной транзакции, см. Runtime.add_consumer)."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_support.domain.events import DELETION_REQUESTED
from tilhero_support.domain.tickets import anonymize_user

CONSUMER_USER_DELETED = "support.user_deleted"
# Сагу удаления ведёт только identity-consent: запрос от другого издателя не исполняется (защита в глубину)
DELETION_PRODUCERS = frozenset({"identity-consent"})

log = logging.getLogger("tilhero.support.consumers")


def make_on_user_deleted(producer: str) -> Callable[[AsyncSession, Envelope], Awaitable[None]]:
    async def on_user_deleted(session: AsyncSession, env: Envelope) -> None:
        """user.deletion.requested.v1 → обезличивание → ACK user.domain.deleted.v1 (support, anonymized)."""
        if env.producer not in DELETION_PRODUCERS:
            log.warning("deletion request from unexpected producer ignored",
                        extra={"event_type": env.event_type, "producer": env.producer[:64]})
            return
        payload = env.payload
        await anonymize_user(
            session, user_id=str(payload["user_id"]), request_id=str(payload["request_id"]), producer=producer
        )

    return on_user_deleted


__all__ = ["CONSUMER_USER_DELETED", "DELETION_REQUESTED", "make_on_user_deleted"]
