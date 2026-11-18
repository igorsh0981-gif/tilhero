"""Проекция learner_activity (онбординг, последнее занятие) из событий learning-plan: inbox-дедупликация, порядок
доставки, издатель, удаление ученика (INTERNAL_API спринта 2 §3)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from admin_kit import CONFIRM, activity_recorded, delete_completely, plan_updated, projection
from sqlalchemy import func, select

from tilhero_common.messaging import inbox_table, make_envelope, run_with_inbox
from tilhero_identity.activity import CONSUMER, on_learning_event

NOW = datetime.now(UTC)


def _spec(env):
    [spec] = [s for s in env.bus.specs if s.durable == CONSUMER]
    return spec


async def _inbox_rows(env, event_id: str) -> int:
    async with env.runtime.transaction() as s:
        return (await s.execute(
            select(func.count()).select_from(inbox_table)
            .where(inbox_table.c.event_id == event_id, inbox_table.c.consumer == CONSUMER)
        )).scalar_one()


async def test_consumer_subscribed_to_learning_events(env) -> None:
    spec = _spec(env)
    assert spec.event_types == ["learning.plan.updated.v1", "learning.activity.recorded.v1"]


async def test_projection_from_plan_and_activity(env) -> None:
    uid = await env.adult()
    assert await projection(env, uid) is None
    done = plan_updated(uid, onboarding_completed=True, at=NOW - timedelta(hours=3))
    await env.bus.publish(done)
    row = await projection(env, uid)
    assert row is not None and row.onboarding_completed_at == done.occurred_at and row.last_activity_at is None
    await env.bus.publish(activity_recorded(uid, NOW - timedelta(days=1)))
    await env.bus.publish(activity_recorded(uid, NOW - timedelta(days=3)))  # более старое занятие не сдвигает назад
    row = await projection(env, uid)
    assert row is not None and row.last_activity_at == NOW - timedelta(days=1)
    assert row.onboarding_completed_at == done.occurred_at
    assert not env.bus.dlq and not env.bus.transient


async def test_projection_dedup_by_inbox(env) -> None:
    uid = await env.adult()
    event = activity_recorded(uid, NOW - timedelta(hours=5))
    handler = _spec(env).handler
    await handler(event)
    first = await projection(env, uid)
    await handler(event)  # повторная доставка того же event_id (JetStream at-least-once)
    second = await projection(env, uid)
    assert first is not None and second is not None
    assert second.last_activity_at == first.last_activity_at and second.updated_at == first.updated_at
    assert await _inbox_rows(env, event.event_id) == 1
    # повтор через общий inbox не вызывает обработчик
    assert await run_with_inbox(env.runtime.db, CONSUMER, event, on_learning_event) is False


async def test_projection_out_of_order_plan_events(env) -> None:
    uid = await env.adult()
    t = [NOW - timedelta(hours=10 - i) for i in range(6)]
    await env.bus.publish(plan_updated(uid, onboarding_completed=True, at=t[2]))
    await env.bus.publish(plan_updated(uid, onboarding_completed=False, at=t[1]))  # старое «не пройден» — без эффекта
    row = await projection(env, uid)
    assert row is not None and row.onboarding_completed_at == t[2] and row.plan_event_at == t[2]
    await env.bus.publish(plan_updated(uid, onboarding_completed=True, at=t[0]))  # раннее true — самое раннее время
    assert (await projection(env, uid)).onboarding_completed_at == t[0]
    await env.bus.publish(plan_updated(uid, onboarding_completed=None, at=t[5]))  # событие без признака онбординга
    assert (await projection(env, uid)).plan_event_at == t[2]
    await env.bus.publish(plan_updated(uid, onboarding_completed=False, at=t[4]))  # новое «не пройден» — снимает
    row = await projection(env, uid)
    assert row.onboarding_completed_at is None and row.plan_event_at == t[4]
    await env.bus.publish(plan_updated(uid, onboarding_completed=True, at=t[3]))  # старое true не возвращает
    assert (await projection(env, uid)).onboarding_completed_at is None
    await env.bus.publish(plan_updated(uid, onboarding_completed=True, at=t[5]))
    assert (await projection(env, uid)).onboarding_completed_at == t[5]


async def test_projection_future_time_is_clamped(env) -> None:
    uid = await env.adult()
    await env.bus.publish(activity_recorded(uid, NOW + timedelta(days=30)))
    await env.bus.publish(plan_updated(uid, onboarding_completed=True, at=NOW + timedelta(days=30)))
    row = await projection(env, uid)
    limit = datetime.now(UTC) + timedelta(seconds=1)
    assert row is not None and row.last_activity_at <= limit and row.onboarding_completed_at <= limit


async def test_projection_ignores_foreign_and_malformed_events(env) -> None:
    uid = await env.adult()
    await env.bus.publish(activity_recorded(uid, NOW, producer="social"))  # чужой издатель
    await env.bus.publish(plan_updated(uid, producer="telegram-bff"))
    await env.bus.publish(make_envelope("learning.plan.updated.v1", {"user_id": "not-a-uuid", "changed_fields": []},
                                        producer="learning-plan"))
    await env.bus.publish(make_envelope("learning.activity.recorded.v1", {"activity_id": str(uuid.uuid4())},
                                        producer="learning-plan"))
    await env.bus.publish(activity_recorded(str(uuid.uuid4()), NOW))  # неизвестный ученик
    assert await projection(env, uid) is None
    assert not env.bus.dlq and not env.bus.transient
    # битое время занятия — берётся время события
    bad_time = make_envelope("learning.activity.recorded.v1", {
        "user_id": uid, "activity_id": str(uuid.uuid4()), "local_date": "2026-11-18", "kind": "lesson",
        "minutes": 5, "recorded_at": "yesterday"}, producer="learning-plan")
    await env.bus.publish(bad_time)
    row = await projection(env, uid)
    assert row is not None and row.last_activity_at == bad_time.occurred_at


async def test_projection_cleared_on_deletion_and_late_events_skipped(env) -> None:
    parent = await env.parent()
    child = (await env.child(parent))["learner_id"]
    for uid in (parent, child):
        await env.bus.publish(plan_updated(uid))
        await env.bus.publish(activity_recorded(uid, NOW - timedelta(hours=1)))
        assert await projection(env, uid) is not None
    r = await env.call("POST", "/internal/v1/me/deletion-request", parent, CONFIRM)
    assert r.status_code == 202, r.text
    assert await projection(env, parent) is None and await projection(env, child) is None
    # поздние события удаляемых учеников проекцию не восстанавливают
    for uid in (parent, child):
        await env.bus.publish(activity_recorded(uid, NOW))
        assert await projection(env, uid) is None
    assert not env.bus.dlq


async def test_projection_absent_after_anonymization(env) -> None:
    uid = await env.adult()
    await env.bus.publish(activity_recorded(uid, NOW - timedelta(hours=2)))
    await delete_completely(env, uid)
    assert await projection(env, uid) is None
    await env.bus.publish(plan_updated(uid))
    assert await projection(env, uid) is None


async def test_projection_kept_for_disabled_learner(env) -> None:
    """Отключённый ученик в аудиторию не попадает, но проекция ведётся — после включения фильтры точны."""
    uid = await env.parent()
    assert (await env.call("POST", "/internal/v1/me/disable", uid)).status_code == 200
    await env.bus.publish(activity_recorded(uid, NOW - timedelta(hours=1)))
    row = await projection(env, uid)
    assert row is not None and row.last_activity_at == NOW - timedelta(hours=1)
