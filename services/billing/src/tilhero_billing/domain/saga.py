"""Сага удаления (INTERNAL_API §1.16, AT-101, В15): consumer user.deletion.requested.v1 (только identity-consent).

Аккаунт: ДО удаления данных — живая подписка Stars отменяется через bot-gateway (`edit … is_canceled: true`; bot-gateway
ещё знает Telegram ID — identity-consent удаляет его последним; сбой — пункт сверки, сага не блокируется). Затем под
блокировкой аккаунта и `SET LOCAL tilhero.deletion = 'on'`: заказы pending → cancelled, их created-транзакции →
cancelled (order_closed); активный период → revoked (deletion) без возврата; удаляются реестр минут, удержания,
остатки, периоды, заявки «четыре глаза», строки learners и ключи идемпотентности ученика; заказы, транзакции,
возвраты, подписки Stars, фискальные чеки сохраняются обезличенными (account_id, beneficiary_id → NULL).

Детский профиль: learner_id в реестре и удержаниях → NULL (активные удержания — снять), заказы с получателем-ребёнком →
beneficiary_id NULL, строка learners — удалить.

→ ACK `user.domain.deleted.v1 {domain: billing, mode: anonymized}`. Платёж после удаления — пункт
`paid_after_deletion` (PaymentPort). Повтор саги — снова ACK."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime

from sqlalchemy import delete, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing import clients
from tilhero_billing.domain import adapters, minutes, periods
from tilhero_billing.domain.common import DOMAIN_DELETED, emit_event, lock_account, recon_item
from tilhero_billing.models import (
    Adjustment,
    DeletedUser,
    Idempotency,
    Learner,
    MinuteHold,
    MinuteLedger,
    Order,
    Period,
    PeriodBalance,
    ProviderTransaction,
    StarsSubscription,
)
from tilhero_common.app import Runtime

log = logging.getLogger("tilhero.billing.saga")


async def cancel_stars_before(rt: Runtime, user_id: uuid.UUID) -> str | None:
    """Вне транзакции, до удаления данных: отменить автопродление живой подписки Stars аккаунта. → код ошибки или
    None (нет подписки / отменена)."""
    async with rt.transaction() as db:
        row = await db.get(Learner, user_id)
        if row is not None and row.kind == "child":
            return None
        sub = await periods.live_stars(db, user_id)
        if sub is None or sub.status == "canceled":
            return None
        charge = sub.first_charge_id
    try:
        await adapters.edit_star_subscription(rt, user_id, charge, is_canceled=True)
    except clients.StarsGatewayError as exc:
        return exc.code
    return None


async def delete_user_data(db: AsyncSession, user_id: uuid.UUID, request_id: uuid.UUID, now: datetime, *,
                           stars_error: str | None = None, causation_id: str | None = None) -> None:
    row = await db.get(Learner, user_id)
    child = row is not None and row.kind == "child"
    account = row.account_id if child and row is not None else user_id
    await lock_account(db, account)
    await db.execute(text("SET LOCAL tilhero.deletion = 'on'"))
    if child:
        await _child(db, user_id, now)
    else:
        await _account(db, user_id, now, stars_error)
    await db.execute(text("SET LOCAL tilhero.deletion = 'off'"))
    await db.execute(insert(DeletedUser).values(user_id=user_id, request_id=request_id, deleted_at=now)
                     .on_conflict_do_nothing(index_elements=["user_id"]))
    await emit_event(db, DOMAIN_DELETED, {"user_id": str(user_id), "request_id": str(request_id),
                                          "domain": "billing", "mode": "anonymized"}, causation_id=causation_id)


async def _account(db: AsyncSession, account: uuid.UUID, now: datetime, stars_error: str | None) -> None:
    subs = (await db.execute(select(StarsSubscription).where(StarsSubscription.account_id == account)
                             .with_for_update())).scalars().all()
    for sub in subs:
        if sub.status in ("active", "failed"):
            if stars_error is None:
                sub.status = "canceled"
            else:
                await recon_item(db, "stars_subscription_desync", f"stars_desync:deletion:{sub.subscription_id}",
                                 at=now, provider="telegram_stars", order_id=sub.first_order_id,
                                 details={"reason": "cancel_failed_on_deletion", "code": stars_error[:40]})
        sub.account_id, sub.updated_at = None, now
    pending = (await db.execute(select(Order).where(Order.account_id == account, Order.status == "pending")
                                .with_for_update())).scalars().all()
    for order in pending:
        order.status, order.closed_at = "cancelled", now
        await db.execute(update(ProviderTransaction).where(
            ProviderTransaction.order_id == order.order_id, ProviderTransaction.state == "created")
            .values(state="cancelled", cancel_reason="order_closed", cancelled_at=now))
    await db.flush()
    active = await periods.active_period(db, account)
    if active is not None:
        await periods.revoke(db, active, reason="deletion", ref="deletion", ref_kind="deletion", actor="system",
                             now=now, emit=False)
    period_ids = select(Period.period_id).where(Period.account_id == account)
    await db.execute(delete(MinuteLedger).where(MinuteLedger.account_id == account))
    await db.execute(delete(MinuteHold).where(MinuteHold.account_id == account))
    await db.execute(delete(PeriodBalance).where(PeriodBalance.period_id.in_(period_ids)))
    await db.execute(delete(Period).where(Period.account_id == account))
    await db.execute(delete(Adjustment).where(Adjustment.account_id == account))
    await db.execute(update(Order).where(Order.account_id == account).values(account_id=None))
    await db.execute(update(Order).where(Order.beneficiary_id == account).values(beneficiary_id=None))
    await db.execute(delete(Learner).where(Learner.user_id == account))
    await db.execute(delete(Idempotency).where(Idempotency.actor == str(account)))


async def _child(db: AsyncSession, child: uuid.UUID, now: datetime) -> None:
    holds = (await db.execute(select(MinuteHold).where(MinuteHold.learner_id == child, MinuteHold.status == "active")
                              .with_for_update())).scalars().all()
    for h in holds:
        await minutes.release_hold(db, h, status="expired", at=now)
    await db.execute(update(MinuteHold).where(MinuteHold.learner_id == child).values(learner_id=None))
    await db.execute(update(MinuteLedger).where(MinuteLedger.learner_id == child).values(learner_id=None))
    await db.execute(update(Order).where(Order.beneficiary_id == child).values(beneficiary_id=None))
    await db.execute(delete(Learner).where(Learner.user_id == child))
