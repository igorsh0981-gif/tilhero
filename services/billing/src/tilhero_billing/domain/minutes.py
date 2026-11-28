"""Реестр минут, остатки периода и удержания (INTERNAL_API §1.11).

- Реестр `minute_ledger` — только добавление (триггер); каждая запись и итог `period_balances` — в одной транзакции;
  исправление — новой записью. Ключи (§1.11): `grant:<period_id>`, `debit:<ref_kind>:<ref_id>`, `expire:<period_id>`,
  `expire:hold:<hold_id>`, `revoke:<period_id>:<refund_id | adjustment_id | deletion>`, `adjust:<adjustment_id>` —
  UNIQUE: повтор не пишет второй раз.
- Доступно = granted − spent − removed − held активного периода; баланс не уходит в минус (CHECK); перерасход ученику
  не выставляется (ADM-MONEY-02) — учитывается в удержании и итогах периода.
- Удержание — при старте занятия (lessons), списание `⌈ИИ-секунды/60⌉` — по событию завершения, один раз.
Все функции — под блокировкой аккаунта (её берёт вызывающий)."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing.domain.common import MINUTES_LOW, emit_event, recon_item
from tilhero_billing.models import MinuteHold, MinuteLedger, Period, PeriodBalance

log = logging.getLogger("tilhero.billing.minutes")


def available(b: PeriodBalance | None) -> int:
    if b is None:
        return 0
    return max(0, b.granted - b.spent - b.removed - b.held)


async def balance(db: AsyncSession, period_id: uuid.UUID) -> PeriodBalance | None:
    return await db.get(PeriodBalance, period_id, with_for_update=True, populate_existing=True)


async def post(db: AsyncSession, bal: PeriodBalance, *, kind: str, minutes: int, ref_kind: str, ref_id: str,
               key: str, actor: str, at: datetime, learner_id: uuid.UUID | None = None, overage: int = 0) -> bool:
    """Запись реестра и итог периода (одна транзакция). minutes со знаком (grant > 0; debit/expire/revoke < 0;
    adjust ±). 0 минут не пишется. → True — запись добавлена (повтор ключа — False, итог не меняется)."""
    if minutes == 0:
        return False
    row = (await db.execute(insert(MinuteLedger).values(
        entry_id=uuid.uuid4(), account_id=bal.account_id, period_id=bal.period_id, kind=kind, minutes=minutes,
        overage=overage, learner_id=learner_id, ref_kind=ref_kind, ref_id=ref_id[:64], actor=actor[:80],
        idempotency_key=key, created_at=at,
    ).on_conflict_do_nothing(index_elements=["idempotency_key"]).returning(MinuteLedger.entry_id))).first()
    if row is None:
        return False
    if kind == "grant" or (kind == "adjust" and minutes > 0):
        bal.granted += minutes
    elif kind == "debit":
        bal.spent += -minutes
    else:  # expire, revoke, adjust < 0
        bal.removed += -minutes
    bal.overage += overage
    bal.updated_at = at
    await db.flush()
    return True


async def close_remaining(db: AsyncSession, period: Period, *, kind: str, key: str, ref_kind: str, ref_id: str,
                          actor: str, at: datetime) -> int:
    """Остаток периода (без удержаний идущих занятий) → expire / revoke. Удержания закроются при расчёте занятия:
    их остаток — `expire:hold:<hold_id>`."""
    bal = await balance(db, period.period_id)
    if bal is None:
        return 0
    rest = available(bal)
    if rest > 0:
        await post(db, bal, kind=kind, minutes=-rest, ref_kind=ref_kind, ref_id=ref_id, key=key, actor=actor, at=at)
    return rest


# ---------------------------------------------------------------- удержания


def hold_view(h: MinuteHold, minutes_left: int, period_ends_at: datetime | None) -> dict[str, Any]:
    from tilhero_billing.domain.common import iso

    return {"allowed": True, "hold_id": str(h.hold_id), "minutes_held": int(h.minutes),
            "minutes_left": minutes_left, "period_ends_at": iso(period_ends_at)}


async def create_hold(db: AsyncSession, period: Period, bal: PeriodBalance, *, learner_id: uuid.UUID | None,
                      feature: str, ref_kind: str, ref_id: uuid.UUID, minutes: int, expires_at: datetime,
                      at: datetime) -> MinuteHold:
    hold = MinuteHold(hold_id=uuid.uuid4(), account_id=period.account_id, period_id=period.period_id,
                      learner_id=learner_id, feature=feature, ref_kind=ref_kind, ref_id=ref_id, minutes=minutes,
                      status="active", created_at=at, expires_at=expires_at)
    db.add(hold)
    bal.held += minutes
    bal.updated_at = at
    await db.flush()
    return hold


async def release_hold(db: AsyncSession, hold: MinuteHold, *, status: str, at: datetime) -> None:
    """Снять активное удержание без списания (истечение, сага детского профиля): минуты возвращаются в доступные."""
    if hold.status != "active":
        return
    bal = await balance(db, hold.period_id)
    if bal is not None:
        bal.held = max(0, bal.held - hold.minutes)
        bal.updated_at = at
    hold.status, hold.settled_at, hold.settled_minutes, hold.overage = status, at, 0, 0
    await db.flush()


async def settle(db: AsyncSession, hold: MinuteHold, billable: int, *, low_percent: int, at: datetime,
                 causation_id: str | None = None) -> dict[str, int] | None:
    """Списание по удержанию (событие завершения занятия; вызывающий держит блокировку аккаунта):
    - active: debit = min(billable, доступно периода после снятия удержания = hold.minutes + свободные),
      перерасход = billable − debit; период уже закончился — только минуты удержания, остаток → `expire:hold:<id>`;
    - settled — ничего (повтор события); expired (событие опоздало) — debit = min(billable, доступно) и пункт
      сверки hold_expired.
    После списания доступно ≤ low_percent % выданного → billing.minutes.low.v1 один раз за период.
    → {debit, overage} или None (повтор)."""
    billable = max(0, int(billable))
    if hold.status == "settled":
        return None
    period = await db.get(Period, hold.period_id, populate_existing=True)
    bal = await balance(db, hold.period_id)
    if period is None or bal is None:
        return None
    ref = f"{hold.ref_kind}:{hold.ref_id}"
    period_live = period.status == "active"
    if hold.status == "active":
        # снять удержание: его минуты снова в «доступно» активного периода; у закончившегося — только они
        bal.held = max(0, bal.held - hold.minutes)
        free = available(bal) if period_live else min(int(hold.minutes), available(bal))
        debit = min(billable, free)
        overage = billable - debit
        await post(db, bal, kind="debit", minutes=-debit, ref_kind=hold.ref_kind, ref_id=str(hold.ref_id),
                   key=f"debit:{ref}", actor="system", at=at, learner_id=hold.learner_id, overage=overage)
        rest = hold.minutes - debit
        if not period_live and rest > 0:
            await post(db, bal, kind="expire", minutes=-rest, ref_kind="hold", ref_id=str(hold.hold_id),
                       key=f"expire:hold:{hold.hold_id}", actor="system", at=at)
        if overage and debit == 0:
            bal.overage += overage  # запись реестра с 0 минут не пишется — перерасход только в итоге
        hold.status, hold.settled_at = "settled", at
    else:  # expired: минуты уже вернулись в доступные; пункт сверки — он же отметка «опоздавшее уже учтено»
        free = available(bal) if period_live else 0
        debit = min(billable, free)
        overage = billable - debit
        first = await recon_item(db, "hold_expired", f"hold_expired:late:{hold.hold_id}", at=at,
                                 period_id=hold.period_id,
                                 details={"hold_id": str(hold.hold_id), "ref_kind": hold.ref_kind,
                                          "billable": billable, "debit": debit})
        if not first:
            return None
        await post(db, bal, kind="debit", minutes=-debit, ref_kind=hold.ref_kind, ref_id=str(hold.ref_id),
                   key=f"debit:{ref}", actor="system", at=at, learner_id=hold.learner_id, overage=overage)
        if overage and debit == 0:
            bal.overage += overage
    hold.settled_minutes, hold.overage = debit, overage
    bal.updated_at = at
    await db.flush()
    if period_live and bal.granted > 0 and not bal.low_notified \
            and available(bal) * 100 <= low_percent * bal.granted:
        bal.low_notified = True
        await emit_event(db, MINUTES_LOW, {"account_id": str(bal.account_id), "period_id": str(bal.period_id),
                                           "minutes_left": available(bal), "minutes_granted": int(bal.granted)},
                         causation_id=causation_id)
    return {"debit": debit, "overage": overage}


async def hold_by_ref(db: AsyncSession, ref_kind: str, ref_id: uuid.UUID) -> MinuteHold | None:
    return await db.scalar(select(MinuteHold).where(MinuteHold.ref_kind == ref_kind, MinuteHold.ref_id == ref_id)
                           .execution_options(populate_existing=True))
