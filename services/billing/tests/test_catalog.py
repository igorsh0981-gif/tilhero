"""Каталог (AT-83, §1.2): валидатор (ограничения Bot API для Stars, кратность тийинов, реквизиты сайта в stage/prod),
версии (черновик → проверка → активация со step-up → откат), стенд dev/test, каталог по каналу (Mini App — только
Stars, сайт — только сумы), детский профиль без цен, подросток без согласия."""

from __future__ import annotations

import copy
import json
import uuid
from pathlib import Path
from typing import Any

from conftest import SERVICE_DIR, Env, make_settings

from tilhero_billing.domain import catalog
from tilhero_billing.domain.stand import with_test_prices

SEED = json.loads((Path(SERVICE_DIR) / "migrations" / "seed" / "catalog_v1.json").read_text(encoding="utf-8"))
PROD_KW: dict[str, Any] = {"env": "prod", "internal_jwt_secret": "p" * 48, "internal_jwt_private_key": "k" * 43,
                           "identity_consent_url": "http://i:1", "gamification_url": "http://g:1",
                           "botgw_url": "http://b:1", "web_pay_origin": "https://pay.example.uz",
                           "scheduler_token": "s" * 40, "payments_edge_token": "e" * 40}


def codes(issues: list[dict[str, str]]) -> set[tuple[str, str]]:
    return {(i["path"], i["code"]) for i in issues}


def test_validator_rules() -> None:
    dev = make_settings()
    errors, warnings = catalog.validate(with_test_prices(SEED), dev)
    assert errors == []
    # dev/test: пустые фискальные реквизиты и заглушка оферты — предупреждения
    assert ("products[0].fiscal.ikpu", "required") in codes(warnings)
    assert ("offer.url", "placeholder") in codes(warnings)
    from tilhero_billing.settings import Settings

    prod = Settings(**PROD_KW)
    errors, _ = catalog.validate(SEED, prod)
    assert ("products[0].fiscal.ikpu", "required") in codes(errors)
    assert ("merchant.tin", "required") in codes(errors)
    assert ("offer.url", "placeholder") in codes(errors)

    bad = copy.deepcopy(with_test_prices(SEED))
    bad["products"][0]["price_stars"] = 10_001  # подписка Stars ≤ 10 000
    bad["products"][0]["days"] = 31  # subscription_period — только 30 дней
    bad["products"][1]["price_tiyin"] = 12_900_050  # целые сумы
    bad["products"][2]["stars_mode"] = "subscription"  # тилы — разовый счёт
    bad["products"][3]["stars_title"] = {"ru": "x" * 33, "uz": "y"}
    bad["products"][4]["code"] = "til_100"
    bad["trial"]["days"] = 31
    bad["limits"]["order_ttl_minutes"] = 30
    bad["offer"]["url"] = "https://pay.example.uz/offer"
    found = codes(catalog.validate(bad, Settings(**{**PROD_KW, "web_pay_origin": "https://pay.example.uz"}))[0])
    for expected in (("products[0].price_stars", "stars_subscription_price"), ("products[0].days",
                                                                                "stars_subscription_days"),
                     ("products[1].price_tiyin", "multiple_of_100"), ("products[2].stars_mode", "one_time_required"),
                     ("products[3].stars_title.ru", "length"), ("products[4].code", "duplicate"),
                     ("trial.days", "range"), ("limits.order_ttl_minutes", "range"), ("offer.url", "not_on_web_pay")):
        assert expected in found, expected
    steer = copy.deepcopy(with_test_prices(SEED))
    steer["products"][0]["title"]["ru"] = "Плюс — дешевле через Payme"
    steer["products"][1]["description"]["uz"] = "Klik orqali emas, CLICK bilan"
    steer["products"][2]["stars_title"]["ru"] = "Узум тилы"
    steer["products"][3]["description"]["ru"] = "Оплата на pay.example.uz"
    steer["products"][4]["title"]["ru"] = "Кликните, чтобы купить"  # обычное слово — не название провайдера
    found = codes(catalog.validate(steer, make_settings(web_pay_origin="https://pay.example.uz"))[0])
    assert {("products[0].title.ru", "anti_steering"), ("products[1].description.uz", "anti_steering"),
            ("products[2].stars_title.ru", "anti_steering"), ("products[3].description.ru", "anti_steering")} \
        <= found
    assert ("products[4].title.ru", "anti_steering") not in found
    none_on_sale = copy.deepcopy(SEED)
    for p in none_on_sale["products"]:
        if p["kind"] == "subscription":
            p["status"] = "hidden"
    assert ("products", "subscription_on_sale_required") in codes(catalog.validate(none_on_sale, dev)[0])


async def test_stand_activates_catalog_with_test_stars_prices(env: Env) -> None:
    items = (await env.adm("GET", "catalog"))["items"]
    assert [(v["version"], v["status"]) for v in items] == [(1, "active")]
    assert items[0]["activated_by"] == {"staff_id": "system", "name": "Система"}
    v1 = await env.adm("GET", "catalog/1")
    assert {p["code"]: p["price_stars"] for p in v1["payload"]["products"]}["plus_30d"] == 250
    [ev] = await env.events("billing.catalog.activated.v1")
    assert ev.payload["version"] == 1
    audit = [e for e in await env.events("admin.audit.recorded.v1")
             if e.payload["action"] == "billing.catalog_activated"]
    assert audit and audit[0].payload["actor_type"] == "system"


async def test_versions_draft_validate_activate_rollback(env: Env) -> None:
    v1 = await env.adm("GET", "catalog/1")
    payload = copy.deepcopy(v1["payload"])
    payload["products"][2]["price_stars"] = 20
    # права: нет — 403; без токена — 401; не admin-bff — 403
    await env.adm("PUT", "catalog/draft", {"payload": payload, "comment": None}, 403, perms=("billing.read",))
    r = await env.c.get("/internal/v1/admin/billing/catalog")
    assert r.status_code == 401
    r = await env.c.get("/internal/v1/admin/billing/catalog", headers=env.svc("telegram-bff"))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    draft = await env.adm("PUT", "catalog/draft", {"payload": payload, "comment": "тилы дороже"})
    assert draft["version"] == 2 and draft["status"] == "draft" and not draft["validated"]
    assert draft["diff"] == [{"path": "products[til_100].price_stars", "from": 15, "to": 20}]
    # второй PUT без If-Match / со старым — 409 DRAFT_CONFLICT
    await env.adm("PUT", "catalog/draft", {"payload": payload, "comment": None}, 409)
    await env.adm("POST", "catalog/draft/activate", {"comment": "активация без проверки"}, 409)
    check = await env.adm("POST", "catalog/draft/validate")
    assert check["ok"] and check["errors"] == []
    # изменён после проверки — снова не проверен
    payload["products"][2]["price_stars"] = 21
    draft = await env.adm("PUT", "catalog/draft", {"payload": payload, "comment": None},
                          headers={"If-Match": draft["updated_at"]})
    assert not draft["validated"]
    await env.adm("POST", "catalog/draft/activate", {"comment": "активация без проверки"}, 409)
    await env.adm("POST", "catalog/draft/validate")
    await env.adm("POST", "catalog/draft/activate", {"comment": "без второго фактора"}, 403, step_up=False)
    await env.adm("POST", "catalog/draft/activate", {"comment": "без права публикации"}, 403,
                  perms=("billing.manage",))
    active = await env.adm("POST", "catalog/draft/activate", {"comment": "новая цена тилов"})
    assert active["version"] == 2 and active["status"] == "active"
    statuses = {v["version"]: v["status"] for v in (await env.adm("GET", "catalog"))["items"]}
    assert statuses == {1: "archived", 2: "active"}
    # откат — новая версия из архивной
    await env.adm("POST", "catalog/2/rollback", {"comment": "откат активной нельзя"}, 409)
    rolled = await env.adm("POST", "catalog/1/rollback", {"comment": "вернуть старую цену"})
    assert rolled["version"] == 3 and rolled["status"] == "active"
    assert {p["code"]: p["price_stars"] for p in rolled["payload"]["products"]}["til_100"] == 15
    assert [e.payload["version"] for e in await env.events("billing.catalog.activated.v1")] == [1, 2, 3]
    # невалидный черновик сохраняется, но не активируется
    broken = copy.deepcopy(payload)
    broken["products"][0]["price_stars"] = 20_000
    await env.adm("PUT", "catalog/draft", {"payload": broken, "comment": None})
    check = await env.adm("POST", "catalog/draft/validate")
    assert not check["ok"] and {"path": "products[0].price_stars", "code": "stars_subscription_price"} \
        in check["errors"]
    await env.adm("DELETE", "catalog/draft", expect=204)
    await env.adm("DELETE", "catalog/draft", expect=404)


async def test_catalog_by_channel_and_audience(env: Env) -> None:
    adult = await env.account()
    mini = await env.get(adult, "catalog")
    assert mini["providers"] == ["telegram_stars"] and mini["sales_enabled"] is True
    assert mini["can_pay"] and not mini["payer_required"]
    assert mini["trial"] == {"available": True, "days": 7, "minutes": 60}
    assert {p["code"]: p["price"] for p in mini["products"]}["plus_30d"] == {"stars": 250, "mode": "subscription"}
    text = json.dumps(mini, ensure_ascii=False)
    for word in ("tiyin", "payme", "click", "uzum", "price_tiyin"):
        assert word not in text.lower(), word  # анти-стиринг: ни сумм, ни фиатных провайдеров
    web = await env.get(adult, "catalog", chn="web")
    assert set(web["providers"]) == {"payme", "click", "uzum"} and "trial" not in web
    assert {p["code"]: p["price"] for p in web["products"]}["plus_30d"] == {"tiyin": 4_900_000}
    assert "stars" not in json.dumps(web["products"])
    # детский профиль — без цен; подросток без согласия; неизвестный возраст — плательщик нужен
    child = uuid.uuid4()
    await env.profile(child, kind="child", age_band="6-9", guardian=adult)
    kid = await env.get(adult, "catalog", lrn=child, age_band="6-9")
    assert kid["products"] == [] and kid["payer_required"] and not kid["can_pay"] and kid["trial"] is None
    teen = await env.account("14-17")
    t = await env.get(teen, "catalog", age_band="14-17")
    assert not t["can_pay"] and t["consent_required"] and not t["payer_required"]
    await env.consent(teen)
    assert (await env.get(teen, "catalog", age_band="14-17"))["can_pay"]
    unknown = uuid.uuid4()
    u = await env.get(unknown, "catalog", age_band=None)
    assert u["payer_required"] and not u["can_pay"]
    # нет канала в токене — 401; чужой вызывающий — 403
    r = await env.c.get("/internal/v1/me/billing/catalog", headers=env.h(adult, chn=None))
    assert r.status_code == 401
    r = await env.c.get("/internal/v1/me/billing/catalog", headers=env.h(adult, issuer="lessons"))
    assert r.status_code == 403
