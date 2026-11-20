"""Потребители событий memory (inbox-дедупликация в Runtime.add_consumer; издатель проверяется — события чужих
издателей не исполняются, INTERNAL_API §1.12)."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.messaging import Envelope
from tilhero_memory.clients import CatalogGateway
from tilhero_memory.domain import cards, glossary, learners, retention
from tilhero_memory.domain.context import now_of, settings_of

ASSESSMENT_COMPLETED: Final = "assessment.completed.v1"
ASSESSMENT_REEVALUATED: Final = "assessment.reevaluated.v1"
SKILLS_CHANGED: Final = "skills.state.changed.v1"
PLAN_UPDATED: Final = "learning.plan.updated.v1"
LESSON_COMPLETED: Final = "lesson.session.completed.v1"
DELETION_REQUESTED: Final = "user.deletion.requested.v1"
GLOSSARY_CHANGED: Final = "catalog.glossary.changed.v1"

PRODUCERS: Final = {
    ASSESSMENT_COMPLETED: "assessment", ASSESSMENT_REEVALUATED: "assessment", SKILLS_CHANGED: "diagnostics",
    PLAN_UPDATED: "learning-plan", LESSON_COMPLETED: "lessons", DELETION_REQUESTED: "identity-consent",
    GLOSSARY_CHANGED: "catalog",
}

log = logging.getLogger("tilhero.memory.consumers")

Handler = Callable[[AsyncSession, Envelope], Awaitable[None]]


def trusted(env: Envelope) -> bool:
    if PRODUCERS.get(env.event_type) == env.producer:
        return True
    log.warning("event from unexpected producer ignored",
                extra={"event_type": env.event_type, "producer": env.producer[:64]})
    return False


def _ts(value: object, default: datetime) -> datetime:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return default


def register(rt: Runtime, catalog: CatalogGateway) -> None:
    async def on_assessment(session: AsyncSession, env: Envelope) -> None:
        """Карточки из урока, медиа и подтверждённых ошибок (memory-feed assessment); переоценка — архив ошибок."""
        if trusted(env):
            await cards.on_assessment_event(rt, catalog, session, env,
                                            reevaluated=env.event_type == ASSESSMENT_REEVALUATED)

    async def on_skills(session: AsyncSession, env: Envelope) -> None:
        """Проверки удержания: → demonstrated — d7; выход из demonstrated — отмена незавершённых."""
        if trusted(env):
            now = now_of(rt)
            await retention.on_skills_changed(session, dict(env.payload), _ts(env.payload.get("occurred_at"),
                                                                              env.occurred_at), now)

    async def on_plan(session: AsyncSession, env: Envelope) -> None:
        """Проекция плана: пояс (день ученика, 19:00), пара, напоминания, язык."""
        if trusted(env):
            await learners.on_plan_updated(session, dict(env.payload), env.occurred_at)

    async def on_lesson(session: AsyncSession, env: Envelope) -> None:
        """Дни активности (правило «нет активности 14 дней» для проверок удержания)."""
        if trusted(env):
            await learners.on_lesson_completed(session, dict(env.payload), settings_of(rt))

    async def on_deletion(session: AsyncSession, env: Envelope) -> None:
        """Сага удаления → ACK user.domain.deleted.v1 {domain: memory}."""
        if trusted(env):
            await learners.delete_user_data(session, uuid.UUID(str(env.payload["user_id"])),
                                            uuid.UUID(str(env.payload["request_id"])), causation_id=env.event_id)

    async def on_glossary(session: AsyncSession, env: Envelope) -> None:
        """Правка словаря курса — сброс кеша перевода по формам статьи."""
        if trusted(env):
            forms = [f for f in env.payload.get("forms") or [] if isinstance(f, str)]
            await glossary.invalidate(rt, settings_of(rt), str(env.payload.get("pair_id")), forms)

    rt.add_consumer("memory.assessment", [ASSESSMENT_COMPLETED, ASSESSMENT_REEVALUATED], on_assessment)
    rt.add_consumer("memory.skills", [SKILLS_CHANGED], on_skills)
    rt.add_consumer("memory.plans", [PLAN_UPDATED], on_plan)
    rt.add_consumer("memory.lessons", [LESSON_COMPLETED], on_lesson)
    rt.add_consumer("memory.user_deletion", [DELETION_REQUESTED], on_deletion)
    rt.add_consumer("memory.glossary", [GLOSSARY_CHANGED], on_glossary)
