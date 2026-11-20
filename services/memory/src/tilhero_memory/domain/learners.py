"""Ученик в memory: контекст из внутреннего токена, аудитория, проекции (план, навыки), дни активности, сага удаления.

Ученик — `lrn` внутреннего токена (активный ученик), аккаунт — `sub` (INTERNAL_API §0). Аудитория — по claim
`age_band` ученика: 6-9 / 10-13 → kids, 14-17 → teens, 18+ → adults. Детский профиль «липкий»: `lrn ≠ sub`, детская
полоса в claims, `?audience=kids` от BFF или детская полоса в проекции — kids. Полоса неизвестна у ребёнка —
поведение 6–9 (сборка вместо ввода: строже). Возраст без сведений — kids.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_memory.domain.common import (
    AGE_BANDS,
    DOMAIN_DELETED,
    KIDS_BANDS,
    emit_event,
    local_date,
    lock_user,
    user_deleted,
    zone,
)
from tilhero_memory.models import (
    ActivityDay,
    Card,
    DeletedUser,
    FeedLog,
    Idempotency,
    LearnerProjection,
    PronunciationAttempt,
    ReminderSent,
    RetentionCheck,
    ReviewSession,
    SkillProjection,
)
from tilhero_memory.settings import Settings


@dataclass(frozen=True)
class Learner:
    user_id: uuid.UUID  # lrn — активный ученик
    account_id: uuid.UUID  # sub — аккаунт Telegram
    age_band: str | None  # claim age_band
    audience_hint: str | None = None  # ?audience= от BFF (детский профиль не понижается)
    locale_hint: str | None = None  # ?locale= от BFF

    @property
    def child_by_claims(self) -> bool:
        return self.user_id != self.account_id or self.age_band in KIDS_BANDS or self.audience_hint == "kids"


@dataclass(frozen=True)
class Profile:
    """Что известно об ученике для правил: аудитория, полоса, язык, пояс, пара."""

    user_id: uuid.UUID
    audience: str  # kids | teens | adults
    band: str | None  # 6-9 | 10-13 | 14-17 | 18+
    locale: str  # ru | uz
    tz: ZoneInfo
    tz_name: str
    pair_id: str

    @property
    def kids(self) -> bool:
        return self.audience == "kids"

    @property
    def young(self) -> bool:
        """Дети 6–9: сборка вместо ввода (полоса ребёнка неизвестна — тоже 6–9: строже)."""
        return self.kids and self.band != "10-13"


async def ensure_not_deleted(session: AsyncSession, user_id: uuid.UUID) -> None:
    if await session.get(DeletedUser, user_id) is not None:
        raise user_deleted()


def audience_of(band: str | None, child: bool) -> str:
    if child or band in KIDS_BANDS:
        return "kids"
    if band == "14-17":
        return "teens"
    if band == "18+":
        return "adults"
    return "kids"


async def profile(session: AsyncSession, learner: Learner, settings: Settings, pair_hint: str | None = None,
                  *, remember: bool = True) -> Profile:
    """Профиль ученика для запроса: claims + проекция плана. remember — запомнить полосу из claims (consumers:
    детям карточек ошибок не бывает — защита в глубину)."""
    proj = await session.get(LearnerProjection, learner.user_id)
    band = learner.age_band if learner.age_band in AGE_BANDS else None
    child = learner.child_by_claims or (proj is not None and proj.age_band in KIDS_BANDS)
    if child and band not in KIDS_BANDS:
        # детский профиль: claim — возраст аккаунта (не ребёнка) или нет; полоса — из проекции, если детская
        band = proj.age_band if proj is not None and proj.age_band in KIDS_BANDS else None
    if band is None and not child and proj is not None and proj.age_band in AGE_BANDS:
        band = proj.age_band
    audience = audience_of(band, child)
    if remember and band is not None and (proj is None or proj.age_band != band):
        await upsert_age_band(session, learner.user_id, band)
    locale = learner.locale_hint if learner.locale_hint in ("ru", "uz") else (
        proj.ui_lang if proj is not None and proj.ui_lang in ("ru", "uz") else "ru")
    tz_name = proj.timezone if proj is not None and proj.timezone else settings.default_timezone
    tz = zone(tz_name, settings.default_timezone)
    pair = pair_hint or (proj.course_pair if proj is not None and proj.course_pair else settings.default_pair_id)
    return Profile(learner.user_id, audience, band, locale, tz, str(tz.key), pair)


async def upsert_age_band(session: AsyncSession, user_id: uuid.UUID, band: str) -> None:
    stmt = insert(LearnerProjection).values(user_id=user_id, age_band=band, updated_at=datetime.now(UTC))
    await session.execute(stmt.on_conflict_do_update(index_elements=["user_id"],
                                                     set_={"age_band": band}))


async def timezone_of(session: AsyncSession, user_id: uuid.UUID, settings: Settings) -> ZoneInfo:
    proj = await session.get(LearnerProjection, user_id)
    return zone(proj.timezone if proj is not None else None, settings.default_timezone)


async def known_kid(session: AsyncSession, user_id: uuid.UUID) -> bool | None:
    """True — ребёнок, False — подросток/взрослый, None — неизвестно (проекции нет)."""
    proj = await session.get(LearnerProjection, user_id)
    if proj is None or proj.age_band is None:
        return None
    return proj.age_band in KIDS_BANDS


# ---------------------------------------------------------------- проекция плана (learning-plan)


async def on_plan_updated(session: AsyncSession, payload: dict[str, Any], occurred_at: datetime) -> None:
    """learning.plan.updated.v1 (полный снимок плана): пояс, пара, напоминания, язык. Запоздавшее событие не
    откатывает более новое; удалённый ученик не воскрешается."""
    user_id = uuid.UUID(str(payload["user_id"]))
    # блокировка ученика ДО проверки удаления: иначе событие, ждавшее сагу, воскресит проекцию после её фиксации
    await lock_user(session, user_id)
    if await session.get(DeletedUser, user_id) is not None:
        return
    at = occurred_at.astimezone(UTC)
    values: dict[str, Any] = {"plan_updated_at": at, "updated_at": datetime.now(UTC)}
    tz = payload.get("timezone")
    if isinstance(tz, str) and tz and _valid_tz(tz):
        values["timezone"] = tz[:64]
    if isinstance(payload.get("course_pair"), str):
        values["course_pair"] = str(payload["course_pair"])[:16]
    if isinstance(payload.get("reminders_enabled"), bool):
        values["reminders_enabled"] = payload["reminders_enabled"]
    if payload.get("ui_lang") in ("ru", "uz"):
        values["ui_lang"] = payload["ui_lang"]
    row = (await session.execute(
        select(LearnerProjection).where(LearnerProjection.user_id == user_id).with_for_update()
    )).scalar_one_or_none()
    if row is None:
        session.add(LearnerProjection(user_id=user_id, **values))
        return
    if row.plan_updated_at is not None and at < row.plan_updated_at:
        return
    for k, v in values.items():
        setattr(row, k, v)


def _valid_tz(name: str) -> bool:
    try:
        ZoneInfo(name)
    except Exception:
        return False
    return True


# ---------------------------------------------------------------- проекция навыков (diagnostics)


async def upsert_skill(session: AsyncSession, user_id: uuid.UUID, pair_id: str, skill_id: str, state: str,
                       at: datetime) -> None:
    stmt = insert(SkillProjection).values(user_id=user_id, pair_id=pair_id, skill_id=skill_id, state=state,
                                          changed_at=at)
    await session.execute(stmt.on_conflict_do_update(
        index_elements=["user_id", "pair_id", "skill_id"], set_={"state": state, "changed_at": at},
        where=SkillProjection.changed_at <= at))


# ---------------------------------------------------------------- дни активности


async def mark_activity(session: AsyncSession, user_id: uuid.UUID, day: date, source: str, now: datetime) -> None:
    await session.execute(insert(ActivityDay).values(user_id=user_id, local_date=day, source=source, created_at=now)
                          .on_conflict_do_nothing(index_elements=["user_id", "local_date"]))


async def on_lesson_completed(session: AsyncSession, payload: dict[str, Any], settings: Settings) -> None:
    """lesson.session.completed.v1 (только от lessons): завершённое занятие → день активности (local_date события,
    иначе — местная дата finished_at по поясу плана)."""
    if payload.get("status") != "completed":
        return
    user_id = uuid.UUID(str(payload["user_id"]))
    await lock_user(session, user_id)  # до проверки удаления (сага держит ту же блокировку)
    if await session.get(DeletedUser, user_id) is not None:
        return
    finished = datetime.fromisoformat(str(payload["finished_at"]).replace("Z", "+00:00"))
    raw = payload.get("local_date")
    if isinstance(raw, str):
        day = date.fromisoformat(raw)
    else:
        day = local_date(finished, await timezone_of(session, user_id, settings))
    await mark_activity(session, user_id, day, "lesson", datetime.now(UTC))


async def active_recently(session: AsyncSession, user_id: uuid.UUID, today: date, days: int) -> bool:
    since = today - timedelta(days=days)
    found = await session.scalar(select(func.count()).select_from(ActivityDay).where(
        ActivityDay.user_id == user_id, ActivityDay.local_date > since))
    return bool(found)


# ---------------------------------------------------------------- сага удаления


async def delete_user_data(session: AsyncSession, user_id: uuid.UUID, request_id: uuid.UUID,
                           causation_id: str | None) -> None:
    """Физическое удаление: карточки (с историей планирования — каскад), сессии (с заданиями — каскад), проверки,
    попытки произношения, проекции, напоминания, дни активности, ключи идемпотентности → ACK
    `user.domain.deleted.v1 {domain: memory, mode: deleted}`. Общий кеш переводов (catalog, Redis) не персональный —
    остаётся. Повтор саги снова подтверждается."""
    await lock_user(session, user_id)
    await session.execute(delete(Card).where(Card.user_id == user_id))
    await session.execute(delete(ReviewSession).where(ReviewSession.user_id == user_id))
    for model in (RetentionCheck, PronunciationAttempt, LearnerProjection, SkillProjection, ReminderSent,
                  ActivityDay, FeedLog, Idempotency):
        await session.execute(delete(model).where(model.user_id == user_id))
    await session.execute(insert(DeletedUser).values(user_id=user_id, request_id=request_id)
                          .on_conflict_do_nothing(index_elements=["user_id"]))
    await emit_event(session, DOMAIN_DELETED, {"user_id": str(user_id), "request_id": str(request_id),
                                               "domain": "memory", "mode": "deleted"}, causation_id=causation_id)
