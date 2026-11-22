"""Потребители событий lessons (inbox-дедупликация в Runtime.add_consumer). Издатель проверяется по таблице
INTERNAL_API §7: события других издателей не исполняются (лог с типом и издателем)."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_lessons.domain import duels, members, pair, users
from tilhero_lessons.settings import Settings

DELETION_REQUESTED = "user.deletion.requested.v1"
PROFILE_CREATED = "user.profile.created.v1"
PROFILE_UPDATED = "user.profile.updated.v1"
# спринт 7: проекции social и итог дуэли
SOCIAL_PROFILE_UPDATED = "social.profile.updated.v1"
SOCIAL_BLOCK_CHANGED = "social.block.changed.v1"
SOCIAL_SANCTION_CHANGED = "social.sanction.changed.v1"
DUEL_FINISHED = "game.duel.finished.v1"
PRODUCERS: dict[str, str] = {
    DELETION_REQUESTED: "identity-consent", PROFILE_CREATED: "identity-consent", PROFILE_UPDATED: "identity-consent",
    SOCIAL_PROFILE_UPDATED: "social", SOCIAL_BLOCK_CHANGED: "social", SOCIAL_SANCTION_CHANGED: "social",
    DUEL_FINISHED: "gamification",
}
# совместимость: сагу и профили ведёт только identity-consent
TRUSTED_PRODUCERS = frozenset({"identity-consent"})

log = logging.getLogger("tilhero.lessons.consumers")

Clock = Callable[[], datetime]


def _trusted(env: Envelope) -> bool:
    if env.producer == PRODUCERS.get(env.event_type):
        return True
    log.warning("event from unexpected producer ignored",
                extra={"event_type": env.event_type, "producer": env.producer[:64]})
    return False


async def on_deletion_requested(session: AsyncSession, env: Envelope, *, now: datetime | None = None,
                                settings: Settings | None = None) -> None:
    """Сага удаления (TG-FR-006): сессии (и дуэли), шаги, реплики, история, очередь повторения, проекции; наборы дуэлей
    и парные комнаты обезличиваются (отчёт партнёра не трогается) → ACK user.domain.deleted.v1 (domain=lessons)."""
    if not _trusted(env):
        return
    await users.delete_user_data(session, uuid.UUID(str(env.payload["user_id"])),
                                 uuid.UUID(str(env.payload["request_id"])), causation_id=env.event_id,
                                 now=now or env.occurred_at, settings=settings)


async def on_profile_event(session: AsyncSession, env: Envelope) -> None:
    """Проекция вида профиля и возрастной полосы («липкий» детский режим — защита в глубину)."""
    if not _trusted(env):
        return
    await users.on_profile_event(session, env.event_type, dict(env.payload), env.occurred_at)


def social_handler(clock: Clock) -> Callable[[AsyncSession, Envelope], Awaitable[None]]:
    """social.profile.updated.v1 → member_id и ник; social.block.changed.v1 → проекция, блокировка отменяет
    приглашения в парный урок между учениками (обе стороны); social.sanction.changed.v1 → проекция, social_ban
    отменяет неотвеченные приглашения ученика (идущие и принятые комнаты доигрываются). Каждое — под блокировками
    затронутых учеников с проверкой «удалён?» после них (members.alive): событие об удалённом не исполняется."""

    async def handle(session: AsyncSession, env: Envelope) -> None:
        if not _trusted(env):
            return
        payload = dict(env.payload)
        if env.event_type == SOCIAL_PROFILE_UPDATED:
            await members.on_profile_updated(session, payload, env.occurred_at)
        elif env.event_type == SOCIAL_BLOCK_CHANGED:
            block = await members.on_block_changed(session, payload, env.occurred_at)
            if block is not None and block[2]:
                await pair.cancel_between(session, block[0], block[1], clock())
        elif env.event_type == SOCIAL_SANCTION_CHANGED:
            user_id = uuid.UUID(str(payload["user_id"]))
            partners = await pair.invite_partners(session, user_id)
            sanction = await members.on_sanction_changed(session, payload, env.occurred_at, partners)
            if sanction is not None and sanction[1]:
                await pair.cancel_invites_of(session, user_id, clock(), {user_id, *partners})

    return handle


def duel_handler(clock: Clock, settings: Settings) -> Callable[[AsyncSession, Envelope], Awaitable[None]]:
    """game.duel.finished.v1 (только gamification): разбор ответов открывается, незаконченные сессии закрываются."""

    async def handle(session: AsyncSession, env: Envelope) -> None:
        if not _trusted(env):
            return
        await duels.on_duel_finished(session, dict(env.payload), clock(), settings)

    return handle
