"""Проверки удержания (INTERNAL_API §1.5, AT-56): d7 → d30, повтор через 3 дня, 2 провала подряд, отмена при смене
состояния навыка, нет заданий, перенос без активности 14 дней, без подсказок, итог — только в конце блока."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from tilhero_memory.domain.retention import choose_items, required_correct

SKILL = "en.func.greet"


async def demonstrated(env: Any, user: uuid.UUID, skill: str = SKILL, *, frm: str = "learning",
                       to: str = "demonstrated", producer: str = "diagnostics", evidence: str | None = None) -> str:
    evidence = evidence or str(uuid.uuid4())
    await env.publish("skills.state.changed.v1", {
        "user_id": str(user), "pair_id": "ru-en",
        "changes": [{"skill_id": skill, "from": frm, "to": to, "source": "lesson", "evidence_id": evidence}],
        "occurred_at": env.now.isoformat().replace("+00:00", "Z")}, producer)
    return evidence


async def checks(env: Any, user: uuid.UUID) -> list[tuple[Any, ...]]:
    return list(await env.sql(
        "SELECT stage, status, due_at, attempt, consecutive_failures, cancel_reason, postponed FROM retention_checks "
        "WHERE user_id = :u ORDER BY created_at, stage", u=user))


async def run_block(env: Any, user: uuid.UUID, *, correct: int) -> dict[str, Any]:
    """Сессия с одной проверкой: первые `correct` заданий верно, остальные — нет → итог блока и сводка."""
    s = await env.start(user)
    sid = s["session_id"]
    assert s["checks"] == 1
    task = await env.current(user, sid)
    results = []
    i = 0
    while task is not None and task["type"] == "check_item":
        body = await env.correct_body(task)
        if i >= correct:
            key = await env.key_of(task["task_id"])
            body = {"choice": (key["answer"] + 1) % len(task["options"])} if task["answer_kind"] == "choice" else (
                {"text": "wrong"} if task["answer_kind"] == "text" else {"order": list(range(len(task["options"])))})
        res = await env.answer(user, sid, task, body)
        assert res["result"] is None and res["correct_answer"] is None and res["next_review_in_days"] is None
        results.append(res)
        task = res["next"]
        i += 1
    while task is not None:
        res = await env.answer(user, sid, task, await env.correct_body(task))
        task = res["next"]
    summary = await env.post(user, f"review-sessions/{sid}/finish")
    return {"results": results, "summary": summary, "session": s}


async def test_d7_then_d30_retained(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    t0 = env.now
    evidence = await demonstrated(env, user)
    [(stage, status, due, *_)] = await checks(env, user)
    assert (stage, status, due) == ("d7", "scheduled", t0 + timedelta(days=7))
    assert (await env.get(user, "overview"))["retention_due"] == 0
    r = await env.c.post("/internal/v1/review-sessions", headers={**env.h(user), "Idempotency-Key": "k-early-01"})
    assert r.status_code == 409 and r.json()["details"]["next_due_at"] == "2026-11-27T05:00:00.000Z"
    env.now = t0 + timedelta(days=7, hours=1)
    assert (await env.get(user, "overview"))["retention_due"] == 1
    s = await env.start(user, key="k-check-001")
    task = await env.current(user, s["session_id"])
    assert task["type"] == "check_item" and task["hints"] == [] and task["check"]["of"] == 3
    assert task["check"]["position"] == 1 and task["check"]["skill_title"]["ru"]
    for kind in ("first_letter", "reveal"):
        r = await env.c.post(f"/internal/v1/review-sessions/{s['session_id']}/tasks/{task['task_id']}/hint",
                             json={"kind": kind}, headers=env.h(user))
        assert r.status_code == 409 and r.json()["code"] == "HINTS_NOT_ALLOWED"
    await env.post(user, f"review-sessions/{s['session_id']}/cancel")  # посреди блока — проверка вернётся
    assert (await checks(env, user))[0][1] == "scheduled"
    out = await run_block(env, user, correct=3)
    last = out["results"][-1]["check_result"]
    assert last["passed"] is True and (last["correct"], last["total"]) == (3, 3)
    assert all(i["correct"] and i["correct_answer"] and i["prompt_en"] for i in last["items"])
    assert out["results"][0]["check_result"] is None
    assert out["summary"]["checks"] == [{"skill_title": task["check"]["skill_title"], "stage": "d7", "passed": True,
                                         "skill_retained": False}]
    [ev] = await env.events("memory.retention.checked.v1", user)
    assert ev.payload["passed"] is True and ev.payload["stage"] == "d7" and ev.payload["evidence_id"] == evidence
    assert ev.payload["consecutive_failures"] == 0 and ev.payload["skill_id"] == SKILL
    rows = await checks(env, user)
    assert [(r[0], r[1]) for r in rows] == [("d7", "passed"), ("d30", "scheduled")]
    assert rows[1][2] == t0 + timedelta(days=30)  # demonstrated_at + 30
    env.now = t0 + timedelta(days=30, hours=1)
    out = await run_block(env, user, correct=2)
    assert out["summary"]["checks"][0] == {**out["summary"]["checks"][0], "stage": "d30", "passed": True,
                                           "skill_retained": True}
    evs = await env.events("memory.retention.checked.v1", user)
    assert [(e.payload["stage"], e.payload["passed"]) for e in evs] == [("d7", True), ("d30", True)]
    assert [(r[0], r[1]) for r in await checks(env, user)] == [("d7", "passed"), ("d30", "passed")]
    # XP и игровые события проверка не даёт: memory публикует только своё событие
    assert {e.event_type for e in env.bus.published if e.producer == "memory"} <= {
        "memory.retention.checked.v1", "memory.review.completed.v1"}


async def test_failures_retry_then_chain_ends(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    t0 = env.now
    await demonstrated(env, user)
    env.now = t0 + timedelta(days=7)
    out = await run_block(env, user, correct=1)
    assert out["results"][-1]["check_result"]["passed"] is False
    rows = await checks(env, user)
    assert [(r[0], r[1], r[3], r[4]) for r in rows] == [("d7", "failed", 1, 1), ("d7", "scheduled", 2, 1)]
    assert rows[1][2] == env.now + timedelta(days=3) or rows[1][2] > t0 + timedelta(days=9)
    env.now += timedelta(days=3, hours=1)
    await run_block(env, user, correct=0)
    evs = await env.events("memory.retention.checked.v1", user)
    assert [(e.payload["passed"], e.payload["consecutive_failures"]) for e in evs] == [(False, 1), (False, 2)]
    assert [r[1] for r in await checks(env, user)] == ["failed", "failed"]  # цепочка закончена


async def test_state_changes_cancel_and_restart_chain(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await demonstrated(env, user)
    await demonstrated(env, user, frm="learning", to="demonstrated")  # повторное — новая цепочка
    rows = await checks(env, user)
    assert [(r[1], r[5]) for r in rows] == [("cancelled", "restarted"), ("scheduled", None)]
    await demonstrated(env, user, frm="demonstrated", to="learning")
    assert [r[1] for r in await checks(env, user)] == ["cancelled", "cancelled"]
    [(state,)] = await env.sql("SELECT state FROM skill_projection WHERE user_id = :u", u=user)
    assert state == "learning"
    other = uuid.uuid4()
    await demonstrated(env, other, producer="lessons")  # чужой издатель — игнор
    assert await checks(env, other) == []


async def test_no_items_cancels_check(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await demonstrated(env, user, skill="en.func.introduce")  # нет уроков с этим основным навыком
    env.now += timedelta(days=8)
    r = await env.c.post("/internal/v1/review-sessions", headers={**env.h(user), "Idempotency-Key": "k-noitem-1"})
    assert r.status_code == 409 and r.json()["code"] == "NOTHING_TO_REVIEW"
    assert [(r[1], r[5]) for r in await checks(env, user)] == [("cancelled", "no_items")]
    assert await env.events("memory.retention.checked.v1", user) == []
    # catalog недоступен — проверка не отменяется, ждёт
    other = uuid.uuid4()
    await demonstrated(env, other)
    env.now += timedelta(days=8)
    env.catalog.down = True
    r = await env.c.post("/internal/v1/review-sessions", headers={**env.h(other), "Idempotency-Key": "k-down-001"})
    assert r.status_code == 409
    assert [r[1] for r in await checks(env, other)] == ["scheduled"]


async def test_postponed_without_activity_then_taken(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    active = uuid.uuid4()
    await demonstrated(env, user)
    await demonstrated(env, active)
    env.now += timedelta(days=7, minutes=10)
    await env.publish("lesson.session.completed.v1", {
        "session_id": str(uuid.uuid4()), "user_id": str(active), "kind": "lesson", "pair_id": "ru-en",
        "status": "completed", "minutes": 20, "practice_only": False, "local_date": "2026-11-26",
        "finished_at": "2026-11-26T10:00:00Z"}, "lessons")
    out = await env.tick()
    assert out["checks_postponed"] == 1
    [(_, status, due, _, _, _, postponed)] = await checks(env, user)
    assert status == "scheduled" and due == env.now + timedelta(days=1) and postponed == 1
    assert (await checks(env, active))[0][6] == 0
    # первое повторение после возвращения берёт её, хотя срок перенесён на завтра
    s = await env.start(user)
    assert s["checks"] == 1


def test_item_choice_prefers_unseen_lessons() -> None:
    def item(lid: str, n: int) -> dict[str, Any]:
        return {"lesson_id": lid, "version": 1, "item": {"item_id": f"{lid}-{n}", "type": "single_choice",
                                                         "options": ["a", "b"], "answer": 0}}
    data = {"items": [item("l-a", 1), item("l-a", 2), item("l-b", 1), item("l-c", 1), item("l-c", 2),
                      {"lesson_id": "l-x", "version": 1, "item": {"item_id": "bad", "type": "single_choice",
                                                                    "options": ["a"], "answer": 5}}]}
    picked = choose_items(data, {"l-a"}, 3)
    assert [p["item"]["item_id"] for p in picked] == ["l-b-1", "l-c-1", "l-a-1"]
    assert len(choose_items({"items": [item("l-a", 1)]}, set(), 3)) == 1
    own = item("l-a", 9)
    own["item"]["skill_id"] = "s-own"
    picked = choose_items({"items": [item("l-a", 1), own, item("l-b", 1)]}, set(), 2, "s-own")
    assert [p["item"]["item_id"] for p in picked] == ["l-a-9", "l-b-1"]  # сначала задания самого навыка
    assert required_correct(3) == 2 and required_correct(2) == 2
