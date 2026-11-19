"""Результат диагностики (AT-33, AT-34): профиль, рекомендация старта по снимку курса (и без catalog), событие
diagnostics.completed.v1, уточнение-ревизия и окно 24 ч, повтор через retest_days, история без перезаписи,
неизменяемость результатов."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from conftest import area_of, assert_no_keys, make_settings
from dx_testkit import always, seed_snapshot, up_to
from sqlalchemy.exc import DBAPIError

from tilhero_diagnostics.engine import FOLLOWUP_THRESHOLD


def wrong_first_vocabulary() -> tuple[set[str], object]:
    """Неровный словарь: первое задание словаря неверно, остальное верно → needs_followup (уверенность 0,33)."""
    seen: set[str] = set()

    def policy(item):
        if item["area"] == "vocabulary" and not seen:
            seen.add(item["item_id"])
            return "wrong"
        return "correct"

    return seen, policy


async def test_result_event_and_recommendation(env, user) -> None:
    result = await env.complete(user, up_to("A1"))
    assert result["revision"] == 1 and result["provisional_level"] == "A1" and result["weak_areas"] == []
    assert result["recommended_start"] is not None
    assert set(result["recommended_start"]) == {"lesson_id", "title", "level"}
    [ev] = await env.events("diagnostics.completed.v1", user)
    p = ev.payload
    assert (p["result_id"], p["revision"], p["test_id"], p["test_version"], p["pair_id"]) == (
        result["result_id"], 1, "dx-en-adult", 1, "ru-en")
    assert p["provisional_level"] == "A1" and p["recommended_start_lesson_id"] == result["recommended_start"][
        "lesson_id"]
    assert p["areas"]["speaking"] == {"status": "not_assessed", "band": None, "confidence": None}
    assert p["areas"]["grammar"]["status"] == "assessed" and p["areas"]["grammar"]["band"] == "A1"
    assert "evidence" not in str(p)  # в событии — без заданий и ответов
    # снимок курса берётся через catalog с ETag: второй прогон — If-None-Match
    snapshot_calls = [c for c in env.catalog.calls if c[0].endswith("/snapshot")]
    assert snapshot_calls and snapshot_calls[0][1] is None


async def test_catalog_down_result_saved_without_recommendation(env, user) -> None:
    env.catalog.down = True
    result = await env.complete(user, always("correct"))
    assert result["recommended_start"] is None and result["provisional_level"] == "B2"
    [ev] = await env.events("diagnostics.completed.v1", user)
    assert ev.payload["recommended_start_lesson_id"] is None
    # навыки без снимка — по skill_ids заданий
    [(n,)] = await env.sql("SELECT count(*) FROM skill_states WHERE user_id = :u AND state = 'demonstrated'", u=user)
    assert n > 0


async def test_snapshot_cache_uses_etag(env) -> None:
    for _ in range(2):
        await env.complete(uuid.uuid4(), always("correct"))
    calls = [c for c in env.catalog.calls if c[0].endswith("/snapshot")]
    assert [c[1] for c in calls] == [None, '"snap-1"']
    # catalog упал после кеширования — используется последний снимок
    env.catalog.down = True
    result = await env.complete(uuid.uuid4(), always("wrong"))
    assert result["recommended_start"]["lesson_id"] == "l-01-greetings"


async def test_followup_creates_revision_and_keeps_previous(env, user) -> None:
    _, policy = wrong_first_vocabulary()
    first = await env.complete(user, policy)
    vocab = area_of(first, "vocabulary")
    assert vocab["needs_followup"] and vocab["confidence"] < float(FOLLOWUP_THRESHOLD)
    assert [a["area"] for a in first["areas"] if a["needs_followup"]] == ["vocabulary"]
    rid = first["result_id"]
    # не та область / чужой результат / неизвестная область
    r = await env.c.post(f"/internal/v1/diagnostics/results/{rid}/followup", json={"area": "grammar"},
                         headers=env.h(user))
    assert r.status_code == 409 and r.json()["details"] == {"area": "grammar", "reason": "not_needed"}
    r = await env.c.post(f"/internal/v1/diagnostics/results/{rid}/followup", json={"area": "vocabulary"},
                         headers=env.h(uuid.uuid4()))
    assert r.status_code == 404 and r.json()["code"] == "DIAGNOSTIC_RESULT_NOT_FOUND"
    r = await env.c.post(f"/internal/v1/diagnostics/results/{rid}/followup", json={"area": "speaking"},
                         headers=env.h(user))
    assert r.status_code == 422
    env.now += timedelta(hours=23)
    r = await env.c.post(f"/internal/v1/diagnostics/results/{rid}/followup", json={"area": "vocabulary"},
                         headers=env.h(user))
    assert r.status_code == 201, r.text
    fu = r.json()
    assert fu["followup_area"] == "vocabulary" and fu["total_estimate"] == 3 and fu["answered"] == 0
    assert fu["test_version"] == first["test_version"]
    again = await env.c.post(f"/internal/v1/diagnostics/results/{rid}/followup", json={"area": "vocabulary"},
                             headers=env.h(user))
    assert again.status_code == 200 and again.json()["session_id"] == fu["session_id"]
    state = (await env.c.get("/internal/v1/diagnostics/state", headers=env.h(user))).json()
    assert state["status"] == "in_progress" and state["session"]["followup_area"] == "vocabulary"
    shown = await env.run(user, fu, always("correct"))
    assert len(shown) == 3 and {i["area"] for i in shown} == {"vocabulary"}
    rows = await env.sql("SELECT a.item_id FROM answers a JOIN results r ON r.session_id = a.session_id "
                         "WHERE r.result_id = :r AND a.area = 'vocabulary'", r=uuid.UUID(rid))
    assert len(rows) == 6
    assert not {i for (i,) in rows} & {i["item_id"] for i in shown}  # уточнение — новые задания
    second = await env.finish(user, fu)
    assert second["result_id"] == rid and second["revision"] == 2
    assert sum(e["answered"] for e in area_of(second, "vocabulary")["evidence"]) == 9
    assert area_of(second, "grammar") == area_of(first, "grammar")
    # прежняя ревизия сохранена и доступна; по умолчанию — последняя
    r1 = await env.c.get(f"/internal/v1/diagnostics/results/{rid}", params={"revision": 1}, headers=env.h(user))
    assert r1.json() == first
    latest = await env.c.get(f"/internal/v1/diagnostics/results/{rid}", headers=env.h(user))
    assert latest.json() == second
    history = (await env.c.get("/internal/v1/diagnostics/results", headers=env.h(user))).json()["items"]
    assert [(h["result_id"], h["revision"]) for h in history] == [(rid, 2)]
    events = await env.events("diagnostics.completed.v1", user)
    assert [(e.payload["result_id"], e.payload["revision"]) for e in events] == [(rid, 1), (rid, 2)]
    # одно уточнение на область
    r = await env.c.post(f"/internal/v1/diagnostics/results/{rid}/followup", json={"area": "vocabulary"},
                         headers=env.h(user))
    if area_of(second, "vocabulary")["needs_followup"]:
        assert r.status_code == 409 and r.json()["details"]["reason"] == "already_done"
    else:
        assert r.status_code == 409 and r.json()["details"]["reason"] == "not_needed"
    r = await env.c.get(f"/internal/v1/diagnostics/results/{rid}", params={"revision": 3}, headers=env.h(user))
    assert r.status_code == 404


async def test_followup_window_is_24h(env, user) -> None:
    _, policy = wrong_first_vocabulary()
    first = await env.complete(user, policy)
    env.now += timedelta(hours=24, seconds=1)
    r = await env.c.post(f"/internal/v1/diagnostics/results/{first['result_id']}/followup",
                         json={"area": "vocabulary"}, headers=env.h(user))
    assert r.status_code == 409 and r.json()["details"]["reason"] == "window_closed"


async def test_new_diagnostic_abandons_open_followup(env, user) -> None:
    _, policy = wrong_first_vocabulary()
    first = await env.complete(user, policy)
    r = await env.c.post(f"/internal/v1/diagnostics/results/{first['result_id']}/followup",
                         json={"area": "vocabulary"}, headers=env.h(user))
    fu = r.json()
    env.now += timedelta(days=14)
    await env.start(user)
    r = await env.c.get(f"/internal/v1/diagnostics/sessions/{fu['session_id']}/next", headers=env.h(user))
    assert r.status_code == 409 and r.json()["details"] == {"status": "abandoned"}


async def test_retest_too_soon_then_allowed_history_kept(env, user) -> None:
    first = await env.complete(user, up_to("A0"))
    env.now += timedelta(days=13, hours=23)
    r = await env.c.post("/internal/v1/diagnostics/sessions", headers={**env.h(user), "Idempotency-Key": "k-retest-1"})
    assert r.status_code == 409 and r.json()["code"] == "DIAGNOSTIC_TOO_SOON"
    assert r.json()["details"] == {"next_allowed_at": "2026-12-03T07:00:00Z"}
    state = (await env.c.get("/internal/v1/diagnostics/state", headers=env.h(user))).json()
    assert state["next_allowed_at"] == "2026-12-03T07:00:00Z"
    env.now += timedelta(hours=1)
    second = await env.complete(user, up_to("B1"))
    assert second["result_id"] != first["result_id"] and second["provisional_level"] == "B1"
    history = (await env.c.get("/internal/v1/diagnostics/results", headers=env.h(user))).json()["items"]
    assert [h["result_id"] for h in history] == [second["result_id"], first["result_id"]]
    assert history[1] == first  # прошлый результат не перезаписан
    r = await env.c.get("/internal/v1/diagnostics/results", params={"limit": 1}, headers=env.h(user))
    assert [h["result_id"] for h in r.json()["items"]] == [second["result_id"]]
    assert_no_keys(history)


async def test_retest_days_setting_overrides_test(env, user) -> None:
    env.runtime.settings = make_settings(database_url=env.settings.database_url, db_schema=env.settings.db_schema,
                                         diag_retest_days=3)
    await env.complete(user, up_to("A1"))
    env.now += timedelta(days=3)
    await env.start(user)


async def test_results_are_immutable(env, user) -> None:
    result = await env.complete(user, up_to("A2"))
    for stmt in ("UPDATE results SET provisional_level = 'B2'", "UPDATE answers SET correct = NOT correct",
                 "UPDATE skill_evidence SET outcome = 'positive'"):
        with pytest.raises(DBAPIError, match="append-only"):
            await env.sql(stmt)
    r = await env.c.get(f"/internal/v1/diagnostics/results/{result['result_id']}", headers=env.h(user))
    assert r.json() == result


async def test_results_isolation_and_validation(env, user) -> None:
    result = await env.complete(user, up_to("A1"))
    other = uuid.uuid4()
    r = await env.c.get(f"/internal/v1/diagnostics/results/{result['result_id']}", headers=env.h(other))
    assert r.status_code == 404
    assert (await env.c.get("/internal/v1/diagnostics/results", headers=env.h(other))).json() == {"items": []}
    r = await env.c.get("/internal/v1/diagnostics/results", params={"limit": 0}, headers=env.h(user))
    assert r.status_code == 422
    r = await env.c.get(f"/internal/v1/diagnostics/results/{result['result_id']}", params={"revision": 0},
                        headers=env.h(user))
    assert r.status_code == 422


async def test_recommendation_on_real_course_snapshot(env) -> None:
    """Живой путь: снимок курса из сида catalog (через catalog), seed-0000 — A2-ученик получает урок уровня A2,
    а не l-01-greetings (A0); B2 — первый не освоенный урок высшего уровня курса; ребёнок — детский урок."""
    snap = seed_snapshot()
    if snap is None:
        pytest.skip("нет сида catalog")
    env.catalog.snapshot = snap
    env.catalog.etag = '"catalog-seed"'
    env.fixed_seed = "seed-0000"
    a2 = await env.complete(uuid.uuid4(), up_to("A2"))
    assert a2["provisional_level"] == "A2"
    assert a2["recommended_start"]["lesson_id"] == "l-13-flight-check-in" and a2["recommended_start"]["level"] == "A2"
    b2 = await env.complete(uuid.uuid4(), always("correct"))
    assert (b2["provisional_level"], b2["recommended_start"]["lesson_id"]) == ("B2", "l-13-flight-check-in")
    zero = await env.complete(uuid.uuid4(), always("wrong"))
    assert (zero["provisional_level"], zero["recommended_start"]["lesson_id"]) == ("A0", "l-01-greetings")
    kid = await env.complete(uuid.uuid4(), up_to("A2"), audience="kids")
    assert kid["recommended_start"]["lesson_id"] == "l-02-where-from"
    events = await env.events("diagnostics.completed.v1")
    assert [e.payload["recommended_start_lesson_id"] for e in events] == [
        "l-13-flight-check-in", "l-13-flight-check-in", "l-01-greetings", "l-02-where-from"]


async def test_stored_item_level_evidence_is_folded_by_band(env, user) -> None:
    """Ревизия, сохранённая в прежнем формате (отметки по заданиям), неизменяема — при чтении отдаётся основаниями
    по полосам, без item_id; not_assessed — []."""
    import json as _json

    sid, rid = uuid.uuid4(), uuid.uuid4()
    old_profile = {"areas": [
        {"area": "vocabulary", "status": "assessed", "band": "A2", "confidence": 1.0, "reason": None,
         "needs_followup": False, "evidence": [{"item_id": "v-a1-01", "band": "A1", "correct": True},
                                               {"item_id": "v-a2-02", "band": "A2", "correct": True},
                                               {"item_id": "v-b1-01", "band": "B1", "correct": False},
                                               {"item_id": "v-a2-03", "band": "A2", "correct": True}]},
        {"area": "grammar", "status": "not_assessed", "band": None, "confidence": None, "reason": "too_few_items",
         "needs_followup": False, "evidence": [{"item_id": "g-a1-01", "band": "A1", "correct": True}]},
    ], "weak_areas": ["grammar"], "recommended_start": None}
    await env.sql(
        "INSERT INTO sessions (session_id, user_id, pair_id, test_id, test_version, seed, segment, status, "
        "started_at, expires_at, finished_at) VALUES (:s, :u, 'ru-en', 'dx-en-adult', 1, 'seed', 'adults', "
        "'finished', :t, :t, :t)", s=sid, u=user, t=env.now)
    await env.sql(
        "INSERT INTO results (result_id, revision, session_id, user_id, pair_id, test_id, test_version, profile, "
        "created_at) VALUES (:r, 1, :s, :u, 'ru-en', 'dx-en-adult', 1, CAST(:p AS jsonb), :t)",
        r=rid, s=sid, u=user, p=_json.dumps(old_profile), t=env.now)
    for r in (await env.c.get(f"/internal/v1/diagnostics/results/{rid}", headers=env.h(user)),
              await env.c.get("/internal/v1/diagnostics/results", headers=env.h(user))):
        assert r.status_code == 200, r.text
        assert "item_id" not in r.text
    body = (await env.c.get(f"/internal/v1/diagnostics/results/{rid}", headers=env.h(user))).json()
    assert area_of(body, "vocabulary")["evidence"] == [
        {"band": "A1", "answered": 1, "correct": 1}, {"band": "A2", "answered": 2, "correct": 2},
        {"band": "B1", "answered": 1, "correct": 0}]
    assert area_of(body, "grammar")["evidence"] == []
    state = (await env.c.get("/internal/v1/diagnostics/state", headers=env.h(user))).json()
    assert "item_id" not in str(state)


async def test_unassessed_results_are_limited_per_retest_window(env, user) -> None:
    """Результаты без оценённой области повтор не блокируют, но не больше 3 за retest_days; 4-я попытка — 409
    DIAGNOSTIC_TOO_SOON {next_allowed_at = самый ранний из них + retest_days}; state показывает тот же срок."""
    first_at = env.now
    for k in range(3):
        session = await env.start(user)
        await env.run(user, session, always("correct"), limit=1)
        result = await env.finish(user, session)
        assert all(a["status"] == "not_assessed" for a in result["areas"])
        state = (await env.c.get("/internal/v1/diagnostics/state", headers=env.h(user))).json()
        if k < 2:
            assert state["next_allowed_at"] is None
        env.now += timedelta(hours=1)
    expected = (first_at + timedelta(days=14)).isoformat().replace("+00:00", "Z")
    r = await env.c.post("/internal/v1/diagnostics/sessions", headers={**env.h(user), "Idempotency-Key": "k-4th-001"})
    assert r.status_code == 409 and r.json()["code"] == "DIAGNOSTIC_TOO_SOON"
    assert r.json()["details"] == {"next_allowed_at": expected}
    state = (await env.c.get("/internal/v1/diagnostics/state", headers=env.h(user))).json()
    assert state["next_allowed_at"] == expected
    # самый ранний выпал из окна — снова можно (в окне осталось два)
    env.now = first_at + timedelta(days=14)
    await env.start(user)
    # другой ученик не затронут
    await env.start(uuid.uuid4())
