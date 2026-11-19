"""Потребители событий lessons (inbox-дедупликация в Runtime.add_consumer)."""

from __future__ import annotations

import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_lessons.domain import users

DELETION_REQUESTED = "user.deletion.requested.v1"
PROFILE_CREATED = "user.profile.created.v1"
PROFILE_UPDATED = "user.profile.updated.v1"
# Сагу удаления и профили ведёт только identity-consent: события других издателей не исполняются
TRUSTED_PRODUCERS = frozenset({"identity-consent"})

log = logging.getLogger("tilhero.lessons.consumers")


def _trusted(env: Envelope) -> bool:
    if env.producer in TRUSTED_PRODUCERS:
        return True
    log.warning("event from unexpected producer ignored",
                extra={"event_type": env.event_type, "producer": env.producer[:64]})
    return False


async def on_deletion_requested(session: AsyncSession, env: Envelope) -> None:
    """Сага удаления (TG-FR-006): сессии, шаги, реплики, история, очередь повторения, проекция — удаляются
    физически → ACK user.domain.deleted.v1 (domain=lessons). Повтор саги снова подтверждается."""
    if not _trusted(env):
        return
    await users.delete_user_data(session, uuid.UUID(str(env.payload["user_id"])),
                                 uuid.UUID(str(env.payload["request_id"])), causation_id=env.event_id)


async def on_profile_event(session: AsyncSession, env: Envelope) -> None:
    """Проекция вида профиля и возрастной полосы («липкий» детский режим — защита в глубину)."""
    if not _trusted(env):
        return
    await users.on_profile_event(session, env.event_type, dict(env.payload), env.occurred_at)
