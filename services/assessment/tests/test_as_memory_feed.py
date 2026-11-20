"""`GET /internal/v1/evaluations/{id}/memory-feed` (спринт 5, INTERNAL_API §5, §1.2): вызывающий — только memory
(иначе 403), ученик — sub токена (чужая и несуществующая — 404); только ошибки текста ученика (T{n}, OA1), закрытые
задания не входят; evidence — null после срока хранения; актуальная запись цепочки (superseded_by); content_refs —
ключи и версии контента по видам."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from as_testkit import always, evaluator_output, lesson_request, media_request, reading_request, text_turns

from tilhero_common.testing import internal_headers

LEARNER_LINES = ("Sure, i can helps you with report.", "My number is five five five, zero one three nine.")
OPEN = "I wants to call my friend and ask her number."
ERRORS = [
    {"turn_id": "T2", "evidence": "i can helps you", "correction": "I can help you", "error_code": "verb_form",
     "severity": "high"},
    {"turn_id": "OA1", "evidence": "I wants", "correction": "I want", "error_code": "verb_form", "severity": "medium"},
]


def feed_path(evaluation_id: str) -> str:
    return f"/internal/v1/evaluations/{evaluation_id}/memory-feed"


def memory(env, user: uuid.UUID | str | None) -> dict[str, str]:
    return internal_headers(env.settings, issuer="memory", subject=str(user) if user else None)


async def feed(env, user: uuid.UUID, evaluation_id: str, expect: int = 200) -> dict[str, Any]:
    r = await env.c.get(feed_path(evaluation_id), headers=memory(env, user))
    assert r.status_code == expect, r.text
    return r.json()


async def text_lesson(env, user: uuid.UUID, *, wrong_closed: bool = True, audience: str = "adults") -> dict[str, Any]:
    """Урок с текстом ученика (реплики и открытый ответ) и ошибками оценщика + неверные закрытые задания."""
    env.ai.output = evaluator_output(scores={"vocabulary": 2, "grammar": 1}, confirmed_errors=ERRORS)
    body = lesson_request("l-03-phone-number", turns=text_turns(*LEARNER_LINES), outcome="success",
                          open_answer=OPEN, audience=audience,
                          policy=always("wrong") if wrong_closed else always("correct"))
    return await env.evaluate(user, body)


async def test_auth_and_callers(env, user) -> None:
    created = await text_lesson(env, user)
    path = feed_path(created["evaluation_id"])
    r = await env.c.get(path)
    assert r.status_code == 401
    for issuer in ("lessons", "telegram-bff", "admin-bff", "diagnostics"):
        r = await env.c.get(path, headers=internal_headers(env.settings, issuer=issuer, subject=str(user)))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    r = await env.c.get(path, headers=env.staff("qa.read"))
    assert r.status_code == 403
    r = await env.c.get(path, headers=memory(env, None))
    assert r.status_code == 401 and r.json()["code"] == "USER_CONTEXT_REQUIRED"
    # чужая и несуществующая — 404 (существование не раскрывается)
    await feed(env, uuid.uuid4(), created["evaluation_id"], expect=404)
    out = await feed(env, user, str(uuid.uuid4()), expect=404)
    assert out["code"] == "EVALUATION_NOT_FOUND"
    r = await env.c.get(feed_path("not-a-uuid"), headers=memory(env, user))
    assert r.status_code == 422


async def test_only_learner_text_errors_and_content_refs(env, user) -> None:
    created = await text_lesson(env, user)
    # в оценке есть и ошибки закрытых заданий (turn_id = id задания) — в ленту memory они не попадают
    card = (await env.c.get(f"/admin/v1/evaluations/{created['evaluation_id']}", headers=env.staff("qa.read"))).json()
    closed = [e for e in card["confirmed_errors"] if not e["turn_id"].startswith(("T", "OA"))]
    assert closed, card["confirmed_errors"]
    out = await feed(env, user, created["evaluation_id"])
    assert out == {
        "evaluation_id": created["evaluation_id"], "session_id": created["session_id"], "user_id": str(user),
        "pair_id": "ru-en", "kind": "lesson",
        "content_refs": {"lesson": {"key": "l-03-phone-number", "version": 1},
                         "scenario": {"key": "sc-meet-phone-number", "version": 1},
                         "media_asset": None, "media_exercises": [], "reading": None,
                         "rubric": {"key": "r-lesson-core", "version": 1}},
        "practice_only": False, "superseded_by": None,
        "errors": [
            {"turn_id": "T2", "evidence": "i can helps you", "correction": "I can help you",
             "error_code": "verb_form", "severity": "high"},
            {"turn_id": "OA1", "evidence": "I wants", "correction": "I want", "error_code": "verb_form",
             "severity": "medium"}],
    }
    # текст реплик целиком в ленту не попадает — только цитаты ≤ 120
    assert LEARNER_LINES[0] not in str(out) and OPEN not in str(out)


async def test_evidence_erased_after_retention(env, user) -> None:
    created = await text_lesson(env, user)
    env.now += timedelta(days=89)
    assert [e["evidence"] for e in (await feed(env, user, created["evaluation_id"]))["errors"]] == [
        "i can helps you", "I wants"]
    # переоценка через 3 дня копирует цитату — срок считается от сессии, а не от переоценки
    env.now += timedelta(days=2)
    body = {"scores": {"grammar": 2}, "skill_outcomes": [
                {"skill_id": o["skill_id"], "outcome": "not_assessed" if o["outcome"] == "not_assessed" else "learning"}
                for o in created["skill_outcomes"]],
            "confirmed_errors": ERRORS[:1], "reason": "Ошибка в открытом ответе не подтвердилась", "appeal_id": None}
    r = await env.c.post(f"/admin/v1/evaluations/{created['evaluation_id']}/reevaluate", json=body,
                         headers=env.staff("qa.review"))
    assert r.status_code == 201, r.text
    out = await feed(env, user, r.json()["evaluation_id"])
    assert out["errors"] == [{"turn_id": "T2", "evidence": None, "correction": "I can help you",
                              "error_code": "verb_form", "severity": "high"}]
    # сама оценка в assessment не меняется (неизменяема)
    card = (await env.c.get(f"/admin/v1/evaluations/{created['evaluation_id']}", headers=env.staff("qa.read"))).json()
    assert any(e["evidence"] == "i can helps you" for e in card["confirmed_errors"])


async def test_reevaluation_gives_actual_record(env, user) -> None:
    created = await text_lesson(env, user, wrong_closed=False)
    eid = created["evaluation_id"]
    body = {"scores": {"grammar": 2}, "skill_outcomes": [{"skill_id": o["skill_id"], "outcome": o["outcome"]}
                                                         for o in created["skill_outcomes"]],
            "confirmed_errors": [ERRORS[0], {"turn_id": "T4", "evidence": "five five five",
                                             "correction": "five-five-five", "error_code": "spelling",
                                             "severity": "low"}],
            "reason": "Апелляция: ошибка в открытом ответе снята", "appeal_id": None}
    r = await env.c.post(f"/admin/v1/evaluations/{eid}/reevaluate", json=body, headers=env.staff("qa.review"))
    assert r.status_code == 201, r.text
    new_id = r.json()["evaluation_id"]
    old = await feed(env, user, eid)
    assert old["evaluation_id"] == new_id and old["superseded_by"] == new_id
    assert [e["turn_id"] for e in old["errors"]] == ["T2", "T4"]
    actual = await feed(env, user, new_id)
    assert actual["superseded_by"] is None and actual["errors"] == old["errors"]
    assert actual["session_id"] == created["session_id"] and actual["content_refs"] == old["content_refs"]
    # переоценённая запись чужому — тоже 404
    await feed(env, uuid.uuid4(), new_id, expect=404)


async def test_closed_only_kinds_kids_and_deleted(env, user) -> None:
    # медиа: только закрытые упражнения — ошибок текста нет; версии медиа и упражнений — для фраз в словарь
    media = await env.evaluate(user, media_request("m-own-coffee-order", policy=always("wrong")))
    out = await feed(env, user, media["evaluation_id"])
    assert out["kind"] == "media" and out["errors"] == []
    refs = out["content_refs"]
    assert refs["media_asset"] == {"key": "m-own-coffee-order", "version": 1} and refs["lesson"] is None
    assert [x["key"] for x in refs["media_exercises"]] == ["mx-coffee-order-1", "mx-coffee-order-2",
                                                            "mx-coffee-order-3"]
    # чтение: practice_only, ключ и версия текста
    reading = await env.evaluate(user, reading_request(policy=always("wrong")))
    out = await feed(env, user, reading["evaluation_id"])
    assert out["kind"] == "reading" and out["practice_only"] is True and out["errors"] == []
    assert out["content_refs"]["reading"] == {"key": "r-a1-coffee-shop", "version": 1}
    assert out["content_refs"]["rubric"] is None
    # ребёнок: свободного текста нет — ошибок для карточек нет (неверные закрытые задания не в счёт)
    kid = uuid.uuid4()
    kid_eval = await env.evaluate(kid, lesson_request("l-01-greetings", audience="kids", policy=always("wrong")))
    assert (await feed(env, kid, kid_eval["evaluation_id"]))["errors"] == []
    # удалённый ученик — 410
    await env.sql("INSERT INTO deleted_users (user_id, request_id) VALUES (:u, :r)", u=kid, r=uuid.uuid4())
    out = await feed(env, kid, kid_eval["evaluation_id"], expect=410)
    assert out["code"] == "USER_DELETED"
