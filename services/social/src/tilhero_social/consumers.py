"""Потребители событий social (inbox-дедупликация в Runtime.add_consumer). Издатель проверяется: события чужих
издателей не исполняются (лог без user_id, событие подтверждается шине).

Спринт 7: рефералы — diagnostics.completed.v1 (diagnostics), lesson.session.completed.v1 (lessons; зачётный —
только kind lesson), game.referral.rewarded.v1 (gamification, ack наград). Время — из события (не обработки)."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Final, cast

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.messaging import Envelope
from tilhero_social.domain import family as fam
from tilhero_social.domain import members, profiles, referrals
from tilhero_social.domain.common import event_time, is_deleted
from tilhero_social.settings import Settings

DELETION_REQUESTED: Final = "user.deletion.requested.v1"
PROFILE_CREATED: Final = "user.profile.created.v1"
PROFILE_UPDATED: Final = "user.profile.updated.v1"
DIAGNOSTICS_COMPLETED: Final = "diagnostics.completed.v1"
LESSON_COMPLETED: Final = "lesson.session.completed.v1"
REFERRAL_REWARDED: Final = "game.referral.rewarded.v1"
PRODUCER: Final = "social"

# Владелец каждого события: проекция профилей и сага — только identity-consent (P-7), рефералы — свои источники
PRODUCERS: Final = {
    DELETION_REQUESTED: "identity-consent", PROFILE_CREATED: "identity-consent", PROFILE_UPDATED: "identity-consent",
    DIAGNOSTICS_COMPLETED: "diagnostics", LESSON_COMPLETED: "lessons", REFERRAL_REWARDED: "gamification",
}

log = logging.getLogger("tilhero.social.consumers")

Handler = Callable[[AsyncSession, Envelope], Awaitable[None]]


def trusted(env: Envelope) -> bool:
    if PRODUCERS.get(env.event_type) == env.producer:
        return True
    log.warning("event from unexpected producer ignored",
                extra={"event_type": env.event_type, "producer": env.producer[:64]})
    return False


def now_of(rt: Runtime) -> datetime:
    clock = getattr(rt, "clock", None)
    return clock() if callable(clock) else datetime.now(UTC)


def register(rt: Runtime) -> None:
    def settings() -> Settings:
        return cast(Settings, rt.settings)

    async def on_deletion(session: AsyncSession, env: Envelope) -> None:
        """Сага удаления → ACK user.domain.deleted.v1 (domain=social). Повтор саги снова подтверждается."""
        if trusted(env):
            await profiles.delete_user_data(session, uuid.UUID(str(env.payload["user_id"])),
                                            uuid.UUID(str(env.payload["request_id"])), causation_id=env.event_id,
                                            producer=PRODUCER)

    async def on_profile(session: AsyncSession, env: Envelope) -> None:
        if not trusted(env):
            return
        # момент события (создание профиля), а не обработки: повторная доставка не меняет joined_at/updated_at
        at = env.occurred_at.astimezone(UTC)
        if env.event_type == PROFILE_CREATED:
            await profiles.on_profile_created(session, env.payload, at, PRODUCER)
            user = uuid.UUID(str(env.payload["user_id"]))
            await fam.lock_users(session, [user])
            if not await is_deleted(session, user):
                # member_id известен social с регистрации ученика; регистрация — для «не новый ученик» (рефералы)
                await members.register(session, settings().member_key_bytes(), [user])
                await referrals.upsert_activity(session, user, now_of(rt),
                                                seen_at=event_time(env.payload.get("created_at"), at))
        else:
            await profiles.on_profile_updated(session, env.payload, at)

    async def on_diagnostic(session: AsyncSession, env: Envelope) -> None:
        if trusted(env):
            await referrals.on_diagnostic(session, dict(env.payload), now_of(rt), referrals.policy_of(settings()))

    async def on_lesson(session: AsyncSession, env: Envelope) -> None:
        if trusted(env):
            await referrals.on_lesson(session, dict(env.payload), now_of(rt), referrals.policy_of(settings()))

    async def on_rewarded(session: AsyncSession, env: Envelope) -> None:
        if trusted(env):
            await referrals.on_rewarded(session, dict(env.payload), now_of(rt))

    rt.add_consumer("social.user_deletion", [DELETION_REQUESTED], on_deletion)
    rt.add_consumer("social.profiles", [PROFILE_CREATED, PROFILE_UPDATED], on_profile)
    rt.add_consumer("social.diagnostics", [DIAGNOSTICS_COMPLETED], on_diagnostic)
    rt.add_consumer("social.lessons", [LESSON_COMPLETED], on_lesson)
    rt.add_consumer("social.referral_rewards", [REFERRAL_REWARDED], on_rewarded)
