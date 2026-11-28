"""PaymentPort ядра (§1.4–1.5, AT-84/85/87/88, R4): машины состояний транзакции и заказа, выдача в одной транзакции с
проведением, идемпотентность по (provider, provider_txn_id), таймаут Payme, попытки Click, Stars — первый платёж,
продление, несоответствия без отказа (пункты сверки), подписка Stars, возвраты по инициативе провайдера, чеки,
выписка, гонки."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from typing import Any

import pytest
from conftest import Env

from tilhero_billing.domain import ports
from tilhero_billing.domain.ports import StarsRecurrence


async def _web(env: Env, account: uuid.UUID, product: str = "plus_30d", provider: str = "payme",
               **extra: Any) -> dict[str, Any]:
    if product.startswith("plus"):
        extra.setdefault("start_mode", "after_current")
    return dict(await env.order(account, product, provider, expect=201, **extra))


async def _oid(env: Env, order_no: int) -> uuid.UUID:
    return (await env.one("SELECT order_id FROM orders WHERE order_no = :n", n=order_no))[0]  # type: ignore[no-any-return]


async def test_payme_flow_delivers_period_once(env: Env) -> None:
    a = await env.account()
    o = await _web(env, a)
    ref, amount = str(o["order_no"]), 4_900_000
    ok = await env.pay.check("payme", ref, amount)
    assert ok.order.order_no == o["order_no"] and ok.order.amount_tiyin == amount and ok.fiscal_items == ()
    t1 = await env.pay.create("payme", "pm-1", ref, amount, env.now, {"click_paydoc_id": 1, "card_pan": "x"})
    assert t1.state == "created" and t1.provider_meta == {"click_paydoc_id": 1}  # без карт и секретов
    assert (await env.pay.create("payme", "pm-1", ref, amount, env.now, {})).txn_id == t1.txn_id
    with pytest.raises(ports.OrderBusy):  # у заказа уже есть транзакция в ожидании (Payme)
        await env.pay.create("payme", "pm-2", ref, amount, env.now, {})
    t2 = await env.pay.perform("payme", "pm-1")
    assert t2.state == "performed" and t2.performed_at is not None
    assert (await env.pay.perform("payme", "pm-1")).performed_at == t2.performed_at
    row = await env.one("SELECT status, paid_at IS NOT NULL, fulfilled_at IS NOT NULL FROM orders WHERE order_no = :n",
                        n=o["order_no"])
    assert tuple(row) == ("fulfilled", True, True)
    assert (await env.balance(a))["granted"] == 300
    sub = await env.get(a, "subscription", chn="web")
    assert sub["status"] == "active" and sub["plan"]["code"] == "plus_30d" and "stars_subscription" not in sub
    [paid] = await env.events("billing.order.paid.v1", order_id=t2.order_id)
    assert paid.payload["channel"] == "web" and paid.payload["amount_tiyin"] == amount and paid.payload["period"]
    assert await env.events("billing.subscription.changed.v1", account_id=a, reason="purchase")
    assert await env.events("billing.access.changed.v1", user_id=a, tier="paid")
    with pytest.raises(ports.AlreadyPaid):
        await env.pay.check("payme", ref, amount)
    with pytest.raises(ports.InvalidState):
        await env.pay.perform("payme", "pm-x") if False else await _perform_cancelled(env, a)


async def _perform_cancelled(env: Env, a: uuid.UUID) -> None:
    o = await _web(env, a, "til_100")
    await env.pay.create("payme", "pm-c", str(o["order_no"]), 500_000, env.now, {})
    await env.pay.cancel("payme", "pm-c", "receivers_not_found", 1)
    await env.pay.perform("payme", "pm-c")


async def test_check_errors_and_flags(env: Env) -> None:
    a = await env.account()
    o = await _web(env, a, "til_100")
    ref = str(o["order_no"])
    for bad in ("abc", "1e5", "", "99999999"):
        with pytest.raises(ports.OrderNotFound):
            await env.pay.check("payme", bad, 500_000)
    with pytest.raises(ports.OrderNotFound):  # заказ другого провайдера / канала
        await env.pay.check("click", ref, 500_000)
    stars = await env.order(a, "til_100", expect=201)
    with pytest.raises(ports.OrderNotFound):
        await env.pay.check("payme", str(stars["order_no"]), 500_000)
    with pytest.raises(ports.AmountMismatch):
        await env.pay.check("payme", ref, 500_001)
    env.settings.payme_enabled = False
    try:
        with pytest.raises(ports.PaymentsDisabled):
            await env.pay.check("payme", ref, 500_000)
        with pytest.raises(ports.PaymentsDisabled):
            await env.pay.create("payme", "pm-off", ref, 500_000, env.now, {})
    finally:
        env.settings.payme_enabled = True
    env.shift(days=2)
    with pytest.raises(ports.OrderClosed):  # истёк (tick ещё не прошёл)
        await env.pay.check("payme", ref, 500_000)


async def test_payme_timeout_cancels(env: Env) -> None:
    a = await env.account()
    o = await _web(env, a, "til_100")
    await env.pay.create("payme", "pm-t", str(o["order_no"]), 500_000, env.now - timedelta(hours=1), {})
    env.shift(hours=12)
    with pytest.raises(ports.TxnTimedOut):
        await env.pay.perform("payme", "pm-t")
    t = await env.pay.get("payme", "pm-t")
    assert t.state == "cancelled" and t.cancel_reason == "timeout" and t.provider_reason == 4
    with pytest.raises(ports.InvalidState):
        await env.pay.perform("payme", "pm-t")
    with pytest.raises(ports.TxnNotFound):
        await env.pay.perform("payme", "nope")


async def test_click_attempts_first_performed_wins(env: Env) -> None:
    a = await env.account()
    o = await _web(env, a, "til_100", "click")
    ref = str(o["order_no"])
    await env.pay.create("click", "c-1", ref, 500_000, env.now, {})
    await env.pay.create("click", "c-2", ref, 500_000, env.now, {})  # несколько попыток допустимы
    a1, a2 = await asyncio.gather(env.pay.perform("click", "c-1"), env.pay.perform("click", "c-2"),
                                  return_exceptions=True)
    results = [x for x in (a1, a2) if not isinstance(x, BaseException)]
    errors = [x for x in (a1, a2) if isinstance(x, BaseException)]
    assert len(results) == 1 and len(errors) == 1 and isinstance(errors[0], ports.AlreadyPaid)
    states = sorted(r[0] for r in await env.sql("SELECT state || ':' || coalesce(cancel_reason, '') FROM "
                                                "provider_transactions WHERE provider = 'click'"))
    assert states == ["cancelled:order_closed", "performed:"]
    assert (await env.one("SELECT status FROM orders WHERE order_no = :n", n=o["order_no"]))[0] == "paid"
    # чек Click — pending, tick → adapter.fiscalize → registered, ссылка на странице заказа
    assert (await env.one("SELECT status FROM fiscal_receipts"))[0] == "pending"
    await env.tick()
    assert (await env.one("SELECT status, qr_code_url FROM fiscal_receipts"))[0] == "registered"
    web = await env.get(a, f"orders/{o['order_no']}", chn="web")
    assert web["receipt_url"] == "https://ofd.test/r/1"


async def test_expired_order_paid_by_txn_created_before(env: Env) -> None:
    a = await env.account()
    o = await _web(env, a, "plus_30d", "click", start_mode="now")
    await env.pay.create("click", "c-e", str(o["order_no"]), 4_900_000, env.now, {})
    env.shift(minutes=1441)
    await env.tick()
    assert (await env.one("SELECT status FROM orders WHERE order_no = :n", n=o["order_no"]))[0] == "expired"
    with pytest.raises(ports.OrderClosed):  # новых транзакций по истёкшему нет
        await env.pay.create("click", "c-new", str(o["order_no"]), 4_900_000, env.now, {})
    await env.pay.perform("click", "c-e")
    row = await env.one("SELECT status, closed_at FROM orders WHERE order_no = :n", n=o["order_no"])
    assert tuple(row) == ("fulfilled", None)


async def test_provider_cancel_of_performed_is_refund_without_request(env: Env) -> None:
    a = await env.account()
    o = await _web(env, a, "plus_30d", start_mode="now")
    await env.pay.create("payme", "pm-r", str(o["order_no"]), 4_900_000, env.now, {})
    await env.pay.perform("payme", "pm-r")
    t = await env.pay.cancel("payme", "pm-r", "refund", 5)
    assert t.state == "refunded" and t.provider_reason == 5
    assert (await env.pay.cancel("payme", "pm-r", "refund", 5)).state == "refunded"  # повтор — тот же
    row = await env.one("SELECT r.status, r.initiated_by, o.status FROM refunds r JOIN orders o USING (order_id)")
    assert tuple(row) == ("completed", "provider", "refunded")
    assert (await env.one("SELECT status, close_reason FROM periods WHERE account_id = :a", a=a))[0] == "revoked"
    assert (await env.one("SELECT kind FROM reconciliation_items"))[0] == "refund_without_request"
    [ev] = await env.events("billing.order.refunded.v1")
    assert ev.payload["initiated_by"] == "provider"
    assert (await env.get(a, "subscription", chn="web"))["status"] == "expired"


async def test_stars_til_pack_paid_then_credited(env: Env) -> None:
    a = await env.account()
    o = await env.order(a, "til_100", expect=201)
    oid = await _oid(env, o["order_no"])
    payload = f"o:{oid}"
    ok = await env.pay.check("telegram_stars", payload, 15, payer_account_id=a)
    assert ok.order.stars_title == {"ru": "100 тилов", "uz": "100 til"}
    with pytest.raises(ports.PayerMismatch):
        await env.pay.check("telegram_stars", payload, 15, payer_account_id=uuid.uuid4())
    with pytest.raises(ports.AmountMismatch):
        await env.pay.check("telegram_stars", payload, 16, payer_account_id=a)
    env.settings.stars_enabled = False
    with pytest.raises(ports.PaymentsDisabled):
        await env.pay.check("telegram_stars", payload, 15, payer_account_id=a)
    # платёж по уже одобренному счёту принимается и при выключенном STARS_ENABLED; повтор charge id — тот же
    t1, t2 = await asyncio.gather(*[env.pay.paid("telegram_stars", "ch-til", payload, 15, payer_account_id=a,
                                                 recurring=None, provider_time=env.now, meta={}) for _ in range(2)],
                                  return_exceptions=True)
    env.settings.stars_enabled = True
    views = [t for t in (t1, t2) if not isinstance(t, BaseException)]
    assert views and all(v.txn_id == views[0].txn_id for v in views)
    assert (await env.pay.paid("telegram_stars", "ch-til", payload, 15, payer_account_id=a, recurring=None,
                               provider_time=env.now, meta={})).txn_id == views[0].txn_id
    assert (await env.one("SELECT count(*) FROM provider_transactions"))[0] == 1
    assert (await env.one("SELECT status FROM orders WHERE order_id = :o", o=oid))[0] == "paid"
    [ev] = await env.events("billing.order.paid.v1", order_id=oid)
    assert ev.payload["til"] == 100 and ev.payload["amount_stars"] == 15 and ev.payload["period"] is None
    # подтверждение gamification (повторно — без изменений)
    credited = {"order_id": str(oid), "user_id": str(a), "til": 100, "op_id": str(uuid.uuid4()),
                "outcome": "credited", "credited_at": env.ts()}
    await env.publish("game.til_pack.credited.v1", credited, "gamification")
    await env.publish("game.til_pack.credited.v1", credited, "gamification")
    await env.publish("game.til_pack.credited.v1", {**credited, "order_id": str(uuid.uuid4())}, "lessons")
    assert (await env.one("SELECT status FROM orders WHERE order_id = :o", o=oid))[0] == "fulfilled"
    # второй платёж за тот же заказ (другой charge id) — пункт сверки, без зачисления
    with pytest.raises(ports.AlreadyPaid):
        await env.pay.paid("telegram_stars", "ch-dup", payload, 15, payer_account_id=a, recurring=None,
                           provider_time=env.now, meta={})
    assert (await env.one("SELECT kind FROM reconciliation_items"))[0] == "duplicate_payment"


async def test_stars_mismatches_are_recorded_not_rejected(env: Env) -> None:
    a = await env.account()
    o1 = await env.order(a, "til_100", expect=201)
    o2 = await env.order(a, "til_550", expect=201)
    t = await env.pay.paid("telegram_stars", "ch-pm", f"o:{await _oid(env, o1['order_no'])}", 15,
                           payer_account_id=uuid.uuid4(), recurring=None, provider_time=env.now, meta={})
    assert t.state == "performed"
    await env.pay.paid("telegram_stars", "ch-am", f"o:{await _oid(env, o2['order_no'])}", 70, payer_account_id=a,
                       recurring=None, provider_time=env.now, meta={})
    with pytest.raises(ports.OrderNotFound):
        await env.pay.paid("telegram_stars", "ch-nf", f"o:{uuid.uuid4()}", 15, payer_account_id=a, recurring=None,
                           provider_time=env.now, meta={})
    kinds = sorted(r[0] for r in await env.sql("SELECT kind FROM reconciliation_items"))
    assert kinds == ["payer_mismatch", "unmatched_settlement", "unmatched_settlement"]
    statuses = sorted(r[0] for r in await env.sql("SELECT status FROM orders"))
    assert statuses == ["paid", "paid"]  # оплачено, не выдано — возврат сотрудником
    assert await env.events("billing.order.paid.v1") == []


async def test_stars_subscription_first_payment_renewal_and_state(env: Env) -> None:
    a = await env.account()
    await env.trial(a)
    o = await env.order(a, "plus_30d", expect=201, confirm_forfeit=True)
    payload = f"o:{await _oid(env, o['order_no'])}"
    exp1 = env.now + timedelta(days=30)
    await env.pay.paid("telegram_stars", "ch-s1", payload, 250, payer_account_id=a,
                       recurring=StarsRecurrence(True, True, exp1), provider_time=env.now, meta={})
    periods = await env.sql("SELECT source, status, ends_at FROM periods WHERE account_id = :a ORDER BY created_at",
                            a=a)
    assert [(p[0], p[1]) for p in periods] == [("trial", "superseded"), ("order", "active")]
    assert periods[1][2] == exp1  # до subscription_expiration_date
    sub = await env.get(a, "subscription")
    assert sub["stars_subscription"] == {"status": "active", "auto_renew": True,
                                         "expires_at": sub["stars_subscription"]["expires_at"], "amount_stars": 250}
    assert sub["expiring"] is False
    # обновление подписки: canceled → active → failed; неизвестная — пункт сверки
    await env.pay.stars_subscription_state(payload, a, "canceled")
    assert (await env.get(a, "subscription"))["stars_subscription"]["auto_renew"] is False
    await env.pay.stars_subscription_state(payload, None, "active")
    await env.pay.stars_subscription_state(payload, a, "failed")
    states = [e.payload["status"] for e in await env.events("billing.stars_subscription.changed.v1")]
    assert states == ["active", "canceled", "active", "failed"]
    with pytest.raises(ports.SubscriptionNotFound):
        await env.pay.stars_subscription_state(f"o:{uuid.uuid4()}", a, "canceled")
    # продление незадолго до конца: заказ renewal, следующий период в очереди → активируется в конце
    env.now = exp1 - timedelta(minutes=5)
    exp2 = exp1 + timedelta(days=30)
    r = await env.pay.paid("telegram_stars", "ch-s2", payload, 250, payer_account_id=a,
                           recurring=StarsRecurrence(True, False, exp2), provider_time=env.now, meta={})
    renewal = await env.one("SELECT channel, status, stars_subscription_id IS NOT NULL FROM orders "
                            "WHERE order_id = :o", o=r.order_id)
    assert tuple(renewal) == ("renewal", "fulfilled", True)
    sub_row = await env.one("SELECT status, renewals, expires_at, last_charge_id FROM stars_subscriptions")
    assert tuple(sub_row) == ("active", 1, exp2, "ch-s2")
    env.now = exp1 + timedelta(minutes=1)
    await env.tick()
    rows = await env.sql("SELECT status, starts_at, ends_at FROM periods WHERE account_id = :a AND source = 'order' "
                         "ORDER BY created_at", a=a)
    assert [x[0] for x in rows] == ["ended", "active"] and rows[1][1] == exp1 and rows[1][2] == exp2
    hist = await env.get(a, "orders")
    assert [i["channel"] for i in hist["items"]] == ["renewal", "miniapp"]
    # конец подписки без продления: tick → ended
    env.now = exp2 + timedelta(hours=2)
    out = await env.tick()
    assert out["stars_subscriptions_ended"] == 1
    assert (await env.one("SELECT status FROM stars_subscriptions"))[0] == "ended"


async def test_stars_refunded_payment_and_fiscal_and_statement(env: Env) -> None:
    a = await env.account()
    o = await env.order(a, "til_100", expect=201)
    oid = await _oid(env, o["order_no"])
    await env.pay.paid("telegram_stars", "ch-rf", f"o:{oid}", 15, payer_account_id=a, recurring=None,
                       provider_time=env.now, meta={})
    t = await env.pay.refunded("telegram_stars", "ch-rf")
    assert t.state == "refunded"
    assert (await env.pay.refunded("telegram_stars", "ch-rf")).state == "refunded"
    assert (await env.one("SELECT kind FROM reconciliation_items"))[0] == "refund_without_request"
    w = await _web(env, a, "til_100")
    await env.pay.create("payme", "pm-f", str(w["order_no"]), 500_000, env.now, {})
    await env.pay.perform("payme", "pm-f")
    await env.pay.store_fiscal("payme", "pm-f", "sale", {"receipt_id": "R1", "terminal_id": "T", "fiscal_sign": "S",
                                                         "qr_code_url": "https://ofd.soliq.uz/check?t=1",
                                                         "status_code": 0})
    await env.pay.store_fiscal("payme", "pm-f", "refund", {"receipt_id": "R2", "status_code": 0})
    rows = await env.sql("SELECT kind, status, fiscal_receipt_id FROM fiscal_receipts ORDER BY kind")
    assert [tuple(r) for r in rows] == [("refund", "registered", "R2"), ("sale", "registered", "R1")]
    with pytest.raises(ports.ReceiptTxnNotFound):
        await env.pay.store_fiscal("payme", "unknown", "sale", {})
    st = await env.pay.statement("payme", env.now - timedelta(hours=1), env.now)
    assert [x.provider_txn_id for x in st] == ["pm-f"]
    # журнал вызовов и ответы pre-checkout (сверх протокола — потоки B и G)
    await env.pay.record_call("payme", "in", "CheckPerformTransaction", "0", 12, order_no=w["order_no"],
                              client_ip="10.0.0.1")
    await env.pay.record_provider_call(provider="click", direction="in", method="prepare", result_code="-1",
                                       latency_ms=3, client_ip="not-an-ip")
    assert (await env.one("SELECT count(*) FROM provider_calls"))[0] == 2
    assert await env.pay.recall_pre_checkout("q1") is None
    assert await env.pay.remember_pre_checkout("q1", f"o:{oid}", False, "order_closed") == (False, "order_closed")
    assert await env.pay.remember_pre_checkout("q1", f"o:{oid}", True, None) == (False, "order_closed")
    assert await env.pay.recall_pre_checkout("q1") == (False, "order_closed")
