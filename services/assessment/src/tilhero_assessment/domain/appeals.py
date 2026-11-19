"""Оценка и апелляции для ученика (INTERNAL_API §3.3) и разбор апелляций сотрудниками (§3.4, AT-47).

- Ученик видит только свои оценки (чужая — 404) — актуальную запись цепочки.
- Апелляция — одна на оценку сессии (цепочку): 409 APPEAL_EXISTS; подаётся на актуальную запись в течение окна
  (14 дней с её создания) — иначе 409 APPEAL_WINDOW_CLOSED; practice_only — 409 APPEAL_NOT_ALLOWED.
  Детский профиль — апелляции разрешены (уведомление о решении уходит опекуну — правила notifications).
- Сотрудник: «взять» (new → in_review), решение upheld | corrected (corrected — только с переоценкой этой оценки,
  сделанной по этой апелляции) → событие `assessment.appeal.decided.v1` (→ notifications), аудит.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_assessment.domain.common import (
    APPEAL_DECIDED,
    IdempotencyReused,
    appeal_not_found,
    audit_payload,
    cursor_time_id,
    emit_audit,
    emit_event,
    encode_cursor,
    evaluation_not_found,
    iso_z,
    lock_session,
    lock_user,
)
from tilhero_assessment.domain.users import ensure_not_deleted
from tilhero_assessment.domain.views import (
    admin_appeal,
    appeal_of_session,
    appeal_view,
    chain_of,
    evaluation_view,
)
from tilhero_assessment.models import Appeal, Evaluation
from tilhero_common.errors import ApiError, conflict, unprocessable
from tilhero_common.internal_auth import Actor

OPEN_STATUSES = ("new", "in_review")
DECIDED_STATUSES = ("upheld", "corrected")


async def own_evaluation(session: AsyncSession, user_id: uuid.UUID, evaluation_id: uuid.UUID) -> Evaluation:
    ev = await session.get(Evaluation, evaluation_id)
    if ev is None or ev.user_id != user_id:
        raise evaluation_not_found()
    return ev


async def learner_view(session: AsyncSession, user_id: uuid.UUID, evaluation_id: uuid.UUID) -> dict[str, Any]:
    await ensure_not_deleted(session, user_id)
    ev = await own_evaluation(session, user_id, evaluation_id)
    chain = await chain_of(session, ev.session_id)
    return evaluation_view(chain[-1], requested_id=evaluation_id,
                           appeal=await appeal_of_session(session, ev.session_id))


# ---------------------------------------------------------------- ученик: апелляции


async def create_appeal(session: AsyncSession, *, user_id: uuid.UUID, evaluation_id: uuid.UUID, reason: str,
                        key: str, now: datetime, window_days: int) -> tuple[dict[str, Any], bool]:
    """→ (Appeal, создана). Повтор с тем же Idempotency-Key и теми же данными — та же апелляция."""
    await lock_user(session, user_id)
    await ensure_not_deleted(session, user_id)
    ev = await own_evaluation(session, user_id, evaluation_id)
    previous = (await session.execute(
        select(Appeal).where(Appeal.user_id == user_id, Appeal.idempotency_key == key)
    )).scalar_one_or_none()
    if previous is not None:
        # текст стёрт по сроку хранения — сравнить нечем: повтор той же сессии с тем же ключом — тот же ответ
        if previous.session_id != ev.session_id or (previous.reason is not None and previous.reason != reason):
            raise IdempotencyReused
        return appeal_view(previous), False
    chain = await chain_of(session, ev.session_id)
    current = chain[-1]
    if current.practice_only:
        raise conflict("APPEAL_NOT_ALLOWED", "Тренировку без влияния на освоение оспорить нельзя")
    existing = await appeal_of_session(session, ev.session_id)
    if existing is not None:
        raise conflict("APPEAL_EXISTS", "Апелляция по этой оценке уже подана", {"appeal_id": str(existing.appeal_id)})
    closes_at = current.created_at + timedelta(days=window_days)
    if now > closes_at:
        raise conflict("APPEAL_WINDOW_CLOSED", "Срок подачи апелляции истёк", {"closed_at": iso_z(closes_at)})
    appeal = Appeal(appeal_id=uuid.uuid4(), evaluation_id=current.evaluation_id, session_id=current.session_id,
                    user_id=user_id, reason=reason, status="new", idempotency_key=key, created_at=now)
    session.add(appeal)
    await session.flush()
    return appeal_view(appeal), True


async def learner_appeals(session: AsyncSession, *, user_id: uuid.UUID, cursor: str | None,
                          limit: int) -> dict[str, Any]:
    await ensure_not_deleted(session, user_id)
    stmt = select(Appeal).where(Appeal.user_id == user_id)
    after = cursor_time_id(cursor)
    if after is not None:
        at, last_id = after
        stmt = stmt.where(or_(Appeal.created_at < at, and_(Appeal.created_at == at, Appeal.appeal_id < last_id)))
    rows = (await session.execute(
        stmt.order_by(Appeal.created_at.desc(), Appeal.appeal_id.desc()).limit(limit + 1)
    )).scalars().all()
    page = rows[:limit]
    next_cursor = encode_cursor(page[-1].created_at.isoformat(), str(page[-1].appeal_id)) \
        if len(rows) > limit else None
    return {"items": [appeal_view(a) for a in page], "next_cursor": next_cursor}


# ---------------------------------------------------------------- сотрудник


async def _locked_appeal(session: AsyncSession, appeal_id: uuid.UUID) -> Appeal:
    user_id = (await session.execute(select(Appeal.user_id).where(Appeal.appeal_id == appeal_id))).scalar_one_or_none()
    if user_id is None:
        raise appeal_not_found()
    await lock_user(session, user_id)
    appeal = (await session.execute(
        select(Appeal).where(Appeal.appeal_id == appeal_id).with_for_update()
    )).scalar_one_or_none()
    if appeal is None:  # удалена сагой, пока ждали блокировку
        raise appeal_not_found()
    await lock_session(session, appeal.session_id)
    return appeal


def _decided(appeal: Appeal) -> ApiError:
    return conflict("APPEAL_DECIDED", "По апелляции уже принято решение", {"status": appeal.status})


async def take(session: AsyncSession, *, actor: Actor, appeal_id: uuid.UUID, now: datetime) -> dict[str, Any]:
    appeal = await _locked_appeal(session, appeal_id)
    if appeal.status in DECIDED_STATUSES:
        raise _decided(appeal)
    if appeal.status == "in_review":
        if appeal.taken_by == actor.id[:64]:
            return admin_appeal(appeal)
        raise conflict("APPEAL_ALREADY_TAKEN", "Апелляцию уже разбирает другой сотрудник",
                       {"taken_by": appeal.taken_by})
    appeal.status, appeal.taken_by, appeal.taken_at = "in_review", actor.id[:64], now
    await session.flush()
    await emit_audit(session, audit_payload(actor, "qa.appeal_taken", "appeal", str(appeal.appeal_id),
                                            before={"status": "new"},
                                            after={"status": "in_review",
                                                   "evaluation_id": str(appeal.evaluation_id)}))
    return admin_appeal(appeal)


async def decide(session: AsyncSession, *, actor: Actor, appeal_id: uuid.UUID, decision: str, note: str,
                 new_evaluation_id: uuid.UUID | None, now: datetime) -> dict[str, Any]:
    appeal = await _locked_appeal(session, appeal_id)
    if appeal.status in DECIDED_STATUSES:
        if appeal.status == decision and appeal.new_evaluation_id == new_evaluation_id \
                and appeal.decision_note == note:
            return admin_appeal(appeal)  # повтор той же команды
        raise _decided(appeal)
    by_appeal = (await session.execute(
        select(Evaluation).where(Evaluation.appeal_id == appeal.appeal_id)
    )).scalars().all()
    if decision == "corrected":
        if new_evaluation_id is None:
            raise unprocessable("NEW_EVALUATION_REQUIRED", "Для «оценка исправлена» нужна переоценка по апелляции")
        target = next((e for e in by_appeal if e.evaluation_id == new_evaluation_id), None)
        if target is None or target.session_id != appeal.session_id:
            raise unprocessable("NEW_EVALUATION_INVALID",
                                "Нужна переоценка оспоренной оценки, сделанная по этой апелляции")
    else:
        if new_evaluation_id is not None:
            raise unprocessable("NEW_EVALUATION_NOT_ALLOWED", "Для «оценка верна» переоценка не указывается")
        if by_appeal:
            raise conflict("APPEAL_HAS_REEVALUATION", "По апелляции уже сделана переоценка — решение «исправлена»",
                           {"new_evaluation_id": str(by_appeal[0].evaluation_id)})
    before = appeal.status
    if appeal.status == "new":
        appeal.taken_by, appeal.taken_at = actor.id[:64], now
    appeal.status, appeal.decided_by, appeal.decided_at = decision, actor.id[:64], now
    appeal.decision_note, appeal.new_evaluation_id = note, new_evaluation_id
    await session.flush()
    await emit_event(session, APPEAL_DECIDED, {
        "appeal_id": str(appeal.appeal_id), "evaluation_id": str(appeal.evaluation_id), "user_id": str(appeal.user_id),
        "decision": decision, "decided_at": iso_z(now)})
    await emit_audit(session, audit_payload(
        actor, "qa.appeal_decided", "appeal", str(appeal.appeal_id), before={"status": before},
        after={"status": decision, "evaluation_id": str(appeal.evaluation_id),
               "new_evaluation_id": str(new_evaluation_id) if new_evaluation_id else None},
        reason=note))
    return admin_appeal(appeal)


async def get_admin_appeal(session: AsyncSession, appeal_id: uuid.UUID) -> dict[str, Any]:
    appeal = await session.get(Appeal, appeal_id)
    if appeal is None:
        raise appeal_not_found()
    return admin_appeal(appeal)


async def list_admin_appeals(session: AsyncSession, *, status: str | None, cursor: str | None,
                             limit: int) -> dict[str, Any]:
    """Очередь апелляций: старые первыми (разбор по порядку подачи)."""
    stmt = select(Appeal)
    if status is not None:
        stmt = stmt.where(Appeal.status == status)
    after = cursor_time_id(cursor)
    if after is not None:
        at, last_id = after
        stmt = stmt.where(or_(Appeal.created_at > at, and_(Appeal.created_at == at, Appeal.appeal_id > last_id)))
    rows = (await session.execute(
        stmt.order_by(Appeal.created_at, Appeal.appeal_id).limit(limit + 1)
    )).scalars().all()
    page = rows[:limit]
    next_cursor = encode_cursor(page[-1].created_at.isoformat(), str(page[-1].appeal_id)) \
        if len(rows) > limit else None
    return {"items": [admin_appeal(a) for a in page], "next_cursor": next_cursor}
