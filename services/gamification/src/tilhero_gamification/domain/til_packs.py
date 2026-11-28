"""Тилы за деньги (INTERNAL_API спринта 8 §6, PLAN решение 14): gamification денег не знает — начисляет пакет тилов по
событию billing и подтверждает его.

- `billing.order.paid.v1` (только издатель billing; `product_kind til_pack`, любой канал — Mini App за Stars или сайт):
  под блокировкой получателя; удалённый — без операции (`outcome user_deleted`); операция реестра `til +til`, reason
  `purchase`, ключ `purchase:<order_id>` — без дневного лимита, множителей событий недели и XP недели (это не
  активность); строка til_orders; подтверждение `game.til_pack.credited.v1` (billing → заказ «выполнен»).
- `billing.order.refunded.v1` (`til_pack`): на балансе ≥ пакета — обратная запись (системный путь: reason reversal,
  исходная операция → reversed) → `reversed`; иначе — `tils_spent` без операции (частичных обратных записей нет,
  billing заводит пункт сверки) → `game.til_pack.reversed.v1`.
- Идемпотентность: повтор события (тот же event_id — inbox; другой event_id того же заказа — строка til_orders и ключ
  операции) второй операции не делает и лишь повторяет подтверждение с сохранёнными данными.
- Возврат раньше начисления (события пришли не по порядку): заказ ещё не начислен → TransientError, шина повторит
  доставку после `paid` (оплата всегда опубликована раньше возврата — outbox billing).
- `GET /internal/v1/game/purchases/by-order/{order_id}` (только billing) — пред-проверка возврата: сколько куплено и
  сколько на балансе получателя.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, TransientError, not_found
from tilhero_gamification.domain.common import (
    TIL_PACK_CREDITED,
    TIL_PACK_REVERSED,
    emit_event,
    iso,
    lock_user,
    parse_ts,
)
from tilhero_gamification.domain.engine import is_deleted, open_turn
from tilhero_gamification.models import Ledger, TilOrder, Wallet
from tilhero_gamification.settings import Settings

log = logging.getLogger("tilhero.gamification.til_packs")

TIL_PACK = "til_pack"
TIL_MAX = 100_000


def purchase_not_found() -> ApiError:
    return not_found("PURCHASE_NOT_FOUND", "Покупка тилов по заказу не найдена")


def _uuid(value: object) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None


def _til(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= TIL_MAX else None


def purchase_key(order_id: uuid.UUID) -> str:
    return f"purchase:{order_id}"


async def _ack_credited(session: AsyncSession, order_id: uuid.UUID, user_id: uuid.UUID, til: int,
                        op_id: uuid.UUID | None, outcome: str, at: datetime, causation_id: str | None) -> None:
    await emit_event(session, TIL_PACK_CREDITED, {
        "order_id": str(order_id), "user_id": str(user_id), "til": til, "op_id": str(op_id) if op_id else None,
        "outcome": outcome, "credited_at": iso(at)}, causation_id=causation_id)


async def _ack_reversed(session: AsyncSession, order_id: uuid.UUID, user_id: uuid.UUID, outcome: str, at: datetime,
                        causation_id: str | None) -> None:
    await emit_event(session, TIL_PACK_REVERSED, {
        "order_id": str(order_id), "user_id": str(user_id), "outcome": outcome, "at": iso(at)},
        causation_id=causation_id)


async def _locked_row(session: AsyncSession, order_id: uuid.UUID) -> TilOrder | None:
    return (await session.execute(select(TilOrder).where(TilOrder.order_id == order_id).with_for_update()
                                  .execution_options(populate_existing=True))).scalar_one_or_none()


# ---------------------------------------------------------------- оплата → начисление


async def on_order_paid(session: AsyncSession, settings: Settings, now: datetime, payload: dict[str, Any],
                        event_id: str | None) -> None:
    """billing.order.paid.v1 → пакет тилов получателю (один раз на заказ) → game.til_pack.credited.v1."""
    if payload.get("product_kind") != TIL_PACK:
        return  # подписка — не наша (периоды и минуты — billing)
    order_id = _uuid(payload.get("order_id"))
    user_id = _uuid(payload.get("beneficiary_user_id"))
    til = _til(payload.get("til"))
    if order_id is None or user_id is None or til is None:
        # не по контракту: без начисления и подтверждения — billing увидит «оплачено, не выполнено» (сверка)
        log.error("til pack paid event malformed", extra={"has_til": til is not None})
        return
    account_id = _uuid(payload.get("account_id"))
    await lock_user(session, user_id)
    if await is_deleted(session, user_id):
        await _ack_credited(session, order_id, user_id, til, None, "user_deleted", now, event_id)
        return
    row = await _locked_row(session, order_id)
    if row is not None:
        # повтор оплаты того же заказа: второй операции нет, подтверждение — ещё раз (billing идемпотентен)
        await _ack_credited(session, order_id, row.user_id, row.til, row.op_id, "credited", row.credited_at,
                            event_id)
        return
    child = account_id is not None and account_id != user_id  # ребёнку тилы покупает родитель (§0.5)
    turn = await open_turn(session, settings, now, user_id, event_id=event_id, account_id=account_id,
                           kind="child" if child else None, at=parse_ts(payload.get("paid_at"), now))
    if turn is None:
        await _ack_credited(session, order_id, user_id, til, None, "user_deleted", now, event_id)
        return
    op = await turn.post(currency="til", amount=til, reason="purchase", key=purchase_key(order_id),
                         source_kind="event", source_ref=str(order_id), actor="system", use_session=False)
    op_id = op.op_id if op is not None else await _op_by_key(session, user_id, purchase_key(order_id))
    session.add(TilOrder(order_id=order_id, user_id=user_id, til=til, op_id=op_id, reversal_op_id=None,
                         status="credited", credited_at=now, reversed_at=None))
    await session.flush()
    log.info("til pack credited", extra={"til": til})
    await _ack_credited(session, order_id, user_id, til, op_id, "credited", now, event_id)


async def _op_by_key(session: AsyncSession, user_id: uuid.UUID, key: str) -> uuid.UUID:
    """Операция по ключу уже проведена (строки заказа нет — например, восстановление из реестра): её op_id."""
    op_id = (await session.execute(select(Ledger.op_id).where(Ledger.user_id == user_id,
                                                              Ledger.idempotency_key == key))).scalar_one()
    return uuid.UUID(str(op_id))


# ---------------------------------------------------------------- возврат → обратная запись


async def on_order_refunded(session: AsyncSession, settings: Settings, now: datetime, payload: dict[str, Any],
                            event_id: str | None) -> None:
    """billing.order.refunded.v1 → обратная запись пакета (баланс ≥ пакета) или tils_spent →
    game.til_pack.reversed.v1."""
    if payload.get("product_kind") != TIL_PACK:
        return
    order_id = _uuid(payload.get("order_id"))
    if order_id is None:
        log.error("til pack refund event malformed")
        return
    known = await session.get(TilOrder, order_id)
    user_id = known.user_id if known is not None else _uuid(payload.get("beneficiary_user_id"))
    if user_id is None:
        # заказ обезличен сагой billing, а строки начисления нет — данные получателя удалены: подтверждать некому
        log.info("til pack refund for anonymized order without credit")
        return
    await lock_user(session, user_id)
    if await is_deleted(session, user_id):
        await _ack_reversed(session, order_id, user_id, "user_deleted", now, event_id)
        return
    row = await _locked_row(session, order_id)
    if row is None:
        # возврат пришёл раньше начисления: повтор доставки после billing.order.paid.v1
        raise TransientError("til pack refund before credit")
    if row.status != "credited":
        # повтор возврата: второй обратной записи нет, подтверждение — ещё раз
        await _ack_reversed(session, order_id, row.user_id, row.status if row.status == "tils_spent" else "reversed",
                            row.reversed_at or now, event_id)
        return
    turn = await open_turn(session, settings, now, row.user_id, event_id=event_id)
    if turn is None:
        await _ack_reversed(session, order_id, row.user_id, "user_deleted", now, event_id)
        return
    op = (await session.execute(select(Ledger).where(Ledger.op_id == row.op_id, Ledger.user_id == row.user_id)
                                .with_for_update())).scalar_one_or_none()
    outcome = "tils_spent"
    if op is not None and op.status == "reversed" and op.reversed_by is not None:
        row.reversal_op_id, outcome = op.reversed_by, "reversed"
    elif op is not None and turn.balance("til") >= op.amount:
        key = f"reversal:{op.op_id}"
        reversal = await turn.post(currency="til", amount=-op.amount, reason="reversal", key=key,
                                   source_kind="event", source_ref=str(order_id), actor="system",
                                   reversal_of=op.op_id, use_session=False)
        reversal_id = reversal.op_id if reversal is not None else await _op_by_key(session, row.user_id, key)
        op.status, op.reversed_by = "reversed", reversal_id
        row.reversal_op_id, outcome = reversal_id, "reversed"
    row.status = outcome
    row.reversed_at = now
    await session.flush()
    log.info("til pack refund processed", extra={"outcome": outcome})
    await _ack_reversed(session, order_id, row.user_id, outcome, now, event_id)


# ---------------------------------------------------------------- пред-проверка возврата (billing)


async def by_order(session: AsyncSession, order_id: uuid.UUID) -> dict[str, Any]:
    """{order_id, credited, til, til_balance, status}: credited — тилы пакета сейчас на счету (не возвращены);
    til_balance — баланс тилов получателя. Нет начисления (или данные удалены) — 404 PURCHASE_NOT_FOUND."""
    row = await session.get(TilOrder, order_id)
    if row is None:
        raise purchase_not_found()
    wallet = await session.get(Wallet, row.user_id)
    return {"order_id": str(order_id), "credited": row.status == "credited", "til": int(row.til),
            "til_balance": int(wallet.til_balance) if wallet is not None else 0, "status": row.status}
