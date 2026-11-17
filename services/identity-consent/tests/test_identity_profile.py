"""Профиль: telegram-login, /me, настройки, отключение/включение, политика; авторизация и изоляция."""

from __future__ import annotations

import asyncio
import random
import uuid

import pytest

from tilhero_common.testing import internal_headers
from tilhero_identity.settings import Settings

# Все эндпоинты telegram-bff, которым нужен пользователь из токена: (метод, путь, тело).
ME_ENDPOINTS = [
    ("GET", "/internal/v1/me", None),
    ("PATCH", "/internal/v1/me/settings", {"locale": "en"}),
    ("PUT", "/internal/v1/me/pin", {"pin": "2580"}),
    ("DELETE", "/internal/v1/me/pin", {"current_pin": "2580"}),
    ("POST", "/internal/v1/me/pin/verify", {"pin": "2580"}),
    ("POST", "/internal/v1/me/pin/reset-request", None),
    ("POST", "/internal/v1/me/pin/reset-confirm", {"code": "123456", "new_pin": "2580"}),
    ("PUT", "/internal/v1/me/biometric", None),
    ("DELETE", "/internal/v1/me/biometric", None),
    ("POST", "/internal/v1/me/biometric/verify", {"biometric_token": "x" * 43}),
    (
        "POST",
        "/internal/v1/me/consent",
        {"policy_version": "1.0", "purposes": ["personalization"], "age_confirmed_18_plus": True},
    ),
    ("DELETE", "/internal/v1/me/consent", None),
    ("POST", "/internal/v1/me/disable", None),
    ("POST", "/internal/v1/me/enable", None),
    ("POST", "/internal/v1/me/deletion-request", {"confirm_word": "DELETE"}),
]
LOGIN = ("POST", "/internal/v1/users/telegram-login", {"telegram_user_id": 77, "first_name": "Тест"})
POLICY = ("GET", "/internal/v1/legal/policy?lang=ru", None)
ALL_BFF = [*ME_ENDPOINTS, LOGIN, POLICY]


@pytest.mark.parametrize(("method", "path", "body"), ALL_BFF)
async def test_bff_endpoints_require_valid_internal_token_from_telegram_bff(env, method, path, body) -> None:
    uid = str(uuid.uuid4())
    missing = await env.client.request(method, path, json=body)
    assert missing.status_code == 401 and missing.json()["code"] == "INTERNAL_TOKEN_MISSING"
    forged = Settings(env="test", internal_jwt_secret="forged-" + "y" * 40)
    bad = await env.client.request(
        method,
        path,
        json=body,
        headers=internal_headers(forged, issuer="telegram-bff", subject=uid, audience="identity-consent"),
    )
    assert bad.status_code == 401 and bad.json()["code"] == "INTERNAL_TOKEN_INVALID"
    wrong_aud = await env.client.request(
        method, path, json=body, headers=internal_headers(env.settings, subject=uid, audience="support")
    )
    assert wrong_aud.status_code == 401
    for caller in ("notifications", "telegram-bot-gateway", "admin-bff"):
        r = await env.call(method, path, uid, body, issuer=caller)
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", (caller, r.text)


@pytest.mark.parametrize(("method", "path", "body"), ME_ENDPOINTS)
async def test_me_endpoints_take_user_only_from_token(env, method, path, body) -> None:
    no_sub = await env.call(method, path, None, body)
    assert no_sub.status_code == 401 and no_sub.json()["code"] == "USER_CONTEXT_REQUIRED"
    bad_sub = await env.call(method, path, "not-a-uuid", body)
    assert bad_sub.status_code == 401 and bad_sub.json()["code"] == "USER_CONTEXT_INVALID"
    # Чужой/несуществующий пользователь → 404, а не 403 (не раскрываем существование).
    unknown = await env.call(method, path, str(uuid.uuid4()), body)
    assert unknown.status_code == 404 and unknown.json()["code"] == "USER_NOT_FOUND", unknown.text


async def test_telegram_login_creates_profile_once(env) -> None:
    tg = random.randint(10**8, 10**10)
    first = await env.login(
        tg, username="@demo_user", first_name="Тест", last_name="Маска", language_code="uz"
    )
    user = first["user"]
    assert user["is_new"] is True and user["locale"] == "ru" and user["status"] == "ACTIVE"
    assert user["display_name"] == "Тест Маска" and user["username"] == "demo_user"
    assert first["onboarding_completed"] is None
    assert first["security"] == {
        "pin_enabled": False,
        "pin_length": None,
        "biometric_enabled": False,
        "pin_required": False,
        "locked_until": None,
    }
    assert first["consent"] == {
        "accepted": False,
        "policy_version": None,
        "current_policy_version": "1.0",
        "accepted_at": None,
        "evidence_hash": None,
        "age_confirmed_18_plus": False,
    }
    assert first["settings"] == {
        "enabled": False,
        "quiet_hours": None,
        "digest_time": "09:00",
        "timezone": "Asia/Tashkent",
    }
    assert "telegram_user_id" not in first["user"]  # Telegram ID наружу не отдаём

    again = await env.login(tg, username="demo_user2", first_name="Тест2", language_code="de")
    assert again["user"]["user_id"] == user["user_id"] and again["user"]["is_new"] is False
    # снимок обновлён, а язык, выбранный при регистрации, — нет (его меняет пользователь в настройках)
    assert again["user"]["username"] == "demo_user2" and again["user"]["display_name"] == "Тест2"
    assert again["user"]["locale"] == "ru"

    created = await env.events("user.profile.created.v1")
    assert len(created) == 1 and created[0].payload["user_id"] == user["user_id"]
    assert created[0].payload["locale"] == "ru" and created[0].producer == "identity-consent"

    en = await env.login(language_code="en-GB")
    assert en["user"]["locale"] == "en"
    assert (await env.login(language_code=None))["user"]["locale"] == "en"


async def test_telegram_login_is_race_safe(env) -> None:
    tg = random.randint(10**8, 10**10)
    body = {"telegram_user_id": tg, "first_name": "Тест"}
    results = await asyncio.gather(
        *[env.client.post("/internal/v1/users/telegram-login", json=body, headers=env.h()) for _ in range(6)]
    )
    assert all(r.status_code == 200 for r in results)
    assert len({r.json()["user"]["user_id"] for r in results}) == 1
    assert sum(r.json()["user"]["is_new"] for r in results) == 1
    assert len(await env.events("user.profile.created.v1")) == 1


async def test_telegram_login_updates_last_seen(env) -> None:
    from sqlalchemy import select

    from tilhero_identity.models import User

    tg = random.randint(10**8, 10**10)
    uid = await env.new_user(telegram_user_id=tg)
    async with env.runtime.transaction() as s:
        before = (
            await s.execute(select(User.last_seen_at).where(User.user_id == uuid.UUID(uid)))
        ).scalar_one()
    await asyncio.sleep(0.01)
    await env.login(tg)
    async with env.runtime.transaction() as s:
        after = (
            await s.execute(select(User.last_seen_at).where(User.user_id == uuid.UUID(uid)))
        ).scalar_one()
    assert after > before


@pytest.mark.parametrize(
    "body",
    [
        {"telegram_user_id": 1},  # нет first_name
        {"telegram_user_id": 1, "first_name": "   "},
        {"telegram_user_id": 0, "first_name": "Тест"},
        {"telegram_user_id": "abc", "first_name": "Тест"},
        {"telegram_user_id": 1, "first_name": "Т" * 65},
        {"telegram_user_id": 1, "first_name": "Тест", "user_id": str(uuid.uuid4())},  # extra=forbid
    ],
)
async def test_telegram_login_validation(env, body) -> None:
    r = await env.client.post("/internal/v1/users/telegram-login", json=body, headers=env.h())
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"


async def test_me_returns_only_own_profile(env) -> None:
    a = await env.new_user(first_name="Альфа")
    b = await env.new_user(first_name="Бета")
    me_a = (await env.call("GET", "/internal/v1/me", a)).json()
    me_b = (await env.call("GET", "/internal/v1/me", b)).json()
    assert me_a["user"]["user_id"] == a and me_a["user"]["display_name"] == "Альфа"
    assert me_b["user"]["user_id"] == b and me_b["user"]["is_new"] is False
    assert set(me_a) == {"user", "security", "consent", "settings"}


async def test_settings_patch_partial_and_validation(env) -> None:
    uid = await env.new_user()
    r = await env.call(
        "PATCH",
        "/internal/v1/me/settings",
        uid,
        {
            "locale": "en",
            "notifications": {
                "quiet_hours": {"start": "23:00", "end": "07:30"},
                "digest_time": "08:15",
                "timezone": "Europe/Istanbul",
            },
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["user"]["locale"] == "en"
    assert r.json()["settings"] == {
        "enabled": False,
        "quiet_hours": {"start": "23:00", "end": "07:30"},
        "digest_time": "08:15",
        "timezone": "Europe/Istanbul",
    }
    # частичное обновление не трогает остальные поля
    r = await env.call("PATCH", "/internal/v1/me/settings", uid, {"notifications": {"enabled": True}})
    assert r.json()["settings"]["enabled"] is True and r.json()["settings"]["digest_time"] == "08:15"
    assert r.json()["user"]["locale"] == "en"
    # явный null выключает тихие часы
    r = await env.call("PATCH", "/internal/v1/me/settings", uid, {"notifications": {"quiet_hours": None}})
    assert (
        r.json()["settings"]["quiet_hours"] is None and r.json()["settings"]["timezone"] == "Europe/Istanbul"
    )
    # пустой патч — без изменений
    assert (await env.call("PATCH", "/internal/v1/me/settings", uid, {})).status_code == 200

    other = await env.new_user()
    assert (await env.call("GET", "/internal/v1/me", other)).json()["settings"]["timezone"] == "Asia/Tashkent"

    for bad in (
        {"locale": "uz"},
        {"notifications": {"timezone": "Mars/Olympus"}},
        {"notifications": {"timezone": "../../etc/passwd"}},
        {"notifications": {"digest_time": "24:00"}},
        {"notifications": {"digest_time": "9:00"}},
        {"notifications": {"quiet_hours": {"start": "23:00", "end": "23:00"}}},
        {"notifications": {"quiet_hours": {"start": "23:00"}}},
        {"notifications": {"push": True}},
        {"theme": "dark"},
    ):
        r = await env.call("PATCH", "/internal/v1/me/settings", uid, bad)
        assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", bad


async def test_disable_enable_status_events(env) -> None:
    uid = await env.new_user()
    assert (await env.consent(uid, ["personalization", "notifications"])).status_code == 200
    r = await env.call("POST", "/internal/v1/me/disable", uid)
    assert r.status_code == 200
    assert r.json()["user"]["status"] == "DISABLED" and r.json()["settings"]["enabled"] is False
    # повтор — без нового события
    assert (await env.call("POST", "/internal/v1/me/disable", uid)).json()["user"]["status"] == "DISABLED"
    # при отключённом TilHero уведомления включить нельзя
    r = await env.call("PATCH", "/internal/v1/me/settings", uid, {"notifications": {"enabled": True}})
    assert r.status_code == 409 and r.json()["code"] == "USER_DISABLED"
    # остальные настройки менять можно
    r = await env.call("PATCH", "/internal/v1/me/settings", uid, {"notifications": {"digest_time": "10:00"}})
    assert r.status_code == 200

    r = await env.call("POST", "/internal/v1/me/enable", uid)
    assert r.json()["user"]["status"] == "ACTIVE"
    assert r.json()["settings"]["enabled"] is True  # согласие включает цель notifications
    await env.call("POST", "/internal/v1/me/enable", uid)

    events = await env.events("user.status.changed.v1", uid)
    assert [(e.payload["previous_status"], e.payload["status"]) for e in events] == [
        ("ACTIVE", "DISABLED"),
        ("DISABLED", "ACTIVE"),
    ]
    assert events[0].payload["reason_code"] == "user_disabled"


async def test_enable_without_notifications_purpose_keeps_notifications_off(env) -> None:
    uid = await env.new_user()
    await env.consent(uid, ["personalization"])
    await env.call("POST", "/internal/v1/me/disable", uid)
    r = await env.call("POST", "/internal/v1/me/enable", uid)
    assert r.json()["settings"]["enabled"] is False


async def test_legal_policy_document(env) -> None:
    ru = await env.call("GET", "/internal/v1/legal/policy?lang=ru", None)
    assert ru.status_code == 200
    body = ru.json()
    assert body["version"] == "1.0" and body["text"].startswith("# Политика обработки данных TilHero")
    assert body["purposes"] == [
        {
            "code": "personalization",
            "required": True,
            "title": "Персонализация",
            "description": body["purposes"][0]["description"],
        },
        {
            "code": "notifications",
            "required": False,
            "title": "Уведомления в Telegram",
            "description": body["purposes"][1]["description"],
        },
    ]
    en = (await env.call("GET", "/internal/v1/legal/policy?lang=en", None)).json()
    assert (
        en["text"].startswith("# TilHero data processing policy")
        and en["purposes"][0]["title"] == "Personalisation"
    )
    assert (await env.call("GET", "/internal/v1/legal/policy?lang=uz", None)).json()["text"] == body["text"]
    assert (await env.call("GET", "/internal/v1/legal/policy?lang=de-DE", None)).json()["text"] == en["text"]
    assert (await env.call("GET", "/internal/v1/legal/policy", None)).json()["text"] == body["text"]
    bad = await env.call("GET", "/internal/v1/legal/policy?lang=<script>", None)
    assert bad.status_code == 422


async def test_health(env) -> None:
    assert (await env.client.get("/health/live")).json() == {"status": "ok"}
    ready = await env.client.get("/health/ready")
    assert ready.status_code == 200
    assert ready.json()["checks"] == {"db": "ok", "redis": "ok", "nats": "ok", "consumers": "ok"}
