"""Дети 6–13 (AT-38, CONVENTIONS §8): свой короткий тест без давления; сегмент — от telegram-bff (`audience`) и
по проекции профиля identity-consent (защита в глубину); рекомендация — только детские уроки."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from conftest import area_of
from dx_testkit import LESSONS, always, up_to

from tilhero_common.messaging import make_envelope
from tilhero_common.testing import assert_event_conforms

KIDS_LESSONS = {ls[0] for ls in LESSONS if "kids" in ls[5]}
SESSION_FIELDS = {"session_id", "pair_id", "test_version", "status", "answered", "total_estimate", "started_at",
                  "expires_at", "followup_area"}
ITEM_FIELDS = {"item_id", "area", "type", "instruction", "prompt_en", "passage_en", "audio_text_en", "options",
               "position"}


async def profile_event(env, event_type: str, payload: dict, *, producer: str = "identity-consent",
                        at: datetime | None = None) -> None:
    env_ = make_envelope(event_type, payload, producer=producer)
    if at is not None:
        env_ = env_.model_copy(update={"occurred_at": at})
    assert_event_conforms(env_)
    await env.bus.publish(env_)


async def test_kids_audience_gets_kids_test_without_pressure(env, user) -> None:
    state = (await env.c.get("/internal/v1/diagnostics/state", params={"audience": "kids"},
                             headers=env.h(user))).json()
    assert state["audience"] == "kids"
    session = await env.start(user, audience="kids")
    assert set(session) == SESSION_FIELDS  # без таймера и «ограничения времени» в данных ученика
    assert session["test_version"] == "dx-en-kids@1" and session["total_estimate"] == 12
    shown = await env.run(user, session, up_to("A1"))
    kids_items = await env.items("dx-en-kids@1")
    assert len(shown) == 12 and all(i["item_id"] in kids_items for i in shown)
    assert all(set(i) == ITEM_FIELDS for i in shown)
    result = await env.finish(user, session)
    # детский порог — 1 верный в полосе: «верно до A1» → A1 (а не всегда A0)
    assert result["provisional_level"] == "A1"
    assert {area_of(result, a)["band"] for a in ("vocabulary", "grammar", "reading", "listening")} == {"A1"}
    assert result["recommended_start"]["lesson_id"] in KIDS_LESSONS
    assert result["cefr_certificate"] is False
    assert (await env.c.get("/internal/v1/diagnostics/state", headers=env.h(user))).json()["audience"] == "kids"


async def test_kids_recommendation_is_kids_lesson_only(env, user) -> None:
    result = await env.complete(user, always("correct"), audience="kids")
    assert result["provisional_level"] == "A2"
    rec = result["recommended_start"]
    assert rec is None or rec["lesson_id"] in KIDS_LESSONS
    adult = await env.complete(uuid.uuid4(), always("correct"))
    assert adult["provisional_level"] == "B2"


async def test_child_profile_projection_forces_kids_test(env) -> None:
    child, teen, adult = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await profile_event(env, "user.profile.created.v1", {
        "user_id": str(child), "kind": "child", "locale": "ru", "age_band": "6-9",
        "guardian_user_id": str(uuid.uuid4()), "created_at": "2026-11-18T10:00:00Z"})
    await profile_event(env, "user.profile.created.v1", {
        "user_id": str(teen), "kind": "account", "locale": "uz", "age_band": None, "guardian_user_id": None,
        "created_at": "2026-11-18T10:00:00Z"})
    await profile_event(env, "user.profile.updated.v1", {
        "user_id": str(teen), "changed_fields": ["age_band"], "age_band": "14-17", "is_minor": True})
    # чужой издатель — игнорируется
    await profile_event(env, "user.profile.created.v1", {
        "user_id": str(adult), "kind": "child", "age_band": "6-9", "created_at": "2026-11-18T10:00:00Z"},
        producer="social")
    assert env.bus.dlq == []
    # BFF не передал сегмент (или передал adults) — ребёнок всё равно получает детский тест
    for hint in (None, "adults"):
        s = await env.start(child, audience=hint)
        assert s["test_version"] == "dx-en-kids@1"
    s = await env.start(teen)
    assert s["test_version"] == "dx-en-adult@1"
    [(segment,)] = await env.sql("SELECT segment FROM sessions WHERE session_id = :s",
                                 s=uuid.UUID(s["session_id"]))
    assert segment == "teens"
    s = await env.start(adult)
    assert s["test_version"] == "dx-en-adult@1"


async def test_profile_projection_ignores_stale_events(env, user) -> None:
    now = datetime(2026, 11, 18, 12, 0, tzinfo=UTC)
    await profile_event(env, "user.profile.updated.v1", {
        "user_id": str(user), "changed_fields": ["age_band"], "age_band": "10-13"}, at=now)
    await profile_event(env, "user.profile.created.v1", {
        "user_id": str(user), "kind": "child", "age_band": "6-9", "created_at": "2026-11-18T10:00:00Z"},
        at=now - timedelta(hours=2))
    [(kind, age)] = await env.sql("SELECT kind, age_band FROM learner_profiles WHERE user_id = :u", u=user)
    assert (kind, age) == ("child", "10-13")


async def test_kids_session_listening_unavailable(env, user) -> None:
    session = await env.start(user, audience="kids")
    r = await env.c.post(f"/internal/v1/diagnostics/sessions/{session['session_id']}/listening-unavailable",
                         headers=env.h(user))
    assert r.status_code == 204
    shown = await env.run(user, session, always("correct"))
    assert len(shown) == 9 and all(i["area"] != "listening" for i in shown)
    result = await env.finish(user, session)
    assert area_of(result, "listening")["reason"] == "no_speech_voice"
