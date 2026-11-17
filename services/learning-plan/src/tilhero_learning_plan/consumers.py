"""Потребители событий preferences (inbox-дедупликация в Runtime.add_consumer)."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_learning_plan.domain.profiles import delete_user_data

DELETION_REQUESTED = "user.deletion.requested.v1"


async def on_deletion_requested(session: AsyncSession, env: Envelope) -> None:
    """Сага удаления (TG-FR-006): удаляем профиль физически и подтверждаем user.domain.deleted.v1."""
    await delete_user_data(
        session,
        uuid.UUID(str(env.payload["user_id"])),
        uuid.UUID(str(env.payload["request_id"])),
        causation_id=env.event_id,
    )
