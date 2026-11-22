"""Ученик в lessons: контекст из внутреннего токена, сегмент (kids/teens/adults), проекция профиля, сага удаления.

Ученик — `lrn` внутреннего токена (активный ученик), аккаунт — `sub` (INTERNAL_API §0). Без `lrn` ученик = аккаунт.
Детский профиль 6–13 — «липкий» (защита в глубину): `lrn ≠ sub`, или claim `age_band` ∈ {6-9, 10-13}, или проекция
learner_profiles (kind=child или детская полоса), или `?audience=kids` от BFF. Ребёнку — только детские материалы и
выбор реплик (ai_mode choices), свободный текст — 403 KIDS_NOT_ALLOWED.
Сегмент без сведений о возрасте — kids (самый строгий набор, как у telegram-bff: возраст не выбран → kids).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import emit
from tilhero_lessons.domain import duels, pair
from tilhero_lessons.domain.common import DOMAIN_DELETED, PRODUCER, lock_user, user_deleted
from tilhero_lessons.models import (
    CommunityMember,
    DeletedUser,
    LearnerProfile,
    ReviewItem,
    Session,
    SocialBlock,
    SocialSanction,
)
from tilhero_lessons.settings import Settings

KIDS_AGE_BANDS = frozenset({"6-9", "10-13"})
AGE_BANDS = frozenset({"6-9", "10-13", "14-17", "18+"})


@dataclass(frozen=True)
class Learner:
    user_id: uuid.UUID  # lrn — активный ученик
    account_id: uuid.UUID  # sub — аккаунт Telegram
    age_band: str | None  # claim age_band (BFF)

    @property
    def child_by_claims(self) -> bool:
        return self.user_id != self.account_id or self.age_band in KIDS_AGE_BANDS


async def ensure_not_deleted(session: AsyncSession, user_id: uuid.UUID) -> None:
    if await session.get(DeletedUser, user_id) is not None:
        raise user_deleted()


async def is_child(session: AsyncSession, learner: Learner) -> bool:
    if learner.child_by_claims:
        return True
    profile = await session.get(LearnerProfile, learner.user_id)
    return profile is not None and (profile.kind == "child" or profile.age_band in KIDS_AGE_BANDS)


async def audience_for(session: AsyncSession, learner: Learner, hint: str | None) -> str:
    """kids — по любому детскому признаку (claims, проекция, hint); иначе hint BFF; иначе age_band claim; иначе
    возраст из проекции; иначе kids."""
    if hint == "kids" or await is_child(session, learner):
        return "kids"
    if hint in ("teens", "adults"):
        return hint
    band = learner.age_band
    if band not in AGE_BANDS:
        profile = await session.get(LearnerProfile, learner.user_id)
        band = profile.age_band if profile is not None else None
    if band == "14-17":
        return "teens"
    if band == "18+":
        return "adults"
    return "kids"


# ---------------------------------------------------------------- проекция профиля (identity-consent)


async def on_profile_event(session: AsyncSession, event_type: str, payload: dict[str, Any],
                           occurred_at: datetime) -> None:
    """user.profile.created.v1 → kind и age_band; user.profile.updated.v1 → age_band, если поле есть в событии.
    Запоздавшее событие не откатывает более новое значение возраста; удалённый ученик не воскрешается."""
    user_id = uuid.UUID(str(payload["user_id"]))
    await lock_user(session, user_id)  # как сага: проверка удаления — после блокировки ученика
    if await session.get(DeletedUser, user_id, populate_existing=True) is not None:
        return
    at = occurred_at.astimezone(UTC)
    row = (await session.execute(
        select(LearnerProfile).where(LearnerProfile.user_id == user_id).with_for_update()
    )).scalar_one_or_none()
    created = event_type == "user.profile.created.v1"
    kind = payload.get("kind") if created and payload.get("kind") in ("account", "child") else None
    has_age = "age_band" in payload
    age = payload.get("age_band") if payload.get("age_band") in AGE_BANDS else None
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
                           causation_id: str | None, *, now: datetime | None = None,
                           settings: Settings | None = None) -> None:
    """Физическое удаление сессий ученика (и сессий, начатых из его аккаунта; спринт 7 — и сессий дуэли) с шагами,
    репликами и историей (каскад), очереди повторения и проекций (профиль, сообщество, блокировки, санкции);
    наборы дуэлей и начатые парные комнаты обезличиваются (отчёт и реплики партнёра не трогаются), неначатые
    комнаты удаляются + ACK `user.domain.deleted.v1 {domain: lessons, mode: deleted}`. Повтор саги снова
    подтверждается. Блокировка ученика держится до фиксации: параллельные команды ждут и видят удаление."""
    when = now or datetime.now(UTC)
    await lock_user(session, user_id)
    await session.execute(delete(Session).where(or_(Session.user_id == user_id, Session.account_id == user_id)))
    await session.execute(delete(ReviewItem).where(ReviewItem.user_id == user_id))
    await session.execute(delete(LearnerProfile).where(LearnerProfile.user_id == user_id))
    await duels.forget_user(session, user_id)
    await pair.forget_user(session, user_id, when, settings or Settings())
    await session.execute(delete(CommunityMember).where(CommunityMember.user_id == user_id))
    await session.execute(delete(SocialBlock).where(or_(SocialBlock.blocker == user_id,
                                                        SocialBlock.blocked == user_id)))
    await session.execute(delete(SocialSanction).where(SocialSanction.user_id == user_id))
    await session.execute(
        insert(DeletedUser).values(user_id=user_id, request_id=request_id).on_conflict_do_nothing(
            index_elements=["user_id"])
    )
    await emit(session, DOMAIN_DELETED,
               {"user_id": str(user_id), "request_id": str(request_id), "domain": "lessons", "mode": "deleted"},
               producer=PRODUCER, causation_id=causation_id)
