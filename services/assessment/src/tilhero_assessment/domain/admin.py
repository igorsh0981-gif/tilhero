"""Контроль диалогов в assessment (INTERNAL_API §3.4, AT-47, AT-52): карточка оценки с цепочкой, QA-флаг,
переоценка (новая запись supersedes, исходная сохраняется), сводка по сессиям для журнала, статистика обзора.
Права — по actor в API; здесь — правила и аудит (`admin.audit.recorded.v1` через outbox, без текстов ученика)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from tilhero_assessment.domain import rules
from tilhero_assessment.domain.common import (
    REEVALUATED,
    IdempotencyReused,
    audit_payload,
    emit_audit,
    emit_event,
    evaluation_not_found,
    iso_z,
    lock_session,
    lock_user,
)
from tilhero_assessment.domain.views import card, cards_for_chain, chain_of, order_chain, successor_of
from tilhero_assessment.models import Appeal, Evaluation, Flag
from tilhero_assessment.schemas import ReevaluationIn
from tilhero_common.errors import conflict, unprocessable
from tilhero_common.internal_auth import Actor

MAX_SUMMARY_SESSIONS = 100


async def _evaluation(session: AsyncSession, evaluation_id: uuid.UUID) -> Evaluation:
    ev = await session.get(Evaluation, evaluation_id)
    if ev is None:
        raise evaluation_not_found()
    return ev


async def _locked_evaluation(session: AsyncSession, evaluation_id: uuid.UUID) -> Evaluation:
    """Блокировки ученика и сессии (как у оценки и саги удаления), затем повторное чтение."""
    ev = await _evaluation(session, evaluation_id)
    await lock_user(session, ev.user_id)
    await lock_session(session, ev.session_id)
    session.expunge(ev)
    return await _evaluation(session, evaluation_id)


async def get_card(session: AsyncSession, evaluation_id: uuid.UUID) -> dict[str, Any]:
    return await card(session, await _evaluation(session, evaluation_id))


async def session_chain(session: AsyncSession, session_id: uuid.UUID) -> dict[str, Any]:
    return {"items": await cards_for_chain(session, await chain_of(session, session_id)), "next_cursor": None}


async def session_summaries(session: AsyncSession, session_ids: list[uuid.UUID]) -> dict[str, Any]:
    """Для журнала «Контроля диалогов» (флаги human_review / appealed / flagged, зачёт): актуальная запись цепочки."""
    rows = (await session.execute(select(Evaluation).where(Evaluation.session_id.in_(session_ids)))).scalars().all()
    flagged = set((await session.execute(
        select(Evaluation.session_id).join(Flag, Flag.evaluation_id == Evaluation.evaluation_id)
        .where(Evaluation.session_id.in_(session_ids))
    )).scalars().all())
    appeals = {a.session_id: a.status for a in (await session.execute(
        select(Appeal).where(Appeal.session_id.in_(session_ids)))).scalars().all()}
    by_session: dict[uuid.UUID, list[Evaluation]] = {}
    for r in rows:
        by_session.setdefault(r.session_id, []).append(r)
    items = []
    for sid in session_ids:
        if sid not in by_session:
            continue
        chain = order_chain(by_session[sid])
        latest = chain[-1]
        items.append({"session_id": sid, "evaluation_id": latest.evaluation_id, "status": latest.status,
                      "passed": latest.passed, "requires_human_review": latest.requires_human_review,
                      "reevaluated": len(chain) > 1, "flagged": sid in flagged, "appeal_status": appeals.get(sid)})
    return {"items": items}


# ---------------------------------------------------------------- флаг


async def flag(session: AsyncSession, *, actor: Actor, evaluation_id: uuid.UUID, reason: str, key: str | None,
               now: datetime) -> dict[str, Any]:
    ev = await _locked_evaluation(session, evaluation_id)
    staff = actor.id[:64]
    if key is not None:
        previous = (await session.execute(
            select(Flag).where(Flag.created_by == staff, Flag.idempotency_key == key)
        )).scalar_one_or_none()
        if previous is not None:
            if previous.evaluation_id != evaluation_id or previous.reason != reason:
                raise IdempotencyReused
            return await card(session, ev)
    f = Flag(flag_id=uuid.uuid4(), evaluation_id=ev.evaluation_id, user_id=ev.user_id, reason=reason,
             created_by=staff, idempotency_key=key, created_at=now)
    session.add(f)
    await session.flush()
    await emit_audit(session, audit_payload(actor, "qa.flagged", "evaluation", str(ev.evaluation_id),
                                            after={"flag_id": str(f.flag_id), "session_id": str(ev.session_id)},
                                            reason=reason))
    return await card(session, ev)


# ---------------------------------------------------------------- переоценка


def _invalid(code: str, message: str, **details: Any) -> Exception:
    return unprocessable(code, message, details or None)


def _new_scores(ev: Evaluation, rubric: rules.Rubric, body: ReevaluationIn) -> dict[str, int | None]:
    unknown = sorted(set(body.scores) - set(rubric.codes))
    if unknown:
        raise _invalid("SCORES_INVALID", "Критериев нет в рубрике оценки", unknown=unknown)
    if body.scores.get("pronunciation") is not None:
        raise _invalid("SCORES_INVALID", "Произношение по тексту не оценивается", criterion="pronunciation")
    # Partial<Record>: не переданный критерий сохраняет прежний балл, null — «не оценивался»
    given: dict[str, int | None] = {str(k): v for k, v in body.scores.items()}
    return {code: (given[code] if code in given else ev.scores.get(code)) for code in rubric.codes}


def _new_outcomes(ev: Evaluation, body: ReevaluationIn, passed: bool | None) -> list[dict[str, Any]]:
    requested = [o.model_dump() for o in body.skill_outcomes]
    original = {s["skill_id"]: s for s in ev.skill_outcomes}
    ids = [o["skill_id"] for o in requested]
    if len(set(ids)) != len(ids) or set(ids) != set(original):
        raise _invalid("SKILL_OUTCOMES_INVALID", "Исходы — по тем же навыкам, что и в оценке",
                       expected=sorted(original))
    if passed is not True and any(o["outcome"] == "demonstrated" for o in requested):
        raise _invalid("SKILL_OUTCOMES_INVALID", "«Демонстрирует» — только при зачтённой рубрике",
                       reason="rubric_not_passed")
    for o in requested:
        if o["outcome"] != "not_assessed" and not original[o["skill_id"]]["evidence_refs"]:
            raise _invalid("SKILL_OUTCOMES_INVALID", "У навыка нет заданий в этой оценке", skill_id=o["skill_id"])
    return [{**o, "evidence_refs": original[o["skill_id"]]["evidence_refs"]} for o in requested]


def _new_errors(ev: Evaluation, body: ReevaluationIn) -> list[dict[str, Any]]:
    allowed = {i["item_id"] for i in ev.items} | {t["turn_id"] for t in ev.turns if t.get("mode") == "text"}
    errors = [e.model_dump() for e in body.confirmed_errors]
    bad = sorted({e["turn_id"] for e in errors} - allowed)
    if bad:
        raise _invalid("ERRORS_INVALID", "Ошибка должна ссылаться на текст ученика или задание оценки", turn_ids=bad)
    return rules.rank_errors(errors)


async def reevaluate(session: AsyncSession, *, actor: Actor, evaluation_id: uuid.UUID, body: ReevaluationIn,
                     key: str | None, now: datetime) -> tuple[dict[str, Any], bool]:
    """Новая запись supersedes = evaluation_id (исходная неизменна) + assessment.reevaluated.v1 + аудит."""
    ev = await _locked_evaluation(session, evaluation_id)
    staff = actor.id[:64]
    if key is not None:
        previous = (await session.execute(
            select(Evaluation).where(Evaluation.created_by == staff, Evaluation.idempotency_key == key)
        )).scalar_one_or_none()
        if previous is not None:
            if previous.supersedes != evaluation_id:
                raise IdempotencyReused
            return await card(session, previous), False
    if staff == str(ev.user_id):
        raise conflict("SELF_REEVALUATION", "Нельзя переоценивать собственную оценку")
    successor = await successor_of(session, evaluation_id)
    if successor is not None:
        raise conflict("EVALUATION_SUPERSEDED", "Оценка уже заменена переоценкой — переоценивается актуальная",
                       {"superseded_by": str(successor)})
    if body.appeal_id is not None:
        # апелляция — по цепочке оценки этой сессии (QA мог переоценить запись, пока апелляция ждала разбора)
        appeal = await session.get(Appeal, body.appeal_id)
        if appeal is None or appeal.session_id != ev.session_id:
            raise _invalid("APPEAL_MISMATCH", "Апелляция подана не на эту оценку")
        if appeal.status not in ("new", "in_review"):
            raise conflict("APPEAL_DECIDED", "По апелляции уже принято решение", {"status": appeal.status})
    rubric = rules.rubric_from_snapshot(ev.rubric_id, ev.rubric_version, ev.rubric)
    scores = _new_scores(ev, rubric, body)
    weighted, passed, evaluated = rules.verdict(rubric, scores)
    status = "ok" if evaluated >= 2 else "insufficient_evidence"
    if ev.practice_only:
        if body.skill_outcomes:
            raise _invalid("SKILL_OUTCOMES_INVALID", "Тренировка без влияния на освоение — без исходов навыков")
        outcomes: list[dict[str, Any]] = []
    else:
        outcomes = _new_outcomes(ev, body, passed)
    new = Evaluation(
        evaluation_id=uuid.uuid4(), session_id=ev.session_id, user_id=ev.user_id, kind=ev.kind, pair_id=ev.pair_id,
        audience=ev.audience, content_refs=ev.content_refs, rubric_id=ev.rubric_id, rubric_version=ev.rubric_version,
        rubric=ev.rubric, status=status, scores=scores, weighted=weighted, passed=passed,
        task_completed=ev.task_completed, outcome=ev.outcome, confirmed_errors=_new_errors(ev, body), items=ev.items,
        turns=ev.turns, skill_outcomes=outcomes, practice_only=ev.practice_only, support_used=ev.support_used,
        evaluator=None, ai_status="not_used", ai_reason=None, requires_human_review=False, supersedes=ev.evaluation_id,
        appeal_id=body.appeal_id, created_by=staff, reason=body.reason, idempotency_key=key, created_at=now)
    session.add(new)
    await session.flush()
    public = [{"skill_id": o["skill_id"], "outcome": o["outcome"]} for o in outcomes]
    await emit_event(session, REEVALUATED, {
        "evaluation_id": str(new.evaluation_id), "supersedes": str(ev.evaluation_id),
        # сессия — та же, что у заменённой оценки (learning-plan сопоставляет переоценку с пройденным уроком)
        "session_id": str(ev.session_id), "user_id": str(ev.user_id),
        "pair_id": ev.pair_id, "skill_outcomes": public, "passed": passed,
        "appeal_id": str(body.appeal_id) if body.appeal_id else None, "created_at": iso_z(now)})
    await emit_audit(session, audit_payload(
        actor, "qa.reevaluated", "evaluation", str(ev.evaluation_id),
        before={"evaluation_id": str(ev.evaluation_id), "status": ev.status, "scores": ev.scores,
                "passed": ev.passed},
        after={"evaluation_id": str(new.evaluation_id), "status": status, "scores": scores, "passed": passed,
               "skill_outcomes": public,
               "appeal_id": str(body.appeal_id) if body.appeal_id else None},
        reason=body.reason))
    return await card(session, new), True


# ---------------------------------------------------------------- статистика


async def stats(session: AsyncSession, *, period: str, since: datetime) -> dict[str, Any]:
    root = (Evaluation.supersedes.is_(None), Evaluation.practice_only.is_(False), Evaluation.created_at >= since)

    async def count(*where: Any, model: Any = Evaluation) -> int:
        return int((await session.execute(select(func.count()).select_from(model).where(*where))).scalar_one())

    successor = aliased(Evaluation)
    human_review_open = await count(
        Evaluation.requires_human_review.is_(True),
        ~exists().where(successor.supersedes == Evaluation.evaluation_id))
    return {
        "period": period,
        "evaluations": await count(*root),
        "passed": await count(*root, Evaluation.passed.is_(True)),
        "insufficient_evidence": await count(*root, Evaluation.status == "insufficient_evidence"),
        "partial": await count(*root, Evaluation.status.in_(("partial", "pending_review"))),
        "reevaluations": await count(Evaluation.supersedes.is_not(None), Evaluation.created_at >= since),
        "appeals_new": await count(Appeal.created_at >= since, model=Appeal),
        "appeals_open": await count(Appeal.status.in_(("new", "in_review")), model=Appeal),
        "human_review_open": human_review_open,
    }
