"""Admin API memory (INTERNAL_API §1.11, AT-61): права в домене (без учёта step-up), сводка, карточки без цитаты
ошибки, история планирования, ручная правка с аудитом, аналитика забывания с k-анонимностью, блок обзора."""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from typing import Any

import pytest

ERR = [{"turn_id": "T1", "evidence": "I from Tashkent", "correction": "I am from Tashkent.",
        "error_code": "missing_be", "severity": "high"}]


async def adm(env: Any, method: str, path: str, *perms: str, expect: int = 200, body: Any = None,
              **kw: Any) -> Any:
    r = await env.c.request(method, f"/admin/v1/memory/{path}", json=body, headers=env.staff(*perms, **kw))
    assert r.status_code == expect, r.text
    return r.json()


@pytest.mark.parametrize(("method", "path", "perm"), [
    ("GET", "learners/{u}", "memory.read"), ("GET", "learners/{u}/cards", "memory.read"),
    ("GET", "cards/{c}", "memory.read"), ("GET", "cards/{c}/log", "memory.read"),
    ("POST", "cards/{c}/actions", "memory.manage"), ("GET", "analytics", "memory.read"),
    ("GET", "stats", "dashboard.read")])
async def test_permissions(env, method: str, path: str, perm: str) -> None:  # type: ignore[no-untyped-def]
    u, c = uuid.uuid4(), uuid.uuid4()
    url = f"/admin/v1/memory/{path.format(u=u, c=c)}"
    body = {"action": "freeze", "reason": "проверка доступа"} if method == "POST" else None
    assert (await env.c.request(method, url, json=body)).status_code == 401
    r = await env.c.request(method, url, json=body, headers=env.staff(perm, issuer="telegram-bff"))
    assert r.status_code == 403 and r.json()["code"] in ("CALLER_NOT_ALLOWED", "ACTOR_NOT_ALLOWED")
    r = await env.c.request(method, url, json=body, headers=env.staff(perm, actor=False))
    assert r.status_code == 403 and r.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    r = await env.c.request(method, url, json=body, headers=env.staff("users.read", "glossary.manage"))
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    r = await env.c.request(method, url, json=body, headers=env.staff(perm))
    assert r.status_code in (200, 404), r.text  # право есть — дальше только правила домена


async def test_summary_cards_and_log(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await adm(env, "GET", f"learners/{user}", "memory.read", expect=404)
    env.identity.set(user)
    await env.lesson_done(user, errors=ERR)
    s = await env.start(user)
    await env.play(user, s["session_id"])
    await env.post(user, f"review-sessions/{s['session_id']}/finish")
    summary = await adm(env, "GET", f"learners/{user}", "memory.read")
    assert summary["cards_by_status"] == {"new": 6, "learning": 5, "review": 0, "known": 0, "frozen": 0,
                                          "archived": 0}
    assert summary["reviews_30d"] == 5 and summary["last_review_at"] and summary["pair_id"] == "ru-en"
    assert summary["due_now"] == 0 and summary["overdue_7d"] == 0 and summary["checks"] == []
    page = await adm(env, "GET", f"learners/{user}/cards?limit=4", "memory.read")
    assert len(page["items"]) == 4 and page["next_cursor"]
    raw = json.dumps(await adm(env, "GET", f"learners/{user}/cards?kind=error", "memory.read"), ensure_ascii=False)
    assert "I from Tashkent" not in raw and "evidence" not in raw
    learning = await adm(env, "GET", f"learners/{user}/cards?status=learning", "memory.read")
    first = next(c for c in learning["items"] if c["kind"] != "error")  # новая ошибка — ввод (good), слово — выбор
    cid = first["card_id"]
    assert first["retrievability"] is not None and first["reps"] == 1
    detail = await adm(env, "GET", f"cards/{cid}", "memory.read")
    assert detail["user_id"] == str(user) and detail["sources"][0]["kind"] == "lesson"
    [row] = detail["log"]["items"]
    assert row["algorithm"] == "fsrs-5" and row["params_version"] == "fsrs5-default-1" and row["actor"] == "learner"
    assert row["actor_id"] is None and row["actor_name"] is None
    assert row["before"]["state"] == "new" and row["after"]["state"] == "learning" and row["grade"] == "hard"
    err_id = (await adm(env, "GET", f"learners/{user}/cards?kind=error", "memory.read"))["items"][0]["card_id"]
    assert "I from Tashkent" not in json.dumps(await adm(env, "GET", f"cards/{err_id}", "memory.read"),
                                               ensure_ascii=False)
    await adm(env, "GET", f"cards/{uuid.uuid4()}", "memory.read", expect=404)
    await adm(env, "GET", f"cards/{cid}/log?cursor=@@", "memory.read", expect=400)


async def test_card_actions_with_audit(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    await env.make_review(user)
    [(cid,)] = await env.sql("SELECT card_id FROM cards WHERE user_id = :u AND key = 'hello'", u=user)
    path = f"cards/{cid}/actions"
    due = (env.now + timedelta(days=2)).isoformat()
    res = await adm(env, "POST", path, "memory.manage", body={"action": "reschedule", "due_at": due,
                                                              "reason": "ученик уезжает, просьба родителя"})
    assert res["due_at"] == "2026-11-22T05:00:00.000Z" and res["stability"] == 10.0  # FSRS не пересчитывается
    entry = res["log"]["items"][0]
    assert entry["actor"] == "staff" and entry["actor_name"] == "Оператор" and entry["grade"] is None
    assert entry["actor_id"] == await audit_actor(env)
    assert entry["reason"] == "ученик уезжает, просьба родителя" and entry["task_type"] == "manual"
    for bad, code in (({"action": "reschedule", "due_at": (env.now + timedelta(hours=5)).isoformat(),
                        "reason": "слишком рано для срока"}, "DUE_AT_RANGE"),
                      ({"action": "reschedule", "due_at": (env.now + timedelta(days=400)).isoformat(),
                        "reason": "слишком поздно для срока"}, "DUE_AT_RANGE"),
                      ({"action": "freeze", "reason": "коротко"}, "VALIDATION_ERROR"),
                      ({"action": "reschedule", "reason": "без нового срока"}, "VALIDATION_ERROR"),
                      ({"action": "freeze", "due_at": due, "reason": "лишний срок у заморозки"}, "VALIDATION_ERROR"),
                      ({"action": "delete_all", "reason": "массовых действий нет"}, "VALIDATION_ERROR")):
        assert (await adm(env, "POST", path, "memory.manage", body=bad, expect=422))["code"] == code
    env.now += timedelta(seconds=1)
    frozen = await adm(env, "POST", path, "memory.manage", body={"action": "freeze", "reason": "жалоба на перевод"})
    assert frozen["status"] == "frozen"
    err = await adm(env, "POST", path, "memory.manage", body={"action": "freeze", "reason": "жалоба на перевод"},
                    expect=409)
    assert err["code"] == "CARD_STATE" and err["details"] == {"status": "frozen"}
    card = await env.get(user, f"cards/{cid}")
    assert card["status"] == "frozen" and card["due_at"] is None
    s = await env.start(user)
    assert s["cards"] == 9  # замороженная в повторение не попадает
    await env.post(user, f"review-sessions/{s['session_id']}/cancel")
    env.now += timedelta(seconds=1)
    assert (await adm(env, "POST", path, "memory.manage", body={"action": "unfreeze",
                                                               "reason": "перевод исправлен"}))["status"] == "review"
    await adm(env, "POST", path, "memory.manage", body={"action": "unfreeze", "reason": "повторная разморозка"},
              expect=409)
    env.now += timedelta(minutes=1)  # порядок строк истории
    reset = await adm(env, "POST", path, "memory.manage", body={"action": "reset", "reason": "начать заново слово"})
    assert reset["status"] == "new" and reset["reps"] == 0 and reset["stability"] is None
    assert reset["log"]["items"][0]["after"]["state"] == "new"
    await adm(env, "POST", f"cards/{uuid.uuid4()}/actions", "memory.manage",
              body={"action": "reset", "reason": "нет такой карточки"}, expect=404)
    audits = [e for e in env.bus.published if e.event_type == "admin.audit.recorded.v1"]
    await env.events("admin.audit.recorded.v1")
    assert [a.payload["action"] for a in audits] == ["memory.card_adjusted"] * 4
    first = audits[0].payload
    assert first["object_type"] == "memory_card" and first["object_id"] == str(cid)
    assert first["after"]["action"] == "reschedule" and first["after"]["user_id"] == str(user)
    assert first["before"]["due_at"] != first["after"]["due_at"] and first["reason"]
    log = await adm(env, "GET", f"cards/{cid}/log?limit=2", "memory.read")
    nxt = await adm(env, "GET", f"cards/{cid}/log?limit=2&cursor={log['next_cursor']}", "memory.read")
    assert len(log["items"]) == 2 and len(nxt["items"]) == 2 and nxt["next_cursor"] is None


async def audit_actor(env: Any) -> str:
    """UUID сотрудника из последнего события аудита (тот же, что в строке истории)."""
    await env.flush()
    return str([e for e in env.bus.published if e.event_type == "admin.audit.recorded.v1"][-1].payload["actor_id"])


async def _seed_analytics(env: Any, n: int) -> list[uuid.UUID]:
    users = []
    for i in range(n):
        u = uuid.uuid4()
        users.append(u)
        env.identity.set(u)
        await env.lesson_done(u, errors=ERR)
        await env.sql(
            "INSERT INTO retention_checks (check_id, user_id, pair_id, skill_id, chain_id, stage, demonstrated_at, "
            "due_at, status, result, checked_at, created_at, updated_at) VALUES (:id, :u, 'ru-en', 'en.func.greet', "
            ":id, 'd7', :t, :t, :st, '{\"correct\": 2, \"total\": 3}', :t, :t, :t)",
            id=uuid.uuid4(), u=u, t=env.now, st="passed" if i % 2 == 0 else "failed")
        for card_key, grades in (("hello", ["again", "again", "good", "hard"]),
                                 ("i am from tashkent", ["again", "again"] if i == 0 else ["good"])):
            [(cid,)] = await env.sql("SELECT card_id FROM cards WHERE user_id = :u AND key = :k", u=u, k=card_key)
            for g in grades:
                await env.sql(
                    "INSERT INTO review_log (log_id, card_id, user_id, task_type, answer_mode, grade, before, after, "
                    "algorithm, params_version, actor, created_at) VALUES (:id, :c, :u, 'typed', 'typed', :g, "
                    "'{}'::jsonb, '{}'::jsonb, 'fsrs-5', 'fsrs5-default-1', 'learner', :t)",
                    id=uuid.uuid4(), c=cid, u=u, g=g, t=env.now)
    return users


async def test_forgetting_analytics_k_anonymity(env) -> None:  # type: ignore[no-untyped-def]
    users = await _seed_analytics(env, 4)
    res = await adm(env, "GET", "analytics?pair_id=ru-en&period=30d", "dashboard.read")
    assert res["checks"]["d7"] == {"scheduled": 0, "passed": 0, "failed": 0, "pass_pct": None, "hidden": True}
    assert res["by_skill"][0]["d7"]["hidden"] is True and res["by_skill"][0]["title"]["ru"]
    assert all(lesson["hidden"] and lesson["again_pct"] is None for lesson in res["by_lesson"])
    assert res["repeated_errors"][0]["hidden"] is True and res["forgotten_words"] == []
    users += await _seed_analytics(env, 1)
    res = await adm(env, "GET", "analytics?pair_id=ru-en&period=90d", "memory.read")
    assert res["checks"]["d7"] == {"scheduled": 5, "passed": 3, "failed": 2, "pass_pct": 60.0, "hidden": False}
    assert res["checks"]["d30"]["hidden"] is True
    [lesson] = res["by_lesson"]
    # 5 × (10 слов урока + карточка ошибки урока); ответы: hello 20 (10 again) + ошибка 7 (4 again у двух учеников)
    assert lesson["lesson_id"] == "l-01-greetings" and lesson["cards"] == 55 and not lesson["hidden"]
    assert lesson["again_pct"] == 51.9 and lesson["title"]["ru"]
    [err] = res["repeated_errors"]
    assert err == {"error_code": "missing_be", "label": {"ru": "Пропущен глагол be", "uz": "be feʼli tushib qolgan"},
                   "learners_with_repeats": 2, "cards": 5, "hidden": False}
    assert res["forgotten_words"] == [{"text_en": "Hello!", "answers": 20, "again_pct": 50.0}]
    raw = json.dumps(res)
    assert all(str(u) not in raw for u in users) and "user_id" not in raw


async def test_dashboard_stats(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    s = await env.start(user)
    await env.play(user, s["session_id"])
    await env.post(user, f"review-sessions/{s['session_id']}/finish")
    stats = await adm(env, "GET", "stats?period=7d", "dashboard.read")
    assert stats == {"period": "7d", "review_sessions": 1, "learners_reviewing": 1, "median_minutes": None,
                     "d30_pass_pct": None, "avg_due_per_learner": None, "ai_glosses_pending": None}
    await adm(env, "GET", "stats?period=1y", "dashboard.read", expect=422)
    today = await adm(env, "GET", "stats?period=today", "dashboard.read")
    assert today["review_sessions"] == 1
