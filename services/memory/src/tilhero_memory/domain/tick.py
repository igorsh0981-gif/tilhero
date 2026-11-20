"""`memory-tick` (n8n, каждые 15 минут; INTERNAL_API §1.8). Повтор безопасен.

Один tick за раз: сессионная advisory-блокировка (`pg_try_advisory_lock`) на выделенном соединении на всё время
прохода; запуск, пока идёт предыдущий, сразу отвечает `skipped`. Шаги — короткими транзакциями:
1. Сессии: active без действий > 2 ч или с окончившимся местным днём → expired (ответы учтены; был ответ —
   `memory.review.completed.v1 {status: expired}`).
2. Напоминания: reminders_enabled, местное время 19:00–19:14, к концу дня ≥ 5 карточек к сроку, повторения сегодня
   не было, напоминания сегодня не было → `memory.reviews.due.v1` + reminders_sent; не больше 500 за tick (остаток —
   следующим tick в том же окне). Детям тоже — адресат (опекун), тихие часы и мягкий текст решает notifications.
3. Проверки удержания: срок наступил, а активности 14 дней нет — срок +1 день (не провал).
4. Сроки хранения: карточки ошибок старше 90 дней → archived, цитата стирается; попытки произношения старше
   180 дней — удаляются; ввод в заданиях завершённых сессий старше 90 дней — стирается; ключи идемпотентности
   старше 7 дней — удаляются.
"""

from __future__ import annotations

import logging
import uuid
import zlib
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any, Final

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncConnection

from tilhero_common.app import Runtime
from tilhero_memory.domain import learners, review
from tilhero_memory.domain.cards import log_row
from tilhero_memory.domain.common import (
    REVIEWS_DUE,
    emit_event,
    end_of_local_day,
    local_date,
    lock_user,
    zone,
)
from tilhero_memory.domain.views import snapshot
from tilhero_memory.models import (
    Card,
    Idempotency,
    LearnerProjection,
    PronunciationAttempt,
    ReminderSent,
    RetentionCheck,
    ReviewSession,
    ReviewTask,
)
from tilhero_memory.settings import Settings

log = logging.getLogger("tilhero.memory.tick")

TICK_LOCK_CLASS: Final = 0x4D454D54  # 'MEMT'
IDEMPOTENCY_DAYS: Final = 7


def _rowcount(result: Any) -> int:
    return int(getattr(result, "rowcount", 0) or 0)


def tick_lock_object(schema: str | None) -> int:
    return int.from_bytes(zlib.crc32((schema or "").encode()).to_bytes(4, "big"), "big", signed=True)


async def expire_sessions(rt: Runtime, settings: Settings, now: datetime) -> dict[str, int]:
    async with rt.transaction() as db:
        rows = (await db.execute(select(ReviewSession).where(ReviewSession.status == "active")
                                 .order_by(ReviewSession.last_activity_at).limit(settings.tick_batch_size * 10))
                ).scalars().all()
    stale = [(s.session_id, s.user_id) for s in rows if review.is_stale(s, now, settings)]
    expired = 0
    for session_id, user_id in stale:
        async with rt.transaction() as db:
            await lock_user(db, user_id)
            s = await db.get(ReviewSession, session_id, populate_existing=True, with_for_update=True)
            if s is None or not review.is_stale(s, now, settings):
                continue
            await review.expire(db, s, now, settings)
            expired += 1
    return {"sessions_expired": expired}


async def reminders(rt: Runtime, settings: Settings, now: datetime) -> dict[str, int]:
    """Вечернее напоминание о повторении — по поясу плана, раз в местный день."""
    sent = 0
    budget = settings.reminders_per_tick
    async with rt.transaction() as db:
        zones = [z for (z,) in (await db.execute(select(LearnerProjection.timezone).where(
            LearnerProjection.reminders_enabled.is_(True)).distinct())).all()]
    for tz_name in zones:
        if budget <= 0:
            break
        tz = zone(tz_name, settings.default_timezone)
        local = now.astimezone(tz)
        if not (local.hour == settings.reminder_hour and local.minute < settings.reminder_window_minutes):
            continue
        today = local.date()
        end = end_of_local_day(now, tz)
        tz_filter = LearnerProjection.timezone.is_(None) if tz_name is None else LearnerProjection.timezone == tz_name
        async with rt.transaction() as db:
            candidates = (await db.execute(select(LearnerProjection).where(
                LearnerProjection.reminders_enabled.is_(True), tz_filter,
                ~select(ReminderSent.user_id).where(ReminderSent.user_id == LearnerProjection.user_id,
                                                    ReminderSent.local_date == today).exists(),
                ~select(ReviewSession.session_id).where(
                    ReviewSession.user_id == LearnerProjection.user_id, ReviewSession.local_date == today,
                    ReviewSession.status.in_(("completed", "expired", "cancelled")),
                    func.coalesce(ReviewSession.summary["reviewed"].as_integer(), 0) > 0).exists(),
            ).order_by(LearnerProjection.user_id).limit(budget * 4))).scalars().all()
            for proj in candidates:
                if budget <= 0:
                    break
                cards = [Card.user_id == proj.user_id, Card.status.in_(("learning", "review")), Card.due_at <= end]
                if proj.course_pair:
                    cards.append(Card.pair_id == proj.course_pair)
                due = int(await db.scalar(select(func.count()).select_from(Card).where(*cards)) or 0)
                if due < settings.reminder_min_due:
                    continue
                inserted = (await db.execute(insert(ReminderSent).values(
                    user_id=proj.user_id, local_date=today, due_count=due, sent_at=now,
                ).on_conflict_do_nothing().returning(ReminderSent.user_id))).first()
                if inserted is None:
                    continue
                await emit_event(db, REVIEWS_DUE, {"user_id": str(proj.user_id), "local_date": today.isoformat(),
                                                   "due_count": min(due, 2000), "timezone": str(tz.key)})
                sent += 1
                budget -= 1
    return {"reminders_sent": sent}


async def postpone_checks(rt: Runtime, settings: Settings, now: datetime) -> dict[str, int]:
    async with rt.transaction() as db:
        rows = (await db.execute(select(RetentionCheck.check_id, RetentionCheck.user_id).where(
            RetentionCheck.status == "scheduled", RetentionCheck.due_at <= now)
            .order_by(RetentionCheck.due_at).limit(settings.tick_batch_size))).all()
        by_user: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
        for check_id, user_id in rows:
            by_user[user_id].append(check_id)
        moved: list[uuid.UUID] = []
        for user_id, ids in by_user.items():
            tz = await learners.timezone_of(db, user_id, settings)
            if not await learners.active_recently(db, user_id, local_date(now, tz),
                                                  settings.inactivity_days_for_checks):
                moved.extend(ids)
        if moved:
            await db.execute(update(RetentionCheck).where(
                RetentionCheck.check_id.in_(moved), RetentionCheck.status == "scheduled",
            ).values(due_at=now + timedelta(days=1), postponed=RetentionCheck.postponed + 1, updated_at=now))
    return {"checks_postponed": len(moved)}


async def retention_sweep(rt: Runtime, settings: Settings, now: datetime) -> dict[str, int]:
    batch = settings.tick_batch_size * 10
    err_cutoff = now - timedelta(days=settings.error_card_retention_days)
    archived = wiped = 0
    async with rt.transaction() as db:
        cards = (await db.execute(select(Card).where(
            Card.kind == "error", Card.created_at < err_cutoff,
            (Card.status != "archived") | (Card.error["evidence"].as_string().is_not(None)),
        ).order_by(Card.created_at).limit(batch).with_for_update(skip_locked=True))).scalars().all()
        for card in cards:
            err = dict(card.error or {})
            if err.get("evidence") is not None:
                err["evidence"] = None
                card.error = err
                wiped += 1
            if card.status != "archived":
                before = snapshot(card)
                card.status = "archived"
                card.archived_by = "system"
                card.updated_at = now
                db.add(log_row(card, before, now, task_type="manual", answer_mode="manual", actor="system",
                               reason="retention_90d"))
                archived += 1
        pron = _rowcount(await db.execute(delete(PronunciationAttempt).where(
            PronunciationAttempt.created_at < now - timedelta(days=settings.pronunciation_retention_days))))
        sessions = select(ReviewSession.session_id).where(
            ReviewSession.status != "active",
            ReviewSession.finished_at < now - timedelta(days=settings.answer_retention_days))
        task_rows = (await db.execute(select(ReviewTask).where(
            ReviewTask.session_id.in_(sessions), ReviewTask.answer.is_not(None), ReviewTask.redacted_at.is_(None),
        ).limit(batch))).scalars().all()
        for t in task_rows:
            t.answer = None
            t.redacted_at = now
            if t.response and isinstance(t.response.get("check_result"), dict):
                cr = dict(t.response["check_result"])
                cr["items"] = [{**i, "your_answer": None} for i in cr.get("items") or [] if isinstance(i, dict)]
                t.response = {**t.response, "check_result": cr}
        idem = _rowcount(await db.execute(delete(Idempotency).where(
            Idempotency.created_at < now - timedelta(days=IDEMPOTENCY_DAYS))))
    return {"error_cards_archived": archived, "evidence_wiped": wiped, "pronunciation_deleted": pron,
            "answers_redacted": len(task_rows), "idempotency_purged": idem}


async def run(rt: Runtime, settings: Settings, now: datetime) -> dict[str, Any]:
    assert rt.db is not None
    async with rt.db.engine.connect() as conn:
        got = (await conn.execute(text("SELECT pg_try_advisory_lock(:c, :o)"),
                                  {"c": TICK_LOCK_CLASS, "o": tick_lock_object(rt.db.schema)})).scalar_one()
        await conn.commit()
        if not got:
            return {"skipped": True}
        try:
            out: dict[str, Any] = {"skipped": False}
            out.update(await expire_sessions(rt, settings, now))
            out.update(await reminders(rt, settings, now))
            out.update(await postpone_checks(rt, settings, now))
            out.update(await retention_sweep(rt, settings, now))
            return out
        finally:
            await _release(conn)


async def _release(conn: AsyncConnection) -> None:
    try:
        if conn.in_transaction():
            await conn.rollback()
        await conn.execute(text("SELECT pg_advisory_unlock_all()"))
        await conn.commit()
    except BaseException:
        await conn.invalidate()
        raise
