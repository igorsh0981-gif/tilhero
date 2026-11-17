"""API саги удаления (INTERNAL_API §1.4): админ-список, деталь, ручной повтор (admin-bff), stats (ops-monitor).

На эндпоинт: happy path, 401, 403 (чужой вызывающий / нет права / лишний контекст), 404, 409/422, идемпотентность."""

from __future__ import annotations

import asyncio
import io
import logging
import uuid
from datetime import timedelta

import httpx
from deletion_kit import (
    DOMAINS,
    OPERATOR,
    READER,
    REASON,
    ack_all,
    attempts,
    backdate_last_sent,
    bff,
    cmd,
    load,
    request_deletion,
    requested_events,
    sweep_at,
)

from tilhero_common.internal_auth import Actor
from tilhero_common.logging import JsonFormatter
from tilhero_common.testing import internal_headers

LIST = "/admin/v1/deletions"
STATS = "/internal/v1/deletions:stats"


def retry_path(rid: str) -> str:
    return f"{LIST}/{rid}:retry"


# ---------------------------------------------------------------- список и деталь

async def test_list_filters_and_pagination(env) -> None:
    done_uid, done = await request_deletion(env)
    await ack_all(env, done_uid, done)
    _, stuck = await request_deletion(env)
    await sweep_at(env, stuck, hours=24)
    _, fresh = await request_deletion(env)

    r = await env.client.get(LIST, headers=bff(env, READER))
    assert r.status_code == 200, r.text
    body = r.json()
    assert [i["request_id"] for i in body["items"]] == [fresh, stuck, done] and body["next_cursor"] is None
    row = body["items"][0]
    assert set(row) == {"request_id", "user_id", "status", "requested_at", "completed_at", "stuck_at", "attempts",
                        "next_retry_at", "acked", "expected", "pending_domains"}
    assert (row["status"], row["acked"], row["expected"], row["attempts"]) == ("REQUESTED", 0, 9, 1)
    assert row["pending_domains"] == DOMAINS and row["requested_at"].endswith("Z")
    by_id = {i["request_id"]: i for i in body["items"]}
    assert by_id[stuck]["status"] == "STUCK" and by_id[stuck]["stuck_at"] is not None
    assert by_id[done]["status"] == "COMPLETED" and by_id[done]["next_retry_at"] is None
    assert (by_id[done]["acked"], by_id[done]["pending_domains"]) == (9, [])

    async def ids(query: dict) -> list[str]:
        resp = await env.client.get(LIST, params=query, headers=bff(env, READER))
        assert resp.status_code == 200, resp.text
        return [i["request_id"] for i in resp.json()["items"]]

    assert await ids({"status": "open"}) == [fresh, stuck]
    assert await ids({"status": "stuck"}) == [stuck]
    assert await ids({"status": "completed"}) == [done]

    page1 = (await env.client.get(LIST, params={"limit": 2}, headers=bff(env, READER))).json()
    assert [i["request_id"] for i in page1["items"]] == [fresh, stuck] and page1["next_cursor"]
    page2 = (await env.client.get(LIST, params={"limit": 2, "cursor": page1["next_cursor"]},
                                  headers=bff(env, READER))).json()
    assert [i["request_id"] for i in page2["items"]] == [done] and page2["next_cursor"] is None

    for query in ({"status": "REQUESTED"}, {"limit": 0}, {"limit": 101}, {"cursor": "!!"}, {"cursor": "e30"}):
        resp = await env.client.get(LIST, params=query, headers=bff(env, READER))
        assert resp.status_code == 422, query


async def test_detail_domains_and_history(env) -> None:
    uid, rid = await request_deletion(env)
    await ack_all(env, uid, rid, ["support"])
    await sweep_at(env, rid, minutes=15)
    r = await env.client.get(f"{LIST}/{rid}", headers=bff(env, READER))
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["attempts"] == 2 and d["acked"] == 1 and d["user_id"] == uid
    assert [x["domain"] for x in d["domains"]] == DOMAINS
    support = next(x for x in d["domains"] if x["domain"] == "support")
    assert support["acked"] is True and support["mode"] == "deleted" and support["acked_at"].endswith("Z")
    assert all(x["acked_at"] is None and x["mode"] is None and x["acked"] is False
               for x in d["domains"] if x["domain"] != "support")
    assert [(h["attempt"], h["by"]) for h in d["history"]] == [(1, "user"), (2, "system")]
    # PII в ответе нет: ни Telegram ID, ни username, ни имени
    assert "demo_user" not in r.text and "Тест" not in r.text

    missing = await env.client.get(f"{LIST}/{uuid.uuid4()}", headers=bff(env, READER))
    assert missing.status_code == 404 and missing.json()["code"] == "DELETION_NOT_FOUND"
    assert (await env.client.get(f"{LIST}/not-a-uuid", headers=bff(env, READER))).status_code == 422


async def test_read_access_control(env) -> None:
    _, rid = await request_deletion(env)
    for path in (LIST, f"{LIST}/{rid}"):
        assert (await env.client.get(path)).status_code == 401
        bad = await env.client.get(path, headers={"X-Internal-Token": "garbage"})
        assert bad.status_code == 401
        for issuer in ("telegram-bff", "ops-monitor", "user-admin"):
            resp = await env.client.get(path, headers=internal_headers(env.settings, issuer=issuer, actor=READER))
            assert resp.status_code == 403 and resp.json()["code"] == "CALLER_NOT_ALLOWED", (path, issuer)
        no_actor = await env.client.get(path, headers=bff(env, None))
        assert no_actor.status_code == 403 and no_actor.json()["code"] == "STAFF_CONTEXT_REQUIRED"
        nobody = Actor(id=str(uuid.uuid4()), role="analyst", permissions=frozenset({"dashboard.read"}))
        denied = await env.client.get(path, headers=bff(env, nobody))
        assert denied.status_code == 403 and denied.json()["details"] == {"permission": "users.read"}


# ---------------------------------------------------------------- ручной повтор

async def test_manual_retry_happy_path_and_audit(env) -> None:
    uid, rid = await request_deletion(env)
    await ack_all(env, uid, rid, DOMAINS[:7])
    await backdate_last_sent(env, rid, 301)
    headers = cmd(env, "retry-key-0001")
    r = await env.client.post(retry_path(rid), json={"reason": f"  {REASON}  "}, headers=headers)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["attempts"] == 2 and d["pending_domains"] == ["ai-concierge", "ai-control"]
    assert d["history"][-1]["by"] == OPERATOR.id and "idempotent-replayed" not in r.headers
    [_, retry] = await requested_events(env, rid)
    assert retry.payload["attempt"] == 2 and retry.payload["request_id"] == rid
    req = await load(env, rid)
    assert req.last_retry_by == OPERATOR.id
    # расписание таймера: следующая точка после ручного повтора (а не сразу за ним)
    assert req.next_retry_at == req.requested_at + timedelta(minutes=15)
    [record] = env.audit.calls
    assert record["action"] == "user.deletion.retry" and record["object_type"] == "deletion_request"
    assert record["object_id"] == rid and record["reason"] == REASON
    assert record["on_behalf_of"] == {"actor_id": OPERATOR.id, "actor_role": "operations"}
    assert record["before"] == {"status": "REQUESTED", "attempts": 1, "pending_domains": ["ai-concierge",
                                                                                          "ai-control"]}
    assert record["after"] == {"attempt": 2, "user_id": uid}
    assert env.audit.issuers == ["identity-consent"]

    # повтор с тем же ключом и телом — тот же ответ, без нового аудита и рассылки
    replay = await env.client.post(retry_path(rid), json={"reason": REASON}, headers=headers)
    assert replay.status_code == 200 and replay.json() == d and replay.headers["idempotent-replayed"] == "true"
    assert len(env.audit.calls) == 1 and len(await requested_events(env, rid)) == 2
    # тот же ключ с другим телом — 422
    reused = await env.client.post(retry_path(rid), json={"reason": "другая причина"}, headers=headers)
    assert reused.status_code == 422 and reused.json()["code"] == "IDEMPOTENCY_KEY_REUSED"


async def test_manual_retry_too_soon_and_not_open(env) -> None:
    uid, rid = await request_deletion(env)
    r = await env.client.post(retry_path(rid), json={"reason": REASON}, headers=cmd(env))
    assert r.status_code == 409 and r.json()["code"] == "DELETION_RETRY_TOO_SOON"
    assert 295 <= r.json()["details"]["retry_after"] <= 300
    assert env.audit.calls == [] and (await load(env, rid)).attempts == 1
    # после повтора таймера — тоже не чаще раза в 5 минут
    await backdate_last_sent(env, rid, 600)
    assert (await env.client.post(retry_path(rid), json={"reason": REASON}, headers=cmd(env))).status_code == 200
    again = await env.client.post(retry_path(rid), json={"reason": REASON}, headers=cmd(env))
    assert again.status_code == 409 and again.json()["code"] == "DELETION_RETRY_TOO_SOON"

    await ack_all(env, uid, rid)
    await backdate_last_sent(env, rid, 600)
    closed = await env.client.post(retry_path(rid), json={"reason": REASON}, headers=cmd(env))
    assert closed.status_code == 409 and closed.json()["code"] == "DELETION_NOT_OPEN"
    missing = await env.client.post(retry_path(str(uuid.uuid4())), json={"reason": REASON}, headers=cmd(env))
    assert missing.status_code == 404 and missing.json()["code"] == "DELETION_NOT_FOUND"
    assert len(env.audit.calls) == 1


async def test_manual_retry_of_stuck_request(env) -> None:
    uid, rid = await request_deletion(env)
    await ack_all(env, uid, rid, DOMAINS[1:])
    await sweep_at(env, rid, hours=24)
    await backdate_last_sent(env, rid, 25 * 3600)  # тик был «через сутки» — сдвигаем его в прошлое
    r = await env.client.post(retry_path(rid), json={"reason": REASON}, headers=cmd(env))
    assert r.status_code == 200 and r.json()["status"] == "STUCK" and r.json()["pending_domains"] == ["preferences"]
    await ack_all(env, uid, rid, ["preferences"])
    d = (await env.client.get(f"{LIST}/{rid}", headers=bff(env, READER))).json()
    assert d["status"] == "COMPLETED" and d["stuck_at"] is not None


async def test_manual_retry_validation_and_access(env) -> None:
    _, rid = await request_deletion(env)
    await backdate_last_sent(env, rid, 600)
    path = retry_path(rid)
    assert (await env.client.post(path, json={"reason": REASON})).status_code == 401
    for issuer in ("telegram-bff", "ops-monitor"):
        h = internal_headers(env.settings, issuer=issuer, actor=OPERATOR)
        h["Idempotency-Key"] = "k" * 16
        assert (await env.client.post(path, json={"reason": REASON}, headers=h)).status_code == 403
    reader = await env.client.post(path, json={"reason": REASON}, headers=cmd(env, actor=READER))
    assert reader.status_code == 403 and reader.json()["details"] == {"permission": "ops.queues.manage"}
    no_actor = await env.client.post(path, json={"reason": REASON}, headers=cmd(env, actor=None))
    assert no_actor.status_code == 403
    no_key = await env.client.post(path, json={"reason": REASON}, headers=bff(env))
    assert no_key.status_code == 400 and no_key.json()["code"] == "IDEMPOTENCY_KEY_REQUIRED"
    for key in ("short", "x" * 129, "bad key with spaces"):
        bad = await env.client.post(path, json={"reason": REASON}, headers=cmd(env, key))
        assert bad.status_code == 422 and bad.json()["code"] == "IDEMPOTENCY_KEY_INVALID", key
    for body in ({}, {"reason": "ab"}, {"reason": "   ab   "}, {"reason": "x" * 301}, {"reason": REASON, "x": 1},
                 {"reason": 5}):
        assert (await env.client.post(path, json=body, headers=cmd(env))).status_code == 422, body
    assert (await env.client.post(f"{LIST}/nope:retry", json={"reason": REASON},
                                  headers=cmd(env))).status_code == 422
    assert env.audit.calls == [] and (await load(env, rid)).attempts == 1


async def test_manual_retry_audit_unavailable_changes_nothing(env) -> None:
    _, rid = await request_deletion(env)
    await backdate_last_sent(env, rid, 600)
    headers = cmd(env, "audit-down-0001")
    for failure in (503, httpx.ConnectError("down"), 403):
        env.audit.responses = [failure, failure]  # клиент audit делает один повтор
        r = await env.client.post(retry_path(rid), json={"reason": REASON}, headers=headers)
        assert r.status_code == 503 and r.json()["code"] == "AUDIT_UNAVAILABLE", failure
        assert (await load(env, rid)).attempts == 1 and len(await requested_events(env, rid)) == 1
        assert len(await attempts(env, rid)) == 1
    # audit поднялся — тот же ключ проходит (ключ при ошибке не занят)
    env.audit.responses = []
    ok = await env.client.post(retry_path(rid), json={"reason": REASON}, headers=headers)
    assert ok.status_code == 200 and ok.json()["attempts"] == 2 and "idempotent-replayed" not in ok.headers


async def test_concurrent_manual_retries(env) -> None:
    """Два сотрудника (разные ключи), обе команды прошли проверку и стоят в аудите одновременно (gate — без зависимости
    от тайминга раннера): повторная проверка под FOR UPDATE пропускает одну, вторая — 409 TOO_SOON. Аудит идёт до
    блокировки строки (ревью спринта 9) — журнал фиксирует обе попытки, рассылка одна."""
    _, rid = await request_deletion(env)
    await backdate_last_sent(env, rid, 600)
    before = len(await requested_events(env, rid))
    other = Actor(id=str(uuid.uuid4()), role="operations", permissions=frozenset({"ops.queues.manage"}))
    env.audit.gate = 2
    results = await asyncio.gather(
        env.client.post(retry_path(rid), json={"reason": REASON}, headers=cmd(env)),
        env.client.post(retry_path(rid), json={"reason": REASON}, headers=cmd(env, actor=other)),
    )
    assert sorted(r.status_code for r in results) == [200, 409], [r.text for r in results]
    assert next(r for r in results if r.status_code == 409).json()["code"] == "DELETION_RETRY_TOO_SOON"
    assert (await load(env, rid)).attempts == 2
    assert len(env.audit.calls) == 2 and len({c["record_id"] for c in env.audit.calls}) == 2
    assert len(await requested_events(env, rid)) == before + 1
    assert len(await attempts(env, rid)) == 2


async def test_sequential_manual_retries_second_refused_before_audit(env) -> None:
    """Второй сотрудник после того, как первый повтор уже записан: 409 TOO_SOON на проверке без блокировки — без
    вызова audit и без рассылки."""
    _, rid = await request_deletion(env)
    await backdate_last_sent(env, rid, 600)
    other = Actor(id=str(uuid.uuid4()), role="operations", permissions=frozenset({"ops.queues.manage"}))
    first = await env.client.post(retry_path(rid), json={"reason": REASON}, headers=cmd(env))
    assert first.status_code == 200
    second = await env.client.post(retry_path(rid), json={"reason": REASON}, headers=cmd(env, actor=other))
    assert second.status_code == 409 and second.json()["code"] == "DELETION_RETRY_TOO_SOON"
    assert (await load(env, rid)).attempts == 2 and len(env.audit.calls) == 1


async def test_same_key_concurrent_retries_one_send_one_replay(env) -> None:
    """Один ключ дважды, обе копии в аудите одновременно (gate): одна рассылка и один replay с тем же ответом; оба
    вызова audit несут один record_id (журнал запишет один раз). Повтор ключа после ответа — replay без audit."""
    _, rid = await request_deletion(env)
    await backdate_last_sent(env, rid, 600)
    before = len(await requested_events(env, rid))
    headers = cmd(env, "same-key-race-01")
    env.audit.gate = 2
    same = await asyncio.gather(*[env.client.post(retry_path(rid), json={"reason": REASON}, headers=headers)
                                  for _ in range(2)])
    assert [r.status_code for r in same] == [200, 200], [r.text for r in same]
    assert sorted(r.headers.get("idempotent-replayed", "false") for r in same) == ["false", "true"]
    assert same[0].json() == same[1].json()
    assert (await load(env, rid)).attempts == 2
    assert len(env.audit.calls) == 2 and len({c["record_id"] for c in env.audit.calls}) == 1
    assert len(await requested_events(env, rid)) == before + 1
    env.audit.gate = 0
    again = await env.client.post(retry_path(rid), json={"reason": REASON}, headers=headers)
    assert again.status_code == 200 and again.headers.get("idempotent-replayed") == "true"
    assert len(env.audit.calls) == 2 and (await load(env, rid)).attempts == 2


async def test_manual_retry_and_timer_race(env) -> None:
    """Таймер и сотрудник в одну секунду: без ошибок и дублей номера попытки; ручной повтор после повтора таймера —
    409 TOO_SOON, таймер после ручного повтора — следующая точка расписания."""
    for _ in range(4):
        uid, rid = await request_deletion(env)
        await backdate_last_sent(env, rid, 600)
        sweep, resp = await asyncio.gather(
            sweep_at(env, rid, minutes=15),
            env.client.post(retry_path(rid), json={"reason": REASON}, headers=cmd(env)),
        )
        assert resp.status_code in (200, 409), resp.text
        history = [(a.attempt, a.sent_by) for a in await attempts(env, rid)]
        manual = [a for a in history if a[1] == OPERATOR.id]
        system = [a for a in history if a[1] == "system"]
        assert len(manual) == (1 if resp.status_code == 200 else 0) and sweep.retried == len(system)
        assert [a[0] for a in history] == list(range(1, len(history) + 1)) and len(history) >= 2
        assert (await load(env, rid)).attempts == len(history) == len(await requested_events(env, rid))
        await ack_all(env, uid, rid)  # закрываем, чтобы следующий тик видел только новый запрос


# ---------------------------------------------------------------- deletions:stats (ops-monitor)

async def test_stats_for_ops_monitor(env) -> None:
    empty = await env.client.get(STATS, headers=internal_headers(env.settings, issuer="ops-monitor"))
    assert empty.status_code == 200
    assert empty.json() == {"open": 0, "stuck": 0, "oldest_open_at": None, "pending_by_domain": {},
                            "stuck_items": []}

    done_uid, done = await request_deletion(env)
    await ack_all(env, done_uid, done)
    s_uid, stuck = await request_deletion(env)
    await ack_all(env, s_uid, stuck, [d for d in DOMAINS if d != "watch"])
    await sweep_at(env, stuck, hours=24)
    o_uid, fresh = await request_deletion(env)
    await ack_all(env, o_uid, fresh, ["preferences", "support"])

    r = await env.client.get(STATS, headers=internal_headers(env.settings, issuer="ops-monitor"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["open"], body["stuck"]) == (2, 1)
    assert body["oldest_open_at"] == (await load(env, stuck)).requested_at.isoformat().replace("+00:00", "Z")
    expected_pending = {d: 1 for d in DOMAINS if d not in ("preferences", "support")}
    expected_pending["watch"] = 2
    assert body["pending_by_domain"] == dict(sorted(expected_pending.items()))
    [item] = body["stuck_items"]
    assert set(item) == {"request_id", "requested_at", "stuck_at", "attempts", "pending_domains"}
    assert (item["request_id"], item["attempts"], item["pending_domains"]) == (stuck, 2, ["watch"])
    # только числа, домены и request_id — без user_id
    for uid in (done_uid, s_uid, o_uid):
        assert uid not in r.text
    assert "user_id" not in r.text


async def test_stats_access_control(env) -> None:
    assert (await env.client.get(STATS)).status_code == 401
    for issuer in ("admin-bff", "telegram-bff", "user-admin", "audit"):
        r = await env.client.get(STATS, headers=internal_headers(env.settings, issuer=issuer, actor=OPERATOR))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    with_subject = await env.client.get(STATS, headers=internal_headers(env.settings, issuer="ops-monitor",
                                                                         subject=str(uuid.uuid4())))
    assert with_subject.status_code == 403 and with_subject.json()["code"] == "CALLER_CONTEXT_NOT_ALLOWED"


async def test_stats_limits_stuck_items(env) -> None:
    rids = []
    for _ in range(52):
        uid = str(uuid.uuid4())
        async with env.runtime.transaction() as s:
            from datetime import UTC, datetime

            from tilhero_identity.deletion.models import DeletionRequest
            from tilhero_identity.models import User

            now = datetime.now(UTC)
            s.add(User(user_id=uuid.UUID(uid), status="DELETION_REQUESTED"))
            await s.flush()
            rid = uuid.uuid4()
            s.add(DeletionRequest(request_id=rid, user_id=uuid.UUID(uid), status="STUCK", requested_at=now,
                                  stuck_at=now, expected_domains=["news"], acked_domains=[], attempts=6,
                                  last_sent_at=now, next_retry_at=now + timedelta(days=1)))
            rids.append(str(rid))
    body = (await env.client.get(STATS, headers=internal_headers(env.settings, issuer="ops-monitor"))).json()
    assert body["stuck"] == 52 and len(body["stuck_items"]) == 50 and body["pending_by_domain"] == {"news": 52}
    assert [i["request_id"] for i in body["stuck_items"]] == rids[:50]  # старые сверху


async def test_api_logs_have_no_pii(env) -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter("identity-consent"))
    logging.getLogger().addHandler(handler)
    try:
        _, rid = await request_deletion(env, telegram_user_id=4_404_404_404, username="canary_login")
        await backdate_last_sent(env, rid, 600)
        await env.client.post(retry_path(rid), json={"reason": REASON}, headers=cmd(env))
        await env.client.get(f"{LIST}/{rid}", headers=bff(env, READER))
        await env.client.get(LIST, headers=bff(env, READER))
        await env.client.get(STATS, headers=internal_headers(env.settings, issuer="ops-monitor"))
        env.audit.responses = [503, 503]
        await backdate_last_sent(env, rid, 600)
        await env.client.post(retry_path(rid), json={"reason": REASON}, headers=cmd(env))
    finally:
        logging.getLogger().removeHandler(handler)
    logs = stream.getvalue()
    assert "/admin/v1/deletions/{request_id}:retry" in logs  # access-лог — шаблон маршрута
    assert "4404404404" not in logs and "canary_login" not in logs and REASON not in logs
