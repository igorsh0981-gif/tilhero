"""Карта навыков ученика по паре (INTERNAL_API §2.4, AT-35).

Состояние меняется только механизмом оценки (диагностика; со спринта 4 — ещё оценки уроков, `lesson_outcomes.py`):
на каждый результат диагностики (ревизию) и навык —
одно свидетельство (positive | negative) с полосой; переход — engine.transition. История свидетельств не меняется
и не удаляется (кроме саги удаления ученика). Изменения — событие skills.state.changed.v1.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import emit
from tilhero_diagnostics import engine
from tilhero_diagnostics.models import SkillEvidence, SkillState
from tilhero_diagnostics.testdef import BANDS, TestDef

SKILLS_CHANGED = "skills.state.changed.v1"
PRODUCER = "diagnostics"
MAX_CHANGES_PER_EVENT = 500
HISTORY_LIMIT = 5


def course_index(snapshot: Mapping[str, Any] | None) -> tuple[dict[str, set[str]] | None, set[str] | None]:
    """tag → навыки курса (diagnostic_tags) и множество навыков курса; без снимка — (None, None)."""
    if snapshot is None:
        return None, None
    tags: dict[str, set[str]] = {}
    skills: set[str] = set()
    for s in snapshot.get("skills", []):
        if not isinstance(s, Mapping) or not isinstance(s.get("skill_id"), str):
            continue
        skills.add(s["skill_id"])
        for tag in s.get("diagnostic_tags") or []:
            tags.setdefault(str(tag), set()).add(s["skill_id"])
    return tags, skills


async def states_of(session: AsyncSession, user_id: uuid.UUID, pair_id: str) -> dict[str, SkillState]:
    rows = (await session.execute(
        select(SkillState).where(SkillState.user_id == user_id, SkillState.pair_id == pair_id)
    )).scalars().all()
    return {r.skill_id: r for r in rows}


async def _last_outcomes(session: AsyncSession, user_id: uuid.UUID, pair_id: str,
                         skill_ids: Sequence[str]) -> dict[str, str]:
    if not skill_ids:
        return {}
    ranked = (
        select(SkillEvidence.skill_id, SkillEvidence.outcome,
               func.row_number().over(partition_by=SkillEvidence.skill_id,
                                      order_by=(SkillEvidence.created_at.desc(), SkillEvidence.id.desc()))
               .label("rn"))
        .where(SkillEvidence.user_id == user_id, SkillEvidence.pair_id == pair_id,
               SkillEvidence.skill_id.in_(list(skill_ids)))
        .subquery()
    )
    rows = (await session.execute(select(ranked.c.skill_id, ranked.c.outcome).where(ranked.c.rn == 1))).all()
    return {r.skill_id: r.outcome for r in rows}


async def apply_diagnostic(
    session: AsyncSession, *, user_id: uuid.UUID, pair_id: str, result_id: uuid.UUID, test: TestDef,
    answers: Sequence[engine.Answered], snapshot: Mapping[str, Any] | None, now: datetime,
) -> dict[str, str]:
    """Свидетельства по ответам `answers` (новые данные этой ревизии) → переходы состояний → событие.
    Возвращает состояния всех навыков ученика по паре после применения (для рекомендации старта)."""
    tag_index, course_skills = course_index(snapshot)
    skills_of: dict[str, set[str]] = {}
    for a in answers:
        item = test.item(a.item_id)
        if item is not None:
            skills_of[a.item_id] = engine.item_skills(item, tag_index, course_skills)
    outcomes = engine.skill_outcomes(answers, skills_of)
    current = await states_of(session, user_id, pair_id)
    previous = await _last_outcomes(session, user_id, pair_id, [o.skill_id for o in outcomes])
    changes: list[dict[str, Any]] = []
    for o in outcomes:
        evidence_id = uuid.uuid4()
        session.add(SkillEvidence(id=evidence_id, user_id=user_id, pair_id=pair_id, skill_id=o.skill_id,
                                  source="diagnostic", ref_id=str(result_id), outcome=o.outcome, band=o.band,
                                  created_at=now))
        row = current.get(o.skill_id)
        before = row.state if row is not None else "not_started"
        after = engine.transition(before, o.outcome, previous.get(o.skill_id))
        # понижение заблокировано (одно отрицательное свидетельство подряд) — состояние и уверенность прежние
        supported = (o.outcome == "positive") == (after in ("demonstrated", "retained"))
        if row is None:
            row = SkillState(user_id=user_id, pair_id=pair_id, skill_id=o.skill_id, state=after,
                             confidence=o.confidence, updated_at=now, source="diagnostic", state_ref=str(result_id))
            session.add(row)
            current[o.skill_id] = row
        elif supported:
            if after != row.state:
                row.state_ref = str(result_id)  # свидетельство, установившее новое состояние (спринт 4)
            row.state, row.confidence, row.updated_at, row.source = after, o.confidence, now, "diagnostic"
        if after != before:
            changes.append({"skill_id": o.skill_id, "from": before, "to": after, "source": "diagnostic",
                            "evidence_id": str(evidence_id)})
    await session.flush()
    for start in range(0, len(changes), MAX_CHANGES_PER_EVENT):
        await emit(session, SKILLS_CHANGED, {
            "user_id": str(user_id), "pair_id": pair_id, "changes": changes[start:start + MAX_CHANGES_PER_EVENT],
            "occurred_at": now.isoformat().replace("+00:00", "Z"),
        }, producer=PRODUCER)
    return {skill_id: row.state for skill_id, row in current.items()}


async def skill_map(session: AsyncSession, user_id: uuid.UUID, pair_id: str, course_id: str,
                    snapshot: Mapping[str, Any] | None) -> dict[str, Any]:
    """SkillMap: навыки курса из снимка (порядок снимка) + навыки с состоянием вне снимка; последние 5 свидетельств."""
    states = await states_of(session, user_id, pair_id)
    ranked = (
        select(SkillEvidence.skill_id, SkillEvidence.source, SkillEvidence.outcome, SkillEvidence.created_at,
               func.row_number().over(partition_by=SkillEvidence.skill_id,
                                      order_by=(SkillEvidence.created_at.desc(), SkillEvidence.id.desc()))
               .label("rn"))
        .where(SkillEvidence.user_id == user_id, SkillEvidence.pair_id == pair_id)
        .subquery()
    )
    history: dict[str, list[dict[str, Any]]] = {}
    for r in (await session.execute(
            select(ranked).where(ranked.c.rn <= HISTORY_LIMIT).order_by(ranked.c.skill_id, ranked.c.rn))).all():
        history.setdefault(r.skill_id, []).append({"source": r.source, "outcome": r.outcome, "at": r.created_at})

    def entry(skill_id: str, meta: Mapping[str, Any] | None) -> dict[str, Any]:
        row = states.get(skill_id)
        title = meta.get("title") if meta else None
        level = meta.get("level") if meta else None
        return {
            "skill_id": skill_id,
            "area": meta.get("area") if meta else None,
            "title": title if isinstance(title, Mapping) and {"ru", "uz"} <= set(title) else None,
            "level": level if level in BANDS else None,
            "state": row.state if row else "not_started",
            "confidence": row.confidence if row else None,
            "prerequisites": [str(p) for p in (meta.get("prerequisites") or [])] if meta else [],
            "updated_at": row.updated_at if row else None,
            "history": history.get(skill_id, []),
        }

    skills: list[dict[str, Any]] = []
    listed: set[str] = set()
    for meta in (snapshot or {}).get("skills", []):
        if isinstance(meta, Mapping) and isinstance(meta.get("skill_id"), str) and meta["skill_id"] not in listed:
            skills.append(entry(meta["skill_id"], meta))
            listed.add(meta["skill_id"])
    for skill_id in sorted(set(states) - listed):
        skills.append(entry(skill_id, None))
    counts = {s: 0 for s in ("not_started", "learning", "demonstrated", "retained")}
    for s in skills:
        counts[s["state"]] += 1
    return {"pair_id": pair_id, "course_id": course_id, "counts": counts, "skills": skills}
