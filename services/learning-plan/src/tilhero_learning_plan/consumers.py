"""Потребители событий learning-plan (inbox-дедупликация в Runtime.add_consumer).

- `user.deletion.requested.v1` (identity-consent) — сага удаления;
- спринт 3 (INTERNAL_API §3) — входы траектории уроков, только проекции (пересчёт — при следующем чтении):
  `diagnostics.completed.v1` и `skills.state.changed.v1` (diagnostics) — последний результат диагностики и карта
  навыков; `catalog.version.published.v1` (catalog; kind course|module|lesson|skill) — снимок курса помечается
  устаревшим; `user.profile.created/updated.v1` (identity-consent) — сегмент аудитории kids|teens|adults для подбора
  уроков (детям 6–13 — только детские), возраст не хранится.

Издатель проверяется (защита в глубину, как у саги, ревью P-7): событие чужого издателя — предупреждение в логе
(тип события и издатель, без user_id) и подтверждение шине без действия. Невалидный payload — исключение → DLQ.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_learning_plan.domain import trajectory as tr
from tilhero_learning_plan.domain.plans import delete_user_data

DELETION_REQUESTED = "user.deletion.requested.v1"
DIAGNOSTICS_COMPLETED = "diagnostics.completed.v1"
SKILLS_CHANGED = "skills.state.changed.v1"
VERSION_PUBLISHED = "catalog.version.published.v1"
PROFILE_CREATED = "user.profile.created.v1"
PROFILE_UPDATED = "user.profile.updated.v1"
PRODUCER = "learning-plan"
# Сагу удаления ведёт только identity-consent: запрос от другого издателя не исполняется (защита в глубину, P-7)
DELETION_PRODUCERS = frozenset({"identity-consent"})
PRODUCERS = {
    DIAGNOSTICS_COMPLETED: frozenset({"diagnostics"}),
    SKILLS_CHANGED: frozenset({"diagnostics"}),
    VERSION_PUBLISHED: frozenset({"catalog"}),
    PROFILE_CREATED: frozenset({"identity-consent"}),
    PROFILE_UPDATED: frozenset({"identity-consent"}),
}
MAX_PAIR_LEN = 64

log = logging.getLogger("tilhero.learning_plan.consumers")

Handler = Callable[[AsyncSession, Envelope], Awaitable[None]]
Band = Literal["A0", "A1", "A2", "B1", "B2"]
SkillState = Literal["not_started", "learning", "demonstrated", "retained"]


class _Payload(BaseModel):
    """Терпимый читатель: обязательные поля строго, новые необязательные поля не ломают потребителя."""

    model_config = ConfigDict(extra="ignore")


class AreaIn(_Payload):
    status: Literal["assessed", "not_assessed"]
    band: Band | None = None
    confidence: Annotated[float, Field(ge=0, le=1)] | None = None


class DiagnosticsCompleted(_Payload):
    user_id: uuid.UUID
    pair_id: Annotated[str, Field(min_length=1, max_length=200)]
    result_id: uuid.UUID
    revision: Annotated[int, Field(ge=1)]
    test_id: Annotated[str, Field(min_length=1, max_length=200)]
    test_version: Annotated[int, Field(ge=0)]
    provisional_level: Band | None = None
    areas: Annotated[dict[str, AreaIn], Field(max_length=8)]
    recommended_start_lesson_id: Annotated[str, Field(max_length=200)] | None = None
    completed_at: AwareDatetime


class SkillChange(_Payload):
    skill_id: Annotated[str, Field(min_length=1, max_length=200)]
    to: SkillState
    source: Literal["diagnostic", "lesson", "retention"]


class SkillsChanged(_Payload):
    user_id: uuid.UUID
    pair_id: Annotated[str, Field(min_length=1, max_length=200)]
    changes: Annotated[list[SkillChange], Field(max_length=500)]
    occurred_at: AwareDatetime


class VersionPublished(_Payload):
    kind: str
    key: Annotated[str, Field(max_length=200)]
    action: Literal["published", "rolled_back", "archived"]
    course_id: Annotated[str, Field(max_length=200)] | None = None


class ProfileCreated(_Payload):
    user_id: uuid.UUID
    kind: Literal["account", "child"]
    age_band: str | None = None
    created_at: AwareDatetime


class ProfileUpdated(_Payload):
    user_id: uuid.UUID
    age_band: str | None = None


def _foreign(env: Envelope) -> bool:
    allowed = PRODUCERS.get(env.event_type, frozenset())
    if env.producer in allowed:
        return False
    log.warning("event from unexpected producer ignored",
                extra={"event_type": env.event_type, "producer": env.producer[:64]})
    return True


def _pair_ok(pair_id: str, env: Envelope) -> bool:
    if len(pair_id) <= MAX_PAIR_LEN:
        return True
    log.warning("event with too long pair_id ignored", extra={"event_type": env.event_type})
    return False


async def on_deletion_requested(session: AsyncSession, env: Envelope) -> None:
    """Сага удаления (TG-FR-006): план, занятия, отметки, траектории и проекции удаляются физически → ACK
    user.domain.deleted.v1. Повтор саги (тот же request_id, новый event_id) снова подтверждается. Чужой издатель —
    только лог (без PII), событие подтверждается шине без действия."""
    if env.producer not in DELETION_PRODUCERS:
        log.warning("deletion request from unexpected producer ignored",
                    extra={"event_type": env.event_type, "producer": env.producer[:64]})
        return
    await delete_user_data(
        session,
        uuid.UUID(str(env.payload["user_id"])),
        uuid.UUID(str(env.payload["request_id"])),
        causation_id=env.event_id,
        producer=PRODUCER,
    )


async def on_diagnostics(session: AsyncSession, env: Envelope) -> None:
    """diagnostics.completed.v1 → последний результат по паре; skills.state.changed.v1 → карта навыков.
    План пересчитывается при следующем чтении траектории (AT-34: по новой проверке; прошлые ревизии остаются)."""
    if _foreign(env):
        return
    if env.event_type == DIAGNOSTICS_COMPLETED:
        d = DiagnosticsCompleted.model_validate(env.payload)
        if not _pair_ok(d.pair_id, env):
            return
        await tr.project_diagnostic(
            session, user_id=d.user_id, pair_id=d.pair_id, result_id=d.result_id, revision=d.revision,
            test_id=d.test_id, test_version=d.test_version, provisional_level=d.provisional_level,
            areas={area: a.model_dump() for area, a in d.areas.items()},
            recommended_start_lesson_id=d.recommended_start_lesson_id, completed_at=d.completed_at,
        )
        return
    s = SkillsChanged.model_validate(env.payload)
    if not _pair_ok(s.pair_id, env):
        return
    await tr.project_skills(session, user_id=s.user_id, pair_id=s.pair_id,
                            changes=[(c.skill_id, c.to, c.source) for c in s.changes], occurred_at=s.occurred_at)


async def on_catalog(session: AsyncSession, env: Envelope) -> None:
    """catalog.version.published.v1 (published | rolled_back | archived) курса, модуля, урока или навыка → снимок
    курса устарел: следующее чтение траектории перепроверит его в catalog и, если он изменился, пересчитает.
    Рубрики, сценарии, медиа на траекторию не влияют."""
    if _foreign(env):
        return
    v = VersionPublished.model_validate(env.payload)
    if v.kind not in tr.STALE_KINDS:
        return
    course_id = v.course_id or (v.key if v.kind == "course" else None)
    marked = await tr.mark_snapshots_stale(session, course_id)
    log.info("course snapshot marked stale", extra={"kind": v.kind, "action": v.action, "snapshots": marked})


async def on_profile(session: AsyncSession, env: Envelope) -> None:
    """Сегмент аудитории ученика (без возраста): детский профиль / 6–13 — kids, 14–17 — teens, иначе adults.
    Обновление без возраста (age_band null) сегмент не меняет."""
    if _foreign(env):
        return
    at: datetime
    if env.event_type == PROFILE_CREATED:
        c = ProfileCreated.model_validate(env.payload)
        user_id, audience, at = c.user_id, tr.audience_from_profile(c.kind, c.age_band), c.created_at
    else:
        u = ProfileUpdated.model_validate(env.payload)
        if u.age_band is None:
            return
        user_id, audience, at = u.user_id, tr.audience_from_profile(None, u.age_band), env.occurred_at
    await tr.project_audience(session, user_id=user_id, audience=audience, at=at)


CONSUMERS: dict[str, tuple[list[str], Handler]] = {
    "learning-plan.user_deletion": ([DELETION_REQUESTED], on_deletion_requested),
    "learning-plan.diagnostics": ([DIAGNOSTICS_COMPLETED, SKILLS_CHANGED], on_diagnostics),
    "learning-plan.catalog": ([VERSION_PUBLISHED], on_catalog),
    "learning-plan.profiles": ([PROFILE_CREATED, PROFILE_UPDATED], on_profile),
}
