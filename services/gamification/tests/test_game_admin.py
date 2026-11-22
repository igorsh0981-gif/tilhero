"""Админ-API (§1.11, AT-71): правила (черновик → проверка → активация со step-up, If-Match, история, diff, откат),
герои (черновик, публикация, замена картинки без релиза), картинки (сигнатура, размер, sha256), магазин, события
недели (пересечения, начало в прошлом, отмена), права и step-up, аудит."""

from __future__ import annotations

import copy
import struct
import uuid
import zlib
from datetime import timedelta
from pathlib import Path
from typing import Any

from conftest import SERVICE_DIR, Env

SEED_IMG = Path(SERVICE_DIR) / "migrations" / "seed" / "heroes"


def png(w: int, h: int, extra: int = 0) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes([(x * 7 + y) % 256 for x in range(w * 4)]) for y in range(h))
    body = chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw))
    if extra:
        body += chunk(b"tEXt", b"pad\x00" + bytes(i % 251 for i in range(extra)))
    return b"\x89PNG\r\n\x1a\n" + body + chunk(b"IEND", b"")


async def upload(env: Env, data: bytes, content_type: str = "image/png", purpose: str = "hero_stage",
                 expect: int = 201, **kw: Any) -> Any:
    r = await env.c.post(f"/internal/v1/admin/game/assets?purpose={purpose}", content=data,
                         headers={**env.staff(*kw.get("perms", ())), "content-type": content_type})
    assert r.status_code == expect, r.text
    return r.json()


async def audits(env: Env, action: str) -> list[Any]:
    return [e for e in await env.events("admin.audit.recorded.v1") if e.payload["action"] == action]


# ---------------------------------------------------------------- правила


async def test_rules_draft_validate_activate(env: Env, user: uuid.UUID) -> None:
    listing = await env.adm("GET", "rules", perms=("game.read",))
    assert [(v["version"], v["status"]) for v in listing["items"]] == [(2, "active"), (1, "archived")]
    assert "payload" not in listing["items"][0]
    v1 = await env.adm("GET", "rules/2", perms=("game.read",))  # версия 2 — миграция спринта 7
    assert v1["diff"] == [] and v1["created_by"] == {"staff_id": "system", "name": "Система"}
    await env.adm("GET", "rules/99", expect=404)
    # структурные ошибки — черновик не сохраняется
    bad = copy.deepcopy(v1["payload"])
    bad["earn"]["lesson"]["xp"] = "20"
    bad["extra"] = 1
    del bad["caps"]
    out = await env.adm("PUT", "rules/draft", {"payload": bad, "comment": None, "based_on": 2}, 422)
    assert out["code"] == "RULES_INVALID"
    assert {(e["path"], e["code"]) for e in out["details"]["errors"]} == {
        ("earn.lesson.xp", "type"), ("extra", "unknown_key"), ("caps", "required")}
    await env.adm("PUT", "rules/draft", {"payload": v1["payload"], "comment": None, "based_on": 2}, 403,
                  perms=("game.read",))
    # смысловые ошибки — сохраняется, проверка показывает
    semantic = copy.deepcopy(v1["payload"])
    semantic["levels"] = [0, 100, 90]
    semantic["caps"]["xp_per_day"] = 10
    semantic["quests"]["templates"] = [t for t in semantic["quests"]["templates"] if "kids" not in t["audiences"]]
    draft = await env.adm("PUT", "rules/draft", {"payload": semantic, "comment": "черновик", "based_on": 2})
    assert draft["status"] == "draft" and draft["version"] == 3 and draft["validated_at"] is None
    assert {d["path"] for d in draft["diff"]} >= {"levels", "caps.xp_per_day", "quests.templates"}
    # замена — только с If-Match = updated_at
    await env.adm("PUT", "rules/draft", {"payload": semantic, "comment": None, "based_on": 2}, 409)
    out = await env.adm("PUT", "rules/draft", {"payload": semantic, "comment": None, "based_on": 2}, 409,
                        headers={"If-Match": "2020-01-01T00:00:00.000Z"})
    assert out["code"] == "DRAFT_CONFLICT" and out["details"]["updated_at"] == draft["updated_at"]
    check = await env.adm("POST", "rules/draft/validate")
    assert not check["ok"] and {(e["path"], e["code"]) for e in check["errors"]} >= {
        ("levels", "not_increasing"), ("quests.templates.kids", "too_few_templates")}
    out = await env.adm("POST", "rules/draft/activate", {"comment": "попытка активации"}, 409)
    assert out["code"] == "RULES_NOT_VALIDATED"
    # исправить → предупреждения не блокируют
    good = copy.deepcopy(v1["payload"])
    good["earn"]["lesson"]["xp"] = 70
    good["caps"]["xp_per_day"] = 400
    good["hero"]["stage_thresholds"] = [0, 12, 20]
    draft = await env.adm("PUT", "rules/draft", {"payload": good, "comment": None, "based_on": 2},
                          headers={"If-Match": f'"{draft["updated_at"]}"'})
    check = await env.adm("POST", "rules/draft/validate")
    assert check["ok"] and check["errors"] == []
    assert {(w["path"], w["code"]) for w in check["warnings"]} == {
        ("earn.lesson.xp", "reward_growth_x2"), ("hero.stage_thresholds[1]", "stage2_above_10")}
    # активация: право, step-up, комментарий ≥ 10
    for perms, step_up, body, code in ((("game.manage",), True, {"comment": "активируем правила"}, 403),
                                       ((), False, {"comment": "активируем правила"}, 403),
                                       ((), True, {"comment": "коротко"}, 422)):
        out = await env.adm("POST", "rules/draft/activate", body, code, perms=perms, step_up=step_up)
    assert out["code"] == "VALIDATION_ERROR"
    r = await env.c.post("/internal/v1/admin/game/rules/draft/activate", json={"comment": "активируем правила"},
                         headers=env.staff(step_up=False))
    assert r.json()["code"] == "STEP_UP_REQUIRED"
    active = await env.adm("POST", "rules/draft/activate", {"comment": "активируем правила"})
    assert active["status"] == "active" and active["version"] == 3 and active["diff"] == []
    assert active["activated_by"]["name"] == "Оператор" and active["comment"] == "активируем правила"
    assert [v["status"] for v in (await env.adm("GET", "rules"))["items"]] == ["active", "archived", "archived"]
    assert (await env.adm("GET", "rules/2"))["diff"]  # архивная отличается от активной
    [ev] = await env.events("game.rules.activated.v1")
    assert ev.payload["version"] == 3 and ev.payload["based_on"] == 2
    assert [a.payload["reason"] for a in await audits(env, "game.rules.activated")] == ["активируем правила"]
    # откат — только архивная; активную и несуществующую — нельзя
    assert (await env.adm("POST", "rules/3/rollback", {"comment": "откат правил игры"}, 409))["code"] == "RULES_STATE"
    await env.adm("POST", "rules/77/rollback", {"comment": "откат правил игры"}, 404)
    await env.adm("POST", "rules/2/rollback", {"comment": "откат правил игры"}, 403, step_up=False)
    # черновик удаляется; без черновика — 404
    await env.adm("PUT", "rules/draft", {"payload": good, "comment": None, "based_on": 3})
    await env.adm("DELETE", "rules/draft", expect=204)
    await env.adm("DELETE", "rules/draft", expect=404)
    await env.adm("POST", "rules/draft/validate", expect=404)


# ---------------------------------------------------------------- картинки и герои


async def test_assets_upload_rules(env: Env) -> None:
    img = png(16, 8)
    a = await upload(env, img)
    assert (a["width"], a["height"], a["size"]) == (16, 8, len(img)) and a["url"].endswith("/content")
    again = await upload(env, img, expect=200)  # та же картинка — тот же asset_id
    assert again["asset_id"] == a["asset_id"]
    webp = (SEED_IMG / "pet_0_1.webp").read_bytes()
    w = await upload(env, webp, "image/webp", purpose="shop_item")
    assert (w["width"], w["height"]) == (362, 460)
    # больше общего лимита тела 256 КиБ, но в пределах 300 КБ — принимается
    big = png(4, 4, extra=270_000)
    assert 262_144 < len(big) < 300 * 1024
    assert (await upload(env, big))["size"] == len(big)
    for data, ctype, reason in ((b"GIF89a" + b"\x00" * 64, "image/png", "signature"),
                                (img, "image/webp", "signature"),
                                (img, "text/plain", "content_type"),
                                (png(1025, 2), "image/png", "dimensions"),
                                (b"", "image/png", "empty"),
                                (img[:20], "image/png", "header")):
        out = await upload(env, data, ctype, expect=422)
        assert out["code"] == "ASSET_INVALID" and out["details"]["reason"] == reason, (reason, out)
    out = await upload(env, png(4, 4, extra=300 * 1024), expect=413)
    assert out["code"] == "ASSET_TOO_LARGE"
    await upload(env, img, perms=("game.read",), expect=403)
    meta = await env.adm("GET", f"assets/{a['asset_id']}", perms=("game.read",))
    assert meta["sha256"] == a["sha256"] and meta["purpose"] == "hero_stage"
    r = await env.c.get(f"/internal/v1/admin/game/assets/{a['asset_id']}/content", headers=env.staff("game.read"))
    assert r.status_code == 200 and r.content == img and r.headers["content-type"] == "image/png"
    await env.adm("GET", f"assets/{uuid.uuid4()}", expect=404)
    [audit] = [x for x in await audits(env, "game.asset.uploaded") if x.payload["object_id"] == a["asset_id"]]
    assert audit.payload["after"]["sha256"] == a["sha256"]


async def test_hero_image_replaced_without_release(env: Env, user: uuid.UUID) -> None:
    await env.send("PUT", user, "hero", {"hero_code": "pet_0"})
    old = (await env.get(user, "summary"))["hero"]["image"]
    new = await upload(env, png(32, 46))
    heroes = (await env.adm("GET", "heroes", perms=("game.read",)))["items"]
    assert len(heroes) == 9
    hero = next(h for h in heroes if h["code"] == "pet_0")
    assert hero["learners"] == 1 and hero["draft"] is None and hero["version"] == 1
    assert hero["images"][0]["image"]["url"] == f"/admin/v1/game/assets/{hero['stages'][0]['asset_id']}/content"
    stages = copy.deepcopy(hero["stages"])
    stages[0]["asset_id"] = new["asset_id"]
    body = {"name": hero["name"], "tagline": {"ru": "Новый слоган", "uz": "Yangi shior"},
            "audiences": hero["audiences"], "stages": stages}
    shop_img = await upload(env, png(8, 8), purpose="shop_item")
    bad = copy.deepcopy(body)
    bad["stages"][1]["asset_id"] = shop_img["asset_id"]
    assert (await env.adm("PUT", "heroes/pet_0/draft", bad, 422))["code"] == "ASSET_INVALID"
    await env.adm("PUT", "heroes/pet_0/draft", {**body, "stages": stages[:2]}, 422)
    await env.adm("PUT", "heroes/pet_0/draft", {**body, "name": {"ru": "", "uz": "x"}}, 422)
    await env.adm("PUT", "heroes/robot_9/draft", body, 404)
    await env.adm("PUT", "heroes/pet_0/draft", body, 403, perms=("game.read",))
    hero = await env.adm("PUT", "heroes/pet_0/draft", body)
    assert hero["draft"]["stages"][0]["asset_id"] == new["asset_id"] and hero["draft"]["updated_at"]
    # черновик ученику не виден, картинка черновика не отдаётся
    assert (await env.get(user, "summary"))["hero"]["image"] == old
    r = await env.c.get(f"/internal/v1/game/assets/{new['asset_id']}", headers=env.svc())
    assert r.status_code == 404 and r.json()["code"] == "ASSET_NOT_FOUND"
    await env.adm("POST", "heroes/pet_0/publish", {"comment": "новая картинка"}, 403, step_up=False)
    hero = await env.adm("POST", "heroes/pet_0/publish", {"comment": "новая картинка"})
    assert hero["version"] == 2 and hero["draft"] is None and hero["tagline"]["ru"] == "Новый слоган"
    assert hero["published_by"]["name"] == "Оператор"
    img = (await env.get(user, "summary"))["hero"]["image"]
    assert img["asset_id"] == new["asset_id"] and img["url"] == f"/v1/game/assets/{new['asset_id']}/{new['sha256']}"
    r = await env.c.get(f"/internal/v1/game/assets/{new['asset_id']}", headers=env.svc())
    assert r.status_code == 200 and r.headers["etag"] == f'"{new["sha256"]}"'
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert r.headers["content-type"] == "image/png"
    r = await env.c.get(f"/internal/v1/game/assets/{new['asset_id']}",
                        headers={**env.svc(), "If-None-Match": f'"{new["sha256"]}"'})
    assert r.status_code == 304 and r.content == b""
    # прежняя картинка больше не используется в опубликованном
    r = await env.c.get(f"/internal/v1/game/assets/{old['asset_id']}", headers=env.svc())
    assert r.status_code == 404
    out = await env.adm("POST", "heroes/pet_0/publish", {"comment": None}, 409)
    assert out["code"] == "HERO_DRAFT_MISSING"
    assert [a.payload["object_id"] for a in await audits(env, "game.hero.published")] == ["pet_0"]


# ---------------------------------------------------------------- магазин


async def test_shop_items_admin(env: Env, user: uuid.UUID) -> None:
    img = await upload(env, png(10, 10), purpose="shop_item")
    item = {"code": "frame_star", "kind": "hero_frame", "title": {"ru": "Звёздная", "uz": "Yulduzli"},
            "description": {"ru": "Рамка со звёздами", "uz": "Yulduzli ramka"}, "asset_id": img["asset_id"],
            "theme": None, "price_til": 70, "audiences": ["kids", "teens", "adults"], "available_from": None,
            "available_until": None, "order": 10}
    created = await env.adm("POST", "shop/items", item, 201, key="k-item-star", staff_id="s-1")
    assert created["status"] == "draft" and created["owners"] == 0 and created["image"]["asset_id"] == img["asset_id"]
    again = await env.adm("POST", "shop/items", item, 200, key="k-item-star", staff_id="s-1")
    assert again == created
    await env.adm("POST", "shop/items", {**item, "price_til": 71}, 422, key="k-item-star", staff_id="s-1")
    assert (await env.adm("POST", "shop/items", item, 409, key="k-item-star2"))["code"] == "ITEM_CODE_TAKEN"
    await env.adm("POST", "shop/items", item, 400)
    for bad in ({"kind": "streak_freeze"}, {"kind": "xp_boost"}, {"price_til": 0}, {"code": "Bad Code"},
                {"audiences": []}):
        await env.adm("POST", "shop/items", {**item, **bad, "code": bad.get("code", "frame_bad")}, 422,
                      key=f"k-{uuid.uuid4()}")
    out = await env.adm("POST", "shop/items", {**item, "code": "frame_css", "asset_id": None,
                                               "theme": {"bg": "red; background:url(x)", "accent": "--ok"}}, 422,
                        key="k-item-css")
    assert out["code"] == "ITEM_INVALID"
    assert "frame_star" not in [i["code"] for i in (await env.get(user, "shop"))["items"]]
    patched = await env.adm("PATCH", "shop/items/frame_star", {"price_til": 75,
                                                                "theme": {"bg": "ok-soft", "accent": "--ok"}})
    assert patched["price_til"] == 75 and patched["theme"] == {"bg": "--ok-soft", "accent": "--ok"}
    await env.adm("POST", "shop/items/frame_star/publish", {"comment": None}, 403, step_up=False)
    await env.adm("POST", "shop/items/frame_star/publish", {"comment": None}, 403, perms=("game.manage",))
    published = await env.adm("POST", "shop/items/frame_star/publish", {"comment": "в продажу"})
    assert published["status"] == "published"
    assert (await env.adm("POST", "shop/items/frame_star/publish", None, 409))["code"] == "ITEM_STATE"
    out = await env.adm("PATCH", "shop/items/frame_star", {"price_til": 80}, 409)
    assert out["code"] == "ITEM_NOT_EDITABLE" and out["details"]["fields"] == ["price_til"]
    until = (env.now + timedelta(days=30)).isoformat()
    assert (await env.adm("PATCH", "shop/items/frame_star", {"order": 2, "available_until": until}))["order"] == 2
    view = {i["code"]: i for i in (await env.get(user, "shop"))["items"]}["frame_star"]
    assert view["image"]["url"] == f"/v1/game/assets/{img['asset_id']}/{img['sha256']}" and view["available_until"]
    r = await env.c.get(f"/internal/v1/game/assets/{img['asset_id']}", headers=env.svc())
    assert r.status_code == 200
    await env.grant(user, "til", 100)
    await env.buy(user, "frame_star")
    items = {i["code"]: i for i in (await env.adm("GET", "shop/items", perms=("game.read",)))["items"]}
    assert items["frame_star"]["owners"] == 1 and items["streak_freeze"]["price_til"] == 40
    await env.adm("POST", "shop/items/frame_star/retire", {"comment": "снять"})
    await env.adm("POST", "shop/items/frame_star/publish", {"comment": "вернуть"})  # снятый можно вернуть
    await env.adm("PATCH", "shop/items/no_item", {"order": 1}, 404)
    await env.adm("PATCH", "shop/items/streak_freeze", {"price_til": 10}, 409)  # цена заморозки — в правилах
    actions = [a.payload["action"] for a in await env.events("admin.audit.recorded.v1")
               if a.payload["object_type"] == "game_shop_item"]
    assert actions == ["game.shop_item.created", "game.shop_item.updated", "game.shop_item.published",
                       "game.shop_item.updated", "game.shop_item.retired", "game.shop_item.published"]


# ---------------------------------------------------------------- события недели


def event_body(env: Env, code: str, *, start_in: timedelta = timedelta(hours=1), days: int = 7,
               audiences: list[str] | None = None, multipliers: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    starts = env.now + start_in
    return {"code": code, "title": {"ru": "Неделя чтения", "uz": "Oʻqish haftaligi"},
            "description": {"ru": "×2 XP за чтение", "uz": "Oʻqish uchun ×2 XP"}, "starts_at": starts.isoformat(),
            "ends_at": (starts + timedelta(days=days)).isoformat(), "audiences": audiences or ["teens", "adults"],
            "multipliers": multipliers or [{"action": "reading", "currency": "xp", "factor": 2}]}


async def test_week_events_admin(env: Env, user: uuid.UUID) -> None:
    a = await env.adm("POST", "events", event_body(env, "reading_week"), 201, key="k-event-a")
    assert a["status"] == "draft" and a["multipliers"] == [{"action": "reading", "currency": "xp", "factor": 2}]
    await env.adm("POST", "events", event_body(env, "too_long", days=15), 422, key="k-event-long")
    await env.adm("POST", "events", event_body(env, "bad_factor", multipliers=[
        {"action": "reading", "currency": "xp", "factor": 5}]), 422, key="k-event-f")
    await env.adm("POST", "events", event_body(env, "dup_pair", multipliers=[
        {"action": "reading", "currency": "xp", "factor": 2}, {"action": "reading", "currency": "xp", "factor": 3}]),
        422, key="k-event-dup")
    assert (await env.adm("POST", "events", event_body(env, "reading_week"), 409, key="k-event-a2"))["code"] == \
        "EVENT_CODE_TAKEN"
    a = await env.adm("PATCH", f"events/{a['event_id']}", {"audiences": ["adults"]})
    assert a["audiences"] == ["adults"]
    await env.adm("POST", f"events/{a['event_id']}/publish", {"comment": None}, 403, step_up=False)
    a = await env.adm("POST", f"events/{a['event_id']}/publish", {"comment": "запуск"})
    assert a["status"] == "published" and a["published_by"]["name"] == "Оператор"
    await env.adm("PATCH", f"events/{a['event_id']}", {"audiences": ["kids"]}, 409)
    # пересечение периода, аудитории и пары действие/валюта с опубликованным
    b = await env.adm("POST", "events", event_body(env, "reading_more", start_in=timedelta(days=2)), 201,
                      key="k-event-b")
    out = await env.adm("POST", f"events/{b['event_id']}/publish", {"comment": None}, 409)
    assert out["code"] == "EVENT_OVERLAP" and out["details"]["event_id"] == a["event_id"]
    # другая аудитория или другая валюта — можно
    c = await env.adm("POST", "events", event_body(env, "kids_reading", audiences=["kids"]), 201, key="k-event-c")
    await env.adm("POST", f"events/{c['event_id']}/publish", {"comment": None})
    d = await env.adm("POST", "events", event_body(env, "reading_til", multipliers=[
        {"action": "reading", "currency": "til", "factor": 1.5}]), 201, key="k-event-d")
    assert (await env.adm("POST", f"events/{d['event_id']}/publish", {"comment": None}))["multipliers"][0][
        "factor"] == 1.5
    # начало в прошлом — 422
    e = await env.adm("POST", "events", event_body(env, "past_week", start_in=timedelta(minutes=5)), 201,
                      key="k-event-e")
    env.now += timedelta(hours=2)
    assert (await env.adm("POST", f"events/{e['event_id']}/publish", None, 422))["code"] == "EVENT_STARTS_IN_PAST"
    # событие действует в свой период; отмена — дальше без множителя, проведённое не пересчитывается
    await env.send("PATCH", user, "settings", {"quests_hidden": True})
    await env.lesson(user, "reading")
    s = await env.get(user, "summary")
    assert {ev["event_id"] for ev in s["events"]} == {a["event_id"], d["event_id"]}
    await env.adm("POST", f"events/{a['event_id']}/cancel", {"comment": "ошибка"})
    await env.lesson(user, "reading")
    assert [op.amount for op in await env.ops(user) if op.currency == "xp"] == [20, 10]
    assert (await env.adm("POST", f"events/{a['event_id']}/cancel", None, 409))["code"] == "EVENT_STATE"
    listing = await env.adm("GET", "events", perms=("game.read",))
    assert len(listing["items"]) == 5
    published = await env.adm("GET", "events?status=published", perms=("game.read",))
    assert {x["code"] for x in published["items"]} == {"kids_reading", "reading_til"}
    # tick: published → finished после окончания
    env.now += timedelta(days=8)
    assert (await env.tick())["events_finished"] == 2
    overview = await env.adm("GET", "overview?period=7d", perms=("dashboard.read",))
    assert overview["active_events"] == [] and overview["active_rules_version"] == 2
    await env.adm("GET", "overview", expect=403, perms=("wallet.adjust",))
