"""Потребители событий billing (INTERNAL_API §1.11, §1.16, §6): inbox-дедупликация по event_id в Runtime.add_consumer,
издатель проверяется — события чужих издателей не исполняются. Изменения и последствия (outbox) — в одной транзакции
с отметкой inbox; блокировка аккаунта — внутри обработчика, «удалён?» — после неё."""

from __future__ import annotations

import logging
import uuid
from typing import Final

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing.domain import account, learners, periods, saga
from tilhero_billing.domain.common import is_deleted, lock_account, lock_order, now_of, parse_ts, recon_item
from tilhero_billing.models import Order
from tilhero_common.app import Runtime
from tilhero_common.messaging import Envelope

log = logging.getLogger("tilhero.billing.consumers")

PROFILE_CREATED: Final = "user.profile.created.v1"
PROFILE_UPDATED: Final = "user.profile.updated.v1"
DELETION_REQUESTED: Final = "user.deletion.requested.v1"
LESSON_COMPLETED: Final = "lesson.session.completed.v1"
PAIR_COMPLETED: Final = "lesson.pair.completed.v1"
TIL_CREDITED: Final = "game.til_pack.credited.v1"
TIL_REVERSED: Final = "game.til_pack.reversed.v1"

PRODUCERS: Final = {
    PROFILE_CREATED: "identity-consent", PROFILE_UPDATED: "identity-consent", DELETION_REQUESTED: "identity-consent",
    LESSON_COMPLETED: "lessons", PAIR_COMPLETED: "lessons", TIL_CREDITED: "gamification",
    TIL_REVERSED: "gamification",
}


def trusted(env: Envelope) -> bool:
    if PRODUCERS.get(env.event_type) == env.producer:
        return True
    log.warning("event from unexpected producer ignored",
                extra={"event_type": env.event_type, "producer": env.producer[:64]})
    return False


def _uuid(value: object) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


async def on_til_credited(session: AsyncSession, payload: dict[str, object], rt: Runtime) -> None:
    """Тилы зачислены → заказ paid → fulfilled; получатель удалён (user_deleted) — пункт сверки, возврат сотрудником."""
    order_id = _uuid(payload.get("order_id"))
    order = await session.get(Order, order_id) if order_id else None
    if order is None:
        return
    if order.account_id is not None:
        await lock_account(session, order.account_id)
    await lock_order(session, order.order_id)
    order = await session.get(Order, order.order_id, with_for_update=True, populate_existing=True)
    assert order is not None
    now = now_of(rt)
    if payload.get("outcome") == "user_deleted":
        await recon_item(session, "paid_after_deletion", f"til_user_deleted:{order.order_id}", at=now,
                         provider=order.provider, order_id=order.order_id, details={"reason": "beneficiary_deleted"})
        return
    if order.status == "paid" and order.product_kind == "til_pack":
        order.status, order.fulfilled_at = "fulfilled", parse_ts(payload.get("credited_at"), now) or now


async def on_til_reversed(session: AsyncSession, payload: dict[str, object], rt: Runtime) -> None:
    """Обратная запись тилов после возврата: потрачены — пункт сверки tils_spent_on_refund."""
    order_id = _uuid(payload.get("order_id"))
    if order_id is None or payload.get("outcome") != "tils_spent":
        return
    provider = await session.scalar(select(Order.provider).where(Order.order_id == order_id))
    await recon_item(session, "tils_spent_on_refund", f"tils_spent_on_refund:{order_id}", at=now_of(rt),
                     provider=provider, order_id=order_id, details={"source": "gamification"})


def register(rt: Runtime) -> None:
    async def on_created(session: AsyncSession, env: Envelope) -> None:
        if not trusted(env):
            return
        row = await learners.on_profile_created(session, dict(env.payload), env.occurred_at, now_of(rt))
        if row is not None and row.kind == "child" and not await is_deleted(session, row.account_id):
            # новому детскому профилю — тариф аккаунта
            await periods.emit_access(session, row.account_id, now_of(rt), only=row.user_id,
                                      causation_id=env.event_id)

    async def on_updated(session: AsyncSession, env: Envelope) -> None:
        if trusted(env):
            await learners.on_profile_updated(session, dict(env.payload), env.occurred_at, now_of(rt))

    async def on_deletion(session: AsyncSession, env: Envelope) -> None:
        if not trusted(env):
            return
        user = uuid.UUID(str(env.payload["user_id"]))
        stars_error = await saga.cancel_stars_before(rt, user)
        await saga.delete_user_data(session, user, uuid.UUID(str(env.payload["request_id"])), now_of(rt),
                                    stars_error=stars_error, causation_id=env.event_id)

    async def on_lesson(session: AsyncSession, env: Envelope) -> None:
        """Урок / сценарий с удержанием → списание ⌈ИИ-секунды/60⌉ (billable_minutes) один раз."""
        if not trusted(env):
            return
        hold_id = _uuid(env.payload.get("billing_hold_id"))
        if hold_id is None:
            return
        billable = env.payload.get("billable_minutes")
        await account.settle_event(session, hold_id, int(billable) if isinstance(billable, int) else 0,
                                   now_of(rt), causation_id=env.event_id)

    async def on_pair(session: AsyncSession, env: Envelope) -> None:
        """Урок вдвоём: минуты у пригласившего один раз за комнату (billing.hold_id)."""
        if not trusted(env):
            return
        billing = env.payload.get("billing")
        if not isinstance(billing, dict):
            return
        hold_id = _uuid(billing.get("hold_id"))
        if hold_id is None:
            return
        billable = billing.get("billable_minutes")
        await account.settle_event(session, hold_id, int(billable) if isinstance(billable, int) else 0,
                                   now_of(rt), causation_id=env.event_id)

    async def on_credited(session: AsyncSession, env: Envelope) -> None:
        if trusted(env):
            await on_til_credited(session, dict(env.payload), rt)

    async def on_reversed(session: AsyncSession, env: Envelope) -> None:
        if trusted(env):
            await on_til_reversed(session, dict(env.payload), rt)

    rt.add_consumer("billing.profiles", [PROFILE_CREATED], on_created)
    rt.add_consumer("billing.profiles_updated", [PROFILE_UPDATED], on_updated)
    rt.add_consumer("billing.user_deletion", [DELETION_REQUESTED], on_deletion)
    rt.add_consumer("billing.lessons", [LESSON_COMPLETED], on_lesson)
    rt.add_consumer("billing.pairs", [PAIR_COMPLETED], on_pair)
    rt.add_consumer("billing.til_credited", [TIL_CREDITED], on_credited)
    rt.add_consumer("billing.til_reversed", [TIL_REVERSED], on_reversed)
