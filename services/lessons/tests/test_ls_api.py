"""API ученика (AT-39): карточка урока, 401/403 вызывающего, IDOR (чужая сессия → 404), 422, пара и аудитория,
история с пагинацией; в ответах ученику нет ключей ответов."""

from __future__ import annotations

import uuid

import pytest
from conftest import Env
from ls_testkit import assert_no_keys

from tilhero_common.internal_auth import HEADER, issue_token


async def test_lesson_card(env: Env, user: uuid.UUID) -> None:
    r = await env.c.get("/internal/v1/lessons/l-01-greetings/card", headers=env.h(user))
    assert r.status_code == 200, r.text
    card = r.json()
    assert_no_keys(card)
    assert card["version"] == 1 and card["available"] is True and card["unavailable_reason"] is None
    assert card["primary_skill"]["skill_id"] == "en.func.greet" and card["primary_skill"]["title"]["ru"]
    assert [x["type"] for x in card["stages_detail"]] == ["retrieval", "explanation", "roleplay", "assessment",
                                                         "summary"]
    assert sum(x["minutes"] for x in card["stages"]) == card["duration_min"] == 20
    assert card["key_words_count"] == 10 and card["roleplay_mode"] == "full" and card["active_session_id"] is None
    s = await env.lesson(user)
    card = (await env.c.get("/internal/v1/lessons/l-01-greetings/card", headers=env.h(user))).json()
    assert card["active_session_id"] == s["session_id"]
    # ИИ выключен (аварийная остановка) — карточка не обещает свободный ответ
    env.ai.available = False
    card = (await env.c.get("/internal/v1/lessons/l-01-greetings/card", headers=env.h(user))).json()
    assert card["roleplay_mode"] == "choices"
    env.ai.available = True
    # ребёнку — выбор реплик; взрослый урок — недоступен по аудитории
    kid = uuid.uuid4()
    env.child(kid)
    card = (await env.c.get("/internal/v1/lessons/l-01-greetings/card", headers=env.h(kid))).json()
    assert card["roleplay_mode"] == "choices"
    card = (await env.c.get("/internal/v1/lessons/l-03-phone-number/card", headers=env.h(kid))).json()
    assert card["available"] is False and card["unavailable_reason"] == "audience"
    r = await env.c.get("/internal/v1/lessons/l-404/card", headers=env.h(user))
    assert r.status_code == 404 and r.json()["code"] == "LESSON_NOT_AVAILABLE"
    # снимок курса с номерами версий тоже поддерживается
    env.catalog.snapshot_versions = True
    card = (await env.c.get("/internal/v1/lessons/l-02-where-from/card", headers=env.h(user))).json()
    assert card["version"] == 1


async def test_start_rules(env: Env, user: uuid.UUID) -> None:
    env.catalog.unpublish("lesson", "l-05-jobs")
    r = await env.c.post("/internal/v1/lessons/l-05-jobs/sessions",
                         headers={**env.h(user), "Idempotency-Key": "k-unpub-01"})
    assert r.status_code == 404 and r.json()["code"] == "LESSON_NOT_AVAILABLE"
    r = await env.c.post("/internal/v1/lessons/l-01-greetings/sessions", params={"pair_id": "ru-uz"},
                         headers={**env.h(user), "Idempotency-Key": "k-pair-001"})
    assert r.status_code == 409 and r.json()["code"] == "PAIR_NOT_AVAILABLE"
    r = await env.c.post("/internal/v1/lessons/l-01-greetings/sessions", params={"pair_id": "RU"},
                         headers={**env.h(user), "Idempotency-Key": "k-pair-002"})
    assert r.status_code == 422
    r = await env.c.post("/internal/v1/lessons/BAD ID/sessions", headers={**env.h(user), "Idempotency-Key": "k-b-01"})
    assert r.status_code == 422
    r = await env.c.post("/internal/v1/lessons/l-01-greetings/sessions",
                         headers={**env.h(user), "Idempotency-Key": "short"})
    assert r.status_code == 422 and r.json()["code"] == "IDEMPOTENCY_KEY_INVALID"
    # подросток — урок для teens/adults; ?audience=kids от BFF — детский режим
    teen = uuid.uuid4()
    s = await env.lesson(teen, "l-03-phone-number", age_band="14-17")
    assert s["ai_mode"] == "full"
    s = await env.lesson(uuid.uuid4(), params={"audience": "kids"})
    assert s["ai_mode"] == "choices"
    # без возраста — самый строгий сегмент (kids)
    s = await env.lesson(uuid.uuid4(), age_band=None)
    assert s["ai_mode"] == "choices"


@pytest.mark.parametrize("path,method", [
    ("/internal/v1/sessions/active", "get"), ("/internal/v1/sessions", "get"),
    ("/internal/v1/lessons/l-01-greetings/card", "get")])
async def test_auth_401_403(env: Env, user: uuid.UUID, path: str, method: str) -> None:
    call = getattr(env.c, method)
    r = await call(path)
    assert r.status_code == 401 and r.json()["code"] == "INTERNAL_TOKEN_MISSING"
    r = await call(path, headers={HEADER: "garbage"})
    assert r.status_code == 401
    r = await call(path, headers=env.h(user, issuer="admin-bff"))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    token = issue_token(env.settings.internal_jwt_secret.get_secret_value(), issuer="telegram-bff",
                        audience="lessons", subject=str(user), extra={"lrn": "not-a-uuid"})
    r = await call(path, headers={HEADER: token})
    assert r.status_code == 401 and r.json()["code"] == "USER_CONTEXT_INVALID"
    token = issue_token(env.settings.internal_jwt_secret.get_secret_value(), issuer="telegram-bff",
                        audience="lessons")
    r = await call(path, headers={HEADER: token})
    assert r.status_code == 401 and r.json()["code"] == "USER_CONTEXT_REQUIRED"


async def test_idor_foreign_session_is_404(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    sid = s["session_id"]
    step = await env.current(user, sid)
    other = uuid.uuid4()
    for method, path in [("get", ""), ("get", "/current"), ("get", "/summary"), ("post", "/pause"),
                         ("post", "/resume"), ("post", "/cancel"), ("post", "/finish"), ("post", "/simpler"),
                         ("post", "/roleplay/retry"), ("post", f"/steps/{step['step_id']}/hint")]:
        r = await getattr(env.c, method)(f"/internal/v1/sessions/{sid}{path}", headers=env.h(other))
        assert r.status_code == 404 and r.json()["code"] == "SESSION_NOT_FOUND", (path, r.text)
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}", json={}, headers=env.h(other))
    assert r.status_code == 404
    # тот же аккаунт, другой ученик (детский профиль) — тоже чужая сессия
    r = await env.c.get(f"/internal/v1/sessions/{sid}", headers=env.h(uuid.uuid4(), account=user))
    assert r.status_code == 404
    # ученик — из lrn, а не из sub
    r = await env.c.get(f"/internal/v1/sessions/{sid}", headers=env.h(user, account=uuid.uuid4()))
    assert r.status_code == 200
    r = await env.c.get(f"/internal/v1/sessions/{uuid.uuid4()}", headers=env.h(user))
    assert r.status_code == 404
    r = await env.c.get("/internal/v1/sessions/not-a-uuid", headers=env.h(user))
    assert r.status_code == 422


async def test_answer_validation_422(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    sid = s["session_id"]
    step = await env.current(user, sid)
    for body in ({"extra": 1}, {"text": "x" * 501}, {"choice_id": "zzz"}, {"answer": True}, {"dont_know": "yes"}):
        r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}", json=body, headers=env.h(user))
        assert r.status_code == 422, body
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/{step['step_id']}", json={"choice_id": "c1"},
                         headers=env.h(user))
    assert r.status_code == 422 and r.json()["code"] == "ANSWER_INVALID"
    r = await env.c.post(f"/internal/v1/sessions/{sid}/steps/bad", json={}, headers=env.h(user))
    assert r.status_code == 422


async def test_history_pagination(env: Env, user: uuid.UUID) -> None:
    ids = []
    for i in range(3):
        s = await env.lesson(user, key=f"hist-key-{i:03d}")
        ids.append(s["session_id"])
        await env.post(user, s["session_id"], "cancel")
        env.now = env.now.replace(second=i + 1)
    page = (await env.c.get("/internal/v1/sessions", params={"limit": 2}, headers=env.h(user))).json()
    assert [x["session_id"] for x in page["items"]] == ids[::-1][:2] and page["next_cursor"]
    assert page["items"][0]["status"] == "cancelled" and page["items"][0]["passed"] is None
    rest = (await env.c.get("/internal/v1/sessions", params={"limit": 2, "cursor": page["next_cursor"]},
                            headers=env.h(user))).json()
    assert [x["session_id"] for x in rest["items"]] == [ids[0]] and rest["next_cursor"] is None
    other = (await env.c.get("/internal/v1/sessions", headers=env.h(uuid.uuid4()))).json()
    assert other["items"] == []
    only = (await env.c.get("/internal/v1/sessions", params={"kind": "media"}, headers=env.h(user))).json()
    assert only["items"] == []
    r = await env.c.get("/internal/v1/sessions", params={"cursor": "!!!"}, headers=env.h(user))
    assert r.status_code == 400 and r.json()["code"] == "INVALID_CURSOR"


async def test_summary_only_after_finish(env: Env, user: uuid.UUID) -> None:
    s = await env.lesson(user)
    r = await env.c.get(f"/internal/v1/sessions/{s['session_id']}/summary", headers=env.h(user))
    assert r.status_code == 409 and r.json()["details"]["status"] == "ready"
    await env.post(user, s["session_id"], "cancel")
    out = (await env.c.get(f"/internal/v1/sessions/{s['session_id']}/summary", headers=env.h(user))).json()
    assert out["status"] == "cancelled" and out["evaluation"] is None and out["next_lesson"] is None


async def test_next_lesson_null_when_plan_not_recomputed(env: Env, user: uuid.UUID) -> None:
    env.plan.next_lesson = "l-01-greetings"
    _, summary = await env.complete_lesson(user)
    assert summary["next_lesson"] is None
    env.plan.down = True
    _, summary = await env.complete_lesson(uuid.uuid4())
    assert summary["next_lesson"] is None and summary["evaluation"] is not None
