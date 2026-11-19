"""Карта навыков (AT-35): состояния после диагностики, свидетельства и история, понижение только при двух
отрицательных подряд, событие skills.state.changed.v1, карта без catalog, изоляция."""

from __future__ import annotations

import uuid
from datetime import timedelta

from dx_testkit import always, up_to


async def skill_map(env, user, **params) -> dict:
    r = await env.c.get("/internal/v1/skills/map", params=params or None, headers=env.h(user))
    assert r.status_code == 200, r.text
    return r.json()


def by_id(m: dict) -> dict[str, dict]:
    return {s["skill_id"]: s for s in m["skills"]}


async def test_empty_map_lists_course_skills(env, user) -> None:
    m = await skill_map(env, user)
    assert m["pair_id"] == "ru-en" and m["course_id"] == "en-core"
    assert m["counts"] == {"not_started": len(m["skills"]), "learning": 0, "demonstrated": 0, "retained": 0}
    greet = by_id(m)["en.func.greet"]
    assert greet == {"skill_id": "en.func.greet", "area": "function", "title": greet["title"], "level": "A0",
                     "state": "not_started", "confidence": None, "prerequisites": [], "updated_at": None,
                     "history": []}


async def test_diagnostic_sets_states_and_emits_event(env, user) -> None:
    result = await env.complete(user, always("correct"))
    m = await skill_map(env, user)
    skills = by_id(m)
    demonstrated = {s for s, v in skills.items() if v["state"] == "demonstrated"}
    assert demonstrated and m["counts"]["learning"] == 0
    assert m["counts"]["demonstrated"] == len(demonstrated)
    [ev] = await env.events("skills.state.changed.v1", user)
    changes = {c["skill_id"]: c for c in ev.payload["changes"]}
    assert set(changes) == demonstrated
    skill = sorted(demonstrated)[0]
    assert (changes[skill]["from"], changes[skill]["to"], changes[skill]["source"]) == (
        "not_started", "demonstrated", "diagnostic")
    one = skills[skill]
    assert one["confidence"] == 1.0 and one["updated_at"] == "2026-11-19T07:00:00Z"
    assert one["history"] == [{"source": "diagnostic", "outcome": "positive", "at": "2026-11-19T07:00:00Z"}]
    [(evidence_ref,)] = await env.sql(
        "SELECT ref_id FROM skill_evidence WHERE id = :i", i=uuid.UUID(changes[skill]["evidence_id"]))
    assert evidence_ref == result["result_id"]
    # навыки только курса (снимок): skill_ids заданий вне курса не появляются
    [(n,)] = await env.sql("SELECT count(*) FROM skill_states WHERE user_id = :u AND skill_id NOT IN "
                           "(SELECT unnest(CAST(:ids AS text[])))", u=user, ids=list(skills))
    assert n == 0


async def test_downgrade_only_after_two_negative_in_a_row(env, user) -> None:
    # фиксированный seed: «верно только A0» подтверждает навыки заданий A0; «всегда неверно» показывает все задания
    # A0 каждой области — подтверждённый навык снова получает свидетельство
    env.fixed_seed = "seed-skills-0001"
    await env.complete(user, up_to("A0"))
    [ev] = await env.events("skills.state.changed.v1", user)
    skill = sorted(c["skill_id"] for c in ev.payload["changes"] if c["to"] == "demonstrated")[0]
    env.now += timedelta(days=14)
    await env.complete(user, always("wrong"))
    one = by_id(await skill_map(env, user))[skill]
    assert one["state"] == "demonstrated"  # одно отрицательное свидетельство — без понижения
    assert [h["outcome"] for h in one["history"]] == ["negative", "positive"]
    env.now += timedelta(days=14)
    await env.complete(user, always("wrong"))
    one = by_id(await skill_map(env, user))[skill]
    assert one["state"] == "learning"
    assert [h["outcome"] for h in one["history"]] == ["negative", "negative", "positive"]
    events = await env.events("skills.state.changed.v1", user)
    moves = [(c["from"], c["to"]) for e in events for c in e.payload["changes"] if c["skill_id"] == skill]
    assert moves == [("not_started", "demonstrated"), ("demonstrated", "learning")]
    env.now += timedelta(days=14)
    await env.complete(user, up_to("A0"))
    assert by_id(await skill_map(env, user))[skill]["state"] == "demonstrated"
    for _ in range(3):
        env.now += timedelta(days=14)
        await env.complete(user, always("wrong"))
    one = by_id(await skill_map(env, user))[skill]
    assert len(one["history"]) == 5 and one["state"] == "learning"
    [(n,)] = await env.sql("SELECT count(*) FROM skill_evidence WHERE user_id = :u AND skill_id = :s", u=user,
                           s=skill)
    assert n == 7  # история не удаляется


async def test_wrong_answers_mark_learning(env, user) -> None:
    await env.complete(user, always("dont_know"))
    m = await skill_map(env, user)
    assert m["counts"]["demonstrated"] == 0 and m["counts"]["learning"] > 0
    assert all(s["history"] == [] or s["history"][0]["outcome"] == "negative" for s in m["skills"])


async def test_map_without_catalog_and_isolation(env, user) -> None:
    await env.complete(user, always("correct"))
    other = uuid.uuid4()
    m = await skill_map(env, other)
    assert m["counts"]["demonstrated"] == 0
    env.catalog.down = True
    env.app.state.catalog._snapshots.clear()
    m = await skill_map(env, user)
    assert m["course_id"] == "en-core" and m["skills"]
    assert all(s["title"] is None and s["level"] is None for s in m["skills"])
    assert all(s["state"] == "demonstrated" for s in m["skills"])
