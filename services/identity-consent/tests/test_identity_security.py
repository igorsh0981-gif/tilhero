"""Безопасность: код родителя (PIN, Argon2id, смена/снятие с текущим кодом), блокировка 5→5 мин, общий счётчик
с биометрией и кодом при удалении, сброс кода из бота, биометрия; события user.security.changed.v1 по схеме."""

from __future__ import annotations

import asyncio
import io
import logging
import uuid

import pytest
from sqlalchemy import select

from tilhero_common.internal_auth import verify_token
from tilhero_common.logging import JsonFormatter
from tilhero_identity.models import BiometricCredential, PinCredential

PIN = "2580"
PIN6 = "402913"
WRONG = "1357"


async def _pin_row(env, uid: str) -> PinCredential | None:
    async with env.runtime.transaction() as s:
        return (
            await s.execute(select(PinCredential).where(PinCredential.user_id == uuid.UUID(uid)))
        ).scalar()


async def _bio_row(env, uid: str) -> BiometricCredential | None:
    async with env.runtime.transaction() as s:
        return (
            await s.execute(select(BiometricCredential).where(BiometricCredential.user_id == uuid.UUID(uid)))
        ).scalar()


async def _verify(env, uid: str, pin: str):
    return await env.call("POST", "/internal/v1/me/pin/verify", uid, {"pin": pin})


# ---------- PIN ----------


async def test_set_change_remove_pin(env) -> None:
    uid = await env.new_user()
    r = await env.call("PUT", "/internal/v1/me/pin", uid, {"pin": PIN})
    assert r.status_code == 200
    assert r.json() == {
        "pin_enabled": True,
        "pin_length": 4,
        "biometric_enabled": False,
        "pin_required": True,
        "locked_until": None,
    }
    row = await _pin_row(env, uid)
    assert row and row.pin_hash.startswith("$argon2id$") and PIN not in row.pin_hash

    # Повторная установка без текущего кода не перезаписывает его.
    again = await env.call("PUT", "/internal/v1/me/pin", uid, {"pin": PIN6})
    assert again.status_code == 409 and again.json()["code"] == "PIN_ALREADY_SET"
    wrong = await env.call("PUT", "/internal/v1/me/pin", uid, {"pin": PIN6, "current_pin": WRONG})
    assert wrong.status_code == 401 and wrong.json()["code"] == "PIN_INVALID"
    assert wrong.json()["details"] == {"remaining": 4}
    changed = await env.call("PUT", "/internal/v1/me/pin", uid, {"pin": PIN6, "current_pin": PIN})
    assert changed.status_code == 200 and changed.json()["pin_length"] == 6
    assert (await _verify(env, uid, PIN6)).json() == {"ok": True}
    assert (await _verify(env, uid, PIN)).status_code == 401
    # успешная проверка обнуляет счётчик
    assert (await _verify(env, uid, PIN6)).status_code == 200
    assert (await _verify(env, uid, WRONG)).json()["details"] == {"remaining": 4}

    no_body = await env.call("DELETE", "/internal/v1/me/pin", uid)
    assert no_body.status_code == 422
    bad = await env.call("DELETE", "/internal/v1/me/pin", uid, {"current_pin": WRONG})
    assert bad.status_code == 401 and bad.json()["details"] == {"remaining": 3}
    removed = await env.call("DELETE", "/internal/v1/me/pin", uid, {"current_pin": PIN6})
    assert removed.status_code == 200
    assert removed.json() == {
        "pin_enabled": False,
        "pin_length": None,
        "biometric_enabled": False,
        "pin_required": False,
        "locked_until": None,
    }
    assert await _pin_row(env, uid) is None
    again_removed = await env.call("DELETE", "/internal/v1/me/pin", uid, {"current_pin": PIN6})
    assert again_removed.status_code == 409 and again_removed.json()["code"] == "PIN_NOT_SET"
    assert (await _verify(env, uid, PIN6)).json()["code"] == "PIN_NOT_SET"

    assert await env.security_changes(uid) == ["pin_set", "pin_changed", "pin_removed"]


@pytest.mark.parametrize("pin", ["0000", "1234", "4321", "123456", "987654", "12345", "12a4", "١٢٣٧", ""])
async def test_pin_format_rejected(env, pin: str) -> None:
    uid = await env.new_user()
    r = await env.call("PUT", "/internal/v1/me/pin", uid, {"pin": pin})
    assert r.status_code == 422 and r.json()["code"] == "PIN_FORMAT"
    assert await _pin_row(env, uid) is None


async def test_pin_input_validation(env) -> None:
    uid = await env.new_user()
    for body in ({"pin": "1" * 17}, {"pin": 2580}, {}, {"pin": PIN, "user_id": str(uuid.uuid4())}):
        r = await env.call("PUT", "/internal/v1/me/pin", uid, body)
        assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", body


async def test_lockout_after_five_wrong_pins(env) -> None:
    uid = await env.new_user()
    other = await env.new_user()
    await env.set_pin(uid)
    await env.set_pin(other)
    for remaining in (4, 3, 2, 1):
        r = await _verify(env, uid, WRONG)
        assert r.status_code == 401 and r.json() == {
            **r.json(),
            "code": "PIN_INVALID",
            "details": {"remaining": remaining},
        }
    locked = await _verify(env, uid, WRONG)
    assert locked.status_code == 423 and locked.json()["code"] == "PIN_LOCKED"
    assert 290 <= locked.json()["details"]["retry_after"] <= 300
    # во время блокировки не принимается даже верный PIN
    still = await _verify(env, uid, PIN)
    assert still.status_code == 423
    me = (await env.call("GET", "/internal/v1/me", uid)).json()
    assert me["security"]["locked_until"] is not None
    # блокировка одного пользователя не задевает другого
    assert (await _verify(env, other, PIN)).status_code == 200
    assert await env.security_changes(uid) == ["pin_set", "pin_locked"]
    # смена PIN при блокировке тоже недоступна
    r = await env.call("PUT", "/internal/v1/me/pin", uid, {"pin": PIN6, "current_pin": PIN})
    assert r.status_code == 423

    # истечение блокировки (имитация 5 минут) → полный набор попыток
    await env.redis.delete(f"pin:lock:{uid}")
    assert (await _verify(env, uid, PIN)).status_code == 200
    assert (await _verify(env, uid, WRONG)).json()["details"] == {"remaining": 4}


async def test_shared_attempt_counter_pin_biometric_deletion(env) -> None:
    uid = await env.new_user()
    await env.set_pin(uid)
    token = (await env.call("PUT", "/internal/v1/me/biometric", uid)).json()["biometric_token"]
    assert (await _verify(env, uid, WRONG)).json()["details"] == {"remaining": 4}
    bad_bio = await env.call("POST", "/internal/v1/me/biometric/verify", uid, {"biometric_token": "nope"})
    assert bad_bio.status_code == 401 and bad_bio.json()["code"] == "BIOMETRIC_INVALID"
    assert bad_bio.json()["details"] == {"remaining": 3}
    r = await env.call("PUT", "/internal/v1/me/pin", uid, {"pin": PIN6, "current_pin": WRONG})
    assert r.json()["details"] == {"remaining": 2}
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"pin": WRONG})
    assert r.status_code == 401 and r.json()["details"] == {"remaining": 1}
    r = await env.call("POST", "/internal/v1/me/biometric/verify", uid, {"biometric_token": token + "x"})
    assert r.status_code == 423 and r.json()["code"] == "PIN_LOCKED"
    # биометрия тоже заблокирована, удаление профиля — тоже
    r = await env.call("POST", "/internal/v1/me/biometric/verify", uid, {"biometric_token": token})
    assert r.status_code == 423
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"pin": PIN})
    assert r.status_code == 423
    me = (await env.call("GET", "/internal/v1/me", uid)).json()
    assert me["user"]["status"] == "ACTIVE"
    assert (await env.security_changes(uid))[-1] == "pin_locked"

    await env.redis.delete(f"pin:lock:{uid}")
    ok = await env.call("POST", "/internal/v1/me/biometric/verify", uid, {"biometric_token": token})
    assert ok.status_code == 200 and ok.json() == {"ok": True}


# ---------- биометрия ----------


async def test_biometric_lifecycle(env) -> None:
    uid = await env.new_user()
    r = await env.call("PUT", "/internal/v1/me/biometric", uid)
    assert r.status_code == 409 and r.json()["code"] == "PIN_REQUIRED"
    await env.set_pin(uid)
    r = await env.call("PUT", "/internal/v1/me/biometric", uid)
    assert r.status_code == 200
    token = r.json()["biometric_token"]
    assert len(token) == 43 and r.json()["security"]["biometric_enabled"] is True
    row = await _bio_row(env, uid)
    assert row and row.token_hash != token and token not in row.token_hash and len(row.token_hash) == 64

    ok = await env.call("POST", "/internal/v1/me/biometric/verify", uid, {"biometric_token": token})
    assert ok.json() == {"ok": True}
    # повторное включение выпускает новый токен, старый перестаёт действовать
    token2 = (await env.call("PUT", "/internal/v1/me/biometric", uid)).json()["biometric_token"]
    assert token2 != token
    old = await env.call("POST", "/internal/v1/me/biometric/verify", uid, {"biometric_token": token})
    assert old.status_code == 401
    assert (
        await env.call("POST", "/internal/v1/me/biometric/verify", uid, {"biometric_token": token2})
    ).status_code == 200
    # чужой токен не подходит
    other = await env.new_user()
    await env.set_pin(other)
    other_token = (await env.call("PUT", "/internal/v1/me/biometric", other)).json()["biometric_token"]
    assert (
        await env.call("POST", "/internal/v1/me/biometric/verify", uid, {"biometric_token": other_token})
    ).status_code == 401

    off = await env.call("DELETE", "/internal/v1/me/biometric", uid)
    assert off.status_code == 200 and off.json()["biometric_enabled"] is False and off.json()["pin_enabled"]
    assert (await env.call("DELETE", "/internal/v1/me/biometric", uid)).status_code == 200  # идемпотентно
    r = await env.call("POST", "/internal/v1/me/biometric/verify", uid, {"biometric_token": token2})
    assert r.status_code == 409 and r.json()["code"] == "BIOMETRIC_NOT_ENABLED"
    for body in ({}, {"biometric_token": ""}, {"biometric_token": "x" * 129}):
        assert (await env.call("POST", "/internal/v1/me/biometric/verify", uid, body)).status_code == 422

    assert await env.security_changes(uid) == [
        "pin_set",
        "biometric_enabled",
        "biometric_enabled",
        "biometric_disabled",
    ]


async def test_removing_pin_removes_biometric(env) -> None:
    uid = await env.new_user()
    await env.set_pin(uid)
    await env.call("PUT", "/internal/v1/me/biometric", uid)
    r = await env.call("DELETE", "/internal/v1/me/pin", uid, {"current_pin": PIN})
    assert r.json()["biometric_enabled"] is False and await _bio_row(env, uid) is None
    changes = await env.security_changes(uid)
    assert changes[:2] == ["pin_set", "biometric_enabled"]
    # оба события одной транзакции: created_at в outbox совпадает, порядок публикации между ними не гарантирован
    assert sorted(changes[2:]) == ["biometric_disabled", "pin_removed"]


# ---------- сброс PIN кодом из бота ----------


async def _request_code(env, uid: str) -> str:
    r = await env.call("POST", "/internal/v1/me/pin/reset-request", uid)
    assert r.status_code == 200, r.text
    assert r.json() == {"expires_in": 600}
    return env.notifications.codes(uid)[-1]


async def test_pin_reset_flow(env) -> None:
    uid = await env.new_user()
    r = await env.call("POST", "/internal/v1/me/pin/reset-request", uid)
    assert r.status_code == 409 and r.json()["code"] == "PIN_NOT_SET"
    await env.set_pin(uid)
    await env.call("PUT", "/internal/v1/me/biometric", uid)

    code = await _request_code(env, uid)
    # Код уходит синхронно в notifications (iss=identity-consent), в событиях и outbox его нет
    p = env.notifications.calls[-1]
    assert p["template"] == "pin.reset_code" and p["params"] == {"code": code, "ttl_minutes": 10}
    assert set(p) == {"notification_id", "user_id", "template", "params", "dedup_key"}
    assert len(code) == 6 and code.isdigit()
    assert p["dedup_key"] == f"pin_reset:{uid}:{uuid.UUID(p['notification_id']).hex}"
    assert env.notifications.headers[-1]["idempotency-key"] == p["notification_id"]
    principal = verify_token(
        env.notifications.headers[-1]["x-internal-token"],
        env.settings.internal_jwt_secret.get_secret_value(),
        audience="notifications",
    )
    assert principal.issuer == "identity-consent"
    await env.flush()
    assert code not in await env.outbox_dump()
    assert env.bus.of_type("notification.requested.v1") == []

    # в Redis только HMAC, кода в открытом виде нет
    stored = await env.redis.hgetall(f"pin_reset:code:{uid}")
    assert set(stored) == {"h", "a"} and len(stored["h"]) == 64 and code not in stored["h"]
    assert 590 <= await env.redis.ttl(f"pin_reset:code:{uid}") <= 600

    # ошибка формата нового PIN не тратит попытку
    trivial = await env.call(
        "POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": code, "new_pin": "1111"}
    )
    assert trivial.status_code == 422 and trivial.json()["code"] == "PIN_FORMAT"
    wrong_code = f"{(int(code) + 1) % 10**6:06d}"
    bad = await env.call(
        "POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": wrong_code, "new_pin": PIN6}
    )
    assert bad.status_code == 401 and bad.json()["code"] == "RESET_CODE_INVALID"
    assert bad.json()["details"] == {"remaining": 4}

    ok = await env.call("POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": code, "new_pin": PIN6})
    assert ok.status_code == 200, ok.text
    assert (
        ok.json()["pin_enabled"] and ok.json()["pin_length"] == 6 and ok.json()["biometric_enabled"] is False
    )
    assert (await _verify(env, uid, PIN6)).status_code == 200
    assert (await _verify(env, uid, PIN)).status_code == 401
    # код одноразовый
    reuse = await env.call("POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": code, "new_pin": PIN})
    assert reuse.status_code == 410 and reuse.json()["code"] == "RESET_CODE_EXPIRED"
    # одна транзакция — порядок публикации между событиями не гарантирован (одинаковый created_at в outbox)
    assert sorted((await env.security_changes(uid))[-2:]) == ["biometric_disabled", "pin_reset"]


async def test_pin_reset_code_attempts_and_expiry(env) -> None:
    uid = await env.new_user()
    await env.set_pin(uid)
    code = await _request_code(env, uid)
    wrong = f"{(int(code) + 7) % 10**6:06d}"
    for remaining in (4, 3, 2, 1, 0):
        r = await env.call("POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": wrong, "new_pin": PIN6})
        assert r.status_code == 401 and r.json()["details"] == {"remaining": remaining}
    # после 5 неверных код сгорает — даже верный больше не принимается
    r = await env.call("POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": code, "new_pin": PIN6})
    assert r.status_code == 410

    await env.redis.delete(f"pin_reset:cooldown:{uid}")
    code2 = await _request_code(env, uid)
    await env.redis.delete(f"pin_reset:code:{uid}")  # TTL истёк
    r = await env.call("POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": code2, "new_pin": PIN6})
    assert r.status_code == 410 and r.json()["code"] == "RESET_CODE_EXPIRED"
    for body in ({"code": "12345", "new_pin": PIN6}, {"code": "abcdef", "new_pin": PIN6}, {"new_pin": PIN6}):
        assert (await env.call("POST", "/internal/v1/me/pin/reset-confirm", uid, body)).status_code == 422


async def test_new_code_replaces_previous(env) -> None:
    uid = await env.new_user()
    await env.set_pin(uid)
    first = await _request_code(env, uid)
    await env.redis.delete(f"pin_reset:cooldown:{uid}")
    second = await _request_code(env, uid)
    if first != second:
        r = await env.call("POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": first, "new_pin": PIN6})
        assert r.status_code == 401
    r = await env.call("POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": second, "new_pin": PIN6})
    assert r.status_code == 200


async def test_pin_reset_rate_limits(env) -> None:
    uid = await env.new_user()
    await env.set_pin(uid)
    await _request_code(env, uid)
    too_soon = await env.call("POST", "/internal/v1/me/pin/reset-request", uid)
    assert too_soon.status_code == 429 and too_soon.json()["code"] == "PIN_RESET_TOO_OFTEN"
    assert 1 <= too_soon.json()["details"]["retry_after"] <= 60
    assert too_soon.headers["retry-after"] == str(too_soon.json()["details"]["retry_after"])
    for _ in range(4):  # всего 5 в сутки
        await env.redis.delete(f"pin_reset:cooldown:{uid}")
        await _request_code(env, uid)
    await env.redis.delete(f"pin_reset:cooldown:{uid}")
    daily = await env.call("POST", "/internal/v1/me/pin/reset-request", uid)
    assert daily.status_code == 429 and daily.json()["details"]["retry_after"] > 60
    assert len(env.notifications.codes(uid)) == 5
    # лимиты per-user
    other = await env.new_user()
    await env.set_pin(other)
    await _request_code(env, other)


async def test_pin_reset_unlocks_lockout(env) -> None:
    uid = await env.new_user()
    await env.set_pin(uid)
    for _ in range(5):
        await _verify(env, uid, WRONG)
    assert (await _verify(env, uid, PIN)).status_code == 423
    code = await _request_code(env, uid)
    r = await env.call("POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": code, "new_pin": PIN6})
    assert r.status_code == 200 and r.json()["locked_until"] is None
    assert (await _verify(env, uid, PIN6)).status_code == 200
    assert (await _verify(env, uid, WRONG)).json()["details"] == {"remaining": 4}


async def test_pin_reset_requires_reachable_bot(env) -> None:
    tg = 5_550_001
    uid = await env.new_user(telegram_user_id=tg)
    await env.set_pin(uid)
    r = await env.call(
        "POST",
        f"/internal/v1/telegram-users/{tg}/bot-status",
        None,
        {"blocked": True},
        issuer="telegram-bot-gateway",
    )
    assert r.status_code == 204
    r = await env.call("POST", "/internal/v1/me/pin/reset-request", uid)
    assert r.status_code == 409 and r.json()["code"] == "BOT_BLOCKED"
    assert await env.redis.exists(f"pin_reset:cooldown:{uid}") == 0  # попытка не израсходована


async def test_secrets_never_leak_to_logs_responses_or_events(env) -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter("identity-consent"))
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        uid = await env.new_user()
        secret_pin, secret_pin2 = "731954", "864209"
        r = await env.call("PUT", "/internal/v1/me/pin", uid, {"pin": secret_pin})
        assert secret_pin not in r.text
        await _verify(env, uid, "999991")
        token = (await env.call("PUT", "/internal/v1/me/biometric", uid)).json()["biometric_token"]
        await env.call("POST", "/internal/v1/me/biometric/verify", uid, {"biometric_token": token})
        code = await _request_code(env, uid)
        r = await env.call(
            "POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": code, "new_pin": secret_pin2}
        )
        assert code not in r.text and secret_pin2 not in r.text
        await env.flush()
    finally:
        root.removeHandler(handler)
    logs = stream.getvalue()
    assert logs  # access-логи действительно писались
    for secret in (secret_pin, secret_pin2, token, f'"{code}"'):
        assert secret not in logs, secret
    outbox = await env.outbox_dump()
    for secret in (secret_pin, secret_pin2, token):
        assert secret not in outbox
    # код не попадает ни в одно событие и ни в outbox — только в синхронный вызов notifications
    assert [e.event_type for e in env.bus.published if code in e.model_dump_json()] == []
    assert code not in outbox


async def test_concurrent_wrong_pins_cannot_exceed_attempt_limit(env) -> None:
    uid = await env.new_user()
    await env.set_pin(uid)
    results = await asyncio.gather(*[_verify(env, uid, f"{1357 + i * 2:04d}") for i in range(10)])
    statuses = sorted(r.status_code for r in results)
    assert statuses == [401] * 4 + [423] * 6
    assert sorted(r.json()["details"]["remaining"] for r in results if r.status_code == 401) == [1, 2, 3, 4]
    assert (await env.security_changes(uid)).count("pin_locked") == 1


async def test_pin_reset_when_notifications_unavailable_does_not_consume_limit(env) -> None:
    """notifications недоступен → 503 UPSTREAM_UNAVAILABLE, код не действует, лимит не расходуется."""
    uid = await env.new_user()
    await env.set_pin(uid)
    import httpx

    env.notifications.responses += [503, 503, httpx.ConnectError("down"), httpx.ConnectError("down")]
    for _ in range(2):  # 503 (с одним повтором клиента) и сетевой сбой
        r = await env.call("POST", "/internal/v1/me/pin/reset-request", uid)
        assert r.status_code == 503 and r.json()["code"] == "UPSTREAM_UNAVAILABLE", r.text
    assert await env.redis.exists(f"pin_reset:code:{uid}") == 0
    assert await env.redis.exists(f"pin_reset:cooldown:{uid}") == 0
    assert int(await env.redis.get(f"pin_reset:daily:{uid}") or 0) == 0
    undelivered = env.notifications.codes(uid)[-1]
    # сразу после сбоя запрос проходит (нет «отправлено недавно»), прежний код не действует
    code = await _request_code(env, uid)
    if undelivered != code:
        stale = await env.call(
            "POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": undelivered, "new_pin": PIN6}
        )
        assert stale.status_code == 401
    assert int(await env.redis.get(f"pin_reset:daily:{uid}")) == 1
    # notifications ответил «не доставлено»: бот заблокирован → 409, иное → 503; лимит тоже не тратится
    await env.redis.delete(f"pin_reset:cooldown:{uid}")
    env.notifications.responses.append({"notification_id": "x", "status": "failed", "reason": "blocked"})
    blocked = await env.call("POST", "/internal/v1/me/pin/reset-request", uid)
    assert blocked.status_code == 409 and blocked.json()["code"] == "BOT_BLOCKED"
    env.notifications.responses.append({"notification_id": "x", "status": "skipped", "reason": "user_not_found"})
    skipped = await env.call("POST", "/internal/v1/me/pin/reset-request", uid)
    assert skipped.status_code == 503
    assert int(await env.redis.get(f"pin_reset:daily:{uid}")) == 1
    # «поставлено в очередь с повтором» — код считается отправленным
    env.notifications.responses.append({"notification_id": "x", "status": "queued", "reason": "telegram_unavailable"})
    assert (await env.call("POST", "/internal/v1/me/pin/reset-request", uid)).status_code == 200


async def test_lockouts_do_not_need_second_connection_under_row_lock() -> None:
    """Событие pin_locked пишется после отката основной транзакции, а не во втором соединении,
    пока первое держит FOR UPDATE: параллельные блокировки не исчерпывают пул (pool 1 + overflow 1)."""
    import random

    import httpx
    from conftest import SERVICE_DIR, make_settings

    from tilhero_common.app import Runtime
    from tilhero_common.messaging import InMemoryBus
    from tilhero_common.testing import create_schema, drop_schema, internal_headers, migrate, unique_schema
    from tilhero_identity.main import build_app

    schema = unique_schema("identity_pool")
    await create_schema(schema)
    settings = make_settings(schema, db_pool_size=1, pin_max_attempts=1)
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    app = build_app(settings, runtime)
    uids: list[str] = []
    try:
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://id") as c:
                for _ in range(3):
                    r = await c.post(
                        "/internal/v1/users/telegram-login",
                        json={"telegram_user_id": random.randint(10**8, 10**10), "first_name": "Тест"},
                        headers=internal_headers(settings),
                    )
                    uids.append(r.json()["user"]["user_id"])
                    h = internal_headers(settings, subject=uids[-1])
                    await c.put("/internal/v1/me/pin", json={"pin": PIN}, headers=h)

                async def wrong(uid: str) -> int:
                    r = await c.post("/internal/v1/me/pin/verify", json={"pin": WRONG},
                                     headers=internal_headers(settings, subject=uid))
                    return r.status_code

                statuses = await asyncio.wait_for(asyncio.gather(*(wrong(u) for u in uids)), timeout=15)
            assert statuses == [423, 423, 423]
            assert runtime.relay is not None
            await runtime.relay.drain()
            locked = [e.payload["user_id"] for e in bus.of_type("user.security.changed.v1")
                      if e.payload["change"] == "pin_locked"]
            assert sorted(locked) == sorted(uids)
            for uid in uids:
                await runtime.redis.delete(f"pin:fail:{uid}", f"pin:lock:{uid}")
    finally:
        await drop_schema(schema)
