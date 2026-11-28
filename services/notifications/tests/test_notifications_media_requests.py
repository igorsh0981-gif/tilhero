"""Спринт 3 (INTERNAL_API §4, AT-30): шаблон `media_request.decided` (категория support, RU/UZ, редактируемый —
{request_title}, {decision}) и потребитель `catalog.media_request.decided.v1` → запись ученику через общую политику
доставки; маршруты Mini App спринта 3 для кнопок рассылок."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import pytest
from notif_testkit import at, local_day, quiet_around_now
from test_notifications_staff_templates import MANAGE, activate, create

from tilhero_common.messaging import make_envelope
from tilhero_notifications.campaigns import ROUTES, check_content
from tilhero_notifications.templates import (
    DECISION_NAMES,
    SAMPLE_CONTEXT,
    TEMPLATES,
    Context,
    TemplateError,
    default_texts,
    render_campaign,
)

KEY = "media_request.decided"
SPEC = TEMPLATES[KEY]
EVENT = "catalog.media_request.decided.v1"
REQUEST = "5b1f7a0e-2c3d-4e5f-8a9b-0c1d2e3f4a5b"
STATUSES = ("authored_alternative", "licensed", "rejected", "duplicate")
CATALOG_JSON = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "release-notes.json"


def params(status: str = "rejected", title: str = "Moonlight Café", **extra: Any) -> dict[str, Any]:
    return {"request_id": REQUEST, "request_title": title, "status": status, "linked_asset_id": None, **extra}


async def decided(env, user: uuid.UUID, *, status: str = "authored_alternative", title: str = "Moonlight Café",
                  request_id: str = REQUEST, producer: str = "catalog") -> Any:
    return await env.publish(EVENT, {
        "request_id": request_id, "user_id": str(user), "status": status, "title": title,
        "linked_asset_id": "m-own-coffee-order" if status in ("authored_alternative", "licensed") else None,
        "decided_at": "2026-11-18T10:00:00Z",
    }, producer=producer)


# ---------------------------------------------------------------- шаблон


def test_registry_entry() -> None:
    assert SPEC.category == "support" and SPEC.editable and not SPEC.kid and SPEC.kid_variant is None
    assert SPEC.placeholder_names == ("request_title", "decision") and SPEC.in_app and SPEC.gated


@pytest.mark.parametrize("status", STATUSES)
def test_default_texts_ru_uz(status: str) -> None:
    ru = SPEC.render("ru", params(status))
    assert ru.title == "Решение по вашей заявке"
    assert ru.body == (f"Решение по заявке «Moonlight Café»: {DECISION_NAMES[status]['ru']}. "
                       "Подробности — в разделе заявок.")
    assert (ru.button, ru.startapp) == ("Открыть заявки", "route_media_requests")
    uz = SPEC.render("uz-Latn", params(status))
    assert uz.title == "Soʻrovingiz boʻyicha qaror"
    assert uz.body == (f"«Moonlight Café» soʻrovi boʻyicha qaror: {DECISION_NAMES[status]['uz']}. "
                       "Batafsil — soʻrovlar boʻlimida.")
    assert uz.button == "Soʻrovlarni ochish" and uz.buttons() == [[{"text": "Soʻrovlarni ochish",
                                                                     "startapp": "route_media_requests"}]]


def test_default_texts_for_admin_card() -> None:
    texts = default_texts(SPEC)
    assert texts["ru"] == {"title": "Решение по вашей заявке",
                           "body": "Решение по заявке «Moonlight Café»: подобран авторский аналог. "
                                   "Подробности — в разделе заявок.",
                           "button": "Открыть заявки"}
    assert texts["uz"]["body"].startswith("«Moonlight Café» soʻrovi boʻyicha qaror: oʻxshash mualliflik")


def test_placeholder_values_in_learner_language() -> None:
    p = SPEC.validate(params("licensed"))
    assert SPEC.values("ru", p, Context()) == {"request_title": "Moonlight Café",
                                               "decision": "материал лицензирован и добавлен"}
    assert SPEC.values("uz", p, SAMPLE_CONTEXT["uz"]) == {"request_title": "Moonlight Café",
                                                          "decision": "material litsenziyalanib qoʻshildi"}
    for names in DECISION_NAMES.values():
        assert names["ru"] and names["uz"] and "'" not in names["uz"]


def test_request_title_cleaned_truncated_escaped() -> None:
    hostile = "<b>Song</b>‮\n\t" + "x" * 150
    r = SPEC.render("ru", params(title=hostile))
    title_in_body = r.body.split("«", 1)[1].split("»", 1)[0]
    assert len(title_in_body) == 80 and title_in_body.endswith("…")
    assert "‮" not in r.body and "\n" not in r.body
    assert "<b>Song</b>" not in r.telegram_text() and "&lt;b&gt;Song&lt;/b&gt;" in r.telegram_text()


@pytest.mark.parametrize(
    "bad",
    [
        params(status="new"),  # «не решено» уведомлением не бывает
        params(status="in_review"),
        params(title="   "),
        params(title="x" * 201),
        params(note="комментарий сотрудника"),  # комментарий в уведомление не принимается
        {**params(), "request_id": "nope"},
    ],
)
def test_invalid_params(bad: dict[str, Any]) -> None:
    with pytest.raises(TemplateError):
        SPEC.render("ru", bad)


async def test_staff_card_and_active_version_applied(env) -> None:
    """Шаблон редактируемый: карточка с плейсхолдерами и образцами; активная версия сотрудника применяется к новому
    уведомлению; неизвестный плейсхолдер (например, комментарий) — 422."""
    r = await env.client.get(f"/admin/v1/notifications/templates/{KEY}", headers=env.staff(MANAGE))
    assert r.status_code == 200, r.text
    card = r.json()
    assert card["category"] == "support" and card["kid"] is False
    assert [p["name"] for p in card["placeholders"]] == ["request_title", "decision"]
    assert card["placeholders"][1]["sample"] == {"ru": "подобран авторский аналог",
                                                 "uz": "oʻxshash mualliflik materiali tanlandi"}
    bad = await create(env, KEY, {"texts": {
        "ru": {"title": "Решение", "body": "{request_title}: {note}", "button": None},
        "uz": {"title": "Qaror", "body": "{request_title}: {decision}", "button": None}}, "note": "Пробуем"})
    assert (bad.status_code, bad.json()["code"]) == (422, "TEMPLATE_INVALID")
    r = await create(env, KEY, {"texts": {
        "ru": {"title": "Заявка рассмотрена", "body": "«{request_title}» — {decision}.", "button": "К заявкам"},
        "uz": {"title": "Soʻrov koʻrib chiqildi", "body": "«{request_title}» — {decision}.", "button": None}},
        "note": "Короче"})
    assert r.status_code == 201, r.text
    assert (await activate(env, r.json()["version"], key=KEY)).status_code == 200
    user = env.add_user()
    await decided(env, user, status="rejected")
    await env.dispatch(at(local_day(1), "12:00"))
    [msg] = env.gateway.calls
    assert msg["text"] == "<b>Заявка рассмотрена</b>\n«Moonlight Café» — заявка отклонена."
    assert msg["buttons"] == [[{"text": "К заявкам", "startapp": "route_media_requests"}]]
    uz = env.add_user(locale="uz")
    await decided(env, uz, status="licensed", request_id=str(uuid.uuid4()))
    await env.dispatch(at(local_day(1), "12:00"))
    assert env.gateway.calls[-1]["buttons"] == [[{"text": "Soʻrovlarni ochish", "startapp": "route_media_requests"}]]
    assert env.gateway.calls[-1]["text"].endswith("— material litsenziyalanib qoʻshildi.")


# ---------------------------------------------------------------- потребитель и доставка


async def test_decision_reaches_telegram_and_center(env) -> None:
    user = env.add_user()
    ev = await decided(env, user, status="authored_alternative")
    row = await env.one(user)
    assert (row.template, row.category, row.telegram_status) == (KEY, "support", "scheduled")
    assert row.dedup_key == f"media_request.decided:{REQUEST}:authored_alternative"
    assert str(row.source_event_id) == ev.event_id
    await env.dispatch(at(local_day(1), "12:00"))
    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == env.telegram_id(user)
    assert msg["text"] == ("<b>Решение по вашей заявке</b>\nРешение по заявке «Moonlight Café»: подобран авторский "
                           "аналог. Подробности — в разделе заявок.")
    assert msg["buttons"] == [[{"text": "Открыть заявки", "startapp": "route_media_requests"}]]
    row = await env.row(row.notification_id)
    assert row.telegram_status == "sent" and row.params is None
    [item] = (await env.inbox(user))["items"]
    assert (item["category"], item["title"], item["startapp"]) == (
        "support", "Решение по вашей заявке", "route_media_requests")
    [delivered] = await env.events("notification.delivered.v1")
    assert delivered.payload["notification_id"] == str(row.notification_id)


async def test_dedup_same_decision_and_changed_decision(env) -> None:
    user = env.add_user()
    ev = await decided(env, user, status="rejected")
    spec = next(s for s in env.bus.specs if s.durable == "notifications.catalog")
    await spec.handler(ev)  # повтор доставки того же события — inbox
    await decided(env, user, status="rejected")  # то же решение новым событием — ключ дедупликации
    assert len(await env.rows(user)) == 1
    await decided(env, user, status="licensed")  # решение изменено — новое сообщение
    assert [r.dedup_key.rsplit(":", 1)[1] for r in await env.rows(user)] == ["rejected", "licensed"]
    await env.dispatch(at(local_day(1), "12:00"))
    assert len(env.gateway.calls) == 2


async def test_support_category_always_on_switch_off_center_only(env) -> None:
    """Категория support включена всегда (даже если ученик выключил все); общий выключатель — только центр;
    тихие часы — отложить; лимит дня support не считает."""
    no_categories = env.add_user(categories=())
    switched_off = env.add_user(enabled=False)
    quiet = env.add_user(quiet=quiet_around_now())
    for i, user in enumerate((no_categories, switched_off, quiet)):
        await decided(env, user, request_id=str(uuid.UUID(int=i + 1)))
    await env.dispatch()
    assert (await env.one(no_categories)).telegram_status == "sent"
    row = await env.one(switched_off)
    assert (row.telegram_status, row.reason) == ("in_app_only", "notifications_disabled")
    assert [i["title"] for i in (await env.inbox(switched_off))["items"]] == ["Решение по вашей заявке"]
    row = await env.one(quiet)
    assert (row.telegram_status, row.reason) == ("scheduled", "quiet_hours")
    assert [c["telegram_user_id"] for c in env.gateway.calls] == [env.telegram_id(no_categories)]
    assert (await env.one(no_categories)).limit_day is None  # support не идёт в лимит 3 в сутки


async def test_kid_rules_are_not_bypassed(env) -> None:
    """Заявки у детей не бывает (catalog: 403 KIDS_NOT_ALLOWED), но если событие всё же придёт — общая политика детей
    действует: адресат — опекун, только в окне 08:00–20:00 местного."""
    parent = env.add_user(name="Нигора")
    child = env.add_child(parent, name="Мадина")
    day = local_day(1)
    await decided(env, child)
    await env.dispatch(at(day, "07:00"))
    row = await env.one(child)
    assert (row.telegram_status, row.reason, row.scheduled_for) == ("scheduled", "kid_window", at(day, "08:00"))
    await env.dispatch(at(day, "08:00"))
    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == env.telegram_id(parent)
    assert (await env.one(child)).telegram_status == "sent"


async def test_foreign_producer_deleted_user_and_invalid_payload(env) -> None:
    user = env.add_user()
    await decided(env, user, producer="social")  # не catalog — без записи
    assert await env.rows(user) == []
    await env.delete(user)
    await decided(env, user)  # ученик удалён — без записи
    assert await env.rows(user) == []
    other = env.add_user()
    bad = make_envelope(EVENT, {"request_id": REQUEST, "user_id": str(other), "status": "new", "title": "x",
                                "decided_at": "2026-11-18T10:00:00Z"}, producer="catalog")
    await env.bus.publish(bad)  # статус не решение — DLQ, без записи
    assert [e.event_id for _, e in env.bus.dlq] == [bad.event_id]
    assert await env.rows(other) == []


# ---------------------------------------------------------------- маршруты Mini App


SPRINT3_ROUTES = ("diagnostics", "plan", "skills", "scenarios", "media", "media_requests", "languages")
RELEASE61_ROUTES = ("heroes", "shop", "badges", "game_history", "game_settings", "dictionary", "reading")
SPRINT7_ROUTES = ("friends", "leagues", "duels", "referrals")
SPRINT8_ROUTES = ("subscription", "til_shop")


def test_campaign_routes_include_sprint3_and_catalog() -> None:
    assert set(SPRINT3_ROUTES) <= set(ROUTES) and set(RELEASE61_ROUTES) <= set(ROUTES)
    assert set(SPRINT7_ROUTES) <= set(ROUTES) and set(SPRINT8_ROUTES) <= set(ROUTES)
    catalog = json.loads(CATALOG_JSON.read_text())
    # общий каталог маршрутов принимается целиком и только он; спринт 8 — ещё блок planned (переходы релиза 8 до
    # переноса потоком I в основной список; после переноса planned пуст или удалён — равенство сохраняется)
    planned = set(catalog.get("planned", {}).get("routes", []))
    assert set(catalog["routes"]) | planned == set(ROUTES)
    texts = {"ru": {"title": "Заголовок", "body": "Текст", "button": None},
             "uz": {"title": "Sarlavha", "body": "Matn", "button": None}}
    for route in SPRINT3_ROUTES + RELEASE61_ROUTES + SPRINT7_ROUTES + SPRINT8_ROUTES:
        assert check_content("Рассылка", texts, route, {}) == [], route
        assert render_campaign("ru", texts, route, None).startapp == f"route_{route}"
    assert check_content("Рассылка", texts, "media-requests", {}) == [{"path": "route", "reason": "invalid"}]
