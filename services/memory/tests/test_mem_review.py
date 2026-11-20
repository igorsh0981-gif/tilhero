"""«Повторение дня» (INTERNAL_API §1.3): состав очереди и лимиты, типы заданий по стадии, оценки строго по таблице,
повтор again, подсказки, ключ не уходит ученику, идемпотентность и переходы статусов, активное время, истечение."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from mem_testkit import assert_no_keys

from tilhero_memory.domain import fsrs
from tilhero_memory.domain.normalize import canonical_tokens

LESSONS = ["l-01-greetings", "l-02-where-from", "l-04-family", "l-06-free-time"]


async def wrong(env: Any, task: dict[str, Any]) -> dict[str, Any]:
    key = await env.key_of(task["task_id"])
    if task["answer_kind"] == "choice":
        right = key.get("correct", key.get("answer"))
        return {"choice": 1 if right == 0 else 0}
    if task["answer_kind"] == "text":
        return {"text": "zzzz qqqq"}
    order = list(range(len(task["tiles"] or task["options"])))
    body = await env.correct_body(task)
    return {"order": list(reversed(body["order"]))} if body["order"] != order[::-1] else {"order": order}


async def log_rows(env: Any, user: uuid.UUID) -> list[tuple[Any, ...]]:
    return list(await env.sql("SELECT task_type, answer_mode, grade, hinted, revealed, algorithm, params_version "
                              "FROM review_log WHERE user_id = :u ORDER BY created_at, log_id", u=user))


async def test_queue_limits_adults_and_kids(env) -> None:  # type: ignore[no-untyped-def]
    adult, kid = uuid.uuid4(), uuid.uuid4()
    for u in (adult, kid):
        for lesson in LESSONS:
            await env.lesson_done(u, lesson)
    for u in (adult, kid):
        rows = await env.sql("SELECT card_id FROM cards WHERE user_id = :u ORDER BY created_at, card_id", u=u)
        for i, (cid,) in enumerate(rows[:30]):  # 30 карточек к сроку с разной извлекаемостью
            await env.sql("UPDATE cards SET status='review', fsrs_state='review', stability=10, difficulty=5, "
                          "reps=2, last_review_at=:last, due_at=:due WHERE card_id=:c",
                          last=env.now - timedelta(days=5 + i), due=env.now - timedelta(hours=1), c=cid)
    s = await env.start(adult)
    assert (s["cards"], s["new_cards"], s["checks"], s["total_tasks"]) == (25, 5, 0, 30)
    picked = {r[0] for r in await env.sql(
        "SELECT DISTINCT card_id FROM review_tasks WHERE session_id = :s AND type <> 'intro'",
        s=uuid.UUID(s["session_id"]))}
    lowest_r = [r[0] for r in await env.sql(
        "SELECT card_id FROM cards WHERE user_id = :u AND status = 'review' ORDER BY last_review_at LIMIT 20", u=adult)]
    assert set(lowest_r) <= picked  # к сроку — по возрастанию R (дольше не повторялись — ниже R)
    k = await env.start(kid, age_band="6-9")
    assert (k["cards"], k["new_cards"], k["total_tasks"]) == (13, 3, 16)
    # новые с учётом начатых сегодня: после отмены — новых больше нет
    await env.post(adult, f"review-sessions/{s['session_id']}/cancel")
    s2 = await env.start(adult)
    assert s2["new_cards"] == 0 and s2["session_id"] != s["session_id"]


async def test_nothing_to_review_and_start_idempotency(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    r = await env.c.post("/internal/v1/review-sessions", headers={**env.h(user), "Idempotency-Key": "k-empty-01"})
    assert r.status_code == 409 and r.json()["details"] == {"next_due_at": None}
    await env.lesson_done(user)
    await env.make_review(user, due_days=3)
    await env.sql("UPDATE cards SET status='review' WHERE user_id = :u", u=user)
    r = await env.c.post("/internal/v1/review-sessions", headers={**env.h(user), "Idempotency-Key": "k-empty-02"})
    assert r.status_code == 409 and r.json()["code"] == "NOTHING_TO_REVIEW"
    assert r.json()["details"]["next_due_at"] == "2026-11-23T05:00:00.000Z"
    ov = await env.get(user, "overview")
    assert ov["due_count"] == 0 and ov["next_due_at"] == "2026-11-23T05:00:00.000Z"
    await env.sql("UPDATE cards SET due_at = :d WHERE user_id = :u", d=env.now, u=user)
    s = await env.start(user, key="k-start-001")
    assert await env.start(user, expect=200, key="k-start-001") == s
    assert (await env.start(user, expect=200, key="k-start-002"))["session_id"] == s["session_id"]
    assert (await env.get(user, "review-sessions/active"))["session"]["session_id"] == s["session_id"]
    assert (await env.get(user, "overview"))["active_session_id"] == s["session_id"]
    r = await env.c.post("/internal/v1/review-sessions", headers=env.h(user))
    assert r.status_code == 400 and r.json()["code"] == "IDEMPOTENCY_KEY_REQUIRED"


async def test_new_card_intro_then_choice_and_grades(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    s = await env.start(user)
    sid = s["session_id"]
    intro = await env.current(user, sid)
    assert intro["type"] == "intro" and intro["answer_kind"] == "none" and intro["hints"] == []
    assert intro["prompt"]["text_en"] and intro["prompt"]["gloss"] and intro["index"] == 1 and intro["total"] == 10
    r = await env.c.post(f"/internal/v1/review-sessions/{sid}/tasks/{intro['task_id']}/hint",
                         json={"kind": "reveal"}, headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "HINTS_NOT_ALLOWED"
    res = await env.answer(user, sid, intro, {})
    assert res["result"] is None and res["next_review_in_days"] is None and not res["requeued"]
    choice = res["next"]
    assert choice["type"] == "meaning_choice" and choice["card_id"] == intro["card_id"]
    assert len(choice["options"]) == 4 and len(set(choice["options"])) == 4 and choice["hints"] == ["reveal"]
    r = await env.c.post(f"/internal/v1/review-sessions/{sid}/tasks/{choice['task_id']}/hint",
                         json={"kind": "first_letter"}, headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "HINTS_NOT_ALLOWED"
    res = await env.answer(user, sid, choice, await env.correct_body(choice))
    assert res["result"] == "correct" and res["correct_answer"] in choice["options"]
    assert res["next_review_in_days"] == 1  # первая оценка hard: S₀ = 1.18 дня
    assert await log_rows(env, user) == [("meaning_choice", "choice", "hard", False, False, "fsrs-5",
                                          "fsrs5-default-1")]
    [(stability, state)] = await env.sql("SELECT stability, fsrs_state FROM cards WHERE card_id = :c",
                                         c=uuid.UUID(choice["card_id"]))
    assert stability == fsrs.init_stability(2) and state == "learning"
    # «Знаю это» во intro: карточка known, выбор перевода по ней пропускается
    intro2 = res["next"]
    res = await env.answer(user, sid, intro2, {"known": True})
    assert res["next"]["type"] == "intro" and res["next"]["total"] == 9
    [(status,)] = await env.sql("SELECT status FROM cards WHERE card_id = :c", c=uuid.UUID(intro2["card_id"]))
    assert status == "known"
    assert (await log_rows(env, user))[-1][:3] == ("intro", "manual", None)


async def test_production_tasks_grades_hints_and_requeue(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    await env.make_review(user)
    s = await env.start(user)
    sid = s["session_id"]
    assert s["new_cards"] == 0 and s["total_tasks"] == 10
    task = await env.current(user, sid)
    seen_types = set()
    # 1) верно без подсказки → good
    assert task["type"] in ("typed", "cloze") and task["answer_kind"] == "text"
    assert task["prompt"]["text_en"] is None and task["hints"] == ["first_letter", "reveal"]
    key = await env.key_of(task["task_id"])
    gap = task["prompt"]["example_gap"]
    assert gap is None or ("___" in gap and key["display"].lower() not in gap.lower())
    res = await env.answer(user, sid, task, await env.correct_body(task))
    assert (res["result"], res["requeued"]) == ("correct", False) and res["correct_answer"] == key["display"]
    seen_types.add(task["type"])
    # 2) первая буква → hard
    task = res["next"]
    hint = await env.post(user, f"review-sessions/{sid}/tasks/{task['task_id']}/hint", {"kind": "first_letter"})
    key = await env.key_of(task["task_id"])
    assert hint["kind"] == "first_letter" and hint["text"].endswith("…") and len(hint["text"]) == 2
    assert hint == await env.post(user, f"review-sessions/{sid}/tasks/{task['task_id']}/hint",
                                  {"kind": "first_letter"})
    assert (await env.current(user, sid))["hints_used"] == ["first_letter"]
    res = await env.answer(user, sid, task, await env.correct_body(task))
    # 3) опечатка (почти) → hard (если в ответе есть слово ≥ 5 букв; иначе — верно → good)
    task = res["next"]
    key = await env.key_of(task["task_id"])
    tokens = canonical_tokens(key["answers"][0])
    long = [i for i, t in enumerate(tokens) if sum(ch.isalpha() for ch in t) >= 5]
    if long:
        word = tokens[long[0]]
        tokens[long[0]] = word[:2] + word[3:]
        res = await env.answer(user, sid, task, {"text": " ".join(tokens)})
        assert res["result"] == "almost"
        third = "hard"
    else:
        res = await env.answer(user, sid, task, await env.correct_body(task))
        third = "good"
    # 4) неверно → again, карточка в конец сессии один раз
    task = res["next"]
    res = await env.answer(user, sid, task, {"text": "zzzz qqqq"})
    assert res["result"] == "incorrect" and res["requeued"] is True and res["next_review_in_days"] >= 1
    assert res["next"]["total"] == 11
    again_card = task["card_id"]
    # 5) «Не помню» → again (ответ показан)
    task = res["next"]
    key = await env.key_of(task["task_id"])
    hint = await env.post(user, f"review-sessions/{sid}/tasks/{task['task_id']}/hint", {"kind": "reveal"})
    assert hint == {"kind": "reveal", "text": key["display"]}
    res = await env.answer(user, sid, task, await env.correct_body(task))
    assert res["result"] == "correct" and res["requeued"] is True and res["next"]["total"] == 12
    while res["next"] and res["next"]["card_id"] != again_card:
        res = await env.answer(user, sid, res["next"], await env.correct_body(res["next"]))
    requeued = res["next"]
    assert requeued["type"] in ("meaning_choice", "listen_choice")  # после провала — снова узнавание
    res = await env.answer(user, sid, requeued, await wrong(env, requeued))
    assert res["requeued"] is False  # повтор в сессии — один раз
    grades = [r[2] for r in await log_rows(env, user)]
    assert grades[:5] == ["good", "hard", third, "again", "again"]
    [(elapsed,)] = await env.sql("SELECT elapsed_days FROM review_log WHERE task_id = :t",
                                 t=uuid.UUID(requeued["task_id"]))
    assert elapsed < 1  # повтор в тот же день — краткосрочная формула
    assert "easy" not in grades


async def test_key_never_leaks_and_task_not_current(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    await env.make_review(user, stability=1.5)  # узнавание
    s = await env.start(user)
    sid = s["session_id"]
    task = await env.current(user, sid)
    assert task["type"] in ("meaning_choice", "listen_choice")
    raw = (await env.c.get(f"/internal/v1/review-sessions/{sid}/current", headers=env.h(user))).text
    assert '"correct"' not in raw and '"answers' not in raw and '"key"' not in raw
    second = (await env.sql("SELECT task_id FROM review_tasks WHERE session_id = :s AND seq = 2",
                            s=uuid.UUID(sid)))[0][0]
    r = await env.c.post(f"/internal/v1/review-sessions/{sid}/tasks/{second}", json={"choice": 0},
                         headers=env.h(user))
    assert r.status_code == 409 and r.json()["details"] == {"current_task_id": task["task_id"]}
    for bad in ({"choice": 9}, {"text": "hello"}, {"order": [0]}, {"choice": 0, "text": "x"}, {"choice": "0"}):
        r = await env.c.post(f"/internal/v1/review-sessions/{sid}/tasks/{task['task_id']}", json=bad,
                             headers=env.h(user))
        assert r.status_code == 422, bad
    res = await env.answer(user, sid, task, await env.correct_body(task))
    again = await env.answer(user, sid, task, await wrong(env, task))  # повтор — тот же результат
    assert {k: v for k, v in again.items() if k != "next"} == {k: v for k, v in res.items() if k != "next"}
    assert len(await log_rows(env, user)) == 1
    r = await env.c.post(f"/internal/v1/review-sessions/{sid}/tasks/{uuid.uuid4()}", json={},
                         headers=env.h(user))
    assert r.status_code == 404 and r.json()["code"] == "TASK_NOT_FOUND"


async def test_kids_assemble_and_10_13_typing(env) -> None:  # type: ignore[no-untyped-def]
    young, older = uuid.uuid4(), uuid.uuid4()
    for u in (young, older):
        await env.lesson_done(u)
        await env.make_review(u)
    s = await env.start(young, age_band="6-9")
    task = await env.current(young, s["session_id"], age_band="6-9")
    assert task["type"] == "assemble" and task["answer_kind"] == "order" and task["tiles"]
    key = await env.key_of(task["task_id"])
    assert task["tiles"] != key["target"] or len(set(key["target"])) == 1
    res = await env.answer(young, s["session_id"], task, await env.correct_body(task), age_band="6-9")
    assert res["result"] == "correct"
    [(grade, mode)] = await env.sql("SELECT grade, answer_mode FROM review_log WHERE user_id = :u", u=young)
    assert (grade, mode) == ("good", "assemble")  # самостоятельная сборка — good
    # детский профиль на аккаунте родителя: lrn ≠ sub, полоса ребёнка неизвестна → поведение 6–9
    parent = uuid.uuid4()
    s3 = await env.start(older, account=parent, age_band="18+")
    t3 = await env.current(older, s3["session_id"], account=parent, age_band="18+")
    assert t3["type"] == "assemble"
    await env.post(older, f"review-sessions/{s3['session_id']}/cancel", account=parent)
    s2 = await env.start(older, age_band="10-13")
    t2 = await env.current(older, s2["session_id"], age_band="10-13")
    assert t2["type"] in ("typed", "cloze")


async def test_error_fix_task(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    env.identity.set(user)
    await env.lesson_done(user, errors=[{"turn_id": "T2", "evidence": "I from Tashkent",
                                         "correction": "I am from Tashkent.", "error_code": "missing_be",
                                         "severity": "high"}])
    await env.sql("DELETE FROM cards WHERE user_id = :u AND kind <> 'error'", u=user)
    await env.make_review(user)
    s = await env.start(user)
    task = await env.current(user, s["session_id"])
    assert task["type"] == "error_fix" and task["prompt"]["evidence"] == "I from Tashkent"
    assert task["prompt"]["gloss"] is None and task["prompt"]["explanation"]["ru"].startswith("В английском")
    assert "Tashkent" not in str(task["options"]) and task["prompt"]["text_en"] is None
    res = await env.answer(user, s["session_id"], task, {"text": "I'm from Tashkent"})
    assert res["result"] == "correct" and res["correct_answer"] == "I am from Tashkent."
    await env.post(user, f"review-sessions/{s['session_id']}/finish")
    # цитата стёрта — typed по исправлению с объяснением
    await env.sql("UPDATE cards SET error = jsonb_set(error, '{evidence}', 'null'::jsonb), due_at = :d "
                  "WHERE user_id = :u", u=user, d=env.now)
    env.now += timedelta(days=1)
    s2 = await env.start(user)
    t2 = await env.current(user, s2["session_id"])
    if t2["type"] != "meaning_choice":
        assert t2["type"] == "typed" and t2["prompt"]["explanation"] and t2["prompt"]["evidence"] is None


async def test_finish_summary_event_and_states(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    s = await env.start(user)
    sid = s["session_id"]
    first = await env.current(user, sid)
    r = await env.c.post(f"/internal/v1/review-sessions/{sid}/finish", headers=env.h(user))
    assert r.status_code == 409 and r.json() == {**r.json(), "code": "TASK_NOT_CURRENT",
                                                 "details": {"current_task_id": first["task_id"]}}
    env.now += timedelta(seconds=30)
    await env.answer(user, sid, first, {})
    env.now += timedelta(minutes=15)  # пауза > 10 мин не идёт в активное время
    nxt = await env.current(user, sid)
    await env.answer(user, sid, nxt, await wrong(env, nxt))
    await env.play(user, sid)
    r = await env.c.get(f"/internal/v1/review-sessions/{sid}/current", headers=env.h(user))
    assert r.status_code == 409 and r.json()["details"] == {"current_task_id": None}
    summary = await env.post(user, f"review-sessions/{sid}/finish")
    assert summary == await env.post(user, f"review-sessions/{sid}/finish")  # повтор — тот же итог
    assert summary["status"] == "completed" and summary["reviewed"] == 5 and summary["again"] == 1
    assert summary["correct"] == 4 and summary["new_learned"] == 5 and summary["checks"] == []
    assert summary["next_due_at"] is not None and summary["due_tomorrow"] >= 1
    [(active_seconds, minutes)] = await env.sql("SELECT active_seconds, minutes FROM review_sessions "
                                                "WHERE session_id = :s", s=uuid.UUID(sid))
    assert active_seconds < 15 * 60 and minutes == summary["minutes"] == -(-active_seconds // 60)
    [ev] = await env.events("memory.review.completed.v1", user)
    assert ev.payload == {"session_id": sid, "user_id": str(user), "pair_id": "ru-en", "status": "completed",
                          "minutes": summary["minutes"], "reviewed": 5, "correct": 4,
                          "finished_at": ev.payload["finished_at"]}
    assert await env.sql("SELECT local_date::text, source FROM activity_days WHERE user_id = :u", u=user) == [
        ("2026-11-20", "review")]
    ov = await env.get(user, "overview")
    assert ov["done_today"] is True and ov["active_session_id"] is None and ov["total_cards"] == 10
    r = await env.c.post(f"/internal/v1/review-sessions/{sid}/cancel", headers=env.h(user))
    assert r.status_code == 409 and r.json()["details"]["status"] == "completed"
    view = await env.get(user, f"review-sessions/{sid}")
    assert view["status"] == "completed" and view["done_tasks"] == view["total_tasks"] == 11  # + повтор again


async def test_cancel_and_isolation(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    s = await env.start(user)
    sid = s["session_id"]
    task = await env.current(user, sid)
    other = uuid.uuid4()
    for method, path in (("GET", f"review-sessions/{sid}"), ("GET", f"review-sessions/{sid}/current"),
                         ("POST", f"review-sessions/{sid}/finish"), ("POST", f"review-sessions/{sid}/cancel")):
        r = await env.c.request(method, f"/internal/v1/{path}", headers=env.h(other))
        assert r.status_code == 404 and r.json()["code"] == "REVIEW_SESSION_NOT_FOUND"
    r = await env.c.post(f"/internal/v1/review-sessions/{sid}/tasks/{task['task_id']}", json={},
                         headers=env.h(other))
    assert r.status_code == 404
    assert (await env.get(other, "review-sessions/active"))["session"] is None
    await env.answer(user, sid, task, {})
    cancelled = await env.post(user, f"review-sessions/{sid}/cancel")
    assert cancelled["status"] == "cancelled" and cancelled["done_tasks"] == 1
    assert (await env.post(user, f"review-sessions/{sid}/cancel"))["status"] == "cancelled"
    nxt = (await env.sql("SELECT task_id FROM review_tasks WHERE session_id = :s AND seq = 2",
                         s=uuid.UUID(sid)))[0][0]
    r = await env.c.post(f"/internal/v1/review-sessions/{sid}/tasks/{nxt}", json={}, headers=env.h(user))
    assert r.status_code == 409 and r.json()["details"]["status"] == "cancelled"
    assert await env.events("memory.review.completed.v1", user) == []
    assert (await env.c.get("/internal/v1/review-sessions/not-a-uuid", headers=env.h(user))).status_code == 422


async def test_expiry_by_inactivity_and_local_day(env) -> None:  # type: ignore[no-untyped-def]
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    for u in (a, b, c):
        await env.lesson_done(u)
    sa = await env.start(a)
    await env.answer(a, sa["session_id"], await env.current(a, sa["session_id"]), {})
    sb = await env.start(b)  # без ответов
    env.now += timedelta(hours=2, minutes=1)
    out = await env.tick()
    assert out["sessions_expired"] == 2
    [ev] = await env.events("memory.review.completed.v1", a)
    assert ev.payload["status"] == "expired" and ev.payload["minutes"] == 1
    assert await env.events("memory.review.completed.v1", b) == []
    r = await env.c.get(f"/internal/v1/review-sessions/{sb['session_id']}/current", headers=env.h(b))
    assert r.status_code == 409 and r.json()["details"]["status"] == "expired"
    # конец местного дня (Ташкент): старт в 23:50, запрос в 00:05 — сессия истекла
    env.now = env.now.replace(hour=18, minute=50)
    sc = await env.start(c)
    env.now = env.now.replace(hour=19, minute=5)
    r = await env.c.get(f"/internal/v1/review-sessions/{sc['session_id']}/current", headers=env.h(c))
    assert r.status_code == 409 and r.json()["details"]["status"] == "expired"
    assert (await env.start(c))["session_id"] != sc["session_id"]


def test_assert_no_keys_helper() -> None:
    assert_no_keys({"prompt": {"text_en": "x"}, "answer_kind": "text"})


async def test_overview_counts_and_limits(env) -> None:  # type: ignore[no-untyped-def]
    kid = uuid.uuid4()
    empty = await env.get(kid, "overview", age_band="6-9")
    assert empty == {"due_count": 0, "new_available": 0, "retention_due": 0, "done_today": False,
                     "active_session_id": None, "next_due_at": None, "total_cards": 0,
                     "pronunciation": "consent_guardian"}
    await env.lesson_done(kid)
    ov = await env.get(kid, "overview", age_band="6-9")
    assert ov["new_available"] == 3 and ov["total_cards"] == 10 and ov["due_count"] == 0  # детям 3 новых в день
    s = await env.start(kid, age_band="6-9")
    await env.play(kid, s["session_id"], age_band="6-9")
    await env.post(kid, f"review-sessions/{s['session_id']}/finish", age_band="6-9")
    ov = await env.get(kid, "overview", age_band="6-9")
    assert ov["new_available"] == 0 and ov["done_today"] is True and ov["next_due_at"] is not None
    env.now += timedelta(days=1)
    ov = await env.get(kid, "overview", age_band="6-9")
    assert ov["new_available"] == 3 and ov["due_count"] == 3 and ov["done_today"] is False
