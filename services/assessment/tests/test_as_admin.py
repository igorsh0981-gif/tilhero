"""Админка (admin-bff, actor): права 401/403 по всем маршрутам; карточка и цепочка оценки (без текстов ответов
ученика); QA-флаг без изменения оценки; переоценка — новая запись supersedes, исходная неизменна, повторная
переоценка заменённой → 409; апелляции take/decide (upheld, corrected с переоценкой по апелляции); события и аудит
без текстов ученика; сводка по сессиям; статистика обзора."""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from typing import Any

import pytest
from as_testkit import always, lesson_request, text_turns

from tilhero_common.testing import internal_headers

READ, REVIEW = "qa.read", "qa.review"
STAFF = str(uuid.uuid4())


def reeval_body(created: dict[str, Any], **kw: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "scores": {"task": 2},
        "skill_outcomes": [{"skill_id": o["skill_id"], "outcome": "learning"} for o in created["skill_outcomes"]],
        "confirmed_errors": [], "reason": "Задача выполнена не полностью", "appeal_id": None}
    body.update(kw)
    return body


async def make(env, user: uuid.UUID, **kw: Any) -> dict[str, Any]:
    return await env.evaluate(user, lesson_request("l-01-greetings", **kw))


async def audits(env, action: str) -> list[dict[str, Any]]:
    return [e.payload for e in await env.events("admin.audit.recorded.v1") if e.payload["action"] == action]


async def test_authz_on_all_routes(env, user) -> None:
    created = await make(env, user)
    eid, sid = created["evaluation_id"], created["session_id"]
    appeal = await env.appeal(user, eid)
    aid = appeal["appeal_id"]
    routes = [
        ("GET", f"/admin/v1/evaluations/{eid}", None, READ),
        ("GET", f"/admin/v1/evaluations?session_id={sid}", None, READ),
        ("GET", f"/admin/v1/evaluations/summary?session_id={sid}", None, READ),
        ("POST", f"/admin/v1/evaluations/{eid}/flag", {"reason": "спорно"}, READ),
        ("POST", f"/admin/v1/evaluations/{eid}/reevaluate", reeval_body(created), REVIEW),
        ("GET", "/admin/v1/appeals", None, READ),
        ("GET", f"/admin/v1/appeals/{aid}", None, READ),
        ("POST", f"/admin/v1/appeals/{aid}/take", None, REVIEW),
        ("POST", f"/admin/v1/appeals/{aid}/decide", {"decision": "upheld", "note": "Оценка верна, ответ неточный"},
         REVIEW),
        ("GET", "/admin/v1/assessment/stats", None, READ),
    ]
    for method, path, body, perm in routes:
        r = await env.c.request(method, path, json=body)
        assert r.status_code == 401, path
        r = await env.c.request(method, path, json=body, headers=internal_headers(
            env.settings, issuer="telegram-bff", subject=str(user)))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", path
        r = await env.c.request(method, path, json=body, headers=env.staff(actor=False))
        assert r.status_code == 403 and r.json()["code"] == "STAFF_CONTEXT_REQUIRED", path
        other = "qa.transcripts" if perm == READ else READ
        r = await env.c.request(method, path, json=body, headers=env.staff(other))
        assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED", path
        r = await env.c.request(method, path, json=body, headers=env.staff(perm, staff_id=STAFF))
        assert r.status_code in (200, 201), (path, r.text)
    # статистика — и по dashboard.read
    r = await env.c.get("/admin/v1/assessment/stats", headers=env.staff("dashboard.read"))
    assert r.status_code == 200


async def test_card_and_chain_without_learner_texts(env, user) -> None:
    body = lesson_request("l-03-phone-number", turns=text_turns("I can helps you."),
                          policy=lambda i: "wrong" if i["item_id"] == "l-03-c2" else "correct")
    from as_testkit import evaluator_output
    env.ai.output = evaluator_output(scores={"vocabulary": 2, "grammar": 1}, confirmed_errors=[
        {"turn_id": "T2", "evidence": "can helps", "correction": "can help", "error_code": "verb_form",
         "severity": "high"}])
    created = await env.evaluate(user, body)
    r = await env.c.get(f"/admin/v1/evaluations/{created['evaluation_id']}", headers=env.staff(READ))
    assert r.status_code == 200
    card = r.json()
    assert card["rubric"] == {"rubric_id": "r-lesson-core", "version": 1}
    assert card["scores"] == [{"code": "task", "score": 3}, {"code": "vocabulary", "score": 2},
                              {"code": "grammar", "score": 1}, {"code": "independence", "score": 3}]
    assert card["evaluator"] == {"agent_id": "independent_evaluator", "agent_version": 3,
                                 "prompt_version": "independent_evaluator@3", "model_id": "fake",
                                 "schema_version": "independent_evaluator.v1", "canary": False}
    assert card["items"][0] == {"item_id": "l-03-c1", "skill_id": "en.func.numbers-phone", "correct": True,
                                "hinted": False}
    assert card["confirmed_errors"][0]["evidence"] == "can helps"  # доказательство-цитата ≤ 120
    assert card["created_by"] is None and card["supersedes"] is None and card["superseded_by"] is None
    assert card["flags"] == [] and card["appeal"] is None and card["ai_status"] == "ok"
    assert card["weighted"] is not None and card["outcome"] == "success"
    text = json.dumps(card, ensure_ascii=False)
    assert "your_answer" not in text and "I can helps you." not in text  # ни ответов, ни реплик целиком
    chain = (await env.c.get("/admin/v1/evaluations", params={"session_id": created["session_id"]},
                             headers=env.staff(READ))).json()
    assert [c["evaluation_id"] for c in chain["items"]] == [created["evaluation_id"]]
    empty = (await env.c.get("/admin/v1/evaluations", params={"session_id": str(uuid.uuid4())},
                             headers=env.staff(READ))).json()
    assert empty == {"items": [], "next_cursor": None}
    r = await env.c.get(f"/admin/v1/evaluations/{uuid.uuid4()}", headers=env.staff(READ))
    assert r.status_code == 404 and r.json()["code"] == "EVALUATION_NOT_FOUND"
    r = await env.c.post(f"/admin/v1/evaluations/{uuid.uuid4()}/flag", json={"reason": "проверить"},
                         headers=env.staff(READ))
    assert r.status_code == 404 and r.json()["code"] == "EVALUATION_NOT_FOUND"
    r = await env.c.get("/admin/v1/evaluations", headers=env.staff(READ))
    assert r.status_code == 422


async def test_flag_does_not_change_evaluation(env, user) -> None:
    created = await make(env, user)
    eid = created["evaluation_id"]
    before = await env.sql("SELECT scores, passed, status FROM evaluations WHERE evaluation_id = :e",
                           e=uuid.UUID(eid))
    h = {**env.staff(READ, staff_id=STAFF), "Idempotency-Key": "flag-key-0001"}
    r = await env.c.post(f"/admin/v1/evaluations/{eid}/flag", json={"reason": "Спорный балл task"}, headers=h)
    assert r.status_code == 201
    card = r.json()
    assert [(f["reason"], f["by"]) for f in card["flags"]] == [("Спорный балл task", STAFF)]
    r = await env.c.post(f"/admin/v1/evaluations/{eid}/flag", json={"reason": "Спорный балл task"}, headers=h)
    assert len(r.json()["flags"]) == 1  # повтор с ключом — без второго флага
    r = await env.c.post(f"/admin/v1/evaluations/{eid}/flag", json={"reason": "другое"}, headers=h)
    assert r.status_code == 422 and r.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    r = await env.c.post(f"/admin/v1/evaluations/{eid}/flag", json={"reason": "x"}, headers=env.staff(READ))
    assert r.status_code == 422
    after = await env.sql("SELECT scores, passed, status FROM evaluations WHERE evaluation_id = :e", e=uuid.UUID(eid))
    assert before == after
    [audit] = await audits(env, "qa.flagged")
    assert audit["object_id"] == eid and audit["reason"] == "Спорный балл task" and audit["actor_id"] == STAFF
    assert await env.events("assessment.reevaluated.v1") == []


async def test_reevaluation_chain(env, user) -> None:
    created = await make(env, user)
    eid = created["evaluation_id"]
    [(original_row,)] = await env.sql("SELECT row_to_json(e)::text FROM evaluations e WHERE evaluation_id = :e",
                                      e=uuid.UUID(eid))
    h = {**env.staff(READ, REVIEW, staff_id=STAFF), "Idempotency-Key": "reeval-key-0001"}
    body = reeval_body(created, confirmed_errors=[
        {"turn_id": "l-01-c2", "evidence": "am", "correction": "am", "error_code": "gap_fill", "severity": "low"}])
    r = await env.c.post(f"/admin/v1/evaluations/{eid}/reevaluate", json=body, headers=h)
    assert r.status_code == 201, r.text
    new = r.json()
    assert new["supersedes"] == eid and new["created_by"] == STAFF and new["reason"] == body["reason"]
    assert {s["code"]: s["score"] for s in new["scores"]} == {"task": 2, "vocabulary": None, "independence": 3}
    assert new["evaluator"] is None and new["status"] == "ok" and new["requires_human_review"] is False
    assert new["passed"] is True and new["items"] == (await env.c.get(
        f"/admin/v1/evaluations/{eid}", headers=env.staff(READ))).json()["items"]
    # повтор с тем же ключом — та же переоценка
    r = await env.c.post(f"/admin/v1/evaluations/{eid}/reevaluate", json=body, headers=h)
    assert r.status_code == 200 and r.json()["evaluation_id"] == new["evaluation_id"]
    # исходная запись неизменна; цепочка из двух; заменённую переоценить нельзя
    [(original_after,)] = await env.sql("SELECT row_to_json(e)::text FROM evaluations e WHERE evaluation_id = :e",
                                        e=uuid.UUID(eid))
    assert original_after == original_row
    chain = (await env.c.get("/admin/v1/evaluations", params={"session_id": created["session_id"]},
                             headers=env.staff(READ))).json()["items"]
    assert [c["evaluation_id"] for c in chain] == [eid, new["evaluation_id"]]
    assert chain[0]["superseded_by"] == new["evaluation_id"]
    r = await env.c.post(f"/admin/v1/evaluations/{eid}/reevaluate", json=reeval_body(created),
                         headers=env.staff(REVIEW))
    assert r.status_code == 409 and r.json()["code"] == "EVALUATION_SUPERSEDED"
    assert r.json()["details"] == {"superseded_by": new["evaluation_id"]}
    # переоценка актуальной — третья запись
    r = await env.c.post(f"/admin/v1/evaluations/{new['evaluation_id']}/reevaluate", headers=env.staff(REVIEW),
                         json=reeval_body(created, scores={"task": 3},
                                          skill_outcomes=created["skill_outcomes"], reason="Вернули исходный балл"))
    assert r.status_code == 201
    events = await env.events("assessment.reevaluated.v1", user)
    assert [e.payload["supersedes"] for e in events] == [eid, new["evaluation_id"]]
    # сессия — та же, что у заменённой оценки (обе переоценки цепочки)
    assert [e.payload["session_id"] for e in events] == [created["session_id"]] * 2
    assert events[0].payload["skill_outcomes"] == [{"skill_id": o["skill_id"], "outcome": "learning"}
                                                   for o in created["skill_outcomes"]]
    assert events[1].payload["skill_outcomes"] == created["skill_outcomes"] and events[1].payload["appeal_id"] is None
    reevaluated = await audits(env, "qa.reevaluated")
    assert len(reevaluated) == 2 and reevaluated[0]["reason"] == body["reason"]
    assert reevaluated[0]["before"]["scores"]["task"] == 3 and reevaluated[0]["after"]["scores"]["task"] == 2
    assert len(await env.events("assessment.completed.v1", user)) == 1


async def test_reevaluation_validation(env, user) -> None:
    created = await make(env, user)
    eid = created["evaluation_id"]

    async def post(body: dict, staff_id: str | None = None) -> Any:
        return await env.c.post(f"/admin/v1/evaluations/{eid}/reevaluate", json=body,
                                headers=env.staff(REVIEW, staff_id=staff_id))

    cases = [
        (reeval_body(created, reason="коротко"), "VALIDATION_ERROR"),
        (reeval_body(created, scores={"task": 4}), "VALIDATION_ERROR"),
        (reeval_body(created, scores={"grammar": 2}), "SCORES_INVALID"),  # нет в рубрике r-kids
        (reeval_body(created, scores={"pronunciation": 2}), "SCORES_INVALID"),
        (reeval_body(created, skill_outcomes=[]), "SKILL_OUTCOMES_INVALID"),
        (reeval_body(created, skill_outcomes=[*created["skill_outcomes"],
                                              {"skill_id": "en.voc.family", "outcome": "learning"}]),
         "SKILL_OUTCOMES_INVALID"),
        (reeval_body(created, scores={"task": 0, "independence": 0}, skill_outcomes=created["skill_outcomes"]),
         "SKILL_OUTCOMES_INVALID"),  # demonstrated без зачёта рубрики
        (reeval_body(created, confirmed_errors=[{"turn_id": "T42", "evidence": "x", "correction": "y",
                                                 "error_code": "article", "severity": "low"}]), "ERRORS_INVALID"),
        (reeval_body(created, appeal_id=str(uuid.uuid4())), "APPEAL_MISMATCH"),
        ({**reeval_body(created), "evaluator": {"model_id": "x"}}, "VALIDATION_ERROR"),
    ]
    for body, code in cases:
        r = await post(body)
        assert r.status_code == 422 and r.json()["code"] == code, (code, r.text)
    r = await post(reeval_body(created), staff_id=str(user))
    assert r.status_code == 409 and r.json()["code"] == "SELF_REEVALUATION"
    r = await env.c.post(f"/admin/v1/evaluations/{uuid.uuid4()}/reevaluate", json=reeval_body(created),
                         headers=env.staff(REVIEW))
    assert r.status_code == 404
    # вердикт по оценённым критериям: один оценённый → insufficient_evidence
    r = await post(reeval_body(created, scores={"task": None, "independence": 3}))
    assert r.status_code == 201 and r.json()["status"] == "insufficient_evidence" and r.json()["passed"] is None


async def test_practice_only_reevaluation_has_no_outcomes(env, user) -> None:
    created = await make(env, user, practice_only=True)
    r = await env.c.post(f"/admin/v1/evaluations/{created['evaluation_id']}/reevaluate", headers=env.staff(REVIEW),
                         json=reeval_body(created, skill_outcomes=[{"skill_id": "en.func.greet",
                                                                    "outcome": "learning"}]))
    assert r.status_code == 422 and r.json()["code"] == "SKILL_OUTCOMES_INVALID"
    r = await env.c.post(f"/admin/v1/evaluations/{created['evaluation_id']}/reevaluate", headers=env.staff(REVIEW),
                         json=reeval_body(created))
    assert r.status_code == 201 and r.json()["practice_only"] is True and r.json()["skill_outcomes"] == []


async def test_appeal_upheld(env, user) -> None:
    created = await make(env, user)
    appeal = await env.appeal(user, created["evaluation_id"], reason="Мой ответ правильный")
    aid = appeal["appeal_id"]
    lst = (await env.c.get("/admin/v1/appeals", params={"status": "new"}, headers=env.staff(READ))).json()
    assert [a["appeal_id"] for a in lst["items"]] == [aid]
    assert lst["items"][0]["reason"] == "Мой ответ правильный" and lst["items"][0]["session_id"] == created[
        "session_id"]
    h = env.staff(REVIEW, staff_id=STAFF)
    r = await env.c.post(f"/admin/v1/appeals/{aid}/take", headers=h)
    assert r.status_code == 200 and r.json()["status"] == "in_review" and r.json()["taken_by"] == STAFF
    assert (await env.c.post(f"/admin/v1/appeals/{aid}/take", headers=h)).status_code == 200
    r = await env.c.post(f"/admin/v1/appeals/{aid}/take", headers=env.staff(REVIEW))
    assert r.status_code == 409 and r.json()["code"] == "APPEAL_ALREADY_TAKEN"
    r = await env.c.post(f"/admin/v1/appeals/{aid}/decide", headers=h, json={
        "decision": "upheld", "note": "Ответ неверен", "new_evaluation_id": str(uuid.uuid4())})
    assert r.status_code == 422 and r.json()["code"] == "NEW_EVALUATION_NOT_ALLOWED"
    r = await env.c.post(f"/admin/v1/appeals/{aid}/decide", headers=h, json={"decision": "upheld", "note": "коротко"})
    assert r.status_code == 422
    env.now += timedelta(hours=1)
    decision = {"decision": "upheld", "note": "Оценка верна: в задании нужен глагол am"}
    r = await env.c.post(f"/admin/v1/appeals/{aid}/decide", headers=h, json=decision)
    assert r.status_code == 200, r.text
    decided = r.json()
    assert decided["status"] == "upheld" and decided["decided_by"] == STAFF
    assert decided["decision_note"] == decision["note"] and decided["new_evaluation_id"] is None
    assert (await env.c.post(f"/admin/v1/appeals/{aid}/decide", headers=h, json=decision)).json() == decided
    r = await env.c.post(f"/admin/v1/appeals/{aid}/decide", headers=h,
                         json={"decision": "upheld", "note": "Другая формулировка решения"})
    assert r.status_code == 409 and r.json()["code"] == "APPEAL_DECIDED"
    r = await env.c.post(f"/admin/v1/appeals/{aid}/take", headers=h)
    assert r.status_code == 409 and r.json()["code"] == "APPEAL_DECIDED"
    [ev] = await env.events("assessment.appeal.decided.v1", user)
    assert ev.payload == {"appeal_id": aid, "evaluation_id": created["evaluation_id"], "user_id": str(user),
                          "decision": "upheld", "decided_at": ev.payload["decided_at"]}
    [taken] = await audits(env, "qa.appeal_taken")
    assert taken["object_id"] == aid and taken["after"]["status"] == "in_review"
    [audit] = await audits(env, "qa.appeal_decided")
    assert audit["reason"] == decision["note"] and audit["object_id"] == aid
    all_audit = json.dumps([e.payload for e in await env.events("admin.audit.recorded.v1")], ensure_ascii=False)
    assert "Мой ответ правильный" not in all_audit  # причина ученика — не в аудит
    v = await env.view(user, created["evaluation_id"])
    assert v["appeal"]["status"] == "upheld" and v["appeal"]["decision_note"] == decision["note"]
    assert v["evaluation_id"] == created["evaluation_id"]


async def test_appeal_corrected_with_reevaluation(env, user) -> None:
    created = await make(env, user, policy=always("correct"), outcome=None, roleplay_hints=3)
    assert created["passed"] is False
    eid = created["evaluation_id"]
    appeal = await env.appeal(user, eid)
    aid = appeal["appeal_id"]
    h = env.staff(READ, REVIEW, staff_id=STAFF)
    r = await env.c.post(f"/admin/v1/appeals/{aid}/decide", headers=h,
                         json={"decision": "corrected", "note": "Исправили балл задачи"})
    assert r.status_code == 422 and r.json()["code"] == "NEW_EVALUATION_REQUIRED"
    # переоценка без ссылки на апелляцию не подходит для corrected
    other = await make(env, user)
    r = await env.c.post(f"/admin/v1/evaluations/{other['evaluation_id']}/reevaluate", headers=h,
                         json=reeval_body(other))
    r = await env.c.post(f"/admin/v1/appeals/{aid}/decide", headers=h, json={
        "decision": "corrected", "note": "Исправили балл задачи", "new_evaluation_id": r.json()["evaluation_id"]})
    assert r.status_code == 422 and r.json()["code"] == "NEW_EVALUATION_INVALID"
    r = await env.c.post(f"/admin/v1/evaluations/{eid}/reevaluate", headers=h, json=reeval_body(
        created, scores={"task": 3}, skill_outcomes=[{"skill_id": o["skill_id"], "outcome": "demonstrated"}
                                                     for o in created["skill_outcomes"]],
        reason="Сценарий завершён верно, исход засчитан", appeal_id=aid))
    assert r.status_code == 201, r.text
    new_id = r.json()["evaluation_id"]
    assert r.json()["appeal_id"] == aid
    r = await env.c.post(f"/admin/v1/appeals/{aid}/decide", headers=h,
                         json={"decision": "upheld", "note": "Оценка верна, без изменений"})
    assert r.status_code == 409 and r.json()["code"] == "APPEAL_HAS_REEVALUATION"
    r = await env.c.post(f"/admin/v1/appeals/{aid}/decide", headers=h, json={
        "decision": "corrected", "note": "Исправили балл задачи", "new_evaluation_id": new_id})
    assert r.status_code == 200 and r.json()["status"] == "corrected" and r.json()["new_evaluation_id"] == new_id
    [reev] = [e for e in await env.events("assessment.reevaluated.v1", user) if e.payload["appeal_id"] == aid]
    assert reev.payload["supersedes"] == eid and reev.payload["passed"] is True
    assert reev.payload["session_id"] == created["session_id"]
    assert {o["outcome"] for o in reev.payload["skill_outcomes"]} == {"demonstrated"}
    [dec] = await env.events("assessment.appeal.decided.v1", user)
    assert dec.payload["decision"] == "corrected" and dec.payload["evaluation_id"] == eid
    v = await env.view(user, eid)
    assert v["evaluation_id"] == new_id and v["superseded_by"] == new_id and v["passed"] is True
    assert v["appeal"]["status"] == "corrected" and v["appeal"]["new_evaluation_id"] == new_id
    # по решённой апелляции переоценивать нельзя; апелляция другой сессии — не подходит
    r = await env.c.post(f"/admin/v1/evaluations/{new_id}/reevaluate", headers=h,
                         json=reeval_body(created, appeal_id=aid))
    assert r.status_code == 409 and r.json()["code"] == "APPEAL_DECIDED"
    r = await env.c.post(f"/admin/v1/evaluations/{other['evaluation_id']}/reevaluate", headers=h,
                         json=reeval_body(other, appeal_id=aid))
    assert r.status_code in (409, 422) and r.json()["code"] in ("EVALUATION_SUPERSEDED", "APPEAL_MISMATCH")
    card = (await env.c.get(f"/admin/v1/evaluations/{new_id}", headers=h)).json()
    assert card["appeal"]["status"] == "corrected" and card["appeal"]["decided_by"] == STAFF


async def test_appeal_survives_qa_reevaluation_in_between(env, user) -> None:
    created = await make(env, user)
    appeal = await env.appeal(user, created["evaluation_id"])
    h = env.staff(READ, REVIEW)
    # QA переоценил, пока апелляция ждала разбора; переоценка по апелляции — уже актуальной записи цепочки
    r = await env.c.post(f"/admin/v1/evaluations/{created['evaluation_id']}/reevaluate", headers=h,
                         json=reeval_body(created))
    qa_id = r.json()["evaluation_id"]
    other = await make(env, uuid.uuid4())
    r = await env.c.post(f"/admin/v1/evaluations/{other['evaluation_id']}/reevaluate", headers=h,
                         json=reeval_body(other, appeal_id=appeal["appeal_id"]))
    assert r.status_code == 422 and r.json()["code"] == "APPEAL_MISMATCH"
    r = await env.c.post(f"/admin/v1/evaluations/{qa_id}/reevaluate", headers=h, json=reeval_body(
        created, scores={"task": 3}, skill_outcomes=created["skill_outcomes"], reason="Апелляция обоснована",
        appeal_id=appeal["appeal_id"]))
    assert r.status_code == 201, r.text
    r = await env.c.post(f"/admin/v1/appeals/{appeal['appeal_id']}/decide", headers=h, json={
        "decision": "corrected", "note": "Оценка исправлена", "new_evaluation_id": r.json()["evaluation_id"]})
    assert r.status_code == 200 and r.json()["status"] == "corrected"


async def test_appeal_admin_lookup_and_queue(env, user) -> None:
    r = await env.c.get(f"/admin/v1/appeals/{uuid.uuid4()}", headers=env.staff(READ))
    assert r.status_code == 404 and r.json()["code"] == "APPEAL_NOT_FOUND"
    for path in (f"/admin/v1/appeals/{uuid.uuid4()}/take", f"/admin/v1/appeals/{uuid.uuid4()}/decide"):
        body = {"decision": "upheld", "note": "Оценка верна полностью"} if path.endswith("decide") else None
        r = await env.c.post(path, json=body, headers=env.staff(REVIEW))
        assert r.status_code == 404, path
    ids = []
    for _ in range(3):
        ev = await make(env, user)
        ids.append((await env.appeal(user, ev["evaluation_id"]))["appeal_id"])
        env.now += timedelta(minutes=1)
    seen, cursor = [], None
    while True:
        page = (await env.c.get("/admin/v1/appeals", params={"limit": 2, **({"cursor": cursor} if cursor else {})},
                                headers=env.staff(READ))).json()
        seen += [a["appeal_id"] for a in page["items"]]
        if not (cursor := page["next_cursor"]):
            break
    assert seen == ids  # очередь — старые первыми
    r = await env.c.get("/admin/v1/appeals", params={"status": "closed"}, headers=env.staff(READ))
    assert r.status_code == 422


async def test_session_summary_and_stats(env, user) -> None:
    a = await make(env, user)
    b = await env.evaluate(user, lesson_request("l-03-phone-number", turns=text_turns("I can help."),
                                                open_answer="text"))  # ИИ ok
    env.ai.mode = "unavailable"
    c = await env.evaluate(user, lesson_request("l-03-phone-number", turns=text_turns("I can help.")))
    assert c["status"] == "partial" and c["requires_human_review"] is True
    await make(env, user, practice_only=True)
    await env.appeal(user, a["evaluation_id"])
    await env.c.post(f"/admin/v1/evaluations/{b['evaluation_id']}/flag", json={"reason": "проверить"},
                     headers=env.staff(READ))
    summary = (await env.c.get("/admin/v1/evaluations/summary",
                               params=[("session_id", s) for s in (a["session_id"], b["session_id"],
                                                                   c["session_id"], str(uuid.uuid4()))],
                               headers=env.staff(READ))).json()["items"]
    assert [(s["session_id"], s["appeal_status"], s["flagged"], s["requires_human_review"]) for s in summary] == [
        (a["session_id"], "new", False, False), (b["session_id"], None, True, False),
        (c["session_id"], None, False, True)]
    stats = (await env.c.get("/admin/v1/assessment/stats", params={"period": "7d"},
                             headers=env.staff("dashboard.read"))).json()
    assert stats == {"period": "7d", "evaluations": 3, "passed": 3, "insufficient_evidence": 0, "partial": 1,
                     "reevaluations": 0, "appeals_new": 1, "appeals_open": 1, "human_review_open": 1}
    # переоценка закрывает ручную проверку
    r = await env.c.post(f"/admin/v1/evaluations/{c['evaluation_id']}/reevaluate", headers=env.staff(REVIEW),
                         json=reeval_body(c, scores={"vocabulary": 2, "grammar": 2},
                                          skill_outcomes=c["skill_outcomes"], reason="Проверили открытую часть"))
    assert r.status_code == 201, r.text
    stats = (await env.c.get("/admin/v1/assessment/stats", headers=env.staff(READ))).json()
    assert stats["human_review_open"] == 0 and stats["reevaluations"] == 1 and stats["period"] == "today"
    r = await env.c.get("/admin/v1/assessment/stats", params={"period": "year"}, headers=env.staff(READ))
    assert r.status_code == 422
    r = await env.c.get("/admin/v1/evaluations/summary", headers=env.staff(READ))
    assert r.status_code == 422


@pytest.mark.parametrize("perm", ["qa.transcripts", "costs.read"])
async def test_review_requires_qa_review(env, user, perm) -> None:
    created = await make(env, user)
    r = await env.c.post(f"/admin/v1/evaluations/{created['evaluation_id']}/reevaluate", json=reeval_body(created),
                         headers=env.staff(READ, perm))
    assert r.status_code == 403 and r.json()["details"] == {"permission": "qa.review"}
