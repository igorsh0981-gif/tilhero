"""Периоды подписки (INTERNAL_API §1.10): машина состояний scheduled → active → ended | superseded | revoked
(триггер `periods_guard`), очередь запланированных по created_at, ленивая активация и завершение (`ensure_current`
под блокировкой аккаунта — любая команда аккаунта и tick), статус аккаунта, события
`billing.subscription.changed.v1` и `billing.access.changed.v1`.

Минуты периода выдаются при его создании (запись `grant` в той же транзакции; у запланированного доступны после
активации). Окончание: остаток (без удержаний) → `expire`; superseded — остаток сгорает (`expire`); revoked — остаток
→ `revoke`. Источник периода (Stars, сайт, пробный, выдача) на доступ не влияет."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing.domain import minutes
from tilhero_billing.domain.common import (
    ACCESS_CHANGED,
    SUBSCRIPTION_CHANGED,
    emit_event,
    is_deleted,
    iso,
    iso_req,
)
from tilhero_billing.domain.learners import learners_of
from tilhero_billing.models import Period, PeriodBalance, StarsSubscription

ACTIVATION_GAP = timedelta(days=1)  # следующий период начинается с конца предыдущего, если тот кончился ≤ суток назад
LIVE_STARS = ("active", "canceled", "failed")


@dataclass
class AccountState:
    status: str  # none | trial | active | expired
    active: Period | None
    balance: PeriodBalance | None
    scheduled: list[Period]
    trial_used: bool
    any_period: bool
    stars: StarsSubscription | None

    @property
    def features(self) -> list[str]:
        return sorted(self.active.features) if self.active is not None else []

    @property
    def minutes_left(self) -> int:
        return minutes.available(self.balance)

    @property
    def paid_active(self) -> bool:
        return self.active is not None and self.active.source in ("order", "grant")

    def paid_until(self) -> datetime | None:
        """Конец цепочки: активный период + запланированные (их дни); подписка Stars с автопродлением — её срок."""
        if self.active is None or self.active.ends_at is None:
            return None
        end = self.active.ends_at + sum((timedelta(days=int(p.days)) for p in self.scheduled), timedelta())
        if self.stars is not None and self.stars.status == "active" and self.stars.expires_at > end:
            end = self.stars.expires_at
        return end


async def active_period(db: AsyncSession, account_id: uuid.UUID) -> Period | None:
    return await db.scalar(select(Period).where(Period.account_id == account_id, Period.status == "active")
                           .execution_options(populate_existing=True))


async def scheduled_periods(db: AsyncSession, account_id: uuid.UUID) -> list[Period]:
    return list((await db.execute(select(Period).where(Period.account_id == account_id,
                                                       Period.status == "scheduled")
                                  .order_by(Period.created_at, Period.period_id)
                                  .execution_options(populate_existing=True))).scalars().all())


async def live_stars(db: AsyncSession, account_id: uuid.UUID) -> StarsSubscription | None:
    return await db.scalar(select(StarsSubscription).where(StarsSubscription.account_id == account_id,
                                                           StarsSubscription.status.in_(LIVE_STARS))
                           .execution_options(populate_existing=True))


async def account_state(db: AsyncSession, account_id: uuid.UUID) -> AccountState:
    active = await active_period(db, account_id)
    bal = await db.get(PeriodBalance, active.period_id, populate_existing=True) if active is not None else None
    scheduled = await scheduled_periods(db, account_id)
    trial_used = (await db.scalar(select(Period.period_id).where(Period.account_id == account_id,
                                                                 Period.source == "trial"))) is not None
    any_period = (await db.scalar(select(Period.period_id).where(Period.account_id == account_id).limit(1))) \
        is not None
    if active is not None:
        status = "trial" if active.source == "trial" else "active"
    else:
        status = "expired" if any_period else "none"
    return AccountState(status=status, active=active, balance=bal, scheduled=scheduled, trial_used=trial_used,
                        any_period=any_period, stars=await live_stars(db, account_id))


async def emit_status(db: AsyncSession, account_id: uuid.UUID, now: datetime, reason: str, *,
                      causation_id: str | None = None) -> None:
    """billing.subscription.changed.v1 (аккаунту) и billing.access.changed.v1 (каждому ученику аккаунта)."""
    if await is_deleted(db, account_id):
        return
    st = await account_state(db, account_id)
    p = st.active
    await emit_event(db, SUBSCRIPTION_CHANGED, {
        "account_id": str(account_id), "status": st.status, "reason": reason,
        "period_id": str(p.period_id) if p is not None else None,
        "product_code": p.product_code if p is not None else None,
        "starts_at": iso(p.starts_at) if p is not None else None,
        "ends_at": iso(p.ends_at) if p is not None else None,
        "minutes_granted": int(st.balance.granted) if p is not None and st.balance is not None else None,
        "changed_at": iso_req(now)}, causation_id=causation_id)
    await emit_access(db, account_id, now, st=st, causation_id=causation_id)


async def emit_access(db: AsyncSession, account_id: uuid.UUID, now: datetime, *, st: AccountState | None = None,
                      only: uuid.UUID | None = None, causation_id: str | None = None) -> None:
    """Тариф учеников аккаунта (ai-gateway, user-admin): paid — есть активный период (в т. ч. пробный)."""
    st = st or await account_state(db, account_id)
    paid = st.active is not None
    users = [only] if only is not None else await learners_of(db, account_id)
    for user in users:
        await emit_event(db, ACCESS_CHANGED, {
            "user_id": str(user), "account_id": str(account_id), "tier": "paid" if paid else "free",
            "features": st.features, "paid_until": iso(st.paid_until()) if paid else None,
            "changed_at": iso_req(now)}, causation_id=causation_id)


async def _close(db: AsyncSession, period: Period, status: str, reason: str, at: datetime, *, ledger_kind: str,
                 key: str, ref_kind: str, ref_id: str, actor: str) -> int:
    """Закрыть период и списать остаток (без удержаний) записью реестра."""
    rest = await minutes.close_remaining(db, period, kind=ledger_kind, key=key, ref_kind=ref_kind, ref_id=ref_id,
                                         actor=actor, at=at)
    period.status, period.close_reason, period.closed_at = status, reason, at
    await db.flush()
    return rest


async def _last_end(db: AsyncSession, account_id: uuid.UUID) -> datetime | None:
    return await db.scalar(select(Period.ends_at).where(Period.account_id == account_id, Period.status == "ended")
                           .order_by(Period.ends_at.desc()).limit(1))


async def _stars_end(db: AsyncSession, period: Period, starts_at: datetime) -> datetime | None:
    """Период подписки Stars: конец — subscription_expiration_date подписки, если это её последний период."""
    if period.stars_subscription_id is None:
        return None
    sub = await db.get(StarsSubscription, period.stars_subscription_id)
    if sub is None or sub.status not in LIVE_STARS or sub.expires_at <= starts_at:
        return None
    latest = await db.scalar(select(Period.period_id).where(Period.stars_subscription_id == sub.subscription_id)
                             .order_by(Period.created_at.desc()).limit(1))
    return sub.expires_at if latest == period.period_id else None


async def _activate(db: AsyncSession, period: Period, now: datetime) -> None:
    last = await _last_end(db, period.account_id)
    starts = last if last is not None and now - ACTIVATION_GAP <= last <= now else now
    ends = await _stars_end(db, period, starts) or starts + timedelta(days=int(period.days))
    period.status, period.starts_at, period.ends_at = "active", starts, ends
    await db.flush()


async def ensure_current(db: AsyncSession, account_id: uuid.UUID, now: datetime, *, emit: bool = True,
                         causation_id: str | None = None) -> Period | None:
    """Ленивое завершение и активация (вызывающий держит блокировку аккаунта): активный с ends_at ≤ now → ended,
    остаток → expire; нет активного — первый запланированный → active. → текущий активный период."""
    changed = False
    for _ in range(50):
        active = await active_period(db, account_id)
        if active is not None and active.ends_at is not None and active.ends_at <= now:
            await _close(db, active, "ended", "ended", active.ends_at, ledger_kind="expire",
                         key=f"expire:{active.period_id}", ref_kind="period", ref_id=str(active.period_id),
                         actor="system")
            changed = True
            continue
        if active is None:
            queue = await scheduled_periods(db, account_id)
            if queue:
                await _activate(db, queue[0], now)
                changed = True
                continue
        break
    if changed and emit:
        st_active = await active_period(db, account_id)
        await emit_status(db, account_id, now, "activated" if st_active is not None else "ended",
                          causation_id=causation_id)
    return await active_period(db, account_id)


async def add_period(db: AsyncSession, account_id: uuid.UUID, *, source: str, product_code: str,
                     catalog_version: int, days: int, minutes_granted: int, features: list[str], mode: str,
                     now: datetime, reason: str, actor: str = "system", order_id: uuid.UUID | None = None,
                     adjustment_id: uuid.UUID | None = None, stars_subscription_id: uuid.UUID | None = None,
                     starts_at: datetime | None = None, ends_at: datetime | None = None,
                     causation_id: str | None = None) -> Period:
    """Новый период и его минуты (вызывающий держит блокировку аккаунта).

    mode: now — сейчас (активный → superseded, остаток сгорает); queue — после текущего (есть активный —
    scheduled); supersede_trial — подписка Stars: активный пробный → superseded, иной активный — в очередь (гонка),
    иначе сейчас до ends_at (subscription_expiration_date)."""
    active = await ensure_current(db, account_id, now, causation_id=causation_id)
    immediate = True
    if active is not None:
        if mode == "now" or (mode == "supersede_trial" and active.source == "trial"):
            await _close(db, active, "superseded", "superseded", now, ledger_kind="expire",
                         key=f"expire:{active.period_id}", ref_kind="period", ref_id=str(active.period_id),
                         actor=actor)
        else:
            immediate = False
    period = Period(period_id=uuid.uuid4(), account_id=account_id, product_code=product_code,
                    catalog_version=catalog_version, source=source, order_id=order_id, adjustment_id=adjustment_id,
                    stars_subscription_id=stars_subscription_id, features=sorted(set(features)),
                    minutes_granted=minutes_granted, days=days, status="scheduled", created_at=now)
    if immediate:
        start = starts_at if starts_at is not None and starts_at <= now else now
        end = ends_at if ends_at is not None and ends_at > start else start + timedelta(days=days)
        period.status, period.starts_at, period.ends_at = "active", start, end
    db.add(period)
    await db.flush()
    bal = PeriodBalance(period_id=period.period_id, account_id=account_id, granted=0, spent=0, removed=0, held=0,
                        overage=0, low_notified=False, updated_at=now)
    db.add(bal)
    await db.flush()
    ref_kind, ref_id = {"order": ("order", str(order_id)), "trial": ("trial", str(period.period_id)),
                        "grant": ("grant", str(adjustment_id))}[source]
    await minutes.post(db, bal, kind="grant", minutes=minutes_granted, ref_kind=ref_kind, ref_id=ref_id,
                       key=f"grant:{period.period_id}", actor=actor, at=now)
    if immediate:
        await emit_status(db, account_id, now, reason, causation_id=causation_id)
    else:
        await emit_access(db, account_id, now, causation_id=causation_id)
    return period


async def revoke(db: AsyncSession, period: Period, *, reason: str, ref: str, ref_kind: str, actor: str,
                 now: datetime, emit: bool = True, causation_id: str | None = None) -> bool:
    """Отзыв периода (возврат, сотрудник «четыре глаза», сага): scheduled | active → revoked, остаток → revoke
    `revoke:<period_id>:<ref>`. → True — отозван сейчас."""
    if period.status not in ("scheduled", "active"):
        return False
    was_active = period.status == "active"
    await _close(db, period, "revoked", reason, now, ledger_kind="revoke", key=f"revoke:{period.period_id}:{ref}",
                 ref_kind=ref_kind, ref_id=ref, actor=actor)
    if emit:
        if was_active:
            await ensure_current(db, period.account_id, now, emit=False)
            await emit_status(db, period.account_id, now, "refund" if reason == "refund" else "staff",
                              causation_id=causation_id)
        else:
            await emit_access(db, period.account_id, now, causation_id=causation_id)
    return True


def period_view(p: Period | None, bal: PeriodBalance | None) -> dict[str, Any] | None:
    """SubscriptionPeriodView (bff.ts): без источника и цены периода."""
    if p is None or p.starts_at is None or p.ends_at is None:
        return None
    return {"starts_at": iso(p.starts_at), "ends_at": iso(p.ends_at),
            "minutes_granted": int(bal.granted) if bal else int(p.minutes_granted),
            "minutes_spent": int(bal.spent) if bal else 0, "minutes_held": int(bal.held) if bal else 0,
            "minutes_left": minutes.available(bal), "overage": int(bal.overage) if bal else 0}
