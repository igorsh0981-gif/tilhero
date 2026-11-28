"""Потребители событий gamification (§1.2; спринт 7 — §2.1, §2.3, §2.4; спринт 8 — §6 пакеты тилов): inbox-дедупликация
по event_id в Runtime.add_consumer, издатель проверяется — события чужих издателей не исполняются. Всё в одной
транзакции с inbox и outbox."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Final, cast

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.messaging import Envelope
from tilhero_gamification.domain import earning, projections, saga, social_rewards, til_packs
from tilhero_gamification.settings import Settings

LESSON_COMPLETED: Final = "lesson.session.completed.v1"
REVIEW_COMPLETED: Final = "memory.review.completed.v1"
SKILLS_CHANGED: Final = "skills.state.changed.v1"
PROFILE_CREATED: Final = "user.profile.created.v1"
INVITE_ACCEPTED: Final = "social.invite.accepted.v1"
SESSION_MISSED: Final = "learning.session.missed.v1"
ACTIVITY_RECORDED: Final = "learning.activity.recorded.v1"
PLAN_UPDATED: Final = "learning.plan.updated.v1"
DELETION_REQUESTED: Final = "user.deletion.requested.v1"
# спринт 7
COMMUNITY_UPDATED: Final = "social.profile.updated.v1"
FRIENDSHIP_CHANGED: Final = "social.friendship.changed.v1"
BLOCK_CHANGED: Final = "social.block.changed.v1"
FAMILY_ADDED: Final = "social.family.member_added.v1"
SANCTION_CHANGED: Final = "social.sanction.changed.v1"
DIAGNOSTICS_COMPLETED: Final = "diagnostics.completed.v1"
REFERRAL_QUALIFIED: Final = "social.referral.qualified.v1"
PAIR_COMPLETED: Final = "lesson.pair.completed.v1"
IDENTITY_UPDATED: Final = "user.profile.updated.v1"
# спринт 8: пакеты тилов за деньги — только от billing (любой канал: Mini App за Stars и сайт)
ORDER_PAID: Final = "billing.order.paid.v1"
ORDER_REFUNDED: Final = "billing.order.refunded.v1"

PRODUCERS: Final = {
    LESSON_COMPLETED: "lessons", REVIEW_COMPLETED: "memory", SKILLS_CHANGED: "diagnostics",
    PROFILE_CREATED: "identity-consent", INVITE_ACCEPTED: "social", SESSION_MISSED: "learning-plan",
    ACTIVITY_RECORDED: "learning-plan", PLAN_UPDATED: "learning-plan", DELETION_REQUESTED: "identity-consent",
    COMMUNITY_UPDATED: "social", FRIENDSHIP_CHANGED: "social", BLOCK_CHANGED: "social", FAMILY_ADDED: "social",
    SANCTION_CHANGED: "social", DIAGNOSTICS_COMPLETED: "diagnostics", REFERRAL_QUALIFIED: "social",
    PAIR_COMPLETED: "lessons", IDENTITY_UPDATED: "identity-consent",
    ORDER_PAID: "billing", ORDER_REFUNDED: "billing",
}

log = logging.getLogger("tilhero.gamification.consumers")

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

    async def on_lesson(session: AsyncSession, env: Envelope) -> None:
        """Урок, сценарий, медиа, чтение → XP и тилы; задания, значки. kind duel — счёт дуэли."""
        if trusted(env):
            await earning.on_lesson(session, settings(), now_of(rt), dict(env.payload), env.event_id)

    async def on_review(session: AsyncSession, env: Envelope) -> None:
        """Повторение дня → XP и тилы, счётчик карточек, задание review_cards."""
        if trusted(env):
            await earning.on_review(session, settings(), now_of(rt), dict(env.payload), env.event_id)

    async def on_skills(session: AsyncSession, env: Envelope) -> None:
        """Навыки → награды, проекция, ступень героя, значки."""
        if trusted(env):
            await earning.on_skills(session, settings(), now_of(rt), dict(env.payload), env.event_id)

    async def on_profile(session: AsyncSession, env: Envelope) -> None:
        """Регистрация профиля (и детского) → ученик и бонус заморозок."""
        if trusted(env):
            await earning.on_profile_created(session, settings(), now_of(rt), dict(env.payload), env.event_id)

    async def on_invite(session: AsyncSession, env: Envelope) -> None:
        """Со спринта 7 — без действий (рефералы награждает social.referral.qualified.v1)."""
        if trusted(env):
            await earning.on_invite_accepted(session, now_of(rt), dict(env.payload))

    async def on_missed(session: AsyncSession, env: Envelope) -> None:
        """Пропуск дня графика → заморозка (если включена и есть в запасе)."""
        if trusted(env):
            await earning.on_session_missed(session, settings(), now_of(rt), dict(env.payload), env.event_id)

    async def on_activity(session: AsyncSession, env: Envelope) -> None:
        """Серия после занятия → значки серии."""
        if trusted(env):
            await earning.on_activity(session, settings(), now_of(rt), dict(env.payload), env.event_id)

    async def on_plan(session: AsyncSession, env: Envelope) -> None:
        """Часовой пояс ученика."""
        if trusted(env):
            await earning.on_plan_updated(session, dict(env.payload), env.occurred_at, now_of(rt))

    async def on_deletion(session: AsyncSession, env: Envelope) -> None:
        """Сага удаления → ACK user.domain.deleted.v1 {domain: gamification}."""
        if trusted(env):
            await saga.delete_user_data(session, uuid.UUID(str(env.payload["user_id"])),
                                        uuid.UUID(str(env.payload["request_id"])), now_of(rt),
                                        causation_id=env.event_id)

    async def on_community(session: AsyncSession, env: Envelope) -> None:
        """Профиль сообщества → проекция member_id, ника и скрытия."""
        if trusted(env):
            await projections.on_profile(session, settings(), dict(env.payload), now_of(rt))

    async def on_friendship(session: AsyncSession, env: Envelope) -> None:
        if trusted(env):
            await projections.on_friendship(session, dict(env.payload), now_of(rt))

    async def on_block(session: AsyncSession, env: Envelope) -> None:
        """Блокировка → проекция; вызовы на дуэль между учениками отменяются."""
        if trusted(env):
            await projections.on_block(session, dict(env.payload), now_of(rt))

    async def on_family(session: AsyncSession, env: Envelope) -> None:
        if trusted(env):
            await projections.on_family(session, dict(env.payload), now_of(rt))

    async def on_sanction(session: AsyncSession, env: Envelope) -> None:
        if trusted(env):
            await projections.on_sanction(session, dict(env.payload), now_of(rt))

    async def on_diagnostics(session: AsyncSession, env: Envelope) -> None:
        """Диагностика → полоса уровня лиги и дуэли."""
        if trusted(env):
            await projections.on_diagnostics(session, dict(env.payload), now_of(rt))

    async def on_referral(session: AsyncSession, env: Envelope) -> None:
        """Реферал квалифицирован → награды обеим сторонам → ack game.referral.rewarded.v1."""
        if trusted(env):
            await social_rewards.on_referral_qualified(session, settings(), now_of(rt), dict(env.payload),
                                                       env.event_id)

    async def on_pair(session: AsyncSession, env: Envelope) -> None:
        """Парный урок завершён → XP за вклад, значок together_1."""
        if trusted(env):
            await social_rewards.on_pair_completed(session, settings(), now_of(rt), dict(env.payload), env.event_id)

    async def on_identity(session: AsyncSession, env: Envelope) -> None:
        """Возраст и согласие родителя на социальное (14–17) → доступ к общей лиге."""
        if trusted(env):
            await projections.on_identity_profile(session, dict(env.payload), env.occurred_at, now_of(rt))

    async def on_billing(session: AsyncSession, env: Envelope) -> None:
        """Пакет тилов оплачен → начисление (purchase) и подтверждение; возвращён → обратная запись или tils_spent.
        Оба типа — одним потребителем: порядок «оплата → возврат» по одному заказу сохраняется."""
        if not trusted(env):
            return
        if env.event_type == ORDER_PAID:
            await til_packs.on_order_paid(session, settings(), now_of(rt), dict(env.payload), env.event_id)
        else:
            await til_packs.on_order_refunded(session, settings(), now_of(rt), dict(env.payload), env.event_id)

    rt.add_consumer("gamification.lessons", [LESSON_COMPLETED], on_lesson)
    rt.add_consumer("gamification.reviews", [REVIEW_COMPLETED], on_review)
    rt.add_consumer("gamification.skills", [SKILLS_CHANGED], on_skills)
    rt.add_consumer("gamification.profiles", [PROFILE_CREATED], on_profile)
    rt.add_consumer("gamification.invites", [INVITE_ACCEPTED], on_invite)
    rt.add_consumer("gamification.missed", [SESSION_MISSED], on_missed)
    rt.add_consumer("gamification.activity", [ACTIVITY_RECORDED], on_activity)
    rt.add_consumer("gamification.plans", [PLAN_UPDATED], on_plan)
    rt.add_consumer("gamification.user_deletion", [DELETION_REQUESTED], on_deletion)
    rt.add_consumer("gamification.community", [COMMUNITY_UPDATED], on_community)
    rt.add_consumer("gamification.friends", [FRIENDSHIP_CHANGED], on_friendship)
    rt.add_consumer("gamification.blocks", [BLOCK_CHANGED], on_block)
    rt.add_consumer("gamification.families", [FAMILY_ADDED], on_family)
    rt.add_consumer("gamification.sanctions", [SANCTION_CHANGED], on_sanction)
    rt.add_consumer("gamification.levels", [DIAGNOSTICS_COMPLETED], on_diagnostics)
    rt.add_consumer("gamification.referrals", [REFERRAL_QUALIFIED], on_referral)
    rt.add_consumer("gamification.pairs", [PAIR_COMPLETED], on_pair)
    rt.add_consumer("gamification.identity", [IDENTITY_UPDATED], on_identity)
    rt.add_consumer("gamification.billing", [ORDER_PAID, ORDER_REFUNDED], on_billing)
