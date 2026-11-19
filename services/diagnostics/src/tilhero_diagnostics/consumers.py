"""Потребители событий diagnostics (inbox-дедупликация в Runtime.add_consumer).

- identity-consent: сага удаления, проекция профиля (возраст);
- спринт 4 — assessment: `assessment.completed.v1`, `assessment.reevaluated.v1` → карта навыков по оценкам уроков
  (`domain/lesson_outcomes.py`). Чужой издатель — предупреждение в логе (тип события и издатель, без user_id),
  событие подтверждается шине без действия; payload не по контракту — исключение → DLQ.
"""

from __future__ import annotations

import logging
import uuid
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_diagnostics.domain import lesson_outcomes, users

DELETION_REQUESTED = "user.deletion.requested.v1"
PROFILE_CREATED = "user.profile.created.v1"
PROFILE_UPDATED = "user.profile.updated.v1"
ASSESSMENT_COMPLETED = "assessment.completed.v1"
ASSESSMENT_REEVALUATED = "assessment.reevaluated.v1"
# Сагу удаления и профили ведёт только identity-consent: события других издателей не исполняются (P-7)
TRUSTED_PRODUCERS = frozenset({"identity-consent"})
# Оценки уроков — только assessment (независимый оценщик; генерирующие агенты и lessons навыки не меняют)
ASSESSMENT_PRODUCERS = frozenset({"assessment"})

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
    kind: Literal["lesson", "scenario", "media", "review"]
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
    practice_only и kind review — без изменений; переоценка — пересчёт демонстрации по заменённой оценке."""
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
            supersedes=c.supersedes, practice_only=c.practice_only or c.kind == "review",
            outcomes=[(o.skill_id, o.outcome) for o in c.skill_outcomes], created_at=c.created_at)
    changes = await lesson_outcomes.apply_evaluation(session, ev)
    log.info("lesson evaluation applied", extra={"event_type": env.event_type, "changes": len(changes)})
