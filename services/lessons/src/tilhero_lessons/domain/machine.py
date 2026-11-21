"""Машина состояний сессии (INTERNAL_API §2.2, AT-41): `ready → in_progress ↔ paused → completed/failed/cancelled`.

Переходы — только здесь (сервер); недопустимый — 409 SESSION_STATE {status}. Каждый переход пишется в
status_history (append-only). Активное время (active_seconds) копится между действиями ученика; промежуток дольше
INACTIVITY_MINUTES — авто-пауза с момента последнего действия (это время в active_seconds не идёт). Пауза дольше
PAUSE_EXPIRY_HOURS и ready дольше READY_EXPIRY_HOURS → cancelled (лениво при запросе и tick-ом).
Событие `lesson.session.completed.v1` — при каждом переходе в итоговый статус (ровно один раз: итоговый статус
необратим); `lesson.session.started.v1` — при ready → in_progress.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import emit
from tilhero_lessons.domain.common import COMPLETED, PRODUCER, STARTED, ceil_minutes, iso, session_state
from tilhero_lessons.models import Session, StatusHistory
from tilhero_lessons.settings import Settings

TERMINAL = frozenset({"completed", "failed", "cancelled"})
ACTIVE = frozenset({"ready", "in_progress", "paused"})
ALLOWED: dict[str, frozenset[str]] = {
    # ready → completed — только сессия дуэли, закрытая по сроку набора (close_deadline)
    "ready": frozenset({"in_progress", "cancelled", "failed", "completed"}),
    "in_progress": frozenset({"paused", "completed", "cancelled", "failed"}),
    "paused": frozenset({"in_progress", "completed", "cancelled", "failed"}),
}


async def _record(db: AsyncSession, s: Session, to: str, reason: str, at: datetime) -> None:
    if to not in ALLOWED.get(s.status, frozenset()):
        raise session_state(s.status)
    seq = int((await db.execute(
        select(func.coalesce(func.max(StatusHistory.seq), 0)).where(StatusHistory.session_id == s.session_id)
    )).scalar_one()) + 1
    db.add(StatusHistory(session_id=s.session_id, seq=seq, from_status=s.status, to_status=to, reason=reason, at=at))
    s.status = to


async def record_created(db: AsyncSession, s: Session, at: datetime) -> None:
    db.add(StatusHistory(session_id=s.session_id, seq=1, from_status=None, to_status="ready", reason="started",
                         at=at))


def minutes_of(s: Session) -> int:
    """ceil(active_seconds / 60), не больше 2× длительности занятия."""
    return min(ceil_minutes(s.active_seconds), 2 * s.duration_min, 600)


def accrue(s: Session, now: datetime, settings: Settings) -> None:
    """Активное время между действиями ученика (in_progress): промежуток ≤ INACTIVITY_MINUTES."""
    if s.status != "in_progress":
        return
    if s.last_activity_at is not None:
        gap = (now - s.last_activity_at).total_seconds()
        if 0 < gap <= settings.inactivity_minutes * 60:
            # целые секунды в счётчик, дробный остаток переносится на следующее действие (частые действия < 1 с
            # иначе терялись бы целиком — e2e спринта 4: minutes = 0)
            whole = int(gap)
            s.active_seconds += whole
            s.last_activity_at += timedelta(seconds=whole)
            return
    s.last_activity_at = now


async def start(db: AsyncSession, s: Session, now: datetime) -> None:
    await _record(db, s, "in_progress", "started", now)
    s.started_at = now
    s.last_activity_at = now
    payload = {
        "session_id": str(s.session_id), "user_id": str(s.user_id), "kind": s.kind, "pair_id": s.pair_id,
        "lesson_id": s.lesson_id, "scenario_id": s.scenario_id, "asset_id": s.asset_id, "ai_mode": s.ai_mode,
        "started_at": iso(now)}
    if s.kind == "duel":  # спринт 7
        payload["duel_id"] = str(s.duel_id)
    await emit(db, STARTED, payload, producer=PRODUCER)


async def pause(db: AsyncSession, s: Session, now: datetime, settings: Settings, *, reason: str = "pause") -> None:
    if reason == "pause":
        accrue(s, now, settings)
    await _record(db, s, "paused", reason, now)
    s.paused_at = now


async def resume(db: AsyncSession, s: Session, now: datetime) -> None:
    await _record(db, s, "in_progress", "resume", now)
    s.paused_at = None
    s.last_activity_at = now


async def finish(db: AsyncSession, s: Session, now: datetime, settings: Settings) -> None:
    accrue(s, now, settings)
    await _record(db, s, "completed", "finish", now)
    s.finished_at = now
    s.paused_at = None
    s.minutes = minutes_of(s)
    await emit_completed(db, s)


async def close_deadline(db: AsyncSession, s: Session, now: datetime, settings: Settings) -> None:
    """Сессия дуэли закрыта по сроку набора или итогу дуэли (спринт 7): completed со счётом по отвеченному."""
    accrue(s, now, settings)
    await _record(db, s, "completed", "deadline", now)
    s.finished_at = now
    s.paused_at = None
    s.minutes = minutes_of(s)
    await emit_completed(db, s)


async def terminate(db: AsyncSession, s: Session, to: str, reason: str, now: datetime, settings: Settings,
                    *, fail_reason: str | None = None) -> None:
    """cancelled (cancel | expired) или failed (fail | content_unpublished): minutes — по факту."""
    if reason == "cancel":
        accrue(s, now, settings)
    await _record(db, s, to, reason, now)
    s.finished_at = now
    s.paused_at = None
    s.minutes = minutes_of(s)
    s.fail_reason = fail_reason
    await emit_completed(db, s)


async def emit_completed(db: AsyncSession, s: Session) -> None:
    passed = s.evaluation.get("passed") if isinstance(s.evaluation, dict) else None
    payload: dict[str, Any] = {
        "session_id": str(s.session_id), "user_id": str(s.user_id), "kind": s.kind, "pair_id": s.pair_id,
        "lesson_id": s.lesson_id, "scenario_id": s.scenario_id, "asset_id": s.asset_id, "status": s.status,
        "outcome": s.outcome if s.status == "completed" else None, "minutes": s.minutes,
        # «день» ученика — по часовому поясу плана: считает learning-plan из finished_at
        "local_date": None,
        "evaluation_id": str(s.evaluation_id) if s.evaluation_id else None,
        "passed": passed if isinstance(passed, bool) else None,
        "practice_only": s.practice_only, "finished_at": iso(s.finished_at)}
    if s.kind == "duel":  # спринт 7 (§3.1): счёт по ключам — в gamification; в assessment не идёт
        score = (s.summary or {}).get("score") if s.status == "completed" else None
        payload.update({"duel_id": str(s.duel_id), "practice_only": True, "evaluation_id": None, "passed": None,
                        "score": {"correct": int(score["correct"]), "total": int(score["total"])}
                        if isinstance(score, dict) else None})
    await emit(db, COMPLETED, payload, producer=PRODUCER)


async def housekeep(db: AsyncSession, s: Session, now: datetime, settings: Settings) -> str | None:
    """Ленивая обработка бездействия незавершённой сессии: авто-пауза (с момента последнего действия) и истечение
    (cancelled/expired). → 'auto_pause' | 'expired' | None."""
    if s.status not in ACTIVE or s.kind == "duel":  # дуэль: срок — по набору (duels.close_if_due / tick)
        return None
    happened: str | None = None
    if s.status == "in_progress" and s.last_activity_at is not None \
            and now - s.last_activity_at > timedelta(minutes=settings.inactivity_minutes):
        at = s.last_activity_at
        await _record(db, s, "paused", "auto_pause", at)
        s.paused_at = at
        happened = "auto_pause"
    expired = (
        (s.status == "paused" and s.paused_at is not None
         and now - s.paused_at > timedelta(hours=settings.pause_expiry_hours))
        or (s.status == "ready" and now - s.created_at > timedelta(hours=settings.ready_expiry_hours))
    )
    if expired:
        await terminate(db, s, "cancelled", "expired", now, settings)
        return "expired"
    return happened


def expires_at(s: Session, settings: Settings) -> datetime | None:
    if s.kind == "duel":  # срок сессии дуэли — срок набора (DuelView.play_deadline), пауза не истекает
        return None
    if s.status == "paused" and s.paused_at is not None:
        return s.paused_at + timedelta(hours=settings.pause_expiry_hours)
    if s.status == "ready":
        return s.created_at + timedelta(hours=settings.ready_expiry_hours)
    return None
