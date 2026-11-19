"""Потребители событий assessment (inbox-дедупликация в Runtime.add_consumer)."""

from __future__ import annotations

import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_assessment.domain import users
from tilhero_assessment.domain.common import DELETION_REQUESTED
from tilhero_common.messaging import Envelope

__all__ = ["DELETION_REQUESTED", "on_deletion_requested"]

# Сагу удаления ведёт только identity-consent: события других издателей не исполняются
TRUSTED_PRODUCERS = frozenset({"identity-consent"})

log = logging.getLogger("tilhero.assessment.consumers")


async def on_deletion_requested(session: AsyncSession, env: Envelope) -> None:
    """Сага удаления (TG-FR-006): оценки, апелляции и QA-флаги ученика удаляются физически →
    ACK `user.domain.deleted.v1 {domain: assessment, mode: deleted}`. Повтор саги снова подтверждается."""
    if env.producer not in TRUSTED_PRODUCERS:
        log.warning("event from unexpected producer ignored",
                    extra={"event_type": env.event_type, "producer": env.producer[:64]})
        return
    await users.delete_user_data(session, uuid.UUID(str(env.payload["user_id"])),
                                 uuid.UUID(str(env.payload["request_id"])), causation_id=env.event_id)
