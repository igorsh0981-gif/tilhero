"""Запрос удаления, ACK доменов (user.domain.deleted.v1), обезличивание, повторная регистрация;
служебные API delivery и bot-status; обратимость миграций."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import func, select, text

from tilhero_common.messaging import make_envelope
from tilhero_common.messaging.store import inbox_table
from tilhero_identity.models import BiometricCredential, Consent, DeletionRequest, PinCredential, User

PIN = "2580"
# offers — спринт 5; recommendations, watch, news — спринт 6; ai-concierge, ai-control — спринт 7
DOMAINS = ["preferences", "support", "notifications", "offers", "recommendations", "watch", "news",
           "ai-concierge", "ai-control"]
SERVICE_DIR = Path(__file__).resolve().parents[1]


def ack(user_id: str, request_id: str, domain: str, mode: str = "deleted"):
    return make_envelope(
        "user.domain.deleted.v1",
        {"user_id": user_id, "request_id": request_id, "domain": domain, "mode": mode},
        producer=domain,
    )


async def _request(env, uid: str) -> DeletionRequest:
    async with env.runtime.transaction() as s:
        return (
            await s.execute(select(DeletionRequest).where(DeletionRequest.user_id == uuid.UUID(uid)))
        ).scalar_one()


async def _user(env, uid: str) -> User:
    async with env.runtime.transaction() as s:
        return (await s.execute(select(User).where(User.user_id == uuid.UUID(uid)))).scalar_one()


# ---------- запрос удаления ----------


async def test_deletion_request_with_confirm_word(env) -> None:
    uid = await env.new_user()
    for body in ({}, {"confirm_word": "удали"}, {"confirm_word": "yes"}, {"pin": PIN}):
        r = await env.call("POST", "/internal/v1/me/deletion-request", uid, body)
        assert r.status_code == 422 and r.json()["code"] == "DELETION_CONFIRMATION_REQUIRED", body
        assert r.json()["details"] == {"method": "confirm_word"}
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"confirm_word": " удалить "})
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["status"] == "REQUESTED" and body["domains"] == [*DOMAINS, "identity-consent"]
    uuid.UUID(body["request_id"])

    # повтор — тот же запрос, без новых событий
    again = await env.call("POST", "/internal/v1/me/deletion-request", uid, {})
    assert again.status_code == 202 and again.json() == body

    me = (await env.call("GET", "/internal/v1/me", uid)).json()
    assert me["user"]["status"] == "DELETION_REQUESTED" and me["settings"]["enabled"] is False
    [requested] = await env.events("user.deletion.requested.v1", uid)
    assert requested.payload["request_id"] == body["request_id"] and requested.payload[
        "requested_at"
    ].endswith("Z")
    [status] = await env.events("user.status.changed.v1", uid)
    assert status.payload == {
        "user_id": uid,
        "status": "DELETION_REQUESTED",
        "previous_status": "ACTIVE",
        "reason_code": "deletion_requested",
    }

    # после запроса удаления профиль не меняется
    for method, path, payload in (
        ("PATCH", "/internal/v1/me/settings", {"locale": "en"}),
        ("PUT", "/internal/v1/me/pin", {"pin": PIN}),
        (
            "POST",
            "/internal/v1/me/consent",
            {"policy_version": "1.0", "purposes": ["personalization"], "age_confirmed_18_plus": True},
        ),
        ("DELETE", "/internal/v1/me/consent", None),
        ("POST", "/internal/v1/me/enable", None),
        ("POST", "/internal/v1/me/disable", None),
        ("PUT", "/internal/v1/me/biometric", None),
    ):
        r = await env.call(method, path, uid, payload)
        assert r.status_code == 409 and r.json()["code"] == "USER_DELETION_REQUESTED", path


async def test_deletion_request_with_pin(env) -> None:
    uid = await env.new_user()
    await env.set_pin(uid)
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"confirm_word": "DELETE"})
    assert r.status_code == 422 and r.json()["details"] == {"method": "pin"}
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"pin": "1357"})
    assert (
        r.status_code == 401 and r.json()["code"] == "PIN_INVALID" and r.json()["details"] == {"remaining": 4}
    )
    assert (await _user(env, uid)).status == "ACTIVE"
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"pin": PIN})
    assert r.status_code == 202
    for body in ({"pin": "1" * 17}, {"confirm_word": "x" * 33}, {"pin": PIN, "reason": "x"}):
        assert (await env.call("POST", "/internal/v1/me/deletion-request", uid, body)).status_code == 422


async def test_disabled_user_can_request_deletion(env) -> None:
    uid = await env.new_user()
    await env.call("POST", "/internal/v1/me/disable", uid)
    assert (
        await env.call("POST", "/internal/v1/me/deletion-request", uid, {"confirm_word": "DELETE"})
    ).status_code == 202
    [ev] = [
        e
        for e in await env.events("user.status.changed.v1", uid)
        if e.payload["status"] == "DELETION_REQUESTED"
    ]
    assert ev.payload["previous_status"] == "DISABLED"


# ---------- ACK доменов и обезличивание ----------


async def test_full_deletion_cycle_and_reregistration(env) -> None:
    tg = 7_000_123_456
    login = await env.login(tg, username="demo_user", first_name="Тест", last_name="Маска")
    uid = login["user"]["user_id"]
    await env.consent(uid)
    await env.set_pin(uid)
    await env.call("PUT", "/internal/v1/me/biometric", uid)
    request_id = (await env.call("POST", "/internal/v1/me/deletion-request", uid, {"pin": PIN})).json()[
        "request_id"
    ]

    first = ack(uid, request_id, "preferences")
    await env.bus.publish(first)
    # повторная доставка того же события в обработчик (как при redelivery JetStream после сбоя ack)
    [consumer] = [spec for spec in env.bus.specs if spec.durable == "identity-consent.deletion_acks"]
    await consumer.handler(first)
    await consumer.handler(first)
    await env.bus.publish(ack(uid, request_id, "support", "anonymized"))
    # чужие/лишние подтверждения игнорируются
    await env.bus.publish(ack(uid, str(uuid.uuid4()), "notifications"))
    await env.bus.publish(ack(str(uuid.uuid4()), request_id, "notifications"))
    await env.bus.publish(ack(uid, request_id, "discovery"))  # не домен удаления
    await env.flush()

    req = await _request(env, uid)
    assert req.status == "REQUESTED" and sorted(req.acked_domains) == ["preferences", "support"]
    assert (await _user(env, uid)).telegram_user_id == tg
    assert env.bus.dlq == []

    # повтор той же доставки обработан один раз (inbox)
    async with env.runtime.transaction() as s:
        seen = (
            await s.execute(
                select(func.count()).select_from(inbox_table).where(inbox_table.c.event_id == first.event_id)
            )
        ).scalar_one()
    assert seen == 1

    await env.bus.publish(ack(uid, request_id, "notifications"))
    await env.bus.publish(ack(uid, request_id, "offers"))  # спринт 5: снимки предложений
    await env.flush()
    # спринт 6: без recommendations, watch и news профиль не обезличивается
    for d in ("recommendations", "watch"):
        await env.bus.publish(ack(uid, request_id, d))
    await env.flush()
    req = await _request(env, uid)
    assert req.status == "REQUESTED" and "news" not in req.acked_domains
    assert (await _user(env, uid)).telegram_user_id == tg
    await env.bus.publish(ack(uid, request_id, "news"))
    await env.flush()
    # спринт 7: без ai-concierge (переписки) и ai-control (уровни доступа, usage) профиль не обезличивается
    await env.bus.publish(ack(uid, request_id, "ai-concierge"))
    await env.flush()
    req = await _request(env, uid)
    assert req.status == "REQUESTED" and "ai-control" not in req.acked_domains
    assert (await _user(env, uid)).telegram_user_id == tg
    await env.bus.publish(ack(uid, request_id, "ai-control", "anonymized"))
    await env.flush()

    user = await _user(env, uid)
    assert user.status == "DELETED" and user.telegram_user_id is None
    assert user.username is None and user.display_name is None and user.notifications_enabled is False
    req = await _request(env, uid)
    assert req.status == "COMPLETED" and req.completed_at is not None
    assert sorted(req.acked_domains) == sorted(DOMAINS)
    async with env.runtime.transaction() as s:
        assert await s.get(PinCredential, uuid.UUID(uid)) is None
        assert await s.get(BiometricCredential, uuid.UUID(uid)) is None
        consents = list((await s.execute(select(Consent).where(Consent.user_id == uuid.UUID(uid)))).scalars())
    # согласие осталось доказательством, без PII
    [consent] = consents
    assert consent.revoke_reason == "deletion" and consent.evidence_hash
    assert str(tg) not in repr(consent.__dict__) and "demo_user" not in repr(consent.__dict__)
    assert await env.redis.exists(f"pin:fail:{uid}", f"pin:lock:{uid}") == 0

    [done] = [e for e in await env.events("user.domain.deleted.v1", uid) if e.producer == "identity-consent"]
    assert done.payload == {
        "user_id": uid,
        "request_id": request_id,
        "domain": "identity-consent",
        "mode": "anonymized",
    }
    statuses = [
        (e.payload["previous_status"], e.payload["status"])
        for e in await env.events("user.status.changed.v1", uid)
    ]
    assert statuses == [("ACTIVE", "DELETION_REQUESTED"), ("DELETION_REQUESTED", "DELETED")]

    # удалённый пользователь недоступен ни клиенту, ни для доставки
    assert (await env.call("GET", "/internal/v1/me", uid)).status_code == 404
    assert (
        await env.call("GET", f"/internal/v1/users/{uid}/delivery", None, issuer="notifications")
    ).status_code == 404
    # поздний ACK после завершения — без побочных эффектов
    await env.bus.publish(ack(uid, request_id, "preferences"))
    await env.flush()
    assert (
        len([e for e in env.bus.of_type("user.domain.deleted.v1") if e.producer == "identity-consent"]) == 1
    )

    # тот же Telegram ID снова открывает TilHero → новый профиль с чистого листа
    fresh = await env.login(tg, first_name="Тест")
    assert fresh["user"]["user_id"] != uid and fresh["user"]["is_new"] is True
    assert fresh["user"]["status"] == "ACTIVE" and fresh["consent"]["accepted"] is False
    assert fresh["security"]["pin_enabled"] is False
    created = await env.events("user.profile.created.v1")
    assert [e.payload["user_id"] for e in created] == [uid, fresh["user"]["user_id"]]


async def test_anonymization_waits_for_all_domains_in_any_order(env) -> None:
    uid = await env.new_user()
    request_id = (
        await env.call("POST", "/internal/v1/me/deletion-request", uid, {"confirm_word": "DELETE"})
    ).json()["request_id"]
    await asyncio.gather(*[env.bus.publish(ack(uid, request_id, d)) for d in reversed(DOMAINS)])
    await env.flush()
    assert (await _user(env, uid)).status == "DELETED"
    assert (
        len([e for e in env.bus.of_type("user.domain.deleted.v1") if e.producer == "identity-consent"]) == 1
    )


async def test_own_and_malformed_acks_are_ignored(env) -> None:
    uid = await env.new_user()
    request_id = (
        await env.call("POST", "/internal/v1/me/deletion-request", uid, {"confirm_word": "DELETE"})
    ).json()["request_id"]
    await env.bus.publish(ack(uid, request_id, "identity-consent", "anonymized"))
    await env.bus.publish(
        make_envelope(
            "user.domain.deleted.v1",
            {"user_id": uid, "request_id": "nope", "domain": "support"},
            producer="support",
        )
    )
    await env.flush()
    assert env.bus.dlq == []
    req = await _request(env, uid)
    assert req.acked_domains == [] and req.status == "REQUESTED"


# ---------- служебные API ----------


async def test_delivery_endpoint(env) -> None:
    tg = 4_242_424_242
    uid = await env.new_user(telegram_user_id=tg, language_code="en")
    await env.consent(uid)
    await env.call(
        "PATCH",
        "/internal/v1/me/settings",
        uid,
        {"notifications": {"quiet_hours": {"start": "22:00", "end": "08:00"}}},
    )
    r = await env.call("GET", f"/internal/v1/users/{uid}/delivery", None, issuer="notifications")
    assert r.status_code == 200
    assert r.json() == {
        "telegram_user_id": tg,
        "locale": "en",
        "notifications_enabled": True,
        "quiet_hours": {"start": "22:00", "end": "08:00"},
        "digest_time": "09:00",  # по умолчанию (спринт 6: дайджест notifications)
        "timezone": "Asia/Tashkent",
        "status": "ACTIVE",
    }
    # digest_time и timezone из настроек пользователя — в ответе delivery
    await env.call(
        "PATCH",
        "/internal/v1/me/settings",
        uid,
        {"notifications": {"digest_time": "07:45", "timezone": "Europe/Moscow"}},
    )
    r = await env.call("GET", f"/internal/v1/users/{uid}/delivery", None, issuer="notifications")
    assert r.json()["digest_time"] == "07:45" and r.json()["timezone"] == "Europe/Moscow"
    # только notifications
    for caller in ("telegram-bff", "telegram-bot-gateway", "support"):
        r = await env.call("GET", f"/internal/v1/users/{uid}/delivery", None, issuer=caller)
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    assert (await env.client.get(f"/internal/v1/users/{uid}/delivery")).status_code == 401
    missing = await env.call(
        "GET", f"/internal/v1/users/{uuid.uuid4()}/delivery", None, issuer="notifications"
    )
    assert missing.status_code == 404 and missing.json()["code"] == "USER_NOT_FOUND"
    assert (
        await env.call("GET", "/internal/v1/users/abc/delivery", None, issuer="notifications")
    ).status_code == 422
    # статус передаётся — notifications решает, слать ли (transactional PIN-код уходит и при DISABLED)
    await env.call("POST", "/internal/v1/me/disable", uid)
    r = await env.call("GET", f"/internal/v1/users/{uid}/delivery", None, issuer="notifications")
    assert r.json()["status"] == "DISABLED" and r.json()["notifications_enabled"] is False


async def test_bot_status_endpoint(env) -> None:
    tg = 3_131_313_131
    uid = await env.new_user(telegram_user_id=tg)
    await env.consent(uid)
    path = f"/internal/v1/telegram-users/{tg}/bot-status"
    for caller in ("telegram-bff", "notifications"):
        r = await env.call("POST", path, None, {"blocked": True}, issuer=caller)
        assert r.status_code == 403
    assert (await env.client.post(path, json={"blocked": True})).status_code == 401
    r = await env.call("POST", path, None, {"blocked": True}, issuer="telegram-bot-gateway")
    assert r.status_code == 204 and r.content == b""
    me = (await env.call("GET", "/internal/v1/me", uid)).json()
    assert me["settings"]["enabled"] is False
    assert (await _user(env, uid)).bot_blocked is True
    # разблокировка не включает уведомления сама — решает пользователь
    await env.call("POST", path, None, {"blocked": False}, issuer="telegram-bot-gateway")
    assert (await _user(env, uid)).bot_blocked is False
    assert (await env.call("GET", "/internal/v1/me", uid)).json()["settings"]["enabled"] is False

    unknown = await env.call(
        "POST",
        "/internal/v1/telegram-users/999/bot-status",
        None,
        {"blocked": True},
        issuer="telegram-bot-gateway",
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


# ---------- миграции ----------


async def test_migrations_are_reversible(env) -> None:
    cfg = Config(str(SERVICE_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVICE_DIR / "migrations"))
    cfg.attributes["settings"] = env.settings
    await env.runtime.db.dispose()  # отпускаем соединения пула перед DDL
    await asyncio.to_thread(command.downgrade, cfg, "base")
    async with env.runtime.transaction() as s:
        tables = (
            (
                await s.execute(
                    text(
                        "SELECT table_name FROM information_schema.tables WHERE table_schema = :s ORDER BY 1"
                    ),
                    {"s": env.schema},
                )
            )
            .scalars()
            .all()
        )
    assert tables == ["alembic_version"]
    await asyncio.to_thread(command.upgrade, cfg, "head")
    async with env.runtime.transaction() as s:
        tables = (
            (
                await s.execute(
                    text(
                        "SELECT table_name FROM information_schema.tables WHERE table_schema = :s ORDER BY 1"
                    ),
                    {"s": env.schema},
                )
            )
            .scalars()
            .all()
        )
    assert tables == [
        "alembic_version",
        "biometric_credentials",
        "consents",
        "deletion_attempts",
        "deletion_domain_acks",
        "deletion_idempotency_keys",
        "deletion_requests",
        "inbox",
        "outbox",
        "pin_credentials",
        "users",
    ]


async def test_no_expected_domains_anonymizes_immediately(env) -> None:
    env.settings.deletion_domains = []  # конфигурация без доменов (например, локальный стенд)
    uid = await env.new_user()
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"confirm_word": "DELETE"})
    assert r.status_code == 202 and r.json()["domains"] == ["identity-consent"]
    assert (await _user(env, uid)).status == "DELETED"


async def test_bot_status_does_not_log_telegram_id(env) -> None:
    import io
    import logging

    from tilhero_common.logging import JsonFormatter

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


async def test_saga_race_duplicate_and_out_of_order_acks(env) -> None:
    """Ревью P7: ACK приходят дважды (повторная публикация домена и повторная доставка того же события),
    параллельно и в произвольном порядке — профиль обезличивается ровно один раз."""
    uid = await env.new_user()
    await env.set_pin(uid)
    request_id = (await env.call("POST", "/internal/v1/me/deletion-request", uid, {"pin": PIN})).json()["request_id"]
    first = [ack(uid, request_id, d) for d in DOMAINS]
    republished = [ack(uid, request_id, d) for d in reversed(DOMAINS)]  # новые event_id, тот же смысл
    spec = next(s for s in env.bus.specs if s.durable == "identity-consent.deletion_acks")
    await asyncio.gather(
        *[spec.handler(e) for e in first],
        *[spec.handler(e) for e in republished],
        *[spec.handler(e) for e in first],  # повторная доставка тех же событий (inbox)
    )
    await env.flush()
    req = await _request(env, uid)
    assert req.status == "COMPLETED" and sorted(req.acked_domains) == sorted(DOMAINS)
    assert (await _user(env, uid)).status == "DELETED"
    own = [e for e in env.bus.of_type("user.domain.deleted.v1") if e.producer == "identity-consent"]
    deleted = [e for e in await env.events("user.status.changed.v1", uid) if e.payload["status"] == "DELETED"]
    assert len(own) == 1 and len(deleted) == 1


async def test_ack_from_wrong_producer_is_ignored(env) -> None:
    uid = await env.new_user()
    request_id = (
        await env.call("POST", "/internal/v1/me/deletion-request", uid, {"confirm_word": "DELETE"})
    ).json()["request_id"]
    forged = make_envelope(
        "user.domain.deleted.v1",
        {"user_id": uid, "request_id": request_id, "domain": "support", "mode": "anonymized"},
        producer="preferences",  # домен «support» подтверждает не сам support
    )
    await env.bus.publish(forged)
    for d in ("preferences", "notifications", "offers", "recommendations", "watch", "news", "ai-concierge",
              "ai-control"):
        await env.bus.publish(ack(uid, request_id, d))
    await env.flush()
    req = await _request(env, uid)
    assert sorted(req.acked_domains) == ["ai-concierge", "ai-control", "news", "notifications", "offers",
                                         "preferences", "recommendations", "watch"]
    assert req.status == "REQUESTED"
    await env.bus.publish(ack(uid, request_id, "support", "anonymized"))
    assert (await _request(env, uid)).status == "COMPLETED"
