"""Сброс кода родителя через бота — с задержкой 24 ч (ревью T-8, INTERNAL_API «Сброс кода родителя через бота»).

Телефон с Telegram может быть у ребёнка: код из бота не даёт права родителя сразу. Новый код ждёт срока
(PIN_RESET_DELAY_HOURS), прежний действует до него, любой верный ввод прежнего кода сброс отменяет, явная отмена —
`POST /me/pin/reset-cancel`. Срок наступил — новый код применяется при следующей проверке кода
(`user.security.changed.v1 {pin_reset}`, `pin_reset_applied` для отзыва сессий в BFF). Время — через app.state.clock.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select

from tilhero_identity.models import BiometricCredential, PinCredential
from tilhero_identity.settings import Settings

CANCELLED = ["pin_set", "biometric_enabled", "pin_reset_requested", "pin_reset_cancelled"]
PIN = "2580"
NEW = "402913"
WRONG = "1357"
T0 = datetime(2026, 11, 18, 17, 30, tzinfo=UTC)  # 22:30 в Ташкенте: срок — на следующий день
DAY = timedelta(hours=24)


async def _row(env, uid: str) -> PinCredential | None:
    async with env.runtime.transaction() as s:
        return (await s.execute(select(PinCredential).where(PinCredential.user_id == uuid.UUID(uid)))).scalar()


async def _has_bio(env, uid: str) -> bool:
    async with env.runtime.transaction() as s:
        q = select(BiometricCredential).where(BiometricCredential.user_id == uuid.UUID(uid))
        return (await s.execute(q)).scalar() is not None


async def _verify(env, uid: str, pin: str) -> httpx.Response:
    return await env.call("POST", "/internal/v1/me/pin/verify", uid, {"pin": pin})


async def _cancel(env, uid: str, pin: str) -> httpx.Response:
    return await env.call("POST", "/internal/v1/me/pin/reset-cancel", uid, {"current_pin": pin})


async def _security(env, uid: str) -> dict:
    r = await env.call("GET", "/internal/v1/me", uid)
    assert r.status_code == 200, r.text
    return r.json()["security"]


async def _schedule(env, uid: str, new_pin: str = NEW, at: datetime = T0) -> dict:
    """Код из бота + новый PIN в момент `at` → SecurityState с ожидающим сбросом."""
    await env.redis.delete(f"pin_reset:cooldown:{uid}")
    r = await env.call("POST", "/internal/v1/me/pin/reset-request", uid)
    assert r.status_code == 200, r.text
    code = env.notifications.codes(uid)[-1]
    env.set_clock(at)
    r = await env.call("POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": code, "new_pin": new_pin})
    assert r.status_code == 200, r.text
    return r.json()


async def _parent(env, *, biometric: bool = False) -> str:
    uid = await env.new_user()
    await env.set_pin(uid, PIN)
    if biometric:
        assert (await env.call("PUT", "/internal/v1/me/biometric", uid)).status_code == 200
    return uid


async def test_reset_waits_24h_old_code_works_new_does_not(env) -> None:
    uid = await _parent(env, biometric=True)
    state = await _schedule(env, uid)
    assert state == {
        "pin_enabled": True, "pin_length": 4, "biometric_enabled": True, "pin_required": True,
        "locked_until": None, "pin_reset_effective_at": (T0 + DAY).isoformat().replace("+00:00", "Z"),
    }
    row = await _row(env, uid)
    assert row is not None and row.reset_pin_hash and row.reset_pin_hash.startswith("$argon2id$")
    assert NEW not in row.reset_pin_hash and row.reset_pin_length == 6
    assert row.reset_requested_at == T0 and row.reset_effective_at == T0 + DAY

    # за секунду до срока новый код не действует (и тратит попытку), сброс ждёт дальше
    env.set_clock(T0 + DAY - timedelta(seconds=1))
    bad = await _verify(env, uid, NEW)
    assert bad.status_code == 401 and bad.json()["code"] == "PIN_INVALID" and bad.json()["details"] == {"remaining": 4}
    assert (await _security(env, uid))["pin_reset_effective_at"] is not None
    assert (await _row(env, uid)).reset_pin_hash is not None
    # смена кода новым кодом как текущим тоже не проходит
    r = await env.call("PUT", "/internal/v1/me/pin", uid, {"pin": "739104", "current_pin": NEW})
    assert r.status_code == 401
    assert await env.security_changes(uid) == ["pin_set", "biometric_enabled", "pin_reset_requested"]

    # прежний код действует до срока — и его верный ввод отменяет сброс (неявная отмена)
    ok = await _verify(env, uid, PIN)
    assert ok.status_code == 200 and ok.json() == {"ok": True, "pin_reset_applied": False}
    row = await _row(env, uid)
    assert row.reset_pin_hash is None and row.reset_effective_at is None and row.pin_length == 4
    assert (await _security(env, uid))["pin_reset_effective_at"] is None
    # отменённый сброс не оживает и после срока
    env.set_clock(T0 + 2 * DAY)
    assert (await _verify(env, uid, NEW)).status_code == 401
    assert (await _verify(env, uid, PIN)).json() == {"ok": True, "pin_reset_applied": False}
    assert await _has_bio(env, uid)
    assert await env.security_changes(uid) == CANCELLED


async def test_reset_applies_at_next_check_after_due(env) -> None:
    uid = await _parent(env, biometric=True)
    await _schedule(env, uid)

    # ровно в срок: состояние показывает новый код действующим (длина 6, срока нет), запись в БД — при проверке
    env.set_clock(T0 + DAY)
    sec = await _security(env, uid)
    assert sec["pin_length"] == 6 and sec["pin_reset_effective_at"] is None and sec["pin_enabled"]
    # прежний код больше не действует; неверная проверка откатывает применение — запись ждёт верной проверки
    old = await _verify(env, uid, PIN)
    assert old.status_code == 401 and old.json()["details"] == {"remaining": 4}
    row = await _row(env, uid)
    assert row.reset_pin_hash is not None and row.pin_length == 4
    assert await env.security_changes(uid) == ["pin_set", "biometric_enabled", "pin_reset_requested"]

    applied = await _verify(env, uid, NEW)
    assert applied.status_code == 200 and applied.json() == {"ok": True, "pin_reset_applied": True}
    row = await _row(env, uid)
    assert row.pin_length == 6 and row.reset_pin_hash is None and row.reset_effective_at is None
    assert row.updated_at == T0 + DAY
    assert not await _has_bio(env, uid)  # учётные данные переустановлены целиком
    changes = await env.security_changes(uid)
    assert changes[:3] == ["pin_set", "biometric_enabled", "pin_reset_requested"]
    assert sorted(changes[3:]) == ["biometric_disabled", "pin_reset"]  # одна транзакция
    # счётчик попыток обнулён верной проверкой; повторная проверка уже ничего не применяет
    assert (await _verify(env, uid, NEW)).json() == {"ok": True, "pin_reset_applied": False}
    assert (await _verify(env, uid, WRONG)).json()["details"] == {"remaining": 4}
    sec = await _security(env, uid)
    assert sec["pin_length"] == 6 and sec["biometric_enabled"] is False and sec["pin_reset_effective_at"] is None


@pytest.mark.parametrize("via", ["set_pin", "deletion"])
async def test_due_reset_applies_on_other_code_checks(env, via: str) -> None:
    uid = await _parent(env)
    await _schedule(env, uid)
    env.set_clock(T0 + DAY + timedelta(minutes=1))
    if via == "set_pin":
        r = await env.call("PUT", "/internal/v1/me/pin", uid, {"pin": "739104", "current_pin": PIN})
        assert r.status_code == 401  # прежний код после срока не принимается
        r = await env.call("PUT", "/internal/v1/me/pin", uid, {"pin": "739104", "current_pin": NEW})
        assert r.status_code == 200 and r.json()["pin_reset_effective_at"] is None
        assert (await _verify(env, uid, "739104")).status_code == 200
        changes = await env.security_changes(uid)
        assert changes[0] == "pin_set"
        assert sorted(changes[1:]) == ["pin_changed", "pin_reset", "pin_reset_requested"]  # одна транзакция
    else:
        r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"pin": PIN})
        assert r.status_code == 401
        r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"pin": NEW})
        assert r.status_code == 202, r.text
        assert "pin_reset" in await env.security_changes(uid)


async def test_explicit_cancel(env) -> None:
    uid = await _parent(env, biometric=True)
    await _schedule(env, uid)
    env.set_clock(T0 + timedelta(hours=3))

    for body in ({}, {"current_pin": "1" * 17}, {"current_pin": PIN, "extra": 1}):
        r = await env.call("POST", "/internal/v1/me/pin/reset-cancel", uid, body)
        assert r.status_code == 422, body
    wrong = await _cancel(env, uid, WRONG)
    assert wrong.status_code == 401 and wrong.json()["code"] == "PIN_INVALID"
    assert wrong.json()["details"] == {"remaining": 4}
    # новым кодом сброс не отменить (и не применить)
    assert (await _cancel(env, uid, NEW)).status_code == 401
    assert (await _row(env, uid)).reset_pin_hash is not None

    ok = await _cancel(env, uid, PIN)
    assert ok.status_code == 200, ok.text
    assert ok.json() == {
        "pin_enabled": True, "pin_length": 4, "biometric_enabled": True, "pin_required": True,
        "locked_until": None, "pin_reset_effective_at": None,
    }
    assert (await _row(env, uid)).reset_pin_hash is None
    # повтор: отменять нечего — состояние без проверки кода (попытка не тратится, ответ от кода не зависит)
    again = await _cancel(env, uid, WRONG)
    assert again.status_code == 200 and again.json() == ok.json()
    assert (await _verify(env, uid, WRONG)).json()["details"] == {"remaining": 4}

    env.set_clock(T0 + 3 * DAY)
    assert (await _verify(env, uid, NEW)).status_code == 401
    assert (await _verify(env, uid, PIN)).json()["pin_reset_applied"] is False
    assert await env.security_changes(uid) == CANCELLED


async def test_cancel_after_due_changes_nothing(env) -> None:
    """Срок наступил — отменять поздно: отмена возвращает состояние (новый код действует), не применяя сброс мимо
    проверки кода и не тратя попытку; применит его следующая проверка."""
    uid = await _parent(env)
    await _schedule(env, uid)
    env.set_clock(T0 + DAY)
    r = await _cancel(env, uid, PIN)
    assert r.status_code == 200 and r.json()["pin_length"] == 6 and r.json()["pin_reset_effective_at"] is None
    assert (await _row(env, uid)).reset_pin_hash is not None
    assert (await _verify(env, uid, NEW)).json()["pin_reset_applied"] is True


async def test_cancel_without_pin_or_for_other_user(env) -> None:
    uid = await env.new_user()
    r = await _cancel(env, uid, PIN)
    assert r.status_code == 409 and r.json()["code"] == "PIN_NOT_SET"

    # изоляция: отмена другим аккаунтом (user_id только из токена) не трогает чужой сброс
    victim = await _parent(env)
    await _schedule(env, victim)
    other = await _parent(env)
    assert (await _cancel(env, other, PIN)).status_code == 200
    assert (await _row(env, victim)).reset_pin_hash is not None
    assert (await _security(env, victim))["pin_reset_effective_at"] is not None


async def test_cancel_attempts_share_the_lockout(env) -> None:
    """Отмена — проверка кода с общим счётчиком: 5 неверных → 423 и pin_locked; сброс при этом не отменяется."""
    uid = await _parent(env)
    await _schedule(env, uid)
    env.set_clock(T0 + timedelta(hours=1))
    for remaining in (4, 3, 2, 1):
        r = await _cancel(env, uid, WRONG)
        assert r.status_code == 401 and r.json()["details"] == {"remaining": remaining}
    locked = await _cancel(env, uid, WRONG)
    assert locked.status_code == 423 and locked.json()["code"] == "PIN_LOCKED"
    assert (await _cancel(env, uid, PIN)).status_code == 423  # даже верный — во время блокировки
    assert (await _verify(env, uid, PIN)).status_code == 423
    assert (await _row(env, uid)).reset_pin_hash is not None
    assert (await env.security_changes(uid))[-1] == "pin_locked"

    # блокировка поверх наступившего срока: новый код тоже ждёт её окончания
    env.set_clock(T0 + DAY)
    assert (await _verify(env, uid, NEW)).status_code == 423
    await env.redis.delete(f"pin:lock:{uid}")
    assert (await _verify(env, uid, NEW)).json() == {"ok": True, "pin_reset_applied": True}


async def test_repeated_reset_replaces_pending_and_restarts_delay(env) -> None:
    uid = await _parent(env)
    await _schedule(env, uid, NEW, at=T0)
    second = await _schedule(env, uid, "739104", at=T0 + timedelta(hours=20))
    assert second["pin_reset_effective_at"] == (T0 + timedelta(hours=44)).isoformat().replace("+00:00", "Z")
    # первый срок прошёл, но первый новый код заменён вторым и срок начался заново
    env.set_clock(T0 + DAY + timedelta(hours=1))
    assert (await _verify(env, uid, NEW)).status_code == 401
    assert (await _verify(env, uid, "739104")).status_code == 401
    env.set_clock(T0 + timedelta(hours=44))
    assert (await _verify(env, uid, "739104")).json() == {"ok": True, "pin_reset_applied": True}
    assert (await _verify(env, uid, PIN)).status_code == 401


async def test_reset_code_attempts_still_limited(env) -> None:
    """Лимиты кода из бота не меняются: 5 попыток на код, затем он сгорает; ожидающий сброс не создаётся."""
    uid = await _parent(env)
    await env.call("POST", "/internal/v1/me/pin/reset-request", uid)
    code = env.notifications.codes(uid)[-1]
    wrong = f"{(int(code) + 3) % 10**6:06d}"
    for _ in range(5):
        r = await env.call("POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": wrong, "new_pin": NEW})
        assert r.status_code == 401
    r = await env.call("POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": code, "new_pin": NEW})
    assert r.status_code == 410
    assert (await _row(env, uid)).reset_pin_hash is None
    again = await env.call("POST", "/internal/v1/me/pin/reset-request", uid)
    assert again.status_code == 429  # не чаще раза в 60 с


async def test_concurrent_checks_apply_once(env) -> None:
    uid = await _parent(env)
    await _schedule(env, uid)
    env.set_clock(T0 + DAY)
    results = await asyncio.gather(*[_verify(env, uid, NEW) for _ in range(3)])
    assert [r.status_code for r in results] == [200, 200, 200]
    assert sorted(r.json()["pin_reset_applied"] for r in results) == [False, False, True]
    assert (await env.security_changes(uid)).count("pin_reset") == 1


async def test_scheduled_notice_without_code_or_pii(env) -> None:
    uid = await env.new_user(first_name="Секретное", last_name="Имя", username="secret_name")
    await env.set_pin(uid)
    await _schedule(env, uid)
    code = env.notifications.codes(uid)[-1]
    [notice] = env.notifications.of(uid, "pin.reset_scheduled")
    assert notice["params"] == {"effective_at": "2026-11-19T17:30:00.000Z"}
    assert set(notice) == {"notification_id", "user_id", "template", "params", "dedup_key"}
    assert notice["dedup_key"] == f"pin_reset_scheduled:{uid}:{uuid.UUID(notice['notification_id']).hex}"
    assert env.notifications.headers[-1]["idempotency-key"] == notice["notification_id"]
    # идентификаторы (UUID и их hex) — случайные шестнадцатеричные строки: в них могут встретиться цифры кода, без
    # этой замены проверка изредка падает ложно
    text = re.sub(r"[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}", "<id>", str(notice))
    for secret in (code, NEW, PIN, "Секретное", "Имя", "secret_name"):
        assert secret not in text
    # в шину ничего о сбросе не уходит (код — только синхронно в notifications)
    await env.flush()
    assert env.bus.of_type("notification.requested.v1") == []


@pytest.mark.parametrize("failure", [422, 503, "network", {"status": "failed", "reason": "blocked"}])
async def test_notice_failure_does_not_block_reset(env, failure) -> None:
    """Сообщение — уведомление, не условие: недоставка не отменяет сброс (родитель видит плашку в Mini App)."""
    uid = await _parent(env)
    await env.call("POST", "/internal/v1/me/pin/reset-request", uid)
    code = env.notifications.codes(uid)[-1]
    if failure == "network":
        env.notifications.responses += [httpx.ConnectError("down"), httpx.ConnectError("down")]
    elif isinstance(failure, int):
        env.notifications.responses += [failure, failure]
    else:
        env.notifications.responses.append({"notification_id": "x", **failure})
    env.set_clock(T0)
    r = await env.call("POST", "/internal/v1/me/pin/reset-confirm", uid, {"code": code, "new_pin": NEW})
    assert r.status_code == 200, r.text
    assert r.json()["pin_reset_effective_at"] is not None
    assert (await _row(env, uid)).reset_pin_hash is not None
    env.notifications.responses.clear()


async def test_delay_from_settings(env, monkeypatch: pytest.MonkeyPatch) -> None:
    assert env.settings.pin_reset_delay_hours == 24
    monkeypatch.setattr(env.settings, "pin_reset_delay_hours", 2.5)
    uid = await _parent(env)
    state = await _schedule(env, uid)
    assert state["pin_reset_effective_at"] == "2026-11-18T20:00:00Z"


def test_delay_setting_bounds(monkeypatch: pytest.MonkeyPatch) -> None:
    base = {"env": "test", "internal_jwt_secret": "s" * 40}
    monkeypatch.setenv("PIN_RESET_DELAY_HOURS", "12")
    assert Settings(**base).pin_reset_delay_hours == 12
    for bad in ("0", "-1", "169"):
        monkeypatch.setenv("PIN_RESET_DELAY_HOURS", bad)
        with pytest.raises(ValueError):
            Settings(**base)
