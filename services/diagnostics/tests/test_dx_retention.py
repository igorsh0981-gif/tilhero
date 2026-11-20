"""Спринт 5 (INTERNAL_API §1.5, §6, AT-56): проверки удержания — memory.retention.checked.v1 (только от memory):
d30 пройдена и навык demonstrated → retained; два провала подряд и demonstrated → learning; иначе без изменений;
skills.state.changed.v1 (source retention, evidence_id = check_id); карта навыков отдаёт retained и историю проверок;
идемпотентность по check_id, чужой издатель, изоляция учеников, сага удаления. Плюс kind reading у
assessment.completed.v1 (практика) принимается и навыки не меняет."""

from __future__ import annotations

import uuid
from typing import Any

import pytest

from tilhero_common.messaging import Envelope, make_envelope
from tilhero_common.testing import assert_event_conforms
from tilhero_diagnostics.domain.retention import retention_transition

CHANGED = "skills.state.changed.v1"
CHECKED = "memory.retention.checked.v1"
GREET, BE = "en.func.greet", "en.gram.to-be"


async def publish(env, event_type: str, payload: dict[str, Any], producer: str) -> Envelope:
    ev = make_envelope(event_type, payload, producer=producer)
    assert_event_conforms(ev)
    await env.bus.publish(ev)
    return ev


async def demonstrate(env, user: uuid.UUID, skill: str = GREET) -> uuid.UUID:
    eid = uuid.uuid4()
    await publish(env, "assessment.completed.v1", {
        "evaluation_id": str(eid), "user_id": str(user), "pair_id": "ru-en", "session_id": str(uuid.uuid4()),
        "kind": "lesson", "skill_outcomes": [{"skill_id": skill, "outcome": "demonstrated"}], "passed": True,
        "practice_only": False, "supersedes": None, "created_at": "2026-11-01T08:00:00Z",
    }, producer="assessment")
    return eid


async def checked(env, user: uuid.UUID, *, stage: str, passed: bool, failures: int = 0, skill: str = GREET,
                  check_id: uuid.UUID | None = None, producer: str = "memory",
                  checked_at: str = "2026-12-01T08:00:00Z", evidence_id: uuid.UUID | None = None) -> uuid.UUID:
    cid = check_id or uuid.uuid4()
    await publish(env, CHECKED, {
        "check_id": str(cid), "user_id": str(user), "pair_id": "ru-en", "skill_id": skill, "stage": stage,
        "passed": passed, "consecutive_failures": failures,
        "evidence_id": str(evidence_id) if evidence_id else None, "checked_at": checked_at,
    }, producer=producer)
    return cid


async def states(env, user: uuid.UUID) -> dict[str, str]:
    return dict(await env.sql("SELECT skill_id, state FROM skill_states WHERE user_id = :u", u=user))


async def retention_moves(env, user: uuid.UUID) -> list[tuple[str, str, str, str, str]]:
    return [(c["skill_id"], c["from"], c["to"], c["source"], c["evidence_id"])
            for e in await env.events(CHANGED, user) for c in e.payload["changes"] if c["source"] == "retention"]


async def skill_map(env, user: uuid.UUID) -> dict[str, Any]:
    r = await env.c.get("/internal/v1/skills/map", headers=env.h(user))
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.parametrize(("current", "stage", "passed", "failures", "expected"), [
    ("demonstrated", "d30", True, 0, "retained"),
    ("demonstrated", "d30", True, 1, "retained"),
    ("demonstrated", "d7", True, 0, "demonstrated"),
    ("demonstrated", "d7", False, 1, "demonstrated"),
    ("demonstrated", "d30", False, 1, "demonstrated"),
    ("demonstrated", "d7", False, 2, "learning"),
    ("demonstrated", "d30", False, 2, "learning"),
    ("learning", "d30", True, 0, "learning"),
    ("not_started", "d30", True, 0, "not_started"),
    ("retained", "d7", False, 2, "retained"),
])
def test_transition_table(current: str, stage: str, passed: bool, failures: int, expected: str) -> None:
    assert retention_transition(current, stage, passed, failures) == expected


async def test_d7_then_d30_passed_makes_retained_with_event_map_and_history(env, user) -> None:
    await demonstrate(env, user)
    await checked(env, user, stage="d7", passed=True, checked_at="2026-11-08T08:00:00Z")
    assert await states(env, user) == {GREET: "demonstrated"}
    assert await retention_moves(env, user) == []  # d7 — без перехода и без события
    cid = await checked(env, user, stage="d30", passed=True, checked_at="2026-12-01T08:00:00Z")
    assert await states(env, user) == {GREET: "retained"}
    events = [e for e in await env.events(CHANGED, user) if e.payload["changes"][0]["source"] == "retention"]
    assert len(events) == 1
    assert events[0].payload["pair_id"] == "ru-en"
    assert events[0].payload["changes"] == [{"skill_id": GREET, "from": "demonstrated", "to": "retained",
                                             "source": "retention", "evidence_id": str(cid)}]
    [(source, ref, confidence)] = await env.sql(
        "SELECT source, state_ref, confidence FROM skill_states WHERE user_id = :u", u=user)
    assert (source, ref, confidence) == ("retention", str(cid), None)
    m = await skill_map(env, user)
    greet = next(s for s in m["skills"] if s["skill_id"] == GREET)
    assert greet["state"] == "retained"
    assert m["counts"]["retained"] == 1
    assert [(h["source"], h["outcome"], h["at"]) for h in greet["history"]][:2] == [
        ("retention", "positive", "2026-12-01T08:00:00Z"), ("retention", "positive", "2026-11-08T08:00:00Z")]


async def test_two_failures_in_a_row_demote_to_learning(env, user) -> None:
    await demonstrate(env, user)
    await checked(env, user, stage="d7", passed=False, failures=1)
    assert await states(env, user) == {GREET: "demonstrated"}
    assert await retention_moves(env, user) == []
    cid = await checked(env, user, stage="d7", passed=False, failures=2, checked_at="2026-12-04T08:00:00Z")
    assert await states(env, user) == {GREET: "learning"}
    assert await retention_moves(env, user) == [(GREET, "demonstrated", "learning", "retention", str(cid))]
    rows = await env.sql("SELECT outcome FROM skill_evidence WHERE user_id = :u AND source = 'retention' "
                         "ORDER BY created_at", u=user)
    assert [r[0] for r in rows] == ["negative", "negative"]


async def test_d30_failure_once_keeps_demonstrated(env, user) -> None:
    await demonstrate(env, user)
    await checked(env, user, stage="d30", passed=False, failures=1)
    assert await states(env, user) == {GREET: "demonstrated"}
    assert await retention_moves(env, user) == []


async def test_skill_not_demonstrated_unchanged_and_no_evidence(env, user) -> None:
    """Навык не в demonstrated (learning, retained, нет состояния) — проверка устарела: ни перехода, ни
    свидетельства."""
    await checked(env, user, stage="d30", passed=True)  # нет состояния
    await env.sql("INSERT INTO skill_states (user_id, pair_id, skill_id, state, confidence, updated_at, source) "
                  "VALUES (:u, 'ru-en', :s, 'learning', NULL, now(), 'lesson')", u=user, s=BE)
    await checked(env, user, stage="d30", passed=True, skill=BE)
    await checked(env, user, stage="d7", passed=False, failures=2, skill=BE)
    assert await states(env, user) == {BE: "learning"}
    assert await env.sql("SELECT 1 FROM skill_evidence WHERE user_id = :u", u=user) == []
    assert await env.events(CHANGED, user) == []
    # retained не понижается проверкой
    await env.sql("UPDATE skill_states SET state = 'retained' WHERE user_id = :u", u=user)
    await checked(env, user, stage="d7", passed=False, failures=2, skill=BE)
    assert await states(env, user) == {BE: "retained"}


async def test_foreign_producer_ignored(env, user) -> None:
    await demonstrate(env, user)
    for producer in ("assessment", "diagnostics", "lessons", "learning-plan", "telegram-bff"):
        await checked(env, user, stage="d30", passed=True, producer=producer)
        await checked(env, user, stage="d7", passed=False, failures=2, producer=producer)
    assert await states(env, user) == {GREET: "demonstrated"}
    assert await env.sql("SELECT 1 FROM skill_evidence WHERE user_id = :u AND source = 'retention'", u=user) == []
    assert await retention_moves(env, user) == []


async def test_idempotent_by_check_id(env, user) -> None:
    """Повторная публикация того же результата (новый event_id) — без изменений, даже после новой демонстрации."""
    await demonstrate(env, user)
    cid = await checked(env, user, stage="d7", passed=False, failures=2)
    assert await states(env, user) == {GREET: "learning"}
    await demonstrate(env, user)  # навык снова демонстрируется (новая цепочка проверок)
    assert await states(env, user) == {GREET: "demonstrated"}
    await checked(env, user, stage="d7", passed=False, failures=2, check_id=cid)  # повтор старого результата
    assert await states(env, user) == {GREET: "demonstrated"}
    d30 = await checked(env, user, stage="d30", passed=True)
    await checked(env, user, stage="d30", passed=True, check_id=d30)
    assert await states(env, user) == {GREET: "retained"}
    assert len(await retention_moves(env, user)) == 2
    [(n,)] = await env.sql("SELECT count(*) FROM skill_evidence WHERE user_id = :u AND source = 'retention'", u=user)
    assert n == 2
    # то же событие (тот же event_id) — inbox
    ev = make_envelope(CHECKED, {
        "check_id": str(uuid.uuid4()), "user_id": str(user), "pair_id": "ru-en", "skill_id": BE, "stage": "d7",
        "passed": True, "consecutive_failures": 0, "evidence_id": None, "checked_at": "2026-12-02T08:00:00Z"},
        producer="memory")
    await demonstrate(env, user, BE)
    await env.bus.publish(ev)
    await env.bus.publish(ev)
    [(n,)] = await env.sql("SELECT count(*) FROM skill_evidence WHERE user_id = :u AND skill_id = :s "
                           "AND source = 'retention'", u=user, s=BE)
    assert n == 1


async def test_learner_isolation(env, user) -> None:
    other = uuid.uuid4()
    await demonstrate(env, user)
    await demonstrate(env, other)
    await checked(env, user, stage="d30", passed=True)
    assert await states(env, user) == {GREET: "retained"}
    assert await states(env, other) == {GREET: "demonstrated"}
    assert await env.events(CHANGED, other) and all(
        c["source"] == "lesson" for e in await env.events(CHANGED, other) for c in e.payload["changes"])


async def test_after_deletion_retention_ignored(env, user) -> None:
    await demonstrate(env, user)
    await publish(env, "user.deletion.requested.v1", {"user_id": str(user), "request_id": str(uuid.uuid4()),
                                                     "requested_at": "2026-11-19T09:00:00Z"},
                  producer="identity-consent")
    await checked(env, user, stage="d30", passed=True)
    assert await states(env, user) == {}
    assert await env.sql("SELECT 1 FROM skill_evidence WHERE user_id = :u", u=user) == []


async def test_lessons_do_not_touch_retained_after_retention(env, user) -> None:
    await demonstrate(env, user)
    await checked(env, user, stage="d30", passed=True)
    await publish(env, "assessment.completed.v1", {
        "evaluation_id": str(uuid.uuid4()), "user_id": str(user), "pair_id": "ru-en",
        "session_id": str(uuid.uuid4()), "kind": "lesson",
        "skill_outcomes": [{"skill_id": GREET, "outcome": "learning"}], "passed": False,
        "practice_only": False, "supersedes": None, "created_at": "2026-12-02T08:00:00Z"}, producer="assessment")
    assert await states(env, user) == {GREET: "retained"}


@pytest.mark.parametrize("practice_only", [True, False])
async def test_reading_evaluation_accepted_and_changes_nothing(env, user, practice_only: bool) -> None:
    """kind reading (вопросы к тексту) — практика: принимается (не DLQ), навыки и свидетельства не меняются;
    practice_only=false у reading — защита в глубину, тоже без изменений."""
    eid = uuid.uuid4()
    await publish(env, "assessment.completed.v1", {
        "evaluation_id": str(eid), "user_id": str(user), "pair_id": "ru-en", "session_id": str(uuid.uuid4()),
        "kind": "reading", "skill_outcomes": [] if practice_only else [{"skill_id": GREET, "outcome": "demonstrated"}],
        "passed": True, "practice_only": practice_only, "supersedes": None, "created_at": "2026-11-19T08:00:00Z",
    }, producer="assessment")
    assert await states(env, user) == {}
    assert await env.sql("SELECT 1 FROM skill_evidence WHERE user_id = :u", u=user) == []
    assert await env.events(CHANGED, user) == []
    [(stored,)] = await env.sql("SELECT practice_only FROM lesson_evaluations WHERE evaluation_id = :e", e=eid)
    assert stored is True
