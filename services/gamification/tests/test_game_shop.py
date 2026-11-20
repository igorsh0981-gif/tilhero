"""Магазин (§1.7, AT-69): витрина, покупка атомарна, повтор ключа без второй операции, предмет не купить дважды,
гонка двух покупок при балансе на одну, нехватка тилов — «покупка скоро», снятие с продажи не отбирает купленное,
экипировка, история операций ученика."""

from __future__ import annotations

import asyncio
import uuid

from conftest import Env


async def test_shop_view_and_insufficient_tils(env: Env, user: uuid.UUID) -> None:
    shop = await env.get(user, "shop")
    assert shop["til_balance"] == 0 and shop["freeze_max"] == 5
    items = {i["code"]: i for i in shop["items"]}
    assert shop["items"][0]["code"] == "streak_freeze" and items["streak_freeze"]["price_til"] == 40
    assert items["frame_gold"]["theme"] == {"bg": "--mark", "accent": "--warn"}
    assert all(i["reason_unavailable"] == "not_enough_tils" and not i["can_buy"] for i in shop["items"])
    r = await env.c.post("/internal/v1/game/purchases", json={"item_code": "bg_sunrise"},
                         headers={**env.h(user), "Idempotency-Key": "k-buy-0001"})
    assert r.status_code == 409 and r.json()["code"] == "INSUFFICIENT_TILS"
    assert r.json()["details"] == {"price": 90, "balance": 0, "missing": 90, "purchase_available": False}
    assert (await env.get(user, "summary"))["purchase_available"] is False
    await env.buy(user, "no_such_item", 404)
    r = await env.c.post("/internal/v1/game/purchases", json={"item_code": "bg_sunrise"}, headers=env.h(user))
    assert r.status_code == 400 and r.json()["code"] == "IDEMPOTENCY_KEY_REQUIRED"
    await env.buy(user, "bg_sunrise", 422, key="bad key!")
    await env.send("POST", user, "purchases", {"item_code": "bg_sunrise", "price_til": 1}, 422, key="k-buy-0002")


async def test_purchase_cosmetic_idempotent_and_once(env: Env, user: uuid.UUID) -> None:
    await env.grant(user, "til", 200)
    out = await env.buy(user, "bg_sunrise", key="k-buy-sunrise")
    assert out["price_til"] == 90 and out["til_balance"] == 110 and out["item_code"] == "bg_sunrise"
    again = await env.buy(user, "bg_sunrise", 200, key="k-buy-sunrise")
    assert again == out
    await env.buy(user, "frame_gold", 422, key="k-buy-sunrise")  # тот же ключ, другое тело
    r = await env.c.post("/internal/v1/game/purchases", json={"item_code": "bg_sunrise"},
                         headers={**env.h(user), "Idempotency-Key": "k-buy-other"})
    assert r.status_code == 409 and r.json()["code"] == "ALREADY_OWNED"
    shop_ops = [op for op in await env.ops(user) if op.reason == "shop"]
    assert [(op.currency, op.amount) for op in shop_ops] == [("til", -90)]
    assert (await env.wallet(user))["til"] == 110
    [ev] = await env.events("game.purchase.completed.v1", user)
    assert ev.payload["item_kind"] == "background" and ev.payload["price_til"] == 90
    items = {i["code"]: i for i in (await env.get(user, "shop"))["items"]}
    assert items["bg_sunrise"]["owned"] and items["bg_sunrise"]["reason_unavailable"] == "owned"
    # экипировка: только своё и нужного вида
    s = await env.send("PUT", user, "equipment", {"background_code": "bg_sunrise", "frame_code": None})
    assert s["equipment"]["background"]["code"] == "bg_sunrise" and s["equipment"]["frame"] is None
    for body in ({"background_code": "bg_ink_sky", "frame_code": None},
                 {"background_code": None, "frame_code": "bg_sunrise"}):
        r = await env.c.put("/internal/v1/game/equipment", json=body, headers=env.h(user))
        assert r.status_code == 409 and r.json()["code"] == "NOT_OWNED"
    await env.send("PUT", user, "equipment", {"background_code": None}, 422)  # оба поля обязательны
    # снятие с продажи купленное не отбирает; купить снятый нельзя
    await env.adm("POST", "shop/items/bg_sunrise/retire", {"comment": "сезон закончился"})
    s = await env.get(user, "summary")
    assert s["equipment"]["background"]["code"] == "bg_sunrise"
    other = uuid.uuid4()
    await env.grant(other, "til", 200)
    r = await env.c.post("/internal/v1/game/purchases", json={"item_code": "bg_sunrise"},
                         headers={**env.h(other), "Idempotency-Key": "k-buy-retired"})
    assert r.status_code == 410 and r.json()["code"] == "ITEM_NOT_AVAILABLE"
    # история ученика: без comment и actor сотрудника
    hist = await env.get(user, "history")
    assert [i["reason"] for i in hist["items"]] == ["shop", "manual", "registration_bonus"]
    assert hist["next_cursor"] is None
    assert set(hist["items"][1]) == {"op_id", "currency", "amount", "reason", "capped", "multiplier", "status",
                                     "created_at"}


async def test_freeze_purchase_and_stock_limit(env: Env, user: uuid.UUID) -> None:
    await env.profile(user)  # +2 заморозки
    await env.grant(user, "til", 200)
    out = await env.buy(user, "streak_freeze")
    assert out["freeze_stock"] == 3 and out["til_balance"] == 160 and out["price_til"] == 40
    await env.buy(user, "streak_freeze")
    await env.buy(user, "streak_freeze")
    r = await env.c.post("/internal/v1/game/purchases", json={"item_code": "streak_freeze"},
                         headers={**env.h(user), "Idempotency-Key": "k-buy-full"})
    assert r.status_code == 409 and r.json()["code"] == "FREEZE_STOCK_FULL" and r.json()["details"] == {"max": 5}
    items = {i["code"]: i for i in (await env.get(user, "shop"))["items"]}
    assert items["streak_freeze"]["reason_unavailable"] == "freeze_full"
    ops = [(op.currency, op.amount) for op in await env.ops(user) if op.reason == "shop"]
    assert ops == [("til", -40), ("freeze", 1)] * 3
    # цена и запас — из правил
    def cheaper(p: dict) -> None:  # type: ignore[type-arg]
        p["freeze"] = {"price_til": 25, "max_stock": 6}

    await env.activate(cheaper)
    out = await env.buy(user, "streak_freeze")
    assert out["price_til"] == 25 and out["freeze_stock"] == 6


async def test_race_two_purchases_balance_for_one(env: Env, user: uuid.UUID) -> None:
    await env.grant(user, "til", 100)
    for attempt in range(3):
        codes = ("bg_mint_notebook", "frame_mint") if attempt == 0 else ("streak_freeze", "streak_freeze")
        if attempt:
            have = (await env.wallet(user))["til"]
            if have < 40:
                await env.grant(user, "til", 40 - have)
            elif have > 79:
                await env.grant(user, "til", 79 - have)
        results = await asyncio.gather(*[
            env.c.post("/internal/v1/game/purchases", json={"item_code": code},
                       headers={**env.h(user), "Idempotency-Key": f"k-race-{attempt}-{i}"})
            for i, code in enumerate(codes)])
        statuses = sorted(r.status_code for r in results)
        assert statuses == [201, 409], [r.text for r in results]
        assert [r.json()["code"] for r in results if r.status_code == 409] == ["INSUFFICIENT_TILS"]
        w = await env.wallet(user)
        assert w["til"] >= 0
    [(total,)] = await env.sql("SELECT coalesce(sum(amount), 0) FROM ledger WHERE user_id = :u AND currency = 'til'",
                               u=user)
    assert total == (await env.wallet(user))["til"] >= 0
    # тот же ключ параллельно — одна покупка
    await env.grant(user, "til", 200)
    results = await asyncio.gather(*[
        env.c.post("/internal/v1/game/purchases", json={"item_code": "frame_ink"},
                   headers={**env.h(user), "Idempotency-Key": "k-race-same"}) for _ in range(2)])
    assert sorted(r.status_code for r in results) == [200, 201]
    assert results[0].json() == results[1].json()
    assert len([op for op in await env.ops(user) if op.reason == "shop" and op.amount == -200]) == 1


async def test_kids_buy_for_tils_and_audience(env: Env, user: uuid.UUID) -> None:
    kid, parent = uuid.uuid4(), uuid.uuid4()
    await env.ensure(kid, age_band="6-9", account=parent)
    await env.grant(kid, "til", 100)
    out = await env.buy(kid, "frame_mint", age_band="6-9", account=parent)
    assert out["til_balance"] == 20
    # предмет только для взрослых ребёнку не виден и не продаётся
    await env.adm("POST", "shop/items", {
        "code": "bg_adults_only", "kind": "background", "title": {"ru": "Офис", "uz": "Ofis"},
        "description": {"ru": "Строгий фон", "uz": "Jiddiy fon"}, "asset_id": None,
        "theme": {"bg": "--paper", "accent": "--ink"}, "price_til": 10, "audiences": ["adults"],
        "available_from": None, "available_until": None, "order": 9}, 201, key="k-item-adults")
    await env.adm("POST", "shop/items/bg_adults_only/publish", {"comment": None})
    codes = [i["code"] for i in (await env.get(kid, "shop", age_band="6-9", account=parent))["items"]]
    assert "bg_adults_only" not in codes
    assert "bg_adults_only" in [i["code"] for i in (await env.get(user, "shop"))["items"]]
    r = await env.c.post("/internal/v1/game/purchases", json={"item_code": "bg_adults_only"},
                         headers={**env.h(kid, age_band="6-9", account=parent), "Idempotency-Key": "k-kid-adult"})
    assert r.status_code == 410
