"""Потребители событий learning-plan (inbox-дедупликация в Runtime.add_consumer).

- `user.deletion.requested.v1` (identity-consent) — сага удаления;
- спринт 3 (INTERNAL_API §3) — входы траектории уроков, только проекции (пересчёт — при следующем чтении):
  `diagnostics.completed.v1` и `skills.state.changed.v1` (diagnostics) — последний результат диагностики и карта
  навыков; `catalog.version.published.v1` (catalog; kind course|module|lesson|skill) — снимок курса помечается
  устаревшим; `user.profile.created/updated.v1` (identity-consent) — сегмент аудитории kids|teens|adults для подбора
  уроков (детям 6–13 — только детские), возраст не хранится;
- спринт 4 (INTERNAL_API §5, AT-46/47): `lesson.session.completed.v1` (lessons) — занятие дня по реальному уроку или
  практике (идемпотентно по session_id) и пройденный урок (траектория — при следующем чтении);
  `assessment.completed.v1` (assessment, kind lesson) — оценка сессии, в т. ч. полученная после завершения
  (R1-05; сопоставление по session_id, порядок событий любой); `assessment.reevaluated.v1` (assessment) — новый исход
  пройденного урока после переоценки (сессия — по заменённой оценке: session_id в событии нет);
- спринт 5 (INTERNAL_API §6, AT-59): `memory.review.completed.v1` (memory) — занятие `review` («Повторение дня»,
  идемпотентно по session_id, 0 минут не засчитывается); kind `reading` у событий уроков — практика;
- спринт 6 (INTERNAL_API спринта 6 §2, AT-66): `game.streak.frozen.v1` (только gamification) — день закрыт
  заморозкой серии (`frozen_days`, повтор ничего не меняет): пропуск этого дня не рвёт серию и цепочку пропусков,
  неделя TodayPlan показывает `frozen`. Единственное обратное влияние игры на учёбу.

Издатель проверяется (защита в глубину, как у саги, ревью P-7): событие чужого издателя — предупреждение в логе
(тип события и издатель, без user_id) и подтверждение шине без действия. Невалидный payload — исключение → DLQ.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_learning_plan.domain import lessons as ls
from tilhero_learning_plan.domain import trajectory as tr
from tilhero_learning_plan.domain.plans import delete_user_data, record_frozen_day

DELETION_REQUESTED = "user.deletion.requested.v1"
DIAGNOSTICS_COMPLETED = "diagnostics.completed.v1"
SKILLS_CHANGED = "skills.state.changed.v1"
VERSION_PUBLISHED = "catalog.version.published.v1"
PROFILE_CREATED = "user.profile.created.v1"
PROFILE_UPDATED = "user.profile.updated.v1"
SESSION_COMPLETED = "lesson.session.completed.v1"
REEVALUATED = "assessment.reevaluated.v1"
ASSESSMENT_COMPLETED = "assessment.completed.v1"
REVIEW_COMPLETED = "memory.review.completed.v1"
STREAK_FROZEN = "game.streak.frozen.v1"
PRODUCER = "learning-plan"
# Сагу удаления ведёт только identity-consent: запрос от другого издателя не исполняется (защита в глубину, P-7)
DELETION_PRODUCERS = frozenset({"identity-consent"})
PRODUCERS = {
    DIAGNOSTICS_COMPLETED: frozenset({"diagnostics"}),
    SKILLS_CHANGED: frozenset({"diagnostics"}),
    VERSION_PUBLISHED: frozenset({"catalog"}),
    PROFILE_CREATED: frozenset({"identity-consent"}),
    PROFILE_UPDATED: frozenset({"identity-consent"}),
    SESSION_COMPLETED: frozenset({"lessons"}),
    REEVALUATED: frozenset({"assessment"}),
    ASSESSMENT_COMPLETED: frozenset({"assessment"}),
    REVIEW_COMPLETED: frozenset({"memory"}),
    STREAK_FROZEN: frozenset({"gamification"}),
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


class SessionCompletedIn(_Payload):
    """lesson.session.completed.v1 (схема — packages/contracts/events)."""

    session_id: uuid.UUID
    user_id: uuid.UUID
    kind: Literal["lesson", "scenario", "media", "review", "reading"]
    pair_id: Annotated[str, Field(min_length=1, max_length=200)]
    lesson_id: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    status: Literal["completed", "cancelled", "failed"]
    minutes: Annotated[int, Field(ge=0, le=600)]
    local_date: date | None = None
    evaluation_id: uuid.UUID | None = None
    passed: bool | None = None
    practice_only: bool
    finished_at: AwareDatetime


class ReevaluatedIn(_Payload):
    """assessment.reevaluated.v1: нужны только ученик, заменённая и новая оценка, вердикт и время записи.
    session_id в схеме v1 нет — если издатель его добавит, используется напрямую (иначе — по заменённой оценке)."""

    evaluation_id: uuid.UUID
    supersedes: uuid.UUID
    user_id: uuid.UUID
    passed: bool | None = None
    created_at: AwareDatetime
    session_id: uuid.UUID | None = None


class AssessmentCompletedIn(_Payload):
    """assessment.completed.v1: ученик, сессия, вид, оценка, вердикт и время записи (исходы навыков — diagnostics)."""

    evaluation_id: uuid.UUID
    user_id: uuid.UUID
    session_id: uuid.UUID
    kind: Literal["lesson", "scenario", "media", "review", "reading"]
    passed: bool | None = None
    created_at: AwareDatetime


class ReviewCompletedIn(_Payload):
    """memory.review.completed.v1 (спринт 5): «Повторение дня» завершено или истекло с ответами."""

    session_id: uuid.UUID
    user_id: uuid.UUID
    pair_id: Annotated[str, Field(min_length=1, max_length=200)]
    status: Literal["completed", "expired"]
    minutes: Annotated[int, Field(ge=0, le=60)]
    reviewed: Annotated[int, Field(ge=0)]
    correct: Annotated[int, Field(ge=0)]
    finished_at: AwareDatetime


class StreakFrozenIn(_Payload):
    """game.streak.frozen.v1 (спринт 6): нужны ученик, день и операция списания; freeze_left — для уведомлений."""

    user_id: uuid.UUID
    local_date: date
    op_id: uuid.UUID
    frozen_at: AwareDatetime


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


def lessons_handler(default_tz: str) -> Handler:
    """Обработчик событий уроков с зоной плана по умолчанию (настройка сервиса DEFAULT_TIMEZONE)."""

    async def on_lessons(session: AsyncSession, env: Envelope) -> None:
        """lesson.session.completed.v1 → занятие (+ пройденный урок); cancelled / failed — без действия.
        assessment.completed.v1 (kind lesson) → оценка сессии; assessment.reevaluated.v1 → новый исход пройденного
        урока с заменённой оценкой. Порядок событий любой (оценка может прийти раньше события сессии)."""
        if _foreign(env):
            return
        if env.event_type == ASSESSMENT_COMPLETED:
            a = AssessmentCompletedIn.model_validate(env.payload)
            if a.kind != "lesson":
                return  # пройденные уроки — только kind lesson; практика на траекторию не влияет
            updated = await ls.apply_evaluation(session, user_id=a.user_id, session_id=a.session_id,
                                                evaluation_id=a.evaluation_id, passed=a.passed,
                                                created_at=a.created_at)
            log.info("lesson evaluation recorded", extra={"updated": updated})
            return
        if env.event_type == REEVALUATED:
            r = ReevaluatedIn.model_validate(env.payload)
            updated = await ls.apply_reevaluation(session, user_id=r.user_id, supersedes=r.supersedes,
                                                  evaluation_id=r.evaluation_id, passed=r.passed,
                                                  created_at=r.created_at, session_id=r.session_id)
            log.info("lesson result reevaluated", extra={"updated": updated})
            return
        c = SessionCompletedIn.model_validate(env.payload)
        if c.status != "completed":
            return  # отменённая или прерванная сессия — не занятие и не пройденный урок
        if not _pair_ok(c.pair_id, env):
            return
        recorded = await ls.record_session(session, ls.SessionCompleted(
            session_id=c.session_id, user_id=c.user_id, kind=c.kind, pair_id=c.pair_id, lesson_id=c.lesson_id,
            minutes=c.minutes, local_date=c.local_date, passed=c.passed, evaluation_id=c.evaluation_id,
            finished_at=c.finished_at,
        ), default_tz=default_tz, producer=PRODUCER)
        log.info("lesson session recorded", extra={"kind": c.kind, "activity": recorded.activity,
                                                   "lesson": recorded.lesson})

    return on_lessons


def memory_handler(default_tz: str) -> Handler:
    """Обработчик событий memory с зоной плана по умолчанию (настройка сервиса DEFAULT_TIMEZONE)."""

    async def on_memory(session: AsyncSession, env: Envelope) -> None:
        """memory.review.completed.v1 → занятие kind review (день графика и серия); 0 минут — не занятие.
        Идемпотентно по session_id; чужой издатель — только лог."""
        if _foreign(env):
            return
        r = ReviewCompletedIn.model_validate(env.payload)
        recorded = await ls.record_review(session, ls.ReviewCompleted(
            session_id=r.session_id, user_id=r.user_id, minutes=r.minutes, finished_at=r.finished_at,
        ), default_tz=default_tz, producer=PRODUCER)
        log.info("review session recorded", extra={"status": r.status, "activity": recorded})

    return on_memory


async def on_streak_frozen(session: AsyncSession, env: Envelope) -> None:
    """game.streak.frozen.v1 → день закрыт заморозкой (`frozen_days`). Повтор доставки — inbox; повторная публикация
    (новый event_id) — ON CONFLICT по (ученик, день). После удаления ученика — без действия. Чужой издатель — лог."""
    if _foreign(env):
        return
    f = StreakFrozenIn.model_validate(env.payload)
    inserted = await record_frozen_day(session, f.user_id, f.local_date, f.op_id)
    log.info("streak freeze recorded", extra={"inserted": inserted})


CONSUMERS: dict[str, tuple[list[str], Handler]] = {
    "learning-plan.user_deletion": ([DELETION_REQUESTED], on_deletion_requested),
    "learning-plan.diagnostics": ([DIAGNOSTICS_COMPLETED, SKILLS_CHANGED], on_diagnostics),
    "learning-plan.catalog": ([VERSION_PUBLISHED], on_catalog),
    "learning-plan.profiles": ([PROFILE_CREATED, PROFILE_UPDATED], on_profile),
    "learning-plan.game": ([STREAK_FROZEN], on_streak_frozen),
}
LESSONS_DURABLE = "learning-plan.lessons"
LESSONS_EVENTS = [SESSION_COMPLETED, ASSESSMENT_COMPLETED, REEVALUATED]
MEMORY_DURABLE = "learning-plan.memory"
MEMORY_EVENTS = [REVIEW_COMPLETED]


def consumers(default_tz: str) -> dict[str, tuple[list[str], Handler]]:
    """Все потребители сервиса (спринт 4: события уроков, спринт 5: повторения memory — с зоной по умолчанию)."""
    return {**CONSUMERS, LESSONS_DURABLE: (LESSONS_EVENTS, lessons_handler(default_tz)),
            MEMORY_DURABLE: (MEMORY_EVENTS, memory_handler(default_tz))}
