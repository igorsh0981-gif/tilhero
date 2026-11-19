"""Траектория уроков ученика (INTERNAL_API §3): снимок курса с кешем по ETag, проекции входов (диагностика, карта
навыков, сегмент аудитории), ревизии и событие `learning.trajectory.updated.v1`.

Пересчёт — при чтении (`GET /internal/v1/plan/trajectory`): входы (basis) сравниваются с последней ревизией;
совпали — отдаётся она, изменились (новая диагностика, навык освоен, цель или темы, аудитория, новый снимок курса,
версия правил) — считается и сохраняется новая ревизия (прежние остаются), в той же транзакции — событие. Поэтому
события-входы (diagnostics, skills, catalog) и смена цели в PATCH плана только обновляют проекции/помечают снимок
устаревшим — без обращения к catalog и без пересчёта (отложенно, при следующем чтении).

Снимок курса: `GET {CATALOG_URL}/internal/v1/courses/{course_id}/snapshot` (внутренний JWT без sub). Кеш — таблица
`course_snapshots` (общая для реплик, переживает рестарт): моложе `CATALOG_SNAPSHOT_MAX_AGE_SECONDS` и не помечен
устаревшим — без запроса; иначе `If-None-Match` → 304 (кеш подтверждён) | 200 (новый снимок). catalog недоступен
(сеть, 5xx, circuit breaker, неверный ответ): есть кеш — расчёт по нему, нет — 503 `CATALOG_UNAVAILABLE`; 404 —
курс не опубликован → 409 `PAIR_NOT_AVAILABLE`. HTTP-запрос идёт вне транзакции БД.
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast

from pydantic import ValidationError
from sqlalchemy import case, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, conflict, unavailable
from tilhero_common.http_client import ServiceClient, UpstreamError
from tilhero_common.messaging import emit
from tilhero_learning_plan.domain.curriculum import (
    ALGORITHM,
    AreaResult,
    Diagnostic,
    Learner,
    Planned,
    TrajectoryPlan,
    explain,
    plan_trajectory,
)
from tilhero_learning_plan.domain.plans import lock_user, user_deleted
from tilhero_learning_plan.domain.snapshot import CourseSnapshot
from tilhero_learning_plan.models import (
    CourseSnapshotCache,
    DeletedUser,
    LearnerAudience,
    LearnerDiagnostic,
    Plan,
    SkillStateProjection,
    Trajectory,
)
from tilhero_learning_plan.settings import Settings

log = logging.getLogger("tilhero.learning_plan.trajectory")

CATALOG = "catalog"
TRAJECTORY_UPDATED = "learning.trajectory.updated.v1"
# Сегмент неизвестен (нет проекции профиля и BFF не передал) — самый строгий набор уроков: только детские
UNKNOWN_AUDIENCE = "kids"
KID_BANDS = frozenset({"6-9", "10-13"})
STALE_KINDS = frozenset({"course", "module", "lesson", "skill"})
MAX_EVENT_REASONS = 10


def pair_not_available(pair_id: str) -> ApiError:
    return conflict("PAIR_NOT_AVAILABLE", "Языковая пара пока недоступна", {"pair_id": pair_id})


def catalog_unavailable() -> ApiError:
    return unavailable("CATALOG_UNAVAILABLE", "Каталог курса временно недоступен — попробуйте позже")


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def real_now() -> datetime:
    """Часы кеша снимка — всегда реальные (их же ставит потребитель событий catalog), независимо от часов запроса."""
    return datetime.now(UTC)


# ---------------------------------------------------------------- снимок курса (catalog)


class CatalogUnavailable(Exception):
    pass


class CourseNotPublished(Exception):
    pass


@dataclass(frozen=True)
class Fetched:
    not_modified: bool
    etag: str | None = None
    snapshot: CourseSnapshot | None = None
    payload: dict[str, Any] | None = None


async def fetch_snapshot(client: ServiceClient, course_id: str, etag: str | None) -> Fetched:
    headers = {"If-None-Match": etag} if etag else None
    try:
        resp = await client.get(f"/internal/v1/courses/{course_id}/snapshot", headers=headers, raw=True)
    except UpstreamError as exc:
        if exc.status == 404:
            raise CourseNotPublished from exc
        log.warning("catalog snapshot request failed", extra={"status": exc.status, "error_code": exc.code})
        raise CatalogUnavailable from exc
    if resp.status_code == 304 and etag:
        return Fetched(not_modified=True, etag=etag)
    if resp.status_code != 200:
        log.warning("catalog snapshot unexpected status", extra={"status": resp.status_code})
        raise CatalogUnavailable
    try:
        payload = resp.json()
        snapshot = CourseSnapshot.model_validate(payload)
    except (ValueError, ValidationError) as exc:
        # контракт CourseSnapshot нарушен — как недоступный catalog (в лог — только тип ошибки)
        log.error("catalog snapshot invalid", extra={"error_type": type(exc).__name__})
        raise CatalogUnavailable from exc
    if snapshot.course_id != course_id:
        log.error("catalog snapshot for another course")
        raise CatalogUnavailable
    new_etag = (resp.headers.get("etag") or f'"{snapshot.snapshot_version}"').strip()[:200]
    return Fetched(not_modified=False, etag=new_etag, snapshot=snapshot, payload=cast(dict[str, Any], payload))


def _keep_stale_after(started: datetime) -> Any:
    """Пометку «устарел» снимаем, только если она поставлена до начала запроса (событие, пришедшее во время
    запроса к catalog, не теряется)."""
    c = CourseSnapshotCache.__table__.c
    return case((c.stale_since > started, c.stale_since), else_=None)


async def store_snapshot(session: AsyncSession, course_id: str, fetched: Fetched, *, started: datetime,
                         etag_sent: str | None) -> None:
    now = real_now()
    c = CourseSnapshotCache.__table__.c
    if fetched.not_modified:
        await session.execute(
            update(CourseSnapshotCache)
            .where(c.course_id == course_id, c.etag == etag_sent)
            .values(checked_at=now, stale_since=_keep_stale_after(started))
        )
        return
    assert fetched.snapshot is not None and fetched.payload is not None and fetched.etag is not None
    stmt = insert(CourseSnapshotCache).values(
        course_id=course_id,
        pair_id=fetched.snapshot.pair_id,
        etag=fetched.etag,
        snapshot_version=fetched.snapshot.snapshot_version,
        payload=fetched.payload,
        fetched_at=now,
        checked_at=now,
        stale_since=None,
    )
    await session.execute(stmt.on_conflict_do_update(
        index_elements=["course_id"],
        set_={
            "pair_id": stmt.excluded.pair_id,
            "etag": stmt.excluded.etag,
            "snapshot_version": stmt.excluded.snapshot_version,
            "payload": stmt.excluded.payload,
            "fetched_at": stmt.excluded.fetched_at,
            "checked_at": stmt.excluded.checked_at,
            "stale_since": _keep_stale_after(started),
        },
    ))


async def mark_snapshots_stale(session: AsyncSession, course_id: str | None) -> int:
    """catalog.version.published.v1: снимок курса (или все, если курс не указан) перепроверяется при следующем
    чтении траектории → новый snapshot_version → новая ревизия траекторий учеников при их следующем чтении."""
    c = CourseSnapshotCache.__table__.c
    stmt = update(CourseSnapshotCache).values(stale_since=real_now())
    if course_id is not None:
        stmt = stmt.where(c.course_id == course_id)
    result = await session.execute(stmt)
    return int(getattr(result, "rowcount", 0) or 0)


def _parse_cached(row: CourseSnapshotCache | None, course_id: str) -> CourseSnapshot | None:
    if row is None:
        return None
    try:
        return CourseSnapshot.model_validate(row.payload)
    except ValidationError:
        log.error("cached course snapshot invalid, refetching", extra={"course_id": course_id})
        return None


# ---------------------------------------------------------------- входы ученика


def audience_from_profile(kind: str | None, age_band: str | None) -> str:
    """Сегмент из профиля identity-consent: детский профиль / 6–13 — kids, 14–17 — teens, иначе (18+, возраст
    аккаунта не выбран) — adults (как ageSegment в telegram-bff)."""
    if kind == "child" or age_band in KID_BANDS:
        return "kids"
    if age_band == "14-17":
        return "teens"
    return "adults"


def effective_audience(hint: str | None, projected: str | None) -> str:
    """Детский сегмент «липкий»: если ребёнок по любому источнику — только детские уроки. Подсказка BFF (`?audience=`,
    из свежего профиля identity-consent) важнее проекции; ничего не известно — kids (самый строгий набор)."""
    if hint == "kids" or projected == "kids":
        return "kids"
    return hint or projected or UNKNOWN_AUDIENCE


def _diagnostic(row: LearnerDiagnostic | None) -> Diagnostic | None:
    if row is None:
        return None
    areas: dict[str, AreaResult] = {}
    for area, value in (row.areas or {}).items():
        if isinstance(value, Mapping):
            band = value.get("band")
            areas[str(area)] = AreaResult(str(value.get("status") or "not_assessed"),
                                          band if isinstance(band, str) else None)
    return Diagnostic(
        result_id=str(row.result_id),
        revision=row.revision,
        provisional_level=row.provisional_level,
        areas=areas,
        recommended_start_lesson_id=row.recommended_start_lesson_id,
    )


async def load_learner(session: AsyncSession, user_id: uuid.UUID, pair_id: str, audience_hint: str | None) -> Learner:
    plan = await session.get(Plan, user_id)
    diag = await session.get(LearnerDiagnostic, (user_id, pair_id))
    skills = (
        await session.execute(
            select(SkillStateProjection.skill_id, SkillStateProjection.state).where(
                SkillStateProjection.user_id == user_id, SkillStateProjection.pair_id == pair_id)
        )
    ).all()
    aud = await session.get(LearnerAudience, user_id)
    return Learner(
        audience=effective_audience(audience_hint, aud.audience if aud is not None else None),
        goal=plan.goal if plan is not None else None,
        topics=tuple(plan.topics) if plan is not None else (),
        diagnostic=_diagnostic(diag),
        skills={skill_id: state for skill_id, state in skills},
    )


def mastered_hash(learner: Learner) -> str:
    """Отпечаток освоенных навыков: траекторию меняет только освоение (learning ↔ not_started — нет)."""
    mastered = sorted(skill for skill in learner.skills if learner.mastered(skill))
    return hashlib.sha256("\n".join(mastered).encode()).hexdigest()[:24]


def make_basis(learner: Learner, snapshot_version: str) -> dict[str, Any]:
    d = learner.diagnostic
    return {
        "algorithm": ALGORITHM,
        "audience": learner.audience,
        "goal": learner.goal,
        "topics": sorted(learner.topics),
        "diagnostic_result_id": d.result_id if d is not None else None,
        "diagnostic_revision": d.revision if d is not None else None,
        "course_snapshot_version": snapshot_version,
        "skills_hash": mastered_hash(learner),
    }


# ---------------------------------------------------------------- ревизии


def _entry(p: Planned) -> dict[str, Any]:
    return {**p.lesson.card(), "reason_codes": list(p.reason_codes)}


def items_of(plan: TrajectoryPlan, learner: Learner) -> dict[str, Any]:
    nxt = plan.next
    return {
        "next": (
            {**_entry(nxt), "explanation": explain(nxt.reason_codes, goal=learner.goal,
                                                    kids=learner.audience == "kids")}
            if nxt is not None else None
        ),
        "mandatory": [_entry(p) for p in plan.mandatory],
        "optional": [_entry(p) for p in plan.optional],
    }


def render(row: Trajectory) -> dict[str, Any]:
    """Trajectory (bff.ts). Пройденные уроки и сами уроки — спринт 4."""
    items = row.items
    return {
        "pair_id": row.pair_id,
        "course_id": row.course_id,
        "revision": row.revision,
        "basis": {
            "diagnostic_result_id": row.basis.get("diagnostic_result_id"),
            "goal": row.basis.get("goal"),
            "computed_at": iso(row.computed_at),
        },
        "next": items.get("next"),
        "mandatory": items.get("mandatory", []),
        "optional": items.get("optional", []),
        "completed": [],
        "lessons_available": False,
    }


async def latest_revision(session: AsyncSession, user_id: uuid.UUID, pair_id: str) -> Trajectory | None:
    return (
        await session.execute(
            select(Trajectory)
            .where(Trajectory.user_id == user_id, Trajectory.pair_id == pair_id)
            .order_by(Trajectory.revision.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def get_trajectory(rt: Runtime, *, user_id: uuid.UUID, pair_id: str, audience_hint: str | None,
                         now: datetime) -> dict[str, Any]:
    settings = cast(Settings, rt.settings)
    course_id = settings.pair_courses.get(pair_id)
    if course_id is None:
        raise pair_not_available(pair_id)

    async with rt.transaction() as session:
        if await session.get(DeletedUser, user_id) is not None:
            raise user_deleted()
        cached = await session.get(CourseSnapshotCache, course_id)
        snapshot = _parse_cached(cached, course_id)
        # невалидный кеш (например, после смены модели) — как отсутствующий: безусловный запрос и замена
        cached_etag = cached.etag if cached is not None and snapshot is not None else None
        fresh = (
            cached is not None
            and snapshot is not None
            and cached.stale_since is None
            and (real_now() - cached.checked_at).total_seconds() < settings.catalog_snapshot_max_age_seconds
        )

    fetched: Fetched | None = None
    started = real_now()
    if not fresh:
        try:
            fetched = await fetch_snapshot(rt.client(CATALOG), course_id, cached_etag)
        except CourseNotPublished:
            raise pair_not_available(pair_id) from None
        except CatalogUnavailable:
            if snapshot is None:
                raise catalog_unavailable() from None
            log.warning("catalog unavailable, cached course snapshot used", extra={"course_id": course_id})
        else:
            if fetched.snapshot is not None:
                snapshot = fetched.snapshot
    if snapshot is None:  # 304 без кеша не бывает (If-None-Match шлётся только с валидным кешем)
        raise catalog_unavailable()

    async with rt.transaction() as session:
        if fetched is not None:
            await store_snapshot(session, course_id, fetched, started=started, etag_sent=cached_etag)
        await lock_user(session, user_id)
        if await session.get(DeletedUser, user_id) is not None:
            raise user_deleted()
        learner = await load_learner(session, user_id, pair_id, audience_hint)
        latest = await latest_revision(session, user_id, pair_id)
        basis = make_basis(learner, snapshot.snapshot_version)
        if latest is not None and latest.basis == basis and latest.course_id == course_id:
            return render(latest)

        plan = plan_trajectory(snapshot, learner, optional_max=settings.optional_lessons_max)
        nxt = plan.next
        revision = Trajectory(
            user_id=user_id,
            pair_id=pair_id,
            revision=(latest.revision + 1) if latest is not None else 1,
            course_id=course_id,
            basis=basis,
            next_lesson_id=nxt.lesson.lesson_id if nxt is not None else None,
            items=items_of(plan, learner),
            computed_at=now,
        )
        session.add(revision)
        await session.flush()
        await emit(session, TRAJECTORY_UPDATED, {
            "user_id": str(user_id),
            "pair_id": pair_id,
            "revision": revision.revision,
            "next_lesson_id": revision.next_lesson_id,
            "reason_codes": list(nxt.reason_codes)[:MAX_EVENT_REASONS] if nxt is not None else [],
            "computed_at": iso(now),
        }, producer=settings.service_name)
        log.info("trajectory revision computed",
                 extra={"pair_id": pair_id, "revision": revision.revision,
                        "mandatory": len(plan.mandatory), "optional": len(plan.optional)})
        return render(revision)


# ---------------------------------------------------------------- проекции (потребители событий)


async def _skip_deleted(session: AsyncSession, user_id: uuid.UUID) -> bool:
    """Под блокировкой ученика (та же, что у саги удаления): события после удаления проекции не воскрешают."""
    await lock_user(session, user_id)
    return await session.get(DeletedUser, user_id) is not None


async def project_diagnostic(session: AsyncSession, *, user_id: uuid.UUID, pair_id: str, result_id: uuid.UUID,
                             revision: int, test_id: str, test_version: int, provisional_level: str | None,
                             areas: dict[str, Any], recommended_start_lesson_id: str | None,
                             completed_at: datetime) -> bool:
    """Последний результат по паре; более старое (по completed_at, затем revision) событие не перезаписывает."""
    if await _skip_deleted(session, user_id):
        return False
    stmt = insert(LearnerDiagnostic).values(
        user_id=user_id, pair_id=pair_id, result_id=result_id, revision=revision, test_id=test_id,
        test_version=test_version, provisional_level=provisional_level, areas=areas,
        recommended_start_lesson_id=recommended_start_lesson_id, completed_at=completed_at, updated_at=real_now(),
    )
    t = LearnerDiagnostic.__table__.c
    newer = (stmt.excluded.completed_at > t.completed_at) | (
        (stmt.excluded.completed_at == t.completed_at) & (stmt.excluded.revision > t.revision))
    result = await session.execute(stmt.on_conflict_do_update(
        index_elements=["user_id", "pair_id"],
        set_={name: getattr(stmt.excluded, name) for name in (
            "result_id", "revision", "test_id", "test_version", "provisional_level", "areas",
            "recommended_start_lesson_id", "completed_at", "updated_at")},
        where=newer,
    ))
    return bool(getattr(result, "rowcount", 0))


async def project_skills(session: AsyncSession, *, user_id: uuid.UUID, pair_id: str,
                         changes: list[tuple[str, str, str]], occurred_at: datetime) -> int:
    """changes: [(skill_id, to, source)]; повтор навыка в одном событии — последнее значение. Изменение старше
    сохранённого (опоздавшее событие) не применяется."""
    if await _skip_deleted(session, user_id) or not changes:
        return 0
    last: dict[str, tuple[str, str]] = {}
    for skill_id, to, source in changes:
        last[skill_id] = (to, source)
    stmt = insert(SkillStateProjection).values([
        {"user_id": user_id, "pair_id": pair_id, "skill_id": skill_id, "state": to, "source": source,
         "updated_at": occurred_at}
        for skill_id, (to, source) in last.items()
    ])
    t = SkillStateProjection.__table__.c
    result = await session.execute(stmt.on_conflict_do_update(
        index_elements=["user_id", "pair_id", "skill_id"],
        set_={"state": stmt.excluded.state, "source": stmt.excluded.source, "updated_at": stmt.excluded.updated_at},
        where=stmt.excluded.updated_at >= t.updated_at,
    ))
    return int(getattr(result, "rowcount", 0) or 0)


async def project_audience(session: AsyncSession, *, user_id: uuid.UUID, audience: str, at: datetime) -> bool:
    """Сегмент из профиля; детский не понижается (защита в глубину: детский профиль не становится взрослым)."""
    if await _skip_deleted(session, user_id):
        return False
    stmt = insert(LearnerAudience).values(user_id=user_id, audience=audience, updated_at=at)
    t = LearnerAudience.__table__.c
    result = await session.execute(stmt.on_conflict_do_update(
        index_elements=["user_id"],
        set_={"audience": stmt.excluded.audience, "updated_at": stmt.excluded.updated_at},
        where=(stmt.excluded.updated_at >= t.updated_at)
        & ((t.audience != "kids") | (stmt.excluded.audience == "kids")),
    ))
    return bool(getattr(result, "rowcount", 0))
