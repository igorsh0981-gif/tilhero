"""Сага удаления (INTERNAL_API §5): user.deletion.requested.v1 только от identity-consent → usage.user_id обезличен,
кеш результатов ученика стёрт, ACK user.domain.deleted.v1 {domain: ai-gateway, mode: anonymized}; дедупликация inbox."""

from __future__ import annotations

import uuid

from tilhero_common.messaging import make_envelope
from tilhero_common.testing import assert_event_conforms


def _request(user_id: uuid.UUID, producer: str = "identity-consent"):
    return make_envelope("user.deletion.requested.v1",
                         {"user_id": str(user_id), "request_id": str(uuid.uuid4()),
                          "requested_at": "2026-11-19T07:00:00Z"}, producer=producer)


async def test_deletion_anonymizes_usage_and_acks(env) -> None:
    learner, other = uuid.uuid4(), uuid.uuid4()
    rid = uuid.uuid4()
    await env.ok(user_id=learner, request_id=rid)
    await env.ok("teaching_coach", user_id=learner)
    await env.ok(user_id=other)
    redis = env.runtime.redis
    cache_keys = [k async for k in redis.scan_iter(match=f"{env.settings.cache_namespace}:invoke:*")]
    assert any(str(rid) in k for k in cache_keys)
    event = _request(learner)
    await env.bus.publish(event)
    assert not env.bus.dlq
    rows = await env.sql("SELECT user_id FROM usage ORDER BY seq")
    assert [r["user_id"] for r in rows] == [None, None, other]
    assert len(await env.usage()) == 3  # метаданные вызовов сохранены (статистика), без ученика
    left = [k async for k in redis.scan_iter(match=f"{env.settings.cache_namespace}:invoke:*")]
    assert not any(str(rid) in k for k in left) and not any(str(learner) in k for k in left)
    await env.flush()
    acks = env.events("user.domain.deleted.v1")
    assert len(acks) == 1 and acks[0].producer == "ai-gateway"
    assert acks[0].payload == {"user_id": str(learner), "request_id": event.payload["request_id"],
                               "domain": "ai-gateway", "mode": "anonymized"}
    assert acks[0].causation_id == event.event_id
    assert_event_conforms(acks[0])
    # повтор того же события — inbox: без второго ACK
    env.bus.published.remove(event)
    await env.bus.publish(event)
    await env.flush()
    assert len(env.events("user.domain.deleted.v1")) == 1
    # повтор саги новым запросом снова подтверждается; новые вызовы ученика — без user_id
    await env.bus.publish(_request(learner))
    await env.flush()
    assert len(env.events("user.domain.deleted.v1")) == 2
    await env.ok(user_id=learner)
    assert (await env.usage())[-1]["user_id"] is None
    # повтор старого request_id после удаления — не из кеша (стёрт), а новым вызовом
    r = await env.invoke(user_id=learner, request_id=rid)
    assert r.status_code == 200 and r.headers.get("idempotent-replay") is None


async def test_deletion_from_other_producer_ignored(env) -> None:
    learner = uuid.uuid4()
    await env.ok(user_id=learner)
    await env.bus.publish(_request(learner, producer="lessons"))
    await env.flush()
    assert (await env.usage())[0]["user_id"] == learner
    assert not env.events("user.domain.deleted.v1")
