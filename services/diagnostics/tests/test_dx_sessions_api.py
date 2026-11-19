"""Сессия диагностики через API (AT-32): подбор, ответы, идемпотентность, 24 ч, прерывание, ITEM_NOT_CURRENT,
аудирование без голоса, авторизация и изоляция учеников, ключи ответов не уходят ученику."""

from __future__ import annotations

import uuid
from datetime import timedelta

from conftest import area_of, assert_no_keys, by_area
from dx_testkit import always, up_to

AREAS = ["vocabulary", "grammar", "reading", "listening"]


async def test_full_adult_diagnostic_happy_path(env, user) -> None:
    r = await env.c.get("/internal/v1/diagnostics/state", headers=env.h(user))
    assert r.status_code == 200, r.text
    assert r.json() == {"pair_id": "ru-en", "status": "none", "session": None, "last_result": None,
                        "next_allowed_at": None, "audience": "adults"}
    session = await env.start(user)
    assert session["test_version"] == "dx-en-adult@1" and session["status"] == "in_progress"
    assert session["answered"] == 0 and session["total_estimate"] == 24 and session["followup_area"] is None
    assert session["expires_at"] == "2026-11-20T07:00:00Z"
    shown = await env.run(user, session, up_to("A2"))
    assert len(shown) == 24 and [i["position"] for i in shown] == list(range(1, 25))
    # порядок областей — по кругу V → G → R → L
    assert [i["area"] for i in shown[:8]] == AREAS * 2
    assert {a: len(v) for a, v in by_area(shown).items()} == dict.fromkeys(AREAS, 6)
    # аудирование: текст для синтеза речи есть, чтение — текст до 600 знаков
    assert all(i["audio_text_en"] for i in shown if i["area"] == "listening")
    assert all(i["passage_en"] for i in shown if i["area"] == "reading")
    r = await env.c.get("/internal/v1/diagnostics/state", headers=env.h(user))
    assert r.json()["status"] == "in_progress" and r.json()["session"]["answered"] == 24
    r = await env.c.get(f"/internal/v1/diagnostics/sessions/{session['session_id']}/next", headers=env.h(user))
    assert r.json() == {"done": True}
    result = await env.finish(user, session)
    assert result["provisional_level"] == "A2" and result["cefr_certificate"] is False
    assert [a["area"] for a in result["areas"]] == [*AREAS, "speaking", "writing"]
    for area in AREAS:
        a = area_of(result, area)
        assert (a["status"], a["band"], a["reason"]) == ("assessed", "A2", None)
        assert 0 <= a["confidence"] <= 1 and sum(e["answered"] for e in a["evidence"]) == 6
        # основания по полосам: путь лестницы «до A2» — A1 → A2 → B1 → A2 → B1 → A2
        assert a["evidence"] == [{"band": "A1", "answered": 1, "correct": 1}, {"band": "A2", "answered": 3,
                                 "correct": 3}, {"band": "B1", "answered": 2, "correct": 0}]
    for area in ("speaking", "writing"):
        assert area_of(result, area) | {"evidence": []} == {
            "area": area, "status": "not_assessed", "band": None, "confidence": None, "reason": "not_in_test_yet",
            "evidence": [], "needs_followup": False}
    assert_no_keys(result)
    r = await env.c.get("/internal/v1/diagnostics/state", headers=env.h(user))
    state = r.json()
    assert state["status"] == "completed" and state["session"] is None
    assert state["last_result"]["result_id"] == result["result_id"]
    assert state["next_allowed_at"] == "2026-12-03T07:00:00Z"


async def test_create_is_idempotent_and_new_session_abandons_previous(env, user) -> None:
    first = await env.start(user, key="key-one-123")
    again = await env.c.post("/internal/v1/diagnostics/sessions", json={"pair_id": "ru-en"},
                             headers={**env.h(user), "Idempotency-Key": "key-one-123"})
    assert again.status_code == 200 and again.headers["idempotent-replayed"] == "true"
    assert again.json() == first
    reused = await env.c.post("/internal/v1/diagnostics/sessions", json={"pair_id": "ru-uz"},
                              headers={**env.h(user), "Idempotency-Key": "key-one-123"})
    assert reused.status_code == 422 and reused.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    second = await env.start(user, key="key-two-123")
    assert second["session_id"] != first["session_id"]
    r = await env.c.get(f"/internal/v1/diagnostics/sessions/{first['session_id']}/next", headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "DIAGNOSTIC_SESSION_CLOSED"
    assert r.json()["details"] == {"status": "abandoned"}
    rows = await env.sql("SELECT status FROM sessions WHERE user_id = :u ORDER BY started_at, status", u=user)
    assert sorted(s for (s,) in rows) == ["abandoned", "in_progress"]
    # повтор первого ключа после прерывания — та же (прерванная) сессия, без новой
    again = await env.c.post("/internal/v1/diagnostics/sessions",
                             headers={**env.h(user), "Idempotency-Key": "key-one-123"})
    assert again.status_code == 200 and again.json()["status"] == "abandoned"


async def test_idempotency_key_required_and_validated(env, user) -> None:
    r = await env.c.post("/internal/v1/diagnostics/sessions", headers=env.h(user))
    assert r.status_code == 400 and r.json()["code"] == "IDEMPOTENCY_KEY_REQUIRED"
    r = await env.c.post("/internal/v1/diagnostics/sessions", headers={**env.h(user), "Idempotency-Key": "short"})
    assert r.status_code == 422 and r.json()["code"] == "IDEMPOTENCY_KEY_INVALID"
    r = await env.c.post("/internal/v1/diagnostics/sessions", json={"pair_id": "ru-en", "extra": 1},
                         headers={**env.h(user), "Idempotency-Key": "key-extra-1"})
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"
    r = await env.c.post("/internal/v1/diagnostics/sessions", params={"audience": "babies"},
                         headers={**env.h(user), "Idempotency-Key": "key-aud-123"})
    assert r.status_code == 422


async def test_answers_item_not_current_repeat_and_validation(env, user) -> None:
    session = await env.start(user)
    url = f"/internal/v1/diagnostics/sessions/{session['session_id']}"
    first = (await env.c.get(f"{url}/next", headers=env.h(user))).json()
    assert first["position"] == 1 and first["area"] == "vocabulary"
    assert_no_keys(first)
    # не текущее задание (другое задание теста) → 409
    items = await env.items(session["test_version"])
    other = next(i for i in items if i != first["item_id"])
    r = await env.c.post(f"{url}/answers", headers=env.h(user),
                         json={"item_id": other, "answer": 0, "dont_know": False, "time_ms": 10})
    assert r.status_code == 409 and r.json()["code"] == "ITEM_NOT_CURRENT"
    # форма ответа: индекс вне вариантов, слова вместо индекса, «не знаю» с ответом, без ответа, bool → 422
    for body in ({"item_id": first["item_id"], "answer": 99, "dont_know": False, "time_ms": 10},
                 {"item_id": first["item_id"], "answer": ["a"], "dont_know": False, "time_ms": 10},
                 {"item_id": first["item_id"], "answer": 0, "dont_know": True, "time_ms": 10},
                 {"item_id": first["item_id"], "answer": None, "dont_know": False, "time_ms": 10}):
        r = await env.c.post(f"{url}/answers", headers=env.h(user), json=body)
        assert r.status_code == 422 and r.json()["code"] == "ANSWER_INVALID", body
    for body in ({"item_id": first["item_id"], "answer": True, "dont_know": False, "time_ms": 10},
                 {"item_id": first["item_id"], "answer": 0, "dont_know": False, "time_ms": -1},
                 {"item_id": first["item_id"], "answer": 0, "dont_know": False},
                 {"item_id": first["item_id"], "answer": 0, "dont_know": False, "time_ms": 1, "correct": True}):
        r = await env.c.post(f"{url}/answers", headers=env.h(user), json=body)
        assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", body
    res = await env.answer(user, session, first, "dont_know")
    assert res["accepted"] and res["next"]["position"] == 2 and res["next"]["area"] == "grammar"
    assert set(res) == {"accepted", "next", "done"}  # правильность ученику не сообщается
    # повтор ответа на тот же item_id (даже с другим ответом) — 200 без изменений
    r = await env.c.post(f"{url}/answers", headers=env.h(user),
                         json={"item_id": first["item_id"], "answer": 1, "dont_know": False, "time_ms": 5})
    assert r.status_code == 200 and r.headers["idempotent-replayed"] == "true"
    assert r.json() == res
    [(n, dont_know, correct)] = await env.sql(
        "SELECT count(*), bool_and(dont_know), bool_or(correct) FROM answers WHERE session_id = :s",
        s=uuid.UUID(session["session_id"]))
    assert (n, dont_know, correct) == (1, True, False)


async def test_listening_unavailable_skips_listening(env, user) -> None:
    session = await env.start(user)
    url = f"/internal/v1/diagnostics/sessions/{session['session_id']}"
    r = await env.c.post(f"{url}/listening-unavailable", headers=env.h(user))
    assert r.status_code == 204
    assert (await env.c.post(f"{url}/listening-unavailable", headers=env.h(user))).status_code == 204
    shown = await env.run(user, session, up_to("A1"))
    assert len(shown) == 18 and "listening" not in by_area(shown)
    state = (await env.c.get("/internal/v1/diagnostics/state", headers=env.h(user))).json()
    assert state["session"]["total_estimate"] == 18
    result = await env.finish(user, session)
    listening = area_of(result, "listening")
    assert (listening["status"], listening["reason"], listening["band"]) == ("not_assessed", "no_speech_voice", None)
    assert result["provisional_level"] == "A1"
    assert result["weak_areas"] == ["listening"]


async def test_session_expires_after_24h(env, user) -> None:
    session = await env.start(user)
    url = f"/internal/v1/diagnostics/sessions/{session['session_id']}"
    item = (await env.c.get(f"{url}/next", headers=env.h(user))).json()
    env.now += timedelta(hours=24)
    for method, path, body in (("GET", "/next", None), ("POST", "/finish", None),
                               ("POST", "/listening-unavailable", None),
                               ("POST", "/answers", {"item_id": item["item_id"], "answer": 0, "dont_know": False,
                                                     "time_ms": 1})):
        r = await env.c.request(method, url + path, json=body, headers=env.h(user))
        assert r.status_code == 409 and r.json()["code"] == "DIAGNOSTIC_SESSION_EXPIRED", path
    state = (await env.c.get("/internal/v1/diagnostics/state", headers=env.h(user))).json()
    assert state["status"] == "none" and state["session"] is None
    # новая сессия возможна (просроченная прерывается)
    await env.start(user)


async def test_finish_rules(env, user) -> None:
    session = await env.start(user)
    r = await env.c.post(f"/internal/v1/diagnostics/sessions/{session['session_id']}/finish", headers=env.h(user))
    assert r.status_code == 422 and r.json()["code"] == "DIAGNOSTIC_EMPTY"
    # ранний выход: 2 ответа → области not_assessed (мало ответов), уровень не по одному ответу
    await env.run(user, session, always("correct"), limit=2)
    result = await env.finish(user, session)
    assert all(a["status"] == "not_assessed" for a in result["areas"])
    assert area_of(result, "vocabulary")["reason"] == "too_few_items"
    assert area_of(result, "vocabulary")["evidence"] == []  # not_assessed — без оснований
    assert result["provisional_level"] is None and result["weak_areas"] == AREAS
    again = await env.finish(user, session)
    assert again == result
    url = f"/internal/v1/diagnostics/sessions/{session['session_id']}"
    assert (await env.c.get(f"{url}/next", headers=env.h(user))).json() == {"done": True}
    r = await env.c.post(f"{url}/answers", headers=env.h(user),
                         json={"item_id": "x", "answer": 0, "dont_know": False, "time_ms": 1})
    assert r.status_code == 409 and r.json()["code"] == "DIAGNOSTIC_SESSION_CLOSED"
    # результат без оценённых областей повтор не блокирует
    state = (await env.c.get("/internal/v1/diagnostics/state", headers=env.h(user))).json()
    assert state["next_allowed_at"] is None
    await env.start(user)


async def test_reproducible_selection_same_seed_same_answers(env) -> None:
    env.fixed_seed = "seed-fixed-0042"
    a, b = uuid.uuid4(), uuid.uuid4()
    shown_a = await env.run(a, await env.start(a), up_to("A1"))
    shown_b = await env.run(b, await env.start(b), up_to("A1"))
    assert [i["item_id"] for i in shown_a] == [i["item_id"] for i in shown_b]
    env.fixed_seed = "seed-other-0043"
    c = uuid.uuid4()
    shown_c = await env.run(c, await env.start(c), up_to("A1"))
    # тот же путь по полосам, но другие задания внутри полос
    assert [i["item_id"] for i in shown_c] != [i["item_id"] for i in shown_a]


async def test_auth_and_learner_isolation(env, user) -> None:
    session = await env.start(user)
    sid = session["session_id"]
    rid = uuid.uuid4()
    paths = [("GET", "/internal/v1/diagnostics/state", None),
             ("POST", "/internal/v1/diagnostics/sessions", None),
             ("GET", f"/internal/v1/diagnostics/sessions/{sid}/next", None),
             ("POST", f"/internal/v1/diagnostics/sessions/{sid}/answers",
              {"item_id": "x", "answer": 0, "dont_know": False, "time_ms": 1}),
             ("POST", f"/internal/v1/diagnostics/sessions/{sid}/listening-unavailable", None),
             ("POST", f"/internal/v1/diagnostics/sessions/{sid}/finish", None),
             ("POST", f"/internal/v1/diagnostics/results/{rid}/followup", {"area": "grammar"}),
             ("GET", "/internal/v1/diagnostics/results", None),
             ("GET", f"/internal/v1/diagnostics/results/{rid}", None),
             ("GET", "/internal/v1/skills/map", None)]
    for method, path, body in paths:
        extra = {"Idempotency-Key": "key-auth-123"}
        r = await env.c.request(method, path, json=body, headers=extra)
        assert r.status_code == 401 and r.json()["code"] == "INTERNAL_TOKEN_MISSING", path
        r = await env.c.request(method, path, json=body, headers={**env.h(None), **extra})
        assert r.status_code == 401 and r.json()["code"] == "USER_CONTEXT_REQUIRED", path
        r = await env.c.request(method, path, json=body, headers={**env.h(user, issuer="learning-plan"), **extra})
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", path
        r = await env.c.request(method, path, json=body, headers={**env.h(user, issuer="admin-bff"), **extra})
        assert r.status_code == 403, path
    # чужая сессия — 404 (неотличима от несуществующей)
    other = uuid.uuid4()
    item = (await env.c.get(f"/internal/v1/diagnostics/sessions/{sid}/next", headers=env.h(user))).json()
    for method, path, body in (
            ("GET", f"/internal/v1/diagnostics/sessions/{sid}/next", None),
            ("POST", f"/internal/v1/diagnostics/sessions/{sid}/answers",
             {"item_id": item["item_id"], "answer": 0, "dont_know": False, "time_ms": 1}),
            ("POST", f"/internal/v1/diagnostics/sessions/{sid}/listening-unavailable", None),
            ("POST", f"/internal/v1/diagnostics/sessions/{sid}/finish", None),
            ("GET", f"/internal/v1/diagnostics/sessions/{uuid.uuid4()}/next", None)):
        r = await env.c.request(method, path, json=body, headers=env.h(other))
        assert r.status_code == 404 and r.json()["code"] == "DIAGNOSTIC_SESSION_NOT_FOUND", path
    r = await env.c.get("/internal/v1/diagnostics/sessions/not-a-uuid/next", headers=env.h(user))
    assert r.status_code == 422
    [(n,)] = await env.sql("SELECT count(*) FROM answers")
    assert n == 0
    state = (await env.c.get("/internal/v1/diagnostics/state", headers=env.h(other))).json()
    assert state["status"] == "none"


async def test_pair_not_available(env, user) -> None:
    for pair in ("ru-uz", "ru-kk"):
        r = await env.c.post("/internal/v1/diagnostics/sessions", json={"pair_id": pair},
                             headers={**env.h(user), "Idempotency-Key": f"key-{pair}-1"})
        assert r.status_code == 409, r.text
        assert (r.json()["code"], r.json()["details"]) == ("PAIR_NOT_AVAILABLE", {"pair_id": pair})
        r = await env.c.get("/internal/v1/diagnostics/state", params={"pair_id": pair}, headers=env.h(user))
        assert r.status_code == 409 and r.json()["code"] == "PAIR_NOT_AVAILABLE"
        r = await env.c.get("/internal/v1/skills/map", params={"pair_id": pair}, headers=env.h(user))
        assert r.status_code == 409
    r = await env.c.get("/internal/v1/diagnostics/state", params={"pair_id": "RU_EN"}, headers=env.h(user))
    assert r.status_code == 422
    # catalog недоступен — только ru-en
    env.catalog.down = True
    env.app.state.catalog._pairs = None
    r = await env.c.get("/internal/v1/diagnostics/state", params={"pair_id": "ru-uz"}, headers=env.h(user))
    assert r.status_code == 409
    r = await env.c.get("/internal/v1/diagnostics/state", headers=env.h(user))
    assert r.status_code == 200
    await env.start(user)
