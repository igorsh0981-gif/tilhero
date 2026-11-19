"""Ученик (через telegram-bff): EvaluationView — только своя (чужая → 404), верный ответ — только для ошибок,
актуальная запись цепочки после переоценки; апелляции — окно 14 дней, одна на оценку, повтор по Idempotency-Key,
practice_only — нельзя, детский профиль — можно; список своих апелляций с курсором."""

from __future__ import annotations

import uuid
from datetime import timedelta

from as_testkit import lesson_request

from tilhero_common.testing import internal_headers


async def test_view_own_evaluation(env, user) -> None:
    created = await env.evaluate(user, lesson_request(
        "l-01-greetings", policy=lambda i: "wrong" if i["item_id"] == "l-01-c2" else "correct"))
    v = await env.view(user, created["evaluation_id"])
    expected = {k: created[k] for k in created if k not in ("session_id", "skill_outcomes", "requires_human_review")}
    assert v == expected
    assert [i["correct_answer"] for i in v["items"]] == [None, "am", None, None, None]
    assert set(v) == {"evaluation_id", "status", "passed", "task_completed", "scores", "key_errors", "items",
                      "practice_only", "rubric_version", "evaluator", "superseded_by", "appeal", "created_at"}


async def test_view_isolation_and_auth(env, user) -> None:
    created = await env.evaluate(user, lesson_request("l-01-greetings"))
    eid = created["evaluation_id"]
    other = uuid.uuid4()
    r = await env.c.get(f"/internal/v1/evaluations/{eid}", headers=env.learner(other))
    assert r.status_code == 404 and r.json()["code"] == "EVALUATION_NOT_FOUND"
    r = await env.c.get(f"/internal/v1/evaluations/{uuid.uuid4()}", headers=env.learner(user))
    assert r.status_code == 404
    assert (await env.c.get(f"/internal/v1/evaluations/{eid}")).status_code == 401
    r = await env.c.get(f"/internal/v1/evaluations/{eid}", headers=env.learner(user, issuer="lessons"))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    r = await env.c.get(f"/internal/v1/evaluations/{eid}", headers=env.learner(user, issuer="admin-bff"))
    assert r.status_code == 403
    r = await env.c.get(f"/internal/v1/evaluations/{eid}", headers=env.learner(None))
    assert r.status_code == 401 and r.json()["code"] == "USER_CONTEXT_REQUIRED"
    r = await env.c.get("/internal/v1/evaluations/not-a-uuid", headers=env.learner(user))
    assert r.status_code == 422
    for path in (f"/internal/v1/evaluations/{eid}/appeal", "/internal/v1/appeals"):
        method = "POST" if path.endswith("appeal") else "GET"
        r = await env.c.request(method, path, json={"reason": "x"} if method == "POST" else None,
                                headers={**internal_headers(env.settings, issuer="lessons", subject=str(user)),
                                         "Idempotency-Key": "k-auth-0001"})
        assert r.status_code == 403, path
        r = await env.c.request(method, path, json={"reason": "x"} if method == "POST" else None)
        assert r.status_code == 401, path


async def test_appeal_lifecycle_for_learner(env, user) -> None:
    created = await env.evaluate(user, lesson_request("l-01-greetings"))
    eid = created["evaluation_id"]
    a = await env.appeal(user, eid, reason="  Ответ «am» верный, проверьте  ", key="appeal-key-1")
    assert a["status"] == "new" and a["evaluation_id"] == eid and a["reason"] == "Ответ «am» верный, проверьте"
    assert a["decision_note"] is None and a["new_evaluation_id"] is None and a["decided_at"] is None
    # повтор с тем же ключом — та же апелляция
    r = await env.c.post(f"/internal/v1/evaluations/{eid}/appeal", json={"reason": "Ответ «am» верный, проверьте"},
                         headers={**env.learner(user), "Idempotency-Key": "appeal-key-1"})
    assert r.status_code == 200 and r.json() == a and r.headers["idempotent-replayed"] == "true"
    r = await env.c.post(f"/internal/v1/evaluations/{eid}/appeal", json={"reason": "другая причина"},
                         headers={**env.learner(user), "Idempotency-Key": "appeal-key-1"})
    assert r.status_code == 422 and r.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    # вторая апелляция по той же оценке — 409
    r = await env.c.post(f"/internal/v1/evaluations/{eid}/appeal", json={"reason": "ещё раз"},
                         headers={**env.learner(user), "Idempotency-Key": "appeal-key-2"})
    assert r.status_code == 409 and r.json()["code"] == "APPEAL_EXISTS"
    assert r.json()["details"] == {"appeal_id": a["appeal_id"]}
    v = await env.view(user, eid)
    assert v["appeal"] == a
    page = (await env.c.get("/internal/v1/appeals", headers=env.learner(user))).json()
    assert page == {"items": [a], "next_cursor": None}
    # апелляции не создают событий (уведомление — только о решении)
    assert await env.events("assessment.appeal.decided.v1") == []


async def test_appeal_rules(env, user) -> None:
    created = await env.evaluate(user, lesson_request("l-01-greetings"))
    eid = created["evaluation_id"]
    # чужая оценка — 404
    r = await env.c.post(f"/internal/v1/evaluations/{eid}/appeal", json={"reason": "моя"},
                         headers={**env.learner(uuid.uuid4()), "Idempotency-Key": "k-foreign-1"})
    assert r.status_code == 404
    # без ключа, неверный ключ, пустая и длинная причина, лишнее поле
    r = await env.c.post(f"/internal/v1/evaluations/{eid}/appeal", json={"reason": "x"}, headers=env.learner(user))
    assert r.status_code == 400 and r.json()["code"] == "IDEMPOTENCY_KEY_REQUIRED"
    r = await env.c.post(f"/internal/v1/evaluations/{eid}/appeal", json={"reason": "x"},
                         headers={**env.learner(user), "Idempotency-Key": "bad"})
    assert r.status_code == 422 and r.json()["code"] == "IDEMPOTENCY_KEY_INVALID"
    for body in ({"reason": "   "}, {"reason": "x" * 501}, {"reason": "ok", "user_id": str(user)}, {},
                 {"reason": "bad\x00text"}):
        r = await env.c.post(f"/internal/v1/evaluations/{eid}/appeal", json=body,
                             headers={**env.learner(user), "Idempotency-Key": f"k-{uuid.uuid4()}"})
        assert r.status_code == 422, body
    # окно 14 дней от актуальной оценки
    env.now += timedelta(days=14, minutes=1)
    r = await env.c.post(f"/internal/v1/evaluations/{eid}/appeal", json={"reason": "поздно"},
                         headers={**env.learner(user), "Idempotency-Key": "k-late-0001"})
    assert r.status_code == 409 and r.json()["code"] == "APPEAL_WINDOW_CLOSED"
    env.now -= timedelta(minutes=2)
    await env.appeal(user, eid, reason="успел")
    # practice_only — оспорить нельзя
    practice = await env.evaluate(user, lesson_request("l-01-greetings", practice_only=True))
    r = await env.c.post(f"/internal/v1/evaluations/{practice['evaluation_id']}/appeal", json={"reason": "почему"},
                         headers={**env.learner(user), "Idempotency-Key": "k-practice-1"})
    assert r.status_code == 409 and r.json()["code"] == "APPEAL_NOT_ALLOWED"


async def test_kids_can_appeal(env, user) -> None:
    created = await env.evaluate(user, lesson_request("l-01-greetings", audience="kids"))
    a = await env.appeal(user, created["evaluation_id"], reason="Мама говорит, что ответ верный")
    assert a["status"] == "new"


async def test_appeals_list_is_own_and_paginated(env, user) -> None:
    other = uuid.uuid4()
    mine = []
    for _ in range(3):
        ev = await env.evaluate(user, lesson_request("l-01-greetings"))
        mine.append(await env.appeal(user, ev["evaluation_id"]))
        env.now += timedelta(minutes=1)
    ev = await env.evaluate(other, lesson_request("l-01-greetings"))
    await env.appeal(other, ev["evaluation_id"])
    seen, cursor = [], None
    while True:
        params = {"limit": 2, **({"cursor": cursor} if cursor else {})}
        page = (await env.c.get("/internal/v1/appeals", params=params, headers=env.learner(user))).json()
        seen += [a["appeal_id"] for a in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert seen == [a["appeal_id"] for a in reversed(mine)]  # новые первыми
    r = await env.c.get("/internal/v1/appeals", params={"cursor": "garbage!"}, headers=env.learner(user))
    assert r.status_code == 400 and r.json()["code"] == "INVALID_CURSOR"
    r = await env.c.get("/internal/v1/appeals", params={"limit": 101}, headers=env.learner(user))
    assert r.status_code == 422


async def test_view_shows_actual_record_after_reevaluation(env, user) -> None:
    created = await env.evaluate(user, lesson_request("l-01-greetings"))
    eid = created["evaluation_id"]
    staff = env.staff("qa.read", "qa.review")
    r = await env.c.post(f"/admin/v1/evaluations/{eid}/reevaluate", headers=staff, json={
        "scores": {"task": 2}, "skill_outcomes": [{"skill_id": o["skill_id"], "outcome": "learning"}
                                                  for o in created["skill_outcomes"]],
        "confirmed_errors": [], "reason": "Задача выполнена не полностью"})
    assert r.status_code == 201, r.text
    new_id = r.json()["evaluation_id"]
    v = await env.view(user, eid)
    assert v["evaluation_id"] == new_id and v["superseded_by"] == new_id
    assert {s["code"]: s["score"] for s in v["scores"]}["task"] == 2 and v["evaluator"] is None
    v2 = await env.view(user, new_id)
    assert v2["evaluation_id"] == new_id and v2["superseded_by"] is None
    # апелляция подаётся на актуальную запись
    a = await env.appeal(user, eid)
    assert a["evaluation_id"] == new_id
