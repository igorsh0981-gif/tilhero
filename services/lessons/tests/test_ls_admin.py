"""«Контроль диалогов» (AT-52): журнал сессий и карточка (qa.read, без текстов), транскрипт (qa.transcripts,
причина ≥ 10, аудит qa.transcript_viewed), стёртые по сроку реплики; права в домене по actor."""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from datetime import UTC, datetime, timedelta

from conftest import T0, Env

LIST = "/admin/v1/lesson-sessions"


async def _text_session(env: Env, user: uuid.UUID) -> str:
    s = await env.start(user, "scenarios/sc-meet-phone-number")
    sid = s["session_id"]
    step = await env.current(user, sid)
    res = await env.answer(user, sid, step, {"text": "Yes, sure, my secret phrase"})
    await env.c.post(f"/internal/v1/sessions/{sid}/steps/{res['next']['step_id']}/hint", headers=env.h(user))
    step = res["next"]
    while step["type"] == "roleplay":
        step = (await env.answer(user, sid, step, {"choice_id": env.choice_to(step, "success",
                                                                               "sc-meet-phone-number")}))["next"]
    await env.answer(user, sid, step, {})
    await env.finish(user, sid)
    return sid


async def test_permissions(env: Env, user: uuid.UUID) -> None:
    sid = await _text_session(env, user)
    r = await env.c.get(LIST)
    assert r.status_code == 401
    r = await env.c.get(LIST, headers=env.h(user))  # telegram-bff — не вызывающий админки
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    r = await env.c.get(LIST, headers=env.staff("qa.read", actor=False))
    assert r.status_code == 403 and r.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    r = await env.c.get(LIST, headers=env.staff("content.read"))
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    r = await env.c.get(f"{LIST}/{sid}", headers=env.staff("costs.read"))
    assert r.status_code == 403
    r = await env.c.post(f"{LIST}/{sid}/transcript", json={"reason": "Проверка жалобы ученика"},
                         headers=env.staff("qa.read"))
    assert r.status_code == 403 and r.json()["details"]["permission"] == "qa.transcripts"
    r = await env.c.get(f"{LIST}/{uuid.uuid4()}", headers=env.staff("qa.read"))
    assert r.status_code == 404


async def test_list_and_card_without_texts(env: Env, user: uuid.UUID) -> None:
    sid = await _text_session(env, user)
    env.now += timedelta(seconds=1)  # часы в тестах заморожены: без сдвига порядок решал бы случайный session_id
    other = uuid.uuid4()
    o = await env.lesson(other)
    r = await env.c.get(LIST, headers=env.staff("qa.read"))
    assert r.status_code == 200, r.text
    page = r.json()
    assert [x["session_id"] for x in page["items"]] == [o["session_id"], sid]
    row = page["items"][1]
    assert row["kind"] == "scenario" and row["status"] == "completed" and row["outcome"] == "success"
    assert row["level"] == "A1" and row["audience"] == "adults" and row["ai_mode"] == "full"
    assert set(row["flags"]) == {"ai_used", "hints"} and row["passed"] is True
    assert "cost_usd" not in row and "user_id" not in row
    text = json.dumps(page, ensure_ascii=False)
    assert "secret phrase" not in text and str(user) not in text
    for params, expected in [({"kind": "lesson"}, [o["session_id"]]), ({"status": "completed"}, [sid]),
                             ({"outcome": "success"}, [sid]), ({"flag": "hints"}, [sid]),
                             ({"flag": "ai_unavailable"}, []), ({"lesson_id": "l-01-greetings"}, [o["session_id"]]),
                             ({"level": "A0"}, [o["session_id"]]), ({"limit": 1}, [o["session_id"]])]:
        got = (await env.c.get(LIST, params=params, headers=env.staff("qa.read"))).json()
        assert [x["session_id"] for x in got["items"]] == expected, params
    nxt = (await env.c.get(LIST, params={"limit": 1}, headers=env.staff("qa.read"))).json()["next_cursor"]
    got = (await env.c.get(LIST, params={"limit": 1, "cursor": nxt}, headers=env.staff("qa.read"))).json()
    assert [x["session_id"] for x in got["items"]] == [sid]
    r = await env.c.get(LIST, params={"flag": "appealed"}, headers=env.staff("qa.read"))
    assert r.status_code == 422 and r.json()["code"] == "FLAG_NOT_SUPPORTED"
    r = await env.c.get(LIST, params={"from": (env.now + timedelta(days=1)).isoformat()},
                        headers=env.staff("qa.read"))
    assert r.json()["items"] == []

    card = (await env.c.get(f"{LIST}/{sid}", headers=env.staff("qa.read"))).json()
    # R2-06: user_ref — HMAC-SHA256(user_id, USER_REF_SECRET)[:8], а не sha256(user_id): по известному user_id
    # без секрета не сопоставить
    key = env.settings.user_ref_secret.get_secret_value().encode()
    assert card["user_ref"] == hmac.new(key, str(user).encode(), hashlib.sha256).hexdigest()[:8]
    assert card["user_ref"] != hashlib.sha256(str(user).encode()).hexdigest()[:8]
    assert len(card["user_ref"]) == 8 and card["user_ref"] not in str(user)
    assert card["content_versions"] == {"scenario": 1, "rubric": 1}
    assert [(h["from"], h["to"], h["reason"]) for h in card["status_history"]] == [
        (None, "ready", "started"), ("ready", "in_progress", "started"), ("in_progress", "completed", "finish")]
    assert card["steps"][0]["type"] == "roleplay" and any(st["hinted"] for st in card["steps"])
    text_turns = [t for t in card["turns_meta"] if t["mode"] == "text"]
    assert text_turns and all(t["ai_call_id"] for t in text_turns) and text_turns[0]["intent"] == "agree"
    assert "secret phrase" not in json.dumps(card, ensure_ascii=False)
    assert card["evaluation_id"] is not None


async def test_transcript_with_reason_and_audit(env: Env, user: uuid.UUID) -> None:
    sid = await _text_session(env, user)
    r = await env.c.post(f"{LIST}/{sid}/transcript", json={"reason": "коротко"}, headers=env.staff("qa.transcripts"))
    assert r.status_code == 422
    r = await env.c.post(f"{LIST}/{sid}/transcript", json={"reason": "          x"},
                         headers=env.staff("qa.transcripts"))
    assert r.status_code == 422
    r = await env.c.post(f"{LIST}/{sid}/transcript", json={"reason": "Разбор обращения TCK-3081"},
                         headers=env.staff("qa.transcripts"))
    assert r.status_code == 200, r.text
    tr = r.json()
    learner_texts = [t["text"] for t in tr["turns"] if t["speaker"] == "learner" and t["mode"] == "text"]
    assert learner_texts == ["Yes, sure, my secret phrase"] and tr["open_answer"] is None
    audit = await env.events("admin.audit.recorded.v1")
    assert len(audit) == 1
    p = audit[0].payload
    assert p["action"] == "qa.transcript_viewed" and p["object_id"] == sid and p["actor_type"] == "staff"
    assert p["reason"] == "Разбор обращения TCK-3081" and "secret" not in json.dumps(p, ensure_ascii=False)
    # повторное открытие — снова в аудите
    await env.c.post(f"{LIST}/{sid}/transcript", json={"reason": "Повторный разбор"},
                     headers=env.staff("qa.transcripts"))
    assert len(await env.events("admin.audit.recorded.v1")) == 2


async def test_transcript_answers_and_redaction(env: Env, user: uuid.UUID) -> None:
    s, _ = await env.complete_lesson(user, open_text="I am Aziz from Tashkent")
    sid = s["session_id"]
    tr = (await env.c.post(f"{LIST}/{sid}/transcript", json={"reason": "Проверка открытого ответа"},
                           headers=env.staff("qa.transcripts"))).json()
    assert tr["open_answer"] == "I am Aziz from Tashkent"
    assert len(tr["answers"]) >= 6 and all(isinstance(a["answer"], str) for a in tr["answers"])
    env.now += timedelta(days=91)
    out = await env.tick()
    assert out["redacted_answers"] == 1 and out["redacted_evaluations"] == 1
    tr = (await env.c.post(f"{LIST}/{sid}/transcript", json={"reason": "Проверка после срока"},
                           headers=env.staff("qa.transcripts"))).json()
    assert tr["open_answer"] is None
    # оценка в итогах — без цитат ученика
    summary = (await env.c.get(f"/internal/v1/sessions/{sid}/summary", headers=env.h(user))).json()
    assert all(i["your_answer"] is None for i in summary["evaluation"]["items"])
    assert (await env.tick())["redacted_evaluations"] == 0


async def test_redacted_turns(env: Env, user: uuid.UUID) -> None:
    sid = await _text_session(env, user)
    env.now += timedelta(days=89)
    assert (await env.tick())["redacted_turns"] == 0
    env.now += timedelta(days=2)
    out = await env.tick()
    assert out["redacted_turns"] == 2  # реплика ученика и ответ ИИ
    tr = (await env.c.post(f"{LIST}/{sid}/transcript", json={"reason": "Проверка после срока"},
                           headers=env.staff("qa.transcripts"))).json()
    redacted = [t for t in tr["turns"] if t["redacted"]]
    assert len(redacted) == 2 and all(t["text"] is None for t in redacted)
    assert all(t["text"] for t in tr["turns"] if not t["redacted"])
    card = (await env.c.get(f"{LIST}/{sid}", headers=env.staff("qa.read"))).json()
    assert sum(t["redacted"] for t in card["turns_meta"]) == 2
    # реплики неизменяемы, кроме стирания текста
    try:
        await env.sql("UPDATE turns SET text = 'x' WHERE session_id = :s", s=uuid.UUID(sid))
        raise AssertionError("turns must be immutable")
    except Exception as exc:
        assert "immutable" in str(exc)
    assert (await env.tick())["redacted_turns"] == 0


async def test_human_review_flag_from_assessment(env: Env, user: uuid.UUID) -> None:
    env.assessment.human_review = True
    s, _ = await env.complete_lesson(user)
    rows = (await env.c.get(LIST, params={"flag": "human_review"}, headers=env.staff("qa.read"))).json()["items"]
    assert [r["session_id"] for r in rows] == [s["session_id"]] and "human_review" in rows[0]["flags"]
    env.assessment.human_review = False
    s2, _ = await env.complete_lesson(uuid.uuid4())
    rows = (await env.c.get(LIST, params={"flag": "human_review"}, headers=env.staff("qa.read"))).json()["items"]
    assert [r["session_id"] for r in rows] == [s["session_id"]] and s2["session_id"] != s["session_id"]


STATS = "/admin/v1/lesson-sessions/stats"


async def test_stats_permissions_and_empty(env: Env, user: uuid.UUID) -> None:
    r = await env.c.get(STATS)
    assert r.status_code == 401
    r = await env.c.get(STATS, headers=env.h(user))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    r = await env.c.get(STATS, headers=env.staff("dashboard.read", actor=False))
    assert r.status_code == 403 and r.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    r = await env.c.get(STATS, headers=env.staff("content.read", "qa.transcripts"))
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    r = await env.c.get(STATS, params={"period": "year"}, headers=env.staff("qa.read"))
    assert r.status_code == 422
    for perm in ("dashboard.read", "qa.read"):
        r = await env.c.get(STATS, headers=env.staff(perm))
        assert r.status_code == 200, r.text
        assert r.json() == {"period": "today", "started": 0, "completed": 0, "completion_pct": None,
                            "median_minutes": None, "by_kind": {"lesson": 0, "scenario": 0, "media": 0, "review": 0,
                                                                     "reading": 0, "duel": 0},
                            "ai_degraded_pct": None}


async def test_stats_calculations(env: Env) -> None:
    # 8 дней назад: урок начат и завершён (входит только в month)
    env.now = T0 - timedelta(days=8)
    _, old = await env.complete_lesson(uuid.uuid4())
    # вчера 18:30 UTC = 23:30 по Ташкенту: начат и отменён (входит в week и month, но не в day)
    env.now = datetime(2026, 11, 18, 18, 30, tzinfo=UTC)
    late = uuid.uuid4()
    s = await env.lesson(late)
    await env.current(late, s["session_id"])
    await env.post(late, s["session_id"], "cancel")
    # сегодня
    env.now = T0
    a = uuid.uuid4()  # сценарий в упрощённом режиме (ИИ недоступен) — завершён
    env.ai.mode["conversation_partner"] = "unavailable"
    sa = await env.start(a, "scenarios/sc-meet-phone-number")
    step = await env.current(a, sa["session_id"])
    env.now += timedelta(seconds=30)
    step = (await env.answer(a, sa["session_id"], step, {"text": "Yes, sure!"}))["next"]
    while step["type"] == "roleplay":
        env.now += timedelta(minutes=1)
        step = (await env.answer(a, sa["session_id"], step,
                                 {"choice_id": env.choice_to(step, "success", "sc-meet-phone-number")}))["next"]
    await env.answer(a, sa["session_id"], step, {})
    done = await env.finish(a, sa["session_id"])
    b = uuid.uuid4()  # урок начат (in_progress)
    sb = await env.lesson(b)
    await env.current(b, sb["session_id"])
    c = uuid.uuid4()  # медиа начато и отменено
    sc = await env.start(c, "media/m-own-coffee-order")
    await env.current(c, sc["session_id"])
    await env.post(c, sc["session_id"], "cancel")
    await env.lesson(uuid.uuid4())  # ready — не начато, не считается

    day = (await env.c.get(STATS, params={"period": "today"}, headers=env.staff("dashboard.read"))).json()
    assert day == {"period": "today", "started": 3, "completed": 1, "completion_pct": 33.3,
                   "median_minutes": float(done["minutes"]),
                   "by_kind": {"lesson": 1, "scenario": 1, "media": 1, "review": 0, "reading": 0, "duel": 0},
                   "ai_degraded_pct": 33.3}
    week = (await env.c.get(STATS, params={"period": "7d"}, headers=env.staff("qa.read"))).json()
    assert week["started"] == 4 and week["completed"] == 1 and week["completion_pct"] == 25.0
    assert week["by_kind"]["lesson"] == 2 and week["ai_degraded_pct"] == 25.0
    month = (await env.c.get(STATS, params={"period": "30d"}, headers=env.staff("qa.read"))).json()
    assert month["started"] == 5 and month["completed"] == 2 and month["completion_pct"] == 40.0
    assert month["median_minutes"] == (done["minutes"] + old["minutes"]) / 2 and month["by_kind"]["lesson"] == 3
    assert month["ai_degraded_pct"] == 20.0
