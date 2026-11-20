"""Потребители событий diagnostics (inbox-дедупликация в Runtime.add_consumer).

- identity-consent: сага удаления, проекция профиля (возраст);
- спринт 4 — assessment: `assessment.completed.v1`, `assessment.reevaluated.v1` → карта навыков по оценкам уроков
  (`domain/lesson_outcomes.py`);
- спринт 5 — memory: `memory.retention.checked.v1` → retained / learning по проверкам удержания
  (`domain/retention.py`). Чужой издатель — предупреждение в логе (тип события и издатель, без user_id),
  событие подтверждается шине без действия; payload не по контракту — исключение → DLQ.
"""

from __future__ import annotations

import logging
import uuid
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_diagnostics.domain import lesson_outcomes, retention, users

DELETION_REQUESTED = "user.deletion.requested.v1"
PROFILE_CREATED = "user.profile.created.v1"
PROFILE_UPDATED = "user.profile.updated.v1"
ASSESSMENT_COMPLETED = "assessment.completed.v1"
ASSESSMENT_REEVALUATED = "assessment.reevaluated.v1"
RETENTION_CHECKED = "memory.retention.checked.v1"
# Сагу удаления и профили ведёт только identity-consent: события других издателей не исполняются (P-7)
TRUSTED_PRODUCERS = frozenset({"identity-consent"})
# Оценки уроков — только assessment (независимый оценщик; генерирующие агенты и lessons навыки не меняют)
ASSESSMENT_PRODUCERS = frozenset({"assessment"})
# Спринт 5: проверки удержания проводит только memory
MEMORY_PRODUCERS = frozenset({"memory"})
# Практика без освоения: повтор ошибок (review) и вопросы к тексту (reading) навыки не меняют
PRACTICE_KINDS = frozenset({"review", "reading"})

log = logging.getLogger("tilhero.diagnostics.consumers")


def _trusted(env: Envelope, producers: frozenset[str] = TRUSTED_PRODUCERS) -> bool:
    if env.producer in producers:
        return True
    log.warning("event from unexpected producer ignored",
                extra={"event_type": env.event_type, "producer": env.producer[:64]})
    return False


async def on_deletion_requested(session: AsyncSession, env: Envelope) -> None:
    """Сага удаления (TG-FR-006): сессии, ответы, результаты, состояния и свидетельства навыков удаляются
    физически → ACK user.domain.deleted.v1 (domain=diagnostics). Повтор саги снова подтверждается."""
    if not _trusted(env):
        return
    await users.delete_user_data(session, uuid.UUID(str(env.payload["user_id"])),
                                 uuid.UUID(str(env.payload["request_id"])), causation_id=env.event_id)


async def on_profile_event(session: AsyncSession, env: Envelope) -> None:
    """Проекция вида профиля и возрастной полосы (детский тест — защита в глубину)."""
    if not _trusted(env):
        return
    await users.on_profile_event(session, env.event_type, dict(env.payload), env.occurred_at)


class _Payload(BaseModel):
    """Терпимый читатель: обязательные поля строго, новые необязательные поля не ломают потребителя."""

    model_config = ConfigDict(extra="ignore")


class SkillOutcomeIn(_Payload):
    skill_id: Annotated[str, Field(min_length=1, max_length=200)]
    outcome: Literal["demonstrated", "learning", "not_assessed"]


class AssessmentCompletedIn(_Payload):
    evaluation_id: uuid.UUID
    user_id: uuid.UUID
    pair_id: Annotated[str, Field(min_length=1, max_length=200)]
    session_id: uuid.UUID
    kind: Literal["lesson", "scenario", "media", "review", "reading"]
    skill_outcomes: Annotated[list[SkillOutcomeIn], Field(max_length=100)]
    practice_only: bool
    supersedes: uuid.UUID | None = None
    created_at: AwareDatetime


class AssessmentReevaluatedIn(_Payload):
    evaluation_id: uuid.UUID
    supersedes: uuid.UUID
    user_id: uuid.UUID
    pair_id: Annotated[str, Field(min_length=1, max_length=200)]
    skill_outcomes: Annotated[list[SkillOutcomeIn], Field(max_length=100)]
    created_at: AwareDatetime


async def on_assessment(session: AsyncSession, env: Envelope) -> None:
    """Оценка урока → свидетельства и переходы навыков (source lesson), skills.state.changed.v1 при изменениях.
    practice_only и kind review / reading (спринт 5: вопросы к тексту — практика) — без изменений; переоценка —
    пересчёт демонстрации по заменённой оценке."""
    if not _trusted(env, ASSESSMENT_PRODUCERS):
        return
    if env.event_type == ASSESSMENT_REEVALUATED:
        r = AssessmentReevaluatedIn.model_validate(env.payload)
        ev = lesson_outcomes.Evaluation(
            evaluation_id=r.evaluation_id, user_id=r.user_id, pair_id=r.pair_id, session_id=None,
            supersedes=r.supersedes, practice_only=False,
            outcomes=[(o.skill_id, o.outcome) for o in r.skill_outcomes], created_at=r.created_at)
    else:
        c = AssessmentCompletedIn.model_validate(env.payload)
        ev = lesson_outcomes.Evaluation(
            evaluation_id=c.evaluation_id, user_id=c.user_id, pair_id=c.pair_id, session_id=c.session_id,
            supersedes=c.supersedes, practice_only=c.practice_only or c.kind in PRACTICE_KINDS,
            outcomes=[(o.skill_id, o.outcome) for o in c.skill_outcomes], created_at=c.created_at)
    changes = await lesson_outcomes.apply_evaluation(session, ev)
    log.info("lesson evaluation applied", extra={"event_type": env.event_type, "changes": len(changes)})


class RetentionCheckedIn(_Payload):
    check_id: uuid.UUID
    user_id: uuid.UUID
    pair_id: Annotated[str, Field(min_length=1, max_length=200)]
    skill_id: Annotated[str, Field(min_length=1, max_length=200)]
    stage: Literal["d7", "d30"]
    passed: bool
    consecutive_failures: Annotated[int, Field(ge=0, le=2)]
    evidence_id: uuid.UUID | None = None
    checked_at: AwareDatetime


async def on_retention_checked(session: AsyncSession, env: Envelope) -> None:
    """Спринт 5: результат проверки удержания (только от memory) → retained (d30 пройдена) или learning (два провала
    подряд) для навыка в demonstrated; skills.state.changed.v1 (source retention, evidence_id = check_id)."""
    if not _trusted(env, MEMORY_PRODUCERS):
        return
    p = RetentionCheckedIn.model_validate(env.payload)
    change = await retention.apply_check(session, retention.RetentionCheck(
        check_id=p.check_id, user_id=p.user_id, pair_id=p.pair_id, skill_id=p.skill_id, stage=p.stage,
        passed=p.passed, consecutive_failures=p.consecutive_failures, checked_at=p.checked_at))
    log.info("retention check applied", extra={"stage": p.stage, "passed": p.passed,
                                               "to": change["to"] if change else None})
