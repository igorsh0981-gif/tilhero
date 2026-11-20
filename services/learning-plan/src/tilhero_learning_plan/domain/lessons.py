"""Занятия по реальным урокам и пройденные уроки (INTERNAL_API спринта 4 §5, AT-46).

`lesson.session.completed.v1` (издатель — только lessons), status `completed`:
- **активность** (`activities`): kind `lesson` для сессии урока, `practice` — для сценария, медиа и повтора ошибок;
  минуты — из события (не больше 240, как у ручной активности); `local_date` — из события, нет — дата `finished_at`
  в часовом поясе плана (плана нет — зона по умолчанию). Одна запись на сессию (`session_id`): повтор события (и
  повторная публикация с новым event_id) минуты не удваивает. Новая запись — `learning.activity.recorded.v1`, как у
  ручной активности. График, серия, пропуски и напоминания (tick, TodayPlan) считаются по `activities` — день с
  уроком засчитан, пропуск по нему не выпускается.
- **пройденный урок** (`completed_lessons`, только kind `lesson`): строка на сессию; в траектории актуальна последняя
  сессия урока. Траектория пересчитывается при следующем чтении (входы basis изменились — новая ревизия).
`cancelled` / `failed` — не занятие и не пройденный урок.

Оценка сессии (R1-05) — проекция `lesson_evaluations`, сопоставление по session_id, события в любом порядке:
- `assessment.completed.v1` (издатель — только assessment; kind lesson): оценка сессии — в т. ч. полученная позже
  завершения (assessment был недоступен при finish: событие сессии ушло с `evaluation_id`/`passed` = null, оценку
  позже получил tick lessons). Пришла раньше события сессии — применяется при его записи;
- `assessment.reevaluated.v1` (издатель — только assessment): сессия — `session_id` события (обязателен в схеме после
  ревью спринта 4); запасной путь без него — по заменённой оценке (`supersedes`: проекция или пройденный урок с этой
  оценкой), пришла раньше заменённой — ждёт её (session_id null), затем session_id протягивается по цепочке.
  Пройденный без зачёта урок, исправленный переоценкой, уходит из «повторить», и наоборот.
Актуальна последняя оценка цепочки сессии (created_at); повтор события (inbox) и повторная публикация — без изменений.

Спринт 5 (INTERNAL_API спринта 5 §6, AT-59): kind `reading` (вопросы к тексту) — занятие `practice`;
`memory.review.completed.v1` (издатель — только memory, completed | expired) — занятие `review`: минуты из события,
`local_date` — дата `finished_at` в поясе плана, одно занятие на сессию повторения (ключ `review/<session_id>`),
0 минут не засчитывается. Серия, пропуски и напоминания учитывают его как любое занятие.

Ручная активность Mini App (`POST /internal/v1/me/activities`, спринт 1) остаётся для совместимости.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Final

from sqlalchemy import or_, select, update
from sqlalchemy.dialects.postgresql import distinct_on, insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import emit
from tilhero_learning_plan.domain import schedule as sch
from tilhero_learning_plan.domain.plans import ACTIVITY_RECORDED, lock_user
from tilhero_learning_plan.models import Activity, CompletedLesson, DeletedUser, LessonEvaluation, Plan

# kind сессии lessons → kind занятия (bff.ts SessionKind; review — повтор ошибок без влияния на освоение;
# спринт 5: reading — вопросы к тексту, практика)
ACTIVITY_KIND: Final = {"lesson": "lesson", "scenario": "practice", "media": "practice", "review": "practice",
                        "reading": "practice"}
MAX_ACTIVITY_MINUTES: Final = 240
SESSION_KEY_PREFIX: Final = "lesson/"  # «/» нет в Idempotency-Key клиента — ручной ключ не займёт ключ сессии
REVIEW_KEY_PREFIX: Final = "review/"  # спринт 5: «Повторение дня» memory — одно занятие на сессию повторения
MAX_CHAIN: Final = 100  # длина цепочки переоценок (защита от зацикливания при протягивании session_id)


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class SessionCompleted:
    session_id: uuid.UUID
    user_id: uuid.UUID
    kind: str
    pair_id: str
    lesson_id: str | None
    minutes: int
    local_date: date | None
    passed: bool | None
    evaluation_id: uuid.UUID | None
    finished_at: datetime


@dataclass(frozen=True)
class Recorded:
    activity: bool  # новая запись занятия (повтор события — False)
    lesson: bool  # новая строка пройденного урока


async def _deleted(session: AsyncSession, user_id: uuid.UUID) -> bool:
    """Под блокировкой ученика (та же, что у саги удаления): события после удаления данные не воскрешают."""
    await lock_user(session, user_id)
    return await session.get(DeletedUser, user_id) is not None


async def _plan_local_date(session: AsyncSession, user_id: uuid.UUID, at: datetime, default_tz: str) -> date:
    """Дата момента `at` в часовом поясе плана; плана нет (или зона неверна) — зона по умолчанию."""
    plan = await session.get(Plan, user_id)
    tz = plan.timezone if plan is not None and sch.is_valid_timezone(plan.timezone) else default_tz
    if not sch.is_valid_timezone(tz):
        tz = sch.FALLBACK_TIMEZONE
    return sch.local_date(at, sch.zone(tz))


async def _local_date(session: AsyncSession, ev: SessionCompleted, default_tz: str) -> date:
    if ev.local_date is not None:
        return ev.local_date
    return await _plan_local_date(session, ev.user_id, ev.finished_at, default_tz)


async def _insert_activity(session: AsyncSession, *, user_id: uuid.UUID, local: date, kind: str, minutes: int,
                           key: str, session_id: uuid.UUID, at: datetime, producer: str) -> bool:
    """Занятие по событию сессии (одно на session_id) + learning.activity.recorded.v1. → новая запись."""
    activity_id = uuid.uuid4()
    # без цели конфликта: и UNIQUE(user_id, idempotency_key), и частичный уникальный индекс session_id
    inserted = (await session.execute(
        insert(Activity).values(
            activity_id=activity_id, user_id=user_id, local_date=local, kind=kind, minutes=minutes,
            idempotency_key=key, recorded_at=at, session_id=session_id,
        ).on_conflict_do_nothing().returning(Activity.activity_id)
    )).scalar_one_or_none()
    if inserted is None:
        return False
    await emit(session, ACTIVITY_RECORDED, {
        "user_id": str(user_id),
        "activity_id": str(activity_id),
        "local_date": local.isoformat(),
        "kind": kind,
        "minutes": minutes,
        "recorded_at": iso(at),
    }, producer=producer)
    return True


async def record_session(session: AsyncSession, ev: SessionCompleted, *, default_tz: str,
                         producer: str) -> Recorded:
    """Завершённая сессия → занятие (+ пройденный урок для kind lesson). Идемпотентно по session_id."""
    if await _deleted(session, ev.user_id):
        return Recorded(False, False)
    local = await _local_date(session, ev, default_tz)
    inserted = await _insert_activity(
        session, user_id=ev.user_id, local=local, kind=ACTIVITY_KIND[ev.kind],
        minutes=max(0, min(ev.minutes, MAX_ACTIVITY_MINUTES)), key=f"{SESSION_KEY_PREFIX}{ev.session_id}",
        session_id=ev.session_id, at=ev.finished_at, producer=producer)
    lesson = False
    if ev.kind == "lesson" and ev.lesson_id:
        row = (await session.execute(
            insert(CompletedLesson).values(
                session_id=ev.session_id, user_id=ev.user_id, pair_id=ev.pair_id, lesson_id=ev.lesson_id,
                passed=ev.passed, evaluation_id=ev.evaluation_id, completed_at=ev.finished_at,
            ).on_conflict_do_nothing(index_elements=["session_id"]).returning(CompletedLesson.session_id)
        )).scalar_one_or_none()
        lesson = row is not None
        # оценка (и переоценка) могла прийти раньше события сессии: переоценка, ждавшая оценку из события, получает
        # session_id; затем — актуальная оценка сессии из проекции
        if ev.evaluation_id is not None:
            await _propagate(session, ev.user_id, ev.session_id, [ev.evaluation_id])
        await _apply_latest(session, ev.user_id, ev.session_id)
    return Recorded(inserted, lesson)


# ---------------------------------------------------------------- «Повторение дня» memory (спринт 5)


@dataclass(frozen=True)
class ReviewCompleted:
    session_id: uuid.UUID
    user_id: uuid.UUID
    minutes: int
    finished_at: datetime


async def record_review(session: AsyncSession, ev: ReviewCompleted, *, default_tz: str, producer: str) -> bool:
    """memory.review.completed.v1 (completed | expired) → занятие kind `review`: минуты из события, `local_date` —
    дата `finished_at` в поясе плана. Идемпотентно по session_id. 0 минут — не занятие (день не засчитывается).
    → новая запись."""
    if ev.minutes <= 0:
        return False
    if await _deleted(session, ev.user_id):
        return False
    local = await _plan_local_date(session, ev.user_id, ev.finished_at, default_tz)
    return await _insert_activity(
        session, user_id=ev.user_id, local=local, kind="review", minutes=min(ev.minutes, MAX_ACTIVITY_MINUTES),
        key=f"{REVIEW_KEY_PREFIX}{ev.session_id}", session_id=ev.session_id, at=ev.finished_at, producer=producer)


# ---------------------------------------------------------------- оценки уроков (R1-05)


async def _propagate(session: AsyncSession, user_id: uuid.UUID, session_id: uuid.UUID,
                     evaluation_ids: list[uuid.UUID]) -> None:
    """session_id — переоценкам, пришедшим раньше заменённой оценки (по цепочке supersedes)."""
    c = LessonEvaluation.__table__.c
    ids = list(evaluation_ids)
    for _ in range(MAX_CHAIN):
        if not ids:
            return
        ids = list((await session.execute(
            update(LessonEvaluation)
            .where(c.user_id == user_id, c.supersedes.in_(ids), c.session_id.is_(None))
            .values(session_id=session_id)
            .returning(c.evaluation_id)
        )).scalars().all())


async def _apply_latest(session: AsyncSession, user_id: uuid.UUID, session_id: uuid.UUID) -> int:
    """Пройденному уроку сессии — актуальная (последняя) оценка из проекции. Нет оценки или урока — без изменений."""
    e = LessonEvaluation.__table__.c
    latest = (await session.execute(
        select(e.evaluation_id, e.passed)
        .where(e.user_id == user_id, e.session_id == session_id)
        .order_by(e.created_at.desc(), e.recorded_at.desc(), e.evaluation_id)
        .limit(1)
    )).first()
    if latest is None:
        return 0
    c = CompletedLesson.__table__.c
    result = await session.execute(
        update(CompletedLesson)
        .where(c.session_id == session_id, c.user_id == user_id,
               or_(c.evaluation_id.is_distinct_from(latest.evaluation_id), c.passed.is_distinct_from(latest.passed)))
        .values(evaluation_id=latest.evaluation_id, passed=latest.passed, updated_at=datetime.now(UTC))
    )
    return int(getattr(result, "rowcount", 0) or 0)


async def _session_of(session: AsyncSession, user_id: uuid.UUID, evaluation_id: uuid.UUID) -> uuid.UUID | None:
    """Сессия оценки ученика: из проекции, иначе — пройденный урок с этой оценкой (из события сессии)."""
    e = LessonEvaluation.__table__.c
    known = (await session.execute(
        select(e.session_id).where(e.user_id == user_id, e.evaluation_id == evaluation_id)
    )).scalar_one_or_none()
    if known is not None:
        return known
    c = CompletedLesson.__table__.c
    return (await session.execute(
        select(c.session_id).where(c.user_id == user_id, c.evaluation_id == evaluation_id).limit(1)
    )).scalar_one_or_none()


async def apply_evaluation(session: AsyncSession, *, user_id: uuid.UUID, session_id: uuid.UUID,
                           evaluation_id: uuid.UUID, passed: bool | None, created_at: datetime) -> int:
    """assessment.completed.v1 (kind lesson): оценка сессии → проекция; пройденный урок сессии (если событие сессии
    уже пришло) получает актуальную оценку. Повтор — без изменений. → число изменённых пройденных уроков."""
    if await _deleted(session, user_id):
        return 0
    await session.execute(
        insert(LessonEvaluation).values(
            evaluation_id=evaluation_id, user_id=user_id, session_id=session_id, supersedes=None, passed=passed,
            created_at=created_at,
        ).on_conflict_do_nothing(index_elements=["evaluation_id"])
    )
    await _propagate(session, user_id, session_id, [evaluation_id])
    return await _apply_latest(session, user_id, session_id)


async def apply_reevaluation(session: AsyncSession, *, user_id: uuid.UUID, supersedes: uuid.UUID,
                             evaluation_id: uuid.UUID, passed: bool | None, created_at: datetime,
                             session_id: uuid.UUID | None = None) -> int:
    """assessment.reevaluated.v1: сессия — из события, если издатель её передал, иначе по заменённой оценке (в схеме
    v1 session_id нет). Заменённая ещё не известна — запись ждёт её (session_id null). Повтор — без изменений.
    → число изменённых пройденных уроков."""
    if await _deleted(session, user_id):
        return 0
    session_id = session_id or await _session_of(session, user_id, supersedes)
    await session.execute(
        insert(LessonEvaluation).values(
            evaluation_id=evaluation_id, user_id=user_id, session_id=session_id, supersedes=supersedes,
            passed=passed, created_at=created_at,
        ).on_conflict_do_nothing(index_elements=["evaluation_id"])
    )
    if session_id is None:
        return 0
    await _propagate(session, user_id, session_id, [evaluation_id])
    return await _apply_latest(session, user_id, session_id)


@dataclass(frozen=True)
class LessonResult:
    """Последняя завершённая сессия урока ученика по паре."""

    lesson_id: str
    session_id: uuid.UUID
    passed: bool | None
    evaluation_id: uuid.UUID | None
    completed_at: datetime


async def latest_results(session: AsyncSession, user_id: uuid.UUID, pair_id: str) -> list[LessonResult]:
    """По последней сессии каждого урока (completed_at, затем время записи), новые первыми."""
    c = CompletedLesson.__table__.c
    rows = (await session.execute(
        select(c.lesson_id, c.session_id, c.passed, c.evaluation_id, c.completed_at)
        .where(c.user_id == user_id, c.pair_id == pair_id)
        .ext(distinct_on(c.lesson_id))
        .order_by(c.lesson_id, c.completed_at.desc(), c.recorded_at.desc(), c.session_id)
    )).all()
    results = [LessonResult(r.lesson_id, r.session_id, r.passed, r.evaluation_id, r.completed_at) for r in rows]
    results.sort(key=lambda r: (r.completed_at, r.lesson_id), reverse=True)
    return results


def results_hash(results: list[LessonResult]) -> str:
    """Отпечаток пройденных уроков для basis траектории: новая сессия урока или переоценка — новая ревизия."""
    lines = sorted(f"{r.lesson_id}|{r.session_id}|{r.passed}|{r.evaluation_id}" for r in results)
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()[:24]
