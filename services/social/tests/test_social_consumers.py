"""Потребители: дети попадают в семью опекуна (user.profile.created.v1), проекция возраста и согласия родителя,
сага удаления (AT-14) с передачей семьи, ACK domain=social, inbox-дедупликация, DLQ."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

from tilhero_common.messaging import Envelope, make_envelope
from tilhero_common.testing import assert_event_conforms


def child_created(child: uuid.UUID, guardian: uuid.UUID, age: str = "6-9") -> dict:
    return {"user_id": str(child), "kind": "child", "age_band": age, "guardian_user_id": str(guardian),
            "created_at": "2026-11-16T08:00:00Z"}


def deletion(user: uuid.UUID, rid: uuid.UUID, attempt: int | None = None) -> Envelope:
    payload: dict = {"user_id": str(user), "request_id": str(rid), "requested_at": "2026-11-18T09:00:00Z"}
    if attempt:
        payload["attempt"] = attempt
    ev = make_envelope("user.deletion.requested.v1", payload, producer="identity-consent")
    assert_event_conforms(ev)
    return ev


async def test_child_joins_guardian_family(env) -> None:
    parent = env.identity.add("Мама")
    child = env.identity.add("Мадина", age="6-9", kind="child")
    ev = await env.profile_event("user.profile.created.v1", child_created(child, parent))
    fam = (await env.c.get("/internal/v1/me/family", headers=env.h(parent))).json()
    assert [(m["display_name"], m["role"]) for m in fam["members"]] == [("Мама", "owner"), ("Мадина", "child")]
    [added] = await env.events("social.family.member_added.v1")
    assert added.payload["user_id"] == str(child) and added.payload["role"] == "child"
    # повторная доставка того же события — inbox; второе событие о том же ребёнке — без дубля
    spec = next(s for s in env.bus.specs if s.durable == "social.profiles")
    await spec.handler(ev)
    await env.profile_event("user.profile.created.v1", child_created(child, parent))
    assert len(await env.events("social.family.member_added.v1")) == 1
    # опекун — участник чужой семьи: ребёнок попадает туда
    owner, dad = env.identity.add("Бабушка"), env.identity.add("Папа")
    iid, token = await env.invite(owner, "family")
    await env.open(dad, token)
    await env.accept(dad, iid)
    son = env.identity.add("Сын", age="10-13", kind="child")
    await env.profile_event("user.profile.created.v1", child_created(son, dad, "10-13"))
    fam = (await env.c.get("/internal/v1/me/family", headers=env.h(dad))).json()
    assert [(m["display_name"], m["role"]) for m in fam["members"]] == [
        ("Бабушка", "owner"), ("Папа", "adult"), ("Сын", "child")]


async def test_profile_projection(env) -> None:
    teen = uuid.uuid4()
    await env.profile_event("user.profile.created.v1", {"user_id": str(teen), "kind": "account",
                                                        "created_at": "2026-11-16T08:00:00Z"})
    await env.profile_event("user.profile.updated.v1", {"user_id": str(teen), "changed_fields": ["age_band"],
                                                        "age_band": "14-17", "is_minor": True,
                                                        "guardian_consent": "pending"})
    rows = await env.sql("SELECT kind, age_band, guardian_consent FROM profiles WHERE user_id = :u", u=teen)
    assert rows == [("account", "14-17", None)]  # guardian_consent не в changed_fields — не трогаем
    await env.grant_guardian_consent(teen)
    # created, доставленный позже updated, не затирает известный возраст
    await env.profile_event("user.profile.created.v1", {"user_id": str(teen), "kind": "account",
                                                        "created_at": "2026-11-16T08:00:00Z"})
    rows = await env.sql("SELECT kind, age_band, guardian_consent FROM profiles WHERE user_id = :u", u=teen)
    assert rows == [("account", "14-17", "granted")]


async def test_deletion_removes_user_data_and_transfers_family(env) -> None:
    owner, friend = env.identity.add("Владелец"), env.identity.add("Друг")
    teen = env.identity.add("Подросток", age="14-17")
    spouse, uncle = env.identity.add("Супруг"), env.identity.add("Дядя")
    child = env.identity.add("Ребёнок", age="6-9", kind="child")
    await env.grant_guardian_consent(teen)
    await env.profile_event("user.profile.created.v1", child_created(child, owner))
    for guest in (teen, spouse, uncle):  # подросток вступил раньше всех, но наследует взрослый
        env.now += timedelta(minutes=1)
        iid, token = await env.invite(owner, "family")
        await env.open(guest, token)
        assert (await env.accept(guest, iid)).status_code == 200
    fid, ftoken = await env.invite(owner, "friend")
    await env.open(friend, ftoken)
    await env.accept(friend, fid)
    _, pending_token = await env.invite(owner, "referral")
    # owner открыл чужое приглашение — его ответ тоже удаляется
    _, friend_token = await env.invite(friend, "referral")
    await env.open(owner, friend_token)
    rid = uuid.uuid4()
    await env.bus.publish(deletion(owner, rid))
    [ack] = await env.events("user.domain.deleted.v1")
    assert ack.payload == {"user_id": str(owner), "request_id": str(rid), "domain": "social", "mode": "deleted"}
    assert await env.sql("SELECT 1 FROM invites WHERE inviter_user_id = :u", u=owner) == []
    assert await env.sql("SELECT 1 FROM invite_redemptions WHERE invitee_user_id = :u", u=owner) == []
    assert await env.sql("SELECT 1 FROM friendships WHERE user_a = :u OR user_b = :u", u=owner) == []
    assert await env.sql("SELECT 1 FROM profiles WHERE user_id = :u", u=owner) == []
    assert (await env.open(friend, pending_token)).status_code == 404
    # семья переходит к самому раннему взрослому; ребёнок и подросток остаются
    del env.identity.users[str(owner)]
    fam = (await env.c.get("/internal/v1/me/family", headers=env.h(spouse))).json()
    assert [(m["display_name"], m["role"]) for m in fam["members"]] == [
        ("Супруг", "owner"), ("Подросток", "teen"), ("Дядя", "adult"), ("Ребёнок", "child")]
    # повтор саги снова подтверждается; запоздавшее событие профиля не воскрешает проекцию
    await env.bus.publish(deletion(owner, rid, attempt=2))
    assert len(await env.events("user.domain.deleted.v1")) == 2
    await env.profile_event("user.profile.updated.v1", {"user_id": str(owner), "changed_fields": ["age_band"],
                                                        "age_band": "18+"})
    assert await env.sql("SELECT 1 FROM profiles WHERE user_id = :u", u=owner) == []
    assert env.bus.dlq == []


async def test_family_without_adults_is_dissolved(env) -> None:
    owner, teen = env.identity.add("Владелец"), env.identity.add("Подросток", age="14-17")
    await env.grant_guardian_consent(teen)
    iid, token = await env.invite(owner, "family")
    await env.open(teen, token)
    await env.accept(teen, iid)
    await env.bus.publish(deletion(owner, uuid.uuid4()))
    await env.flush()
    assert await env.sql("SELECT 1 FROM families") == []
    assert (await env.c.get("/internal/v1/me/family", headers=env.h(teen))).status_code == 404


async def test_member_deletion_and_unknown_user(env) -> None:
    owner, guest = env.identity.add("Владелец"), env.identity.add("Гость")
    iid, token = await env.invite(owner, "family")
    await env.open(guest, token)
    await env.accept(guest, iid)
    await env.bus.publish(deletion(guest, uuid.uuid4()))
    await env.bus.publish(deletion(uuid.uuid4(), uuid.uuid4()))  # нечего удалять — всё равно ACK
    assert len(await env.events("user.domain.deleted.v1")) == 2
    fam = (await env.c.get("/internal/v1/me/family", headers=env.h(owner))).json()
    assert [m["display_name"] for m in fam["members"]] == ["Владелец"]


async def test_parallel_redelivery_and_dlq(env) -> None:
    user, rid = env.identity.add(), uuid.uuid4()
    await env.invite(user, "referral")
    first, retry = deletion(user, rid, 1), deletion(user, rid, 2)
    spec = next(s for s in env.bus.specs if s.durable == "social.user_deletion")
    await asyncio.gather(spec.handler(first), spec.handler(retry), spec.handler(first))
    acks = await env.events("user.domain.deleted.v1")
    assert sorted(e.causation_id for e in acks) == sorted([first.event_id, retry.event_id])
    await env.bus.publish(make_envelope("user.deletion.requested.v1", {"user_id": "bad"}, producer="identity-consent"))
    assert [d for d, _ in env.bus.dlq] == ["social.user_deletion"]
