"""Запрос удаления, ACK доменов (user.domain.deleted.v1), обезличивание, повторная регистрация; удаление детских
профилей вместе с аккаунтом родителя (AT-14); обратимость миграций."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from conftest import DOMAINS, REQUIRED
from deletion_kit import CONFIRM, ack, request_of
from sqlalchemy import func, select, text

from tilhero_common.messaging import make_envelope
from tilhero_common.messaging.store import inbox_table
from tilhero_identity.models import (
    BiometricCredential,
    Consent,
    DeletionRequest,
    GuardianLink,
    PinCredential,
)

PIN = "2580"
SERVICE_DIR = Path(__file__).resolve().parents[1]


# ---------- запрос удаления ----------


async def test_deletion_request_with_confirm_word(env) -> None:
    uid = await env.new_user()
    for body in ({}, {"confirm_word": "удали"}, {"confirm_word": "yes"}, {"confirm_word": "DELETE"}, {"pin": PIN}):
        r = await env.call("POST", "/internal/v1/me/deletion-request", uid, body)
        assert r.status_code == 422 and r.json()["code"] == "DELETION_CONFIRMATION_REQUIRED", body
        assert r.json()["details"] == {"method": "confirm_word"}
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"confirm_word": " удалить "})
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["status"] == "REQUESTED" and body["domains"] == [*DOMAINS, "identity-consent"]
    assert body["learners"] == 1
    uuid.UUID(body["request_id"])

    # повтор — тот же запрос, без новых событий
    again = await env.call("POST", "/internal/v1/me/deletion-request", uid, {})
    assert again.status_code == 202 and again.json() == body

    me = (await env.call("GET", "/internal/v1/me", uid)).json()
    assert me["user"]["status"] == "DELETION_REQUESTED" and me["settings"]["enabled"] is False
    [requested] = await env.events("user.deletion.requested.v1", uid)
    assert requested.payload["request_id"] == body["request_id"]
    assert requested.payload["requested_at"].endswith("Z")
    [status] = await env.events("user.status.changed.v1", uid)
    assert status.payload == {
        "user_id": uid,
        "status": "DELETION_REQUESTED",
        "previous_status": "ACTIVE",
        "reason_code": "deletion_requested",
    }

    # после запроса удаления профиль не меняется
    for method, path, payload in (
        ("PATCH", "/internal/v1/me/settings", {"locale": "uz"}),
        ("PUT", "/internal/v1/me/age", {"age_band": "18+"}),
        ("POST", "/internal/v1/me/learners", {"display_name": "Мадина", "age_band": "6-9"}),
        ("POST", "/internal/v1/me/guardian-consent-requests", None),
        ("PUT", "/internal/v1/me/pin", {"pin": PIN}),
        ("POST", "/internal/v1/me/consent", {"policy_version": "1.1", "purposes": REQUIRED}),
        ("DELETE", "/internal/v1/me/consent", None),
        ("POST", "/internal/v1/me/enable", None),
        ("POST", "/internal/v1/me/disable", None),
        ("PUT", "/internal/v1/me/biometric", None),
    ):
        r = await env.call(method, path, uid, payload)
        assert r.status_code == 409 and r.json()["code"] == "USER_DELETION_REQUESTED", path


@pytest.mark.parametrize("word", ["OʻCHIRISH", "o'chirish", "O‘chirish", "  oʼchirish "])
async def test_deletion_confirm_word_uz(env, word) -> None:
    uid = await env.new_user(language_code="uz")
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"confirm_word": word})
    assert r.status_code == 202, r.text


async def test_deletion_request_with_pin(env) -> None:
    uid = await env.new_user()
    await env.set_pin(uid)
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, CONFIRM)
    assert r.status_code == 422 and r.json()["details"] == {"method": "pin"}
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"pin": "1357"})
    assert r.status_code == 401 and r.json()["code"] == "PIN_INVALID" and r.json()["details"] == {"remaining": 4}
    assert (await env.user_row(uid)).status == "ACTIVE"
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"pin": PIN})
    assert r.status_code == 202
    for body in ({"pin": "1" * 17}, {"confirm_word": "x" * 33}, {"pin": PIN, "reason": "x"}):
        assert (await env.call("POST", "/internal/v1/me/deletion-request", uid, body)).status_code == 422


async def test_disabled_user_can_request_deletion(env) -> None:
    uid = await env.new_user()
    await env.call("POST", "/internal/v1/me/disable", uid)
    assert (await env.call("POST", "/internal/v1/me/deletion-request", uid, CONFIRM)).status_code == 202
    [ev] = [e for e in await env.events("user.status.changed.v1", uid) if e.payload["status"] == "DELETION_REQUESTED"]
    assert ev.payload["previous_status"] == "DISABLED"


# ---------- ACK доменов и обезличивание ----------


async def test_full_deletion_cycle_and_reregistration(env) -> None:
    tg = 7_000_123_456
    login = await env.login(tg, username="demo_user", first_name="Тест", last_name="Маска")
    uid = login["user"]["user_id"]
    await env.set_age(uid, "18+")
    await env.consent(uid)
    await env.set_pin(uid)
    await env.call("PUT", "/internal/v1/me/biometric", uid)
    request_id = (await env.call("POST", "/internal/v1/me/deletion-request", uid, {"pin": PIN})).json()["request_id"]

    first = ack(uid, request_id, "learning-plan")
    await env.bus.publish(first)
    # повторная доставка того же события в обработчик (как при redelivery JetStream после сбоя ack)
    [consumer] = [spec for spec in env.bus.specs if spec.durable == "identity-consent.deletion_acks"]
    await consumer.handler(first)
    await consumer.handler(first)
    await env.bus.publish(ack(uid, request_id, "support", "anonymized"))
    # чужие/лишние подтверждения игнорируются
    await env.bus.publish(ack(uid, str(uuid.uuid4()), "notifications"))
    await env.bus.publish(ack(str(uuid.uuid4()), request_id, "notifications"))
    await env.bus.publish(ack(uid, request_id, "preferences"))  # не домен удаления TilHero
    await env.flush()

    req = await request_of(env, uid)
    assert req.status == "REQUESTED" and sorted(req.acked_domains) == ["learning-plan", "support"]
    assert (await env.user_row(uid)).telegram_user_id == tg
    assert env.bus.dlq == []

    # повтор той же доставки обработан один раз (inbox)
    async with env.runtime.transaction() as s:
        seen = (
            await s.execute(
                select(func.count()).select_from(inbox_table).where(inbox_table.c.event_id == first.event_id)
            )
        ).scalar_one()
    assert seen == 1

    # спринт 3: контент и диагностика; спринт 4: уроки, оценки, ai-gateway (обезличивает учёт вызовов); спринт 5:
    # memory (карточки, история планирования, проверки, попытки произношения)
    for d in ("notifications", "social", "catalog", "diagnostics", "lessons", "assessment", "ai-gateway", "memory"):
        await env.bus.publish(ack(uid, request_id, d, "anonymized" if d in ("catalog", "ai-gateway") else "deleted"))
    await env.flush()
    # без experience-config (отметки просмотра «Что нового») профиль не обезличивается
    req = await request_of(env, uid)
    assert req.status == "REQUESTED" and "experience-config" not in req.acked_domains
    assert (await env.user_row(uid)).telegram_user_id == tg
    await env.bus.publish(ack(uid, request_id, "experience-config"))
    await env.flush()

    user = await env.user_row(uid)
    assert user.status == "DELETED" and user.telegram_user_id is None
    assert user.username is None and user.display_name is None and user.notifications_enabled is False
    assert user.age_band is None
    req = await request_of(env, uid)
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

    # удалённый пользователь недоступен ни клиенту, ни для доставки, ни social
    assert (await env.call("GET", "/internal/v1/me", uid)).status_code == 404
    assert (await env.delivery(uid)).status_code == 404
    assert (await env.call("GET", f"/internal/v1/users/{uid}/public", None, issuer="social")).status_code == 404
    # поздний ACK после завершения — без побочных эффектов
    await env.bus.publish(ack(uid, request_id, "learning-plan"))
    await env.flush()
    assert len([e for e in env.bus.of_type("user.domain.deleted.v1") if e.producer == "identity-consent"]) == 1

    # тот же Telegram ID снова открывает TilHero → новый профиль с чистого листа
    fresh = await env.login(tg, first_name="Тест")
    assert fresh["user"]["user_id"] != uid and fresh["user"]["is_new"] is True
    assert fresh["user"]["status"] == "ACTIVE" and fresh["consent"]["accepted"] is False
    assert fresh["user"]["age_band"] is None and fresh["security"]["pin_enabled"] is False
    created = await env.events("user.profile.created.v1")
    assert [e.payload["user_id"] for e in created] == [uid, fresh["user"]["user_id"]]


async def test_account_deletion_deletes_children(env) -> None:
    """AT-14: удаление аккаунта родителя удаляет и детские профили — отдельный request_id на каждого ученика."""
    tg = 7_000_222_333
    guardian = await env.adult(telegram_user_id=tg)
    kids = [(await env.child(guardian, name))["learner_id"] for name in ("Мадина", "Тимур")]
    r = await env.call("POST", "/internal/v1/me/deletion-request", guardian, CONFIRM)
    assert r.status_code == 202
    body = r.json()
    assert body["learners"] == 3 and body["domains"] == [*DOMAINS, "identity-consent"]
    again = await env.call("POST", "/internal/v1/me/deletion-request", guardian, CONFIRM)
    assert again.json() == body

    parent_req = await request_of(env, guardian)
    child_reqs = {k: await request_of(env, k) for k in kids}
    assert str(parent_req.request_id) == body["request_id"]
    assert all(req.parent_request_id == parent_req.request_id for req in child_reqs.values())
    assert len({req.request_id for req in child_reqs.values()}) == 2
    requested = await env.events("user.deletion.requested.v1")
    assert sorted(e.payload["user_id"] for e in requested) == sorted([guardian, *kids])
    for k in kids:
        [st] = await env.events("user.status.changed.v1", k)
        assert (st.payload["status"], st.payload["reason_code"]) == ("DELETION_REQUESTED",
                                                                      "guardian_deletion_requested")
        assert (await env.user_row(k)).status == "DELETION_REQUESTED"
    # дети ушли из списка учеников и из адресации
    assert (await env.call("GET", "/internal/v1/me/learners", guardian)).json()["items"][1:] == []
    assert (await env.delivery(kids[0])).json()["status"] == "DELETION_REQUESTED"

    # каждый ученик проходит сагу сам: ACK аккаунта не обезличивает детей и наоборот
    for d in DOMAINS:
        await env.bus.publish(ack(guardian, str(parent_req.request_id), d))
    await env.flush()
    assert (await env.user_row(guardian)).status == "DELETED"
    assert [(await env.user_row(k)).status for k in kids] == ["DELETION_REQUESTED"] * 2
    for k, req in child_reqs.items():
        for d in DOMAINS:
            await env.bus.publish(ack(k, str(req.request_id), d))
    await env.flush()
    for k in kids:
        row = await env.user_row(k)
        assert (row.status, row.display_name, row.age_band) == ("DELETED", None, None)
        assert (await request_of(env, k)).status == "COMPLETED"
    async with env.runtime.transaction() as s:
        assert (await s.execute(select(func.count()).select_from(GuardianLink))).scalar_one() == 0
        child_consents = list((await s.execute(
            select(Consent).where(Consent.user_id.in_([uuid.UUID(k) for k in kids])))).scalars())
    assert [c.revoke_reason for c in child_consents] == ["deletion", "deletion"]
    own = [e.payload["user_id"] for e in env.bus.of_type("user.domain.deleted.v1") if e.producer == "identity-consent"]
    assert sorted(own) == sorted([guardian, *kids])
    assert (await env.delivery(kids[0])).status_code == 404


async def test_anonymization_waits_for_all_domains_in_any_order(env) -> None:
    uid = await env.new_user()
    request_id = (await env.call("POST", "/internal/v1/me/deletion-request", uid, CONFIRM)).json()["request_id"]
    await asyncio.gather(*[env.bus.publish(ack(uid, request_id, d)) for d in reversed(DOMAINS)])
    await env.flush()
    assert (await env.user_row(uid)).status == "DELETED"
    assert len([e for e in env.bus.of_type("user.domain.deleted.v1") if e.producer == "identity-consent"]) == 1


async def test_own_and_malformed_acks_are_ignored(env) -> None:
    uid = await env.new_user()
    request_id = (await env.call("POST", "/internal/v1/me/deletion-request", uid, CONFIRM)).json()["request_id"]
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
    req = await request_of(env, uid)
    assert req.acked_domains == [] and req.status == "REQUESTED"


async def test_ack_from_wrong_producer_is_ignored(env) -> None:
    uid = await env.new_user()
    request_id = (await env.call("POST", "/internal/v1/me/deletion-request", uid, CONFIRM)).json()["request_id"]
    forged = make_envelope(
        "user.domain.deleted.v1",
        {"user_id": uid, "request_id": request_id, "domain": "support", "mode": "anonymized"},
        producer="learning-plan",  # домен «support» подтверждает не сам support
    )
    await env.bus.publish(forged)
    for d in DOMAINS:
        if d != "support":
            await env.bus.publish(ack(uid, request_id, d))
    await env.flush()
    req = await request_of(env, uid)
    assert sorted(req.acked_domains) == sorted(d for d in DOMAINS if d != "support")
    assert req.status == "REQUESTED"
    await env.bus.publish(ack(uid, request_id, "support", "anonymized"))
    assert (await request_of(env, uid)).status == "COMPLETED"


async def test_saga_race_duplicate_and_out_of_order_acks(env) -> None:
    """ACK приходят дважды (повторная публикация домена и повторная доставка того же события), параллельно и в
    произвольном порядке — профиль обезличивается ровно один раз."""
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
    req = await request_of(env, uid)
    assert req.status == "COMPLETED" and sorted(req.acked_domains) == sorted(DOMAINS)
    assert (await env.user_row(uid)).status == "DELETED"
    own = [e for e in env.bus.of_type("user.domain.deleted.v1") if e.producer == "identity-consent"]
    deleted = [e for e in await env.events("user.status.changed.v1", uid) if e.payload["status"] == "DELETED"]
    assert len(own) == 1 and len(deleted) == 1


async def test_no_expected_domains_anonymizes_immediately(env) -> None:
    env.settings.deletion_domains = []  # конфигурация без доменов (например, локальный стенд)
    guardian = await env.adult()
    child = await env.child(guardian)
    r = await env.call("POST", "/internal/v1/me/deletion-request", guardian, CONFIRM)
    assert r.status_code == 202 and r.json()["domains"] == ["identity-consent"] and r.json()["learners"] == 2
    assert (await env.user_row(guardian)).status == "DELETED"
    assert (await env.user_row(child["learner_id"])).status == "DELETED"


# ---------- миграции ----------


async def test_migrations_are_reversible(env) -> None:
    cfg = Config(str(SERVICE_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVICE_DIR / "migrations"))
    cfg.attributes["settings"] = env.settings
    await env.runtime.db.dispose()  # отпускаем соединения пула перед DDL

    async def tables() -> list[str]:
        async with env.runtime.transaction() as s:
            return list((await s.execute(
                text("SELECT table_name FROM information_schema.tables WHERE table_schema = :s ORDER BY 1"),
                {"s": env.schema},
            )).scalars().all())

    await asyncio.to_thread(command.downgrade, cfg, "base")
    assert await tables() == ["alembic_version"]
    await asyncio.to_thread(command.upgrade, cfg, "head")
    assert await tables() == [
        "alembic_version",
        "biometric_credentials",
        "consents",
        "deletion_attempts",
        "deletion_domain_acks",
        "deletion_requests",
        "guardian_consent_requests",
        "guardian_links",
        "inbox",
        "learner_activity",
        "outbox",
        "pin_credentials",
        "users",
    ]
    async with env.runtime.transaction() as s:
        assert (await s.execute(select(func.count()).select_from(DeletionRequest))).scalar_one() == 0
