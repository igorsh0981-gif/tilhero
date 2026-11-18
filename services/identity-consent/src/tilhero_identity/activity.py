"""Проекция learner_activity (онбординг и последнее занятие) для фильтров аудитории рассылок `onboarded` и
`active_days` (docs/sprint2/INTERNAL_API.md §3).

Источник — `learning.plan.updated.v1` (`onboarding_completed`) и `learning.activity.recorded.v1` (`recorded_at`)
только от learning-plan; дедупликация — inbox (Runtime.add_consumer). Порядок доставки не гарантирован:
- последнее занятие — максимум `recorded_at` (не позже текущего момента: время из будущего не делает ученика
  «активным» навсегда);
- онбординг — время события плана с `onboarding_completed=true` (самое раннее); `false` снимает отметку, только если
  событие новее последнего применённого (`plan_event_at`), и более старое `true` не возвращает её после более нового
  `false`.
Проекция ведётся только для живых учеников (ACTIVE, DISABLED): запрос удаления и обезличивание удаляют строку
(service.py), поздние события удаляемого или удалённого ученика пропускаются. Строка ученика блокируется FOR SHARE —
параллельный запрос удаления (FOR UPDATE) дождётся события и удалит строку уже после него.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.context import pseudonymize
from tilhero_common.messaging import Envelope
from tilhero_identity.models import LearnerActivity, User

log = logging.getLogger("tilhero.identity.activity")

CONSUMER = "identity-consent.learner_activity"
PLAN_UPDATED = "learning.plan.updated.v1"
ACTIVITY_RECORDED = "learning.activity.recorded.v1"
EVENT_TYPES = [PLAN_UPDATED, ACTIVITY_RECORDED]
# Только learning-plan владеет планом и занятиями: события другого издателя не меняют проекцию (защита в глубину)
LEARNING_PRODUCERS = frozenset({"learning-plan"})
LIVE_STATUSES = ("ACTIVE", "DISABLED")


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _parse_time(raw: object) -> datetime | None:
    if not isinstance(raw, str) or len(raw) > 64:
        return None
    try:
        value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value if value.tzinfo is not None else None


def apply_plan(row: LearnerActivity, at: datetime, onboarding_completed: object) -> bool:
    """Отметка онбординга по событию плана → True, если проекция изменилась."""
    if not isinstance(onboarding_completed, bool):
        return False  # событие ничего не говорит об онбординге
    before = (row.onboarding_completed_at, row.plan_event_at)
    newer = row.plan_event_at is None or at > row.plan_event_at
    if onboarding_completed:
        if row.onboarding_completed_at is not None:
            row.onboarding_completed_at = min(row.onboarding_completed_at, at)
        elif newer:  # более новое событие уже сказало «не пройден» — старое true его не отменяет
            row.onboarding_completed_at = at
    elif newer:
        row.onboarding_completed_at = None
    row.plan_event_at = at if row.plan_event_at is None else max(row.plan_event_at, at)
    return (row.onboarding_completed_at, row.plan_event_at) != before


def apply_activity(row: LearnerActivity, at: datetime) -> bool:
    if row.last_activity_at is not None and row.last_activity_at >= at:
        return False
    row.last_activity_at = at
    return True


async def on_learning_event(session: AsyncSession, env: Envelope) -> None:
    if env.producer not in LEARNING_PRODUCERS:
        log.warning("learning event from unexpected producer ignored",
                    extra={"event_type": env.event_type, "producer": env.producer[:64]})
        return
    try:
        user_id = uuid.UUID(str(env.payload["user_id"]))
    except (KeyError, ValueError):
        log.warning("learning event ignored: malformed payload", extra={"event_id": env.event_id})
        return
    status = (await session.execute(
        select(User.status).where(User.user_id == user_id).with_for_update(read=True)
    )).scalar_one_or_none()
    if status not in LIVE_STATUSES:  # неизвестный, удаляемый или удалённый ученик — проекции не нужно
        log.info("learning event skipped: learner is not live",
                 extra={"event_type": env.event_type, "user_pid": pseudonymize(str(user_id))})
        return
    now = datetime.now(UTC)
    occurred = min(_aware(env.occurred_at), now)
    await session.execute(pg_insert(LearnerActivity).values(user_id=user_id).on_conflict_do_nothing())
    row = (await session.execute(
        select(LearnerActivity).where(LearnerActivity.user_id == user_id).with_for_update()
    )).scalar_one()
    if env.event_type == PLAN_UPDATED:
        changed = apply_plan(row, occurred, env.payload.get("onboarding_completed"))
    else:
        recorded = _parse_time(env.payload.get("recorded_at")) or occurred
        changed = apply_activity(row, min(recorded, now))
    if changed:
        row.updated_at = now
