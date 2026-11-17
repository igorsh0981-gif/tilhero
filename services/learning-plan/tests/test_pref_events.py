from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import text

from tilhero_common.messaging import make_envelope
from tilhero_common.testing import assert_event_conforms

PREFS = "/internal/v1/me/preferences"


def deletion_event(user: uuid.UUID, request_id: uuid.UUID | None = None):
    return make_envelope("user.deletion.requested.v1",
                         {"user_id": str(user), "request_id": str(request_id or uuid.uuid4()),
                          "requested_at": datetime.now(UTC).isoformat()},
                         producer="identity-consent")


async def test_updated_event_conforms_to_contract(env, user) -> None:
    h = env.h(user)
    await env.c.patch(PREFS, json={"event_formats": ["online"], "budget": {"preset": "under_500"}}, headers=h)
    await env.c.put("/internal/v1/me/departures", json={"airports": ["TAS"]}, headers=h)
    await env.c.post("/internal/v1/me/onboarding/complete", headers=h)
    await env.flush()
    events = env.events("user.preferences.updated.v1")
    assert [e.payload["changed_fields"] for e in events] == [
        ["event_formats", "budget"], ["departures"], ["onboarding_completed_at"]]
    assert [e.payload["onboarding_completed"] for e in events] == [False, False, True]
    for e in events:
        assert_event_conforms(e)
        assert e.producer == "preferences"
        assert set(e.payload) == {"user_id", "changed_fields", "onboarding_completed"}  # без PII и значений
        assert e.payload["user_id"] == str(user)


async def test_deletion_removes_profile_and_acks(env, user) -> None:
    h = env.h(user)
    body = {"interests": {"categories": ["music"], "entities": ["Coldplay"]}}
    await env.c.patch(PREFS, json=body, headers=h)
    other = uuid.uuid4()
    await env.c.get(PREFS, headers=env.h(other))
    req = uuid.uuid4()
    ev = deletion_event(user, req)
    assert_event_conforms(ev)
    await env.bus.publish(ev)
    await env.flush()
    acks = env.events("user.domain.deleted.v1")
    assert len(acks) == 1
    assert acks[0].payload == {"user_id": str(user), "request_id": str(req), "domain": "preferences",
                               "mode": "deleted"}
    assert acks[0].causation_id == ev.event_id
    assert_event_conforms(acks[0])
    async with env.runtime.transaction() as s:
        rows = (await s.execute(text("SELECT user_id::text FROM preference_profiles"))).scalars().all()
    assert rows == [str(other)]  # удалён только профиль пользователя из события
    # после удаления запоздавшие команды не воскрешают профиль
    for method, path, body in [("GET", PREFS, None), ("PATCH", PREFS, {"search_horizon_months": 6}),
                               ("PUT", "/internal/v1/me/departures", {"airports": ["TAS"]}),
                               ("POST", "/internal/v1/me/onboarding/complete", None)]:
        r = await env.c.request(method, path, json=body, headers=h)
        assert r.status_code == 410 and r.json()["code"] == "USER_DELETED"
    async with env.runtime.transaction() as s:
        assert (await s.execute(text("SELECT count(*) FROM preference_profiles WHERE user_id = :u"),
                                {"u": user})).scalar() == 0


async def test_deletion_is_idempotent(env, user) -> None:
    await env.c.get(PREFS, headers=env.h(user))
    ev = deletion_event(user)
    await env.bus.publish(ev)
    await env.runtime.bus.publish(ev)  # повторная доставка того же события (дедуп шины)
    # обходим дедупликацию шины: тот же event_id напрямую в обработчик — inbox не даёт выполнить дважды
    spec = next(s for s in env.bus.specs if s.durable == "preferences.user_deletion")
    await spec.handler(ev)
    await env.flush()
    assert len(env.events("user.domain.deleted.v1")) == 1
    async with env.runtime.transaction() as s:
        sql = text("SELECT count(*) FROM inbox WHERE consumer = 'preferences.user_deletion'")
        assert (await s.execute(sql)).scalar() == 1
    # новый запрос удаления (новый event_id) для уже удалённого пользователя снова подтверждается
    await env.bus.publish(deletion_event(user))
    await env.flush()
    assert len(env.events("user.domain.deleted.v1")) == 2


async def test_deletion_for_unknown_user_still_acks(env) -> None:
    ghost = uuid.uuid4()
    await env.bus.publish(deletion_event(ghost))
    await env.flush()
    acks = env.events("user.domain.deleted.v1")
    assert len(acks) == 1 and acks[0].payload["user_id"] == str(ghost)


async def test_invalid_deletion_payload_goes_to_dlq(env) -> None:
    bad = make_envelope("user.deletion.requested.v1", {"user_id": "nope", "request_id": "x"}, producer="x")
    with pytest.raises(Exception):  # noqa: B017 — контракт отвергает такой payload
        assert_event_conforms(bad)
    await env.bus.publish(bad)
    assert env.bus.dlq and env.bus.dlq[0][0] == "preferences.user_deletion"
    await env.flush()
    assert env.events("user.domain.deleted.v1") == []
