"""Admin API диагностики: тесты и версии (content.read, с ключами), публикация (content.publish) с аудитом,
неизменяемость опубликованного, сессии на своей версии, статистика (dashboard.read); 401/403/404/422."""

from __future__ import annotations

import json
import uuid
from datetime import timedelta

import pytest
from dx_testkit import always, up_to
from sqlalchemy.exc import DBAPIError

from tilhero_common.messaging import make_envelope

BASE = "/admin/v1/diagnostics"


async def add_draft(env, version: int = 2, *, mutate=None) -> None:
    [(config, items)] = await env.sql(
        "SELECT config, items FROM tests WHERE test_id = 'dx-en-adult' AND version = 1")
    items = [dict(i) for i in items]
    if mutate:
        mutate(config, items)
    await env.sql(
        "INSERT INTO tests (test_id, version, status, pair_id, audience, config, items, checksum, created_by) "
        "VALUES ('dx-en-adult', :v, 'draft', 'ru-en', 'adults', CAST(:c AS jsonb), CAST(:i AS jsonb), :h, 'm')",
        v=version, c=json.dumps(config), i=json.dumps(items), h=f"draft-{version}")


async def test_list_and_version_with_keys(env) -> None:
    h = env.staff("content.read")
    r = await env.c.get(f"{BASE}/tests", headers=h)
    assert r.status_code == 200, r.text
    rows = {row["test_id"]: row for row in r.json()["items"]}
    assert set(rows) == {"dx-en-adult", "dx-en-kids"}
    adult = rows["dx-en-adult"]
    assert adult["pair_id"] == "ru-en" and adult["audience"] == "adults" and adult["published_version"] == 1
    assert adult["versions"] == [{"version": 1, "status": "published", "items": adult["versions"][0]["items"],
                                  "published_at": "2026-11-19T06:00:00Z"}]
    r = await env.c.get(f"{BASE}/tests/dx-en-kids/versions/1", headers=h)
    body = r.json()
    assert body["status"] == "published" and body["config"]["min_correct_per_band"] == 1
    assert all("answer" in i for i in body["items"])  # сотруднику — с ключами
    assert set(body["coverage"]) == {"vocabulary", "grammar", "reading", "listening"}
    assert sum(sum(b.values()) for b in body["coverage"].values()) == len(body["items"])
    assert body["coverage"]["vocabulary"]["B2"] == 0
    for path in (f"{BASE}/tests/dx-en-kids/versions/9", f"{BASE}/tests/nope/versions/1"):
        r = await env.c.get(path, headers=h)
        assert r.status_code == 404 and r.json()["code"] == "DIAGNOSTIC_TEST_NOT_FOUND"
    for path in (f"{BASE}/tests/dx-en-kids/versions/0", f"{BASE}/tests/BAD!/versions/1"):
        assert (await env.c.get(path, headers=h)).status_code == 422


async def test_admin_authz(env) -> None:
    cases = [("GET", f"{BASE}/tests", None, "content.read"),
             ("GET", f"{BASE}/tests/dx-en-adult/versions/1", None, "content.read"),
             ("POST", f"{BASE}/tests/dx-en-adult/versions/1/publish", {"reason": "Повтор"}, "content.publish"),
             ("GET", f"{BASE}/stats", None, "dashboard.read"),
             ("GET", f"{BASE}/pairs", None, "content.read")]
    for method, path, body, perm in cases:
        r = await env.c.request(method, path, json=body)
        assert r.status_code == 401, path
        r = await env.c.request(method, path, json=body, headers=env.staff(perm, issuer="telegram-bff", actor=False))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", path
        r = await env.c.request(method, path, json=body, headers=env.staff(perm, actor=False))
        assert r.status_code == 403 and r.json()["code"] == "STAFF_CONTEXT_REQUIRED", path
        r = await env.c.request(method, path, json=body, headers=env.staff("content.edit", "users.read"))
        assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED", path
        assert r.json()["details"] == {"permission": perm}
        r = await env.c.request(method, path, json=body, headers=env.staff(perm))
        assert r.status_code == 200, (path, r.text)
    # content.read не даёт публиковать
    r = await env.c.post(f"{BASE}/tests/dx-en-adult/versions/1/publish", json={"reason": "Публикую"},
                         headers=env.staff("content.read"))
    assert r.status_code == 403


async def test_publish_new_version_archives_previous_and_sessions_keep_version(env) -> None:
    learner = uuid.uuid4()
    old_session = await env.start(learner)
    await env.run(learner, old_session, up_to("A1"), limit=5)
    await add_draft(env)
    h = env.staff("content.publish")
    r = await env.c.post(f"{BASE}/tests/dx-en-adult/versions/2/publish", json={"reason": "Новая версия банка"},
                         headers=h)
    assert r.status_code == 200, r.text
    row = r.json()
    assert row["published_version"] == 2
    assert [(v["version"], v["status"]) for v in row["versions"]] == [(1, "archived"), (2, "published")]
    audits = await env.events("admin.audit.recorded.v1")
    published = [e for e in audits if e.payload["actor_type"] == "staff"]
    assert len(published) == 1
    p = published[0].payload
    assert (p["action"], p["object_type"], p["object_id"], p["reason"]) == (
        "diagnostics.test_published", "diagnostic_test", "dx-en-adult@2", "Новая версия банка")
    assert p["before"] == {"status": "draft", "published": ["dx-en-adult@1"]}
    assert "items" in p["after"] and "answer" not in json.dumps(p)
    # повтор — без изменений и без второй записи аудита
    r = await env.c.post(f"{BASE}/tests/dx-en-adult/versions/2/publish", json={"reason": "Новая версия банка"},
                         headers=h)
    assert r.status_code == 200 and r.json() == row
    assert len([e for e in await env.events("admin.audit.recorded.v1") if e.payload["actor_type"] == "staff"]) == 1
    # начатая сессия идёт на своей версии, новая — на новой
    rest = await env.run(learner, old_session, up_to("A1"))
    assert len(rest) == 19
    assert (await env.finish(learner, old_session))["test_version"] == "dx-en-adult@1"
    fresh = await env.start(uuid.uuid4())
    assert fresh["test_version"] == "dx-en-adult@2"
    # откат: архивная v1 снова публикуется
    r = await env.c.post(f"{BASE}/tests/dx-en-adult/versions/1/publish", json={"reason": "Откат"}, headers=h)
    assert [(v["version"], v["status"]) for v in r.json()["versions"]] == [(1, "published"), (2, "archived")]


async def test_publish_invalid_version_and_errors(env) -> None:
    def break_it(config, items):
        items[0]["answer"] = 42

    await add_draft(env, mutate=break_it)
    h = env.staff("content.publish")
    r = await env.c.post(f"{BASE}/tests/dx-en-adult/versions/2/publish", json={"reason": "Публикую"}, headers=h)
    assert r.status_code == 422 and r.json()["code"] == "TEST_INVALID"
    assert {e["code"] for e in r.json()["details"]["errors"]} == {"ANSWER_INVALID"}
    rows = await env.sql("SELECT version, status FROM tests WHERE test_id = 'dx-en-adult' ORDER BY version")
    assert [tuple(r) for r in rows] == [(1, "published"), (2, "draft")]
    r = await env.c.post(f"{BASE}/tests/dx-en-adult/versions/7/publish", json={"reason": "Публикую"}, headers=h)
    assert r.status_code == 404
    for body in ({}, {"reason": "x"}, {"reason": "Публикую", "force": True}):
        r = await env.c.post(f"{BASE}/tests/dx-en-adult/versions/2/publish", json=body, headers=h)
        assert r.status_code == 422, body


async def test_published_tests_are_immutable_in_db(env) -> None:
    with pytest.raises(DBAPIError, match="immutable"):
        await env.sql("UPDATE tests SET items = '[]'::jsonb WHERE test_id = 'dx-en-kids'")
    with pytest.raises(DBAPIError, match="cannot be deleted"):
        await env.sql("DELETE FROM tests WHERE test_id = 'dx-en-kids'")
    with pytest.raises(DBAPIError, match="not allowed"):
        await env.sql("UPDATE tests SET status = 'draft' WHERE test_id = 'dx-en-kids'")
    await add_draft(env)
    await env.sql("UPDATE tests SET created_by = 'other' WHERE test_id = 'dx-en-adult' AND version = 2")


async def test_stats(env) -> None:
    h = env.staff("dashboard.read")
    r = await env.c.get(f"{BASE}/stats", params={"period": "7d"}, headers=h)
    assert r.json() == {"period": "7d", "started": 0, "finished": 0, "median_minutes": None,
                        "by_level": {"A0": 0, "A1": 0, "A2": 0, "B1": 0, "B2": 0, "none": 0},
                        "not_assessed_pct": {"vocabulary": 0.0, "grammar": 0.0, "reading": 0.0, "listening": 0.0},
                        "followups": 0}
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    s = await env.start(a)
    await env.run(a, s, up_to("A2"))
    env.now += timedelta(minutes=12)
    await env.finish(a, s)
    s = await env.start(b)
    await env.c.post(f"/internal/v1/diagnostics/sessions/{s['session_id']}/listening-unavailable",
                     headers=env.h(b))
    await env.run(b, s, always("correct"))
    env.now += timedelta(minutes=8)
    await env.finish(b, s)
    await env.start(c)  # начата, не завершена
    r = await env.c.get(f"{BASE}/stats", params={"period": "today"}, headers=h)
    body = r.json()
    assert (body["started"], body["finished"], body["median_minutes"]) == (3, 2, 10.0)
    assert body["by_level"] == {"A0": 0, "A1": 0, "A2": 1, "B1": 0, "B2": 1, "none": 0}
    assert body["not_assessed_pct"] == {"vocabulary": 0.0, "grammar": 0.0, "reading": 0.0, "listening": 50.0}
    assert body["followups"] == 0
    r = await env.c.get(f"{BASE}/stats", params={"period": "1y"}, headers=h)
    assert r.status_code == 422


async def add_result(env, user: uuid.UUID, pair_id: str, revisions: int = 1) -> None:
    """Результат по другой паре (через API пока доступна только ru-en) — прямо в БД."""
    sid, rid = uuid.uuid4(), uuid.uuid4()
    await env.sql(
        "INSERT INTO sessions (session_id, user_id, pair_id, test_id, test_version, seed, segment, status, "
        "started_at, expires_at, finished_at) VALUES (:s, :u, :p, 'dx-en-adult', 1, 'seed', 'adults', 'finished', "
        ":t, :t, :t)", s=sid, u=user, p=pair_id, t=env.now)
    for revision in range(1, revisions + 1):
        rsid = sid if revision == 1 else uuid.uuid4()
        if revision > 1:
            await env.sql(
                "INSERT INTO sessions (session_id, user_id, pair_id, test_id, test_version, seed, segment, status, "
                "followup_area, result_id, started_at, expires_at, finished_at) VALUES (:s, :u, :p, 'dx-en-adult', "
                "1, 'seed', 'adults', 'finished', 'grammar', :r, :t, :t, :t)", s=rsid, u=user, p=pair_id, r=rid,
                t=env.now)
        await env.sql(
            "INSERT INTO results (result_id, revision, session_id, user_id, pair_id, test_id, test_version, profile, "
            "created_at) VALUES (:r, :v, :s, :u, :p, 'dx-en-adult', 1, '{}'::jsonb, :t)",
            r=rid, v=revision, s=rsid, u=user, p=pair_id, t=env.now)


async def test_pair_learners(env) -> None:
    h = env.staff("content.read")
    r = await env.c.get(f"{BASE}/pairs", headers=h)
    assert r.status_code == 200 and r.json() == {"items": []}
    a, b, started_only, deleted, other_pair_only, racing = (uuid.uuid4() for _ in range(6))
    # a: результат с ревизией уточнения + повторная диагностика через 14 дней — один ученик
    seen: set[str] = set()

    def wrong_first_vocabulary(item):
        if item["area"] == "vocabulary" and not seen:
            seen.add(item["item_id"])
            return "wrong"
        return "correct"

    first = await env.complete(a, wrong_first_vocabulary)
    r = await env.c.post(f"/internal/v1/diagnostics/results/{first['result_id']}/followup",
                         json={"area": "vocabulary"}, headers=env.h(a))
    fu = r.json()
    await env.run(a, fu, always("correct"))
    assert (await env.finish(a, fu))["revision"] == 2
    env.now += timedelta(days=14)
    await env.complete(a, up_to("A2"))
    [(rows,)] = await env.sql("SELECT count(*) FROM results WHERE user_id = :u", u=a)
    assert rows == 3
    await env.complete(b, always("correct"))
    await env.start(started_only)  # без результата — не считается
    await env.complete(deleted, always("wrong"))
    await env.bus.publish(make_envelope("user.deletion.requested.v1", {
        "user_id": str(deleted), "request_id": str(uuid.uuid4()), "requested_at": "2026-11-19T09:00:00Z"},
        producer="identity-consent"))
    # изоляция по парам: результаты ru-uz не влияют на ru-en и наоборот
    await add_result(env, a, "ru-uz", revisions=2)
    await add_result(env, other_pair_only, "ru-uz")
    # отметка удаления при ещё не удалённых строках (гонка с сагой) — не считается
    await add_result(env, racing, "ru-uz")
    await env.sql("INSERT INTO deleted_users (user_id, request_id) VALUES (:u, :r)", u=racing, r=uuid.uuid4())
    r = await env.c.get(f"{BASE}/pairs", headers=h)
    assert r.status_code == 200, r.text
    assert r.json() == {"items": [{"pair_id": "ru-en", "learners": 2}, {"pair_id": "ru-uz", "learners": 2}]}
