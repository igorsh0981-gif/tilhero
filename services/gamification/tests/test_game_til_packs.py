"""Спринт 8 — тилы за деньги (INTERNAL_API спринта 8 §6, AT-93, AT-94): billing.order.paid.v1 → операция purchase
(ключ purchase:<order_id>, без лимитов, множителей и XP недели) → game.til_pack.credited.v1; billing.order.refunded.v1
→ обратная запись или tils_spent → game.til_pack.reversed.v1; только от billing, любой канал; повтор события — без
второй операции; возврат раньше начисления — повтор доставки; by-order — только billing; сага."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from typing import Any

import pytest
from conftest import Env

from tilhero_common.errors import TransientError
from tilhero_common.internal_auth import HEADER, issue_token
from tilhero_common.messaging import Envelope, make_envelope


def _paid(order_id: uuid.UUID, beneficiary: uuid.UUID, til: int = 550, *, account: uuid.UUID | None = None,
          channel: str = "miniapp", kind: str = "til_pack", code: str = "til_550") -> dict[str, Any]:
    stars = channel in ("miniapp", "renewal")
    return {
        "order_id": str(order_id), "order_no": 100001, "account_id": str(account or beneficiary),
        "beneficiary_user_id": str(beneficiary), "channel": channel, "product_kind": kind, "product_code": code,
        "product_title": {"ru": f"{til} тилов", "uz": f"{til} til"}, "currency": "XTR" if stars else "UZS",
        "amount_tiyin": None if stars else 2500000, "amount_stars": 120 if stars else None,
        "provider": "telegram_stars" if stars else "click", "til": til if kind == "til_pack" else None,
        "period": None, "paid_at": "2026-11-20T05:00:00Z"}


def _refunded(order_id: uuid.UUID, beneficiary: uuid.UUID | None, *, account: uuid.UUID | None = None,
              kind: str = "til_pack") -> dict[str, Any]:
    return {
        "order_id": str(order_id), "order_no": 100001,
        "account_id": str(account or beneficiary) if (account or beneficiary) else None,
        "beneficiary_user_id": str(beneficiary) if beneficiary else None, "channel": "miniapp", "product_kind": kind,
        "currency": "XTR", "amount_tiyin": None, "amount_stars": 120, "refund_id": str(uuid.uuid4()),
        "initiated_by": "staff", "refunded_at": "2026-11-21T05:00:00Z"}


async def _ops(env: Env, user: uuid.UUID, reason: str) -> list[Any]:
    return [o for o in await env.ops(user) if o.reason == reason]


async def _by_order(env: Env, order_id: uuid.UUID, issuer: str = "billing", expect: int = 200) -> Any:
    r = await env.c.get(f"/internal/v1/game/purchases/by-order/{order_id}", headers=env.svc(issuer))
    assert r.status_code == expect, r.text
    return r.json()


async def test_paid_til_pack_credited_once_and_acknowledged(env: Env, user: uuid.UUID) -> None:
    order = uuid.uuid4()
    # событие недели «×2 тилов за уроки» и дневной лимит тилов 60 не касаются покупки
    await env.week_event([{"action": "lesson", "currency": "til", "factor": 2}])
    e = await env.publish("billing.order.paid.v1", _paid(order, user, til=1200), "billing")
    assert (await env.wallet(user))["til"] == 1200
    [op] = await _ops(env, user, "purchase")
    assert (op.currency, op.amount, op.capped, float(op.multiplier), op.idempotency_key) == (
        "til", 1200, False, 1.0, f"purchase:{order}")
    rows = await env.sql("SELECT source_kind, source_ref, actor, league_week, source_session_id FROM ledger "
                         "WHERE op_id = :o", o=op.op_id)
    assert rows[0] == ("event", str(order), "system", None, None)
    [ack] = await env.events("game.til_pack.credited.v1")
    assert ack.payload == {"order_id": str(order), "user_id": str(user), "til": 1200, "op_id": str(op.op_id),
                           "outcome": "credited", "credited_at": ack.payload["credited_at"]}
    assert ack.causation_id == e.event_id
    # тот же event_id (inbox) и другое событие того же заказа — без второй операции, подтверждение повторяется
    await env.publish("billing.order.paid.v1", {}, "billing", env=e)
    await env.publish("billing.order.paid.v1", _paid(order, user, til=1200), "billing")
    assert (await env.wallet(user))["til"] == 1200 and len(await _ops(env, user, "purchase")) == 1
    acks = await env.events("game.til_pack.credited.v1")
    assert len(acks) == 2 and {a.payload["op_id"] for a in acks} == {str(op.op_id)}
    # история ученика: операция purchase видна, без actor и комментариев
    hist = await env.get(user, "history", params={"currency": "til"})
    assert [(i["reason"], i["amount"]) for i in hist["items"]] == [("purchase", 1200)]
    assert await _by_order(env, order) == {"order_id": str(order), "credited": True, "til": 1200,
                                           "til_balance": 1200, "status": "credited"}


@pytest.mark.parametrize("channel", ["miniapp", "web"])
async def test_any_channel_credits(env: Env, user: uuid.UUID, channel: str) -> None:
    await env.publish("billing.order.paid.v1", _paid(uuid.uuid4(), user, til=100, channel=channel), "billing")
    assert (await env.wallet(user))["til"] == 100


async def test_parent_buys_tils_for_child(env: Env) -> None:
    parent, kid = uuid.uuid4(), uuid.uuid4()
    await env.publish("billing.order.paid.v1", _paid(uuid.uuid4(), kid, til=100, account=parent), "billing")
    assert (await env.wallet(kid))["til"] == 100 and (await env.wallet(parent))["til"] == 0
    rows = await env.sql("SELECT kind, account_id FROM learners WHERE user_id = :u", u=kid)
    assert rows[0] == ("child", parent)


async def test_ignores_subscription_and_foreign_producers(env: Env, user: uuid.UUID) -> None:
    await env.publish("billing.order.paid.v1", _paid(uuid.uuid4(), user, kind="subscription", code="plus_30d"),
                      "billing")
    for producer in ("telegram-bff", "gamification", "lessons"):
        await env.publish("billing.order.paid.v1", _paid(uuid.uuid4(), user), producer)
        await env.publish("billing.order.refunded.v1", _refunded(uuid.uuid4(), user), producer)
    assert (await env.wallet(user))["til"] == 0 and await env.events("game.til_pack.credited.v1") == []
    assert await env.sql("SELECT count(*) FROM til_orders") == [(0,)]


async def test_deleted_beneficiary_not_resurrected(env: Env, user: uuid.UUID) -> None:
    await env.publish("user.deletion.requested.v1", {"user_id": str(user), "request_id": str(uuid.uuid4()),
                                                     "requested_at": env.ts()}, "identity-consent")
    order = uuid.uuid4()
    await env.publish("billing.order.paid.v1", _paid(order, user), "billing")
    assert await env.sql("SELECT count(*) FROM ledger WHERE user_id = :u", u=user) == [(0,)]
    assert await env.sql("SELECT count(*) FROM learners WHERE user_id = :u", u=user) == [(0,)]
    [ack] = await env.events("game.til_pack.credited.v1")
    assert ack.payload["outcome"] == "user_deleted" and ack.payload["op_id"] is None and ack.payload["til"] == 550
    await env.publish("billing.order.refunded.v1", _refunded(order, user), "billing")
    [rev] = await env.events("game.til_pack.reversed.v1")
    assert rev.payload["outcome"] == "user_deleted" and rev.payload["user_id"] == str(user)


async def test_refund_reverses_when_balance_allows(env: Env, user: uuid.UUID) -> None:
    order = uuid.uuid4()
    await env.publish("billing.order.paid.v1", _paid(order, user, til=550), "billing")
    [op] = await _ops(env, user, "purchase")
    e = await env.publish("billing.order.refunded.v1", _refunded(order, user), "billing")
    assert (await env.wallet(user))["til"] == 0
    [rev] = await _ops(env, user, "reversal")
    assert rev.amount == -550 and rev.idempotency_key == f"reversal:{op.op_id}"
    rows = await env.sql("SELECT status, reversed_by FROM ledger WHERE op_id = :o", o=op.op_id)
    assert rows[0] == ("reversed", rev.op_id)
    rows = await env.sql("SELECT reversal_of, actor, source_kind FROM ledger WHERE op_id = :o", o=rev.op_id)
    assert rows[0] == (op.op_id, "system", "event")
    [ack] = await env.events("game.til_pack.reversed.v1")
    assert ack.payload == {"order_id": str(order), "user_id": str(user), "outcome": "reversed",
                           "at": ack.payload["at"]} and ack.causation_id == e.event_id
    # повтор возврата (то же событие и новое) — без второй обратной записи; подтверждение повторяется
    await env.publish("billing.order.refunded.v1", {}, "billing", env=e)
    await env.publish("billing.order.refunded.v1", _refunded(order, user), "billing")
    assert len(await _ops(env, user, "reversal")) == 1 and (await env.wallet(user))["til"] == 0
    assert [a.payload["outcome"] for a in await env.events("game.til_pack.reversed.v1")] == ["reversed"] * 2
    # повторная оплата того же заказа после возврата — тилы не начисляются снова
    await env.publish("billing.order.paid.v1", _paid(order, user, til=550), "billing")
    assert (await env.wallet(user))["til"] == 0 and len(await _ops(env, user, "purchase")) == 1
    got = await _by_order(env, order)
    assert got["credited"] is False and got["status"] == "reversed" and got["til_balance"] == 0


async def test_refund_after_tils_spent_no_operation(env: Env, user: uuid.UUID) -> None:
    order = uuid.uuid4()
    await env.publish("billing.order.paid.v1", _paid(order, user, til=100), "billing")
    await env.buy(user, "streak_freeze")  # часть тилов потрачена в магазине
    balance = (await env.wallet(user))["til"]
    assert balance < 100
    pre = await _by_order(env, order)
    assert pre == {"order_id": str(order), "credited": True, "til": 100, "til_balance": balance,
                   "status": "credited"}  # billing видит: возврат вернёт деньги без тилов (пункт сверки)
    await env.publish("billing.order.refunded.v1", _refunded(order, user), "billing")
    assert (await env.wallet(user))["til"] == balance and await _ops(env, user, "reversal") == []
    [ack] = await env.events("game.til_pack.reversed.v1")
    assert ack.payload["outcome"] == "tils_spent"
    assert (await _by_order(env, order))["status"] == "tils_spent"
    [op] = await _ops(env, user, "purchase")
    assert op.status == "confirmed"  # частичных обратных записей нет


async def test_refund_before_credit_is_redelivered(env: Env, user: uuid.UUID) -> None:
    order = uuid.uuid4()
    refund = make_envelope("billing.order.refunded.v1", _refunded(order, user), producer="billing")
    with pytest.raises(TransientError):
        await env.publish("billing.order.refunded.v1", {}, "billing", env=refund)
    assert [d for d, _ in env.bus.transient] == ["gamification.billing"]  # повтор без DLQ
    assert await env.events("game.til_pack.reversed.v1") == []
    await env.publish("billing.order.paid.v1", _paid(order, user, til=100), "billing")
    env.bus.errors.clear()
    env.bus.transient.clear()
    [spec] = [x for x in env.bus.specs if x.durable == "gamification.billing"]
    await spec.handler(refund)  # повтор доставки шиной (NATS: nak с задержкой)
    await env.flush()
    assert (await env.wallet(user))["til"] == 0
    [ack] = await env.events("game.til_pack.reversed.v1")
    assert ack.payload["outcome"] == "reversed"


async def test_refund_of_anonymized_order(env: Env, user: uuid.UUID) -> None:
    credited, unknown = uuid.uuid4(), uuid.uuid4()
    await env.publish("billing.order.paid.v1", _paid(credited, user, til=100), "billing")
    # заказ обезличен сагой billing (получатель жив — детский профиль родителя, удалённого раньше)
    await env.publish("billing.order.refunded.v1", _refunded(credited, None), "billing")
    [ack] = await env.events("game.til_pack.reversed.v1")
    assert ack.payload["user_id"] == str(user) and ack.payload["outcome"] == "reversed"
    # обезличен и не начислялся — подтверждать некому
    await env.publish("billing.order.refunded.v1", _refunded(unknown, None), "billing")
    assert len(await env.events("game.til_pack.reversed.v1")) == 1


async def test_concurrent_paid_events_single_operation(env: Env, user: uuid.UUID) -> None:
    order = uuid.uuid4()
    envs: list[Envelope] = [make_envelope("billing.order.paid.v1", _paid(order, user, til=100), producer="billing")
                            for _ in range(3)]
    env.now += timedelta(seconds=1)
    await asyncio.gather(*(env.bus.publish(e) for e in envs))
    await env.flush()
    assert env.bus.errors == []
    assert (await env.wallet(user))["til"] == 100 and len(await _ops(env, user, "purchase")) == 1
    assert len(await env.events("game.til_pack.credited.v1")) == 3  # подтверждение — на каждое событие


async def test_by_order_only_billing(env: Env, user: uuid.UUID) -> None:
    assert (await _by_order(env, uuid.uuid4(), expect=404))["code"] == "PURCHASE_NOT_FOUND"
    order = uuid.uuid4()
    await env.publish("billing.order.paid.v1", _paid(order, user, til=100), "billing")
    for issuer in ("telegram-bff", "admin-bff", "lessons"):
        assert (await _by_order(env, order, issuer=issuer, expect=403))["code"] == "CALLER_NOT_ALLOWED"
    r = await env.c.get(f"/internal/v1/game/purchases/by-order/{order}")
    assert r.status_code == 401
    # ученик не достаёт покупку по заказу своим токеном
    token = issue_token(env.settings.internal_jwt_secret.get_secret_value(), issuer="telegram-bff",
                        audience="gamification", subject=str(user), extra={"lrn": str(user)})
    r = await env.c.get(f"/internal/v1/game/purchases/by-order/{order}", headers={HEADER: token})
    assert r.status_code == 403


async def test_saga_deletes_til_orders(env: Env, user: uuid.UUID) -> None:
    order = uuid.uuid4()
    await env.publish("billing.order.paid.v1", _paid(order, user, til=100), "billing")
    await env.publish("user.deletion.requested.v1", {"user_id": str(user), "request_id": str(uuid.uuid4()),
                                                     "requested_at": env.ts()}, "identity-consent")
    assert await env.sql("SELECT count(*) FROM til_orders") == [(0,)]
    assert (await _by_order(env, order, expect=404))["code"] == "PURCHASE_NOT_FOUND"


async def test_staff_cannot_reverse_purchase_operation(env: Env, user: uuid.UUID) -> None:
    await env.publish("billing.order.paid.v1", _paid(uuid.uuid4(), user, til=100), "billing")
    [op] = await _ops(env, user, "purchase")
    r = await env.adm("POST", f"wallets/{user}/ledger/{op.op_id}/reverse", {"reason": "попытка вернуть тилы"},
                      expect=409)
    assert r["code"] == "OPERATION_NOT_REVERSIBLE"  # деньги возвращает только billing (возврат заказа)
