"""Навыки по оценкам уроков (INTERNAL_API спринта 4 §5, AT-46, AT-47).

Владелец карты навыков — diagnostics; оценки приходят событиями assessment (издатель — только assessment):
`assessment.completed.v1` и `assessment.reevaluated.v1` (а также completed с `supersedes` — тоже переоценка).

Переходы по `skill_outcomes` оценки:
- `learning`: not_started | learning → learning; demonstrated — без изменений (кроме переоценки, ниже);
- `demonstrated`: not_started | learning → demonstrated; demonstrated — без изменений;
- `not_assessed` — без изменений и без свидетельства; `retained` (спринт 5) не трогается никогда;
- `practice_only` (повтор ошибок, практика без освоения) — без изменений и свидетельств.
На каждый оценённый навык — свидетельство `skill_evidence` (source `lesson`, ref_id = evaluation_id, positive для
demonstrated / negative для learning, время — `created_at` оценки): история подтверждений карты навыков.

Переоценка (`supersedes` = заменённая оценка): навык, чья демонстрация держалась только на заменённой оценке
(состояние demonstrated установлено свидетельством заменённой оценки цепочки — `state_ref`, и после него нет
положительных свидетельств других, не заменённых оценок или диагностики), возвращается в learning, если новая оценка
его не демонстрирует. Остальное — как у обычной оценки.

Идемпотентно: полученная оценка записывается в `lesson_evaluations`; повтор (новый event_id) — без изменений.
Оценка, уже заменённая пришедшей раньше переоценкой (события не по порядку), записывается, но не применяется.
Событие `skills.state.changed.v1` (source `lesson`, evidence_id = evaluation_id) — только при реальных изменениях.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import emit
from tilhero_diagnostics.domain.skills import MAX_CHANGES_PER_EVENT, PRODUCER, SKILLS_CHANGED
from tilhero_diagnostics.domain.users import lock_user
from tilhero_diagnostics.models import DeletedUser, LessonEvaluation, SkillEvidence, SkillState

log = logging.getLogger("tilhero.diagnostics.lessons")

MAX_PAIR_LEN: Final = 16  # skill_states.pair_id
MAX_SKILL_LEN: Final = 64  # skill_states.skill_id
EVIDENCE: Final = {"demonstrated": "positive", "learning": "negative"}


@dataclass(frozen=True)
class Evaluation:
    evaluation_id: uuid.UUID
    user_id: uuid.UUID
    pair_id: str
    session_id: uuid.UUID | None
    supersedes: uuid.UUID | None
    practice_only: bool
    outcomes: Sequence[tuple[str, str]]  # (skill_id, demonstrated | learning | not_assessed)
    created_at: datetime


def lesson_transition(current: str, outcome: str) -> str:
    """Переход по исходу оценки урока (без переоценки): только вверх или без изменений; retained не трогается."""
    if current == "retained" or outcome == "not_assessed":
        return current
    if outcome == "demonstrated":
        return "demonstrated"
    return current if current == "demonstrated" else "learning"


async def _superseded_ids(session: AsyncSession, user_id: uuid.UUID) -> set[str]:
    rows = (await session.execute(
        select(LessonEvaluation.supersedes).where(LessonEvaluation.user_id == user_id,
                                                  LessonEvaluation.supersedes.is_not(None))
    )).scalars().all()
    return {str(r) for r in rows}


async def _evidence(session: AsyncSession, user_id: uuid.UUID, pair_id: str,
                    skill_ids: Sequence[str]) -> dict[str, list[SkillEvidence]]:
    if not skill_ids:
        return {}
    rows = (await session.execute(
        select(SkillEvidence).where(SkillEvidence.user_id == user_id, SkillEvidence.pair_id == pair_id,
                                    SkillEvidence.skill_id.in_(list(skill_ids)))
    )).scalars().all()
    out: dict[str, list[SkillEvidence]] = {}
    for r in rows:
        out.setdefault(r.skill_id, []).append(r)
    return out


def _held_only_by_superseded(row: SkillState, evidence: Sequence[SkillEvidence], superseded: set[str]) -> bool:
    """Демонстрация установлена свидетельством заменённой оценки и после него нет положительных свидетельств
    действующих оценок или диагностики."""
    if row.state != "demonstrated" or row.state_ref is None or row.state_ref not in superseded:
        return False
    since = [e.created_at for e in evidence if e.ref_id == row.state_ref and e.outcome == "positive"]
    if not since:
        return True
    start = min(since)
    return not any(e.outcome == "positive" and e.ref_id not in superseded and e.created_at >= start
                   for e in evidence)


async def apply_evaluation(session: AsyncSession, ev: Evaluation) -> list[dict[str, Any]]:
    """Оценка → свидетельства и переходы навыков → skills.state.changed.v1 (если есть изменения). Возвращает
    изменения (from, to, source, evidence_id)."""
    await lock_user(session, ev.user_id)  # та же блокировка, что у диагностики и саги удаления
    if await session.get(DeletedUser, ev.user_id) is not None:
        return []
    if len(ev.pair_id) > MAX_PAIR_LEN:
        log.warning("evaluation with too long pair_id ignored")
        return []
    if await session.get(LessonEvaluation, ev.evaluation_id) is not None:
        return []  # повтор оценки (повторная публикация) — без изменений
    outcomes: dict[str, str] = {}
    for skill_id, outcome in ev.outcomes:
        if len(skill_id) <= MAX_SKILL_LEN:
            outcomes[skill_id] = outcome
    replaced = await session.get(LessonEvaluation, ev.supersedes) if ev.supersedes is not None else None
    if replaced is not None and replaced.user_id != ev.user_id:
        log.warning("superseded evaluation of another learner ignored")
        replaced = None  # изоляция учеников: чужая оценка не влияет
    practice_only = ev.practice_only or (replaced is not None and replaced.practice_only)
    already_replaced = (await session.execute(
        select(LessonEvaluation.evaluation_id).where(LessonEvaluation.user_id == ev.user_id,
                                                     LessonEvaluation.supersedes == ev.evaluation_id).limit(1)
    )).scalar_one_or_none() is not None
    session.add(LessonEvaluation(
        evaluation_id=ev.evaluation_id, user_id=ev.user_id, pair_id=ev.pair_id, session_id=ev.session_id,
        supersedes=ev.supersedes, practice_only=practice_only,
        outcomes=[{"skill_id": s, "outcome": o} for s, o in outcomes.items()], created_at=ev.created_at,
    ))
    await session.flush()
    if practice_only or already_replaced:
        return []

    ref = str(ev.evaluation_id)
    candidates = set(outcomes)
    superseded: set[str] = set()
    if ev.supersedes is not None:
        superseded = await _superseded_ids(session, ev.user_id)  # вместе с только что записанной заменой
        if replaced is not None:
            candidates |= {str(o.get("skill_id")) for o in replaced.outcomes if isinstance(o, dict)}
        candidates |= set((await session.execute(
            select(SkillState.skill_id).where(SkillState.user_id == ev.user_id, SkillState.pair_id == ev.pair_id,
                                              SkillState.state_ref == str(ev.supersedes))
        )).scalars().all())
    rows = {r.skill_id: r for r in (await session.execute(
        select(SkillState).where(SkillState.user_id == ev.user_id, SkillState.pair_id == ev.pair_id,
                                 SkillState.skill_id.in_(sorted(candidates)))
    )).scalars().all()} if candidates else {}
    evidence = await _evidence(session, ev.user_id, ev.pair_id, sorted(candidates)) if superseded else {}

    now = datetime.now(UTC)
    changes: list[dict[str, Any]] = []
    for skill_id in sorted(candidates):
        outcome = outcomes.get(skill_id, "not_assessed")
        if outcome in EVIDENCE:
            session.add(SkillEvidence(id=uuid.uuid4(), user_id=ev.user_id, pair_id=ev.pair_id, skill_id=skill_id,
                                      source="lesson", ref_id=ref, outcome=EVIDENCE[outcome], band=None,
                                      created_at=ev.created_at))
        row = rows.get(skill_id)
        before = row.state if row is not None else "not_started"
        after = lesson_transition(before, outcome)
        if (superseded and outcome != "demonstrated" and row is not None
                and _held_only_by_superseded(row, evidence.get(skill_id, []), superseded)):
            after = "learning"  # демонстрация держалась только на заменённой оценке
        if after == before:
            continue
        if row is None:
            session.add(SkillState(user_id=ev.user_id, pair_id=ev.pair_id, skill_id=skill_id, state=after,
                                   confidence=None, updated_at=now, source="lesson", state_ref=ref))
        else:
            row.state, row.confidence, row.updated_at, row.source, row.state_ref = after, None, now, "lesson", ref
        changes.append({"skill_id": skill_id, "from": before, "to": after, "source": "lesson", "evidence_id": ref})
    await session.flush()
    for start in range(0, len(changes), MAX_CHANGES_PER_EVENT):
        await emit(session, SKILLS_CHANGED, {
            "user_id": str(ev.user_id), "pair_id": ev.pair_id, "changes": changes[start:start + MAX_CHANGES_PER_EVENT],
            "occurred_at": now.isoformat().replace("+00:00", "Z"),
        }, producer=PRODUCER)
    return changes
