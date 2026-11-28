"""Гонки (AGENT_BRIEF «Минимум тестов»): продление Stars одновременно с tick конца периода; возврат одновременно с
проведением; удаление аккаунта одновременно с заказом (проверка «удалён?» после блокировки); админ-чтения заказов."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

from conftest import Env

from tilhero_billing.domain.ports import StarsRecurrence


async def test_renewal_concurrent_with_period_end_tick(env: Env) -> None:
    a = await env.account()
    o = await env.order(a, "plus_30d", expect=201)
    oid = (await env.one("SELECT order_id FROM orders WHERE order_no = :n", n=o["order_no"]))[0]
    exp1 = env.now + timedelta(days=30)
    await env.pay.paid("telegram_stars", "ch-r1", f"o:{oid}", 250, payer_account_id=a,
                       recurring=StarsRecurrence(True, True, exp1), provider_time=env.now, meta={})
    env.now = exp1 + timedelta(seconds=30)
    exp2 = exp1 + timedelta(days=30)
    paid, tick = await asyncio.gather(
        env.pay.paid("telegram_stars", "ch-r2", f"o:{oid}", 250, payer_account_id=a,
                     recurring=StarsRecurrence(True, False, exp2), provider_time=env.now, meta={}),
        env.tick())
    assert paid.state == "performed" and tick["skipped"] is False
    await env.tick()
    rows = await env.sql("SELECT status, starts_at, ends_at FROM periods WHERE account_id = :a ORDER BY created_at",
                         a=a)
    assert [r[0] for r in rows] == ["ended", "active"]
    assert rows[1][1] == exp1 and rows[1][2] == exp2  # продолжение без разрыва, до subscription_expiration_date
    assert (await env.get(a, "subscription"))["status"] == "active"


async def test_refund_concurrent_with_perform(env: Env) -> None:
    a = await env.account()
    o = await env.order(a, "til_100", "click", expect=201)
    oid = (await env.one("SELECT order_id FROM orders WHERE order_no = :n", n=o["order_no"]))[0]
    await env.pay.create("click", "c-race", str(o["order_no"]), 500_000, env.now, {})
    perform, refund = await asyncio.gather(
        env.pay.perform("click", "c-race"),
        env.c.post(f"/internal/v1/admin/billing/orders/{oid}/refunds", json={"reason": "гонка с проведением"},
                   headers={**env.staff(), "Idempotency-Key": "k-race-refund"}))
    assert perform.state == "performed"
    assert refund.status_code in (201, 409)
    state = (await env.one("SELECT o.status, t.state FROM orders o JOIN provider_transactions t USING (order_id)"))
    if refund.status_code == 201:
        assert tuple(state) == ("refunded", "refunded")
    else:
        assert refund.json()["details"]["reason"] == "not_paid" and tuple(state) == ("paid", "performed")


async def test_deletion_concurrent_with_order(env: Env) -> None:
    for _ in range(3):
        a = await env.account()
        results = await asyncio.gather(env.order(a, "til_100", expect=(200, 201, 410)), env.delete(a),
                                       return_exceptions=True)
        assert not any(isinstance(r, BaseException) for r in results), results
        live = await env.sql("SELECT status FROM orders WHERE account_id = :a", a=a)
        assert live == []  # заказ до удаления — обезличен и отменён; после — 410 USER_DELETED
    assert (await env.one("SELECT count(*) FROM orders WHERE status = 'pending'"))[0] == 0


async def test_admin_order_listing_and_filters(env: Env) -> None:
    a = await env.account()
    s = await env.order(a, "til_100", expect=201)
    w = await env.order(a, "til_550", "payme", expect=201)
    await env.pay.create("payme", "pm-list", str(w["order_no"]), 2_500_000, env.now, {})
    rows = await env.adm("GET", "orders?channel=web")
    assert [r["order_no"] for r in rows["items"]] == [w["order_no"]]
    rows = await env.adm("GET", "orders?provider_txn_id=pm-list")
    assert rows["items"][0]["amount_tiyin"] == 2_500_000 and rows["items"][0]["amount_stars"] is None
    rows = await env.adm("GET", f"orders?account_id={a}&order_no={s['order_no']}")
    assert rows["items"][0]["currency"] == "XTR"
    card = await env.adm("GET", f"orders/{rows['items'][0]['order_id']}")
    assert card["can_refund"] is False and card["product_snapshot"]["price_stars"] == 15
    await env.adm("GET", f"orders/{uuid.uuid4()}", None, 404)
    await env.adm("GET", "orders", None, 403, perms=("dashboard.read",))
    acc = await env.adm("GET", f"accounts/{a}")
    assert acc["status"] == "none" and acc["tier"] == "free" and acc["periods"] == []
