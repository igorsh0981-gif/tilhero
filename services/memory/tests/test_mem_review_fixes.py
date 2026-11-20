"""Исправления по независимому ревью memory (спринт 5): пропуск в примере с типографским апострофом, цитата ошибки
не хранится в задании, 404 assessment без маршрута — повтор, вечернее окно напоминаний, фрагмент контента вместо
сырого ввода, неизменяемость истории (DELETE), «Не помню» без ответа, дети и взрослый контент, текст ошибки в
админке, Idempotency-Key ручной правки, допуск срока переноса."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from tilhero_memory.domain import tasks
from tilhero_memory.models import Card

READING = {"kind": "reading", "key": "r-a1-coffee", "version": 1}
ERR = [{"turn_id": "T1", "evidence": "I from Tashkent", "correction": "I am from Tashkent.",
        "error_code": "missing_be", "severity": "high"}]


def card(text: str, example: str | None, *, stability: float = 10.0) -> Card:
    now = datetime(2026, 11, 20, tzinfo=UTC)
    return Card(card_id=uuid.uuid4(), user_id=uuid.uuid4(), pair_id="ru-en", kind="phrase", key=text.lower(),
                text_en=text, gloss={"ru": "перевод", "uz": "tarjima"}, gloss_source="course", example_en=example,
                answers_en=[text], distractors=[], error=None, error_code=None, sources=[], status="review",
                fsrs_state="review", stability=stability, difficulty=5.0, reps=2, lapses=0,
                last_review_at=now - timedelta(days=10), due_at=now, created_at=now, updated_at=now)


# ---------------------------------------------------------------- 1. пропуск в примере


@pytest.mark.parametrize("seed", [f"s{i}" for i in range(12)])
def test_gap_cut_in_original_sentence_with_typographic_apostrophe(seed: str) -> None:
    c = card("What's your name?", "Hi! I’m Emma. What’s your name?")
    typ = tasks.card_task_type(c, young=False, seed=seed)
    assert typ in ("typed", "cloze")
    b = tasks.build_card_task(c, typ, seed=seed, locale="ru", pool=[])
    gap = b.payload["prompt"]["example_gap"]
    assert gap == "Hi! I’m Emma. ___?"
    assert "name" not in gap.lower()


def test_no_gap_when_answer_repeats_in_example() -> None:
    c = card("Hi!", "Hi, Tom! Hi!")
    for i in range(12):
        assert tasks.card_task_type(c, young=False, seed=f"s{i}") == "typed"  # cloze не выбирается
    b = tasks.build_card_task(c, "cloze", seed="x", locale="ru", pool=[])
    assert b.type == "typed" and b.payload["prompt"]["example_gap"] is None


# ---------------------------------------------------------------- 2. цитата ошибки — только из карточки


async def test_evidence_not_stored_in_task(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    env.identity.set(user)
    await env.lesson_done(user, errors=ERR)
    await env.sql("DELETE FROM cards WHERE user_id = :u AND kind <> 'error'", u=user)
    await env.make_review(user)
    s = await env.start(user)
    task = await env.current(user, s["session_id"])
    assert task["type"] == "error_fix" and task["prompt"]["evidence"] == "I from Tashkent"
    raw = await env.sql("SELECT payload::text, key::text FROM review_tasks WHERE session_id = :s",
                        s=uuid.UUID(s["session_id"]))
    assert all("Tashkent" not in p.replace("I am from Tashkent", "") for p, _ in raw)
    assert all("I from Tashkent" not in p and "I from Tashkent" not in k for p, k in raw)
    await env.sql("UPDATE cards SET error = jsonb_set(error, '{evidence}', 'null'::jsonb) WHERE user_id = :u", u=user)
    again = await env.current(user, s["session_id"])
    assert again["task_id"] == task["task_id"] and again["prompt"]["evidence"] is None


# ---------------------------------------------------------------- 3. 404 assessment без маршрута — повтор


async def test_feed_route_missing_is_retried(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    """404 без кода EVALUATION_NOT_FOUND (старая версия assessment без маршрута) — не «оценки нет», а повтор."""
    from mem_testkit import error

    ev = env.assessment.feed(user)
    transport = env.runtime.clients["assessment"]._client._transport
    original = transport.handler
    transport.handler = lambda request: error(404, "NOT_FOUND")
    try:
        await env.publish("assessment.completed.v1", {
            "evaluation_id": ev, "user_id": str(user), "pair_id": "ru-en",
            "session_id": env.assessment.feeds[ev]["session_id"], "kind": "lesson", "skill_outcomes": [],
            "practice_only": False, "created_at": "2026-11-20T05:00:00Z"}, "assessment")
    finally:
        transport.handler = original
    assert [e.payload["evaluation_id"] for _, e in env.bus.transient] == [ev]
    assert await env.sql("SELECT count(*) FROM feed_log") == [(0,)]


# ---------------------------------------------------------------- 4. вечернее окно напоминаний


async def test_reminder_window_until_22_and_missed_tick(env) -> None:  # type: ignore[no-untyped-def]
    users = []
    for _ in range(3):
        u = uuid.uuid4()
        await env.plan(u)
        await env.lesson_done(u)
        await env.make_review(u)
        users.append(u)
    env.settings.reminders_per_tick = 2
    env.now = datetime(2026, 11, 20, 14, 40, tzinfo=UTC)  # 19:40 — тик 19:00–19:14 пропущен
    assert (await env.tick())["reminders_sent"] == 2
    env.now = datetime(2026, 11, 20, 16, 59, tzinfo=UTC)  # 21:59 — остаток догоняется
    assert (await env.tick())["reminders_sent"] == 1
    late = uuid.uuid4()
    await env.plan(late)
    await env.lesson_done(late)
    await env.make_review(late)
    env.now = datetime(2026, 11, 20, 17, 0, tzinfo=UTC)  # 22:00 — окно закрыто
    assert (await env.tick())["reminders_sent"] == 0
    assert {e.payload["user_id"] for e in await env.events("memory.reviews.due.v1")} == {str(u) for u in users}


# ---------------------------------------------------------------- 5. фрагмент контента вместо сырого ввода


async def test_surface_from_content_not_raw_input(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    res = await env.post(user, "translate", {"text": "  BARISTA ", "content": READING})
    assert res["source"] == "ai" and env.ai.requests[-1]["context"]["word"] == "barista"
    assert env.catalog.by_form("barista")["lemma"] == "barista"
    added = await env.post(user, "cards", {"text_en": "CROISSANT", "source": READING}, 201, key="k-surface-1")
    assert added["text_en"] == "croissant"


# ---------------------------------------------------------------- 6. история: DELETE только каскадом


async def test_review_log_delete_only_with_card(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    cid = (await env.get(user, "cards"))["items"][0]["card_id"]
    await env.post(user, f"cards/{cid}/known")
    with pytest.raises(Exception, match="immutable"):
        await env.sql("DELETE FROM review_log WHERE user_id = :u", u=user)
    await env.sql("DELETE FROM cards WHERE card_id = :c", c=uuid.UUID(cid))  # каскад (сага удаления) — можно
    assert await env.sql("SELECT count(*) FROM review_log WHERE user_id = :u", u=user) == [(0,)]


# ---------------------------------------------------------------- 7. «Не помню» без ответа


@pytest.mark.parametrize("close", ["cancel", "expire"])
async def test_revealed_without_answer_graded_again(env, user: uuid.UUID, close: str) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    await env.make_review(user)
    s = await env.start(user)
    sid = s["session_id"]
    task = await env.current(user, sid)
    await env.post(user, f"review-sessions/{sid}/tasks/{task['task_id']}/hint", {"kind": "reveal"})
    if close == "cancel":
        await env.post(user, f"review-sessions/{sid}/cancel")
    else:
        env.now += timedelta(hours=3)
        await env.tick()
    [(grade, revealed, mode)] = await env.sql("SELECT grade, revealed, answer_mode FROM review_log WHERE user_id = :u",
                                              u=user)
    assert grade == "again" and revealed is True and mode == tasks.ANSWER_MODE[task["type"]]
    [(result, t_grade)] = await env.sql("SELECT result, grade FROM review_tasks WHERE task_id = :t",
                                        t=uuid.UUID(task["task_id"]))
    assert (result, t_grade) == ("incorrect", "again")
    [(state,)] = await env.sql("SELECT fsrs_state FROM cards WHERE card_id = :c", c=uuid.UUID(task["card_id"]))
    assert state == "learning"


# ---------------------------------------------------------------- 8. дети и взрослый контент


async def test_kids_only_kids_content(env) -> None:  # type: ignore[no-untyped-def]
    kid = uuid.uuid4()
    r = await env.c.post("/internal/v1/translate", json={"text": "barista", "content": READING},
                         headers=env.h(kid, age_band="6-9"))
    assert r.status_code == 404 and r.json()["code"] == "CONTENT_NOT_FOUND"
    r = await env.c.post("/internal/v1/cards", json={"text_en": "barista", "source": READING},
                         headers={**env.h(kid, age_band="6-9"), "Idempotency-Key": "k-kid-adult-1"})
    assert r.status_code == 404
    assert env.ai.requests == []
    ok = await env.post(kid, "translate", {"text": "milk", "content": {"kind": "reading", "key": "r-kids-cat",
                                                                       "version": 1}}, age_band="6-9")
    assert ok["gloss"] is not None
    # кеш проверки «слово в тексте» — по аудитории: взрослый проверил, ребёнку всё равно 404
    adult = uuid.uuid4()
    await env.post(adult, "translate", {"text": "friendly", "content": READING})
    r = await env.c.post("/internal/v1/translate", json={"text": "friendly", "content": READING},
                         headers=env.h(kid, age_band="6-9"))
    assert r.status_code == 404


# ---------------------------------------------------------------- 9. админка: текст ошибки не показывается


async def test_admin_hides_error_text(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    env.identity.set(user)
    await env.lesson_done(user, errors=ERR)
    page = (await env.c.get(f"/admin/v1/memory/learners/{user}/cards?kind=error",
                            headers=env.staff("memory.read"))).json()
    [row] = page["items"]
    assert row["text_en"] is None and row["error_code"] == "missing_be"
    detail = (await env.c.get(f"/admin/v1/memory/cards/{row['card_id']}", headers=env.staff("memory.read"))).json()
    assert detail["text_en"] is None and detail["example_en"] is None
    assert "Tashkent" not in json.dumps(detail)
    word = (await env.c.get(f"/admin/v1/memory/learners/{user}/cards?kind=word",
                            headers=env.staff("memory.read"))).json()["items"][0]
    assert word["text_en"]


# ---------------------------------------------------------------- 10–11. ручная правка: ключ и допуск срока


async def test_card_action_idempotency_and_due_tolerance(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    await env.make_review(user)
    [(cid,)] = await env.sql("SELECT card_id FROM cards WHERE user_id = :u AND key = 'hello'", u=user)
    url = f"/admin/v1/memory/cards/{cid}/actions"
    staff = env.staff("memory.manage")
    body = {"action": "freeze", "reason": "жалоба на перевод слова"}
    r1 = await env.c.post(url, json=body, headers={**staff, "Idempotency-Key": "adm-key-0001"})
    r2 = await env.c.post(url, json=body, headers={**staff, "Idempotency-Key": "adm-key-0001"})
    assert r1.status_code == r2.status_code == 200 and r1.json() == r2.json()
    assert await env.sql("SELECT count(*) FROM review_log WHERE card_id = :c", c=cid) == [(1,)]
    await env.flush()
    assert len([e for e in env.bus.published if e.event_type == "admin.audit.recorded.v1"]) == 1
    r = await env.c.post(url, json={**body, "reason": "другая причина правки"},
                         headers={**staff, "Idempotency-Key": "adm-key-0001"})
    assert r.status_code == 422 and r.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    other = env.staff("memory.manage")  # другой сотрудник с тем же ключом — своя команда
    r = await env.c.post(url, json=body, headers={**other, "Idempotency-Key": "adm-key-0001"})
    assert r.status_code == 409 and r.json()["details"] == {"status": "frozen"}
    env.now += timedelta(hours=25)  # ключ старше 24 ч — новая команда
    r = await env.c.post(url, json=body, headers={**staff, "Idempotency-Key": "adm-key-0001"})
    assert r.status_code == 409
    await env.c.post(url, json={"action": "unfreeze", "reason": "перевод исправлен методистом"}, headers=staff)
    for delta in (timedelta(hours=12), timedelta(days=366)):  # полдень завтрашнего дня; 365 дней + сутки
        r = await env.c.post(url, json={"action": "reschedule", "due_at": (env.now + delta).isoformat(),
                                        "reason": "перенос по просьбе родителя"}, headers=staff)
        assert r.status_code == 200, r.text
    r = await env.c.post(url, json={"action": "reschedule", "due_at": env.now.isoformat(),
                                    "reason": "перенос по просьбе родителя"}, headers=staff)
    assert r.status_code == 422 and r.json()["code"] == "DUE_AT_RANGE"
    r = await env.c.post(url, json=body, headers={**staff, "Idempotency-Key": "bad"})
    assert r.status_code == 422 and r.json()["code"] == "IDEMPOTENCY_KEY_INVALID"
