"""Потребители событий social (inbox-дедупликация в Runtime.add_consumer)."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_social.domain import profiles

DELETION_REQUESTED = "user.deletion.requested.v1"
PROFILE_CREATED = "user.profile.created.v1"
PROFILE_UPDATED = "user.profile.updated.v1"
PRODUCER = "social"
# Проекция профилей принимается только от владельца данных (как в audit: события чужих издателей игнорируются)
PROFILE_PRODUCERS = frozenset({"identity-consent"})
# Сагу удаления ведёт только identity-consent: запрос от другого издателя не исполняется (защита в глубину, P-7)
DELETION_PRODUCERS = frozenset({"identity-consent"})

log = logging.getLogger("tilhero.social.consumers")


async def on_deletion_requested(session: AsyncSession, env: Envelope) -> None:
    """Сага удаления → ACK user.domain.deleted.v1 (domain=social). Повтор саги снова подтверждается.
    Чужой издатель — только лог (без PII), событие подтверждается шине без действия."""
    if env.producer not in DELETION_PRODUCERS:
        log.warning("deletion request from unexpected producer ignored",
                    extra={"event_type": env.event_type, "producer": env.producer[:64]})
        return
    await profiles.delete_user_data(session, uuid.UUID(str(env.payload["user_id"])),
                                    uuid.UUID(str(env.payload["request_id"])), causation_id=env.event_id,
                                    producer=PRODUCER)


async def on_profile_event(session: AsyncSession, env: Envelope) -> None:
    if env.producer not in PROFILE_PRODUCERS:
        return
    # момент события (создание профиля), а не обработки: повторная доставка не меняет joined_at/updated_at
    now = env.occurred_at.astimezone(UTC)
    if env.event_type == PROFILE_CREATED:
        await profiles.on_profile_created(session, env.payload, now, PRODUCER)
    else:
        await profiles.on_profile_updated(session, env.payload, now)
