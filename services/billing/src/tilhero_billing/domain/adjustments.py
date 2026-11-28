"""Корректировки «четыре глаза» (INTERNAL_API §1.13, ADM-USR-04, ADM-MONEY-05, AT-95).

Заявка (`subscriptions.override` + step-up, Idempotency-Key) → pending на 72 ч → решение другим сотрудником
(`billing.approve` + step-up; автор — 409 SELF_APPROVAL, в БД — CHECK decided_by <> requested_by) → применение в одной
транзакции под блокировкой аккаунта: запись `adjust` (или период `grant` / отзыв периода), before/after, событие
`billing.adjustment.applied.v1`, аудит с обоими сотрудниками. Проверки — и при подаче, и при применении. Исключения
«единственный super_admin» нет. Ученику — запись «начислено поддержкой», комментарий сотрудника не показывается."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing.domain import catalog, minutes, periods
from tilhero_billing.domain.common import (
    ADJUSTMENT_APPLIED,
    BILLING_APPROVE,
    cursor_time_id,
    emit_audit,
    emit_event,
    encode_cursor,
    is_deleted,
    iso,
    iso_req,
    lock_account,
    staff_ref,
)
from tilhero_billing.models import Adjustment, Learner, Order, Period
from tilhero_common.errors import ApiError, conflict, not_found, unprocessable
from tilhero_common.internal_auth import Actor

TTL = timedelta(hours=72)


def adjustment_not_found() -> ApiError:
    return not_found("ADJUSTMENT_NOT_FOUND", "Заявка не найдена")


def adjustment_state(status: str) -> ApiError:
    del status
    return conflict("ADJUSTMENT_STATE", "Заявка уже в другом состоянии")


def adjustment_invalid(reason: str) -> ApiError:
    del reason
    return unprocessable("ADJUSTMENT_INVALID", "Некорректная заявка")


def self_approval() -> ApiError:
    return conflict("SELF_APPROVAL", "Подтвердить заявку может только другой сотрудник")


def balance_negative(available: int, minutes_: int) -> ApiError:
    del available, minutes_
    return conflict("BALANCE_NEGATIVE", "Остаток минут не может уйти в минус")


def account_not_found() -> ApiError:
    return not_found("ACCOUNT_NOT_FOUND", "Аккаунт не найден")


async def known_account(db: AsyncSession, account_id: uuid.UUID) -> bool:
    if await is_deleted(db, account_id):
        return False
    row = await db.get(Learner, account_id)
    if row is not None:
        return row.kind == "account"
    for model, col in ((Period, Period.account_id), (Order, Order.account_id)):
        if await db.scalar(select(func.count()).select_from(model).where(col == account_id)):
            return True
    return False


async def _check(db: AsyncSession, account_id: uuid.UUID, kind: str, minutes_: int | None, days: int | None,
                 period_id: uuid.UUID | None) -> Period | None:
    """Проверки заявки (при подаче и при применении)."""
    if kind == "minutes":
        if minutes_ is None or minutes_ == 0 or not -10_000 <= minutes_ <= 10_000 or period_id is None \
                or days is not None:
            raise adjustment_invalid("minutes")
    elif kind == "grant_period":
        if days is None or not 1 <= days <= 90 or minutes_ is None or not 1 <= minutes_ <= 10_000 \
                or period_id is not None:
            raise adjustment_invalid("grant_period")
        return None
    elif kind == "revoke_period":
        if period_id is None or minutes_ is not None or days is not None:
            raise adjustment_invalid("revoke_period")
    else:
        raise adjustment_invalid("kind")
    period = await db.get(Period, period_id, populate_existing=True)
    if period is None or period.account_id != account_id or period.status not in ("active", "scheduled"):
        raise adjustment_invalid("period_state")
    if kind == "minutes" and minutes_ is not None and minutes_ < 0:
        bal = await db.get(periods.PeriodBalance, period.period_id, populate_existing=True)
        free = minutes.available(bal)
        if -minutes_ > free:
            raise balance_negative(free, minutes_)
    return period


async def request(db: AsyncSession, actor: Actor, account_id: uuid.UUID, kind: str, minutes_: int | None,
                  days: int | None, period_id: uuid.UUID | None, reason: str, key: str,
                  now: datetime) -> tuple[Adjustment, bool]:
    """→ (заявка, создана сейчас). Повтор ключа тем же сотрудником — та же заявка."""
    prior = await db.scalar(select(Adjustment).where(Adjustment.requested_by == actor.id[:80],
                                                     Adjustment.idempotency_key == key))
    if prior is not None:
        if (prior.account_id, prior.kind, prior.minutes, prior.days, prior.period_id) != (
                account_id, kind, minutes_, days, period_id):
            raise unprocessable("IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными")
        return prior, False
    await lock_account(db, account_id)
    if not await known_account(db, account_id):
        raise account_not_found()
    await periods.ensure_current(db, account_id, now)
    await _check(db, account_id, kind, minutes_, days, period_id)
    adj = Adjustment(adjustment_id=uuid.uuid4(), account_id=account_id, kind=kind, minutes=minutes_, days=days,
                     period_id=period_id, reason=reason, status="pending", requested_by=actor.id[:80],
                     requested_by_name=(actor.name or "")[:120] or None, requested_at=now, expires_at=now + TTL,
                     idempotency_key=key)
    db.add(adj)
    await db.flush()
    await emit_audit(db, actor, "billing.adjustment_requested", "billing_adjustment", str(adj.adjustment_id),
                     after={"account_id": str(account_id), "kind": kind, "minutes": minutes_, "days": days,
                            "period_id": str(period_id) if period_id else None}, reason=reason, at=now)
    return adj, True


async def _locked(db: AsyncSession, adjustment_id: uuid.UUID) -> Adjustment:
    row = await db.get(Adjustment, adjustment_id)
    if row is None:
        raise adjustment_not_found()
    await lock_account(db, row.account_id)
    row = await db.get(Adjustment, adjustment_id, with_for_update=True, populate_existing=True)
    assert row is not None
    return row


async def _expire_if_due(db: AsyncSession, adj: Adjustment, now: datetime) -> None:
    if adj.status == "pending" and adj.expires_at <= now:
        adj.status, adj.decided_at = "expired", now
        await db.flush()


async def _snapshot(db: AsyncSession, account_id: uuid.UUID, period: Period | None) -> dict[str, Any]:
    st = await periods.account_state(db, account_id)
    out: dict[str, Any] = {"status": st.status, "minutes_left": st.minutes_left,
                           "active_period_id": str(st.active.period_id) if st.active else None}
    if period is not None:
        bal = await db.get(periods.PeriodBalance, period.period_id, populate_existing=True)
        out.update(period_id=str(period.period_id), period_status=period.status,
                   period_minutes_left=minutes.available(bal))
    return out


async def approve(db: AsyncSession, actor: Actor, adjustment_id: uuid.UUID, note: str | None,
                  now: datetime) -> Adjustment:
    adj = await _locked(db, adjustment_id)
    if adj.requested_by == actor.id[:80]:
        raise self_approval()
    await _expire_if_due(db, adj, now)
    if adj.status != "pending":
        raise adjustment_state(adj.status)
    if await is_deleted(db, adj.account_id):
        raise account_not_found()
    await periods.ensure_current(db, adj.account_id, now)
    period = await _check(db, adj.account_id, adj.kind, adj.minutes, adj.days, adj.period_id)
    before = await _snapshot(db, adj.account_id, period)
    staff = f"staff:{actor.id[:64]}"
    applied_period: uuid.UUID | None = adj.period_id
    if adj.kind == "minutes":
        assert period is not None and adj.minutes is not None
        bal = await minutes.balance(db, period.period_id)
        assert bal is not None
        await minutes.post(db, bal, kind="adjust", minutes=int(adj.minutes), ref_kind="adjustment",
                           ref_id=str(adj.adjustment_id), key=f"adjust:{adj.adjustment_id}", actor=staff, at=now)
        await periods.emit_access(db, adj.account_id, now)
    elif adj.kind == "grant_period":
        assert adj.days is not None and adj.minutes is not None
        cat = await catalog.active_catalog(db)
        new = await periods.add_period(db, adj.account_id, source="grant", product_code="grant",
                                       catalog_version=cat.version if cat else 1, days=int(adj.days),
                                       minutes_granted=int(adj.minutes), features=["ai_lessons", "pair_lessons"],
                                       mode="queue", now=now, reason="grant", actor=staff,
                                       adjustment_id=adj.adjustment_id)
        applied_period = new.period_id
        period = new
    else:
        assert period is not None
        await periods.revoke(db, period, reason="staff", ref=str(adj.adjustment_id), ref_kind="adjustment",
                             actor=staff, now=now)
    after = await _snapshot(db, adj.account_id, period)
    adj.status, adj.decided_by, adj.decided_at = "applied", actor.id[:80], now
    adj.decided_by_name = (actor.name or "")[:120] or None
    adj.decision_note, adj.before_value, adj.after_value = (note or None), before, after
    await db.flush()
    await emit_event(db, ADJUSTMENT_APPLIED, {
        "adjustment_id": str(adj.adjustment_id), "account_id": str(adj.account_id), "kind": adj.kind,
        "minutes": adj.minutes, "days": adj.days, "period_id": str(applied_period) if applied_period else None,
        "applied_at": iso_req(now)})
    await emit_audit(db, actor, "billing.adjustment_approved", "billing_adjustment", str(adj.adjustment_id),
                     before=before, after={**after, "requested_by": adj.requested_by, "approved_by": actor.id},
                     reason=adj.reason, at=now)
    return adj


async def reject(db: AsyncSession, actor: Actor, adjustment_id: uuid.UUID, note: str, now: datetime) -> Adjustment:
    adj = await _locked(db, adjustment_id)
    if adj.requested_by == actor.id[:80]:
        raise self_approval()
    await _expire_if_due(db, adj, now)
    if adj.status != "pending":
        raise adjustment_state(adj.status)
    adj.status, adj.decided_by, adj.decided_at = "rejected", actor.id[:80], now
    adj.decided_by_name, adj.decision_note = (actor.name or "")[:120] or None, note
    await db.flush()
    await emit_audit(db, actor, "billing.adjustment_rejected", "billing_adjustment", str(adj.adjustment_id),
                     after={"requested_by": adj.requested_by, "rejected_by": actor.id}, reason=note, at=now)
    return adj


async def cancel(db: AsyncSession, actor: Actor, adjustment_id: uuid.UUID, now: datetime) -> Adjustment:
    adj = await _locked(db, adjustment_id)
    if adj.requested_by != actor.id[:80]:
        raise adjustment_not_found()
    await _expire_if_due(db, adj, now)
    if adj.status != "pending":
        raise adjustment_state(adj.status)
    adj.status, adj.decided_at = "cancelled", now
    await db.flush()
    await emit_audit(db, actor, "billing.adjustment_cancelled", "billing_adjustment", str(adj.adjustment_id),
                     after={"status": "cancelled"}, at=now)
    return adj


async def expire_due(db: AsyncSession, now: datetime, batch: int) -> int:
    rows = (await db.execute(select(Adjustment).where(Adjustment.status == "pending", Adjustment.expires_at <= now)
                             .limit(batch).with_for_update(skip_locked=True))).scalars().all()
    for adj in rows:
        adj.status, adj.decided_at = "expired", now
    return len(rows)


def view(adj: Adjustment, actor: Actor | None) -> dict[str, Any]:
    pending = adj.status == "pending"
    me = actor.id[:80] if actor is not None else None
    return {
        "adjustment_id": str(adj.adjustment_id), "account_id": str(adj.account_id), "kind": adj.kind,
        "minutes": adj.minutes, "days": adj.days, "period_id": str(adj.period_id) if adj.period_id else None,
        "reason": adj.reason, "status": adj.status,
        "requested_by": staff_ref(adj.requested_by, adj.requested_by_name), "requested_at": iso(adj.requested_at),
        "decided_by": staff_ref(adj.decided_by, adj.decided_by_name), "decided_at": iso(adj.decided_at),
        "decision_note": adj.decision_note, "before_value": adj.before_value, "after_value": adj.after_value,
        "expires_at": iso(adj.expires_at),
        "can_decide": bool(pending and actor is not None and BILLING_APPROVE in actor.permissions
                           and me != adj.requested_by),
        "can_cancel": bool(pending and me == adj.requested_by)}


async def page(db: AsyncSession, status: str | None, cursor: str | None, limit: int,
               account_id: uuid.UUID | None = None) -> tuple[list[Adjustment], str | None]:
    stmt = select(Adjustment)
    if status:
        stmt = stmt.where(Adjustment.status == status)
    if account_id is not None:
        stmt = stmt.where(Adjustment.account_id == account_id)
    after = cursor_time_id(cursor)
    if after is not None:
        ts, aid = after
        stmt = stmt.where((Adjustment.requested_at < ts)
                          | ((Adjustment.requested_at == ts) & (Adjustment.adjustment_id < aid)))
    rows = list((await db.execute(stmt.order_by(Adjustment.requested_at.desc(), Adjustment.adjustment_id.desc())
                                  .limit(limit + 1))).scalars().all())
    nxt = encode_cursor(iso(rows[limit - 1].requested_at), rows[limit - 1].adjustment_id) \
        if len(rows) > limit else None
    return rows[:limit], nxt
