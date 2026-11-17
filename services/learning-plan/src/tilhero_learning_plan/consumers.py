"""Потребители событий learning-plan (inbox-дедупликация в Runtime.add_consumer).

Проекция is_minor/age_band не ведётся: в payload событий learning-plan этих полей нет (схемы learning.*),
адресацию и правила для детей применяет notifications по DeliveryInfo.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_learning_plan.domain.plans import delete_user_data

DELETION_REQUESTED = "user.deletion.requested.v1"
PRODUCER = "learning-plan"


async def on_deletion_requested(session: AsyncSession, env: Envelope) -> None:
    """Сага удаления (TG-FR-006): план, занятия и отметки удаляются физически → ACK user.domain.deleted.v1.
    Повтор саги (тот же request_id, новый event_id) снова подтверждается."""
    await delete_user_data(
        session,
        uuid.UUID(str(env.payload["user_id"])),
        uuid.UUID(str(env.payload["request_id"])),
        causation_id=env.event_id,
        producer=PRODUCER,
    )
