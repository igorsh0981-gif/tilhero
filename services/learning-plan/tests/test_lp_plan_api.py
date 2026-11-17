"""GET/PATCH плана, онбординг, справочники: формы bff.ts, If-Match, PLAN_INVALID, авторизация, изоляция, события."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from tilhero_common.testing import internal_headers


async def test_default_plan_created_on_first_read(env, user) -> None:
    r = await env.c.get("/internal/v1/me/plan?tz=Europe/Moscow", headers=env.h(user))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "learner_id": str(user), "goal": None, "level_self": None, "topics": [], "ui_lang": "ru",
        "explain_lang": "ru", "course_pair": "ru-en",
        "schedule": {"preset": "daily", "days": [1, 2, 3, 4, 5, 6, 7], "preferred_time": "19:00", "duration_min": 20,
                     "reminders_enabled": False, "timezone": "Europe/Moscow"},
        "onboarding_completed_at": None, "updated_at": body["updated_at"], "version": 1,
    }
    assert r.headers["etag"] == '"1"'
    # повторный вход — тот же план (зона не перезаписывается следующим ?tz=)
    again = await env.c.get("/internal/v1/me/plan?tz=Asia/Tokyo", headers=env.h(user))
    assert again.json() == body
    assert await env.events("learning.plan.updated.v1") == []  # создание по умолчанию — не правка


async def test_default_timezone_and_unknown_tz_fallback(env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    assert (await env.c.get("/internal/v1/me/plan", headers=env.h(a))).json()["schedule"]["timezone"] == "Asia/Tashkent"
    r = await env.c.get("/internal/v1/me/plan?tz=Mars/Base", headers=env.h(b))
    assert r.status_code == 200 and r.json()["schedule"]["timezone"] == "Asia/Tashkent"
    too_long = await env.c.get("/internal/v1/me/plan?tz=" + "A" * 65, headers=env.h(b))
    assert too_long.status_code == 422


async def test_patch_happy_path_and_event(env, user) -> None:
    patch = {"goal": "work", "level_self": "some", "topics": ["work", "interview"], "ui_lang": "uz",
             "schedule": {"preset": "custom", "days": [6, 2], "preferred_time": "07:30", "duration_min": 15,
                          "reminders_enabled": True, "timezone": "Asia/Samarkand"}}
    r = await env.c.patch("/internal/v1/me/plan", json=patch, headers={**env.h(user), "If-Match": '"1"'})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["version"] == 2 and r.headers["etag"] == '"2"'
    assert body["goal"] == "work" and body["topics"] == ["work", "interview"] and body["ui_lang"] == "uz"
    assert body["explain_lang"] == "ru" and body["course_pair"] == "ru-en"  # язык интерфейса не меняет пару (AT-05)
    assert body["schedule"] == {"preset": "custom", "days": [2, 6], "preferred_time": "07:30", "duration_min": 15,
                                "reminders_enabled": True, "timezone": "Asia/Samarkand"}
    [ev] = await env.events("learning.plan.updated.v1", user)
    assert ev.payload["changed_fields"] == ["goal", "level_self", "topics", "ui_lang", "preset", "days",
                                            "preferred_time", "duration_min", "reminders_enabled", "timezone"]
    assert ev.payload["days"] == [2, 6] and ev.payload["preferred_time"] == "07:30"
    assert ev.payload["onboarding_completed"] is False and ev.payload["goal"] == "work"
    # повтор того же PATCH — no-op: версия и события не меняются
    same = await env.c.patch("/internal/v1/me/plan", json=patch, headers=env.h(user))
    assert same.status_code == 200 and same.json()["version"] == 2
    assert len(await env.events("learning.plan.updated.v1", user)) == 1
    # после повторного входа ученик видит то же (AT-06)
    assert (await env.c.get("/internal/v1/me/plan", headers=env.h(user))).json() == same.json()


async def test_preset_switch_changes_days(env, user) -> None:
    r = await env.c.patch("/internal/v1/me/plan", json={"schedule": {"preset": "three_per_week"}}, headers=env.h(user))
    assert r.json()["schedule"]["days"] == [1, 3, 5]
    r = await env.c.patch("/internal/v1/me/plan", json={"schedule": {"days": [1, 3, 6]}}, headers=env.h(user))
    assert r.json()["schedule"]["preset"] == "custom"  # поменял дни — стал custom
    r = await env.c.patch("/internal/v1/me/plan", json={"schedule": {"preset": "weekdays"}}, headers=env.h(user))
    assert r.json()["schedule"] == {**r.json()["schedule"], "preset": "weekdays", "days": [1, 2, 3, 4, 5]}


async def test_if_match_conflict(env, user) -> None:
    await env.c.patch("/internal/v1/me/plan", json={"goal": "travel"}, headers=env.h(user))
    r = await env.c.patch("/internal/v1/me/plan", json={"goal": "exam"}, headers={**env.h(user), "If-Match": "1"})
    assert r.status_code == 409 and r.json()["code"] == "PLAN_VERSION_CONFLICT"
    assert r.json()["details"] == {"current_version": 2}
    ok = await env.c.patch("/internal/v1/me/plan", json={"goal": "exam"}, headers={**env.h(user), "If-Match": 'W/"2"'})
    assert ok.status_code == 200 and ok.json()["goal"] == "exam"
    bad = await env.c.patch("/internal/v1/me/plan", json={"goal": "exam"}, headers={**env.h(user), "If-Match": "v2"})
    assert bad.status_code == 422 and bad.json()["details"] == {"field": "If-Match", "reason": "format"}


async def test_plan_invalid_reasons(env, user) -> None:
    cases = [
        ({"schedule": {"days": []}}, "schedule.days", "empty"),
        ({"schedule": {"days": [0]}}, "schedule.days", "out_of_range"),
        ({"schedule": {"days": [1, 2, 3, 4, 5, 6, 7, 1]}}, "schedule.days", "duplicate"),
        ({"schedule": {"preset": "weekdays", "days": [1, 2]}}, "schedule.days", "preset_mismatch"),
        ({"schedule": {"preferred_time": "9:00"}}, "schedule.preferred_time", "format"),
        ({"schedule": {"duration_min": 45}}, "schedule.duration_min", "not_allowed"),
        ({"schedule": {"duration_min": "20"}}, "schedule.duration_min", "int_type"),
        ({"schedule": {"timezone": "Europe/Atlantis"}}, "schedule.timezone", "unknown_timezone"),
        ({"topics": ["food", "nope"]}, "topics", "unknown_topic"),
        ({"topics": ["food", "travel", "work", "study", "home", "tech"]}, "topics", "too_many"),
        ({"goal": "fun"}, "goal", "unknown_value"),
        ({"level_self": "expert"}, "level_self", "unknown_value"),
        ({"ui_lang": "en"}, "ui_lang", "unknown_value"),
        ({"goal": None}, "goal", "null_not_allowed"),
        ({"schedule": {"reminders_enabled": None}}, "schedule.reminders_enabled", "null_not_allowed"),
        ({"course_pair": "ru-de"}, "course_pair", "unknown_field"),
        ({"schedule": {"days": "1,2"}}, "schedule.days", "list_type"),
    ]
    for body, field, reason in cases:
        r = await env.c.patch("/internal/v1/me/plan", json=body, headers=env.h(user))
        assert r.status_code == 422, (body, r.text)
        assert r.json()["code"] == "PLAN_INVALID" and r.json()["details"] == {"field": field, "reason": reason}, body
    # ничего не сохранилось
    plan = (await env.c.get("/internal/v1/me/plan", headers=env.h(user))).json()
    assert plan["version"] == 1 and plan["goal"] is None


async def test_onboarding_requires_goal_level_schedule(env, user) -> None:
    r = await env.c.post("/internal/v1/me/plan/onboarding/complete", headers=env.h(user))
    assert r.status_code == 409 and r.json()["code"] == "PLAN_INCOMPLETE"
    assert r.json()["details"] == {"missing": ["goal", "level_self", "schedule"]}
    # зона из Intl — не выбор графика
    await env.c.patch("/internal/v1/me/plan", json={"goal": "daily", "level_self": "zero",
                                                    "schedule": {"timezone": "Asia/Tashkent"}}, headers=env.h(user))
    r = await env.c.post("/internal/v1/me/plan/onboarding/complete", headers=env.h(user))
    assert r.json()["details"] == {"missing": ["schedule"]}
    # ученик подтвердил график по умолчанию (те же значения) — шаг пройден без правки версии
    v = (await env.c.patch("/internal/v1/me/plan", json={"schedule": {"preset": "daily", "duration_min": 20}},
                           headers=env.h(user))).json()["version"]
    env.now = datetime(2026, 11, 16, 9, 0, tzinfo=UTC)
    done = await env.c.post("/internal/v1/me/plan/onboarding/complete", headers=env.h(user))
    assert done.status_code == 200, done.text
    assert done.json()["onboarding_completed_at"] == "2026-11-16T09:00:00Z" and done.json()["version"] == v + 1
    env.now += timedelta(hours=1)
    again = await env.c.post("/internal/v1/me/plan/onboarding/complete", headers=env.h(user))
    assert again.status_code == 200 and again.json() == done.json()
    events = [e for e in await env.events("learning.plan.updated.v1", user)
              if e.payload["changed_fields"] == ["onboarding_completed_at"]]
    assert len(events) == 1 and events[0].payload["onboarding_completed"] is True


async def test_auth_and_callers(env, user) -> None:
    for method, path in (("GET", "/internal/v1/me/plan"), ("PATCH", "/internal/v1/me/plan"),
                         ("POST", "/internal/v1/me/plan/onboarding/complete"), ("GET", "/internal/v1/me/plan/today"),
                         ("POST", "/internal/v1/me/activities"), ("GET", "/internal/v1/directory/goals"),
                         ("GET", "/internal/v1/directory/topics")):
        r = await env.c.request(method, path, json={})
        assert r.status_code == 401 and r.json()["code"] == "INTERNAL_TOKEN_MISSING", path
        bad = await env.c.request(method, path, json={}, headers={"x-internal-token": "garbage"})
        assert bad.status_code == 401 and bad.json()["code"] == "INTERNAL_TOKEN_INVALID", path
        other = await env.c.request(method, path, json={}, headers=env.h(user, issuer="support"))
        assert other.status_code == 403 and other.json()["code"] == "CALLER_NOT_ALLOWED", path
    # чужая аудитория (токен для другого сервиса) не принимается
    wrong_aud = internal_headers(env.settings, subject=str(user), audience="social")
    assert (await env.c.get("/internal/v1/me/plan", headers=wrong_aud)).status_code == 401
    # без ученика в токене
    r = await env.c.get("/internal/v1/me/plan", headers=env.h(None))
    assert r.status_code == 401 and r.json()["code"] == "USER_CONTEXT_REQUIRED"
    r = await env.c.get("/internal/v1/me/plan", headers=env.h("not-a-uuid"))
    assert r.status_code == 401 and r.json()["code"] == "USER_CONTEXT_INVALID"


async def test_users_are_isolated(env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    await env.c.patch("/internal/v1/me/plan", json={"goal": "exam", "schedule": {"preferred_time": "06:00"}},
                      headers=env.h(a))
    pb = (await env.c.get("/internal/v1/me/plan", headers=env.h(b))).json()
    assert pb["learner_id"] == str(b) and pb["goal"] is None and pb["schedule"]["preferred_time"] == "19:00"
    # путь и тело не задают ученика: попытка передать чужой id — лишнее поле
    r = await env.c.patch("/internal/v1/me/plan", json={"learner_id": str(a), "goal": "work"}, headers=env.h(b))
    assert r.status_code == 422
    assert (await env.c.get("/internal/v1/me/plan", headers=env.h(a))).json()["goal"] == "exam"


async def test_directory(env, user) -> None:
    goals = (await env.c.get("/internal/v1/directory/goals", headers=env.h(user))).json()["items"]
    assert [g["code"] for g in goals] == ["work", "career", "travel", "daily", "study", "exam"]
    topics = (await env.c.get("/internal/v1/directory/topics", headers=env.h())).json()["items"]
    assert len(topics) == 12 and len({t["code"] for t in topics}) == 12
    for item in goals + topics:
        assert item["label"]["ru"] and item["label"]["uz"] and set(item) == {"code", "label", "icon"}
