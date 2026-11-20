"""Профиль: telegram-login, /me, настройки уведомлений, отключение/включение, политика; авторизация и изоляция."""

from __future__ import annotations

import asyncio
import random
import uuid

import pytest
from conftest import REQUIRED

from tilhero_common.testing import internal_headers
from tilhero_identity.settings import Settings

ANY_ID = str(uuid.uuid4())
TOKEN = "A" * 43
# Все эндпоинты telegram-bff, которым нужен аккаунт из токена: (метод, путь, тело).
ME_ENDPOINTS = [
    ("GET", "/internal/v1/me", None),
    ("PATCH", "/internal/v1/me/settings", {"locale": "uz"}),
    ("PUT", "/internal/v1/me/age", {"age_band": "18+"}),
    ("GET", "/internal/v1/me/learners", None),
    ("POST", "/internal/v1/me/learners", {"display_name": "Мадина", "age_band": "6-9"}),
    ("GET", f"/internal/v1/me/learners/{ANY_ID}", None),
    ("PATCH", f"/internal/v1/me/learners/{ANY_ID}", {"display_name": "Мадина"}),
    ("POST", "/internal/v1/me/guardian-consent-requests", None),
    ("POST", f"/internal/v1/guardian-consents/{TOKEN}/accept", None),
    ("POST", f"/internal/v1/guardian-consents/{TOKEN}/decline", None),
    ("PUT", "/internal/v1/me/pin", {"pin": "2580"}),
    ("DELETE", "/internal/v1/me/pin", {"current_pin": "2580"}),
    ("POST", "/internal/v1/me/pin/verify", {"pin": "2580"}),
    ("POST", "/internal/v1/me/pin/reset-request", None),
    ("POST", "/internal/v1/me/pin/reset-confirm", {"code": "123456", "new_pin": "2580"}),
    ("POST", "/internal/v1/me/pin/reset-cancel", {"current_pin": "2580"}),
    ("PUT", "/internal/v1/me/biometric", None),
    ("DELETE", "/internal/v1/me/biometric", None),
    ("POST", "/internal/v1/me/biometric/verify", {"biometric_token": "x" * 43}),
    ("POST", "/internal/v1/me/consent", {"policy_version": "1.1", "purposes": REQUIRED}),
    ("DELETE", "/internal/v1/me/consent", None),
    ("POST", "/internal/v1/me/disable", None),
    ("POST", "/internal/v1/me/enable", None),
    ("POST", "/internal/v1/me/deletion-request", {"confirm_word": "УДАЛИТЬ"}),
]
LOGIN = ("POST", "/internal/v1/users/telegram-login", {"telegram_user_id": 77, "first_name": "Тест"})
POLICY = ("GET", "/internal/v1/legal/policy?lang=ru", None)
PREVIEW = ("GET", f"/internal/v1/guardian-consents/{TOKEN}", None)
ALL_BFF = [*ME_ENDPOINTS, LOGIN, POLICY, PREVIEW]
DEFAULT_SETTINGS = {
    "enabled": False,
    "categories": {"reminders": False, "missed": False, "social": False, "support": True, "product": False},
    "quiet_hours": {"start": "22:00", "end": "08:00"},
    "timezone": "Asia/Tashkent",
}


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
    for caller in ("notifications", "telegram-bot-gateway", "social", "admin-bff", "learning-plan"):
        r = await env.call(method, path, uid, body, issuer=caller)
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", (caller, r.text)


@pytest.mark.parametrize(("method", "path", "body"), ME_ENDPOINTS)
async def test_me_endpoints_take_user_only_from_token(env, method, path, body) -> None:
    no_sub = await env.call(method, path, None, body)
    assert no_sub.status_code == 401 and no_sub.json()["code"] == "USER_CONTEXT_REQUIRED"
    bad_sub = await env.call(method, path, "not-a-uuid", body)
    assert bad_sub.status_code == 401 and bad_sub.json()["code"] == "USER_CONTEXT_INVALID"
    # Чужой/несуществующий пользователь → 404, а не 403 (не раскрываем существование).
    expected = "GUARDIAN_CONSENT_NOT_FOUND" if "/guardian-consents/" in path else "USER_NOT_FOUND"
    unknown = await env.call(method, path, str(uuid.uuid4()), body)
    assert unknown.status_code == 404 and unknown.json()["code"] == expected, unknown.text


@pytest.mark.parametrize(("method", "path", "body"), [e for e in ME_ENDPOINTS if "/guardian-consents/" not in e[1]])
async def test_child_profile_is_not_an_account_subject(env, method, path, body) -> None:
    """Детский профиль 6–13 сам ничего не вызывает: sub = ребёнок → 404 как у несуществующего аккаунта."""
    guardian = await env.adult()
    child = await env.child(guardian)
    r = await env.call(method, path, child["learner_id"], body)
    assert r.status_code == 404 and r.json()["code"] == "USER_NOT_FOUND", r.text


async def test_telegram_login_creates_profile_once(env) -> None:
    tg = random.randint(10**8, 10**10)
    first = await env.login(
        tg, username="@demo_user", first_name="Тест", last_name="Маска", language_code="uz"
    )
    user = first["user"]
    assert user == {
        "user_id": user["user_id"], "display_name": "Тест Маска", "username": "demo_user", "locale": "uz",
        "status": "ACTIVE", "is_new": True, "age_band": None, "guardian_consent": "not_required",
    }
    assert first["security"] == {
        "pin_enabled": False,
        "pin_length": None,
        "biometric_enabled": False,
        "pin_required": False,
        "locked_until": None,
        "pin_reset_effective_at": None,
    }
    assert first["consent"] == {
        "accepted": False,
        "policy_version": None,
        "current_policy_version": "1.1",
        "accepted_at": None,
        "evidence_hash": None,
        "purposes": [],
    }
    assert first["settings"] == DEFAULT_SETTINGS
    assert first["learners"] == [{
        "learner_id": user["user_id"], "kind": "self", "display_name": "Тест Маска", "age_band": None,
        "is_active": True, "onboarding_completed": False, "voice_consent": False,
    }]
    assert "telegram_user_id" not in first["user"]  # Telegram ID наружу не отдаём

    again = await env.login(tg, username="demo_user2", first_name="Тест2", language_code="ru")
    assert again["user"]["user_id"] == user["user_id"] and again["user"]["is_new"] is False
    # снимок обновлён, а язык, выбранный при регистрации, — нет (его меняет пользователь в настройках)
    assert again["user"]["username"] == "demo_user2" and again["user"]["display_name"] == "Тест2"
    assert again["user"]["locale"] == "uz"

    [created] = await env.events("user.profile.created.v1")
    assert created.producer == "identity-consent"
    assert created.payload == {"user_id": user["user_id"], "kind": "account", "locale": "uz", "age_band": None,
                               "guardian_user_id": None, "created_at": created.payload["created_at"]}

    for code, locale in (("en-GB", "ru"), (None, "ru"), ("uz-Latn", "uz"), ("ru", "ru")):
        assert (await env.login(language_code=code))["user"]["locale"] == locale


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
    tg = random.randint(10**8, 10**10)
    uid = await env.new_user(telegram_user_id=tg)
    before = (await env.user_row(uid)).last_seen_at
    await asyncio.sleep(0.01)
    await env.login(tg)
    assert (await env.user_row(uid)).last_seen_at > before


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
    assert set(me_a) == {"user", "security", "consent", "settings", "learners"}
    assert [x["learner_id"] for x in me_a["learners"]] == [a]


async def test_settings_patch_categories_quiet_hours_and_events(env) -> None:
    uid = await env.new_user()
    r = await env.call(
        "PATCH",
        "/internal/v1/me/settings",
        uid,
        {
            "locale": "uz",
            "notifications": {
                "quiet_hours": {"start": "23:00", "end": "07:30"},
                "timezone": "Europe/Istanbul",
                "categories": {"reminders": True, "missed": True},
            },
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["user"]["locale"] == "uz"
    assert r.json()["settings"] == {
        "enabled": False,
        "categories": {"reminders": True, "missed": True, "social": False, "support": True, "product": False},
        "quiet_hours": {"start": "23:00", "end": "07:30"},
        "timezone": "Europe/Istanbul",
    }
    # частичное обновление не трогает остальные поля; null в категориях — без изменений
    r = await env.call("PATCH", "/internal/v1/me/settings", uid,
                       {"notifications": {"enabled": True, "categories": {"missed": False, "social": None}}})
    s = r.json()["settings"]
    assert s["enabled"] is True and s["timezone"] == "Europe/Istanbul"
    assert s["categories"] == {"reminders": True, "missed": False, "social": False, "support": True,
                               "product": False}
    assert r.json()["user"]["locale"] == "uz"
    # явный null выключает тихие часы
    r = await env.call("PATCH", "/internal/v1/me/settings", uid, {"notifications": {"quiet_hours": None}})
    assert r.json()["settings"]["quiet_hours"] is None
    # пустой патч и повтор того же значения — без событий
    assert (await env.call("PATCH", "/internal/v1/me/settings", uid, {})).status_code == 200
    await env.call("PATCH", "/internal/v1/me/settings", uid, {"notifications": {"timezone": "Europe/Istanbul"}})

    events = await env.events("user.notification_settings.changed.v1", uid)
    assert [(e.payload["enabled"], e.payload["categories"]) for e in events] == [
        (False, ["reminders", "missed", "support"]),
        # enabled — итоговая доставка: согласия нет, но выключатель включён пользователем
        (True, ["reminders", "support"]),
        (True, ["reminders", "support"]),
    ]
    [profile] = await env.events("user.profile.updated.v1", uid)
    assert profile.payload == {"user_id": uid, "changed_fields": ["locale"], "age_band": None, "is_minor": False,
                               "locale": "uz", "guardian_consent": "not_required"}

    other = await env.new_user()
    assert (await env.call("GET", "/internal/v1/me", other)).json()["settings"] == DEFAULT_SETTINGS


@pytest.mark.parametrize(("body", "code"), [
    ({"notifications": {"quiet_hours": {"start": "23:00", "end": "23:00"}}}, "QUIET_HOURS_INVALID"),
    ({"notifications": {"quiet_hours": {"start": "24:00", "end": "08:00"}}}, "QUIET_HOURS_INVALID"),
    ({"notifications": {"quiet_hours": {"start": "22:00", "end": "8:00"}}}, "QUIET_HOURS_INVALID"),
    ({"notifications": {"quiet_hours": {"start": "ab:cd", "end": "08:00"}}}, "QUIET_HOURS_INVALID"),
    ({"notifications": {"quiet_hours": {"start": "23:00"}}}, "VALIDATION_ERROR"),
    ({"notifications": {"quiet_hours": {"start": "23:00:00", "end": "08:00"}}}, "VALIDATION_ERROR"),
    ({"locale": "en"}, "VALIDATION_ERROR"),
    ({"display_name": "Новое имя"}, "VALIDATION_ERROR"),  # имя аккаунта — из Telegram
    ({"notifications": {"timezone": "Mars/Olympus"}}, "VALIDATION_ERROR"),
    ({"notifications": {"timezone": "../../etc/passwd"}}, "VALIDATION_ERROR"),
    ({"notifications": {"digest_time": "09:00"}}, "VALIDATION_ERROR"),  # поле aievent удалено
    ({"notifications": {"categories": {"ads": True}}}, "VALIDATION_ERROR"),
    ({"notifications": {"categories": {"reminders": "yes"}}}, "VALIDATION_ERROR"),
    ({"theme": "dark"}, "VALIDATION_ERROR"),
])
async def test_settings_patch_validation(env, body, code) -> None:
    uid = await env.new_user()
    r = await env.call("PATCH", "/internal/v1/me/settings", uid, body)
    assert r.status_code == 422 and r.json()["code"] == code, r.text
    me = (await env.call("GET", "/internal/v1/me", uid)).json()
    assert me["settings"] == DEFAULT_SETTINGS and me["user"]["locale"] == "ru"


async def test_disable_enable_status_events(env) -> None:
    uid = await env.new_user()
    assert (await env.consent(uid)).status_code == 200
    r = await env.call("POST", "/internal/v1/me/disable", uid)
    assert r.status_code == 200
    assert r.json()["user"]["status"] == "DISABLED" and r.json()["settings"]["enabled"] is False
    # повтор — без нового события
    assert (await env.call("POST", "/internal/v1/me/disable", uid)).json()["user"]["status"] == "DISABLED"
    # при отключённом TilHero уведомления включить нельзя
    r = await env.call("PATCH", "/internal/v1/me/settings", uid, {"notifications": {"enabled": True}})
    assert r.status_code == 409 and r.json()["code"] == "USER_DISABLED"
    # остальные настройки менять можно
    r = await env.call("PATCH", "/internal/v1/me/settings", uid, {"notifications": {"timezone": "Asia/Samarkand"}})
    assert r.status_code == 200

    r = await env.call("POST", "/internal/v1/me/enable", uid)
    assert r.json()["user"]["status"] == "ACTIVE"
    assert r.json()["settings"]["enabled"] is True  # действующее согласие включает уведомления
    await env.call("POST", "/internal/v1/me/enable", uid)

    events = await env.events("user.status.changed.v1", uid)
    assert [(e.payload["previous_status"], e.payload["status"]) for e in events] == [
        ("ACTIVE", "DISABLED"),
        ("DISABLED", "ACTIVE"),
    ]
    assert events[0].payload["reason_code"] == "user_disabled"


async def test_enable_without_consent_keeps_notifications_off(env) -> None:
    uid = await env.new_user()
    await env.call("POST", "/internal/v1/me/disable", uid)
    r = await env.call("POST", "/internal/v1/me/enable", uid)
    assert r.json()["settings"]["enabled"] is False


async def test_legal_policy_document(env) -> None:
    ru = await env.call("GET", "/internal/v1/legal/policy?lang=ru", None)
    assert ru.status_code == 200
    body = ru.json()
    assert body["version"] == "1.1" and body["text"].startswith("# Политика обработки данных TilHero")
    assert "черновик" in body["text"]
    assert [(p["code"], p["required"]) for p in body["purposes"]] == [
        ("terms", True), ("privacy", True), ("learning", True),
        ("voice_recording", False), ("social", False), ("product_news", False),
    ]
    assert body["purposes"][0]["title"] == "Условия использования"
    assert all(p["title"] and p["description"] for p in body["purposes"])
    uz = (await env.call("GET", "/internal/v1/legal/policy?lang=uz", None)).json()
    assert uz["text"].startswith("# TilHero maʼlumotlarini") and "qoralama" in uz["text"]
    assert uz["purposes"][0]["title"] == "Foydalanish shartlari" and uz["version"] == "1.1"
    assert (await env.call("GET", "/internal/v1/legal/policy?lang=uz-Latn", None)).json()["text"] == uz["text"]
    assert (await env.call("GET", "/internal/v1/legal/policy?lang=en", None)).json()["text"] == body["text"]
    assert (await env.call("GET", "/internal/v1/legal/policy", None)).json()["text"] == body["text"]
    bad = await env.call("GET", "/internal/v1/legal/policy?lang=<script>", None)
    assert bad.status_code == 422


async def test_health(env) -> None:
    assert (await env.client.get("/health/live")).json() == {"status": "ok"}
    ready = await env.client.get("/health/ready")
    assert ready.status_code == 200
    assert ready.json()["checks"] == {"db": "ok", "redis": "ok", "nats": "ok", "consumers": "ok"}
