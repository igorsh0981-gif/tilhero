"""Команды и чтения плана ученика.

Изменение и событие пишутся в одной транзакции (outbox). Изменения одного ученика сериализуются
pg_advisory_xact_lock (ключ из user_id); строка плана блокируется FOR NO KEY UPDATE — не конфликтует с FOR KEY SHARE,
которым tick держит план, пока выпускает события по нему. Таблица deleted_users проверяется под той же блокировкой:
после удаления (сага) план не воскрешается.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from sqlalchemy import and_, delete, exists, func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict, unprocessable
from tilhero_common.messaging import emit
from tilhero_learning_plan.domain import schedule as sch
from tilhero_learning_plan.models import (
    Activity,
    CompletedLesson,
    DeletedUser,
    LearnerAudience,
    LearnerDiagnostic,
    LessonEvaluation,
    Plan,
    SkillStateProjection,
    SlotMark,
    Trajectory,
)
from tilhero_learning_plan.schemas import ActivityIn, LearningPlanOut, PlanPatchIn

PLAN_UPDATED = "learning.plan.updated.v1"
ACTIVITY_RECORDED = "learning.activity.recorded.v1"
DOMAIN_DELETED = "user.domain.deleted.v1"
DELETION_DOMAIN = "learning-plan"
_LOCK_CLASS = 0x4C504C4E  # 'LPLN' — пространство advisory-ключей сервиса

DEFAULT_TIME = time(19, 0)
DEFAULT_DURATION = 20
# порядок полей в changed_fields события и в проверке «что изменилось»
PLAN_FIELDS = ("goal", "level_self", "topics", "ui_lang", "explain_lang")
SCHEDULE_FIELDS = ("preset", "days", "preferred_time", "duration_min", "reminders_enabled", "timezone")
TIMING_FIELDS = frozenset({"days", "preferred_time", "timezone"})


def user_deleted() -> ApiError:
    return ApiError(410, "USER_DELETED", "Данные ученика удалены по запросу")


def plan_invalid(exc: sch.PlanInvalid) -> ApiError:
    return unprocessable("PLAN_INVALID", "Некорректные данные плана", {"field": exc.field, "reason": exc.reason})


def defaults(user_id: uuid.UUID, timezone: str) -> dict[str, Any]:
    """План по умолчанию (bff.ts): goal null, каждый день, 19:00, 20 минут, напоминания выключены, зона клиента."""
    return {
        "user_id": user_id,
        "goal": None,
        "level_self": None,
        "topics": [],
        "ui_lang": "ru",
        "explain_lang": "ru",
        "course_pair": "ru-en",
        "preset": "daily",
        "days": list(sch.PRESET_DAYS["daily"]),
        "preferred_time": DEFAULT_TIME,
        "duration_min": DEFAULT_DURATION,
        "reminders_enabled": False,
        "timezone": timezone,
        "schedule_set_at": None,
        "onboarding_completed_at": None,
        "version": 1,
    }


def to_public(p: Plan) -> LearningPlanOut:
    return LearningPlanOut.model_validate({
        "learner_id": str(p.user_id),
        "goal": p.goal,
        "level_self": p.level_self,
        "topics": list(p.topics),
        "ui_lang": p.ui_lang,
        "explain_lang": p.explain_lang,
        "course_pair": p.course_pair,
        "schedule": {
            "preset": p.preset,
            "days": sorted(p.days),
            "preferred_time": sch.fmt_hhmm(p.preferred_time),
            "duration_min": p.duration_min,
            "reminders_enabled": p.reminders_enabled,
            "timezone": p.timezone,
        },
        "onboarding_completed_at": p.onboarding_completed_at,
        "updated_at": p.updated_at,
        "version": p.version,
    })


def resolve_timezone(requested: str | None, fallback: str) -> str:
    """?tz= клиента, если это известная IANA-зона; иначе зона по умолчанию (неизвестная зона не ломает вход)."""
    if requested and sch.is_valid_timezone(requested):
        return requested
    return fallback if sch.is_valid_timezone(fallback) else sch.FALLBACK_TIMEZONE


async def lock_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    obj = int.from_bytes(user_id.bytes[:4], "big", signed=True)
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, :o)"), {"c": _LOCK_CLASS, "o": obj})


async def _ensure_not_deleted(session: AsyncSession, user_id: uuid.UUID) -> None:
    if await session.get(DeletedUser, user_id) is not None:
        raise user_deleted()


async def get_or_create(session: AsyncSession, user_id: uuid.UUID, timezone: str) -> Plan:
    """Чтение; при первом обращении создаёт план по умолчанию (без события: это не правка ученика)."""
    plan = await session.get(Plan, user_id)
    if plan is not None:
        return plan
    await lock_user(session, user_id)
    await _ensure_not_deleted(session, user_id)
    await session.execute(
        insert(Plan).values(**defaults(user_id, timezone)).on_conflict_do_nothing(index_elements=["user_id"])
    )
    return (await session.execute(select(Plan).where(Plan.user_id == user_id))).scalar_one()


async def load_for_update(session: AsyncSession, user_id: uuid.UUID, timezone: str) -> Plan:
    await lock_user(session, user_id)
    await _ensure_not_deleted(session, user_id)
    await session.execute(
        insert(Plan).values(**defaults(user_id, timezone)).on_conflict_do_nothing(index_elements=["user_id"])
    )
    stmt = select(Plan).where(Plan.user_id == user_id).with_for_update(key_share=True)
    return (await session.execute(stmt.execution_options(populate_existing=True))).scalar_one()


def parse_if_match(value: str | None) -> int | None:
    """If-Match: 3 | "3" | W/"3" → 3. Пусто или * → без проверки версии."""
    if value is None:
        return None
    v = value.strip()
    if v in ("", "*"):
        return None
    if v.startswith("W/"):
        v = v[2:]
    v = v.strip('"')
    if not v.isdigit() or len(v) > 9:
        raise unprocessable("PLAN_INVALID", "Некорректные данные плана", {"field": "If-Match", "reason": "format"})
    return int(v)


def _event_payload(p: Plan, changed: list[str]) -> dict[str, Any]:
    return {
        "user_id": str(p.user_id),
        "changed_fields": changed,
        "goal": p.goal,
        "ui_lang": p.ui_lang,
        "course_pair": p.course_pair,
        "timezone": p.timezone,
        "days": sorted(p.days),
        "preferred_time": sch.fmt_hhmm(p.preferred_time),
        "duration_min": p.duration_min,
        "reminders_enabled": p.reminders_enabled,
        "onboarding_completed": p.onboarding_completed_at is not None,
        "level_self": p.level_self,
        "preset": p.preset,
    }


async def _commit_change(session: AsyncSession, p: Plan, changed: list[str], now: datetime, producer: str) -> None:
    p.version += 1
    p.updated_at = now
    await session.flush()
    await emit(session, PLAN_UPDATED, _event_payload(p, changed), producer=producer)


def _current_schedule(p: Plan) -> sch.ScheduleState:
    return sch.ScheduleState(p.preset, tuple(sorted(p.days)), p.preferred_time, p.duration_min,
                             p.reminders_enabled, p.timezone)


async def apply_patch(session: AsyncSession, user_id: uuid.UUID, patch: PlanPatchIn, *, if_match: int | None,
                      default_tz: str, now: datetime, producer: str) -> Plan:
    """Частичная правка. Повтор того же PATCH — no-op (версия и события не меняются).
    Валидация до блокировки там, где она не зависит от текущего состояния."""
    provided = patch.model_fields_set
    for name in provided:
        if getattr(patch, name) is None:
            raise sch.PlanInvalid(name, "null_not_allowed")
    sched_patch: dict[str, Any] = {}
    if patch.schedule is not None:
        for name in patch.schedule.model_fields_set:
            value = getattr(patch.schedule, name)
            if value is None:
                raise sch.PlanInvalid(f"schedule.{name}", "null_not_allowed")
            sched_patch[name] = value

    new: dict[str, Any] = {}
    if patch.goal is not None:
        new["goal"] = sch.validate_choice("goal", patch.goal, sch.GOALS)
    if patch.level_self is not None:
        new["level_self"] = sch.validate_choice("level_self", patch.level_self, sch.LEVELS)
    if patch.topics is not None:
        new["topics"] = sch.validate_topics(patch.topics)
    if patch.ui_lang is not None:
        new["ui_lang"] = sch.validate_choice("ui_lang", patch.ui_lang, sch.UI_LANGS)
    if patch.explain_lang is not None:
        new["explain_lang"] = sch.validate_choice("explain_lang", patch.explain_lang, sch.UI_LANGS)

    p = await load_for_update(session, user_id, default_tz)
    if if_match is not None and if_match != p.version:
        raise conflict("PLAN_VERSION_CONFLICT", "План уже изменён в другом окне — обновите данные",
                       {"current_version": p.version})

    if sched_patch:
        merged = sch.merge_schedule(_current_schedule(p), sched_patch)
        new.update({
            "preset": merged.preset,
            "days": list(merged.days),
            "preferred_time": merged.preferred_time,
            "duration_min": merged.duration_min,
            "reminders_enabled": merged.reminders_enabled,
            "timezone": merged.timezone,
        })

    def current(name: str) -> Any:
        value = getattr(p, name)
        return sorted(value) if name == "days" else value

    changed = [name for name in (*PLAN_FIELDS, *SCHEDULE_FIELDS) if name in new and current(name) != new[name]]
    for name in changed:
        setattr(p, name, new[name])
    # Шаг графика пройден: ученик сам выбрал хоть одно поле графика (зона из Intl выбором не считается).
    # Дальше schedule_set_at двигается только при смене времени/дней/зоны — новый график действует со следующего слота.
    chose = bool(sch.SCHEDULE_CHOICE_FIELDS & sched_patch.keys())
    if (p.schedule_set_at is None and chose) or (p.schedule_set_at is not None and TIMING_FIELDS & set(changed)):
        p.schedule_set_at = now
    if changed:
        await _commit_change(session, p, changed, now, producer)
    else:
        await session.flush()
    return p


def missing_for_onboarding(p: Plan) -> list[str]:
    missing = []
    if p.goal is None:
        missing.append("goal")
    if p.level_self is None:
        missing.append("level_self")
    if p.schedule_set_at is None:
        missing.append("schedule")
    return missing


async def complete_onboarding(session: AsyncSession, user_id: uuid.UUID, *, default_tz: str, now: datetime,
                              producer: str) -> Plan:
    """Идемпотентно: повтор возвращает исходную отметку времени без нового события."""
    p = await load_for_update(session, user_id, default_tz)
    if p.onboarding_completed_at is not None:
        return p
    missing = missing_for_onboarding(p)
    if missing:
        raise conflict("PLAN_INCOMPLETE", "Онбординг не завершён: заполните цель, уровень и график",
                       {"missing": missing})
    p.onboarding_completed_at = now
    await _commit_change(session, p, ["onboarding_completed_at"], now, producer)
    return p


# ---------------------------------------------------------------- занятия и «сегодня»


async def streak_days(session: AsyncSession, user_id: uuid.UUID, today: date) -> int:
    """Серия: дни с занятием после последнего выпущенного пропуска без занятия. Дни вне графика серию не рвут
    (по ним пропуск не выпускается), сегодняшний несделанный слот — тоже (день не закончился)."""
    act = Activity.__table__.c
    marks = SlotMark.__table__.c
    last_break = (
        await session.execute(
            select(func.max(marks.local_date)).where(
                marks.user_id == user_id,
                marks.kind == "missed",
                marks.local_date < today,
                ~exists().where(and_(act.user_id == user_id, act.local_date == marks.local_date)),
            )
        )
    ).scalar_one()
    stmt = select(func.count(func.distinct(act.local_date))).where(act.user_id == user_id, act.local_date <= today)
    if last_break is not None:
        stmt = stmt.where(act.local_date > last_break)
    return int((await session.execute(stmt)).scalar_one())


async def day_facts(session: AsyncSession, user_id: uuid.UUID, start: date, end: date) -> sch.DayFacts:
    act = Activity.__table__.c
    rows = (
        await session.execute(
            select(act.local_date, func.sum(act.minutes))
            .where(act.user_id == user_id, act.local_date >= start, act.local_date <= end)
            .group_by(act.local_date)
        )
    ).all()
    marks = SlotMark.__table__.c
    missed = (
        await session.execute(
            select(marks.local_date).where(marks.user_id == user_id, marks.kind == "missed",
                                           marks.local_date >= start, marks.local_date <= end)
        )
    ).scalars().all()
    return sch.DayFacts({d: int(m or 0) for d, m in rows}, frozenset(missed))


async def today_for(session: AsyncSession, p: Plan, now: datetime) -> dict[str, Any]:
    tz = sch.zone(p.timezone)
    today = sch.local_date(now, tz)
    monday = today - timedelta(days=today.isoweekday() - 1)
    facts = await day_facts(session, p.user_id, monday, monday + timedelta(days=6))
    return sch.today_plan(today=today, days=p.days, preferred_time=p.preferred_time, duration_min=p.duration_min,
                          facts=facts, streak_days=await streak_days(session, p.user_id, today))


class IdempotencyReused(Exception):
    pass


async def record_activity(session: AsyncSession, user_id: uuid.UUID, body: ActivityIn, *, key: str,
                          default_tz: str, now: datetime, max_age: timedelta, future_skew: timedelta,
                          producer: str) -> tuple[Plan, bool]:
    """→ (план, replayed). local_date — по зоне плана. Повтор с тем же Idempotency-Key — без новой записи и события."""
    occurred = body.occurred_at.astimezone(UTC) if body.occurred_at is not None else now
    p = await load_for_update(session, user_id, default_tz)
    existing = (
        await session.execute(select(Activity).where(Activity.user_id == user_id, Activity.idempotency_key == key))
    ).scalar_one_or_none()
    if existing is not None:
        same = existing.kind == body.kind and existing.minutes == body.minutes and (
            body.occurred_at is None or existing.recorded_at == occurred)
        if not same:
            raise IdempotencyReused
        return p, True
    if occurred > now + future_skew or occurred < now - max_age:
        raise unprocessable("ACTIVITY_INVALID", "Некорректное время занятия",
                            {"field": "occurred_at", "reason": "out_of_range"})
    activity = Activity(
        activity_id=uuid.uuid4(),
        user_id=user_id,
        local_date=sch.local_date(occurred, sch.zone(p.timezone)),
        kind=body.kind,
        minutes=body.minutes,
        idempotency_key=key,
        recorded_at=occurred,
    )
    session.add(activity)
    await session.flush()
    await emit(session, ACTIVITY_RECORDED, {
        "user_id": str(user_id),
        "activity_id": str(activity.activity_id),
        "local_date": activity.local_date.isoformat(),
        "kind": activity.kind,
        "minutes": activity.minutes,
        "recorded_at": occurred.isoformat().replace("+00:00", "Z"),
    }, producer=producer)
    return p, False


# ---------------------------------------------------------------- сага удаления


async def delete_user_data(session: AsyncSession, user_id: uuid.UUID, request_id: uuid.UUID,
                           causation_id: str | None, producer: str) -> None:
    """Физическое удаление плана, занятий, отметок, траекторий, проекций, пройденных уроков и их оценок
    (TG-FR-006) + ACK саге. Повтор снова подтверждает удаление.

    План удаляется первым: DELETE ждёт tick, который держит план FOR KEY SHARE, — после этого удаление отметок
    видит и отметку, которую tick успел записать (READ COMMITTED), сирот не остаётся."""
    await lock_user(session, user_id)
    await session.execute(delete(Plan).where(Plan.user_id == user_id))
    await session.execute(delete(Activity).where(Activity.user_id == user_id))
    await session.execute(delete(SlotMark).where(SlotMark.user_id == user_id))
    # спринт 3: ревизии траектории и проекции входов (диагностика, карта навыков, сегмент аудитории)
    await session.execute(delete(Trajectory).where(Trajectory.user_id == user_id))
    await session.execute(delete(LearnerDiagnostic).where(LearnerDiagnostic.user_id == user_id))
    await session.execute(delete(SkillStateProjection).where(SkillStateProjection.user_id == user_id))
    await session.execute(delete(LearnerAudience).where(LearnerAudience.user_id == user_id))
    # спринт 4: пройденные уроки и проекция их оценок (занятия из событий уроков — в activities, удалены выше)
    await session.execute(delete(CompletedLesson).where(CompletedLesson.user_id == user_id))
    await session.execute(delete(LessonEvaluation).where(LessonEvaluation.user_id == user_id))
    await session.execute(
        insert(DeletedUser).values(user_id=user_id, request_id=request_id).on_conflict_do_nothing(
            index_elements=["user_id"])
    )
    await emit(
        session,
        DOMAIN_DELETED,
        {"user_id": str(user_id), "request_id": str(request_id), "domain": DELETION_DOMAIN, "mode": "deleted"},
        producer=producer,
        causation_id=causation_id,
    )
