"""Staff API шаблонов (admin.ts «Шаблоны уведомлений»): список и карточка, версии (проверка → TEMPLATE_INVALID,
Idempotency-Key), предпросмотр, активация и откат, сброс; AT-20 — новое напоминание уходит с новым текстом;
тестовая отправка (AT-21) — только в тестовые чаты, «[ТЕСТ] », лимит 10/мин; права и вызывающий; аудит."""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import pytest
from notif_testkit import STAFF_ID, at, local_day
from sqlalchemy import update

from tilhero_common.testing import assert_event_conforms, internal_headers
from tilhero_notifications.models import TemplateVersion
from tilhero_notifications.templates import EDITABLE

BASE = "/admin/v1/notifications"
MANAGE = "notif.templates.manage"


def texts(ru_title: str = "Пора заниматься", ru_body: str = "Сегодня — {duration} английского.",
          uz_title: str = "Mashgʻulot vaqti", uz_body: str = "Bugun — {duration} ingliz tili.",
          button: str | None = None) -> dict[str, Any]:
    return {"ru": {"title": ru_title, "body": ru_body, "button": button},
            "uz": {"title": uz_title, "body": uz_body, "button": button}}


async def create(env, key: str = "lesson.reminder", body: dict | None = None, *, idem: str | None = None,
                 headers: dict | None = None) -> httpx.Response:
    h = dict(headers or env.staff(MANAGE))
    if idem:
        h["Idempotency-Key"] = idem
    return await env.client.post(f"{BASE}/templates/{key}/versions",
                                 json=body or {"texts": texts(), "note": "Новый текст"}, headers=h)


async def activate(env, version: int, key: str = "lesson.reminder", reason: str = "Согласовано") -> httpx.Response:
    return await env.client.post(f"{BASE}/templates/{key}/versions/{version}/activate", json={"reason": reason},
                                 headers=env.staff(MANAGE))


async def reset(env, key: str = "lesson.reminder") -> httpx.Response:
    return await env.client.post(f"{BASE}/templates/{key}/reset", json={"reason": "Вернуть как было"},
                                 headers=env.staff(MANAGE))


async def send_reminder(env, user: uuid.UUID, offset: int) -> dict[str, Any]:
    day = local_day(offset)
    await env.reminder(user, day, "10:00", duration=20)
    before = len(env.gateway.calls)
    await env.dispatch(at(day, "10:01"))
    assert len(env.gateway.calls) == before + 1
    return env.gateway.calls[-1]


# ---------------------------------------------------------------- чтение


async def test_list_and_card(env) -> None:
    r = await env.client.get(f"{BASE}/templates", headers=env.staff(MANAGE))
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert [i["key"] for i in items] == list(EDITABLE)
    reminder = items[0]
    assert reminder["key"] == "lesson.reminder" and reminder["category"] == "reminders" and reminder["kid"] is False
    assert reminder["description"]["ru"] and reminder["description"]["en"]
    assert [p["name"] for p in reminder["placeholders"]] == ["duration", "slot_time", "streak_days"]
    assert reminder["placeholders"][0]["sample"] == {"ru": "15 минут", "uz": "15 daqiqa"}
    assert reminder["default_texts"]["ru"] == {
        "title": "Время занятия",
        "body": "По графику — 15 минут английского. Начнём? Вы занимаетесь 5 дней подряд — отлично!",
        "button": "Начать занятие",
    }
    assert (reminder["active_version"], reminder["active_since"], reminder["updated_at"]) == (None, None, None)
    assert {i["key"]: i["kid"] for i in items}["lesson.missed.kid"] is True
    card = await env.client.get(f"{BASE}/templates/lesson.missed.kid", headers=env.staff(MANAGE))
    assert card.status_code == 200 and card.json()["versions"] == []
    assert [p["name"] for p in card.json()["placeholders"]] == ["learner_name", "next_slot_date"]
    for key in ("pin.reset_code", "pin.reset_scheduled", "nope", "campaign"):
        r = await env.client.get(f"{BASE}/templates/{key}", headers=env.staff(MANAGE))
        assert (r.status_code, r.json()["code"]) == (404, "TEMPLATE_NOT_FOUND"), key


ENDPOINTS = [
    ("GET", "/templates", None),
    ("GET", "/templates/lesson.reminder", None),
    ("POST", "/templates/lesson.reminder/versions", {"texts": texts(), "note": "abc"}),
    ("POST", "/templates/lesson.reminder/versions/1/preview", {"lang": "ru"}),
    ("POST", "/templates/lesson.reminder/versions/1/activate", {"reason": "abc"}),
    ("POST", "/templates/lesson.reminder/reset", {"reason": "abc"}),
    ("POST", "/templates/lesson.reminder/versions/1/test", {"lang": "ru", "recipient": 0}),
    ("GET", "/test-recipients", None),
]


@pytest.mark.parametrize(("method", "path", "body"), ENDPOINTS)
async def test_auth_and_permissions(env, method: str, path: str, body: dict | None) -> None:
    async def call(headers: dict[str, str]) -> httpx.Response:
        return await env.client.request(method, BASE + path, json=body, headers=headers)

    r = await call({})
    assert (r.status_code, r.json()["code"]) == (401, "INTERNAL_TOKEN_MISSING")
    r = await call(internal_headers(env.settings, issuer="telegram-bff", subject=str(uuid.uuid4())))
    assert (r.status_code, r.json()["code"]) == (403, "CALLER_NOT_ALLOWED")
    r = await call(env.staff(with_actor=False))
    assert (r.status_code, r.json()["code"]) == (403, "STAFF_CONTEXT_REQUIRED")
    r = await call(env.staff("dashboard.read", "whatsnew.manage", "users.read"))
    assert (r.status_code, r.json()["code"]) == (403, "PERMISSION_DENIED")
    assert r.json()["details"]["permission"] == MANAGE
    assert env.gateway.calls == []


# ---------------------------------------------------------------- версии


async def test_create_version_idempotent_and_audited(env) -> None:
    r = await create(env, idem="tmpl-create-0001")
    assert r.status_code == 201, r.text
    v = r.json()
    assert (v["key"], v["version"], v["status"], v["note"]) == ("lesson.reminder", 1, "draft", "Новый текст")
    assert v["texts"] == texts() and v["created_by"] == STAFF_ID and v["created_by_name"] is None
    assert v["activated_at"] is None and v["created_at"].endswith("Z")
    replay = await create(env, idem="tmpl-create-0001")
    assert replay.status_code == 201 and replay.json() == v
    reused = await create(env, body={"texts": texts(ru_title="Другое"), "note": "Новый текст"},
                          idem="tmpl-create-0001")
    assert (reused.status_code, reused.json()["code"]) == (422, "IDEMPOTENCY_KEY_REUSED")
    second = await create(env, body={"texts": texts(button="  "), "note": "  Вторая  "})
    assert second.json()["version"] == 2 and second.json()["note"] == "Вторая"
    assert second.json()["texts"]["ru"]["button"] is None  # пустая кнопка — кнопка по умолчанию
    records = await env.audit("template.version_created")
    assert [(a["object_id"], a["after"]["version"]) for a in records] == [("lesson.reminder", 1),
                                                                         ("lesson.reminder", 2)]
    assert records[0]["actor_id"] == STAFF_ID and records[0]["actor_type"] == "staff"
    assert "texts" not in str(records[0]["after"])  # тексты в журнал не попадают
    for env_ in await env.events("admin.audit.recorded.v1"):
        assert_event_conforms(env_)
        assert env_.producer == "notifications"
    card = (await env.client.get(f"{BASE}/templates/lesson.reminder", headers=env.staff(MANAGE))).json()
    assert [x["version"] for x in card["versions"]] == [2, 1] and card["active_version"] is None
    assert card["updated_at"] is not None


@pytest.mark.parametrize(
    ("key", "body", "expected"),
    [
        ("lesson.reminder", {"texts": {"ru": {"title": "A", "body": "B"}}, "note": "Без узбекского"},
         {("texts.uz", "required")}),
        ("lesson.reminder", {"texts": texts(uz_body="  "), "note": "Пустой текст"}, {("texts.uz.body", "required")}),
        ("lesson.reminder", {"texts": texts(ru_body="Привет, {learner_name}"), "note": "Чужой плейсхолдер"},
         {("texts.ru.body", "unknown_placeholder")}),
        ("lesson.reminder", {"texts": texts(ru_body="{duration:>9}"), "note": "Формат"},
         {("texts.ru.body", "invalid_placeholder")}),
        ("lesson.reminder", {"texts": texts(ru_title="Т" * 81, uz_title="t\x1bx"), "note": "Длина"},
         {("texts.ru.title", "too_long"), ("texts.uz.title", "control_chars")}),
        ("lesson.reminder.kid", {"texts": texts(ru_body="{learner_name}, не потеряй серию!"), "note": "Давление"},
         {("texts.ru.body", "pressure_words")}),
        ("lesson.reminder.kid", {"texts": texts(ru_body="{streak_days} подряд"), "note": "Серия детям"},
         {("texts.ru.body", "unknown_placeholder")}),
        ("lesson.reminder", {"texts": texts(), "note": "ok"}, {("note", "too_short")}),
    ],
)
async def test_create_version_invalid(env, key: str, body: dict, expected: set) -> None:
    r = await create(env, key, body)
    assert (r.status_code, r.json()["code"]) == (422, "TEMPLATE_INVALID"), r.text
    assert {(f["path"], f["reason"]) for f in r.json()["details"]["fields"]} == expected
    assert await env.audit() == []


async def test_create_version_shape_and_not_found(env) -> None:
    r = await create(env, body={"texts": texts(), "note": "Новый текст", "status": "active"})
    assert (r.status_code, r.json()["code"]) == (422, "VALIDATION_ERROR")
    r = await create(env, body={"texts": {**texts(), "en": {"title": "x", "body": "y"}}, "note": "abcd"})
    assert (r.status_code, r.json()["code"]) == (422, "VALIDATION_ERROR")
    r = await create(env, "pin.reset_code")
    assert (r.status_code, r.json()["code"]) == (404, "TEMPLATE_NOT_FOUND")
    r = await create(env, idem="bad key!")
    assert (r.status_code, r.json()["code"]) == (422, "VALIDATION_ERROR")


async def test_preview(env) -> None:
    await create(env, body={"texts": texts(ru_title="В {slot_time}", ru_body="{duration} — {{вперёд}}"),
                            "note": "Предпросмотр"})
    r = await env.client.post(f"{BASE}/templates/lesson.reminder/versions/1/preview", json={"lang": "ru"},
                              headers=env.staff(MANAGE))
    assert r.status_code == 200, r.text
    assert r.json() == {"lang": "ru", "title": "В 19:00", "body": "15 минут — {вперёд}", "button": "Начать занятие",
                        "telegram_text": "В 19:00\n15 минут — {вперёд}"}
    r = await env.client.post(f"{BASE}/templates/lesson.reminder/versions/1/preview",
                              json={"lang": "uz", "sample": {"duration": "30 daqiqa"}}, headers=env.staff(MANAGE))
    assert r.json()["body"] == "Bugun — 30 daqiqa ingliz tili."
    r = await env.client.post(f"{BASE}/templates/lesson.reminder/versions/1/preview",
                              json={"lang": "ru", "sample": {"learner_name": "x"}}, headers=env.staff(MANAGE))
    assert (r.status_code, r.json()["code"]) == (422, "TEMPLATE_INVALID")
    assert r.json()["details"]["fields"] == [{"path": "sample.learner_name", "reason": "unknown_placeholder"}]
    r = await env.client.post(f"{BASE}/templates/lesson.reminder/versions/9/preview", json={"lang": "ru"},
                              headers=env.staff(MANAGE))
    assert (r.status_code, r.json()["code"]) == (404, "TEMPLATE_VERSION_NOT_FOUND")
    r = await env.client.post(f"{BASE}/templates/lesson.reminder/versions/1/preview", json={"lang": "en"},
                              headers=env.staff(MANAGE))
    assert (r.status_code, r.json()["code"]) == (422, "VALIDATION_ERROR")


# ---------------------------------------------------------------- AT-20: активация, откат, сброс


async def test_at20_new_reminder_uses_active_version_rollback_and_reset(env) -> None:
    user = env.add_user()
    code_text = (await send_reminder(env, user, 1))["text"]
    assert code_text == "<b>Время занятия</b>\nПо графику — 20 минут английского. Начнём?"

    await create(env, body={"texts": texts(ru_title="Пора заниматься", ru_body="Сегодня — {duration} английского."),
                            "note": "Версия 1"})
    await create(env, body={"texts": texts(ru_title="Урок ждёт", ru_body="{duration} — и готово!",
                                           button="Поехали"), "note": "Версия 2"})
    r = await activate(env, 1)
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["activated_by"]) == ("active", STAFF_ID) and r.json()["activated_at"]
    msg = await send_reminder(env, user, 2)
    assert msg["text"] == "<b>Пора заниматься</b>\nСегодня — 20 минут английского."
    assert msg["buttons"] == [[{"text": "Начать занятие", "startapp": "route_home"}]]  # кнопка и startapp — из кода

    r = await activate(env, 2)
    assert r.json()["status"] == "active"
    card = (await env.client.get(f"{BASE}/templates/lesson.reminder", headers=env.staff(MANAGE))).json()
    assert card["active_version"] == 2 and card["active_since"] is not None
    assert {v["version"]: v["status"] for v in card["versions"]} == {2: "active", 1: "archived"}
    msg = await send_reminder(env, user, 3)
    assert msg["text"] == "<b>Урок ждёт</b>\n20 минут — и готово!"
    assert msg["buttons"] == [[{"text": "Поехали", "startapp": "route_home"}]]

    # откат: активация прежней версии
    assert (await activate(env, 1)).json()["status"] == "active"
    assert (await send_reminder(env, user, 4))["text"] == "<b>Пора заниматься</b>\nСегодня — 20 минут английского."
    again = await activate(env, 1)
    assert again.status_code == 200 and again.json()["status"] == "active"

    # сброс к тексту по умолчанию
    r = await reset(env)
    assert r.status_code == 200 and r.json()["active_version"] is None and "versions" not in r.json()
    assert (await send_reminder(env, user, 5))["text"] == code_text.replace("20 минут", "20 минут")
    assert (await reset(env)).status_code == 200  # повтор — без изменений

    actions = [(a["action"], a["before"], a["after"]) for a in await env.audit()
               if a["action"] in ("template.activated", "template.reset")]
    assert actions == [
        ("template.activated", {"active_version": None}, {"active_version": 1}),
        ("template.activated", {"active_version": 1}, {"active_version": 2}),
        ("template.activated", {"active_version": 2}, {"active_version": 1}),
        ("template.reset", {"active_version": 1}, {"active_version": None}),
    ]
    assert all(a["reason"] for a in await env.audit("template.activated"))
    # центр: отправленные записи остались со своим текстом
    titles = [i["title"] for i in (await env.inbox(user))["items"]]
    assert titles == ["Время занятия", "Пора заниматься", "Урок ждёт", "Пора заниматься", "Время занятия"][::-1]


async def test_activate_errors(env) -> None:
    r = await activate(env, 1)
    assert (r.status_code, r.json()["code"]) == (404, "TEMPLATE_VERSION_NOT_FOUND")
    r = await env.client.post(f"{BASE}/templates/pin.reset_code/versions/1/activate", json={"reason": "abc"},
                              headers=env.staff(MANAGE))
    assert (r.status_code, r.json()["code"]) == (404, "TEMPLATE_NOT_FOUND")
    await create(env)
    r = await activate(env, 1, reason="  ")
    assert (r.status_code, r.json()["code"]) == (422, "VALIDATION_ERROR")
    r = await env.client.post(f"{BASE}/templates/lesson.reminder/versions/1/activate", json={},
                              headers=env.staff(MANAGE))
    assert r.status_code == 422
    # версия, ставшая невалидной (например, плейсхолдер удалён из кода), не активируется
    async with env.runtime.transaction() as s:
        await s.execute(update(TemplateVersion).values(texts=texts(ru_body="{gone}")))
    r = await activate(env, 1)
    assert (r.status_code, r.json()["code"]) == (422, "TEMPLATE_INVALID")


async def test_kid_version_names_child_for_parent(env) -> None:
    parent = env.add_user()
    child = env.add_child(parent, name="Мадина")
    await create(env, "lesson.reminder.kid", {"texts": texts(ru_title="{learner_name}: пора на урок",
                                                             ru_body="{duration} вместе — будет весело."),
                                              "note": "Мягче"})
    assert (await activate(env, 1, key="lesson.reminder.kid")).status_code == 200
    day = local_day(1)
    await env.reminder(child, day, "10:00", duration=15)
    await env.dispatch(at(day, "10:01"))
    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == env.telegram_id(parent)
    assert msg["text"] == "<b>Мадина: пора на урок</b>\n15 минут вместе — будет весело."


async def test_release_note_center_uses_active_version(env) -> None:
    user = env.add_user()
    await env.inbox(user)  # водяной знак центра
    r = await create(env, "release_note.published", {
        "texts": texts(ru_title="Обновление TilHero", ru_body="Смотрите!", uz_body="Koʻring!"),
        "note": "Новый заголовок"})
    assert r.status_code == 201, r.text
    assert (await activate(env, 1, key="release_note.published")).status_code == 200
    await env.release_note(audience="all")
    [item] = (await env.inbox(user))["items"]
    assert (item["title"], item["body"], item["startapp"]) == ("Обновление TilHero", "Смотрите!", "route_news")


async def test_active_cache_ttl_and_invalidation(env) -> None:
    """Другая реплика активировала версию: здесь новый текст — не позже TTL (≤ 30 с); своя активация — сразу."""
    cache = env.dispatcher.templates
    assert await cache.get("support.reply") is None
    body = {"texts": texts(ru_body="Ответ по {ticket_number}", uz_body="{ticket_number}"), "note": "Коротко"}
    r = await create(env, "support.reply", body)
    assert r.status_code == 201, r.text
    async with env.runtime.transaction() as s:
        await s.execute(update(TemplateVersion).values(status="active"))
    assert await cache.get("support.reply") is None  # кэш ещё жив
    cache._loaded_at -= env.settings.template_cache_ttl_seconds  # TTL истёк
    assert (await cache.get("support.reply")).version == 1  # type: ignore[union-attr]
    assert env.settings.template_cache_ttl_seconds <= 30
    await reset(env, "support.reply")
    assert await cache.get("support.reply") is None  # сброс на этой реплике — сразу


# ---------------------------------------------------------------- тестовая отправка (AT-21)


async def test_test_recipients_masked(env) -> None:
    r = await env.client.get(f"{BASE}/test-recipients", headers=env.staff(MANAGE))
    assert r.json() == {"items": [{"index": 0, "label": "Тестовый чат 1 (••••1111)"},
                                  {"index": 1, "label": "Тестовый чат 2 (••••2222)"}]}
    assert "5550001111" not in r.text
    r = await env.client.get(f"{BASE}/test-recipients", headers=env.staff("notif.campaigns.manage"))
    assert r.status_code == 200
    env.settings.admin_test_chat_ids = ""
    assert (await env.client.get(f"{BASE}/test-recipients", headers=env.staff(MANAGE))).json() == {"items": []}


async def test_test_send_only_to_test_chats(env) -> None:
    learner = env.add_user()
    await create(env, body={"texts": texts(ru_title="Пора <заниматься>"), "note": "Тест"})
    url = f"{BASE}/templates/lesson.reminder/versions/1/test"
    r = await env.client.post(url, json={"lang": "ru", "recipient": 1}, headers=env.staff(MANAGE))
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["sent"] is True and result["error"] is None and uuid.UUID(result["delivery_id"])
    [msg] = env.gateway.calls
    assert msg["telegram_user_id"] == 5550002222
    assert msg["text"] == "<b>[ТЕСТ] Пора &lt;заниматься&gt;</b>\nСегодня — 15 минут английского."
    assert msg["buttons"] == [[{"text": "Начать занятие", "startapp": "route_home"}]]
    assert msg["idempotency_key"] == result["delivery_id"]
    assert await env.rows() == []  # без записи в центр уведомлений и журнал ученика
    [record] = await env.audit("template.test_sent")
    assert record["after"] == {"version": 1, "lang": "ru", "recipient": 1, "sent": True,
                               "delivery_id": result["delivery_id"]}
    assert "5550002222" not in str(record)

    # ученику — никогда: только индекс из настройки, другие поля не принимаются
    for body in ({"lang": "ru", "recipient": 2}, {"lang": "ru", "recipient": -1}):
        r = await env.client.post(url, json=body, headers=env.staff(MANAGE))
        assert (r.status_code, r.json()["code"]) == (422, "TEST_RECIPIENT_NOT_ALLOWED")
    for body in ({"lang": "ru", "recipient": 0, "telegram_user_id": env.telegram_id(learner)},
                 {"lang": "ru", "recipient": 0, "user_id": str(learner)},
                 {"lang": "ru", "recipient": str(env.telegram_id(learner))}):
        r = await env.client.post(url, json=body, headers=env.staff(MANAGE))
        assert r.status_code == 422, body
    env.settings.admin_test_chat_ids = ""
    r = await env.client.post(url, json={"lang": "ru", "recipient": 0}, headers=env.staff(MANAGE))
    assert (r.status_code, r.json()["code"]) == (422, "TEST_RECIPIENT_NOT_ALLOWED")
    assert len(env.gateway.calls) == 1
    assert env.telegram_id(learner) not in {c["telegram_user_id"] for c in env.gateway.calls}


async def test_test_send_gateway_failure_and_not_found(env) -> None:
    await create(env)
    env.gateway.queue.append(httpx.Response(409, json={"code": "TELEGRAM_BLOCKED", "message": "x", "trace_id": "t",
                                                       "details": {}}))
    r = await env.client.post(f"{BASE}/templates/lesson.reminder/versions/1/test", json={"lang": "uz", "recipient": 0},
                              headers=env.staff(MANAGE))
    assert r.status_code == 200 and r.json() == {"sent": False, "delivery_id": None, "error": "TELEGRAM_BLOCKED"}
    assert (await env.audit("template.test_sent"))[0]["after"]["sent"] is False
    r = await env.client.post(f"{BASE}/templates/lesson.reminder/versions/7/test", json={"lang": "uz", "recipient": 0},
                              headers=env.staff(MANAGE))
    assert (r.status_code, r.json()["code"]) == (404, "TEMPLATE_VERSION_NOT_FOUND")


async def test_test_send_rate_limited_per_staff(env) -> None:
    await create(env)
    url = f"{BASE}/templates/lesson.reminder/versions/1/test"
    for _ in range(10):
        assert (await env.client.post(url, json={"lang": "ru", "recipient": 0},
                                      headers=env.staff(MANAGE))).status_code == 200
    r = await env.client.post(url, json={"lang": "ru", "recipient": 0}, headers=env.staff(MANAGE))
    assert (r.status_code, r.json()["code"]) == (429, "RATE_LIMITED")
    assert int(r.headers["Retry-After"]) >= 1 and r.json()["details"]["retry_after"] >= 1
    other = env.staff(MANAGE, staff_id=str(uuid.uuid4()))
    assert (await env.client.post(url, json={"lang": "ru", "recipient": 0}, headers=other)).status_code == 200
    assert len(env.gateway.calls) == 11
