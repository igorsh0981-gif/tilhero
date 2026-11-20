"""«Повторение дня» (INTERNAL_API §1.3, APP-MEM-03/04): очередь, задания, ответы и FSRS, подсказки, завершение.

Очередь при старте: (1) проверки удержания со сроком — до 2, по 3 задания; (2) карточки к сроку (learning | review,
due_at ≤ конец местного дня) по возрастанию извлекаемости R — взрослым и подросткам до 20, детям до 10; (3) новые
карточки по created_at — до 5 в день (детям до 3) с учётом начатых сегодня. Пустая очередь → 409 NOTHING_TO_REVIEW.

Ответ: проверка по ключу (domain/tasks.py) → оценка по таблице → FSRS → строка review_log. Карточка с again
возвращается в конец сессии один раз (повтор в тот же день — краткосрочная формула FSRS). Ключ ответа ученику до
ответа не отдаётся; у check_item верный ответ — только в конце блока проверки. Повтор ответа — тот же результат.
Бездействие > 10 мин не идёт в active_seconds; > 2 ч или конец местного дня → expired (tick или первый запрос).
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Final

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_memory.domain import fsrs, learners, retention, tasks
from tilhero_memory.domain.cards import log_row
from tilhero_memory.domain.common import (
    REVIEW_COMPLETED,
    answer_invalid,
    ceil_minutes,
    day_start,
    emit_event,
    end_of_local_day,
    hints_not_allowed,
    iso,
    local_date,
    lock_user,
    nothing_to_review,
    session_not_found,
    session_state,
    task_not_current,
    task_not_found,
    zone,
)
from tilhero_memory.domain.context import Ctx
from tilhero_memory.domain.learners import Profile
from tilhero_memory.domain.pronunciation import status_for
from tilhero_memory.domain.views import apply_memory, memory_of, snapshot
from tilhero_memory.models import Card, RetentionCheck, ReviewSession, ReviewTask
from tilhero_memory.settings import Settings

log = logging.getLogger("tilhero.memory.review")

CANDIDATE_CHECKS: Final = 6
DUE_FETCH: Final = 500
POOL_SIZE: Final = 40
SKILL_FALLBACK: Final = {"ru": "Навык", "uz": "Koʻnikma"}


# ---------------------------------------------------------------- общие помощники


def _limits(prof: Profile, s: Settings) -> tuple[int, int]:
    return (s.due_limit_kids, s.new_limit_kids) if prof.kids else (s.due_limit_adults, s.new_limit_adults)


def is_stale(s: ReviewSession, now: datetime, settings: Settings) -> bool:
    if s.status != "active":
        return False
    tz = zone(s.timezone, settings.default_timezone)
    return (now - s.last_activity_at > timedelta(minutes=settings.session_expiry_minutes)
            or local_date(now, tz) > s.local_date)


def _touch(s: ReviewSession, now: datetime, settings: Settings) -> None:
    """active_seconds: бездействие дольше INACTIVITY_MINUTES (10 мин) не учитывается (как в lessons)."""
    delta = (now - s.last_activity_at).total_seconds()
    if 0 < delta <= settings.inactivity_minutes * 60:
        s.active_seconds += int(delta)
    if now > s.last_activity_at:
        s.last_activity_at = now


async def _tasks(db: AsyncSession, session_id: uuid.UUID) -> list[ReviewTask]:
    return list((await db.execute(select(ReviewTask).where(ReviewTask.session_id == session_id)
                                  .order_by(ReviewTask.seq))).scalars().all())


def _current(rows: list[ReviewTask]) -> ReviewTask | None:
    return next((t for t in rows if t.answered_at is None and not t.skipped), None)


def session_view(s: ReviewSession, rows: list[ReviewTask]) -> dict[str, Any]:
    """ReviewSession (bff.ts)."""
    visible = [t for t in rows if not t.skipped]
    stats = s.stats or {}
    return {"session_id": str(s.session_id), "status": s.status, "total_tasks": len(visible),
            "done_tasks": sum(1 for t in visible if t.answered_at is not None),
            "cards": int(stats.get("cards", 0)), "new_cards": int(stats.get("new_cards", 0)),
            "checks": int(stats.get("checks", 0)), "started_at": iso(s.started_at), "finished_at": iso(s.finished_at),
            "minutes": s.minutes if s.status != "active" else ceil_minutes(s.active_seconds)}


def task_view(t: ReviewTask, rows: list[ReviewTask], settings: Settings) -> dict[str, Any]:
    """ReviewTask (bff.ts) — без ключа."""
    visible = [x for x in rows if not x.skipped]
    p = t.payload
    return {"task_id": str(t.task_id), "index": sum(1 for x in visible if x.seq <= t.seq), "total": len(visible),
            "type": t.type, "card_id": str(t.card_id) if t.card_id else None, "check": p.get("check"),
            "prompt": p["prompt"], "options": list(p.get("options") or []), "tiles": list(p.get("tiles") or []),
            "answer_kind": p["answer_kind"], "hints": list(p.get("hints") or []), "hints_used": list(t.hints or []),
            "voice": settings.review_voice}


async def _own_session(db: AsyncSession, user_id: uuid.UUID, session_id: uuid.UUID) -> ReviewSession:
    s = (await db.execute(select(ReviewSession).where(ReviewSession.session_id == session_id,
                                                      ReviewSession.user_id == user_id).with_for_update())
         ).scalar_one_or_none()
    if s is None:
        raise session_not_found()
    return s


async def _answered_count(db: AsyncSession, session_id: uuid.UUID) -> int:
    return int(await db.scalar(select(func.count()).select_from(ReviewTask).where(
        ReviewTask.session_id == session_id, ReviewTask.answered_at.is_not(None))) or 0)


# ---------------------------------------------------------------- итоги, завершение, истечение


async def _summary(db: AsyncSession, s: ReviewSession, settings: Settings, now: datetime) -> dict[str, Any]:
    stats = s.stats or {}
    first: dict[str, str] = dict(stats.get("first") or {})
    new_ids = set(stats.get("new_ids") or [])
    checks = []
    for c in stats.get("check_results") or []:
        checks.append({"skill_title": c.get("skill_title") or SKILL_FALLBACK, "stage": c["stage"],
                       "passed": bool(c["passed"]), "skill_retained": c["stage"] == "d30" and bool(c["passed"])})
    tz = zone(s.timezone, settings.default_timezone)
    tomorrow_end = day_start(local_date(now, tz) + timedelta(days=2), tz)
    active = (Card.user_id == s.user_id, Card.pair_id == s.pair_id, Card.status.in_(("learning", "review")))
    next_due = await db.scalar(select(func.min(Card.due_at)).where(*active, Card.due_at > now))
    due_tomorrow = await db.scalar(select(func.count()).select_from(Card).where(*active, Card.due_at < tomorrow_end))
    return {"session_id": str(s.session_id), "status": s.status, "minutes": s.minutes, "reviewed": len(first),
            "correct": sum(1 for g in first.values() if g in ("hard", "good")),
            "again": sum(1 for g in first.values() if g == "again"),
            "new_learned": sum(1 for cid in new_ids if cid in first), "checks": checks,
            "next_due_at": iso(next_due), "due_tomorrow": int(due_tomorrow or 0)}


async def _close(db: AsyncSession, s: ReviewSession, status: str, now: datetime, settings: Settings) -> None:
    """completed | expired | cancelled: минуты, итог, проверки посреди блока — обратно в очередь, событие (completed;
    expired — если был хотя бы один ответ), день активности (если были ответы)."""
    answered = await _answered_count(db, s.session_id)
    if status == "completed":
        _touch(s, now, settings)
        s.finished_at = now
    elif status == "expired":
        s.finished_at = max(s.last_activity_at, s.started_at)
    else:
        _touch(s, now, settings)
        s.finished_at = now
    s.status = status
    s.minutes = ceil_minutes(s.active_seconds)
    await retention.release(db, s.session_id, now)
    s.summary = await _summary(db, s, settings, now)
    if answered:
        day = local_date(s.finished_at, zone(s.timezone, settings.default_timezone))
        await learners.mark_activity(db, s.user_id, day, "review", now)
    if status == "completed" or (status == "expired" and answered):
        summary = s.summary
        await emit_event(db, REVIEW_COMPLETED, {
            "session_id": str(s.session_id), "user_id": str(s.user_id), "pair_id": s.pair_id, "status": status,
            "minutes": s.minutes, "reviewed": int(summary["reviewed"]), "correct": int(summary["correct"]),
            "finished_at": iso(s.finished_at)})


async def expire(db: AsyncSession, s: ReviewSession, now: datetime, settings: Settings) -> None:
    await _close(db, s, "expired", now, settings)


# ---------------------------------------------------------------- старт


async def _pool(db: AsyncSession, user_id: uuid.UUID, pair_id: str) -> list[dict[str, Any]]:
    rows = (await db.execute(select(Card.text_en, Card.gloss).where(
        Card.user_id == user_id, Card.pair_id == pair_id, Card.kind.in_(("word", "phrase")),
        Card.status != "archived").order_by(Card.created_at.desc()).limit(POOL_SIZE))).all()
    return [{"en": en, "gloss": gloss} for en, gloss in rows]


async def _new_started_today(db: AsyncSession, user_id: uuid.UUID, today: date) -> int:
    return int(await db.scalar(select(func.count()).select_from(ReviewTask).join(
        ReviewSession, ReviewSession.session_id == ReviewTask.session_id).where(
        ReviewSession.user_id == user_id, ReviewSession.local_date == today, ReviewTask.type == "intro",
        ReviewTask.requeued_from.is_(None))) or 0)


async def _due_cards(db: AsyncSession, user_id: uuid.UUID, pair_id: str, until: datetime, now: datetime,
                     limit: int) -> list[Card]:
    rows = list((await db.execute(select(Card).where(
        Card.user_id == user_id, Card.pair_id == pair_id, Card.status.in_(("learning", "review")),
        Card.due_at <= until).order_by(Card.due_at, Card.card_id).limit(DUE_FETCH))).scalars().all())
    rows.sort(key=lambda c: (fsrs.current_retrievability(memory_of(c), now) or 0.0, c.due_at or now, str(c.card_id)))
    return rows[:limit]


async def _next_due(db: AsyncSession, user_id: uuid.UUID, pair_id: str) -> datetime | None:
    card_due = await db.scalar(select(func.min(Card.due_at)).where(
        Card.user_id == user_id, Card.pair_id == pair_id, Card.status.in_(("learning", "review", "new"))))
    check_due = await db.scalar(select(func.min(RetentionCheck.due_at)).where(
        RetentionCheck.user_id == user_id, RetentionCheck.pair_id == pair_id, RetentionCheck.status == "scheduled"))
    dues = [d for d in (card_due, check_due) if d is not None]
    return min(dues) if dues else None


async def start(ctx: Ctx, pair_hint: str | None, idem_key: str) -> tuple[int, dict[str, Any]]:
    """POST /internal/v1/review-sessions → (201 новая | 200 активная или повтор ключа, ReviewSession)."""
    s = ctx.settings
    # 1. чтение: профиль, активная сессия, повтор ключа, проверки-кандидаты (без блокировок)
    async with ctx.rt.transaction() as db:
        await learners.ensure_not_deleted(db, ctx.user_id)
        prof = await learners.profile(db, ctx.learner, s, pair_hint)
        candidates = await retention.due_checks(db, ctx.user_id, prof.pair_id, ctx.now, CANDIDATE_CHECKS)
        seen = {c.check_id: await retention.recent_lessons(db, c) for c in candidates}
    # 2. задания проверок из catalog (вне транзакции)
    taken: dict[uuid.UUID, tuple[list[dict[str, Any]], dict[str, str] | None]] = {}
    no_items: list[uuid.UUID] = []
    for c in candidates:
        if len(taken) >= s.checks_per_session:
            break
        data = await ctx.catalog.check_items(c.skill_id, prof.audience, prof.pair_id)
        if data is None:  # catalog недоступен — проверка подождёт следующего повторения
            continue
        items = retention.choose_items(data, seen.get(c.check_id, set()), s.check_items, c.skill_id)
        title = data.get("title") if isinstance(data.get("title"), dict) else None
        if len(items) < 2:
            no_items.append(c.check_id)
        else:
            taken[c.check_id] = (items, title)
    # 3. запись под блокировкой ученика
    expired_id: uuid.UUID | None = None
    result: tuple[int, dict[str, Any]] | None = None
    async with ctx.rt.transaction() as db:
        await lock_user(db, ctx.user_id)
        await learners.ensure_not_deleted(db, ctx.user_id)
        replay = (await db.execute(select(ReviewSession).where(
            ReviewSession.user_id == ctx.user_id, ReviewSession.idempotency_key == idem_key))).scalar_one_or_none()
        active = (await db.execute(select(ReviewSession).where(
            ReviewSession.user_id == ctx.user_id, ReviewSession.status == "active").with_for_update())
                  ).scalar_one_or_none()
        if active is not None and is_stale(active, ctx.now, s):
            await expire(db, active, ctx.now, s)
            expired_id = active.session_id
            active = None
        if active is not None:
            return 200, session_view(active, await _tasks(db, active.session_id))
        if replay is not None:
            return 200, session_view(replay, await _tasks(db, replay.session_id))
        if no_items:
            await db.execute(retention_cancel_stmt(no_items, ctx.now))
        result = await _create(db, ctx, prof, taken, idem_key)
    if result is None:
        async with ctx.rt.transaction() as db:
            nxt = await _next_due(db, ctx.user_id, prof.pair_id)
        raise nothing_to_review(iso(nxt))
    if expired_id is not None:
        log.info("stale review session expired on start")
    return result


def retention_cancel_stmt(ids: list[uuid.UUID], now: datetime) -> Any:
    return update(RetentionCheck).where(RetentionCheck.check_id.in_(ids), RetentionCheck.status == "scheduled") \
        .values(status="cancelled", cancel_reason="no_items", updated_at=now)


async def _create(db: AsyncSession, ctx: Ctx, prof: Profile,
                  taken: dict[uuid.UUID, tuple[list[dict[str, Any]], dict[str, str] | None]],
                  idem_key: str) -> tuple[int, dict[str, Any]] | None:
    s = ctx.settings
    now = ctx.now
    today = local_date(now, prof.tz)
    due_limit, new_limit = _limits(prof, s)
    checks = list((await db.execute(select(RetentionCheck).where(
        RetentionCheck.check_id.in_(list(taken)), RetentionCheck.status == "scheduled",
    ).order_by(RetentionCheck.due_at).with_for_update())).scalars().all()) if taken else []
    due = await _due_cards(db, ctx.user_id, prof.pair_id, end_of_local_day(now, prof.tz), now, due_limit)
    new_quota = max(0, new_limit - await _new_started_today(db, ctx.user_id, today))
    new = list((await db.execute(select(Card).where(
        Card.user_id == ctx.user_id, Card.pair_id == prof.pair_id, Card.status == "new",
    ).order_by(Card.created_at, Card.card_id).limit(new_quota))).scalars().all()) if new_quota else []
    if not checks and not due and not new:
        return None
    session_id = uuid.uuid4()
    pool = await _pool(db, ctx.user_id, prof.pair_id)
    built: list[tuple[tasks.Built, uuid.UUID | None, uuid.UUID | None]] = []
    for c in checks:
        items, title = taken[c.check_id]
        title = title or c.skill_title or dict(SKILL_FALLBACK)
        for i, x in enumerate(items, 1):
            b = tasks.build_check_task(x["item"], check_id=str(c.check_id), skill_title=title, position=i,
                                       of=len(items), seed=tasks.task_seed(str(session_id), str(c.check_id), i))
            built.append((b, None, c.check_id))
        c.status, c.session_id, c.updated_at = "in_session", session_id, now
        c.items = [{"lesson_id": x["lesson_id"], "version": x["version"], "item_id": x["item"]["item_id"]}
                   for x in items]
        c.skill_title = title
    for card in due:
        seed = tasks.task_seed(str(session_id), str(card.card_id), 0)
        typ = tasks.card_task_type(card, young=prof.young, seed=seed)
        built.append((tasks.build_card_task(card, typ, seed=seed, locale=prof.locale, pool=pool), card.card_id, None))
    for card in new:
        seed = tasks.task_seed(str(session_id), str(card.card_id), 0)
        built.append((tasks.build_card_task(card, "intro", seed=seed, locale=prof.locale, pool=pool),
                      card.card_id, None))
        if card.kind == "error":  # ошибка: после знакомства — исправление (выбора перевода у ошибки нет)
            typ = tasks.card_task_type(card, young=prof.young, seed=seed)
        else:
            typ = "meaning_choice"
        built.append((tasks.build_card_task(card, typ, seed=seed + ":1", locale=prof.locale, pool=pool),
                      card.card_id, None))
    sess = ReviewSession(
        session_id=session_id, user_id=ctx.user_id, pair_id=prof.pair_id, status="active", local_date=today,
        timezone=prof.tz_name, audience=prof.audience, age_band=prof.band, locale=prof.locale, started_at=now,
        last_activity_at=now, finished_at=None, active_seconds=0, minutes=0, plan=[], summary=None,
        idempotency_key=idem_key,
        stats={"cards": len(due) + len(new), "new_cards": len(new), "checks": len(checks),
               "new_ids": [str(c.card_id) for c in new], "requeued": [], "first": {}, "check_results": []})
    db.add(sess)
    await db.flush()
    rows = []
    for seq, (b, card_id, check_id) in enumerate(built, 1):
        rows.append(ReviewTask(task_id=uuid.uuid4(), session_id=session_id, seq=seq, card_id=card_id,
                               check_id=check_id, type=b.type, payload=b.payload, key=b.key, requeued_from=None,
                               hints=[], skipped=False, created_at=now))
    db.add_all(rows)
    sess.plan = [str(t.task_id) for t in rows]
    await db.flush()
    return 201, session_view(sess, rows)


# ---------------------------------------------------------------- чтение


async def active_session(ctx: Ctx) -> dict[str, Any] | None:
    async with ctx.rt.transaction() as db:
        await learners.ensure_not_deleted(db, ctx.user_id)
        s = (await db.execute(select(ReviewSession).where(
            ReviewSession.user_id == ctx.user_id, ReviewSession.status == "active"))).scalar_one_or_none()
        if s is None:
            return None
        if is_stale(s, ctx.now, ctx.settings):
            await lock_user(db, ctx.user_id)
            s = await _own_session(db, ctx.user_id, s.session_id)
            if is_stale(s, ctx.now, ctx.settings):
                await expire(db, s, ctx.now, ctx.settings)
            return None if s.status != "active" else session_view(s, await _tasks(db, s.session_id))
        return session_view(s, await _tasks(db, s.session_id))


async def get_session(ctx: Ctx, session_id: uuid.UUID) -> dict[str, Any]:
    async with ctx.rt.transaction() as db:
        await learners.ensure_not_deleted(db, ctx.user_id)
        s = await _own_session(db, ctx.user_id, session_id)
        if is_stale(s, ctx.now, ctx.settings):
            await lock_user(db, ctx.user_id)
            await expire(db, s, ctx.now, ctx.settings)
        return session_view(s, await _tasks(db, s.session_id))


async def current(ctx: Ctx, session_id: uuid.UUID) -> dict[str, Any]:
    expired = False
    async with ctx.rt.transaction() as db:
        await lock_user(db, ctx.user_id)
        await learners.ensure_not_deleted(db, ctx.user_id)
        s = await _own_session(db, ctx.user_id, session_id)
        if is_stale(s, ctx.now, ctx.settings):
            await expire(db, s, ctx.now, ctx.settings)
            expired = True
        else:
            if s.status != "active":
                raise session_state(s.status)
            rows = await _tasks(db, s.session_id)
            cur = _current(rows)
            if cur is None:
                raise task_not_current(None)
            return task_view(cur, rows, ctx.settings)
    assert expired
    raise session_state("expired")


# ---------------------------------------------------------------- ответ


def _stored_answer(body: dict[str, Any], checked: tasks.Checked | None) -> dict[str, Any]:
    out = {k: body[k] for k in ("choice", "text", "order", "known") if body.get(k) is not None}
    if checked is not None and checked.shown_answer is not None and "text" not in out:
        out["shown"] = checked.shown_answer
    return out


async def answer(ctx: Ctx, session_id: uuid.UUID, task_id: uuid.UUID, body: dict[str, Any]) -> dict[str, Any]:
    """POST …/tasks/{task_id} → ReviewTaskResult. Повтор — тот же результат (next — текущее состояние)."""
    s_cfg = ctx.settings
    expired = False
    async with ctx.rt.transaction() as db:
        await lock_user(db, ctx.user_id)
        await learners.ensure_not_deleted(db, ctx.user_id)
        s = await _own_session(db, ctx.user_id, session_id)
        rows = await _tasks(db, s.session_id)
        t = next((x for x in rows if x.task_id == task_id), None)
        if t is None:
            raise task_not_found()
        if t.answered_at is not None and t.response is not None:
            cur = _current(rows) if s.status == "active" else None
            return {**t.response, "next": task_view(cur, rows, s_cfg) if cur is not None else None}
        if s.status != "active":
            raise session_state(s.status)
        if is_stale(s, ctx.now, s_cfg):
            await expire(db, s, ctx.now, s_cfg)
            expired = True
        else:
            cur = _current(rows)
            if cur is None or cur.task_id != t.task_id:
                raise task_not_current(cur.task_id if cur else None)
            response = await _apply_answer(db, ctx, s, t, rows, body)
            _touch(s, ctx.now, s_cfg)
            rows = await _tasks(db, s.session_id)
            nxt = _current(rows)
            return {**response, "next": task_view(nxt, rows, s_cfg) if nxt is not None else None}
    assert expired
    raise session_state("expired")


async def _apply_answer(db: AsyncSession, ctx: Ctx, s: ReviewSession, t: ReviewTask, rows: list[ReviewTask],
                        body: dict[str, Any]) -> dict[str, Any]:
    now = ctx.now
    response: dict[str, Any] = {"result": None, "correct_answer": None, "next_review_in_days": None,
                                "requeued": False, "check_result": None}
    checked: tasks.Checked | None = None
    stats = dict(s.stats or {})
    if t.type == "intro":
        if any(body.get(k) is not None for k in ("choice", "text", "order")):
            raise answer_invalid("intro")
        if body.get("known") is True and t.card_id is not None:
            card = await db.get(Card, t.card_id, with_for_update=True)
            if card is not None and card.status in ("new", "learning", "review"):
                before = snapshot(card)
                card.status = "known"
                card.updated_at = now
                db.add(log_row(card, before, now, task_type="intro", answer_mode="manual", session_id=s.session_id,
                               task_id=t.task_id))
            for other in rows:
                if other.card_id == t.card_id and other.task_id != t.task_id and other.answered_at is None:
                    other.skipped = True
            stats["new_ids"] = [c for c in stats.get("new_ids") or [] if c != str(t.card_id)]
    else:
        try:
            checked = tasks.check_answer(t.type, t.payload, t.key, body)
        except tasks.AnswerInvalid as exc:
            raise answer_invalid(exc.field) from None
        t.result = checked.result
        if t.type == "check_item":
            response["check_result"] = await _check_block(db, s, t, rows, checked, stats, now)
        else:
            grade = tasks.grade_for(t.type, checked.result, list(t.hints or []))
            t.grade = grade
            response.update({"result": checked.result, "correct_answer": t.key.get("display")})
            card = await db.get(Card, t.card_id, with_for_update=True) if t.card_id is not None else None
            if card is not None and card.status in ("new", "learning", "review"):
                before = snapshot(card)
                outcome = fsrs.review(memory_of(card), grade, now)
                apply_memory(card, outcome.memory)
                card.status = card.fsrs_state
                card.updated_at = now
                db.add(log_row(card, before, now, task_type=t.type, answer_mode=tasks.ANSWER_MODE[t.type],
                               grade=grade, hinted="first_letter" in (t.hints or []),
                               revealed="reveal" in (t.hints or []), elapsed_days=outcome.elapsed_days,
                               session_id=s.session_id, task_id=t.task_id))
                response["next_review_in_days"] = outcome.interval_days
                first = dict(stats.get("first") or {})
                first.setdefault(str(card.card_id), grade)
                stats["first"] = first
                requeued = list(stats.get("requeued") or [])
                if grade == "again" and str(card.card_id) not in requeued:
                    requeued.append(str(card.card_id))
                    stats["requeued"] = requeued
                    await _requeue(db, ctx, s, card, t, rows)
                    response["requeued"] = True
    t.answer = _stored_answer(body, checked)
    t.response = response
    t.answered_at = now
    s.stats = stats
    return response


async def _requeue(db: AsyncSession, ctx: Ctx, s: ReviewSession, card: Card, t: ReviewTask,
                   rows: list[ReviewTask]) -> None:
    """Карточка с again — в конец этой сессии, один раз (тип — по новой стадии карточки)."""
    seq = max(x.seq for x in rows) + 1
    seed = tasks.task_seed(str(s.session_id), str(card.card_id), seq)
    young = s.audience == "kids" and s.age_band != "10-13"
    typ = tasks.card_task_type(card, young=young, seed=seed)
    if typ == "intro":
        typ = "meaning_choice"
    pool = await _pool(db, s.user_id, s.pair_id)
    b = tasks.build_card_task(card, typ, seed=seed, locale=s.locale, pool=pool)
    row = ReviewTask(task_id=uuid.uuid4(), session_id=s.session_id, seq=seq, card_id=card.card_id, check_id=None,
                     type=b.type, payload=b.payload, key=b.key, requeued_from=t.task_id, hints=[], skipped=False,
                     created_at=ctx.now)
    db.add(row)
    s.plan = [*s.plan, str(row.task_id)]
    await db.flush()


async def _check_block(db: AsyncSession, s: ReviewSession, t: ReviewTask, rows: list[ReviewTask],
                       checked: tasks.Checked, stats: dict[str, Any], now: datetime) -> dict[str, Any] | None:
    """Последнее задание блока проверки → итог по каждому заданию, статус проверки, событие."""
    block = [x for x in rows if x.check_id == t.check_id]
    pending = [x for x in block if x.task_id != t.task_id and x.answered_at is None]
    if pending:
        return None
    results = []
    for x in block:
        if x.task_id == t.task_id:
            mine, shown = checked.result == "correct", checked.shown_answer
        else:
            mine = x.result == "correct"
            shown = (x.answer or {}).get("text") or (x.answer or {}).get("shown")
        results.append({"prompt_en": str(x.key.get("prompt_en") or ""), "your_answer": shown,
                        "correct_answer": tasks.correct_check_answer(x.key), "correct": mine})
    correct = sum(1 for r in results if r["correct"])
    check = await db.get(RetentionCheck, t.check_id, with_for_update=True)
    passed = correct >= retention.required_correct(len(results))
    if check is not None and await retention.finalize(db, check, correct, len(results), now):
        check_results = list(stats.get("check_results") or [])
        check_results.append({"check_id": str(check.check_id), "stage": check.stage, "passed": passed,
                              "skill_title": check.skill_title})
        stats["check_results"] = check_results
    return {"passed": passed, "correct": correct, "total": len(results), "items": results}


# ---------------------------------------------------------------- подсказки


async def hint(ctx: Ctx, session_id: uuid.UUID, task_id: uuid.UUID, kind: str) -> dict[str, Any]:
    """first_letter — для ввода и сборки; reveal — «Не помню» (ответ показан, оценка again). check_item и intro —
    409 HINTS_NOT_ALLOWED. Повтор той же подсказки — тот же ответ."""
    expired = False
    async with ctx.rt.transaction() as db:
        await lock_user(db, ctx.user_id)
        await learners.ensure_not_deleted(db, ctx.user_id)
        s = await _own_session(db, ctx.user_id, session_id)
        rows = await _tasks(db, s.session_id)
        t = next((x for x in rows if x.task_id == task_id), None)
        if t is None:
            raise task_not_found()
        if t.type in ("check_item", "intro") or kind not in (t.payload.get("hints") or []):
            raise hints_not_allowed()
        if s.status != "active":
            raise session_state(s.status)
        if is_stale(s, ctx.now, ctx.settings):
            await expire(db, s, ctx.now, ctx.settings)
            expired = True
        else:
            cur = _current(rows)
            if cur is None or cur.task_id != t.task_id:
                raise task_not_current(cur.task_id if cur else None)
            if kind not in (t.hints or []):
                t.hints = [*(t.hints or []), kind]
            _touch(s, ctx.now, ctx.settings)
            return {"kind": kind, "text": tasks.hint_text(kind, t.key)}
    assert expired
    raise session_state("expired")


# ---------------------------------------------------------------- завершение и отмена


async def finish(ctx: Ctx, session_id: uuid.UUID) -> dict[str, Any]:
    expired = False
    async with ctx.rt.transaction() as db:
        await lock_user(db, ctx.user_id)
        await learners.ensure_not_deleted(db, ctx.user_id)
        s = await _own_session(db, ctx.user_id, session_id)
        if s.status == "completed" and s.summary is not None:
            return dict(s.summary)
        if s.status != "active":
            raise session_state(s.status)
        if is_stale(s, ctx.now, ctx.settings):
            await expire(db, s, ctx.now, ctx.settings)
            expired = True
        else:
            cur = _current(await _tasks(db, s.session_id))
            if cur is not None:
                raise task_not_current(cur.task_id)
            await _close(db, s, "completed", ctx.now, ctx.settings)
            return dict(s.summary or {})
    assert expired
    raise session_state("expired")


async def cancel(ctx: Ctx, session_id: uuid.UUID) -> dict[str, Any]:
    async with ctx.rt.transaction() as db:
        await lock_user(db, ctx.user_id)
        await learners.ensure_not_deleted(db, ctx.user_id)
        s = await _own_session(db, ctx.user_id, session_id)
        if s.status == "active":
            if is_stale(s, ctx.now, ctx.settings):
                await expire(db, s, ctx.now, ctx.settings)
            else:
                await _close(db, s, "cancelled", ctx.now, ctx.settings)
        elif s.status != "cancelled":
            raise session_state(s.status)
        return session_view(s, await _tasks(db, s.session_id))


# ---------------------------------------------------------------- обзор


async def overview(ctx: Ctx, pair_hint: str | None) -> dict[str, Any]:
    """MemoryOverview (bff.ts)."""
    s = ctx.settings
    now = ctx.now
    async with ctx.rt.transaction() as db:
        await learners.ensure_not_deleted(db, ctx.user_id)
        prof = await learners.profile(db, ctx.learner, s, pair_hint)
        today = local_date(now, prof.tz)
        end = end_of_local_day(now, prof.tz)
        base = (Card.user_id == ctx.user_id, Card.pair_id == prof.pair_id)
        due_count = int(await db.scalar(select(func.count()).select_from(Card).where(
            *base, Card.status.in_(("learning", "review")), Card.due_at <= end)) or 0)
        new_total = int(await db.scalar(select(func.count()).select_from(Card).where(*base, Card.status == "new"))
                        or 0)
        _, new_limit = _limits(prof, s)
        new_available = min(new_total, max(0, new_limit - await _new_started_today(db, ctx.user_id, today)))
        retention_due = len(await retention.due_checks(db, ctx.user_id, prof.pair_id, now, 100))
        done_today = bool(await db.scalar(select(func.count()).select_from(ReviewSession).where(
            ReviewSession.user_id == ctx.user_id, ReviewSession.status == "completed",
            ReviewSession.local_date == today)))
        active = (await db.execute(select(ReviewSession).where(
            ReviewSession.user_id == ctx.user_id, ReviewSession.status == "active"))).scalar_one_or_none()
        active_id = active.session_id if active is not None and not is_stale(active, now, s) else None
        total = int(await db.scalar(select(func.count()).select_from(Card).where(
            Card.user_id == ctx.user_id, Card.status != "archived")) or 0)
        next_due = None
        if due_count == 0 and new_available == 0 and retention_due == 0:
            future = await db.scalar(select(func.min(Card.due_at)).where(
                *base, Card.status.in_(("learning", "review")), Card.due_at > end))
            check_due = await db.scalar(select(func.min(RetentionCheck.due_at)).where(
                RetentionCheck.user_id == ctx.user_id, RetentionCheck.pair_id == prof.pair_id,
                RetentionCheck.status == "scheduled"))
            dues = [d for d in (future, check_due) if d is not None]
            next_due = min(dues) if dues else None
    pron = await status_for(ctx.rt, ctx.learner)
    return {"due_count": due_count, "new_available": new_available, "retention_due": retention_due,
            "done_today": done_today, "active_session_id": str(active_id) if active_id else None,
            "next_due_at": iso(next_due), "total_cards": total, "pronunciation": pron}
