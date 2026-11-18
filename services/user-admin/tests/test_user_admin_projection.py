"""Проекция admin_user_summary из событий: контракты входящих событий, дедупликация, нарушенный порядок,
удаление, чужие производители."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import func, select
from user_admin_testkit import now

from tilhero_common.messaging import make_envelope
from tilhero_common.messaging.store import inbox_table
from tilhero_common.testing import assert_event_conforms
from tilhero_user_admin.models import MASK_NONE, TicketRef, UserSummary

ID = "identity-consent"


async def row(env, uid) -> UserSummary | None:
    async with env.runtime.transaction() as s:
        return await s.get(UserSummary, uuid.UUID(str(uid)))


def samples(uid: str) -> list:
    t = str(uuid.uuid4())
    req = str(uuid.uuid4())
    return [
        make_envelope("user.profile.created.v1", {"user_id": uid, "locale": "en", "created_at": now().isoformat()},
                      producer=ID),
        make_envelope("user.status.changed.v1", {"user_id": uid, "status": "DISABLED", "previous_status": "ACTIVE",
                                                 "reason_code": "user_disabled"}, producer=ID),
        make_envelope("consent.accepted.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "policy_version": "1.0",
                                              "purposes": ["personalization", "notifications"],
                                              "age_confirmed_18_plus": True}, producer=ID),
        make_envelope("consent.revoked.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "policy_version": "1.0"},
                      producer=ID),
        make_envelope("user.preferences.updated.v1", {"user_id": uid, "changed_fields": ["interests"],
                                                      "onboarding_completed": True}, producer="preferences"),
        make_envelope("user.security.changed.v1", {"user_id": uid, "change": "pin_set"}, producer=ID),
        make_envelope("support.ticket.created.v1", {"ticket_id": t, "number": "TCK-3001", "user_id": uid,
                                                    "category": "OTHER", "priority": "normal",
                                                    "has_event_context": False,
                                                    "sla_first_response_at": now().isoformat()}, producer="support"),
        make_envelope("support.ticket.status.changed.v1", {"ticket_id": t, "number": "TCK-3001", "user_id": uid,
                                                           "from_status": "NEW", "to_status": "IN_PROGRESS",
                                                           "changed_by": "operator"}, producer="support"),
        make_envelope("user.deletion.requested.v1", {"user_id": uid, "request_id": req,
                                                     "requested_at": now().isoformat()}, producer=ID),
        make_envelope("user.domain.deleted.v1", {"user_id": uid, "request_id": req, "domain": ID,
                                                 "mode": "anonymized"}, producer=ID),
        # спринт 9 (ADR-009): «удаление зависло» — в test_user_admin_deletion_stuck.py
        make_envelope("user.deletion.stuck.v1", {"request_id": req, "user_id": uid, "requested_at": now().isoformat(),
                                                 "stuck_at": now().isoformat(), "pending_domains": ["watch"],
                                                 "attempts": 6}, producer=ID),
    ]


def test_consumed_event_examples_conform_to_contracts() -> None:
    from tilhero_user_admin.domain.projection import EVENT_TYPES

    examples = samples(str(uuid.uuid4()))
    # user.access_level.changed.v1 (спринт 7, ai-control) — test_user_admin_access_level.py
    assert sorted({e.event_type for e in examples}) == sorted(set(EVENT_TYPES) - {"user.access_level.changed.v1"})
    for e in examples:
        assert_event_conforms(e)


async def test_full_lifecycle_from_events(env) -> None:
    uid = str(uuid.uuid4())
    events = samples(uid)
    for e in events[:8]:
        await env.deliver(e)
    r = await row(env, uid)
    assert r is not None and r.profile_known and r.locale == "en"
    assert r.status == "DISABLED"
    assert r.consent_policy_version == "1.0" and r.consent_revoked_at is not None
    assert r.consent_purposes == ["personalization", "notifications"] and r.age_confirmed_18_plus
    assert r.onboarding_completed and r.preferences_changed_fields == ["interests"]
    assert r.pin_enabled and not r.biometric_enabled
    assert (r.open_tickets, r.tickets_total) == (1, 1)

    await env.deliver(events[8])
    assert (await row(env, uid)).status == "DELETION_REQUESTED"
    await env.deliver(events[9])
    r = await row(env, uid)
    assert r.status == "DELETED" and r.username is None and r.display_name is None and r.erased_at
    assert r.telegram_id_masked == MASK_NONE and (r.open_tickets, r.tickets_total) == (0, 0)
    async with env.runtime.transaction() as s:
        ref = (await s.execute(select(TicketRef))).scalar_one()
    assert ref.user_id is None and ref.anonymized  # TCK-поиск больше не ведёт к удалённому

    # поздние события ничего не возвращают
    await env.emit("user.status.changed.v1", {"user_id": uid, "status": "ACTIVE", "previous_status": "DISABLED"},
                   producer=ID, occurred_at=now() + timedelta(minutes=5))
    await env.emit("support.ticket.created.v1", {"ticket_id": str(uuid.uuid4()), "number": "TCK-3002",
                                                 "user_id": uid, "category": "OTHER", "priority": "normal"},
                   producer="support")
    r = await row(env, uid)
    assert r.status == "DELETED" and (r.open_tickets, r.tickets_total) == (0, 0)


async def test_inbox_deduplicates_redelivery(env) -> None:
    uid = str(uuid.uuid4())
    created = make_envelope("support.ticket.created.v1", {"ticket_id": str(uuid.uuid4()), "number": "TCK-3100",
                                                          "user_id": uid, "category": "OTHER", "priority": "normal"},
                            producer="support")
    await env.deliver(created, times=3)
    consent = make_envelope("consent.accepted.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()),
                                                    "policy_version": "1.0", "purposes": ["personalization"]},
                            producer=ID)
    await env.deliver(consent, times=2)
    async with env.runtime.transaction() as s:
        processed = (await s.execute(select(func.count()).select_from(inbox_table))).scalar_one()
        refs = (await s.execute(select(func.count()).select_from(TicketRef))).scalar_one()
    assert processed == 2 and refs == 1
    r = await row(env, uid)
    assert (r.open_tickets, r.tickets_total) == (1, 1)


async def test_out_of_order_does_not_roll_back(env) -> None:
    uid = str(uuid.uuid4())
    t0 = now()
    # статус: DISABLED (t2) пришёл раньше ACTIVE (t1)
    await env.emit("user.status.changed.v1", {"user_id": uid, "status": "DISABLED", "previous_status": "ACTIVE"},
                   producer=ID, occurred_at=t0 + timedelta(seconds=2))
    await env.emit("user.status.changed.v1", {"user_id": uid, "status": "ACTIVE", "previous_status": "DISABLED"},
                   producer=ID, occurred_at=t0 + timedelta(seconds=1))
    # профиль пришёл последним: предварительный created_at заменяется, статус не откатывается
    created_at = t0 - timedelta(days=3)
    await env.emit("user.profile.created.v1", {"user_id": uid, "locale": "ru", "created_at": created_at.isoformat()},
                   producer=ID, occurred_at=created_at)
    r = await row(env, uid)
    assert r.status == "DISABLED" and r.created_at == created_at and r.profile_known

    # безопасность: biometric_enabled (t4) раньше pin_set (t3) — оба поля включены
    await env.emit("user.security.changed.v1", {"user_id": uid, "change": "biometric_enabled"}, producer=ID,
                   occurred_at=t0 + timedelta(seconds=4))
    await env.emit("user.security.changed.v1", {"user_id": uid, "change": "pin_set"}, producer=ID,
                   occurred_at=t0 + timedelta(seconds=3))
    r = await row(env, uid)
    assert r.pin_enabled and r.biometric_enabled
    # старое снятие PIN (t2.5) не перекрывает новые включения
    await env.emit("user.security.changed.v1", {"user_id": uid, "change": "pin_removed"}, producer=ID,
                   occurred_at=t0 + timedelta(seconds=2, milliseconds=500))
    r = await row(env, uid)
    assert r.pin_enabled and r.biometric_enabled

    # согласие: отзыв (t6) раньше принятия (t5)
    await env.emit("consent.revoked.v1", {"user_id": uid, "consent_id": str(uuid.uuid4())}, producer=ID,
                   occurred_at=t0 + timedelta(seconds=6))
    await env.emit("consent.accepted.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "policy_version": "1.0",
                                           "purposes": ["personalization"]}, producer=ID,
                   occurred_at=t0 + timedelta(seconds=5))
    r = await row(env, uid)
    assert r.consent_revoked_at is not None

    # обращение: CLOSED (t9) раньше IN_PROGRESS (t8), а created — последним
    tid = str(uuid.uuid4())
    base = {"ticket_id": tid, "number": "TCK-3200", "user_id": uid}
    await env.emit("support.ticket.status.changed.v1", {**base, "from_status": "RESOLVED", "to_status": "CLOSED",
                                                        "changed_by": "user"}, producer="support",
                   occurred_at=t0 + timedelta(seconds=9))
    await env.emit("support.ticket.status.changed.v1", {**base, "from_status": "NEW", "to_status": "IN_PROGRESS",
                                                        "changed_by": "operator"}, producer="support",
                   occurred_at=t0 + timedelta(seconds=8))
    await env.emit("support.ticket.created.v1", {**base, "category": "OTHER", "priority": "normal"},
                   producer="support", occurred_at=t0 + timedelta(seconds=7))
    r = await row(env, uid)
    assert (r.open_tickets, r.tickets_total) == (0, 1)

    # онбординг: старое «не завершён» не откатывает «завершён»
    await env.emit("user.preferences.updated.v1", {"user_id": uid, "changed_fields": ["onboarding"],
                                                   "onboarding_completed": True}, producer="preferences",
                   occurred_at=t0 + timedelta(seconds=11))
    await env.emit("user.preferences.updated.v1", {"user_id": uid, "changed_fields": ["interests"],
                                                   "onboarding_completed": False}, producer="preferences",
                   occurred_at=t0 + timedelta(seconds=10))
    r = await row(env, uid)
    assert r.onboarding_completed and r.preferences_changed_fields == ["onboarding"]


async def test_anonymized_ticket_is_unlinked(env) -> None:
    uid = str(uuid.uuid4())
    tid = str(uuid.uuid4())
    await env.emit("user.profile.created.v1", {"user_id": uid, "created_at": now().isoformat()}, producer=ID)
    await env.emit("support.ticket.created.v1", {"ticket_id": tid, "number": "TCK-3300", "user_id": uid,
                                                 "category": "OTHER", "priority": "normal"}, producer="support")
    # support обезличил обращение (user_id → null) и закрыл
    await env.emit("support.ticket.status.changed.v1", {"ticket_id": tid, "number": "TCK-3300", "user_id": None,
                                                        "from_status": "NEW", "to_status": "CLOSED",
                                                        "changed_by": "system"}, producer="support")
    r = await row(env, uid)
    assert (r.open_tickets, r.tickets_total) == (0, 0)
    # запоздавшее событие с user_id связь не восстанавливает
    await env.emit("support.ticket.status.changed.v1", {"ticket_id": tid, "number": "TCK-3300", "user_id": uid,
                                                        "from_status": "NEW", "to_status": "IN_PROGRESS",
                                                        "changed_by": "operator"}, producer="support",
                   occurred_at=now() - timedelta(minutes=1))
    r = await row(env, uid)
    assert (r.open_tickets, r.tickets_total) == (0, 0)


@pytest.mark.parametrize(("event_type", "payload", "producer"), [
    ("user.status.changed.v1", {"status": "DISABLED", "previous_status": "ACTIVE"}, "support"),
    ("consent.accepted.v1", {"consent_id": "c", "policy_version": "1.0", "purposes": []}, "preferences"),
    ("user.domain.deleted.v1", {"request_id": "r", "domain": "identity-consent", "mode": "deleted"}, "support"),
    ("user.preferences.updated.v1", {"changed_fields": ["x"], "onboarding_completed": True}, "identity-consent"),
])
async def test_events_from_foreign_producers_are_ignored(env, event_type, payload, producer) -> None:
    uid = str(uuid.uuid4())
    await env.emit(event_type, {"user_id": uid, **payload}, producer=producer)
    assert await row(env, uid) is None


async def test_other_domain_acks_and_malformed_events_are_ignored(env) -> None:
    uid = str(uuid.uuid4())
    await env.emit("user.profile.created.v1", {"user_id": uid, "created_at": now().isoformat()}, producer=ID)
    await env.emit("user.domain.deleted.v1", {"user_id": uid, "request_id": str(uuid.uuid4()), "domain": "support",
                                              "mode": "anonymized"}, producer="support")
    assert (await row(env, uid)).status == "ACTIVE"
    await env.emit("user.status.changed.v1", {"user_id": "not-a-uuid", "status": "DISABLED"}, producer=ID)
    await env.emit("support.ticket.created.v1", {"ticket_id": str(uuid.uuid4()), "number": "garbage",
                                                 "user_id": uid}, producer="support")
    await env.emit("user.status.changed.v1", {"user_id": uid, "status": "HACKED", "previous_status": "ACTIVE"},
                   producer=ID)
    r = await row(env, uid)
    assert r.status == "ACTIVE" and r.tickets_total == 0


async def test_ticket_number_collision_is_skipped_not_retried(env) -> None:
    uid = str(uuid.uuid4())
    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    base = {"number": "TCK-5001", "user_id": uid, "category": "OTHER", "priority": "normal"}
    await env.emit("support.ticket.created.v1", {**base, "ticket_id": first}, producer="support")
    # другой ticket_id с тем же номером (пересозданная БД support) — обработчик не падает
    await env.emit("support.ticket.created.v1", {**base, "ticket_id": second}, producer="support")
    await env.emit("support.ticket.status.changed.v1", {**base, "ticket_id": second, "from_status": "NEW",
                                                        "to_status": "CLOSED", "changed_by": "operator"},
                   producer="support")
    async with env.runtime.transaction() as s:
        refs = (await s.execute(select(TicketRef))).scalars().all()
    assert [(str(r.ticket_id), r.status) for r in refs] == [(first, "NEW")]
