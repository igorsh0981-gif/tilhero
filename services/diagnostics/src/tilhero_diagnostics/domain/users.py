"""Ученик в diagnostics: блокировка по ученику, отметка удаления, возрастной сегмент, сага удаления.

Сегмент (kids | teens | adults) выбирает тест (дети 6–13 — `dx-en-kids`) и аудиторию уроков рекомендации:
- основной источник — параметр `audience` от telegram-bff (сегмент активного ученика `lrn`, как `?audience=` у
  catalog и `age` у experience-config);
- защита в глубину — проекция learner_profiles из событий identity-consent (kind=child или age_band 6-9/10-13):
  ребёнок получает детский тест, даже если BFF сегмент не передал или передал другой.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError
from tilhero_common.messaging import emit
from tilhero_diagnostics.models import (
    DeletedUser,
    LearnerProfile,
    Result,
    Session,
    SkillEvidence,
    SkillState,
)

PRODUCER = "diagnostics"
DOMAIN_DELETED = "user.domain.deleted.v1"
_LOCK_CLASS = 0x0D1A  # класс advisory-блокировок diagnostics (ученик)
KIDS_AGE_BANDS = frozenset({"6-9", "10-13"})


def user_deleted() -> ApiError:
    return ApiError(410, "USER_DELETED", "Данные ученика удалены по запросу")


async def lock_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    """Сериализация команд одного ученика (создание сессии, ответ, завершение, сага) до конца транзакции."""
    obj = int.from_bytes(user_id.bytes[:4], "big", signed=True)
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, :o)"), {"c": _LOCK_CLASS, "o": obj})


async def ensure_not_deleted(session: AsyncSession, user_id: uuid.UUID) -> None:
    if await session.get(DeletedUser, user_id) is not None:
        raise user_deleted()


async def segment_for(session: AsyncSession, user_id: uuid.UUID, hint: str | None) -> str:
    """kids — если так говорит BFF или проекция профиля (ребёнок защищён при любом hint); иначе hint BFF;
    без hint — возраст из проекции, затем сегмент последней сессии ученика, иначе adults."""
    profile = await session.get(LearnerProfile, user_id)
    child = profile is not None and (profile.kind == "child" or profile.age_band in KIDS_AGE_BANDS)
    if hint == "kids" or child:
        return "kids"
    if hint in ("teens", "adults"):
        return hint
    if profile is not None and profile.age_band in ("14-17", "18+"):
        return "teens" if profile.age_band == "14-17" else "adults"
    last = (await session.execute(
        select(Session.segment).where(Session.user_id == user_id).order_by(Session.started_at.desc()).limit(1)
    )).scalar_one_or_none()
    return last or "adults"


def test_audience(segment: str) -> str:
    return "kids" if segment == "kids" else "adults"


# ---------------------------------------------------------------- проекция профиля (identity-consent)


async def on_profile_event(session: AsyncSession, event_type: str, payload: dict[str, Any],
                           occurred_at: datetime) -> None:
    """user.profile.created.v1 → kind и age_band; user.profile.updated.v1 → age_band, если поле есть в событии.
    Запоздавшее событие не откатывает более новое значение возраста; удалённый ученик не воскрешается."""
    user_id = uuid.UUID(str(payload["user_id"]))
    if await session.get(DeletedUser, user_id) is not None:
        return
    at = occurred_at.astimezone(UTC)
    row = (await session.execute(
        select(LearnerProfile).where(LearnerProfile.user_id == user_id).with_for_update()
    )).scalar_one_or_none()
    created = event_type == "user.profile.created.v1"
    kind = payload.get("kind") if created and payload.get("kind") in ("account", "child") else None
    has_age = "age_band" in payload
    age = payload.get("age_band") if payload.get("age_band") in ("6-9", "10-13", "14-17", "18+") else None
    if row is None:
        session.add(LearnerProfile(user_id=user_id, kind=kind, age_band=age if has_age else None, updated_at=at))
        return
    if kind is not None:
        row.kind = kind
    if has_age and at >= row.updated_at:
        row.age_band = age
        row.updated_at = at


# ---------------------------------------------------------------- сага удаления


async def delete_user_data(session: AsyncSession, user_id: uuid.UUID, request_id: uuid.UUID,
                           causation_id: str | None) -> None:
    """Физическое удаление сессий, ответов (каскад), результатов, состояний и свидетельств навыков, проекции
    профиля + ACK саге `user.domain.deleted.v1 {domain: diagnostics, mode: deleted}`. Повтор снова подтверждает."""
    await lock_user(session, user_id)
    await session.execute(delete(SkillEvidence).where(SkillEvidence.user_id == user_id))
    await session.execute(delete(SkillState).where(SkillState.user_id == user_id))
    await session.execute(delete(Result).where(Result.user_id == user_id))
    await session.execute(delete(Session).where(Session.user_id == user_id))
    await session.execute(delete(LearnerProfile).where(LearnerProfile.user_id == user_id))
    await session.execute(
        insert(DeletedUser).values(user_id=user_id, request_id=request_id).on_conflict_do_nothing(
            index_elements=["user_id"])
    )
    await emit(session, DOMAIN_DELETED,
               {"user_id": str(user_id), "request_id": str(request_id), "domain": "diagnostics", "mode": "deleted"},
               producer=PRODUCER, causation_id=causation_id)
