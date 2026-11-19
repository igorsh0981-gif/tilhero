"""Админка диагностики (admin.ts «Диагностика»): тесты и версии (с ключами — content.read), публикация версии
(content.publish; step-up — в admin-bff), статистика для обзора (dashboard.read). Права проверяет API по actor."""

from __future__ import annotations

import statistics
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.errors import not_found, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit
from tilhero_diagnostics.models import DeletedUser, Result, Session, Test
from tilhero_diagnostics.testdef import BANDS, TEST_AREAS, TestInvalid, coverage, from_row

AUDIT_EVENT = "admin.audit.recorded.v1"
PRODUCER = "diagnostics"
_LOCK_CLASS, _LOCK_TESTS = 0x0D1A, -1  # публикации тестов сериализуются


def test_not_found() -> Any:
    return not_found("DIAGNOSTIC_TEST_NOT_FOUND", "Тест диагностики не найден")


def _row(test_id: str, versions: list[Test]) -> dict[str, Any]:
    versions = sorted(versions, key=lambda v: v.version)
    published = next((v.version for v in versions if v.status == "published"), None)
    head = versions[-1]
    return {
        "test_id": test_id, "pair_id": head.pair_id, "audience": head.audience, "published_version": published,
        "versions": [{"version": v.version, "status": v.status, "items": len(v.items), "published_at": v.published_at}
                     for v in versions],
    }


async def list_tests(session: AsyncSession) -> list[dict[str, Any]]:
    rows = (await session.execute(select(Test).order_by(Test.test_id, Test.version))).scalars().all()
    grouped: dict[str, list[Test]] = {}
    for r in rows:
        grouped.setdefault(r.test_id, []).append(r)
    return [_row(test_id, versions) for test_id, versions in grouped.items()]


async def test_row(session: AsyncSession, test_id: str) -> dict[str, Any]:
    rows = list((await session.execute(select(Test).where(Test.test_id == test_id))).scalars().all())
    if not rows:
        raise test_not_found()
    return _row(test_id, rows)


async def get_version(session: AsyncSession, test_id: str, version: int) -> dict[str, Any]:
    t = await session.get(Test, (test_id, version))
    if t is None:
        raise test_not_found()
    return {"test_id": t.test_id, "version": t.version, "status": t.status, "config": t.config, "items": t.items,
            "coverage": coverage(t.items)}


def _audit(actor: Actor, action: str, object_id: str, before: dict | None, after: dict | None,
           reason: str) -> dict[str, Any]:
    """Payload admin.audit.recorded.v1 (RecordIn audit-service) — без содержимого заданий."""
    return {
        "record_id": str(uuid.uuid4()),
        "occurred_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "actor_type": "staff",
        "actor_id": actor.id[:64],
        "actor_role": actor.role[:64],
        "action": action,
        "object_type": "diagnostic_test",
        "object_id": object_id,
        "before": before,
        "after": after,
        "reason": reason,
        "trace_id": context.get_trace_id()[:64],
    }


async def publish(session: AsyncSession, *, test_id: str, version: int, actor: Actor, reason: str,
                  now: datetime) -> tuple[dict[str, Any], bool]:
    """draft/archived → published; прежняя опубликованная версия той же (пары, аудитории) → archived.
    Уже опубликованная — без изменений (повтор безопасен). Невалидная версия — 422 TEST_INVALID {errors}.
    Начатые сессии проходят на своей версии (сессия хранит test_version)."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, :o)"), {"c": _LOCK_CLASS, "o": _LOCK_TESTS})
    t = (await session.execute(
        select(Test).where(Test.test_id == test_id, Test.version == version).with_for_update()
    )).scalar_one_or_none()
    if t is None:
        raise test_not_found()
    if t.status == "published":
        return await test_row(session, test_id), False
    try:
        from_row(t.test_id, t.version, t.pair_id, t.audience, t.config, t.items)
    except TestInvalid as exc:
        raise unprocessable("TEST_INVALID", "Тест не прошёл проверку", {"errors": exc.errors}) from None
    previous = (await session.execute(
        select(Test.test_id, Test.version).where(Test.pair_id == t.pair_id, Test.audience == t.audience,
                                                 Test.status == "published")
    )).all()
    await session.execute(
        update(Test).where(Test.pair_id == t.pair_id, Test.audience == t.audience, Test.status == "published")
        .values(status="archived", archived_at=now)
    )
    from_status = t.status
    t.status, t.published_at, t.published_by, t.archived_at = "published", now, actor.id[:64], None
    await session.flush()
    await emit(session, AUDIT_EVENT, _audit(
        actor, "diagnostics.test_published", f"{test_id}@{version}",
        {"status": from_status, "published": [f"{p.test_id}@{p.version}" for p in previous]},
        {"status": "published", "items": len(t.items)}, reason), producer=PRODUCER)
    return await test_row(session, test_id), True


async def pair_learners(session: AsyncSession) -> list[dict[str, Any]]:
    """Ученики по паре: число различных user_id хотя бы с одним результатом (любой ревизии). Удалённые не
    считаются: сага удаляет их результаты, отметка deleted_users исключает их и на время гонки. Пары без
    результатов не возвращаются."""
    rows = (await session.execute(
        select(Result.pair_id, func.count(func.distinct(Result.user_id)))
        .where(Result.user_id.not_in(select(DeletedUser.user_id)))
        .group_by(Result.pair_id).order_by(Result.pair_id)
    )).all()
    return [{"pair_id": pair_id, "learners": int(n)} for pair_id, n in rows]


def _pct(part: int, total: int) -> float:
    return round(100.0 * part / total, 1) if total else 0.0


async def stats(session: AsyncSession, *, period: str, since: datetime) -> dict[str, Any]:
    """Прохождения за период: начатые и завершённые основные сессии, медиана длительности (мин), распределение
    предварительного уровня и доля not_assessed по областям (последняя ревизия результатов периода), уточнения."""
    started = int((await session.execute(
        select(func.count()).select_from(Session).where(Session.result_id.is_(None), Session.started_at >= since)
    )).scalar_one())
    durations = (await session.execute(
        select(Session.started_at, Session.finished_at).where(
            Session.result_id.is_(None), Session.status == "finished", Session.finished_at >= since)
    )).all()
    minutes = [(f - s).total_seconds() / 60 for s, f in durations if f is not None]
    first_ids = select(Result.result_id).where(Result.revision == 1, Result.created_at >= since)
    last_revision = (select(Result.result_id, func.max(Result.revision).label("revision"))
                     .where(Result.result_id.in_(first_ids)).group_by(Result.result_id).subquery())
    latest = (await session.execute(
        select(Result).join(last_revision, (Result.result_id == last_revision.c.result_id)
                            & (Result.revision == last_revision.c.revision))
    )).scalars().all()
    by_level: dict[str, int] = {b: 0 for b in (*BANDS, "none")}
    not_assessed = dict.fromkeys(TEST_AREAS, 0)
    for r in latest:
        by_level[r.provisional_level or "none"] += 1
        for a in r.profile.get("areas", []):
            if a.get("area") in not_assessed and a.get("status") == "not_assessed":
                not_assessed[a["area"]] += 1
    followups = int((await session.execute(
        select(func.count()).select_from(Session).where(
            Session.result_id.is_not(None), Session.status == "finished", Session.finished_at >= since)
    )).scalar_one())
    return {
        "period": period, "started": started, "finished": len(minutes),
        "median_minutes": round(statistics.median(minutes), 1) if minutes else None,
        "by_level": by_level,
        "not_assessed_pct": {a: _pct(n, len(latest)) for a, n in not_assessed.items()},
        "followups": followups,
    }
