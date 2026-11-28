"""Возвраты (INTERNAL_API §1.12, APP-BILL-04, AT-94): только полные, по решению сотрудника (`billing.refund` +
step-up + причина) или по инициативе провайдера.

Заявка: заказ paid/fulfilled с проведённой транзакцией и без живого возврата; окно Click (текущий месяц, 1-го числа
— и прошлый); Stars — плательщик известен; пакет тилов — пред-проверка gamification by-order (потрачены и нет force —
409 REFUND_NOT_ALLOWED tils_spent). Возврат пишется до вызова провайдера (UNIQUE живого возврата на заказ — повторный
возврат невозможен), адаптер — вне транзакции БД: Stars и Click — сразу completed | failed; Payme и Uzum —
awaiting_provider с инструкцией (завершение — CancelTransaction state 2 / reverse).

Завершение (`complete`) — одна транзакция: транзакция и заказ → refunded, возврат → completed; подписка — период
revoked (refund), остаток → revoke; подписка Stars → refunded; пакет тилов — `billing.order.refunded.v1` →
gamification обратной записью; аудит. Без заявки (Payme/Uzum отмена проведённой, refunded_payment) — то же +
initiated_by provider + пункт сверки refund_without_request."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing.domain import periods
from tilhero_billing.domain.common import (
    ORDER_REFUNDED,
    STARS_SUB_CHANGED,
    emit_audit,
    emit_event,
    is_deleted,
    iso,
    iso_req,
    recon_item,
    report_zone,
    staff_ref,
)
from tilhero_billing.models import Order, Period, ProviderTransaction, Refund, StarsSubscription
from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, conflict, not_found
from tilhero_common.internal_auth import Actor

log = logging.getLogger("tilhero.billing.refunds")

API_PROVIDERS = ("telegram_stars", "click")  # возврат сразу через API; Payme, Uzum — в кабинете


def refund_state(status: str | None = None) -> ApiError:
    del status  # details — только поля контракта (admin.ts: REFUND_STATE без деталей)
    return conflict("REFUND_STATE", "Возврат по заказу уже оформлен или заказ в другом состоянии")


def refund_not_allowed(reason: str, **extra: Any) -> ApiError:
    return conflict("REFUND_NOT_ALLOWED", "Возврат сейчас невозможен", {"reason": reason, **extra})


def stars_payer_unknown() -> ApiError:
    return conflict("STARS_PAYER_UNKNOWN", "Плательщик неизвестен (аккаунт удалён) — возврат через API невозможен")


def refund_not_found() -> ApiError:
    return not_found("REFUND_NOT_FOUND", "Возврат не найден")


def click_window_open(performed_at: datetime | None, now: datetime) -> bool:
    """Click: возврат — только в текущем отчётном месяце (Asia/Tashkent); 1-го числа — и за прошлый (§1.7)."""
    if performed_at is None:
        return False
    tz = report_zone()
    paid, today = performed_at.astimezone(tz), now.astimezone(tz)
    if (paid.year, paid.month) == (today.year, today.month):
        return True
    prev = (today.year, today.month - 1) if today.month > 1 else (today.year - 1, 12)
    return today.day == 1 and (paid.year, paid.month) == prev


async def stars_subscription_of(db: AsyncSession, order: Order) -> StarsSubscription | None:
    if order.stars_subscription_id is not None:
        return await db.get(StarsSubscription, order.stars_subscription_id, populate_existing=True)
    return await db.scalar(select(StarsSubscription).where(StarsSubscription.first_order_id == order.order_id)
                           .execution_options(populate_existing=True))


async def complete(db: AsyncSession, refund: Refund, txn: ProviderTransaction, order: Order, now: datetime, *,
                   causation_id: str | None = None) -> None:
    """Завершение возврата (вызывающий держит блокировки «аккаунт → заказ»). Повтор — без изменений."""
    if refund.status == "completed":
        return
    if txn.state == "performed":
        txn.state, txn.cancelled_at, txn.cancel_reason = "refunded", now, "refund"
    refund.status, refund.completed_at = "completed", now
    if order.status in ("paid", "fulfilled"):
        order.status, order.closed_at = "refunded", now
    await db.flush()
    if order.product_kind == "subscription":
        period = await db.scalar(select(Period).where(Period.order_id == order.order_id)
                                 .execution_options(populate_existing=True))
        if period is not None:
            await periods.revoke(db, period, reason="refund", ref=str(refund.refund_id), ref_kind="refund",
                                 actor="system", now=now, causation_id=causation_id)
        sub = await stars_subscription_of(db, order)
        if sub is not None and sub.status != "refunded":
            sub.status, sub.updated_at = "refunded", now
            await db.flush()
            if sub.account_id is not None and not await is_deleted(db, sub.account_id):
                await emit_event(db, STARS_SUB_CHANGED, {
                    "account_id": str(sub.account_id), "subscription_id": str(sub.subscription_id),
                    "status": "refunded", "expires_at": iso_req(sub.expires_at), "changed_at": iso_req(now)},
                    causation_id=causation_id)
    await emit_event(db, ORDER_REFUNDED, {
        "order_id": str(order.order_id), "order_no": int(order.order_no),
        "account_id": str(order.account_id) if order.account_id else None,
        "beneficiary_user_id": str(order.beneficiary_id) if order.beneficiary_id else None,
        "channel": order.channel, "product_kind": order.product_kind, "currency": order.currency,
        "amount_tiyin": order.amount_tiyin, "amount_stars": order.amount_stars, "refund_id": str(refund.refund_id),
        "initiated_by": refund.initiated_by, "refunded_at": iso_req(now)}, causation_id=causation_id)
    await emit_audit(db, None, "billing.refund_completed", "billing_order", str(order.order_id),
                     before={"status": "performed"}, after={"refund_id": str(refund.refund_id),
                                                            "initiated_by": refund.initiated_by}, at=now)


async def provider_refunded(db: AsyncSession, txn: ProviderTransaction, order: Order, now: datetime, *,
                            provider_reason: int | None = None) -> Refund:
    """Провайдер вернул проведённую оплату (Payme Cancel state 2, Uzum reverse после confirm, Stars
    refunded_payment): подтверждение нашего живого возврата или возврат по его инициативе (+ refund_without_request)."""
    live = await db.scalar(select(Refund).where(Refund.order_id == order.order_id,
                                                Refund.status.in_(("awaiting_provider", "completed")))
                           .with_for_update().execution_options(populate_existing=True))
    if provider_reason is not None and txn.provider_reason is None:
        txn.provider_reason = provider_reason
    if live is not None:
        await complete(db, live, txn, order, now)
        return live
    refund = Refund(refund_id=uuid.uuid4(), order_id=order.order_id, txn_id=txn.txn_id,
                    amount_tiyin=txn.amount_tiyin, amount_stars=txn.amount_stars, status="awaiting_provider",
                    initiated_by="provider",
                    method="provider_api" if txn.provider in API_PROVIDERS else "provider_cabinet",
                    reason=None, requested_by=None, requested_at=now)
    db.add(refund)
    await db.flush()
    await recon_item(db, "refund_without_request", f"refund_without_request:{txn.txn_id}", at=now,
                     provider=txn.provider, order_id=order.order_id, txn_id=txn.txn_id,
                     details={"provider_reason": provider_reason})
    await complete(db, refund, txn, order, now)
    return refund


def refund_view(r: Refund, order: Order | None, txn: ProviderTransaction | None) -> dict[str, Any]:
    tils = r.tils_check if isinstance(r.tils_check, dict) else None
    instruction = None
    if r.method == "provider_cabinet" and r.status == "awaiting_provider" and txn is not None:
        instruction = {"provider": txn.provider, "provider_txn_id": txn.provider_txn_id,
                       "amount_tiyin": txn.amount_tiyin}
    return {
        "refund_id": str(r.refund_id), "order_id": str(r.order_id),
        "order_no": int(order.order_no) if order is not None else None, "txn_id": str(r.txn_id),
        "provider": txn.provider if txn is not None else (order.provider if order is not None else None),
        "amount_tiyin": r.amount_tiyin, "amount_stars": r.amount_stars, "status": r.status,
        "initiated_by": r.initiated_by, "method": r.method, "reason": r.reason,
        "requested_by": staff_ref(r.requested_by, r.requested_by_name), "requested_at": iso(r.requested_at),
        "completed_at": iso(r.completed_at), "failure_code": r.failure_code,
        "tils_check": {"til": int(tils.get("til") or 0), "til_balance": int(tils.get("til_balance") or 0),
                       "status": str(tils.get("status") or "")} if tils else None,
        "instruction": instruction,
    }


# ---------------------------------------------------------------- возврат сотрудником (§1.12)


async def _performed(db: AsyncSession, order_id: uuid.UUID) -> ProviderTransaction | None:
    return await db.scalar(select(ProviderTransaction).where(
        ProviderTransaction.order_id == order_id, ProviderTransaction.state == "performed")
        .execution_options(populate_existing=True))


async def _guard(db: AsyncSession, order: Order, now: datetime) -> ProviderTransaction:
    """Проверки заявки (до и после пред-проверки тилов): проведённая транзакция, нет живого возврата, окно Click,
    плательщик Stars известен."""
    if order.status == "refunded" or await db.scalar(select(Refund.refund_id).where(
            Refund.order_id == order.order_id, Refund.status.in_(("awaiting_provider", "completed")))) is not None:
        raise refund_state(order.status)
    txn = await _performed(db, order.order_id)
    if txn is None or order.status not in ("paid", "fulfilled"):
        # платёж на отменённый / истёкший заказ (пункт сверки) — не через этот возврат (контракт §1.12)
        raise refund_not_allowed("not_paid")
    if txn.provider == "click" and not click_window_open(txn.performed_at, now):
        raise refund_not_allowed("provider_window")
    if txn.provider == "telegram_stars" and (order.account_id is None or await is_deleted(db, order.account_id)):
        raise stars_payer_unknown()
    return txn


async def request(rt: Runtime, actor: Actor, order_id: uuid.UUID, reason: str, force: bool,
                  key: str) -> tuple[dict[str, Any], bool]:
    """Заявка на возврат → AdminRefund (201): Stars и Click — completed | failed; Payme и Uzum — awaiting_provider с
    инструкцией. Повтор Idempotency-Key тем же сотрудником — тот же возврат."""
    from tilhero_billing import clients
    from tilhero_billing.domain import adapters
    from tilhero_billing.domain.common import (
        lock_account,
        lock_order,
        now_of,
        order_not_found,
        request_hash,
        upstream_unavailable,
    )
    from tilhero_billing.models import Idempotency
    from tilhero_billing.providers.base import RefundOutcome

    scope, h = f"refund:{order_id}", request_hash({"reason": reason, "force": force})
    now = now_of(rt)
    async with rt.transaction() as db:
        prior = await db.get(Idempotency, (scope, actor.id[:80], key))
        if prior is not None:
            if prior.request_hash != h:
                from tilhero_billing.domain.common import idempotency_reused

                raise idempotency_reused()
            return await _view_by_id(db, uuid.UUID(str(prior.response["refund_id"]))), True
        order = await db.get(Order, order_id)
        if order is None:
            raise order_not_found()
        await _guard(db, order, now)
        til = int((order.product_snapshot or {}).get("til") or 0) if order.product_kind == "til_pack" else 0
    tils_check: dict[str, Any] | None = None
    if til:
        try:
            got = await clients.purchase_by_order(rt, order_id)
        except Exception as exc:
            log.warning("gamification by-order failed", extra={"error_type": type(exc).__name__})
            if not force:
                raise upstream_unavailable("gamification") from None
            got = None
            tils_check = {"til": til, "til_balance": 0, "status": "unavailable"}
        if got is not None:
            balance = int(got.get("til_balance") or 0)
            tils_check = {"til": til, "til_balance": balance, "status": str(got.get("status") or "credited")}
            if got.get("credited") and balance < til and not force:
                raise refund_not_allowed("tils_spent", til=til, til_balance=balance)
        elif tils_check is None:
            tils_check = {"til": til, "til_balance": 0, "status": "not_credited"}
    async with rt.transaction() as db:
        order = await db.get(Order, order_id)
        assert order is not None
        if order.account_id is not None:
            await lock_account(db, order.account_id)
        await lock_order(db, order_id)
        order = await db.get(Order, order_id, with_for_update=True, populate_existing=True)
        assert order is not None
        txn = await _guard(db, order, now)
        refund = Refund(refund_id=uuid.uuid4(), order_id=order_id, txn_id=txn.txn_id, amount_tiyin=txn.amount_tiyin,
                        amount_stars=txn.amount_stars, status="awaiting_provider", initiated_by="staff",
                        method="provider_api" if txn.provider in API_PROVIDERS else "provider_cabinet",
                        reason=reason, requested_by=actor.id[:80], requested_by_name=(actor.name or "")[:120] or None,
                        requested_at=now, tils_check=tils_check, idempotency_key=key[:128])
        db.add(refund)
        db.add(Idempotency(scope=scope, actor=actor.id[:80], key=key, request_hash=h, status_code=201,
                           response={"refund_id": str(refund.refund_id)}, created_at=now))
        await db.flush()
        if tils_check is not None and tils_check["til_balance"] < til and tils_check["status"] == "credited":
            await recon_item(db, "tils_spent_on_refund", f"tils_spent_on_refund:{order_id}", at=now,
                             order_id=order_id, txn_id=txn.txn_id, details={"til": til, "forced": True})
        await emit_audit(db, actor, "billing.refund_requested", "billing_order", str(order_id),
                         after={"refund_id": str(refund.refund_id), "provider": txn.provider, "force": force},
                         reason=reason, at=now)
        from tilhero_billing.domain.payments import txn_view

        tv = txn_view(txn, int(order.order_no))
        refund_id, account, provider = refund.refund_id, order.account_id, txn.provider
        sub = await stars_subscription_of(db, order) if order.product_kind == "subscription" else None
        sub_charge = sub.first_charge_id if sub is not None and sub.status in ("active", "canceled", "failed") \
            else None
    try:
        outcome = await adapters.of(rt).get(provider).refund(tv, account_id=account)
    except Exception as exc:
        log.warning("provider refund failed", extra={"provider": provider, "error_type": type(exc).__name__})
        outcome = RefundOutcome(kind="api_failed", failure_code="PROVIDER_UNAVAILABLE")
    if outcome.kind == "api_ok" and sub_charge is not None and account is not None:
        try:  # подписка Stars при возврате ещё и отменяется (AT-94)
            await adapters.edit_star_subscription(rt, account, sub_charge, is_canceled=True)
        except clients.StarsGatewayError as exc:
            log.warning("stars subscription cancel on refund failed", extra={"code": exc.code})
    now = now_of(rt)
    async with rt.transaction() as db:
        order = await db.get(Order, order_id)
        assert order is not None
        if order.account_id is not None:
            await lock_account(db, order.account_id)
        await lock_order(db, order_id)
        order = await db.get(Order, order_id, with_for_update=True, populate_existing=True)
        refund_row = await db.get(Refund, refund_id, with_for_update=True, populate_existing=True)
        txn_row = await db.get(ProviderTransaction, tv.txn_id, with_for_update=True, populate_existing=True)
        assert order is not None and refund_row is not None and txn_row is not None
        if refund_row.status == "awaiting_provider":
            if outcome.kind == "api_ok":
                await complete(db, refund_row, txn_row, order, now)
            elif outcome.kind == "api_failed":
                refund_row.status = "failed"
                refund_row.failure_code = (outcome.failure_code or "PROVIDER_ERROR")[:64]
                await emit_audit(db, actor, "billing.refund_failed", "billing_order", str(order_id),
                                 after={"refund_id": str(refund_id), "failure_code": refund_row.failure_code},
                                 at=now)
            else:
                refund_row.method = "provider_cabinet"
        await db.flush()
        return refund_view(refund_row, order, txn_row), False


async def _view_by_id(db: AsyncSession, refund_id: uuid.UUID) -> dict[str, Any]:
    r = await db.get(Refund, refund_id, populate_existing=True)
    if r is None:
        raise refund_not_found()
    return refund_view(r, await db.get(Order, r.order_id), await db.get(ProviderTransaction, r.txn_id))


async def fail(db: AsyncSession, actor: Actor, refund_id: uuid.UUID, note: str, now: datetime) -> dict[str, Any]:
    """Закрыть зависший возврат (awaiting_provider) как failed — после него возможна новая заявка."""
    from tilhero_billing.domain.common import lock_account, lock_order

    r = await db.get(Refund, refund_id)
    if r is None:
        raise refund_not_found()
    order = await db.get(Order, r.order_id)
    assert order is not None
    if order.account_id is not None:
        await lock_account(db, order.account_id)
    await lock_order(db, order.order_id)
    r = await db.get(Refund, refund_id, with_for_update=True, populate_existing=True)
    assert r is not None
    if r.status != "awaiting_provider":
        raise refund_state(r.status)
    r.status, r.failure_code = "failed", "CLOSED_BY_STAFF"
    await db.flush()
    await emit_audit(db, actor, "billing.refund_failed", "billing_order", str(order.order_id),
                     after={"refund_id": str(refund_id), "failure_code": "CLOSED_BY_STAFF"}, reason=note, at=now)
    return refund_view(r, order, await db.get(ProviderTransaction, r.txn_id))


def utcnow() -> datetime:
    return datetime.now(UTC)
