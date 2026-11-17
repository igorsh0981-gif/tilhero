"""Удаление (AT-14, TG-FR-006): user.deletion.requested.v1 → журнал и центр ученика, записи с его именем у других,
состояния и кэши удалены → user.domain.deleted.v1 {domain: notifications, mode: deleted}; запоздавшие события
записей не создают; повтор и параллельная доставка подтверждаются без ошибок."""

from __future__ import annotations

import asyncio
import uuid

from notif_testkit import at, local_day
from sqlalchemy import func, select, text

from tilhero_common.messaging import Envelope, make_envelope
from tilhero_common.testing import assert_event_conforms
from tilhero_notifications.models import FamilyOwner, InboxState, MissedState

CONSUMER = "notifications.user_deleted"


def requested(user: uuid.UUID, request_id: uuid.UUID, attempt: int) -> Envelope:
    ev = make_envelope(
        "user.deletion.requested.v1",
        {"user_id": str(user), "request_id": str(request_id), "requested_at": "2026-11-18T09:00:00.000Z",
         "attempt": attempt},
        producer="identity-consent",
    )
    assert_event_conforms(ev)
    return ev


async def acks(env, request_id: uuid.UUID) -> list[Envelope]:
    found = [e for e in await env.events("user.domain.deleted.v1") if e.payload["request_id"] == str(request_id)]
    for e in found:
        assert_event_conforms(e)
        assert e.producer == "notifications"
    return found


async def count(env, model, **where) -> int:
    async with env.runtime.transaction() as s:
        stmt = select(func.count()).select_from(model)
        for k, v in where.items():
            stmt = stmt.where(getattr(model, k) == v)
        return int((await s.execute(stmt)).scalar_one())


async def test_deletion_removes_center_names_states_and_caches(env) -> None:
    user, other, friend = env.add_user(name="Удаляемый"), env.add_user(), env.add_user()
    family, day = uuid.uuid4(), local_day(1)
    await env.reminder(user, day, "10:00")
    await env.missed(user, day, "10:00")
    await env.member_added(family, user, "owner")
    await env.invite("accepted", friend, user)  # у друга — запись с именем удаляемого
    await env.reply_event(other)
    await env.dispatch(at(day, "10:00"))
    await env.inbox(user)  # водяной знак рассылок
    [to_friend] = env.gateway.to(env.telegram_id(friend))
    assert to_friend["text"].endswith("Удаляемый принял(а) ваше приглашение в TilHero.")
    assert await count(env, MissedState, user_id=user) == 1 and await count(env, InboxState, user_id=user) == 1
    request_id = uuid.uuid4()
    await env.delete(user, request_id)
    assert await env.rows(user) == [] and await env.rows(friend) == []
    assert len(await env.rows(other)) == 1
    assert await count(env, MissedState, user_id=user) == 0 and await count(env, InboxState, user_id=user) == 0
    assert await count(env, FamilyOwner, owner_user_id=user) == 0
    assert env.runtime.redis is not None
    for kind in ("delivery", "public"):
        assert await env.runtime.redis.get(f"{env.settings.redis_key_prefix}:{kind}:{user}") is None
    [ack] = await acks(env, request_id)
    assert ack.payload == {"user_id": str(user), "request_id": str(request_id), "domain": "notifications",
                           "mode": "deleted"}


async def test_late_events_after_deletion_create_nothing(env) -> None:
    user, day = env.add_user(), local_day(1)
    request_id = uuid.uuid4()
    await env.delete(user, request_id)
    await env.reply_event(user)
    await env.reminder(user, day)
    await env.missed(user, day)
    await env.invite("reminder_due", env.add_user(), user)
    tx = await env.transactional(user)
    assert tx.status_code == 200 and tx.json() == {
        "notification_id": tx.json()["notification_id"], "status": "skipped", "reason": "user_deleted"
    }
    assert (await env.inbox(user))["items"] == []  # чтение центра не создаёт состояние удалённому
    assert await env.rows(user) == [] and env.gateway.calls == []
    assert await count(env, MissedState, user_id=user) == 0 and await count(env, InboxState, user_id=user) == 0
    async with env.runtime.transaction() as s:
        marks = (await s.execute(text("SELECT count(*) FROM deleted_users WHERE user_id = :u"), {"u": user})).scalar()
    assert marks == 1


async def test_child_deletion_keeps_parent(env) -> None:
    parent = env.add_user()
    child = env.add_child(parent)
    day = local_day(1)
    await env.reminder(child, day)
    await env.reminder(parent, day)
    await env.delete(child)
    assert await env.rows(child) == [] and len(await env.rows(parent)) == 1


async def test_race_deletion_vs_new_notification(env) -> None:
    """Гонка «удаление ↔ новое уведомление»: при любом порядке записей с user_id не остаётся."""
    for _ in range(8):
        user = env.add_user()
        await asyncio.gather(env.reply_event(user), env.delete(user), env.reminder(user, local_day(1)))
        assert await env.rows(user) == []


async def test_retry_is_acked_again(env) -> None:
    """Повтор `user.deletion.requested.v1` — тот же request_id, новый event_id, attempt — снова подтверждается."""
    user, other, rid = env.add_user(), env.add_user(), uuid.uuid4()
    for u in (user, other):
        await env.reply_event(u)
    first, retry = requested(user, rid, 1), requested(user, rid, 2)
    await env.bus.publish(first)
    assert len(await acks(env, rid)) == 1 and await env.rows(user) == []
    await env.bus.publish(retry)
    found = await acks(env, rid)
    assert len(found) == 2 and found[0].payload == found[1].payload
    assert len(await env.rows(other)) == 1 and env.bus.dlq == []


async def test_parallel_retries_and_redelivery(env) -> None:
    user, rid = env.add_user(), uuid.uuid4()
    await env.reply_event(user)
    events = [requested(user, rid, n) for n in (1, 2, 3)]
    spec = next(s for s in env.bus.specs if s.durable == CONSUMER)
    await asyncio.gather(*[spec.handler(e) for e in events], spec.handler(events[0]))
    assert len(await acks(env, rid)) == 3  # по ACK на каждый event_id; повторная доставка — inbox
    assert await env.rows(user) == [] and env.bus.dlq == []
