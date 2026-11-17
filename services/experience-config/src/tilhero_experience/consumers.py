"""Потребители событий experience-config (inbox и outbox — в одной транзакции, см. Runtime.add_consumer)."""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_experience.domain.release_notes import DELETION_REQUESTED, delete_user_data

CONSUMER_USER_DELETED = "experience-config.user_deleted"
# Сагу удаления ведёт только identity-consent: запрос от другого издателя не исполняется (защита в глубину)
DELETION_PRODUCERS = frozenset({"identity-consent"})

log = logging.getLogger("tilhero.experience.consumers")


async def on_user_deleted(session: AsyncSession, env: Envelope) -> None:
    """user.deletion.requested.v1 → удалить отметки просмотра ученика → ACK user.domain.deleted.v1
    {domain: experience-config, mode: deleted}. Повтор рассылки сагой (новый event_id) снова подтверждается."""
    if env.producer not in DELETION_PRODUCERS:
        log.warning("deletion request from unexpected producer ignored",
                    extra={"event_type": env.event_type, "producer": env.producer[:64]})
        return
    await delete_user_data(session, user_id=str(env.payload["user_id"]), request_id=str(env.payload["request_id"]))


__all__ = ["CONSUMER_USER_DELETED", "DELETION_REQUESTED", "on_user_deleted"]
