"""Спринт 4 (INTERNAL_API §5, AT-46, AT-47): карта навыков по оценкам уроков — assessment.completed.v1 и
assessment.reevaluated.v1 (только от assessment): переходы learning / demonstrated, retained и not_assessed не
трогаются, practice_only — без изменений, свидетельства source lesson (история карты), skills.state.changed.v1 только
при изменениях, переоценка возвращает демонстрацию только по заменённой оценке, идемпотентность, изоляция, сага."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from dx_testkit import always, up_to

from tilhero_common.messaging import Envelope, make_envelope
from tilhero_common.testing import assert_event_conforms

CHANGED = "skills.state.changed.v1"
DURABLE = "diagnostics.assessment"
GREET, BE, FAMILY = "en.func.greet", "en.gram.to-be", "en.voc.family"


async def publish(env, event_type: str, payload: dict[str, Any], producer: str = "assessment") -> Envelope:
    ev = make_envelope(event_type, payload, producer=producer)
    assert_event_conforms(ev)
    await env.bus.publish(ev)
    return ev


async def completed(env, user: uuid.UUID, outcomes: dict[str, str], *, evaluation_id: uuid.UUID | None = None,
                    practice_only: bool = False, kind: str = "lesson", supersedes: uuid.UUID | None = None,
                    created_at: str = "2026-11-19T08:00:00Z", producer: str = "assessment",
                    pair_id: str = "ru-en") -> uuid.UUID:
    eid = evaluation_id or uuid.uuid4()
    await publish(env, "assessment.completed.v1", {
        "evaluation_id": str(eid), "user_id": str(user), "pair_id": pair_id, "session_id": str(uuid.uuid4()),
        "kind": kind, "skill_outcomes": [{"skill_id": s, "outcome": o} for s, o in outcomes.items()],
        "passed": True, "practice_only": practice_only, "supersedes": str(supersedes) if supersedes else None,
        "created_at": created_at,
    }, producer=producer)
    return eid


async def reevaluated(env, user: uuid.UUID, supersedes: uuid.UUID, outcomes: dict[str, str], *,
                      created_at: str = "2026-11-20T08:00:00Z", producer: str = "assessment") -> uuid.UUID:
    eid = uuid.uuid4()
    # session_id обязателен в схеме после ревью спринта 4; diagnostics сопоставляет по supersedes
    await publish(env, "assessment.reevaluated.v1", {
        "evaluation_id": str(eid), "supersedes": str(supersedes), "session_id": str(uuid.uuid4()),
        "user_id": str(user), "pair_id": "ru-en",
        "skill_outcomes": [{"skill_id": s, "outcome": o} for s, o in outcomes.items()], "passed": None,
        "appeal_id": str(uuid.uuid4()), "created_at": created_at,
    }, producer=producer)
    return eid


async def states(env, user: uuid.UUID) -> dict[str, str]:
    rows = await env.sql("SELECT skill_id, state FROM skill_states WHERE user_id = :u", u=user)
    return dict(rows)


async def skill_map(env, user: uuid.UUID) -> dict[str, dict[str, Any]]:
    r = await env.c.get("/internal/v1/skills/map", headers=env.h(user))
    assert r.status_code == 200, r.text
    return {s["skill_id"]: s for s in r.json()["skills"]}


def moves(events: list[Envelope]) -> list[tuple[str, str, str, str, str]]:
    return [(c["skill_id"], c["from"], c["to"], c["source"], c["evidence_id"])
            for e in events for c in e.payload["changes"]]


# ---------------------------------------------------------------- оценка урока


async def test_completed_sets_learning_and_demonstrated_with_event_and_history(env, user) -> None:
    eid = await completed(env, user, {GREET: "demonstrated", BE: "learning", FAMILY: "not_assessed"})
    assert await states(env, user) == {GREET: "demonstrated", BE: "learning"}
    [ev] = await env.events(CHANGED, user)
    assert ev.payload["pair_id"] == "ru-en"
    assert sorted(moves([ev])) == [(GREET, "not_started", "demonstrated", "lesson", str(eid)),
                                   (BE, "not_started", "learning", "lesson", str(eid))]
    m = await skill_map(env, user)
    assert m[GREET]["state"] == "demonstrated" and m[GREET]["confidence"] is None
    assert m[GREET]["history"] == [{"source": "lesson", "outcome": "positive", "at": "2026-11-19T08:00:00Z"}]
    assert m[BE]["history"] == [{"source": "lesson", "outcome": "negative", "at": "2026-11-19T08:00:00Z"}]
    assert m[FAMILY]["state"] == "not_started" and m[FAMILY]["history"] == []  # not_assessed — без свидетельства
    rows = await env.sql("SELECT skill_id, source, ref_id FROM skill_evidence WHERE user_id = :u ORDER BY skill_id",
                         u=user)
    assert [tuple(r) for r in rows] == [(GREET, "lesson", str(eid)), (BE, "lesson", str(eid))]


async def test_transitions_table(env, user) -> None:
    """learning → demonstrated; demonstrated + learning — без изменений; retained не трогается."""
    await completed(env, user, {GREET: "learning", BE: "demonstrated"})
    await env.sql("INSERT INTO skill_states (user_id, pair_id, skill_id, state, confidence, updated_at, source) "
                  "VALUES (:u, 'ru-en', :s, 'retained', NULL, now(), 'retention')", u=user, s=FAMILY)
    await completed(env, user, {GREET: "demonstrated", BE: "learning", FAMILY: "learning"},
                    created_at="2026-11-19T09:00:00Z")
    assert await states(env, user) == {GREET: "demonstrated", BE: "demonstrated", FAMILY: "retained"}
    events = await env.events(CHANGED, user)
    assert [sorted((m[0], m[1], m[2]) for m in moves([e])) for e in events] == [
        [(GREET, "not_started", "learning"), (BE, "not_started", "demonstrated")],
        [(GREET, "learning", "demonstrated")]]
    # без реальных изменений — события нет, но свидетельства пишутся
    await completed(env, user, {BE: "demonstrated"}, created_at="2026-11-19T10:00:00Z")
    assert len(await env.events(CHANGED, user)) == 2
    [(n,)] = await env.sql("SELECT count(*) FROM skill_evidence WHERE user_id = :u AND skill_id = :s", u=user, s=BE)
    assert n == 3
    # история карты — свидетельства уроков, новые первыми
    history = (await skill_map(env, user))[BE]["history"]
    assert [(h["source"], h["outcome"]) for h in history] == [("lesson", "positive"), ("lesson", "negative"),
                                                              ("lesson", "positive")]


async def test_practice_only_and_review_change_nothing(env, user) -> None:
    await completed(env, user, {GREET: "demonstrated"}, practice_only=True)
    await completed(env, user, {BE: "demonstrated"}, kind="review")
    assert await states(env, user) == {}
    assert await env.sql("SELECT 1 FROM skill_evidence WHERE user_id = :u", u=user) == []
    assert await env.events(CHANGED, user) == []
    [(n,)] = await env.sql("SELECT count(*) FROM lesson_evaluations WHERE user_id = :u AND practice_only", u=user)
    assert n == 2


async def test_lesson_after_diagnostic(env, user) -> None:
    """Диагностика поставила learning — урок демонстрирует; урок с learning не понижает демонстрацию диагностики."""
    await env.complete(user, always("dont_know"))
    before = await states(env, user)
    learning = sorted(s for s, v in before.items() if v == "learning")
    assert learning
    skill = learning[0]
    await completed(env, user, {skill: "demonstrated"}, created_at="2026-11-19T08:00:00Z")
    assert (await states(env, user))[skill] == "demonstrated"
    other = uuid.uuid4()
    await env.complete(other, up_to("A2"))
    shown = sorted(s for s, v in (await states(env, other)).items() if v == "demonstrated")[0]
    await completed(env, other, {shown: "learning"})
    assert (await states(env, other))[shown] == "demonstrated"


async def test_idempotent_redelivery_and_republish(env, user) -> None:
    eid = uuid.uuid4()
    ev = make_envelope("assessment.completed.v1", {
        "evaluation_id": str(eid), "user_id": str(user), "pair_id": "ru-en", "session_id": str(uuid.uuid4()),
        "kind": "lesson", "skill_outcomes": [{"skill_id": GREET, "outcome": "demonstrated"}], "passed": True,
        "practice_only": False, "supersedes": None, "created_at": "2026-11-19T08:00:00Z"}, producer="assessment")
    await env.bus.publish(ev)
    spec = next(s for s in env.bus.specs if s.durable == DURABLE)
    await spec.handler(ev)  # повтор доставки — inbox
    await completed(env, user, {GREET: "demonstrated"}, evaluation_id=eid)  # повторная публикация, новый event_id
    [(n,)] = await env.sql("SELECT count(*) FROM skill_evidence WHERE user_id = :u", u=user)
    assert n == 1 and len(await env.events(CHANGED, user)) == 1


async def test_foreign_producer_and_invalid_payload(env, user) -> None:
    for producer in ("lessons", "ai-gateway", "telegram-bff"):
        await completed(env, user, {GREET: "demonstrated"}, producer=producer)
    eid = uuid.uuid4()
    await reevaluated(env, user, eid, {GREET: "demonstrated"}, producer="lessons")
    assert await states(env, user) == {} and await env.sql("SELECT 1 FROM lesson_evaluations") == []
    bad = make_envelope("assessment.completed.v1", {"evaluation_id": str(uuid.uuid4()), "user_id": str(user)},
                        producer="assessment")
    await env.bus.publish(bad)
    assert [e.event_id for _, e in env.bus.dlq] == [bad.event_id]


async def test_isolation_and_pair(env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    await completed(env, a, {GREET: "demonstrated"})
    assert await states(env, b) == {}
    assert (await skill_map(env, b))[GREET]["state"] == "not_started"
    await completed(env, b, {GREET: "learning"}, pair_id="ru-uz")
    assert (await skill_map(env, b))[GREET]["state"] == "not_started"  # карта ru-en не тронута
    rows = await env.sql("SELECT pair_id, state FROM skill_states WHERE user_id = :u", u=b)
    assert [tuple(r) for r in rows] == [("ru-uz", "learning")]
    await completed(env, b, {GREET: "learning"}, pair_id="x" * 20)  # pair_id длиннее колонки — без действия
    assert len(await env.sql("SELECT 1 FROM skill_states WHERE user_id = :u", u=b)) == 1


# ---------------------------------------------------------------- переоценка (AT-47)


async def test_reevaluation_reverts_demonstration_only_by_superseded(env, user) -> None:
    e1 = await completed(env, user, {GREET: "demonstrated", BE: "demonstrated", FAMILY: "learning"})
    # BE подтверждён и другой оценкой (другой урок) — переоценка e1 его не трогает
    await completed(env, user, {BE: "demonstrated"}, created_at="2026-11-19T09:00:00Z")
    e2 = await reevaluated(env, user, e1, {GREET: "learning", BE: "learning", FAMILY: "demonstrated"})
    assert await states(env, user) == {GREET: "learning", BE: "demonstrated", FAMILY: "demonstrated"}
    events = await env.events(CHANGED, user)
    assert sorted(moves(events[-1:])) == [(GREET, "demonstrated", "learning", "lesson", str(e2)),
                                          (FAMILY, "learning", "demonstrated", "lesson", str(e2))]
    # исходная оценка и её свидетельства сохранены; новая — свои свидетельства
    [(n1,)] = await env.sql("SELECT count(*) FROM skill_evidence WHERE ref_id = :r", r=str(e1))
    [(n2,)] = await env.sql("SELECT count(*) FROM skill_evidence WHERE ref_id = :r", r=str(e2))
    assert (n1, n2) == (3, 3)
    history = (await skill_map(env, user))[GREET]["history"]
    assert [(h["outcome"], h["at"]) for h in history] == [("negative", "2026-11-20T08:00:00Z"),
                                                          ("positive", "2026-11-19T08:00:00Z")]


async def test_reevaluation_not_assessed_or_omitted_reverts_and_upheld_keeps(env, user) -> None:
    e1 = await completed(env, user, {GREET: "demonstrated", BE: "demonstrated"})
    e2 = await reevaluated(env, user, e1, {GREET: "not_assessed"})  # BE в новой оценке нет
    assert await states(env, user) == {GREET: "learning", BE: "learning"}
    # переоценка, подтверждающая демонстрацию, — без изменений и без события
    other = uuid.uuid4()
    o1 = await completed(env, other, {GREET: "demonstrated"})
    await reevaluated(env, other, o1, {GREET: "demonstrated"})
    assert await states(env, other) == {GREET: "demonstrated"}
    assert len(await env.events(CHANGED, other)) == 1
    # цепочка: переоценка переоценки (e2 заменена e3, которая демонстрирует GREET)
    e3 = await reevaluated(env, user, e2, {GREET: "demonstrated"}, created_at="2026-11-21T08:00:00Z")
    assert (await states(env, user))[GREET] == "demonstrated"
    await reevaluated(env, user, e3, {GREET: "learning"}, created_at="2026-11-22T08:00:00Z")
    assert (await states(env, user))[GREET] == "learning"


async def test_reevaluation_keeps_diagnostic_demonstration(env, user) -> None:
    """Демонстрация, установленная диагностикой, переоценкой урока не отменяется (держится не на оценке урока)."""
    await env.complete(user, up_to("A2"))
    shown = sorted(s for s, v in (await states(env, user)).items() if v == "demonstrated")[0]
    e1 = await completed(env, user, {shown: "demonstrated"})
    await reevaluated(env, user, e1, {shown: "learning"})
    assert (await states(env, user))[shown] == "demonstrated"


async def test_reevaluation_retained_and_practice_only_untouched(env, user) -> None:
    e1 = await completed(env, user, {GREET: "demonstrated"})
    await env.sql("UPDATE skill_states SET state = 'retained' WHERE user_id = :u", u=user)
    await reevaluated(env, user, e1, {GREET: "learning"})
    assert await states(env, user) == {GREET: "retained"}
    p1 = await completed(env, user, {BE: "demonstrated"}, practice_only=True)
    await reevaluated(env, user, p1, {BE: "demonstrated"})
    assert BE not in await states(env, user)


async def test_out_of_order_superseded_evaluation_not_applied(env, user) -> None:
    """Переоценка пришла раньше исходной оценки — исходная записывается, но навыки по ней не меняются."""
    e1 = uuid.uuid4()
    await reevaluated(env, user, e1, {GREET: "learning"})
    await completed(env, user, {GREET: "demonstrated"}, evaluation_id=e1)
    assert await states(env, user) == {GREET: "learning"}
    # completed с supersedes — тоже переоценка
    e2 = await completed(env, user, {BE: "demonstrated"}, created_at="2026-11-19T08:00:00Z")
    await completed(env, user, {BE: "learning"}, supersedes=e2, created_at="2026-11-19T09:00:00Z")
    assert (await states(env, user))[BE] == "learning"


async def test_reevaluation_cannot_touch_another_learner(env, user) -> None:
    other = uuid.uuid4()
    e1 = await completed(env, other, {GREET: "demonstrated"})
    await completed(env, user, {GREET: "demonstrated"}, evaluation_id=uuid.uuid4())
    await reevaluated(env, user, e1, {GREET: "learning"})  # «заменяет» чужую оценку — у других ничего не меняется
    assert await states(env, other) == {GREET: "demonstrated"}
    assert await states(env, user) == {GREET: "demonstrated"}


async def test_deletion_removes_lesson_evaluations_and_late_events(env, user) -> None:
    await completed(env, user, {GREET: "demonstrated"})
    env.now += timedelta(minutes=1)
    await publish(env, "user.deletion.requested.v1", {"user_id": str(user), "request_id": str(uuid.uuid4()),
                                                     "requested_at": "2026-11-19T09:00:00Z"},
                  producer="identity-consent")
    for table in ("lesson_evaluations", "skill_states", "skill_evidence"):
        [(n,)] = await env.sql(f"SELECT count(*) FROM {table} WHERE user_id = :u", u=user)  # noqa: S608
        assert n == 0, table
    await completed(env, user, {BE: "demonstrated"})
    assert await states(env, user) == {}
    assert await env.sql("SELECT 1 FROM lesson_evaluations WHERE user_id = :u", u=user) == []


async def test_skill_map_readable_by_lessons_only_own_learner(env, user) -> None:
    """lessons читает карту навыков ученика (этап повторения); остальной клиентский API — только telegram-bff."""
    await completed(env, user, {GREET: "learning"})
    r = await env.c.get("/internal/v1/skills/map", headers=env.h(user, issuer="lessons"))
    assert r.status_code == 200
    assert {s["skill_id"]: s["state"] for s in r.json()["skills"]}[GREET] == "learning"
    for issuer in ("assessment", "learning-plan", "notifications"):
        r = await env.c.get("/internal/v1/skills/map", headers=env.h(user, issuer=issuer))
        assert (r.status_code, r.json()["code"]) == (403, "CALLER_NOT_ALLOWED"), issuer
    r = await env.c.get("/internal/v1/diagnostics/state", headers=env.h(user, issuer="lessons"))
    assert (r.status_code, r.json()["code"]) == (403, "CALLER_NOT_ALLOWED")
    r = await env.c.get("/internal/v1/skills/map", headers=env.h(None, issuer="lessons"))
    assert (r.status_code, r.json()["code"]) == (401, "USER_CONTEXT_REQUIRED")
