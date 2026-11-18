"""Потребитель событий read-модели (inbox-дедупликация и транзакция — в Runtime.add_consumer)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_user_admin.domain.projection import EV_PROFILE_CREATED, EVENT_TYPES, apply_event
from tilhero_user_admin.domain.sync import IdentitySync

CONSUMER = "user-admin.projection"
__all__ = ["CONSUMER", "EVENT_TYPES", "make_handler"]


def make_handler(sync: IdentitySync | None) -> Callable[[AsyncSession, Envelope], Awaitable[None]]:
    async def handle(session: AsyncSession, env: Envelope) -> None:
        applied = await apply_event(session, env)
        if applied and env.event_type == EV_PROFILE_CREATED and sync is not None:
            sync.wake()  # username/имя нового пользователя есть только в identity-consent

    return handle
