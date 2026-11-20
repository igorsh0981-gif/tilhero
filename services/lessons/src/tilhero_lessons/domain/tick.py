"""`lessons-tick` (n8n, каждые 15 минут; INTERNAL_API §2.2, §8). Повтор безопасен.

1. Брошенные сессии: in_progress без действий > INACTIVITY_MINUTES → авто-пауза (с момента последнего действия);
   пауза > 72 ч и ready > 24 ч → cancelled (`expired`) + `lesson.session.completed.v1 {status: cancelled}`
   (minutes — по факту). Каждая сессия — своя транзакция под блокировкой ученика.
2. Срок хранения: текст свободных реплик (и реплик ИИ, которые могут цитировать ученика), открытых ответов и цитат
   в копии оценки старше TEXT_RETENTION_DAYS стирается (redacted_at) — оценка остаётся в assessment.
3. Сессии без оценки (assessment был недоступен): повторная отправка EvaluationRequest (идемпотентно по session_id);
   старше EVALUATION_RETRY_DAYS — больше не отправляются (evaluation_status = failed). Событие completed повторно
   не публикуется.
"""

from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError
from tilhero_lessons import clients
from tilhero_lessons.catalog import CatalogGateway, ContentGone
from tilhero_lessons.domain import evaluation, machine
from tilhero_lessons.domain.common import lock_user
from tilhero_lessons.domain.content import load_bundle
from tilhero_lessons.models import Session, Step, Turn
from tilhero_lessons.settings import Settings

log = logging.getLogger("tilhero.lessons.tick")


def _rowcount(result: Any) -> int:
    return int(getattr(result, "rowcount", 0) or 0)


async def _locked(db: AsyncSession, session_id: uuid.UUID, user_id: uuid.UUID) -> Session | None:
    await lock_user(db, user_id)
    return await db.get(Session, session_id, populate_existing=True)


async def stale_sessions(rt: Runtime, settings: Settings, now: datetime) -> dict[str, int]:
    idle = now - timedelta(minutes=settings.inactivity_minutes)
    paused_before = now - timedelta(hours=settings.pause_expiry_hours)
    ready_before = now - timedelta(hours=settings.ready_expiry_hours)
    async with rt.transaction() as db:
        rows = (await db.execute(
            select(Session.session_id, Session.user_id).where(or_(
                and_(Session.status == "in_progress", Session.last_activity_at < idle),
                and_(Session.status == "paused", Session.paused_at < paused_before),
                and_(Session.status == "ready", Session.created_at < ready_before),
            )).order_by(Session.created_at).limit(settings.tick_batch_size)
        )).all()
    counts = {"auto_paused": 0, "expired": 0}
    for session_id, user_id in rows:
        async with rt.transaction() as db:
            s = await _locked(db, session_id, user_id)
            if s is None:
                continue
            happened = await machine.housekeep(db, s, now, settings)
        if happened == "auto_pause":
            counts["auto_paused"] += 1
        elif happened == "expired":
            counts["expired"] += 1
    return counts


async def redact(rt: Runtime, settings: Settings, now: datetime) -> dict[str, int]:
    cutoff = now - timedelta(days=settings.text_retention_days)
    batch = settings.tick_batch_size * 10
    async with rt.transaction() as db:
        turn_keys = select(Turn.session_id, Turn.seq).where(
            Turn.mode == "text", Turn.redacted_at.is_(None), Turn.created_at < cutoff).limit(batch).subquery()
        turns = _rowcount(await db.execute(
            update(Turn).where(Turn.session_id == turn_keys.c.session_id, Turn.seq == turn_keys.c.seq)
            .values(text=None, redacted_at=now)))
        step_keys = select(Step.session_id, Step.seq).where(
            Step.type == "open_answer", Step.answer.is_not(None), Step.redacted_at.is_(None),
            Step.answered_at < cutoff).limit(batch).subquery()
        answers = _rowcount(await db.execute(
            update(Step).where(Step.session_id == step_keys.c.session_id, Step.seq == step_keys.c.seq)
            .values(answer=None, redacted_at=now)))
        rows = (await db.execute(
            select(Session).where(Session.finished_at < cutoff, Session.evaluation.is_not(None),
                                  func.coalesce(Session.summary["texts_redacted"].astext, "false") != "true")
            .limit(batch)
        )).scalars().all()
        for s in rows:
            s.evaluation = evaluation.redact_evaluation(s.evaluation or {})
            s.summary = {**(s.summary or {}), "texts_redacted": True}
    return {"redacted_turns": int(turns), "redacted_answers": int(answers), "redacted_evaluations": len(rows)}


async def resend_evaluations(rt: Runtime, catalog: CatalogGateway, settings: Settings,
                             now: datetime) -> dict[str, int]:
    oldest = now - timedelta(days=settings.evaluation_retry_days)
    async with rt.transaction() as db:
        given_up = _rowcount(await db.execute(
            update(Session).where(Session.evaluation_status == "pending", Session.finished_at < oldest)
            .values(evaluation_status="failed")))
        rows = (await db.execute(
            select(Session).where(Session.evaluation_status == "pending", Session.finished_at >= oldest)
            .order_by(Session.finished_at).limit(settings.tick_batch_size)
        )).scalars().all()
    sent = failed = 0
    started = time.monotonic()
    for row in rows:
        # n8n ждёт tick 120 с, отправка — до assessment_timeout_seconds: новые не начинаются после бюджета времени,
        # оставшиеся уйдут следующим tick (через 15 минут)
        if time.monotonic() - started > settings.tick_resend_budget_seconds:
            break
        try:
            b = await load_bundle(catalog, row.content_versions)
        except (ContentGone, ApiError) as exc:
            log.warning("evaluation resend skipped: content unavailable", extra={"error_type": type(exc).__name__})
            failed += 1
            continue
        async with rt.transaction() as db:
            s = await db.get(Session, row.session_id, populate_existing=True)
            if s is None:
                continue
            body = evaluation.build_request(s, await evaluation.steps_of(db, s), await evaluation.turns_of(db, s))
        practice = s.kind in ("review", "reading")  # навыки не меняются — «было» и названия не нужны
        before = await clients.skill_states(rt, s.user_id, s.pair_id) if not practice else None
        snapshot = await catalog.snapshot(s.course_id or settings.default_course_id) if not practice else None
        titles: dict[str, Any] = {sk["skill_id"]: sk["title"] for sk in (snapshot or {}).get("skills") or []}
        result = await clients.request_evaluation(rt, s.user_id, body)
        async with rt.transaction() as db:
            s2 = await _locked(db, row.session_id, row.user_id)
            if s2 is None or s2.evaluation_status != "pending":
                continue
            s2.evaluation_attempts = min(s2.evaluation_attempts + 1, 30000)
            if result is None:
                failed += 1
                continue
            await evaluation.apply(db, s2, b, result, before, titles, now, settings)
            sent += 1
    return {"evaluations_sent": sent, "evaluations_failed": failed, "evaluations_given_up": int(given_up)}


async def run(rt: Runtime, catalog: CatalogGateway, settings: Settings, now: datetime) -> dict[str, Any]:
    out: dict[str, Any] = {}
    out.update(await stale_sessions(rt, settings, now))
    out.update(await redact(rt, settings, now))
    out.update(await resend_evaluations(rt, catalog, settings, now))
    return out

