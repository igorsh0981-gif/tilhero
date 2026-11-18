"""Доставка: код сброса PIN (transactional), повторы и backoff, постоянные ошибки, недоступность identity-consent,
кэш адресации и его сброс, параллельные обработчики, POST /internal/v1/notifications:dispatch (n8n)."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta

import httpx
from notif_testkit import SCHEDULER_TOKEN, api_error, at, local_day, quiet_around_now
from sqlalchemy import update

from tilhero_common.internal_auth import verify_token
from tilhero_common.messaging import make_envelope
from tilhero_common.testing import assert_event_conforms, internal_headers
from tilhero_notifications.models import Notification

NOON = at(local_day(1), "12:00")


async def test_pin_code_sent_immediately_and_cleared(env) -> None:
    """Код уходит синхронно, сразу (даже в тихие часы, при выключенных уведомлениях и категориях), params
    очищаются, в центре его нет."""
    quiet = env.add_user(quiet=quiet_around_now(), categories=())
    disabled = env.add_user(enabled=False, status="DISABLED", locale="uz")
    for user in (quiet, disabled):
        r = await env.transactional(user, "482913", params={"code": "482913", "ttl_minutes": 10})
        assert r.status_code == 200 and r.json()["status"] == "sent", r.text
    texts = [c["text"] for c in env.gateway.calls]
    assert texts == [
        "Код для сброса PIN-кода родителя в TilHero: <b>482913</b>. Никому не сообщайте его. Действует 10 минут. "
        "Новый PIN-код заработает через 24 часа.",
        "TilHero ota-ona PIN-kodini tiklash kodi: <b>482913</b>. Uni hech kimga aytmang. 10 daqiqa amal qiladi. "
        "Yangi PIN-kod 24 soatdan keyin ishlaydi.",
    ]
    assert all(c["buttons"] is None for c in env.gateway.calls)
    for row in await env.rows():
        assert (row.telegram_status, row.params, row.kind, row.category, row.title) == (
            "sent", None, "transactional", "service", None
        )
    assert (await env.inbox(quiet))["items"] == []
    token = env.gateway.headers[0]["x-internal-token"]
    assert verify_token(token, "t" * 40, audience="telegram-bot-gateway").issuer == "notifications"


async def test_transactional_auth_validation_idempotency_retry_blocked(env) -> None:
    user = env.add_user()
    assert (await env.client.post("/internal/v1/notifications/transactional", json={})).status_code == 401
    for issuer in ("telegram-bff", "support", "notifications"):
        r = await env.transactional(user, issuer=issuer)
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    bad = [
        {"template": "support.reply", "params": {"number": "TCK-1"}},  # только секретные транзакционные шаблоны
        {"params": {"code": "12345"}},
        {"params": {"code": "123456", "extra": 1}},
        {"params": {"code": "123456", "ttl_minutes": 0}},
        {"dedup_key": "k" * 201},
    ]
    for override in bad:
        r = await env.transactional(user, **override)
        assert r.status_code == 422, override
    assert await env.rows(user) == [] and env.gateway.calls == []

    nid = uuid.uuid4()
    first = await env.transactional(user, notification_id=nid, params={"code": "135790", "ttl_minutes": 2})
    assert first.json() == {"notification_id": str(nid), "status": "sent", "reason": None}
    again = await env.transactional(user, notification_id=nid, params={"code": "135790", "ttl_minutes": 2})
    assert again.status_code == 200 and again.json()["status"] == "sent" and len(env.gateway.calls) == 1

    # Временная ошибка доставки: код остаётся в очереди с повтором и очищается после отправки
    env.gateway.queue.append(api_error(502, "TELEGRAM_ERROR", {"permanent": False}))
    queued = await env.transactional(user, "246802")
    assert queued.json()["status"] == "queued" and queued.json()["reason"] == "telegram_unavailable"
    row = await env.row(uuid.UUID(queued.json()["notification_id"]))
    assert row.params == {"code": "246802"} and row.scheduled_for is not None
    await env.dispatch(row.scheduled_for + timedelta(seconds=1))
    row = await env.row(row.notification_id)
    assert row.telegram_status == "sent" and row.params is None
    # Бот заблокирован → failed blocked (identity-consent ответит 409 BOT_BLOCKED); не in_app_only — кода в центре нет
    env.gateway.queue.append(api_error(409, "TELEGRAM_BLOCKED"))
    blocked = await env.transactional(user, "975310")
    assert blocked.json()["status"] == "failed" and blocked.json()["reason"] == "blocked"
    for e in await env.events("notification.delivered.v1") + await env.events("telegram.delivery.failed.v1"):
        assert "135790" not in e.to_json() and "246802" not in e.to_json() and "975310" not in e.to_json()


async def test_secret_template_only_via_direct_path(env) -> None:
    """Шаблон с секретом не принимается в обход синхронного HTTP (защита общего приёма)."""
    user = env.add_user()
    async with env.runtime.transaction() as session:
        outcome = await env.accept(
            session, None, user_id=user, template="pin.reset_code", params={"code": "111222"}, dedup_key="pin:bus"
        )
    assert outcome == "failed"
    [row] = await env.rows(user)
    assert (row.telegram_status, row.reason, row.params) == ("failed", "direct_only", None)
    async with env.runtime.transaction() as session:
        unknown = await env.accept(session, None, user_id=user, template="promo.blast", params={}, dedup_key="x")
        assert unknown == "failed"
        assert await env.accept(
            session, None, user_id=user, template="support.reply", params={"number": "1"}, dedup_key="y"
        ) == "failed"
    reasons = sorted(r.reason for r in await env.rows(user))  # type: ignore[type-var]
    assert reasons == ["direct_only", "params_invalid", "template_unknown"]
    assert len(await env.events("telegram.delivery.failed.v1")) == 3
    await env.dispatch(NOON)
    assert env.gateway.calls == []


async def test_invalid_event_goes_to_dlq(env) -> None:
    user = env.add_user()
    await env.bus.publish(
        make_envelope(
            "learning.reminder.due.v1", {"user_id": str(user), "local_date": "nope"}, producer="learning-plan"
        )
    )
    assert env.bus.dlq and env.bus.dlq[-1][0] == "notifications.learning"
    assert await env.rows(user) == []


async def test_retries_with_backoff_and_retry_after(env) -> None:
    user = env.add_user()
    await env.reply_event(user)
    nid = (await env.one(user)).notification_id
    t0 = NOON
    env.gateway.queue += [
        api_error(429, "TELEGRAM_RATE_LIMITED", {"retry_after": 7}),
        api_error(502, "TELEGRAM_ERROR", {"permanent": False}),
        httpx.ConnectError("down"),
    ]
    await env.dispatch(t0)
    row = await env.row(nid)
    assert (row.telegram_status, row.attempts, row.reason) == ("scheduled", 1, "rate_limited")
    assert row.scheduled_for == t0 + timedelta(seconds=7) and row.params == {"number": "TCK-3081"}
    assert await env.dispatch(t0 + timedelta(seconds=6)) == 0
    await env.dispatch(t0 + timedelta(seconds=8))
    row = await env.row(nid)
    assert row.attempts == 2 and row.reason == "telegram_unavailable"
    assert row.scheduled_for == t0 + timedelta(seconds=8 + 120)
    await env.dispatch(t0 + timedelta(seconds=200))
    row = await env.row(nid)
    assert row.attempts == 3 and row.reason == "gateway_unavailable"
    [item] = (await env.inbox(user))["items"]
    assert item["telegram"] == "scheduled"  # ждёт повтора — в центре уже видно
    await env.dispatch(t0 + timedelta(seconds=2000))
    row = await env.row(nid)
    assert (row.telegram_status, row.attempts, row.reason) == ("sent", 4, None)
    assert len({c["idempotency_key"] for c in env.gateway.calls}) == 1  # все попытки — один ключ


async def test_retry_does_not_hit_own_limit_reservation(env) -> None:
    """Повтор зарезервированного в лимит сообщения не упирается в собственный резерв."""
    user, day = env.add_user(), local_day(1)
    for _ in range(3):
        await env.invite("accepted", user, env.add_user())
    env.gateway.queue += [httpx.ConnectError("down")] * 3
    await env.dispatch(at(day, "12:00"))
    assert {r.telegram_status for r in await env.rows(user)} == {"scheduled"}
    await env.dispatch(at(day, "12:30"))
    assert [r.telegram_status for r in await env.rows(user)] == ["sent"] * 3


async def test_max_attempts_fail_with_event(env) -> None:
    user = env.add_user()
    await env.reply_event(user)
    nid = (await env.one(user)).notification_id
    env.gateway.queue += [api_error(503, "TELEGRAM_ERROR", {"permanent": False})] * env.settings.max_attempts
    now = NOON
    for _ in range(env.settings.max_attempts):
        await env.dispatch(now)
        now += timedelta(hours=2)
    row = await env.row(nid)
    assert (row.telegram_status, row.attempts, row.params) == ("failed", env.settings.max_attempts, None)
    [failed] = await env.events("telegram.delivery.failed.v1")
    assert failed.payload == {"notification_id": str(nid), "user_id": str(user), "reason": "error"}
    assert_event_conforms(failed)
    assert (await env.inbox(user))["items"][0]["telegram"] == "failed"


async def test_permanent_errors(env) -> None:
    gone, broken, busy = env.add_user(), env.add_user(), env.add_user()
    env.gateway.queue += [api_error(502, "TELEGRAM_ERROR", {"permanent": True, "reason": "chat_not_found"})]
    await env.reply_event(gone)
    await env.dispatch(NOON)
    env.gateway.queue += [api_error(422, "VALIDATION_ERROR")]
    await env.reply_event(broken)
    await env.dispatch(NOON)
    env.gateway.queue += [api_error(409, "IDEMPOTENCY_IN_PROGRESS")]
    await env.reply_event(busy)
    await env.dispatch(NOON)
    rows = {r.user_id: r for r in await env.rows()}
    assert (rows[busy].telegram_status, rows[busy].reason) == ("scheduled", "send_in_progress")
    assert (rows[gone].telegram_status, rows[gone].reason) == ("failed", "invalid_chat")
    assert (rows[broken].telegram_status, rows[broken].reason) == ("failed", "gateway_rejected")
    reasons = {e.payload["user_id"]: e.payload["reason"] for e in await env.events("telegram.delivery.failed.v1")}
    assert reasons == {str(gone): "invalid_chat", str(broken): "error"}


async def test_identity_outage_and_delivery_cache(env) -> None:
    user = env.add_user()
    env.identity.fail = [503, 503, 503]  # GET повторяется клиентом дважды → одна неудачная попытка
    await env.reply_event(user)
    nid = (await env.one(user)).notification_id
    await env.dispatch(NOON)
    row = await env.row(nid)
    assert (row.telegram_status, row.reason, row.title) == ("scheduled", "identity_unavailable", None)
    assert env.gateway.calls == []
    await env.dispatch(NOON + timedelta(minutes=1))
    assert (await env.row(nid)).telegram_status == "sent"
    calls_before = len(env.identity.calls)
    await env.reply_event(user)
    await env.dispatch(NOON + timedelta(minutes=2))
    assert len(env.identity.calls) == calls_before  # адрес из кэша Redis (5 мин)
    assert env.runtime.redis is not None
    cached = await env.runtime.redis.get(f"{env.settings.redis_key_prefix}:delivery:{user}")
    assert cached and json.loads(cached)["recipient_telegram_user_id"] == env.telegram_id(user)


async def test_name_lookup_outage_retries(env) -> None:
    inviter, invitee = env.add_user(), env.add_user(name="Дилноза")
    await env.invite("accepted", inviter, invitee)
    env.identity.public.pop(str(invitee))  # 404 — имя неизвестно: текст без имени
    await env.dispatch(NOON)
    assert env.gateway.calls[-1]["text"].endswith("Ваше приглашение в TilHero приняли.")


async def test_cache_reset_events(env) -> None:
    """Настройки, статус, отзыв согласия, профиль действуют сразу, а не через 5 мин TTL кэша адресации."""
    user = env.add_user()
    assert env.runtime.redis is not None
    key = f"{env.settings.redis_key_prefix}:delivery:{user}"
    events = [
        ("user.notification_settings.changed.v1", {"user_id": str(user), "enabled": False, "categories": ["support"]}),
        ("user.status.changed.v1", {"user_id": str(user), "status": "DISABLED", "previous_status": "ACTIVE"}),
        ("consent.revoked.v1", {"user_id": str(user), "consent_id": str(uuid.uuid4())}),
        ("user.profile.updated.v1", {"user_id": str(user), "changed_fields": ["locale"], "locale": "uz"}),
    ]
    for n, (event_type, payload) in enumerate(events):
        await env.reply_event(user)
        await env.dispatch(NOON + timedelta(minutes=n))
        assert await env.runtime.redis.get(key)
        await env.publish(event_type, payload)
        assert await env.runtime.redis.get(key) is None, event_type
    env.set(user, notifications_enabled=False)
    await env.reply_event(user)
    await env.dispatch(NOON + timedelta(minutes=10))
    assert (await env.rows(user))[-1].telegram_status == "in_app_only"  # взято свежим


async def test_concurrent_dispatchers_send_once(env) -> None:
    users = [env.add_user() for _ in range(6)]
    for u in users:
        await env.reply_event(u)
    counts = await asyncio.gather(env.dispatch(NOON), env.dispatch(NOON), env.dispatch(NOON))
    assert sum(counts) == 6 and len(env.gateway.calls) == 6
    assert {c["telegram_user_id"] for c in env.gateway.calls} == {env.telegram_id(u) for u in users}


async def test_health(env) -> None:
    ready = await env.client.get("/health/ready")
    assert ready.status_code == 200
    assert ready.json()["checks"] == {"db": "ok", "redis": "ok", "nats": "ok", "consumers": "ok"}


async def test_dispatch_endpoint_auth(env) -> None:
    path = "/internal/v1/notifications:dispatch"
    assert (await env.client.post(path)).status_code == 401
    for header in (f"Bearer {SCHEDULER_TOKEN}x", f"Basic {SCHEDULER_TOKEN}", "Bearer ", SCHEDULER_TOKEN):
        r = await env.client.post(path, headers={"Authorization": header})
        assert r.status_code == 401 and r.json()["code"] == "SCHEDULER_TOKEN_INVALID", header
    for issuer in ("telegram-bff", "identity-consent"):
        r = await env.client.post(path, headers=internal_headers(env.settings, issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    env.settings.scheduler_token = type(env.settings.scheduler_token)("")  # пустой токен выключает вход
    r = await env.client.post(path, headers={"Authorization": "Bearer "})
    assert r.status_code == 401
    r = await env.client.post(path, headers={"Authorization": f"Bearer {SCHEDULER_TOKEN}"})
    assert r.status_code == 401


async def test_dispatch_endpoint_processes_due_and_is_repeat_safe(env) -> None:
    path = "/internal/v1/notifications:dispatch"
    auth = {"Authorization": f"Bearer {SCHEDULER_TOKEN}"}
    sent, off = env.add_user(), env.add_user(enabled=False)
    quiet = env.add_user(quiet=quiet_around_now())
    blocked = env.add_user()
    for u in (sent, off, quiet, blocked):
        await env.reply_event(u)
    env.gateway.queue.append(api_error(409, "TELEGRAM_BLOCKED"))  # уходит первому отправленному
    r = await env.client.post(path, headers=auth)
    assert r.status_code == 200
    assert r.json() == {"sent": 1, "scheduled": 1, "in_app_only": 2, "failed": 0}
    again = await env.client.post(path, headers=auth)
    assert again.json() == {"sent": 0, "scheduled": 0, "in_app_only": 0, "failed": 0}
    assert len(env.gateway.calls) == 2
    # срок хранения: записи старше 90 дней удаляются
    async with env.runtime.transaction() as s:
        await s.execute(update(Notification).values(created_at=datetime.now(UTC) - timedelta(days=91)))
    await env.client.post(path, headers=auth)
    assert await env.rows() == []
