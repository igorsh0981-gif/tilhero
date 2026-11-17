"""Потребители событий support (inbox и outbox — в одной транзакции, см. Runtime.add_consumer)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_support.domain.events import DELETION_REQUESTED
from tilhero_support.domain.tickets import anonymize_user

CONSUMER_USER_DELETED = "support.user_deleted"


def make_on_user_deleted(producer: str) -> Callable[[AsyncSession, Envelope], Awaitable[None]]:
    async def on_user_deleted(session: AsyncSession, env: Envelope) -> None:
        """user.deletion.requested.v1 → обезличивание → ACK user.domain.deleted.v1 (support, anonymized)."""
        payload = env.payload
        await anonymize_user(
            session, user_id=str(payload["user_id"]), request_id=str(payload["request_id"]), producer=producer
        )

    return on_user_deleted


__all__ = ["CONSUMER_USER_DELETED", "DELETION_REQUESTED", "make_on_user_deleted"]
