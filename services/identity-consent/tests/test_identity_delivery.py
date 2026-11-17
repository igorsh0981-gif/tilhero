"""Служебные API: адресация доставки (notifications), публичный профиль (social, notifications), статус бота
(telegram-bot-gateway). Для детского профиля адресат — опекун (CONVENTIONS §8, AT-07)."""

from __future__ import annotations

import io
import logging
import uuid

import pytest

from tilhero_common.logging import JsonFormatter


async def test_delivery_for_account(env) -> None:
    tg = 4_242_424_242
    uid = await env.adult(telegram_user_id=tg, language_code="uz", first_name="Тест")
    await env.consent(uid)
    await env.call("PATCH", "/internal/v1/me/settings", uid, {"notifications": {
        "quiet_hours": {"start": "23:00", "end": "07:00"}, "timezone": "Europe/Moscow",
        "categories": {"reminders": True, "social": True}}})
    r = await env.delivery(uid)
    assert r.status_code == 200
    assert r.json() == {
        "user_id": uid,
        "kind": "account",
        "recipient_telegram_user_id": tg,
        "recipient_is_guardian": False,
        "learner_display_name": "Тест",
        "locale": "uz",
        "age_band": "18+",
        "is_minor": False,
        "notifications_enabled": True,
        "categories": ["reminders", "social", "support"],
        "quiet_hours": {"start": "23:00", "end": "07:00"},
        "timezone": "Europe/Moscow",
        "status": "ACTIVE",
    }
    # статус передаётся — notifications решает, слать ли (transactional PIN-код уходит и при DISABLED)
    await env.call("POST", "/internal/v1/me/disable", uid)
    r = await env.delivery(uid)
    assert r.json()["status"] == "DISABLED" and r.json()["notifications_enabled"] is False


async def test_delivery_access_and_validation(env) -> None:
    uid = await env.adult()
    for caller in ("telegram-bff", "telegram-bot-gateway", "social", "support"):
        r = await env.call("GET", f"/internal/v1/users/{uid}/delivery", None, issuer=caller)
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", caller
    assert (await env.client.get(f"/internal/v1/users/{uid}/delivery")).status_code == 401
    missing = await env.delivery(str(uuid.uuid4()))
    assert missing.status_code == 404 and missing.json()["code"] == "USER_NOT_FOUND"
    assert (await env.call("GET", "/internal/v1/users/abc/delivery", None, issuer="notifications")).status_code == 422


async def test_delivery_for_child_goes_to_guardian(env) -> None:
    tg = 4_343_434_343
    guardian = await env.adult(telegram_user_id=tg, language_code="uz")
    child = await env.child(guardian, "Мадина", "6-9")
    cid = child["learner_id"]
    await env.call("PATCH", f"/internal/v1/me/learners/{cid}", guardian, {"settings": {
        "categories": {"reminders": True, "missed": True}, "quiet_hours": {"start": "20:00", "end": "08:00"},
        "timezone": "Asia/Samarkand"}})
    info = (await env.delivery(cid)).json()
    assert info == {
        "user_id": cid,
        "kind": "child",
        "recipient_telegram_user_id": tg,  # адресат — родитель
        "recipient_is_guardian": True,
        "learner_display_name": "Мадина",  # имя ребёнка — для «Мадина: время занятия»
        "locale": "uz",  # язык опекуна (он читает сообщение)
        "age_band": "6-9",
        "is_minor": True,
        "notifications_enabled": True,
        "categories": ["reminders", "missed", "support"],
        "quiet_hours": {"start": "20:00", "end": "08:00"},
        "timezone": "Asia/Samarkand",
        "status": "ACTIVE",
    }
    # родитель выключил TilHero — сообщения ребёнку в Telegram не уходят (центр уведомлений работает)
    await env.call("POST", "/internal/v1/me/disable", guardian)
    assert (await env.delivery(cid)).json()["notifications_enabled"] is False
    await env.call("POST", "/internal/v1/me/enable", guardian)
    assert (await env.delivery(cid)).json()["notifications_enabled"] is True


@pytest.mark.parametrize(("age_band", "minor"), [("6-9", True), ("10-13", True)])
async def test_child_is_minor(env, age_band, minor) -> None:
    guardian = await env.adult()
    child = await env.child(guardian, age_band=age_band)
    info = (await env.delivery(child["learner_id"])).json()
    assert (info["age_band"], info["is_minor"]) == (age_band, minor)


async def test_account_is_minor_by_age(env) -> None:
    teen = await env.teen()
    adult = await env.adult()
    unknown = await env.new_user()
    assert [(await env.delivery(u)).json()["is_minor"] for u in (teen, adult, unknown)] == [True, False, False]
    assert (await env.delivery(unknown)).json()["age_band"] is None


async def test_public_profile(env) -> None:
    tg = 4_545_454_545
    guardian = await env.adult(telegram_user_id=tg, username="secret_handle", first_name="Анна", last_name="Тест")
    child = await env.child(guardian, "Мадина", "10-13")
    for caller in ("social", "notifications"):
        r = await env.call("GET", f"/internal/v1/users/{guardian}/public", None, issuer=caller)
        assert r.status_code == 200
        assert r.json() == {"user_id": guardian, "display_name": "Анна Тест", "kind": "account", "age_band": "18+",
                            "guardian_consent": "not_required", "status": "ACTIVE"}
        assert "secret_handle" not in r.text and str(tg) not in r.text
    r = await env.call("GET", f"/internal/v1/users/{child['learner_id']}/public", None, issuer="social")
    assert r.json() == {"user_id": child["learner_id"], "display_name": "Мадина", "kind": "child",
                        "age_band": "10-13", "guardian_consent": "granted", "status": "ACTIVE"}
    for caller in ("telegram-bff", "telegram-bot-gateway", "learning-plan"):
        r = await env.call("GET", f"/internal/v1/users/{guardian}/public", None, issuer=caller)
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    assert (await env.client.get(f"/internal/v1/users/{guardian}/public")).status_code == 401
    missing = await env.call("GET", f"/internal/v1/users/{uuid.uuid4()}/public", None, issuer="social")
    assert missing.status_code == 404 and missing.json()["code"] == "USER_NOT_FOUND"
    assert (await env.call("GET", "/internal/v1/users/1/public", None, issuer="social")).status_code == 422


async def test_bot_status_endpoint(env) -> None:
    tg = 3_131_313_131
    uid = await env.adult(telegram_user_id=tg)
    await env.consent(uid)
    child = await env.child(uid)
    cid = child["learner_id"]
    path = f"/internal/v1/telegram-users/{tg}/bot-status"
    for caller in ("telegram-bff", "notifications", "social"):
        r = await env.call("POST", path, None, {"blocked": True}, issuer=caller)
        assert r.status_code == 403
    assert (await env.client.post(path, json={"blocked": True})).status_code == 401
    r = await env.call("POST", path, None, {"blocked": True}, issuer="telegram-bot-gateway")
    assert r.status_code == 204 and r.content == b""
    assert (await env.user_row(uid)).bot_blocked is True
    # настройка пользователя не меняется, но доставка в Telegram выключена — и ему, и его ребёнку (AT-12: центр
    # уведомлений работает)
    assert (await env.call("GET", "/internal/v1/me", uid)).json()["settings"]["enabled"] is True
    assert (await env.delivery(uid)).json()["notifications_enabled"] is False
    assert (await env.delivery(cid)).json()["notifications_enabled"] is False
    # повтор того же статуса — без событий
    await env.call("POST", path, None, {"blocked": True}, issuer="telegram-bot-gateway")
    await env.call("POST", path, None, {"blocked": False}, issuer="telegram-bot-gateway")
    assert (await env.user_row(uid)).bot_blocked is False
    assert (await env.delivery(uid)).json()["notifications_enabled"] is True
    assert (await env.delivery(cid)).json()["notifications_enabled"] is True
    # сброс кэша адресации notifications: аккаунт и ребёнок, по событию на каждое изменение
    for learner in (uid, cid):
        flags = [e.payload["enabled"] for e in await env.events("user.notification_settings.changed.v1", learner)]
        assert flags[-2:] == [False, True], learner

    unknown = await env.call(
        "POST", "/internal/v1/telegram-users/999/bot-status", None, {"blocked": True}, issuer="telegram-bot-gateway"
    )
    assert unknown.status_code == 404
    for bad_path, body in (
        (path, {}),
        (path, {"blocked": "maybe"}),
        (path, {"blocked": True, "x": 1}),
        ("/internal/v1/telegram-users/0/bot-status", {"blocked": True}),
    ):
        r = await env.call("POST", bad_path, None, body, issuer="telegram-bot-gateway")
        assert r.status_code == 422, (bad_path, body)


async def test_bot_status_does_not_log_telegram_id(env) -> None:
    tg = 6_060_606_061
    await env.new_user(telegram_user_id=tg)
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter("identity-consent"))
    logging.getLogger().addHandler(handler)
    try:
        for issuer, body in (
            ("telegram-bot-gateway", {"blocked": True}),
            ("telegram-bff", {"blocked": True}),
            ("telegram-bot-gateway", {"blocked": "?"}),
        ):
            await env.call("POST", f"/internal/v1/telegram-users/{tg}/bot-status", None, body, issuer=issuer)
    finally:
        logging.getLogger().removeHandler(handler)
    logs = stream.getvalue()
    assert "/internal/v1/telegram-users/{telegram_user_id}/bot-status" in logs
    assert str(tg) not in logs


async def test_child_names_and_tokens_do_not_leak_to_logs(env) -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter("identity-consent"))
    logging.getLogger().addHandler(handler)
    try:
        guardian = await env.adult(first_name="Канарейка")
        child = await env.child(guardian, "Секретнаяимя")
        await env.call("PATCH", f"/internal/v1/me/learners/{child['learner_id']}", guardian,
                       {"display_name": "Другоеимя"})
        await env.delivery(child["learner_id"])
        teen = await env.teen()
        token = (await env.call("POST", "/internal/v1/me/guardian-consent-requests", teen)).json()["token"]
        await env.call("GET", f"/internal/v1/guardian-consents/{token}", None)
        await env.call("POST", f"/internal/v1/guardian-consents/{token}/accept", guardian)
    finally:
        logging.getLogger().removeHandler(handler)
    logs = stream.getvalue()
    assert "/internal/v1/guardian-consents/{token}" in logs  # шаблон маршрута, не путь
    for secret in ("Канарейка", "Секретнаяимя", "Другоеимя", token, child["learner_id"]):
        assert secret not in logs, secret
