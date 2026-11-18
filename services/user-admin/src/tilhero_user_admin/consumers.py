"""Потребитель событий read-модели (inbox-дедупликация и транзакция — в Runtime.add_consumer)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_user_admin.domain.projection import EVENT_TYPES, apply_event
from tilhero_user_admin.domain.sync import Reconciler

CONSUMER = "user-admin.projection"
__all__ = ["CONSUMER", "EVENT_TYPES", "make_handler"]


def make_handler(reconciler: Reconciler | None) -> Callable[[AsyncSession, Envelope], Awaitable[None]]:
    async def handle(session: AsyncSession, env: Envelope) -> None:
        result = await apply_event(session, env)
        if reconciler is None:
            return
        # данных нет в событии: имя/username — в identity-consent, уровень/пресет — в learning-plan
        if result.wake_identity:
            reconciler.identity.wake()
        if result.wake_plans:
            reconciler.plans.wake()

    return handle
