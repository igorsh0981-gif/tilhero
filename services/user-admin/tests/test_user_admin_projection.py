"""Проекция admin_learner_summary из событий: контракты входящих событий (как их реально публикуют identity-consent,
learning-plan и support), дедупликация, нарушенный порядок, аккаунт и детский профиль, план и график, удаление,
чужие производители."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import func, select
from user_admin_testkit import ID, LP, iso, now, snapshot

from tilhero_common.messaging import make_envelope
from tilhero_common.messaging.store import inbox_table
from tilhero_common.testing import assert_event_conforms
from tilhero_user_admin.domain.projection import EVENT_TYPES
from tilhero_user_admin.models import LearnerSummary, TicketRef


async def row(env, uid) -> LearnerSummary | None:
    async with env.runtime.transaction() as s:
        return await s.get(LearnerSummary, uuid.UUID(str(uid)))


def plan_payload(uid: str, **kw) -> dict:
    """Payload learning.plan.updated.v1 как в learning-plan domain/plans.py _event_payload."""
    base = {"user_id": uid, "changed_fields": ["goal", "level_self", "preset", "days", "preferred_time",
                                               "reminders_enabled"],
            "goal": "travel", "ui_lang": "uz", "course_pair": "ru-en", "timezone": "Asia/Tashkent",
            "days": [1, 3, 5], "preferred_time": "07:30", "duration_min": 15, "reminders_enabled": True,
            "onboarding_completed": False}
    base.update(kw)
    return base


def samples(uid: str, guardian: str) -> list:
    """По одному примеру каждого потребляемого события — формы издателей (service.py identity-consent и т.д.)."""
    t = str(uuid.uuid4())
    req = str(uuid.uuid4())
    return [
        make_envelope("user.profile.created.v1", {"user_id": uid, "kind": "child", "locale": "uz", "age_band": "6-9",
                                                  "guardian_user_id": guardian, "created_at": iso(now())},
                      producer=ID),
        make_envelope("user.profile.updated.v1", {"user_id": uid, "changed_fields": ["display_name"],
                                                  "age_band": "10-13", "is_minor": True, "locale": "uz",
                                                  "guardian_consent": "not_required"}, producer=ID),
        make_envelope("user.status.changed.v1", {"user_id": uid, "status": "DISABLED", "previous_status": "ACTIVE",
                                                 "reason_code": "user_disabled"}, producer=ID),
        make_envelope("consent.accepted.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "policy_version": "1.0",
                                              "purposes": ["terms", "privacy"], "age_band": "6-9", "basis": "guardian",
                                              "granted_by_user_id": guardian}, producer=ID),
        make_envelope("consent.revoked.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "policy_version": "1.0",
                                             "basis": "guardian", "revoked_by_user_id": guardian}, producer=ID),
        make_envelope("user.notification_settings.changed.v1", {"user_id": uid, "enabled": True,
                                                                "categories": ["support", "reminders"]}, producer=ID),
        make_envelope("user.security.changed.v1", {"user_id": uid, "change": "pin_reset_requested"}, producer=ID),
        make_envelope("learning.plan.updated.v1", plan_payload(uid), producer=LP),
        make_envelope("learning.activity.recorded.v1", {"user_id": uid, "activity_id": str(uuid.uuid4()),
                                                        "local_date": "2026-11-18", "kind": "practice", "minutes": 10,
                                                        "recorded_at": iso(now())}, producer=LP),
        make_envelope("support.ticket.created.v1", {"ticket_id": t, "number": "TCK-3001", "user_id": uid,
                                                    "category": "other", "priority": "normal",
                                                    "sla_first_response_at": iso(now())}, producer="support"),
        make_envelope("support.ticket.status.changed.v1", {"ticket_id": t, "number": "TCK-3001", "user_id": uid,
                                                           "from_status": "NEW", "to_status": "IN_PROGRESS",
                                                           "changed_by": "operator"}, producer="support"),
        make_envelope("user.deletion.requested.v1", {"user_id": uid, "request_id": req, "requested_at": iso(now()),
                                                     "attempt": 1}, producer=ID),
        make_envelope("user.domain.deleted.v1", {"user_id": uid, "request_id": req, "domain": ID,
                                                 "mode": "anonymized"}, producer=ID),
        # спринт 8: тариф ученика (billing)
        make_envelope("billing.access.changed.v1", {"user_id": uid, "account_id": guardian, "tier": "paid",
                                                    "features": ["ai_lessons", "pair_lessons"],
                                                    "paid_until": iso(now() + timedelta(days=30)),
                                                    "changed_at": iso(now())}, producer="billing"),
    ]


def test_consumed_event_examples_conform_to_contracts() -> None:
    examples = samples(str(uuid.uuid4()), str(uuid.uuid4()))
    assert sorted({e.event_type for e in examples}) == sorted(EVENT_TYPES)
    for e in examples:
        assert_event_conforms(e)


async def test_full_lifecycle_of_child_profile_from_events(env) -> None:
    uid, guardian = str(uuid.uuid4()), str(uuid.uuid4())
    events = samples(uid, guardian)
    for e in events[:11]:
        await env.deliver(e)
    r = await row(env, uid)
    assert r is not None and r.profile_known and r.kind == "child" and str(r.guardian_user_id) == guardian
    assert r.locale == "uz" and r.age_band == "10-13" and r.status == "DISABLED"
    assert r.username is None and r.telegram_id_masked is None
    assert r.consent["basis"] == "guardian" and r.consent["purposes"] == ["terms", "privacy"]
    assert r.consent["revoked_at"] is not None and r.consent["policy_version"] == "1.0"
    assert r.notifications == {"enabled": True, "categories": {"reminders": True, "missed": False, "social": False,
                                                               "support": True, "product": False, "game": False}}
    assert r.security == {"pin_enabled": False, "pin_reset_pending": True}
    assert r.goal == "travel" and r.reminders_enabled and not r.onboarding_completed
    assert r.plan["schedule"] == {"preset": "three_per_week", "days": [1, 3, 5], "preferred_time": "07:30",
                                  "duration_min": 15, "reminders_enabled": True, "timezone": "Asia/Tashkent"}
    assert r.plan["ui_lang"] == "uz" and r.plan["level_self"] is None  # уровень — только из сверки
    assert r.last_activity_at is not None
    assert (r.open_tickets, r.tickets_total) == (1, 1)

    await env.deliver(events[11])
    assert (await row(env, uid)).status == "DELETION_REQUESTED"
    await env.deliver(events[12])
    r = await row(env, uid)
    assert r.status == "DELETED" and r.erased_at is not None
    assert (r.display_name, r.username, r.telegram_id_masked, r.search_text, r.guardian_user_id) == (None,) * 5
    assert r.plan is None and r.notifications is None and r.goal is None and r.last_activity_at is None
    assert (r.open_tickets, r.tickets_total) == (0, 0)
    async with env.runtime.transaction() as s:
        ref = (await s.execute(select(TicketRef))).scalar_one()
    assert ref.user_id is None and ref.anonymized  # TCK-поиск больше не ведёт к удалённому

    # поздние события ничего не возвращают
    await env.emit("user.status.changed.v1", {"user_id": uid, "status": "ACTIVE", "previous_status": "DISABLED"},
                   producer=ID, occurred_at=now() + timedelta(minutes=5))
    await env.emit("learning.plan.updated.v1", plan_payload(uid), producer=LP, occurred_at=now() + timedelta(minutes=5))
    await env.emit("support.ticket.created.v1", {"ticket_id": str(uuid.uuid4()), "number": "TCK-3002",
                                                 "user_id": uid, "category": "other", "priority": "normal"},
                   producer="support")
    r = await row(env, uid)
    assert r.status == "DELETED" and r.plan is None and (r.open_tickets, r.tickets_total) == (0, 0)


async def test_account_profile_and_status_events(env) -> None:
    uid = str(uuid.uuid4())
    created = now() - timedelta(days=2)
    await env.emit("user.profile.created.v1", {"user_id": uid, "kind": "account", "locale": "ru", "age_band": None,
                                               "guardian_user_id": None, "created_at": iso(created)}, producer=ID)
    r = await row(env, uid)
    assert r.kind == "account" and r.guardian_user_id is None and r.created_at == created and r.age_band is None
    # подросток выбрал возраст, родитель дал согласие
    await env.emit("user.profile.updated.v1", {"user_id": uid, "changed_fields": ["age_band"], "age_band": "14-17",
                                               "is_minor": True, "locale": "ru", "guardian_consent": "pending"},
                   producer=ID)
    await env.emit("user.profile.updated.v1", {"user_id": uid, "changed_fields": ["guardian_consent"],
                                               "age_band": "14-17", "is_minor": True, "locale": "uz",
                                               "guardian_consent": "granted"}, producer=ID)
    r = await row(env, uid)
    assert (r.age_band, r.guardian_consent, r.locale) == ("14-17", "granted", "uz")
    # неизвестные значения не ломают строку
    await env.emit("user.profile.updated.v1", {"user_id": uid, "changed_fields": ["locale"], "locale": "en",
                                               "age_band": "99+", "guardian_consent": "maybe"}, producer=ID)
    r = await row(env, uid)
    assert (r.age_band, r.guardian_consent, r.locale) == (None, "granted", None)


async def test_inbox_deduplicates_redelivery(env) -> None:
    uid = str(uuid.uuid4())
    created = make_envelope("support.ticket.created.v1", {"ticket_id": str(uuid.uuid4()), "number": "TCK-3100",
                                                          "user_id": uid, "category": "other", "priority": "normal"},
                            producer="support")
    await env.deliver(created, times=3)
    activity = make_envelope("learning.activity.recorded.v1", {
        "user_id": uid, "activity_id": str(uuid.uuid4()), "local_date": "2026-11-18", "kind": "lesson",
        "minutes": 5, "recorded_at": iso(now())}, producer=LP)
    await env.deliver(activity, times=2)
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
    await env.emit("user.profile.created.v1", {"user_id": uid, "kind": "account", "locale": "ru",
                                               "created_at": iso(created_at)}, producer=ID, occurred_at=created_at)
    r = await row(env, uid)
    assert r.status == "DISABLED" and r.created_at == created_at and r.profile_known

    # возраст: новое значение (t4) раньше старого (t3)
    await env.emit("user.profile.updated.v1", {"user_id": uid, "changed_fields": ["age_band"], "age_band": "18+",
                                               "locale": "ru"}, producer=ID, occurred_at=t0 + timedelta(seconds=4))
    await env.emit("user.profile.updated.v1", {"user_id": uid, "changed_fields": ["age_band"], "age_band": "14-17",
                                               "locale": "ru"}, producer=ID, occurred_at=t0 + timedelta(seconds=3))
    assert (await row(env, uid)).age_band == "18+"

    # безопасность: запрос сброса (t6) раньше установки PIN (t5) — оба поля включены; старое снятие не перекрывает
    await env.emit("user.security.changed.v1", {"user_id": uid, "change": "pin_reset_requested"}, producer=ID,
                   occurred_at=t0 + timedelta(seconds=6))
    await env.emit("user.security.changed.v1", {"user_id": uid, "change": "pin_set"}, producer=ID,
                   occurred_at=t0 + timedelta(seconds=5))
    await env.emit("user.security.changed.v1", {"user_id": uid, "change": "pin_removed"}, producer=ID,
                   occurred_at=t0 + timedelta(seconds=4))
    assert (await row(env, uid)).security == {"pin_enabled": True, "pin_reset_pending": True}
    # pin_locked и биометрия блок безопасности карточки не меняют
    await env.emit("user.security.changed.v1", {"user_id": uid, "change": "pin_locked"}, producer=ID)
    await env.emit("user.security.changed.v1", {"user_id": uid, "change": "biometric_disabled"}, producer=ID)
    assert (await row(env, uid)).security == {"pin_enabled": True, "pin_reset_pending": True}
    await env.emit("user.security.changed.v1", {"user_id": uid, "change": "pin_reset"}, producer=ID,
                   occurred_at=t0 + timedelta(seconds=6, milliseconds=500))
    assert (await row(env, uid)).security == {"pin_enabled": True, "pin_reset_pending": False}

    # согласие: отзыв (t8) раньше принятия (t7)
    await env.emit("consent.revoked.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "basis": "self"},
                   producer=ID, occurred_at=t0 + timedelta(seconds=8))
    await env.emit("consent.accepted.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "policy_version": "1.0",
                                           "purposes": ["terms"], "basis": "self"}, producer=ID,
                   occurred_at=t0 + timedelta(seconds=7))
    assert (await row(env, uid)).consent["revoked_at"] is not None

    # уведомления: старое выключение не перекрывает новое включение
    await env.emit("user.notification_settings.changed.v1", {"user_id": uid, "enabled": True, "categories": []},
                   producer=ID, occurred_at=t0 + timedelta(seconds=10))
    await env.emit("user.notification_settings.changed.v1", {"user_id": uid, "enabled": False, "categories": []},
                   producer=ID, occurred_at=t0 + timedelta(seconds=9))
    assert (await row(env, uid)).notifications["enabled"] is True

    # план: онбординг (t12) раньше старой правки (t11); занятие — максимум
    await env.emit("learning.plan.updated.v1", plan_payload(uid, changed_fields=["onboarding_completed_at"],
                                                            onboarding_completed=True),
                   producer=LP, occurred_at=t0 + timedelta(seconds=12))
    await env.emit("learning.plan.updated.v1", plan_payload(uid, goal="work"), producer=LP,
                   occurred_at=t0 + timedelta(seconds=11))
    r = await row(env, uid)
    assert r.onboarding_completed and r.goal == "travel"
    for minutes in (2, 1):
        await env.emit("learning.activity.recorded.v1", {
            "user_id": uid, "activity_id": str(uuid.uuid4()), "local_date": "2026-11-18", "kind": "practice",
            "minutes": 5, "recorded_at": iso(t0 - timedelta(minutes=minutes))}, producer=LP)
    assert (await row(env, uid)).last_activity_at == t0 - timedelta(minutes=1)

    # обращение: CLOSED (t15) раньше IN_PROGRESS (t14), а created — последним
    tid = str(uuid.uuid4())
    base = {"ticket_id": tid, "number": "TCK-3200", "user_id": uid}
    await env.emit("support.ticket.status.changed.v1", {**base, "from_status": "RESOLVED", "to_status": "CLOSED",
                                                        "changed_by": "user"}, producer="support",
                   occurred_at=t0 + timedelta(seconds=15))
    await env.emit("support.ticket.status.changed.v1", {**base, "from_status": "NEW", "to_status": "IN_PROGRESS",
                                                        "changed_by": "operator"}, producer="support",
                   occurred_at=t0 + timedelta(seconds=14))
    await env.emit("support.ticket.created.v1", {**base, "category": "other", "priority": "normal"},
                   producer="support", occurred_at=t0 + timedelta(seconds=13))
    r = await row(env, uid)
    assert (r.open_tickets, r.tickets_total) == (0, 1)


async def test_plan_event_keeps_known_level_and_preset_and_wakes_reconcile(env) -> None:
    uid = str(uuid.uuid4())
    env.plans.put({"user_id": uid, "goal": "work", "level_self": "some", "ui_lang": "ru",
                   "schedule": {"preset": "custom", "days": [1, 2, 3, 4, 5], "preferred_time": "08:00",
                                "duration_min": 10, "reminders_enabled": False, "timezone": "Asia/Tashkent"},
                   "onboarding_completed_at": None, "updated_at": iso(now() - timedelta(minutes=1))})
    await env.reconciler.plans.run_once()
    r = await row(env, uid)
    assert r.plan["level_self"] == "some" and r.plan["schedule"]["preset"] == "custom"

    # правка времени: уровень и пресет «custom» (с днями будних) сохраняются, досрочная сверка не нужна
    env.reconciler.plans._wake.clear()
    await env.emit("learning.plan.updated.v1", plan_payload(uid, changed_fields=["preferred_time"], goal="work",
                                                            ui_lang="ru", days=[1, 2, 3, 4, 5],
                                                            preferred_time="09:15", reminders_enabled=False,
                                                            duration_min=10), producer=LP)
    r = await row(env, uid)
    assert r.plan["level_self"] == "some" and r.plan["schedule"]["preset"] == "custom"
    assert r.plan["schedule"]["preferred_time"] == "09:15"
    assert not env.reconciler.plans._wake.is_set()

    # смена уровня: значения нет в событии → null до сверки, сверка разбужена
    await env.emit("learning.plan.updated.v1", plan_payload(uid, changed_fields=["level_self"], goal="work",
                                                            days=[1, 2, 3, 4, 5]), producer=LP)
    r = await row(env, uid)
    assert r.plan["level_self"] is None and env.reconciler.plans._wake.is_set()

    # событие спринта 2 несёт level_self и preset → применяются сразу, сверка не нужна
    env.reconciler.plans._wake.clear()
    ev = plan_payload(uid, changed_fields=["level_self", "preset", "days"], goal="work", days=[1, 2, 3, 4, 5],
                      level_self="confident", preset="weekdays")
    assert_event_conforms(make_envelope("learning.plan.updated.v1", ev, producer=LP))
    await env.emit("learning.plan.updated.v1", ev, producer=LP)
    r = await row(env, uid)
    assert (r.plan["level_self"], r.plan["schedule"]["preset"]) == ("confident", "weekdays")
    assert not env.reconciler.plans._wake.is_set()


async def test_consent_revoke_of_other_basis_keeps_active_consent(env) -> None:
    """Родитель отозвал своё согласие у подростка: действующее согласие подростка (self) в карточке остаётся."""
    uid = str(uuid.uuid4())
    await env.emit("consent.accepted.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "policy_version": "1.0",
                                           "purposes": ["terms", "privacy"], "basis": "self"}, producer=ID)
    await env.emit("consent.revoked.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "basis": "guardian",
                                          "revoked_by_user_id": str(uuid.uuid4())}, producer=ID)
    r = await row(env, uid)
    assert r.consent["basis"] == "self" and r.consent["revoked_at"] is None
    await env.emit("consent.revoked.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "basis": "self"},
                   producer=ID)
    assert (await row(env, uid)).consent["revoked_at"] is not None


async def test_anonymized_ticket_is_unlinked(env) -> None:
    uid = str(uuid.uuid4())
    tid = str(uuid.uuid4())
    await env.emit("user.profile.created.v1", {"user_id": uid, "kind": "account", "created_at": iso(now())},
                   producer=ID)
    await env.emit("support.ticket.created.v1", {"ticket_id": tid, "number": "TCK-3300", "user_id": uid,
                                                 "category": "other", "priority": "normal"}, producer="support")
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
    ("user.profile.updated.v1", {"changed_fields": ["age_band"], "age_band": "18+"}, "social"),
    ("consent.accepted.v1", {"consent_id": "c", "policy_version": "1.0", "purposes": []}, LP),
    ("user.domain.deleted.v1", {"request_id": "r", "domain": ID, "mode": "deleted"}, "support"),
    ("learning.plan.updated.v1", {"changed_fields": ["goal"], "goal": "work"}, ID),
    ("learning.activity.recorded.v1", {"recorded_at": "2026-11-18T10:00:00Z"}, "support"),
    ("support.ticket.created.v1", {"ticket_id": str(uuid.uuid4()), "number": "TCK-1"}, ID),
])
async def test_events_from_foreign_producers_are_ignored(env, event_type, payload, producer) -> None:
    uid = str(uuid.uuid4())
    await env.emit(event_type, {"user_id": uid, **payload}, producer=producer)
    assert await row(env, uid) is None


async def test_other_domain_acks_and_malformed_events_are_ignored(env) -> None:
    uid = str(uuid.uuid4())
    await env.emit("user.profile.created.v1", {"user_id": uid, "kind": "account", "created_at": iso(now())},
                   producer=ID)
    for domain in ("support", LP):
        await env.emit("user.domain.deleted.v1", {"user_id": uid, "request_id": str(uuid.uuid4()), "domain": domain,
                                                  "mode": "deleted"}, producer=domain)
    assert (await row(env, uid)).status == "ACTIVE"
    await env.emit("user.status.changed.v1", {"user_id": "not-a-uuid", "status": "DISABLED"}, producer=ID)
    await env.emit("support.ticket.created.v1", {"ticket_id": str(uuid.uuid4()), "number": "garbage",
                                                 "user_id": uid}, producer="support")
    await env.emit("user.status.changed.v1", {"user_id": uid, "status": "HACKED", "previous_status": "ACTIVE"},
                   producer=ID)
    await env.emit("user.notification_settings.changed.v1", {"user_id": uid, "enabled": "yes"}, producer=ID)
    await env.emit("learning.plan.updated.v1", {"user_id": uid, "changed_fields": ["goal"], "goal": "hack",
                                                "days": ["x"], "preferred_time": "25:99"}, producer=LP)
    r = await row(env, uid)
    assert r.status == "ACTIVE" and r.tickets_total == 0 and r.notifications is None
    assert r.goal is None and r.plan["schedule"] is None  # мусор не попадает в план, полный план — после сверки


async def test_ticket_number_collision_is_skipped_not_retried(env) -> None:
    uid = str(uuid.uuid4())
    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    base = {"number": "TCK-5001", "user_id": uid, "category": "other", "priority": "normal"}
    await env.emit("support.ticket.created.v1", {**base, "ticket_id": first}, producer="support")
    # другой ticket_id с тем же номером (пересозданная БД support) — обработчик не падает
    await env.emit("support.ticket.created.v1", {**base, "ticket_id": second}, producer="support")
    await env.emit("support.ticket.status.changed.v1", {**base, "ticket_id": second, "from_status": "NEW",
                                                        "to_status": "CLOSED", "changed_by": "operator"},
                   producer="support")
    async with env.runtime.transaction() as s:
        refs = (await s.execute(select(TicketRef))).scalars().all()
    assert [(str(r.ticket_id), r.status) for r in refs] == [(first, "NEW")]


async def test_profile_events_wake_identity_reconcile(env) -> None:
    uid = str(uuid.uuid4())
    sync = env.reconciler.identity
    sync._wake.clear()
    await env.emit("user.profile.updated.v1", {"user_id": uid, "changed_fields": ["age_band"], "age_band": "18+"},
                   producer=ID)
    assert not sync._wake.is_set()
    await env.emit("user.profile.updated.v1", {"user_id": uid, "changed_fields": ["display_name"]}, producer=ID)
    assert sync._wake.is_set()  # имени в событии нет — его приносит сверка
    sync._wake.clear()
    await env.emit("user.profile.created.v1", {"user_id": str(uuid.uuid4()), "kind": "account",
                                               "created_at": iso(now())}, producer=ID)
    assert sync._wake.is_set()


# ---------------------------------------------------------------- согласие подростка и допуск часов (ревью P2-3)

ALL_PURPOSES = ["terms", "privacy", "voice_recording", "social", "product_news"]


def own_consent(at, purposes=("terms", "privacy")) -> dict:
    return {"policy_version": "1.0", "purposes": list(purposes), "accepted_at": iso(at), "revoked_at": None,
            "basis": "self"}


async def test_teen_consent_card_equals_identity_snapshot(env) -> None:
    """Подросток принял политику сам; родитель разрешил, затем отозвал. В карточке аккаунта — собственное согласие
    подростка (как в снимке identity), решение родителя — в guardian_consent. Версия снимка (момент изменения строки
    identity) чуть раньше occurred_at событий той же транзакции — снимок всё равно авторитетен."""
    uid = str(uuid.uuid4())
    t0 = now() - timedelta(minutes=10)
    snap = env.identity.put(snapshot(uid, updated_at=t0, age_band="14-17", guardian_consent="pending",
                                     consent=own_consent(t0)))
    await env.reconciler.identity.run_once()

    async def card() -> dict:
        r = await env.get(f"/admin/v1/learners/{uid}")
        assert r.status_code == 200, r.text
        return r.json()

    # родитель разрешил: identity пишет запись basis=guardian со всеми целями политики
    t1 = now() - timedelta(minutes=5)
    await env.emit("consent.accepted.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "policy_version": "1.0",
                                           "purposes": ALL_PURPOSES, "basis": "guardian",
                                           "granted_by_user_id": str(uuid.uuid4())}, producer=ID, occurred_at=t1)
    await env.emit("user.profile.updated.v1", {"user_id": uid, "changed_fields": ["guardian_consent"],
                                               "age_band": "14-17", "is_minor": True, "locale": "ru",
                                               "guardian_consent": "granted"}, producer=ID, occurred_at=t1)
    r = await row(env, uid)  # проекция и без снимка не подменяет согласие подростка согласием родителя
    assert r.consent["basis"] == "self" and r.consent["purposes"] == ["terms", "privacy"]
    assert r.guardian_consent == "granted"
    snap.update(updated_at=iso(t1 - timedelta(milliseconds=30)), guardian_consent="granted")
    c = await card()
    assert c["consent"] == snap["consent"] and c["guardian_consent"] == "granted"

    # родитель отозвал: запись guardian закрыта, своё согласие подростка сужено (consent.accepted self) и действует
    t2 = now() - timedelta(minutes=1)
    await env.emit("consent.revoked.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "policy_version": "1.0",
                                          "basis": "guardian", "revoked_by_user_id": str(uuid.uuid4())},
                   producer=ID, occurred_at=t2)
    await env.emit("consent.accepted.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "policy_version": "1.0",
                                           "purposes": ["terms", "privacy"], "basis": "self"},
                   producer=ID, occurred_at=t2)
    await env.emit("user.profile.updated.v1", {"user_id": uid, "changed_fields": ["guardian_consent"],
                                               "age_band": "14-17", "guardian_consent": "declined"},
                   producer=ID, occurred_at=t2)
    r = await row(env, uid)
    assert r.consent["basis"] == "self" and r.consent["revoked_at"] is None and r.guardian_consent == "declined"
    snap.update(updated_at=iso(t2 - timedelta(milliseconds=30)), guardian_consent="declined",
                consent=own_consent(t0))
    c = await card()
    assert c["consent"] == snap["consent"] and c["consent"]["revoked_at"] is None
    assert c["guardian_consent"] == "declined"


async def test_consent_basis_by_kind(env) -> None:
    """Аккаунт — только своё согласие; детский профиль — только согласие опекуна."""
    parent, kid = str(uuid.uuid4()), str(uuid.uuid4())
    await env.emit("user.profile.created.v1", {"user_id": parent, "kind": "account", "created_at": iso(now())},
                   producer=ID)
    await env.emit("user.profile.created.v1", {"user_id": kid, "kind": "child", "guardian_user_id": parent,
                                               "age_band": "6-9", "created_at": iso(now())}, producer=ID)
    for uid, basis in ((parent, "guardian"), (kid, "self")):  # чужое основание — блок не трогается
        await env.emit("consent.accepted.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()),
                                               "policy_version": "1.0", "purposes": ALL_PURPOSES, "basis": basis},
                       producer=ID)
        assert (await row(env, uid)).consent["basis"] is None
    for uid, basis in ((parent, "self"), (kid, "guardian")):
        await env.emit("consent.accepted.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()),
                                               "policy_version": "1.0", "purposes": ["terms"], "basis": basis},
                       producer=ID)
        await env.emit("consent.revoked.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()),
                                              "basis": "self" if basis == "guardian" else "guardian"}, producer=ID)
        r = await row(env, uid)
        assert r.consent["basis"] == basis and r.consent["revoked_at"] is None
        await env.emit("consent.revoked.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "basis": basis},
                       producer=ID)
        assert (await row(env, uid)).consent["revoked_at"] is not None


async def test_snapshot_within_clock_skew_is_authoritative(env) -> None:
    """Снимок авторитетен, если не старше версии события больше чем на 2 с; старше — событие новее, не затирается.
    Версия после снимка не уменьшается: запоздавшее более старое событие снимок не перетирает."""
    uid = str(uuid.uuid4())
    t = now()
    env.identity.put(snapshot(uid, updated_at=t - timedelta(minutes=1), consent=own_consent(t - timedelta(minutes=1))))
    await env.reconciler.identity.run_once()
    await env.emit("consent.accepted.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "policy_version": "1.0",
                                           "purposes": ["terms", "privacy", "social"], "basis": "self"},
                   producer=ID, occurred_at=t)
    await env.emit("user.status.changed.v1", {"user_id": uid, "status": "DISABLED", "previous_status": "ACTIVE"},
                   producer=ID, occurred_at=t)
    # снимок той же транзакции (версия на 1,5 с раньше — часы БД и приложения) — авторитетен
    env.identity.put(snapshot(uid, updated_at=t - timedelta(milliseconds=1500), status="DISABLED",
                              consent=own_consent(t, ("terms", "privacy"))))
    await env.reconciler.identity.run_once()
    r = await row(env, uid)
    assert r.consent["purposes"] == ["terms", "privacy"] and r.status == "DISABLED" and r.consent_at == t
    # снимок старше допуска (прочитан до события) — события новее не затирает
    env.identity.put(snapshot(uid, updated_at=t - timedelta(seconds=3), status="ACTIVE",
                              consent=own_consent(t, ("terms",))))
    await env.reconciler.identity.run_once()
    r = await row(env, uid)
    assert r.consent["purposes"] == ["terms", "privacy"] and r.status == "DISABLED"
    # запоздавшее событие старше версии (уже учтено снимком) — без изменений
    await env.emit("consent.accepted.v1", {"user_id": uid, "consent_id": str(uuid.uuid4()), "policy_version": "1.0",
                                           "purposes": ALL_PURPOSES, "basis": "self"},
                   producer=ID, occurred_at=t - timedelta(milliseconds=10))
    assert (await row(env, uid)).consent["purposes"] == ["terms", "privacy"]
