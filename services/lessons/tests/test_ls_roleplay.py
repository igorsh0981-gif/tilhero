"""Ролевая ситуация (AT-43, AT-42): выбор реплики до каждого исхода по графу; свободный текст через
conversation_partner (распознано / unclear ×2 → только варианты / unavailable → варианты + ai_degraded / ребёнок →
403 без вызова ИИ); повторная попытка после fail с точки восстановления; пауза → ближайшая точка восстановления."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from conftest import Env

SCN = "sc-meet-phone-number"


async def _scenario(env: Env, user: uuid.UUID, scenario_id: str = SCN, **kw: Any) -> tuple[str, dict[str, Any]]:
    s = await env.start(user, f"scenarios/{scenario_id}", **kw)
    assert [x["type"] for x in s["stages"]] == ["roleplay", "summary"]
    return s["session_id"], await env.current(user, s["session_id"], **kw)


def _choice(step: dict[str, Any], text: str) -> str:
    return next(c["choice_id"] for c in step["choices"] if c["text_en"] == text)


@pytest.mark.parametrize("outcome", ["success", "alt_success", "fail"])
async def test_choices_reach_every_outcome(env: Env, user: uuid.UUID, outcome: str) -> None:
    sid, step = await _scenario(env, user)
    assert step["type"] == "roleplay" and step["node_id"] == "start" and step["character"]["name"] == "Jake"
    assert step["free_text_allowed"] is True and step["history"] == [] and step["unclear_attempts"] == 0
    assert {c["choice_id"] for c in step["choices"]} == {"c1", "c2"}
    while step["type"] == "roleplay":
        res = await env.answer(user, sid, step, {"choice_id": env.choice_to(step, outcome, SCN)})
        nxt = res["next"]
        if nxt["type"] == "roleplay":
            # ответ персонажа — реплика следующего узла графа; история чата растёт
            assert res["reply"] == {"character_id": "jake", "text_en": nxt["line_en"], "gloss": nxt["gloss"],
                                    "clarification": False}
            assert nxt["history"][-1]["speaker"] == "learner"
        step = nxt
    assert step["type"] == "roleplay_end" and step["outcome"] == outcome
    assert step["can_retry"] is (outcome == "fail")
    done = (await env.answer(user, sid, step, {}))["next"]
    assert done["type"] == "done"
    summary = await env.finish(user, sid)
    assert summary["outcome"] == outcome and summary["kind"] == "scenario"
    [req] = env.assessment.requests
    assert req["kind"] == "scenario" and req["roleplay"]["outcome"] == outcome and req["answers"] == []
    assert req["content_refs"]["rubric"] == {"key": "r-roleplay", "version": 1}
    assert all(t["mode"] == "choice" for t in req["turns"])
    [ev] = await env.events("lesson.session.completed.v1", user)
    assert ev.payload["outcome"] == outcome and ev.payload["scenario_id"] == SCN


async def test_choices_are_shuffled_reproducibly_by_seed(env: Env, user: uuid.UUID) -> None:
    orders = []
    for _ in range(6):
        env.app.state.seed_factory = lambda: "fixed-seed"
        sid, step = await _scenario(env, user)
        orders.append([c["text_en"] for c in step["choices"]])
        await env.post(user, sid, "cancel")
    assert all(o == orders[0] for o in orders)
    seen = set()
    for i in range(12):
        env.app.state.seed_factory = lambda i=i: f"seed-{i}"
        sid, step = await _scenario(env, user)
        seen.add(tuple(c["text_en"] for c in step["choices"]))
        await env.post(user, sid, "cancel")
    assert len(seen) == 2  # оба порядка встречаются


async def test_free_text_recognized_intent(env: Env, user: uuid.UUID) -> None:
    sid, step = await _scenario(env, user)
    res = await env.answer(user, sid, step, {"text": "Yes, sure, of course!"})
    assert res["reply"] == {"character_id": "jake", "text_en": "Nice! Let's go on.", "gloss": None,
                            "clarification": False}
    nxt = res["next"]
    assert nxt["node_id"] == "ask_number"
    texts = [h["text_en"] for h in nxt["history"]]
    assert texts[-2:] == ["Yes, sure, of course!", "Nice! Let's go on."]
    [call] = env.ai.requests
    assert call["agent"] == "conversation_partner" and call["audience"] == "adults"
    assert call["user_id"] == str(user) and call["session_kind"] == "scenario"
    ctx = call["context"]
    assert ctx["node"]["node_id"] == "start" and ctx["learner_turn"] == "Yes, sure, of course!"
    assert {t["intent"] for t in ctx["node"]["transitions"]} == {"agree", "ask_what"}
    assert len(ctx["history"]) <= 6 and set(ctx) == {"scenario", "node", "history", "learner_turn",
                                                       "attempts_on_node"}
    # повтор той же реплики → тот же результат без второго вызова ИИ
    again = await env.answer(user, sid, step, {"text": "Yes, sure, of course!"})
    assert again == res and len(env.ai.requests) == 1
    view = (await env.c.get(f"/internal/v1/sessions/{sid}", headers=env.h(user))).json()
    assert view["ai_degraded"] is False


async def test_unclear_twice_then_only_choices(env: Env, user: uuid.UUID) -> None:
    env.ai.mode["conversation_partner"] = "unclear"
    sid, step = await _scenario(env, user)
    first = await env.answer(user, sid, step, {"text": "Banana weather tomorrow"})
    assert first["reply"]["clarification"] is True and first["reply"]["text_en"] == "Sorry, can you say it again?"
    s2 = first["next"]
    assert s2["node_id"] == "start" and s2["unclear_attempts"] == 1 and s2["free_text_allowed"] is True
    env.ai.mode["conversation_partner"] = "off_topic"
    second = await env.answer(user, sid, s2, {"text": "I like football"})
    s3 = second["next"]
    assert s3["node_id"] == "start" and s3["unclear_attempts"] == 2 and s3["free_text_allowed"] is False
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{s3['step_id']}", json={"text": "Yes"},
                         headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "FREE_TEXT_NOT_ALLOWED"
    res = await env.answer(user, sid, s3, {"choice_id": _choice(s3, "Yes, sure!")})
    assert res["next"]["node_id"] == "ask_number" and res["next"]["free_text_allowed"] is True
    assert res["next"]["unclear_attempts"] == 0


@pytest.mark.parametrize("mode", ["unavailable", "error", "garbage"])
async def test_ai_unavailable_falls_back_to_choices(env: Env, user: uuid.UUID, mode: str) -> None:
    env.ai.mode["conversation_partner"] = mode
    sid, step = await _scenario(env, user)
    res = await env.answer(user, sid, step, {"text": "Yes, sure!"})
    assert res["reply"]["text_en"] == "Let's choose an answer." and res["reply"]["clarification"] is True
    assert res["reply"]["gloss"]["ru"] == "Давайте выберем ответ"
    nxt = res["next"]
    assert nxt["node_id"] == "start" and nxt["free_text_allowed"] is False
    view = (await env.c.get(f"/internal/v1/sessions/{sid}", headers=env.h(user))).json()
    assert view["ai_degraded"] is True and view["ai_mode"] == "full"
    # дальше в этом этапе ИИ не вызывается — сценарий проходится выбором реплик
    calls = len(env.ai.requests)
    step = nxt
    while step["type"] == "roleplay":
        assert step["free_text_allowed"] is False
        step = (await env.answer(user, sid, step, {"choice_id": env.choice_to(step, "success", SCN)}))["next"]
    assert step["outcome"] == "success" and len(env.ai.requests) == calls


async def test_kids_text_forbidden_and_ai_not_called(env: Env, user: uuid.UUID) -> None:
    env.child(user)
    s = await env.start(user, "scenarios/sc-meet-greetings")
    assert s["ai_mode"] == "choices"
    step = await env.current(user, s["session_id"])
    assert step["free_text_allowed"] is False
    r = await env.c.post(f"/internal/v1/sessions/{s['session_id']}/steps/{step['step_id']}",
                         json={"text": "Hello!"}, headers=env.h(user))
    assert r.status_code == 403 and r.json()["code"] == "KIDS_NOT_ALLOWED"
    assert env.ai.requests == []
    # взрослый сценарий детям недоступен
    await env.post(user, s["session_id"], "cancel")
    await env.start(user, f"scenarios/{SCN}", expect=404)
    # детский профиль по lrn ≠ sub — тоже kids, даже если BFF прислал взрослый возраст
    kid = uuid.uuid4()
    s = await env.start(kid, "scenarios/sc-meet-greetings", account=uuid.uuid4(), age_band="18+")
    assert s["ai_mode"] == "choices"


async def test_adult_refused_by_gateway_falls_back(env: Env, user: uuid.UUID) -> None:
    env.ai.mode["conversation_partner"] = "refused"
    sid, step = await _scenario(env, user)
    res = await env.answer(user, sid, step, {"text": "Yes, sure!"})
    assert res["next"]["free_text_allowed"] is False and res["reply"]["clarification"] is True


async def test_retry_after_fail_from_recovery_point(env: Env, user: uuid.UUID) -> None:
    sid, step = await _scenario(env, user)
    while step["type"] == "roleplay":
        step = (await env.answer(user, sid, step, {"choice_id": env.choice_to(step, "fail", SCN)}))["next"]
    assert step["outcome"] == "fail" and step["can_retry"] is True
    retried = await env.post(user, sid, "roleplay/retry")
    assert retried["type"] == "roleplay" and retried["node_id"] == "start" and retried["history"] == []
    # старый шаг завершения больше не текущий; второй повтор невозможен
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}", json={}, headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "STEP_NOT_CURRENT"
    step = retried
    while step["type"] == "roleplay":
        step = (await env.answer(user, sid, step, {"choice_id": env.choice_to(step, "fail", SCN)}))["next"]
    assert step["outcome"] == "fail" and step["can_retry"] is False
    r = await env.c.post(f"/internal/v1/sessions/{sid}/roleplay/retry", headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "RETRY_NOT_AVAILABLE"
    await env.answer(user, sid, step, {})
    summary = await env.finish(user, sid)
    assert summary["outcome"] == "fail"


async def test_retry_success_on_second_attempt(env: Env, user: uuid.UUID) -> None:
    sid, step = await _scenario(env, user)
    while step["type"] == "roleplay":
        step = (await env.answer(user, sid, step, {"choice_id": env.choice_to(step, "fail", SCN)}))["next"]
    step = await env.post(user, sid, "roleplay/retry")
    while step["type"] == "roleplay":
        step = (await env.answer(user, sid, step, {"choice_id": env.choice_to(step, "success", SCN)}))["next"]
    assert step["outcome"] == "success"
    await env.answer(user, sid, step, {})
    summary = await env.finish(user, sid)
    assert summary["outcome"] == "success"
    [req] = env.assessment.requests
    assert req["roleplay"]["outcome"] == "success"


async def test_pause_resumes_from_nearest_recovery_point(env: Env, user: uuid.UUID) -> None:
    sid, step = await _scenario(env, user)
    step = (await env.answer(user, sid, step, {"choice_id": _choice(step, "Yes, sure!")}))["next"]
    assert step["node_id"] == "ask_number"  # не точка восстановления
    paused = await env.post(user, sid, "pause")
    assert paused["status"] == "paused" and paused["expires_at"] is not None
    resumed = await env.current(user, sid)
    assert resumed["node_id"] == "start" and resumed["step_id"] != step["step_id"]
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}",
                         json={"choice_id": "c1"}, headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "STEP_NOT_CURRENT"
    # на точке восстановления пауза не откатывает
    await env.post(user, sid, "pause")
    again = await env.current(user, sid)
    assert again["step_id"] == resumed["step_id"]


async def test_roleplay_hint_is_marked(env: Env, user: uuid.UUID) -> None:
    sid, step = await _scenario(env, user)
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}/hint", headers=env.h(user))
    assert r.status_code == 200 and set(r.json()["hint"]) == {"ru", "uz"}
    cur = await env.current(user, sid)
    assert cur["hints_used"] == 1
    while cur["type"] == "roleplay":
        cur = (await env.answer(user, sid, cur, {"choice_id": env.choice_to(cur, "success", SCN)}))["next"]
    await env.answer(user, sid, cur, {})
    await env.finish(user, sid)
    [req] = env.assessment.requests
    assert req["roleplay"]["hints"] == 1 and req["turns"][1]["hinted"] is True


async def test_agent_requests_match_ai_gateway_contract(env: Env, user: uuid.UUID) -> None:
    """Контрактный тест: AgentInvokeRequest и контексты агентов lessons принимает ai-gateway (extra=forbid)."""
    internal = pytest.importorskip("tilhero_ai_gateway.api.internal")
    contracts = pytest.importorskip("tilhero_ai_gateway.contracts")
    sid, step = await _scenario(env, user)
    env.ai.mode["conversation_partner"] = "unclear"
    step = (await env.answer(user, sid, step, {"text": "Hmm " + "x" * 480}))["next"]
    env.ai.mode["conversation_partner"] = "ok"
    step = (await env.answer(user, sid, step, {"text": "Yes, sure!"}))["next"]
    for text in ("Sorry, I don't share my number.", "OK"):
        if step["type"] != "roleplay" or not step["free_text_allowed"]:
            break
        step = (await env.answer(user, sid, step, {"text": text}))["next"]
    await env.post(user, sid, "cancel")
    lesson = await env.lesson(user)
    cur = await env.current(user, lesson["session_id"])
    await env.answer(user, lesson["session_id"], cur, {})
    await env.post(user, lesson["session_id"], "simpler")
    assert {r["agent"] for r in env.ai.requests} == {"conversation_partner", "teaching_coach"}
    for req in env.ai.requests:
        agent = req.pop("agent")
        internal.InvokeIn.model_validate(req)
        normalized, errors = contracts.validate_context(agent, req["context"])
        assert errors == [] and normalized is not None, errors


@pytest.mark.parametrize("available", [False, None])
async def test_ai_off_at_start_means_choices_from_first_step(env: Env, user: uuid.UUID,
                                                             available: bool | None) -> None:
    """Аварийная остановка (ai-gateway status false) — занятие сразу в «вариантах»: без свободного текста, без открытого
    задания, плашка упрощённого режима. Статус недоступен (500) — старт в full, деградация на первом отказе."""
    env.ai.available = available
    s = await env.start(user, f"scenarios/{SCN}")
    step = await env.current(user, s["session_id"])
    if available is False:
        assert s["ai_mode"] == "choices" and s["ai_degraded"] is True
        assert step["free_text_allowed"] is False
        r = await env.c.post(f"/internal/v1/sessions/{s['session_id']}/steps/{step['step_id']}",
                             json={"text": "Yes, sure!"}, headers=env.h(user))
        assert r.status_code == 409 and r.json()["code"] == "FREE_TEXT_NOT_ALLOWED"
        await env.post(user, s["session_id"], "cancel")
        lesson = await env.lesson(user)
        assert lesson["ai_mode"] == "choices" and lesson["ai_degraded"] is True
        [(plan,)] = await env.sql("SELECT plan FROM sessions WHERE session_id = :sid",
                                  sid=uuid.UUID(lesson["session_id"]))
        units = [u["t"] for st in plan["stages"] for u in st["units"]]
        assert "open_answer" not in units and "item" in units
    else:
        assert s["ai_mode"] == "full" and s["ai_degraded"] is False and step["free_text_allowed"] is True
    assert [r for r in env.ai.requests if r.get("agent")] == []


async def test_ai_busy_returns_409_and_keeps_session(env: Env, user: uuid.UUID) -> None:
    """ai-gateway 409 IDEMPOTENCY_IN_PROGRESS (дубль реплики) — не «ИИ недоступен»: клиенту 409 AI_BUSY, сессия не
    меняется (нет деградации, шаг тот же); повтор после ответа шлюза — обычный ход."""
    sid, step = await _scenario(env, user)
    env.ai.mode["conversation_partner"] = "busy"
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}", json={"text": "Yes, sure!"},
                         headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "AI_BUSY"
    view = (await env.c.get(f"/internal/v1/sessions/{sid}", headers=env.h(user))).json()
    assert view["ai_degraded"] is False
    assert (await env.current(user, sid))["step_id"] == step["step_id"]
    env.ai.mode["conversation_partner"] = "ok"
    res = await env.answer(user, sid, step, {"text": "Yes, sure!"})
    assert res["reply"]["clarification"] is False and res["next"]["free_text_allowed"] is True
