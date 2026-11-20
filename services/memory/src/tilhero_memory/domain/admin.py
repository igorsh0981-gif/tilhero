"""Admin API memory (INTERNAL_API §1.11, ADM-MEM-01): сводка ученика, карточки и история планирования, ручная правка
одной карточки. Права проверяются в API по actor (memory.read / memory.manage); здесь — правила, история и аудит
(`admin.audit.recorded.v1` через outbox). Цитата ошибки ученика (evidence) в админку не попадает никогда.

Ручная правка не пересчитывает FSRS: перенос меняет только due_at (1..365 дней от сейчас), сброс возвращает new,
заморозка/разморозка — статус. Каждая правка — строка review_log (actor staff:<id>, причина) и аудит
`memory.card_adjusted`. Массовых действий нет.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any, Final

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict, not_found
from tilhero_common.internal_auth import Actor
from tilhero_memory.clients import CatalogGateway
from tilhero_memory.domain import retention
from tilhero_memory.domain.cards import log_row
from tilhero_memory.domain.common import (
    audit_payload,
    card_not_found,
    cursor_time_id,
    emit_audit,
    encode_cursor,
    idempotency_reused,
    iso,
    lock_user,
    request_hash,
)
from tilhero_memory.domain.views import admin_row, snapshot
from tilhero_memory.models import (
    CARD_STATUSES,
    Card,
    Idempotency,
    LearnerProjection,
    RetentionCheck,
    ReviewLog,
    ReviewSession,
)

ADJUSTABLE: Final = {"reschedule": ("new", "learning", "review"), "reset": ("new", "learning", "review", "known"),
                     "freeze": ("new", "learning", "review", "known"), "unfreeze": ("frozen",)}
DUE_TOLERANCE: Final = timedelta(days=1)
IDEM_SCOPE: Final = "admin.card_action"
IDEM_TTL: Final = timedelta(hours=24)


def learner_not_found() -> ApiError:
    return not_found("MEMORY_LEARNER_NOT_FOUND", "Данных памяти ученика нет")


def card_state(status: str) -> ApiError:
    return conflict("CARD_STATE", "Действие недоступно для карточки в этом состоянии", {"status": status})


def due_at_range() -> ApiError:
    return ApiError(422, "DUE_AT_RANGE", "Новый срок — от 1 до 365 дней от сейчас")


async def learner_summary(db: AsyncSession, catalog: CatalogGateway, user_id: uuid.UUID,
                          now: datetime) -> dict[str, Any]:
    """LearnerMemorySummary: карточки по статусам, к сроку, просрочено > 7 дней, повторения за 30 дней, последние
    20 проверок удержания."""
    counts = dict((await db.execute(select(Card.status, func.count()).where(Card.user_id == user_id)
                                    .group_by(Card.status))).all())
    proj = await db.get(LearnerProjection, user_id)
    checks = list((await db.execute(select(RetentionCheck).where(RetentionCheck.user_id == user_id)
                                    .order_by(RetentionCheck.created_at.desc(), RetentionCheck.check_id.desc())
                                    .limit(20))).scalars().all())
    sessions = int(await db.scalar(select(func.count()).select_from(ReviewSession).where(
        ReviewSession.user_id == user_id)) or 0)
    if not counts and proj is None and not checks and not sessions:
        raise learner_not_found()
    active = (Card.user_id == user_id, Card.status.in_(("learning", "review")))
    due_now = int(await db.scalar(select(func.count()).select_from(Card).where(*active, Card.due_at <= now)) or 0)
    overdue = int(await db.scalar(select(func.count()).select_from(Card).where(
        *active, Card.due_at < now - timedelta(days=7))) or 0)
    graded = (ReviewLog.user_id == user_id, ReviewLog.actor == "learner", ReviewLog.grade.is_not(None))
    reviews = int(await db.scalar(select(func.count()).select_from(ReviewLog).where(
        *graded, ReviewLog.created_at >= now - timedelta(days=30))) or 0)
    last = await db.scalar(select(func.max(ReviewLog.created_at)).where(*graded))
    pair = proj.course_pair if proj is not None and proj.course_pair else await db.scalar(
        select(Card.pair_id).where(Card.user_id == user_id).group_by(Card.pair_id)
        .order_by(func.count().desc()).limit(1))
    rows = []
    for c in checks:
        view = retention.row_view(c)
        if view["skill_title"] is None:
            view["skill_title"] = await catalog.skill_title(c.skill_id, c.pair_id)
        rows.append(view)
    return {"user_id": str(user_id), "pair_id": pair,
            "cards_by_status": {s: int(counts.get(s, 0)) for s in CARD_STATUSES}, "due_now": due_now,
            "overdue_7d": overdue, "reviews_30d": reviews, "last_review_at": iso(last), "checks": rows}


async def learner_cards(db: AsyncSession, user_id: uuid.UUID, *, status: str | None, kind: str | None,
                        cursor: str | None, limit: int, now: datetime) -> dict[str, Any]:
    after = cursor_time_id(cursor)
    stmt = select(Card).where(Card.user_id == user_id)
    if status:
        stmt = stmt.where(Card.status == status)
    if kind:
        stmt = stmt.where(Card.kind == kind)
    if after is not None:
        stmt = stmt.where(or_(Card.created_at < after[0], and_(Card.created_at == after[0], Card.card_id < after[1])))
    rows = (await db.execute(stmt.order_by(Card.created_at.desc(), Card.card_id.desc()).limit(limit + 1))
            ).scalars().all()
    nxt = encode_cursor(rows[limit - 1].created_at.isoformat(), str(rows[limit - 1].card_id)) \
        if len(rows) > limit else None
    return {"items": [admin_row(c, now) for c in rows[:limit]], "next_cursor": nxt}


def log_view(r: ReviewLog) -> dict[str, Any]:
    """ReviewLogRow (admin.ts)."""
    staff = r.actor.startswith("staff:")
    actor = "staff" if staff else r.actor
    return {"log_id": str(r.log_id), "at": iso(r.created_at), "task_type": r.task_type, "answer_mode": r.answer_mode,
            "grade": r.grade, "hinted": r.hinted, "revealed": r.revealed, "elapsed_days": r.elapsed_days,
            "before": r.before, "after": r.after, "algorithm": r.algorithm, "params_version": r.params_version,
            "actor": actor, "actor_id": r.actor.split(":", 1)[1] if staff else None,
            "actor_name": r.actor_name if staff else None, "reason": r.reason}


async def card_log(db: AsyncSession, card_id: uuid.UUID, *, cursor: str | None, limit: int) -> dict[str, Any]:
    if await db.get(Card, card_id) is None:
        raise card_not_found()
    after = cursor_time_id(cursor)
    stmt = select(ReviewLog).where(ReviewLog.card_id == card_id)
    if after is not None:
        stmt = stmt.where(or_(ReviewLog.created_at < after[0], and_(ReviewLog.created_at == after[0],
                                                                    ReviewLog.log_id < after[1])))
    rows = (await db.execute(stmt.order_by(ReviewLog.created_at.desc(), ReviewLog.log_id.desc()).limit(limit + 1))
            ).scalars().all()
    nxt = encode_cursor(rows[limit - 1].created_at.isoformat(), str(rows[limit - 1].log_id)) \
        if len(rows) > limit else None
    return {"items": [log_view(r) for r in rows[:limit]], "next_cursor": nxt}


async def card_detail(db: AsyncSession, card_id: uuid.UUID, now: datetime, log_limit: int = 20) -> dict[str, Any]:
    """AdminCardDetail: без цитаты ошибки; история планирования — первая страница."""
    card = await db.get(Card, card_id)
    if card is None:
        raise card_not_found()
    body = admin_row(card, now)
    body.update({"user_id": str(card.user_id), "example_en": None if card.kind == "error" else card.example_en,
                 "sources": [{"kind": str(s.get("kind")), "key": s.get("key") if isinstance(s.get("key"), str)
                              else None, "version": s.get("version") if isinstance(s.get("version"), int) else None,
                              "at": s.get("at")} for s in card.sources],
                 "log": await card_log(db, card_id, cursor=None, limit=log_limit)})
    return body


def _actor_uuid(actor: Actor) -> uuid.UUID:
    try:
        return uuid.UUID(actor.id)
    except ValueError:
        return uuid.uuid5(uuid.NAMESPACE_URL, f"tilhero:staff:{actor.id}")


async def card_action(db: AsyncSession, actor: Actor, card_id: uuid.UUID, action: str, due_at: datetime | None,
                      reason: str, now: datetime, idem_key: str | None = None) -> dict[str, Any]:
    """Idempotency-Key (admin-bff): повтор того же сотрудника с тем же ключом за 24 ч — тот же ответ, без новой
    строки истории и аудита; тот же ключ с другими данными — 422 IDEMPOTENCY_KEY_REUSED."""
    card = await db.get(Card, card_id)
    if card is None:
        raise card_not_found()
    await lock_user(db, card.user_id)
    fp = request_hash({"card_id": str(card_id), "action": action, "due_at": due_at.isoformat() if due_at else None,
                       "reason": reason})
    staff_id = _actor_uuid(actor)
    if idem_key is not None:
        prior = await db.get(Idempotency, (staff_id, IDEM_SCOPE, idem_key), with_for_update=True)
        if prior is not None and prior.created_at >= now - IDEM_TTL:
            if prior.request_hash != fp:
                raise idempotency_reused()
            return dict(prior.response)
        if prior is not None:
            await db.delete(prior)
            await db.flush()
    card = await db.get(Card, card_id, with_for_update=True, populate_existing=True)
    if card is None:
        raise card_not_found()
    if card.status not in ADJUSTABLE[action]:
        raise card_state(card.status)
    before = snapshot(card)
    if action == "reschedule":
        assert due_at is not None
        delta = due_at - now
        # 1..365 дней с допуском ±1 сутки: клиент шлёт полдень выбранного местного дня
        if delta <= timedelta(days=1) - DUE_TOLERANCE or delta > timedelta(days=365) + DUE_TOLERANCE:
            raise due_at_range()
        card.due_at = due_at
    elif action == "reset":
        card.status = card.fsrs_state = "new"
        card.stability = card.difficulty = None
        card.reps = card.lapses = 0
        card.last_review_at = None
        card.due_at = now
    elif action == "freeze":
        card.status = "frozen"
    else:  # unfreeze
        card.status = card.fsrs_state
    card.updated_at = now
    db.add(log_row(card, before, now, task_type="manual", answer_mode="manual", actor=f"staff:{actor.id}"[:80],
                   actor_name=(actor.name or None), reason=reason))
    after = snapshot(card)
    await emit_audit(db, audit_payload(actor, "memory.card_adjusted", "memory_card", str(card.card_id),
                                       before={"card_id": str(card.card_id), "user_id": str(card.user_id), **before},
                                       after={"card_id": str(card.card_id), "user_id": str(card.user_id),
                                              "action": action, **after}, reason=reason))
    await db.flush()
    body = await card_detail(db, card_id, now)
    if idem_key is not None:
        db.add(Idempotency(user_id=staff_id, scope=IDEM_SCOPE, key=idem_key, request_hash=fp, status_code=200,
                           response=body, created_at=now))
    return body
