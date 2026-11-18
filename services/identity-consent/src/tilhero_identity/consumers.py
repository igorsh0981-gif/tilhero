"""Потребители событий identity-consent (inbox-дедупликация — в Runtime.add_consumer)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.messaging import Envelope
from tilhero_identity import activity
from tilhero_identity.service import EV_DOMAIN_DELETED, IdentityService

DELETION_ACKS = "identity-consent.deletion_acks"
LEARNER_ACTIVITY = activity.CONSUMER


def deletion_ack_handler(runtime: Runtime) -> Callable[[AsyncSession, Envelope], Awaitable[None]]:
    async def handle(session: AsyncSession, env: Envelope) -> None:
        svc = IdentityService(runtime)
        await svc.on_domain_deleted(session, env)
        await svc.stamp_versions(session)  # обезличивание: версия снимка не раньше событий (ревью P2-3)

    return handle


def configure(runtime: Runtime) -> None:
    runtime.add_consumer(DELETION_ACKS, [EV_DOMAIN_DELETED], deletion_ack_handler(runtime))
    # Проекция learner_activity для аудитории рассылок (онбординг, последнее занятие) — activity.py
    runtime.add_consumer(LEARNER_ACTIVITY, list(activity.EVENT_TYPES), activity.on_learning_event)
