"""Цепочки оценок и формы вывода: EvaluationView (ученик, lessons), EvaluationCard и AdminAppeal (админка)."""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_assessment.domain.rules import key_errors
from tilhero_assessment.models import Appeal, Evaluation, Flag


def order_chain(rows: Sequence[Evaluation]) -> list[Evaluation]:
    """Исходная (supersedes IS NULL) → переоценки по ссылкам supersedes; цепочка линейна (UNIQUE supersedes)."""
    by_parent = {r.supersedes: r for r in rows if r.supersedes is not None}
    root = next((r for r in rows if r.supersedes is None), None)
    out: list[Evaluation] = []
    current = root
    while current is not None and len(out) < len(rows):
        out.append(current)
        current = by_parent.get(current.evaluation_id)
    return out


async def chain_of(session: AsyncSession, session_id: uuid.UUID) -> list[Evaluation]:
    rows = (await session.execute(select(Evaluation).where(Evaluation.session_id == session_id))).scalars().all()
    return order_chain(rows)


async def successor_of(session: AsyncSession, evaluation_id: uuid.UUID) -> uuid.UUID | None:
    return (await session.execute(
        select(Evaluation.evaluation_id).where(Evaluation.supersedes == evaluation_id)
    )).scalar_one_or_none()


async def appeal_of_session(session: AsyncSession, session_id: uuid.UUID) -> Appeal | None:
    return (await session.execute(select(Appeal).where(Appeal.session_id == session_id))).scalar_one_or_none()


# ---------------------------------------------------------------- ученик


def appeal_view(a: Appeal) -> dict[str, Any]:
    """Appeal (bff.ts). reason — null, если текст стёрт по сроку хранения (90 дней после решения, ревью R1-14)."""
    return {"appeal_id": a.appeal_id, "evaluation_id": a.evaluation_id, "status": a.status, "reason": a.reason,
            "decision_note": a.decision_note, "new_evaluation_id": a.new_evaluation_id, "created_at": a.created_at,
            "decided_at": a.decided_at}


def evaluation_view(ev: Evaluation, *, requested_id: uuid.UUID | None = None,
                    appeal: Appeal | None = None) -> dict[str, Any]:
    """EvaluationView актуальной записи цепочки. superseded_by — id показанной актуальной записи, если запрошенная
    была заменена переоценкой (иначе null). Верный ответ — только для заданий, где ученик ошибся."""
    titles = {c["code"]: c["title"] for c in ev.rubric["criteria"]}
    evaluator = None
    if ev.evaluator:
        evaluator = {"model_id": ev.evaluator["model_id"], "prompt_version": ev.evaluator["prompt_version"]}
    return {
        "evaluation_id": ev.evaluation_id,
        "status": ev.status,
        "passed": ev.passed,
        "task_completed": ev.task_completed,
        "scores": [{"code": c["code"], "title": titles[c["code"]], "score": ev.scores.get(c["code"])}
                   for c in ev.rubric["criteria"]],
        "key_errors": key_errors(ev.confirmed_errors),
        "items": [{"item_id": i["item_id"], "prompt_en": i["prompt_en"], "your_answer": i["your_answer"],
                   "correct": i["correct"], "hinted": i["hinted"],
                   "correct_answer": None if i["correct"] else i["correct_answer"]} for i in ev.items],
        "practice_only": ev.practice_only,
        "rubric_version": f"{ev.rubric_id}@{ev.rubric_version}",
        "evaluator": evaluator,
        "superseded_by": ev.evaluation_id if requested_id is not None and requested_id != ev.evaluation_id else None,
        "appeal": appeal_view(appeal) if appeal is not None else None,
        "created_at": ev.created_at,
    }


def public_outcomes(ev: Evaluation) -> list[dict[str, str]]:
    return [{"skill_id": s["skill_id"], "outcome": s["outcome"]} for s in ev.skill_outcomes]


def evaluation_result(ev: Evaluation, *, appeal: Appeal | None = None) -> dict[str, Any]:
    """Ответ lessons: EvaluationView + session_id, skill_outcomes, requires_human_review."""
    return {**evaluation_view(ev, appeal=appeal), "session_id": ev.session_id, "skill_outcomes": public_outcomes(ev),
            "requires_human_review": ev.requires_human_review}


# ---------------------------------------------------------------- админка


def admin_appeal(a: Appeal) -> dict[str, Any]:
    """AdminAppeal: reason_redacted — текст ученика стёрт по сроку хранения (reason = null), сотрудник видит пометку."""
    return {"appeal_id": a.appeal_id, "evaluation_id": a.evaluation_id, "session_id": a.session_id,
            "status": a.status, "reason": a.reason, "reason_redacted": a.reason_redacted_at is not None,
            "decision_note": a.decision_note, "taken_by": a.taken_by,
            "decided_by": a.decided_by, "new_evaluation_id": a.new_evaluation_id, "created_at": a.created_at,
            "taken_at": a.taken_at, "decided_at": a.decided_at}


def evaluation_card(ev: Evaluation, *, successor: uuid.UUID | None, flags: Sequence[Flag],
                    appeal: Appeal | None) -> dict[str, Any]:
    """EvaluationCard (admin.ts) без текста реплик и ответов ученика; сотрудники — id (имена — admin-bff)."""
    return {
        "evaluation_id": ev.evaluation_id,
        "session_id": ev.session_id,
        "kind": ev.kind,
        "status": ev.status,
        "rubric": {"rubric_id": ev.rubric_id, "version": ev.rubric_version},
        "scores": [{"code": c["code"], "score": ev.scores.get(c["code"])} for c in ev.rubric["criteria"]],
        "weighted": ev.weighted,
        "passed": ev.passed,
        "task_completed": ev.task_completed,
        "outcome": ev.outcome,
        "confirmed_errors": ev.confirmed_errors,
        "items": [{"item_id": i["item_id"], "skill_id": i["skill_id"], "correct": i["correct"], "hinted": i["hinted"]}
                  for i in ev.items],
        "skill_outcomes": public_outcomes(ev),
        "evaluator": ev.evaluator,
        "ai_status": ev.ai_status,
        "requires_human_review": ev.requires_human_review,
        "practice_only": ev.practice_only,
        "supersedes": ev.supersedes,
        "superseded_by": successor,
        "created_by": ev.created_by,
        "reason": ev.reason,
        "appeal_id": ev.appeal_id,
        "flags": [{"reason": f.reason, "by": f.created_by, "at": f.created_at}
                  for f in sorted(flags, key=lambda f: (f.created_at, str(f.flag_id)))],
        "appeal": admin_appeal(appeal) if appeal is not None else None,
        "created_at": ev.created_at,
    }


async def cards_for_chain(session: AsyncSession, chain: Sequence[Evaluation]) -> list[dict[str, Any]]:
    if not chain:
        return []
    ids = [e.evaluation_id for e in chain]
    flags = (await session.execute(select(Flag).where(Flag.evaluation_id.in_(ids)))).scalars().all()
    appeal = await appeal_of_session(session, chain[0].session_id)
    successors = {e.supersedes: e.evaluation_id for e in chain if e.supersedes is not None}
    return [evaluation_card(e, successor=successors.get(e.evaluation_id),
                            flags=[f for f in flags if f.evaluation_id == e.evaluation_id], appeal=appeal)
            for e in chain]


async def card(session: AsyncSession, ev: Evaluation) -> dict[str, Any]:
    chain = await chain_of(session, ev.session_id)
    cards = await cards_for_chain(session, chain)
    return next(c for c in cards if c["evaluation_id"] == ev.evaluation_id)
