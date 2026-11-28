"""Заказы и каналы (§1.3, §0.2, §0.5; AT-84/85/86 — доменная часть): пара «канал — провайдер», сумма из каталога,
идемпотентность, плательщик и получатель, правила подписки Stars, лимит открытых заказов, изоляция и анти-стиринг
каналов, ссылка на счёт Stars, отмена."""

from __future__ import annotations

import json
import uuid

from conftest import Env

from tilhero_billing.domain.ports import StarsRecurrence


async def test_stars_order_amount_from_catalog_and_idempotency(env: Env) -> None:
    a = await env.account()
    key = f"k-{uuid.uuid4()}"
    o = await env.order(a, "til_100", expect=201, key=key)
    assert o["currency"] == "XTR" and o["amount_stars"] == 15 and o["provider"] == "telegram_stars"
    assert o["invoice_link"] == f"https://t.me/$inv{o['order_no']}" and o["channel"] == "miniapp"
    assert "amount_tiyin" not in o and "checkout_url" not in o
    again = await env.order(a, "til_100", expect=200, key=key)
    assert again["order_no"] == o["order_no"]
    await env.order(a, "til_550", expect=422, key=key)  # тот же ключ, другие данные
    same = await env.order(a, "til_100", expect=200)  # незавершённый того же товара — он же
    assert same["order_no"] == o["order_no"]
    row = await env.one("SELECT amount_stars, amount_tiyin, currency, product_snapshot, expires_at - created_at "
                        "FROM orders WHERE order_no = :n", n=o["order_no"])
    assert row[0] == 15 and row[1] is None and row[2] == "XTR" and row[3]["til"] == 100
    assert row[4].total_seconds() == 3600  # stars_order_ttl_minutes


async def test_channel_provider_pair_and_flags(env: Env) -> None:
    a = await env.account()
    r = await env.order(a, "til_100", "payme", expect=422, chn="miniapp")
    assert r["code"] == "PROVIDER_NOT_ALLOWED"
    r = await env.order(a, "til_100", "telegram_stars", expect=422, chn="web")
    assert r["code"] == "PROVIDER_NOT_ALLOWED"
    web = await env.order(a, "til_100", "click", expect=201)
    assert web["currency"] == "UZS" and web["amount_tiyin"] == 500_000 and "amount_stars" not in web
    assert web["checkout_url"].startswith("https://checkout.click.test/")
    assert web["checkout_url"].endswith(f"/orders/{web['order_no']}")  # возврат — на страницу заказа сайта
    env.settings.click_enabled = False
    try:
        assert (await env.order(a, "til_550", "click", expect=409))["code"] == "PROVIDER_NOT_AVAILABLE"
    finally:
        env.settings.click_enabled = True
    env.settings.payments_enabled = False
    try:
        assert (await env.order(a, "til_550", expect=409))["code"] == "PAYMENTS_DISABLED"
    finally:
        env.settings.payments_enabled = True
    assert (await env.order(a, "nope_1", expect=404))["code"] == "PRODUCT_NOT_FOUND"
    r = await env.post(a, "orders", {"product_code": "til_100", "provider": "telegram_stars", "offer_version": "0.9"},
                       409, key=f"k-{uuid.uuid4()}")
    assert r["code"] == "OFFER_VERSION_MISMATCH" and r["details"]["current"] == "1.0"
    r = await env.post(a, "orders", {"product_code": "til_100", "provider": "telegram_stars", "offer_version": "1.0"},
                       400)
    assert r["code"] == "IDEMPOTENCY_KEY_REQUIRED"


async def test_payer_and_beneficiary(env: Env) -> None:
    parent = await env.account()
    child = uuid.uuid4()
    await env.profile(child, kind="child", age_band="6-9", guardian=parent)
    # детский профиль не платит; ребёнку тилы покупает родитель из своего профиля
    r = await env.order(parent, "til_100", expect=403, lrn=child, age_band="6-9")
    assert r["code"] == "PAYER_REQUIRED"
    o = await env.order(parent, "til_100", expect=201, beneficiary_id=str(child))
    assert (await env.one("SELECT beneficiary_id FROM orders WHERE order_no = :n", n=o["order_no"]))[0] == child
    other = await env.account()
    r = await env.order(other, "til_100", expect=403, beneficiary_id=str(child))
    assert r["code"] == "BENEFICIARY_NOT_ALLOWED"
    r = await env.order(parent, "plus_90d", expect=403, beneficiary_id=str(child), start_mode="now")
    assert r["code"] == "BENEFICIARY_NOT_ALLOWED"
    teen = await env.account("14-17")
    r = await env.order(teen, "til_100", expect=403, age_band="14-17")
    assert r["code"] == "GUARDIAN_CONSENT_REQUIRED"
    await env.consent(teen)
    await env.order(teen, "til_100", expect=201, age_band="14-17")
    nobody = uuid.uuid4()
    assert (await env.order(nobody, "til_100", expect=403, age_band=None))["code"] == "PAYER_REQUIRED"


async def test_stars_subscription_rules(env: Env) -> None:
    a = await env.account()
    await env.trial(a)
    r = await env.order(a, "plus_30d", expect=409)
    assert r["code"] == "FORFEIT_CONFIRMATION_REQUIRED" and r["details"] == {"minutes_left": 60, "days_left": 7}
    o = await env.order(a, "plus_30d", expect=201, confirm_forfeit=True)
    row = await env.one("SELECT stars_mode, start_mode FROM orders WHERE order_no = :n", n=o["order_no"])
    assert tuple(row) == ("subscription", None)  # подписка Stars начинается в момент оплаты
    # оплата → подписка Stars живая → вторую купить нельзя
    await env.pay.paid("telegram_stars", "ch-1", f"o:{await _order_id(env, o)}", 250, payer_account_id=a,
                       recurring=StarsRecurrence(True, True, env.now + __import__("datetime").timedelta(days=30)),
                       provider_time=env.now, meta={})
    assert (await env.order(a, "plus_30d", expect=409, confirm_forfeit=True))["code"] == "STARS_SUBSCRIPTION_EXISTS"
    # оплаченный период активен (сайт) — подписку Stars купить нельзя
    b = await env.account()
    w = await env.order(b, "plus_90d", "payme", expect=201, start_mode="now")
    oid = await _order_id(env, w)
    await env.pay.create("payme", "pm-1", str(w["order_no"]), 12_900_000, env.now, {})
    await env.pay.perform("payme", "pm-1")
    r = await env.order(b, "plus_30d", expect=409, confirm_forfeit=True)
    assert r["code"] == "ACTIVE_PERIOD_EXISTS" and r["details"]["ends_at"]
    # разовая подписка: start_mode обязателен; now при активном — только с подтверждением
    assert (await env.order(b, "plus_90d", expect=422))["code"] == "VALIDATION_ERROR"
    assert (await env.order(b, "plus_90d", expect=409, start_mode="now"))["code"] == "FORFEIT_CONFIRMATION_REQUIRED"
    await env.order(b, "plus_90d", expect=201, start_mode="after_current")
    assert oid


async def _order_id(env: Env, o: dict[str, object]) -> uuid.UUID:
    return (await env.one("SELECT order_id FROM orders WHERE order_no = :n", n=o["order_no"]))[0]  # type: ignore[no-any-return]


async def test_orders_limit_isolation_and_channel_history(env: Env) -> None:
    a = await env.account()
    for code in ("til_100", "til_550", "til_1200"):
        await env.order(a, code, expect=201)
    web = await env.order(a, "til_100", "payme", expect=201)
    await env.order(a, "til_550", "payme", expect=201)
    assert (await env.order(a, "til_1200", "payme", expect=429))["code"] == "ORDERS_LIMIT"
    mini = await env.get(a, "orders")
    assert len(mini["items"]) == 3 and all(i["currency"] == "XTR" for i in mini["items"])
    assert "payme" not in json.dumps(mini) and "tiyin" not in json.dumps(mini)  # анти-стиринг
    assert len((await env.get(a, "orders", chn="web"))["items"]) == 2
    # заказ сайта не виден в Mini App; чужой — 404
    await env.get(a, f"orders/{web['order_no']}", 404)
    await env.get(a, f"orders/{web['order_no']}", chn="web")
    other = await env.account()
    await env.get(other, f"orders/{web['order_no']}", 404, chn="web")
    page = await env.get(a, "orders", params={"limit": 2})
    assert len(page["items"]) == 2 and page["next_cursor"]
    rest = await env.get(a, "orders", params={"cursor": page["next_cursor"]})
    assert len(rest["items"]) == 1
    assert (await env.get(a, "orders", 400, params={"cursor": "bad"}))["code"] == "INVALID_CURSOR"


async def test_stars_invoice_link_unavailable_then_retried(env: Env) -> None:
    a = await env.account()
    env.adapters["telegram_stars"].down = True
    key = f"k-{uuid.uuid4()}"
    r = await env.order(a, "til_100", expect=503, key=key)
    assert r["code"] == "STARS_UNAVAILABLE" and r["details"] == {}
    assert (await env.order(a, "til_100", expect=503, key=key))["code"] == "STARS_UNAVAILABLE"
    env.adapters["telegram_stars"].down = False
    # повтор POST с тем же ключом — тот же заказ (200), уже со ссылкой на счёт
    again = await env.order(a, "til_100", expect=200, key=key)
    assert again["status"] == "pending" and again["invoice_link"].startswith("https://t.me/")
    assert again["channel"] == "miniapp" and again["paid_at"] is None
    got = await env.get(a, f"orders/{again['order_no']}")
    assert got["invoice_link"] == again["invoice_link"]
    assert (await env.one("SELECT count(*) FROM orders"))[0] == 1


async def test_cancel_and_expiry(env: Env) -> None:
    a = await env.account()
    o = await env.order(a, "til_100", "payme", expect=201)
    await env.pay.create("payme", "pm-c", str(o["order_no"]), 500_000, env.now, {})
    r = await env.post(a, f"orders/{o['order_no']}/cancel", None, 409, chn="web")
    assert r["code"] == "ORDER_STATE"
    s = await env.order(a, "til_100", expect=201)
    done = await env.post(a, f"orders/{s['order_no']}/cancel", None, 200)
    assert done["status"] == "cancelled" and done["invoice_link"] is None
    await env.post(a, f"orders/{s['order_no']}/cancel", None, 409)
    other = await env.account()
    await env.post(other, f"orders/{o['order_no']}/cancel", None, 404, chn="web")
    # истечение tick'ом
    p = await env.order(a, "til_550", expect=201)
    env.shift(minutes=61)
    assert (await env.get(a, f"orders/{p['order_no']}"))["status"] == "expired"
    out = await env.tick()
    assert out["orders_expired"] >= 1
    status = (await env.one("SELECT status FROM orders WHERE order_no = :n", n=p["order_no"]))[0]
    assert status == "expired"


async def test_web_channel_without_age_claim_uses_projection(env: Env) -> None:
    """Сайт: токен `chn web` несёт только sub = lrn = аккаунт — плательщик и аудитория по проекции."""
    adult = await env.account()
    cat = await env.get(adult, "catalog", chn="web", age_band=None)
    assert cat["can_pay"] and not cat["payer_required"]
    assert {p["code"]: p["price"] for p in cat["products"]}["til_100"] == {"tiyin": 500_000}
    o = await env.order(adult, "plus_30d", "payme", expect=201, age_band=None, start_mode="after_current")
    assert o["checkout_url"].startswith("https://") and o["receipt_url"] is None and o["currency"] == "UZS"
    assert o["status"] == "pending" and o["refund"] is None and o["paid_at"] is None
    teen = await env.account("14-17")
    r = await env.order(teen, "til_100", "click", expect=403, age_band=None)
    assert r["code"] == "GUARDIAN_CONSENT_REQUIRED"
    assert (await env.get(teen, "catalog", chn="web", age_band=None))["consent_required"]
    await env.consent(teen)
    await env.order(teen, "til_100", "click", expect=201, age_band=None)
    stranger = uuid.uuid4()  # нет в проекции — возраст неизвестен
    r = await env.order(stranger, "til_100", "uzum", expect=403, age_band=None)
    assert r["code"] == "PAYER_REQUIRED"
