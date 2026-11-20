"""Проверки удержания (спринт 5, INTERNAL_API §1.5, §6, AT-56).

Проверки ставит и проводит memory; результат приходит событием `memory.retention.checked.v1` (издатель — только
memory). diagnostics — владелец карты навыков — меняет состояние:
- `stage d30, passed` и навык `demonstrated` → `retained` («закреплён»);
- `consecutive_failures ≥ 2` и навык `demonstrated` → `learning`;
- иначе (d7, первый провал, навык уже не `demonstrated`) — состояние без изменений.

Свидетельство: результат проверки навыка в состоянии `demonstrated` (цепочка проверок действующая) записывается в
историю карты (`skill_evidence`, source `retention`, ref_id = check_id, positive | negative, время — `checked_at`).
Навык не в `demonstrated` — проверка устарела (memory отменяет цепочку при уходе из demonstrated, событие могло
обогнать отмену): ни свидетельства, ни перехода.

Идемпотентно: повторная публикация того же check_id (новый event_id) — без изменений (свидетельство с этим ref_id
уже есть). Переход → `skills.state.changed.v1` (source `retention`, evidence_id = check_id). XP и игровые механики
проверки не затрагивают (их здесь нет).
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import emit
from tilhero_diagnostics.domain.lesson_outcomes import MAX_PAIR_LEN, MAX_SKILL_LEN
from tilhero_diagnostics.domain.skills import PRODUCER, SKILLS_CHANGED
from tilhero_diagnostics.domain.users import lock_user
from tilhero_diagnostics.models import DeletedUser, SkillEvidence, SkillState

log = logging.getLogger("tilhero.diagnostics.retention")

SOURCE: Final = "retention"
DEMOTE_AFTER_FAILURES: Final = 2


@dataclass(frozen=True)
class RetentionCheck:
    check_id: uuid.UUID
    user_id: uuid.UUID
    pair_id: str
    skill_id: str
    stage: Literal["d7", "d30"]
    passed: bool
    consecutive_failures: int
    checked_at: datetime


def retention_transition(current: str, stage: str, passed: bool, consecutive_failures: int) -> str:
    """Переход по результату проверки: только из demonstrated; d30 пройдена → retained; два провала подряд →
    learning; иначе без изменений."""
    if current != "demonstrated":
        return current
    if passed and stage == "d30":
        return "retained"
    if not passed and consecutive_failures >= DEMOTE_AFTER_FAILURES:
        return "learning"
    return current


async def apply_check(session: AsyncSession, chk: RetentionCheck) -> dict[str, Any] | None:
    """Результат проверки → свидетельство и переход → skills.state.changed.v1. Возвращает изменение или None."""
    await lock_user(session, chk.user_id)  # та же блокировка, что у диагностики, оценок уроков и саги удаления
    if await session.get(DeletedUser, chk.user_id) is not None:
        return None
    if len(chk.pair_id) > MAX_PAIR_LEN or len(chk.skill_id) > MAX_SKILL_LEN:
        log.warning("retention check with too long pair_id or skill_id ignored")
        return None
    ref = str(chk.check_id)
    seen = (await session.execute(
        select(SkillEvidence.id).where(SkillEvidence.user_id == chk.user_id, SkillEvidence.pair_id == chk.pair_id,
                                       SkillEvidence.skill_id == chk.skill_id, SkillEvidence.source == SOURCE,
                                       SkillEvidence.ref_id == ref).limit(1)
    )).scalar_one_or_none()
    if seen is not None:
        return None  # повтор результата той же проверки
    row = (await session.execute(
        select(SkillState).where(SkillState.user_id == chk.user_id, SkillState.pair_id == chk.pair_id,
                                 SkillState.skill_id == chk.skill_id).with_for_update()
    )).scalar_one_or_none()
    before = row.state if row is not None else "not_started"
    if row is None or before != "demonstrated":
        log.info("retention check for a skill not in demonstrated ignored", extra={"state": before})
        return None
    session.add(SkillEvidence(id=uuid.uuid4(), user_id=chk.user_id, pair_id=chk.pair_id, skill_id=chk.skill_id,
                              source=SOURCE, ref_id=ref, outcome="positive" if chk.passed else "negative", band=None,
                              created_at=chk.checked_at))
    after = retention_transition(before, chk.stage, chk.passed, chk.consecutive_failures)
    if after == before:
        await session.flush()
        return None
    now = datetime.now(UTC)
    row.state, row.confidence, row.updated_at, row.source, row.state_ref = after, None, now, SOURCE, ref
    await session.flush()
    change = {"skill_id": chk.skill_id, "from": before, "to": after, "source": SOURCE, "evidence_id": ref}
    await emit(session, SKILLS_CHANGED, {
        "user_id": str(chk.user_id), "pair_id": chk.pair_id, "changes": [change],
        "occurred_at": now.isoformat().replace("+00:00", "Z"),
    }, producer=PRODUCER)
    return change
