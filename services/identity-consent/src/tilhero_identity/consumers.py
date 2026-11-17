"""Потребители событий identity-consent (inbox-дедупликация — в Runtime.add_consumer)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.messaging import Envelope
from tilhero_identity.service import EV_DOMAIN_DELETED, IdentityService

DELETION_ACKS = "identity-consent.deletion_acks"


def deletion_ack_handler(runtime: Runtime) -> Callable[[AsyncSession, Envelope], Awaitable[None]]:
    async def handle(session: AsyncSession, env: Envelope) -> None:
        await IdentityService(runtime).on_domain_deleted(session, env)

    return handle


def configure(runtime: Runtime) -> None:
    runtime.add_consumer(DELETION_ACKS, [EV_DOMAIN_DELETED], deletion_ack_handler(runtime))
