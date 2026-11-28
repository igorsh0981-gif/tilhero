"""Возвраты (§1.12, AT-94): step-up и причина, Stars — сразу с отменой подписки, Payme — инструкция и ожидание
CancelTransaction, Click — окно месяца, пред-проверка тилов, повторный возврат невозможен, сбой провайдера, закрытие
зависшего, плательщик Stars неизвестен."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from conftest import Env

from tilhero_billing.domain.ports import StarsRecurrence
from tilhero_billing.providers.base import RefundOutcome


async def _paid_stars_subscription(env: Env, a: uuid.UUID) -> uuid.UUID:
    o = await env.order(a, "plus_30d", expect=201)
    oid = (await env.one("SELECT order_id FROM orders WHERE order_no = :n", n=o["order_no"]))[0]
    await env.pay.paid("telegram_stars", f"ch-{uuid.uuid4()}", f"o:{oid}", 250, payer_account_id=a,
                       recurring=StarsRecurrence(True, True, env.now + timedelta(days=30)), provider_time=env.now,
                       meta={})
    return oid  # type: ignore[no-any-return]


async def _paid_web(env: Env, a: uuid.UUID, product: str, provider: str) -> uuid.UUID:
    extra: dict[str, Any] = {"start_mode": "now"} if product.startswith("plus") else {}
    o = await env.order(a, product, provider, expect=201, **extra)
    tid = f"{provider}-{uuid.uuid4().hex[:10]}"
    amount = (await env.one("SELECT amount_tiyin FROM orders WHERE order_no = :n", n=o["order_no"]))[0]
    await env.pay.create(provider, tid, str(o["order_no"]), amount, env.now, {})
    await env.pay.perform(provider, tid)
    return (await env.one("SELECT order_id FROM orders WHERE order_no = :n", n=o["order_no"]))[0]  # type: ignore[no-any-return]


async def test_stars_refund_completes_and_cancels_subscription(env: Env) -> None:
    a = await env.account()
    oid = await _paid_stars_subscription(env, a)
    body = {"reason": "ученик передумал сразу"}
    await env.adm("POST", f"orders/{oid}/refunds", body, 403, step_up=False, key="k-refund-1")
    await env.adm("POST", f"orders/{oid}/refunds", body, 403, perms=("billing.read",), key="k-refund-1")
    await env.adm("POST", f"orders/{oid}/refunds", {"reason": "коротко"}, 422, key="k-refund-1")
    staff = str(uuid.uuid4())
    r = await env.adm("POST", f"orders/{oid}/refunds", body, 201, key="k-refund-1", staff_id=staff)
    assert r["status"] == "completed" and r["method"] == "provider_api" and r["amount_stars"] == 250
    assert r["requested_by"]["staff_id"] == staff and r["initiated_by"] == "staff"
    assert env.adapters["telegram_stars"].refunds and env.botgw.edits[-1]["is_canceled"] is True
    again = await env.adm("POST", f"orders/{oid}/refunds", body, 201, key="k-refund-1", staff_id=staff)
    assert again["refund_id"] == r["refund_id"]  # повтор ключа — тот же возврат
    assert (await env.adm("POST", f"orders/{oid}/refunds", body, 409, key="k-refund-2"))["code"] == "REFUND_STATE"
    assert (await env.one("SELECT status FROM orders WHERE order_id = :o", o=oid))[0] == "refunded"
    assert (await env.one("SELECT status FROM stars_subscriptions"))[0] == "refunded"
    assert (await env.one("SELECT status, close_reason FROM periods WHERE order_id = :o", o=oid))[1] == "refund"
    assert (await env.get(a, "subscription"))["status"] == "expired"
    [ev] = await env.events("billing.order.refunded.v1", order_id=oid)
    assert ev.payload["initiated_by"] == "staff" and ev.payload["amount_stars"] == 250
    assert [e.payload["status"] for e in await env.events("billing.stars_subscription.changed.v1")][-1] == "refunded"
    actions = {e.payload["action"] for e in await env.events("admin.audit.recorded.v1")}
    assert {"billing.refund_requested", "billing.refund_completed"} <= actions
    card = await env.adm("GET", f"orders/{oid}")
    assert card["can_refund"] is False and card["refunds"][0]["status"] == "completed"
    assert card["stars_subscription"]["status"] == "refunded" and card["transactions"][0]["state"] == "refunded"


async def test_payme_refund_awaits_provider_cancel(env: Env) -> None:
    a = await env.account()
    oid = await _paid_web(env, a, "plus_30d", "payme")
    r = await env.adm("POST", f"orders/{oid}/refunds", {"reason": "возврат по заявлению"}, 201, key="k-pm-refund")
    assert r["status"] == "awaiting_provider" and r["method"] == "provider_cabinet"
    assert r["instruction"]["provider"] == "payme" and r["instruction"]["amount_tiyin"] == 4_900_000
    txn = (await env.one("SELECT provider_txn_id FROM provider_transactions WHERE order_id = :o", o=oid))[0]
    await env.pay.cancel("payme", txn, "refund", 5)  # CancelTransaction state 2 из кабинета
    row = await env.one("SELECT status, initiated_by FROM refunds")
    assert tuple(row) == ("completed", "staff")
    assert await env.sql("SELECT 1 FROM reconciliation_items WHERE kind = 'refund_without_request'") == []
    listing = await env.adm("GET", "refunds", None)
    assert listing["items"][0]["status"] == "completed"


async def test_click_window_tils_check_and_failures(env: Env) -> None:
    a = await env.account()
    oid = await _paid_web(env, a, "til_100", "click")
    # тилы потрачены — без force нельзя; с force — можно и пункт сверки
    env.game.purchases[str(oid)] = {"order_id": str(oid), "credited": True, "til": 100, "til_balance": 30,
                                    "status": "credited"}
    r = await env.adm("POST", f"orders/{oid}/refunds", {"reason": "тилы не нужны"}, 409, key="k-click-1")
    assert r["details"] == {"reason": "tils_spent", "til": 100, "til_balance": 30}
    env.game.down = True
    r = await env.adm("POST", f"orders/{oid}/refunds", {"reason": "тилы не нужны"}, 503, key="k-click-2")
    assert r["details"]["service"] == "gamification"
    env.game.down = False
    env.adapters["click"].refund_outcome = RefundOutcome(kind="api_failed", failure_code="-9")
    r = await env.adm("POST", f"orders/{oid}/refunds", {"reason": "тилы не нужны", "force": True}, 201,
                      key="k-click-3")
    assert r["status"] == "failed" and r["failure_code"] == "-9" and r["tils_check"]["til_balance"] == 30
    assert (await env.one("SELECT kind FROM reconciliation_items"))[0] == "tils_spent_on_refund"
    env.adapters["click"].refund_outcome = RefundOutcome(kind="api_ok")
    r = await env.adm("POST", f"orders/{oid}/refunds", {"reason": "тилы не нужны", "force": True}, 201,
                      key="k-click-4")
    assert r["status"] == "completed"
    [ev] = await env.events("billing.order.refunded.v1", order_id=oid)
    assert ev.payload["product_kind"] == "til_pack" and ev.payload["amount_tiyin"] == 500_000
    # окно Click: проведено в прошлом месяце (не 1-е число) — нельзя
    b = await env.account()
    old = await _paid_web(env, b, "til_100", "click")
    env.shift(days=40)
    r = await env.adm("POST", f"orders/{old}/refunds", {"reason": "старый платёж"}, 409, key="k-click-5")
    assert r["details"]["reason"] == "provider_window"


async def test_not_paid_stuck_close_and_payer_unknown(env: Env) -> None:
    a = await env.account()
    o = await env.order(a, "til_100", "payme", expect=201)
    oid = (await env.one("SELECT order_id FROM orders WHERE order_no = :n", n=o["order_no"]))[0]
    r = await env.adm("POST", f"orders/{oid}/refunds", {"reason": "не оплачен ещё"}, 409, key="k-notpaid-1")
    assert r["code"] == "REFUND_NOT_ALLOWED" and r["details"]["reason"] == "not_paid"
    await env.adm("POST", f"orders/{uuid.uuid4()}/refunds", {"reason": "нет такого заказа"}, 404, key="k-notpaid-2")
    paid = await _paid_web(env, a, "til_550", "uzum")
    r = await env.adm("POST", f"orders/{paid}/refunds", {"reason": "возврат через Uzum"}, 201, key="k-uzum-001")
    assert r["status"] == "awaiting_provider"
    env.shift(days=3, hours=1)
    await env.tick()
    assert await env.sql("SELECT 1 FROM reconciliation_items WHERE kind = 'refund_stuck'")
    await env.adm("POST", f"refunds/{r['refund_id']}/fail", {"note": "закрыт вручную"}, 403, step_up=False)
    closed = await env.adm("POST", f"refunds/{r['refund_id']}/fail", {"note": "провайдер отказал по телефону"})
    assert closed["status"] == "failed" and closed["failure_code"] == "CLOSED_BY_STAFF"
    await env.adm("POST", f"refunds/{r['refund_id']}/fail", {"note": "повторное закрытие"}, 409)
    # после закрытия — новая заявка возможна
    await env.adm("POST", f"orders/{paid}/refunds", {"reason": "повторная попытка"}, 201, key="k-uzum-002")
    # Stars: плательщик удалён — возврат через API невозможен
    b = await env.account()
    s = await _paid_stars_subscription(env, b)
    await env.delete(b)
    r = await env.adm("POST", f"orders/{s}/refunds", {"reason": "аккаунт удалён"}, 409, key="k-stars-01")
    assert r["code"] == "STARS_PAYER_UNKNOWN"


async def test_refund_fail_and_resolve_replay_and_can_refund(env: Env) -> None:
    a = await env.account()
    oid = await _paid_web(env, a, "plus_30d", "payme")
    card = await env.adm("GET", f"orders/{oid}")
    assert card["can_refund"] is True and card["status"] == "fulfilled"
    refunder = str(uuid.uuid4())
    r = await env.adm("POST", f"orders/{oid}/refunds", {"reason": "повтор закрытия"}, 201, key="k-rf-rep-1",
                      staff_id=refunder)
    h = {**env.staff(staff_id=refunder), "Idempotency-Key": "k-rf-rep-1"}
    rep = await env.c.post(f"/internal/v1/admin/billing/orders/{oid}/refunds", json={"reason": "повтор закрытия"},
                           headers=h)
    assert rep.status_code == 201 and rep.json()["refund_id"] == r["refund_id"]
    assert rep.headers["idempotent-replayed"] == "true"
    staff = str(uuid.uuid4())
    one = await env.adm("POST", f"refunds/{r['refund_id']}/fail", {"note": "провайдер отказал"}, key="k-fail-rep",
                        staff_id=staff)
    assert await env.adm("POST", f"refunds/{r['refund_id']}/fail", {"note": "провайдер отказал"},
                         key="k-fail-rep", staff_id=staff) == one
    # пункт сверки: повтор разбора с ключом — тот же ответ
    env.shift(days=4)
    await env.tick()
    item = (await env.adm("GET", "reconciliation/items"))["items"][0]
    res = await env.adm("POST", f"reconciliation/items/{item['item_id']}/resolve",
                        {"status": "resolved", "note": "разобрано вручную"}, key="k-res-rep", staff_id=staff)
    assert await env.adm("POST", f"reconciliation/items/{item['item_id']}/resolve",
                         {"status": "resolved", "note": "разобрано вручную"}, key="k-res-rep", staff_id=staff) == res
    # can_refund — только paid / fulfilled
    pend = await env.order(a, "til_100", "click", expect=201)
    pid = (await env.one("SELECT order_id FROM orders WHERE order_no = :n", n=pend["order_no"]))[0]
    assert (await env.adm("GET", f"orders/{pid}"))["can_refund"] is False


async def test_order_date_filter_uses_tashkent_days(env: Env) -> None:
    """admin-bff передаёт дату — день Ташкента, «по» включительно (billing: from ≤ created_at < начало след. дня)."""
    a = await env.account()
    env.now = env.now.replace(hour=19, minute=30)  # 00:30 следующего дня по Ташкенту (UTC+5)
    late = await env.order(a, "til_100", expect=201)
    by_day = {d: [r["order_no"] for r in (await env.adm("GET", f"orders?from={d}&to={d}"))["items"]]
              for d in ("2026-11-20", "2026-11-21")}
    assert late["order_no"] in by_day["2026-11-21"] and late["order_no"] not in by_day["2026-11-20"]
    bounded = await env.adm("GET", "orders?from=2026-11-21T00:00:00%2B05:00&to=2026-11-22T00:00:00%2B05:00")
    assert [r["order_no"] for r in bounded["items"]] == [late["order_no"]]
