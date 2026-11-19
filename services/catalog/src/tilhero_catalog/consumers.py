"""Потребители событий catalog (inbox и outbox — в одной транзакции, см. Runtime.add_consumer)."""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_catalog.domain.common import DELETION_REQUESTED
from tilhero_catalog.domain.requests import anonymize_user
from tilhero_common.messaging import Envelope

CONSUMER_USER_DELETED = "catalog.user_deleted"
# Сагу удаления ведёт только identity-consent: запрос от другого издателя не исполняется (защита в глубину)
DELETION_PRODUCERS = frozenset({"identity-consent"})

log = logging.getLogger("tilhero.catalog.consumers")


async def on_user_deleted(session: AsyncSession, env: Envelope) -> None:
    """user.deletion.requested.v1 → обезличивание заявок → ACK user.domain.deleted.v1 (catalog, anonymized)."""
    if env.producer not in DELETION_PRODUCERS:
        log.warning("deletion request from unexpected producer ignored",
                    extra={"event_type": env.event_type, "producer": env.producer[:64]})
        return
    payload = env.payload
    await anonymize_user(session, user_id=str(payload["user_id"]), request_id=str(payload["request_id"]))


__all__ = ["CONSUMER_USER_DELETED", "DELETION_REQUESTED", "on_user_deleted"]
