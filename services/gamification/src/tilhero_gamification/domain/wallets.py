"""Кошельки учеников в админке (§1.11, AT-72): баланс и операции, ручное начисление или списание (wallet.adjust +
step-up, причина ≥ 10, отдельной записью reason manual), обратная запись (reversal, исходная → reversed), возврат
покупки. Баланс не уходит в минус (409 BALANCE_NEGATIVE). Каждая команда — аудит admin.audit.recorded.v1."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict, not_found
from tilhero_common.internal_auth import Actor
from tilhero_gamification.domain.common import (
    cursor_time_id,
    emit_audit,
    encode_cursor,
    idempotency_reused,
    iso,
    local_date,
    wallet_not_found,
    zone,
)
from tilhero_gamification.domain.engine import Turn, learner_audience, open_turn
from tilhero_gamification.models import (
    Badge,
    Learner,
    Ledger,
    Ownership,
    Purchase,
    Quest,
    Referral,
    ReferralReward,
    ShopItem,
    Wallet,
)
from tilhero_gamification.settings import Settings

NOT_REVERSIBLE = ("reversal", "shop", "purchase")


def op_not_found() -> ApiError:
    return not_found("OPERATION_NOT_FOUND", "Операция не найдена")


def admin_op(op: Ledger) -> dict[str, Any]:
    """AdminLedgerOperation (admin.ts): все поля, включая actor и comment."""
    return {"op_id": str(op.op_id), "currency": op.currency, "amount": op.amount, "reason": op.reason,
            "source": {"kind": op.source_kind, "ref": op.source_ref}, "rules_version": op.rules_version,
            "multiplier": _num(op.multiplier), "capped": bool(op.capped), "local_date": op.local_date.isoformat(),
            "status": op.status, "reversed_by": str(op.reversed_by) if op.reversed_by else None,
            "reversal_of": str(op.reversal_of) if op.reversal_of else None, "actor": op.actor,
            "comment": op.comment, "created_at": iso(op.created_at)}


def learner_op(op: Ledger) -> dict[str, Any]:
    """GameOperation (bff.ts): без actor и комментария сотрудника."""
    return {"op_id": str(op.op_id), "currency": op.currency, "amount": op.amount, "reason": op.reason,
            "capped": bool(op.capped), "multiplier": _num(op.multiplier), "status": op.status,
            "created_at": iso(op.created_at)}


def _num(value: Any) -> float | int:
    f = float(value)
    return int(f) if f.is_integer() else f


async def page(session: AsyncSession, user_id: uuid.UUID, *, currency: str | None, cursor: str | None,
               limit: int) -> tuple[list[Ledger], str | None]:
    """Операции ученика, новые сверху (created_at, op_id)."""
    stmt = select(Ledger).where(Ledger.user_id == user_id)
    if currency is not None:
        stmt = stmt.where(Ledger.currency == currency)
    after = cursor_time_id(cursor)
    if after is not None:
        at, oid = after
        stmt = stmt.where(or_(Ledger.created_at < at, and_(Ledger.created_at == at, Ledger.op_id < oid)))
    rows = list((await session.execute(stmt.order_by(Ledger.created_at.desc(), Ledger.op_id.desc())
                                       .limit(limit + 1))).scalars().all())
    nxt = None
    if len(rows) > limit:
        rows = rows[:limit]
        nxt = encode_cursor(rows[-1].created_at.isoformat(), str(rows[-1].op_id))
    return rows, nxt


async def wallet_view(session: AsyncSession, settings: Settings, user_id: uuid.UUID, now: datetime) -> dict[str, Any]:
    learner = await session.get(Learner, user_id)
    if learner is None:
        raise wallet_not_found()
    wallet = await session.get(Wallet, user_id)
    today = local_date(now, zone(learner.timezone, settings.default_timezone))
    owned = (await session.execute(select(Ownership).where(Ownership.user_id == user_id)
                                   .order_by(Ownership.purchased_at))).scalars().all()
    kinds = {r[0]: r[1] for r in (await session.execute(select(ShopItem.code, ShopItem.kind).where(
        ShopItem.code.in_([o.item_code for o in owned])))).all()} if owned else {}
    quests = (await session.execute(select(Quest).where(Quest.user_id == user_id, Quest.local_date == today,
                                                        Quest.slot >= 1).order_by(Quest.slot))).scalars().all()
    badges = (await session.execute(select(Badge).where(Badge.user_id == user_id)
                                    .order_by(Badge.earned_at))).scalars().all()
    refs = {r[0]: int(r[1]) for r in (await session.execute(select(Referral.status, func.count()).where(
        Referral.inviter_user_id == user_id).group_by(Referral.status))).all()}
    # спринт 7: награды по реферальной кампании social (история спринта 6 — referrals)
    refs["rewarded"] = refs.get("rewarded", 0) + int(await session.scalar(select(func.count()).select_from(
        ReferralReward).where(ReferralReward.inviter_user_id == user_id, ReferralReward.outcome == "rewarded")) or 0)
    return {
        "user_id": str(user_id), "audience": learner_audience(learner),
        "level": int(wallet.level) if wallet else 1, "xp_total": int(wallet.xp_total) if wallet else 0,
        "til_balance": int(wallet.til_balance) if wallet else 0,
        "freeze_stock": int(wallet.freeze_stock) if wallet else 0,
        "hero": {"code": learner.hero_code, "stage": int(learner.hero_stage)} if learner.hero_code else None,
        "confirmed_skills": int(learner.confirmed_skills),
        "owned_items": [{"code": o.item_code, "kind": kinds.get(o.item_code, "background"),
                         "purchased_at": iso(o.purchased_at), "purchase_id": str(o.purchase_id)} for o in owned],
        "quests_today": [{"code": q.template_code, "kind": q.kind, "target": q.target, "progress": q.progress,
                          "status": q.status} for q in quests],
        "badges": [{"code": b.badge_code, "earned_at": iso(b.earned_at)} for b in badges],
        "referrals": {"pending": int(refs.get("pending", 0)), "rewarded": int(refs.get("rewarded", 0)),
                      "capped": int(refs.get("capped", 0))},
        "settings": {"auto_freeze": bool(learner.auto_freeze), "quests_hidden": bool(learner.quests_hidden)},
    }


async def _staff_turn(session: AsyncSession, settings: Settings, user_id: uuid.UUID, now: datetime) -> Turn:
    if await session.get(Learner, user_id) is None:
        raise wallet_not_found()
    turn = await open_turn(session, settings, now, user_id)
    if turn is None:
        raise wallet_not_found()
    return turn


async def adjust(session: AsyncSession, settings: Settings, actor: Actor, user_id: uuid.UUID, currency: str,
                 amount: int, reason: str, key: str, now: datetime) -> dict[str, Any]:
    """Ручная операция (reason manual, actor staff:<id>, comment = причина): отдельной записью; минус не ниже 0."""
    turn = await _staff_turn(session, settings, user_id, now)
    adjustment_id = uuid.uuid4()
    op = await turn.post(currency=currency, amount=amount, reason="manual", key=f"manual:{actor.id}:{key}",
                         source_kind="staff", source_ref=str(adjustment_id), actor=f"staff:{actor.id}"[:80],
                         comment=reason[:300], use_session=False)
    if op is None:  # ключ уже использован, а сохранённый ответ очищен по сроку — как везде, 422
        raise idempotency_reused()
    if currency == "xp" and amount > 0:
        await turn.check_level()
    await emit_audit(session, actor, "game.wallet.adjusted", "game_wallet", str(user_id),
                     after={"op_id": str(op.op_id), "currency": currency, "amount": amount,
                            "balance": turn.balance(currency)}, reason=reason)
    return admin_op(op)


async def _reverse(turn: Turn, actor: Actor, op: Ledger, reason: str) -> Ledger:
    if op.status == "reversed":
        raise conflict("ALREADY_REVERSED", "Операция уже отменена", {"reversed_by": str(op.reversed_by)})
    reversal = await turn.post(currency=op.currency, amount=-op.amount, reason="reversal",
                               key=f"reversal:{op.op_id}", source_kind="staff", source_ref=str(op.op_id),
                               actor=f"staff:{actor.id}"[:80], comment=reason[:300], reversal_of=op.op_id,
                               use_session=False)
    if reversal is None:
        raise conflict("ALREADY_REVERSED", "Операция уже отменена")
    op.status = "reversed"
    op.reversed_by = reversal.op_id
    return reversal


async def reverse(session: AsyncSession, settings: Settings, actor: Actor, user_id: uuid.UUID, op_id: uuid.UUID,
                  reason: str, now: datetime) -> dict[str, Any]:
    """Обратная запись: reason reversal, amount = −исходная, исходная → reversed. Уровень и ступень не меняются."""
    turn = await _staff_turn(session, settings, user_id, now)
    op = (await session.execute(select(Ledger).where(Ledger.op_id == op_id, Ledger.user_id == user_id)
                                .with_for_update())).scalar_one_or_none()
    if op is None:
        raise op_not_found()
    if op.reason in NOT_REVERSIBLE and op.status != "reversed":
        raise conflict("OPERATION_NOT_REVERSIBLE", "Эту операцию нельзя отменить обратной записью",
                       {"reason": op.reason, "hint": "refund" if op.reason == "shop" else None})
    reversal = await _reverse(turn, actor, op, reason)
    await emit_audit(session, actor, "game.wallet.reversed", "game_ledger_op", str(op_id),
                     before={"status": "confirmed", "amount": op.amount, "currency": op.currency},
                     after={"status": "reversed", "reversal_op_id": str(reversal.op_id), "user_id": str(user_id)},
                     reason=reason)
    return admin_op(reversal)


async def refund(session: AsyncSession, settings: Settings, actor: Actor, user_id: uuid.UUID,
                 purchase_id: uuid.UUID, reason: str, now: datetime) -> dict[str, Any]:
    """Возврат покупки: обратные записи её операций, владение удаляется (и снимается с экипировки)."""
    turn = await _staff_turn(session, settings, user_id, now)
    p = (await session.execute(select(Purchase).where(Purchase.purchase_id == purchase_id,
                                                      Purchase.user_id == user_id).with_for_update())
         ).scalar_one_or_none()
    if p is None:
        raise not_found("PURCHASE_NOT_FOUND", "Покупка не найдена")
    if p.status == "refunded":
        raise conflict("ALREADY_REVERSED", "Покупка уже возвращена")
    ops = (await session.execute(select(Ledger).where(Ledger.user_id == user_id, Ledger.op_id.in_(
        [uuid.UUID(x) for x in p.op_ids])).with_for_update())).scalars().all()
    # сначала заморозка (её списание может упереться в ноль), затем возврат тилов
    out = [await _reverse(turn, actor, op, reason) for op in sorted(ops, key=lambda o: o.currency != "freeze")
           if op.status == "confirmed"]
    await session.execute(delete(Ownership).where(Ownership.user_id == user_id, Ownership.item_code == p.item_code,
                                                  Ownership.purchase_id == p.purchase_id))
    if turn.learner.background_code == p.item_code:
        turn.learner.background_code = None
    if turn.learner.frame_code == p.item_code:
        turn.learner.frame_code = None
    p.status, p.refunded_at = "refunded", now
    await emit_audit(session, actor, "game.purchase.refunded", "game_purchase", str(purchase_id),
                     before={"status": "completed", "item_code": p.item_code, "price_til": p.price_til},
                     after={"status": "refunded", "user_id": str(user_id),
                            "reversal_op_ids": [str(o.op_id) for o in out]}, reason=reason)
    return {"operations": [admin_op(o) for o in out]}
