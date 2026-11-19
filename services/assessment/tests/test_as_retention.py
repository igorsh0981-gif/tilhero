"""Ревью R1-14: срок хранения текста апелляции — через 90 дней после решения `reason` → null (tick assessment, n8n
`assessment-tick` по SCHEDULER_TOKEN), сотрудник видит «стёрт по сроку хранения»; нерешённые не стираются; повтор
tick безопасен; оценки (цитаты и исправления) в assessment остаются (PLAN «Хранение реплик»)."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from as_testkit import lesson_request, text_turns
from conftest import SCHEDULER_TOKEN

from tilhero_common.testing import internal_headers

TICK = "/internal/v1/assessment:tick"
REVIEW = ("qa.read", "qa.review")


async def tick(env, expect: int = 200) -> dict[str, Any]:
    r = await env.c.post(TICK, headers={"Authorization": f"Bearer {SCHEDULER_TOKEN}"})
    assert r.status_code == expect, r.text
    return dict(r.json())


async def decided_appeal(env, user: uuid.UUID, reason: str, decision: str = "upheld") -> tuple[str, str]:
    created = await env.evaluate(user, lesson_request("l-03-phone-number", turns=text_turns("I can helps you.")))
    eid = created["evaluation_id"]
    aid = (await env.appeal(user, eid, reason=reason))["appeal_id"]
    staff = env.staff(*REVIEW)
    body: dict[str, Any] = {"decision": "upheld", "note": "Оценка верна, ошибка подтверждена"}
    if decision == "corrected":
        r = await env.c.post(f"/admin/v1/evaluations/{eid}/reevaluate", headers=staff, json={
            "scores": {"task": 3}, "skill_outcomes": created["skill_outcomes"], "confirmed_errors": [],
            "reason": "Переоценка по апелляции", "appeal_id": aid})
        assert r.status_code == 201, r.text
        body = {"decision": "corrected", "note": "Оценка исправлена", "new_evaluation_id": r.json()["evaluation_id"]}
    r = await env.c.post(f"/admin/v1/appeals/{aid}/decide", headers=staff, json=body)
    assert r.status_code == 200, r.text
    return eid, aid


async def admin_appeal(env, aid: str) -> dict[str, Any]:
    r = await env.c.get(f"/admin/v1/appeals/{aid}", headers=env.staff("qa.read"))
    assert r.status_code == 200, r.text
    return dict(r.json())


async def test_tick_requires_scheduler_token(env) -> None:
    r = await env.c.post(TICK)
    assert r.status_code == 401 and r.json()["code"] == "SCHEDULER_TOKEN_INVALID"
    r = await env.c.post(TICK, headers={"Authorization": "Bearer wrong-token-wrong-token-wrong-token"})
    assert r.status_code == 401
    for issuer in ("lessons", "admin-bff", "telegram-bff"):
        r = await env.c.post(TICK, headers=internal_headers(env.settings, issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    assert await tick(env) == {"redacted_appeal_reasons": 0}


async def test_appeal_reason_redacted_90_days_after_decision(env, user) -> None:
    eid, aid = await decided_appeal(env, user, "Я написал верно, проверьте мою фразу")
    other = uuid.uuid4()
    _, corrected = await decided_appeal(env, other, "Персонаж меня не понял", decision="corrected")
    pending_user = uuid.uuid4()
    created = await env.evaluate(pending_user, lesson_request("l-01-greetings"))
    pending = (await env.appeal(pending_user, created["evaluation_id"], reason="Ещё не рассмотрено"))["appeal_id"]
    decided_at = env.now

    env.now = decided_at + timedelta(days=89, hours=23)
    assert await tick(env) == {"redacted_appeal_reasons": 0}
    card = await admin_appeal(env, aid)
    assert card["reason"] == "Я написал верно, проверьте мою фразу" and card["reason_redacted"] is False

    env.now = decided_at + timedelta(days=90, minutes=1)
    assert await tick(env) == {"redacted_appeal_reasons": 2}
    assert await tick(env) == {"redacted_appeal_reasons": 0}  # повтор безопасен
    for appeal_id in (aid, corrected):
        card = await admin_appeal(env, appeal_id)
        assert card["reason"] is None and card["reason_redacted"] is True  # сотрудник видит «стёрт»
        assert card["status"] in ("upheld", "corrected") and card["decision_note"]  # решение — остаётся
    # нерешённая апелляция не стирается, сколько бы ни прошло
    card = await admin_appeal(env, pending)
    assert card["reason"] == "Ещё не рассмотрено" and card["reason_redacted"] is False
    # ученик: своя апелляция — без текста; решение видно
    r = await env.c.get("/internal/v1/appeals", headers=env.learner(user))
    [mine] = r.json()["items"]
    assert mine["appeal_id"] == aid and mine["reason"] is None and mine["decision_note"]
    view = await env.view(user, eid)
    assert view["appeal"]["reason"] is None and view["appeal"]["status"] == "upheld"
    # в списке сотрудника — тоже пометка
    r = await env.c.get("/admin/v1/appeals", params={"status": "upheld"}, headers=env.staff("qa.read"))
    assert {a["appeal_id"]: a["reason_redacted"] for a in r.json()["items"]}[aid] is True
    rows = await env.sql("SELECT count(*) FROM appeals WHERE reason IS NULL AND reason_redacted_at IS NOT NULL")
    assert rows == [(2,)]


async def test_evaluation_texts_stay_in_assessment(env, user) -> None:
    """Цитаты ошибок и исправления в оценке не стираются (PLAN: доказательства-цитаты остаются в assessment)."""
    from as_testkit import evaluator_output

    env.ai.output = evaluator_output(scores={"vocabulary": 2, "grammar": 1}, confirmed_errors=[
        {"turn_id": "T2", "evidence": "I can helps", "correction": "I can help", "error_code": "verb_form",
         "severity": "medium"}])
    eid, _ = await decided_appeal(env, user, "Причина апелляции")
    env.now += timedelta(days=120)
    await tick(env)
    view = await env.view(user, eid)
    assert [(e["evidence"], e["correction"]) for e in view["key_errors"]] == [("I can helps", "I can help")]


async def test_replay_of_appeal_after_redaction(env, user) -> None:
    """Повтор подачи с тем же Idempotency-Key после стирания текста — тот же ответ, не 422."""
    created = await env.evaluate(user, lesson_request("l-01-greetings"))
    reason = "Повтор после стирания"
    first = await env.appeal(user, created["evaluation_id"], reason=reason, key="ap-replay-0001")
    r = await env.c.post(f"/admin/v1/appeals/{first['appeal_id']}/decide", headers=env.staff(*REVIEW),
                         json={"decision": "upheld", "note": "Оценка верна, всё проверено"})
    assert r.status_code == 200
    env.now += timedelta(days=91)
    assert (await tick(env))["redacted_appeal_reasons"] == 1
    r = await env.c.post(f"/internal/v1/evaluations/{created['evaluation_id']}/appeal", json={"reason": reason},
                         headers={**env.learner(user), "Idempotency-Key": "ap-replay-0001"})
    assert r.status_code in (200, 201) and r.json()["appeal_id"] == first["appeal_id"] and r.json()["reason"] is None
