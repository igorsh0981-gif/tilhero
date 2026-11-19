"""Исправления по ревью спринта 4 (lessons): R1-06 — подсказка партнёра по диалогу (`hint_offered`) = явная подсказка;
R1-13 — задания «по порядку» перемешаны по seed сессии и не в порядке ответа; R1-16 / R2-02 — сроки необязательных
вызовов (статус ИИ 2 с, второстепенные вызовы итогов, повторное чтение оценки); R2-01 — при повторе урока задания,
верный ответ к которым ученик видел в прошлых итогах, уходят в оценку как `hinted`."""

from __future__ import annotations

import copy
import time
import uuid
from typing import Any

from conftest import Env
from ls_testkit import SEED_DATA, wrong_answer

from tilhero_lessons.domain.content import order_key, shown_options

LIST = "/admin/v1/lesson-sessions"
LESSON = "l-01-greetings"
WRONG = frozenset({"l-01-c1", "l-01-c3"})  # задания проверки, на которые в первой сессии дан неверный ответ


def _control(item_id: str, lesson_id: str = LESSON) -> dict[str, Any]:
    return next(c for c in SEED_DATA["lesson"][lesson_id]["control_items"] if c["item_id"] == item_id)


async def _play_lesson(env: Env, user: uuid.UUID, *,
                       wrong: frozenset[str] | set[str] = frozenset()) -> tuple[str, list[dict[str, Any]]]:
    """Урок до шага done: на задания проверки из `wrong` — неверный ответ, на остальное — верный."""
    s = await env.lesson(user, LESSON)
    sid = s["session_id"]
    step = await env.current(user, sid)
    shown = [step]
    while step["type"] != "done":
        body = env.body_for(step)
        if step["stage"] == "assessment" and step["type"] == "item" and step["item"]["item_id"] in wrong:
            body = {"answer": wrong_answer(step["item"])}
        step = (await env.answer(user, sid, step, body))["next"]
        shown.append(step)
    return sid, shown


# ---------------------------------------------------------------- R1-06: hint_offered


async def test_hint_offered_marks_turn_and_step_as_hinted(env: Env, user: uuid.UUID) -> None:
    scn = "sc-meet-phone-number"
    s = await env.start(user, f"scenarios/{scn}")
    sid = s["session_id"]
    step = await env.current(user, sid)
    env.ai.mode["conversation_partner"] = "unclear"
    env.ai.hint_offered = True  # персонаж подсказал в уточнении
    res = await env.answer(user, sid, step, {"text": "Banana weather tomorrow"})
    assert res["reply"]["clarification"] is True
    env.ai.mode["conversation_partner"] = "ok"
    env.ai.hint_offered = False
    step = (await env.answer(user, sid, res["next"], {"text": "Yes, sure, of course!"}))["next"]
    while step["type"] == "roleplay":
        step = (await env.answer(user, sid, step, {"choice_id": env.choice_to(step, "success", scn)}))["next"]
    await env.answer(user, sid, step, {})
    await env.finish(user, sid)
    [req] = env.assessment.requests
    learner = [t for t in req["turns"] if t["speaker"] == "learner"]
    assert learner[0]["mode"] == "text" and learner[0]["hinted"] is True  # реплика с подсказкой партнёра
    assert all(t["hinted"] is False for t in learner[1:])  # распознанная реплика без подсказки — без пометки
    assert req["roleplay"]["hints"] == 1  # как явная подсказка: в hint_usage оценщика и independence
    card = (await env.c.get(f"{LIST}/{sid}", headers=env.staff("qa.read"))).json()
    assert [st["hinted"] for st in card["steps"][:2]] == [True, False]
    assert "hints" in card["flags"]


# ---------------------------------------------------------------- R1-13: задания «по порядку»


def test_order_words_shuffled_by_seed_never_in_answer_order() -> None:
    item = _control("l-01-c3")
    key = order_key("order_words", item["options"], item["answer"])
    assert key == item["answer"]
    seen = set()
    for i in range(60):
        shown = shown_options(f"seed-{i}", item["item_id"], "order_words", item["options"], item["answer"])
        assert sorted(shown) == sorted(item["options"]) and shown != key
        assert shown == shown_options(f"seed-{i}", item["item_id"], "order_words", item["options"], item["answer"])
        seen.add(tuple(shown))
    assert len(seen) > 3  # у разных сессий — разный порядок
    # опубликовано до запрета в catalog: варианты в порядке ответа и пустые варианты — всё равно не в порядке ответа
    for options in (list(item["answer"]), []):
        for i in range(60):
            shown = shown_options(f"seed-{i}", "x", "order_words", options, item["answer"])
            assert sorted(shown) == sorted(item["answer"]) and shown != item["answer"]
    # два слова: единственный другой порядок
    assert {tuple(shown_options(f"s{i}", "x", "order_words", ["Hi", "Tom"], ["Hi", "Tom"]))
            for i in range(20)} == {("Tom", "Hi")}


def test_order_lines_shuffled_and_other_types_untouched() -> None:
    ex = SEED_DATA["media_exercise"]["mx-hello-song-3"]
    key = [ex["options"][i] for i in ex["answer"]]
    assert order_key("order_lines", ex["options"], ex["answer"]) == key
    for i in range(60):
        shown = shown_options(f"seed-{i}", ex["exercise_id"], "order_lines", ex["options"], ex["answer"])
        assert sorted(shown) == sorted(ex["options"]) and shown != key
    in_order = list(key)
    for i in range(60):
        assert shown_options(f"seed-{i}", "x", "order_lines", in_order, list(range(len(in_order)))) != in_order
    choice = _control("l-01-c1")
    assert shown_options("seed-1", "x", choice["type"], choice["options"], choice["answer"]) == choice["options"]


async def test_lesson_shows_order_words_shuffled_even_for_legacy_content(env: Env, user: uuid.UUID) -> None:
    """Опубликованная до правила catalog версия урока со словами в порядке ответа: ученик видит их перемешанными,
    верный ответ (слова по порядку) засчитывается."""
    payload = copy.deepcopy(env.catalog.payload("lesson", LESSON))
    c3 = next(c for c in payload["control_items"] if c["item_id"] == "l-01-c3")
    c3["options"] = list(c3["answer"])
    env.catalog.publish("lesson", LESSON, payload)
    sid, shown = await _play_lesson(env, user)
    [step] = [x for x in shown if x["type"] == "item" and x["item"]["item_id"] == "l-01-c3"]
    assert step["item"]["options"] != c3["answer"] and sorted(step["item"]["options"]) == sorted(c3["answer"])
    summary = await env.finish(user, sid)
    assert next(i for i in summary["evaluation"]["items"] if i["item_id"] == "l-01-c3")["correct"] is True
    answer = next(a for a in env.assessment.requests[-1]["answers"] if a["item_id"] == "l-01-c3")
    assert answer["answer"] == c3["answer"]


# ---------------------------------------------------------------- R1-16 / R2-02: сроки необязательных вызовов


async def test_slow_ai_status_does_not_block_start(env: Env, user: uuid.UUID) -> None:
    env.settings.ai_status_timeout_seconds = 0.2
    env.ai.available = False
    env.ai.status_delay = 3.0
    started = time.monotonic()
    s = await env.lesson(user)
    assert time.monotonic() - started < 2
    assert s["ai_mode"] == "full"  # статус не ответил вовремя — как ошибка связи: full, деградация на первом вызове
    await env.post(user, s["session_id"], "cancel")
    env.ai.status_delay = 0.0
    assert (await env.lesson(user, "l-02-where-from"))["ai_mode"] == "choices"  # ответил вовремя — «варианты»


async def test_summary_aux_calls_are_bounded(env: Env, user: uuid.UUID) -> None:
    env.settings.summary_aux_timeout_seconds = 0.2
    env.settings.summary_refresh_timeout_seconds = 0.2
    sid, _ = await _play_lesson(env, user)
    env.diagnostics.delay = 3.0
    env.plan.delay = 3.0
    started = time.monotonic()
    summary = await env.finish(user, sid)
    assert time.monotonic() - started < 2
    # оценка есть; «было» навыков и следующий урок не успели — итоги без них
    assert summary["status"] == "completed" and summary["evaluation"] is not None
    assert summary["skills"] == [] and summary["next_lesson"] is None
    # повторное чтение оценки в итогах: assessment не ответил вовремя — сохранённая копия
    env.assessment.delay = 3.0
    started = time.monotonic()
    r = await env.c.get(f"/internal/v1/sessions/{sid}/summary", headers=env.h(user))
    assert r.status_code == 200 and time.monotonic() - started < 2
    assert r.json()["evaluation"] == summary["evaluation"]


# ---------------------------------------------------------------- R2-01: ключ, виденный в прошлых итогах


async def test_retake_items_with_seen_keys_are_hinted(env: Env, user: uuid.UUID) -> None:
    sid1, _ = await _play_lesson(env, user, wrong=WRONG)
    first = await env.finish(user, sid1)
    shown_keys = {i["item_id"] for i in first["evaluation"]["items"] if i["correct"] is False}
    assert shown_keys == WRONG  # в итогах этим заданиям показан верный ответ
    assert all(a["hinted"] is False for a in env.assessment.requests[-1]["answers"])

    sid2, _ = await _play_lesson(env, user)  # повтор урока: всё верно
    second = await env.finish(user, sid2)
    req = env.assessment.requests[-1]
    assert {a["item_id"]: a["hinted"] for a in req["answers"]} == {
        c["item_id"]: c["item_id"] in WRONG for c in SEED_DATA["lesson"][LESSON]["control_items"]}
    items = {i["item_id"]: i for i in second["evaluation"]["items"]}
    # правильность засчитывается, в итогах — та же пометка, что у подсказки
    assert all(i["correct"] for i in items.values())
    assert {k for k, i in items.items() if i["hinted"]} == WRONG
    card = (await env.c.get(f"{LIST}/{sid2}", headers=env.staff("qa.read"))).json()
    hinted_steps = [st for st in card["steps"] if st["stage"] == "assessment" and st["hinted"]]
    assert len(hinted_steps) == len(WRONG)

    # третья сессия: ключи остаются «виденными» (история итогов доступна всегда)
    sid3, _ = await _play_lesson(env, user)
    await env.finish(user, sid3)
    assert {a["item_id"] for a in env.assessment.requests[-1]["answers"] if a["hinted"]} == WRONG

    # другой ученик и другой урок — без пометок
    other = uuid.uuid4()
    sid4, _ = await _play_lesson(env, other)
    await env.finish(user=other, sid=sid4)
    assert all(a["hinted"] is False for a in env.assessment.requests[-1]["answers"])


async def test_retake_after_pending_evaluation_not_hinted(env: Env, user: uuid.UUID) -> None:
    """Оценки не было (assessment недоступен при finish) — верные ответы не показывались, пометки нет."""
    env.assessment.mode = "down"
    sid1, _ = await _play_lesson(env, user, wrong=WRONG)
    pending = await env.finish(user, sid1)
    assert pending["evaluation"] is None
    env.assessment.mode = "ok"
    sid2, _ = await _play_lesson(env, user)
    await env.finish(user, sid2)
    req = next(r for r in reversed(env.assessment.requests) if r["session_id"] == sid2)
    assert all(a["hinted"] is False for a in req["answers"])
