"""Политика и доставка: support.reply/resolved, PIN-код, тихие часы, дедупликация, ретраи, удаление."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from notif_testkit import CRIT_PARAMS, api_error
from sqlalchemy import text

from tilhero_common.internal_auth import verify_token
from tilhero_common.testing import assert_event_conforms
from tilhero_notifications.policy import quiet_hours_end


def quiet_around_now(tz: str = "Asia/Tashkent") -> dict[str, str]:
    local = datetime.now(UTC).astimezone(ZoneInfo(tz))
    return {
        "start": (local - timedelta(hours=1)).strftime("%H:%M"),
        "end": (local + timedelta(hours=2)).strftime("%H:%M"),
    }


async def test_support_reply_notification_without_reply_text(env) -> None:
    ru, en = env.add_user(locale="ru"), env.add_user(locale="en")
    await env.reply_event(ru, "TCK-3081")
    await env.reply_event(en, "TCK-3082")
    [row_ru] = await env.rows(ru)
    assert row_ru.kind == "standard" and row_ru.template == "support.reply" and row_ru.status == "queued"
    assert row_ru.params == {"number": "TCK-3081"}
    assert await env.dispatch() == 2
    by_user = {c["telegram_user_id"]: c for c in env.gateway.calls}
    msg = by_user[env.telegram_id(ru)]
    assert msg["text"] == "Поддержка ответила на обращение TCK-3081. Откройте, чтобы прочитать."
    assert msg["buttons"] == [[{"text": "Открыть обращение", "startapp": "ticket_TCK-3081"}]]
    assert msg["idempotency_key"] == str(row_ru.notification_id) and msg["disable_notification"] is False
    assert by_user[env.telegram_id(en)]["text"] == (
        "Support replied to your request TCK-3082. Open it to read the reply."
    )
    assert by_user[env.telegram_id(en)]["buttons"][0][0]["text"] == "Open request"
    token = env.gateway.headers[0]["x-internal-token"]
    # EdDSA, ключ издателя notifications (dev/test — выведен из секрета стенда)
    assert verify_token(token, "t" * 40, audience="telegram-bot-gateway").issuer == "notifications"
    sent = await env.row(row_ru.notification_id)
    assert sent.status == "sent" and sent.params is None and sent.telegram_message_id and sent.attempts == 1
    delivered = await env.events("notification.delivered.v1")
    assert len(delivered) == 2
    assert {d.payload["user_id"] for d in delivered} == {str(ru), str(en)}
    for d in delivered:
        assert d.payload["channel"] == "telegram"
        assert_event_conforms(d)


async def test_resolved_notification_only_for_resolved(env) -> None:
    user = env.add_user()
    base = {
        "ticket_id": str(uuid.uuid4()),
        "number": "TCK-3090",
        "user_id": str(user),
        "changed_by": "operator",
    }
    for frm, to in (
        ("NEW", "IN_PROGRESS"),
        ("IN_PROGRESS", "WAITING_CUSTOMER"),
        ("WAITING_CUSTOMER", "RESOLVED"),
    ):
        await env.publish(
            "support.ticket.status.changed.v1",
            {**base, "from_status": frm, "to_status": to},
            producer="support",
        )
    await env.publish(
        "support.ticket.status.changed.v1",
        {**base, "user_id": None, "from_status": "NEW", "to_status": "RESOLVED", "changed_by": "system"},
        producer="support",
    )
    rows = await env.rows()
    assert [r.template for r in rows] == ["support.resolved"]
    await env.dispatch()
    assert env.gateway.calls[0]["text"].startswith("Обращение TCK-3090 решено.")
    assert env.gateway.calls[0]["buttons"] == [[{"text": "Открыть обращение", "startapp": "ticket_TCK-3090"}]]


async def test_pin_reset_code_is_transactional_and_cleared(env) -> None:
    """Ревью P2: код приходит синхронным HTTP от identity-consent, отправляется сразу (даже в тихие часы и при
    выключенных уведомлениях), params очищаются; через шину код не принимается."""
    quiet = env.add_user(quiet=quiet_around_now())
    disabled = env.add_user(enabled=False, status="DISABLED")
    for user in (quiet, disabled):
        r = await env.transactional(user, "482913", params={"code": "482913", "ttl_minutes": 10})
        assert r.status_code == 200 and r.json()["status"] == "sent", r.text
    texts = [c["text"] for c in env.gateway.calls]
    assert (
        texts
        == ["Код для сброса PIN в TilHero: <b>482913</b>. Никому не сообщайте его. Действует 10 минут."] * 2
    )
    for row in await env.rows():
        assert row.status == "sent" and row.params is None and row.kind == "transactional"
    # Через шину шаблон с секретом не принимается: failed direct_only, параметры не сохраняются
    bus_id = await env.request(quiet, "pin.reset_code", {"code": "111222"})
    row = await env.row(bus_id)
    assert (row.status, row.failure_reason, row.params) == ("failed", "direct_only", None)
    await env.dispatch()
    assert len(env.gateway.calls) == 2


async def test_transactional_endpoint_auth_validation_idempotency_and_retry(env) -> None:
    user = env.add_user()
    assert (await env.client.post("/internal/v1/notifications/transactional", json={})).status_code == 401
    for issuer in ("telegram-bff", "support", "notifications"):
        r = await env.transactional(user, issuer=issuer)
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    bad = [
        {"template": "watch.critical", "params": CRIT_PARAMS},  # только секретные транзакционные шаблоны
        {"params": {"code": "12345"}},
        {"params": {"code": "123456", "extra": 1}},
        {"params": {"code": "123456", "ttl_minutes": 0}},
    ]
    for override in bad:
        r = await env.transactional(user, **override)
        assert r.status_code == 422, override
    assert await env.rows(user) == [] and env.gateway.calls == []

    nid = uuid.uuid4()
    first = await env.transactional(user, "135790", notification_id=nid, params={"code": "135790", "ttl_minutes": 2})
    assert first.json() == {"notification_id": str(nid), "status": "sent", "reason": None}
    assert env.gateway.calls[-1]["text"].endswith("Действует 2 минуты.")
    again = await env.transactional(user, "135790", notification_id=nid)
    assert again.status_code == 200 and again.json()["status"] == "sent" and len(env.gateway.calls) == 1

    # Временная ошибка доставки: код остаётся в очереди с повтором и очищается после отправки
    env.gateway.queue.append(api_error(502, "TELEGRAM_ERROR", {"permanent": False}))
    queued = await env.transactional(user, "246802")
    assert queued.json()["status"] == "queued" and queued.json()["reason"] == "telegram_unavailable"
    row = await env.row(uuid.UUID(queued.json()["notification_id"]))
    assert row.params == {"code": "246802"} and row.next_attempt_at is not None
    await env.dispatch(row.next_attempt_at + timedelta(seconds=1))
    row = await env.row(row.notification_id)
    assert row.status == "sent" and row.params is None
    # Бот заблокирован → failed blocked (identity-consent сообщит пользователю)
    env.gateway.queue.append(api_error(409, "TELEGRAM_BLOCKED"))
    blocked = await env.transactional(user, "975310")
    assert blocked.json()["status"] == "failed" and blocked.json()["reason"] == "blocked"
    # Код не попадает в события
    for e in await env.events("notification.delivered.v1") + await env.events("telegram.delivery.failed.v1"):
        assert "135790" not in e.to_json() and "246802" not in e.to_json()


async def test_quiet_hours_defer_until_end(env) -> None:
    window = quiet_around_now()
    user = env.add_user(quiet=window)
    await env.reply_event(user)
    critical = await env.request(
        user,
        "watch.critical",
        CRIT_PARAMS,
        kind="critical",
    )
    now = datetime.now(UTC) + timedelta(seconds=1)
    await env.dispatch(now)
    assert len(env.gateway.calls) == 1 and env.gateway.calls[0]["text"].startswith(
        "<b>Desert Sounds Festival</b>"
    )
    assert (await env.row(critical)).status == "sent"  # критичное — сразу, даже в тихие часы
    [deferred] = [r for r in await env.rows(user) if r.template == "support.reply"]
    expected_end = quiet_hours_end(now, window["start"], window["end"], ZoneInfo("Asia/Tashkent"))
    assert deferred.status == "scheduled" and deferred.scheduled_for == expected_end
    assert deferred.next_attempt_at == expected_end and deferred.params == {"number": "TCK-3081"}
    assert await env.dispatch(expected_end - timedelta(seconds=5)) == 0
    assert await env.dispatch(expected_end + timedelta(seconds=1)) == 1
    assert len(env.gateway.calls) == 2 and (await env.row(deferred.notification_id)).status == "sent"


async def test_disabled_inactive_or_deleted_are_skipped(env) -> None:
    off = env.add_user(enabled=False)
    inactive = env.add_user(status="DELETION_REQUESTED")
    ghost = uuid.uuid4()  # identity-consent: 404
    for user in (off, inactive, ghost):
        await env.reply_event(user)
    await env.dispatch()
    assert env.gateway.calls == []
    reasons = {r.user_id: (r.status, r.failure_reason, r.params) for r in await env.rows()}
    assert reasons == {
        off: ("skipped", "notifications_disabled", None),
        inactive: ("skipped", "user_inactive", None),
        ghost: ("skipped", "user_not_found", None),
    }
    assert await env.events("notification.delivered.v1") == []


async def test_deduplication(env) -> None:
    user = env.add_user()
    await env.critical(user, dedup_key="crit:req-1")
    await env.critical(user, dedup_key="crit:req-1")  # другой notification_id
    message_id = uuid.uuid4()
    replied = await env.reply_event(user, message_id=message_id)
    await env.reply_event(user, message_id=message_id)  # новое событие о том же ответе
    spec = next(s for s in env.bus.specs if s.durable == "notifications.support")
    await spec.handler(replied)  # повторная доставка того же события (inbox)
    assert len(await env.rows(user)) == 2
    await env.dispatch()
    await env.dispatch()
    assert len(env.gateway.calls) == 2


async def test_retries_with_backoff_and_retry_after(env) -> None:
    user = env.add_user()
    nid = await env.critical(user)
    t0 = datetime.now(UTC) + timedelta(seconds=1)
    env.gateway.queue += [
        api_error(429, "TELEGRAM_RATE_LIMITED", {"retry_after": 7}),
        api_error(502, "TELEGRAM_ERROR", {"permanent": False}),
        httpx.ConnectError("down"),
    ]
    await env.dispatch(t0)
    row = await env.row(nid)
    assert row.status == "queued" and row.attempts == 1 and row.failure_reason == "rate_limited"
    assert row.next_attempt_at == t0 + timedelta(seconds=7) and row.params == CRIT_PARAMS
    assert await env.dispatch(t0 + timedelta(seconds=6)) == 0
    await env.dispatch(t0 + timedelta(seconds=8))
    row = await env.row(nid)
    assert row.attempts == 2 and row.failure_reason == "telegram_unavailable"
    assert row.next_attempt_at == t0 + timedelta(seconds=8 + 120)
    await env.dispatch(t0 + timedelta(seconds=200))
    row = await env.row(nid)
    assert row.attempts == 3 and row.failure_reason == "gateway_unavailable"
    await env.dispatch(t0 + timedelta(seconds=2000))
    row = await env.row(nid)
    assert row.status == "sent" and row.attempts == 4 and row.failure_reason is None
    assert len({c["idempotency_key"] for c in env.gateway.calls}) == 1  # все попытки — один ключ


async def test_max_attempts_fail_with_event(env) -> None:
    user = env.add_user()
    nid = await env.critical(user)
    env.gateway.queue += [api_error(503, "TELEGRAM_ERROR", {"permanent": False})] * env.settings.max_attempts
    now = datetime.now(UTC) + timedelta(seconds=1)
    for _ in range(env.settings.max_attempts):
        await env.dispatch(now)
        now += timedelta(hours=2)
    row = await env.row(nid)
    assert row.status == "failed" and row.attempts == env.settings.max_attempts and row.params is None
    [failed] = await env.events("telegram.delivery.failed.v1")
    assert failed.payload == {"notification_id": str(nid), "user_id": str(user), "reason": "error"}
    assert_event_conforms(failed)


async def test_blocked_and_permanent_errors(env) -> None:
    blocked, gone, broken = env.add_user(), env.add_user(), env.add_user()
    env.gateway.queue += [api_error(409, "TELEGRAM_BLOCKED")]
    await env.critical(blocked)
    await env.dispatch()
    env.gateway.queue += [api_error(502, "TELEGRAM_ERROR", {"permanent": True, "reason": "chat_not_found"})]
    await env.critical(gone)
    await env.dispatch()
    env.gateway.queue += [api_error(422, "VALIDATION_ERROR")]
    await env.critical(broken)
    await env.dispatch()
    busy = env.add_user()
    env.gateway.queue += [api_error(409, "IDEMPOTENCY_IN_PROGRESS")]
    busy_id = await env.critical(busy)
    await env.dispatch()
    busy_row = await env.row(busy_id)
    assert (busy_row.status, busy_row.failure_reason) == ("queued", "send_in_progress")  # не конечная ошибка
    rows = {r.user_id: r for r in await env.rows() if r.user_id != busy}
    assert (rows[blocked].status, rows[blocked].failure_reason) == ("failed", "blocked")
    assert (rows[gone].status, rows[gone].failure_reason) == ("failed", "invalid_chat")
    assert (rows[broken].status, rows[broken].failure_reason) == ("failed", "gateway_rejected")
    assert all(r.params is None for r in rows.values())
    reasons = {
        e.payload["user_id"]: e.payload["reason"] for e in await env.events("telegram.delivery.failed.v1")
    }
    assert reasons == {str(blocked): "blocked", str(gone): "invalid_chat", str(broken): "error"}
    assert len(env.gateway.calls) == 4


async def test_identity_outage_and_delivery_cache(env) -> None:
    user = env.add_user()
    env.identity.fail = [503, 503, 503]  # GET повторяется клиентом дважды → одна неудачная попытка
    nid = await env.critical(user)
    now = datetime.now(UTC) + timedelta(seconds=1)
    await env.dispatch(now)
    row = await env.row(nid)
    assert row.status == "queued" and row.failure_reason == "identity_unavailable" and env.gateway.calls == []
    await env.dispatch(now + timedelta(minutes=1))
    assert (await env.row(nid)).status == "sent"
    calls_before = len(env.identity.calls)
    await env.critical(user)
    await env.dispatch()
    assert len(env.identity.calls) == calls_before  # адрес из кэша Redis (5 мин)
    assert env.runtime.redis is not None
    cached = await env.runtime.redis.get(f"{env.settings.redis_key_prefix}:delivery:{user}")
    assert cached and json.loads(cached)["telegram_user_id"] == env.telegram_id(user)


async def test_user_deletion_removes_journal(env) -> None:
    user, other = env.add_user(), env.add_user()
    await env.critical(user)
    await env.critical(other)
    await env.dispatch()
    request_id = str(uuid.uuid4())
    await env.publish(
        "user.deletion.requested.v1",
        {"user_id": str(user), "request_id": request_id, "requested_at": "2026-10-08T10:00:00Z"},
    )
    assert await env.rows(user) == [] and len(await env.rows(other)) == 1
    assert env.runtime.redis is not None
    assert await env.runtime.redis.get(f"{env.settings.redis_key_prefix}:delivery:{user}") is None
    [ack] = await env.events("user.domain.deleted.v1")
    assert ack.payload == {
        "user_id": str(user),
        "request_id": request_id,
        "domain": "notifications",
        "mode": "deleted",
    }
    assert_event_conforms(ack)


async def test_rejected_requests(env) -> None:
    user = env.add_user()
    unknown = await env.request(user, "promo.blast", {"x": 1}, kind="digest")
    bad = await env.request(user, "watch.critical", {**CRIT_PARAMS, "change": "<b>x</b>"}, kind="critical")
    extra = await env.request(
        user, "support.reply", {"number": "TCK-1", "text": "ответ оператора"}, kind="digest"
    )
    for nid, reason in ((unknown, "template_unknown"), (bad, "params_invalid"), (extra, "params_invalid")):
        row = await env.row(nid)
        assert (row.status, row.failure_reason, row.params) == ("failed", reason, None)
    assert len(await env.events("telegram.delivery.failed.v1")) == 3
    # Невалидный конверт уходит в DLQ, журнал не пишется
    await env.publish("notification.requested.v1", {"notification_id": "nope", "user_id": str(user)})
    assert env.bus.dlq and env.bus.dlq[-1][0] == "notifications.requests"
    assert len(await env.rows(user)) == 3
    await env.dispatch()
    assert env.gateway.calls == []


async def test_concurrent_dispatchers_send_once(env) -> None:
    users = [env.add_user() for _ in range(6)]
    for u in users:
        await env.critical(u)
    counts = await asyncio.gather(env.dispatch(), env.dispatch(), env.dispatch())
    assert sum(counts) == 6 and len(env.gateway.calls) == 6
    assert {c["telegram_user_id"] for c in env.gateway.calls} == {env.telegram_id(u) for u in users}


async def test_health(env) -> None:
    ready = await env.client.get("/health/ready")
    assert ready.status_code == 200
    assert ready.json()["checks"] == {"db": "ok", "redis": "ok", "nats": "ok", "consumers": "ok"}


async def test_deleted_user_gets_no_new_notifications(env) -> None:
    """Ревью P3: после ACK удаления запоздавшие события не создают записей журнала с user_id."""
    user = env.add_user()
    request_id = str(uuid.uuid4())
    await env.publish(
        "user.deletion.requested.v1",
        {"user_id": str(user), "request_id": request_id, "requested_at": "2026-10-08T10:00:00Z"},
    )
    await env.reply_event(user)
    await env.critical(user)
    tx = await env.transactional(user)
    assert tx.status_code == 200 and tx.json()["status"] == "skipped" and tx.json()["reason"] == "user_deleted"
    assert await env.rows(user) == [] and env.gateway.calls == []
    async with env.runtime.transaction() as s:
        marks = (await s.execute(text("SELECT count(*) FROM deleted_users WHERE user_id = :u"), {"u": user})).scalar()
    assert marks == 1
    # повторный запрос удаления (новое событие) снова подтверждается
    await env.publish(
        "user.deletion.requested.v1",
        {"user_id": str(user), "request_id": request_id, "requested_at": "2026-10-08T10:00:00Z"},
    )
    assert len(await env.events("user.domain.deleted.v1")) == 2


async def test_race_deletion_vs_new_notification(env) -> None:
    """Гонка «удаление ↔ новое уведомление»: при любом порядке строк журнала с user_id не остаётся."""
    for _ in range(8):
        user = env.add_user()
        deletion = env.publish(
            "user.deletion.requested.v1",
            {"user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": "2026-10-08T10:00:00Z"},
        )
        await asyncio.gather(env.reply_event(user), deletion, env.critical(user))
        assert await env.rows(user) == []


async def test_status_change_and_consent_revocation_reset_delivery_cache(env) -> None:
    """Ревью #17: отключение/отзыв согласия действуют сразу, а не через 5 мин TTL кэша адресации."""
    user = env.add_user()
    await env.critical(user)
    await env.dispatch()
    assert env.runtime.redis is not None
    key = f"{env.settings.redis_key_prefix}:delivery:{user}"
    assert await env.runtime.redis.get(key)
    env.identity.users[str(user)]["status"] = "DISABLED"
    await env.publish("user.status.changed.v1",
                      {"user_id": str(user), "status": "DISABLED", "previous_status": "ACTIVE"})
    assert await env.runtime.redis.get(key) is None
    await env.critical(user)
    await env.dispatch()
    assert len(env.gateway.calls) == 1  # второе не отправлено: статус взят свежим
    await env.dispatch()
    env.identity.users[str(user)]["status"] = "ACTIVE"
    await env.publish("consent.revoked.v1", {"user_id": str(user), "consent_id": str(uuid.uuid4())})
    assert await env.runtime.redis.get(key) is None
