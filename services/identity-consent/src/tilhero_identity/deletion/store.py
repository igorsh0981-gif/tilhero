"""Операции саги удаления над БД (одна сессия = одна транзакция вызывающего): первичная рассылка и повтор,
«зависло», ACK домена, завершение.

События — только через outbox (`emit`) в транзакции изменения. Повтор `user.deletion.requested.v1` — новый `event_id`,
тот же `request_id`, `attempt = n`. Payload без PII: `user_id` — псевдоним.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import and_, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope, emit
from tilhero_identity.deletion import saga
from tilhero_identity.deletion.models import DeletionAttempt, DeletionDomainAck, DeletionRequest
from tilhero_identity.domain.evidence import iso_utc_ms

log = logging.getLogger("tilhero.identity.deletion")

PRODUCER = "identity-consent"
EV_DELETION_REQUESTED = "user.deletion.requested.v1"
EV_DELETION_STUCK = "user.deletion.stuck.v1"
ACK_MODES = ("deleted", "anonymized")


def _event_uuid(event_id: str | None) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(event_id))
    except (TypeError, ValueError):
        return None


def requested_payload(req: DeletionRequest, attempt: int) -> dict[str, object]:
    return {
        "user_id": str(req.user_id),
        "request_id": str(req.request_id),
        "requested_at": iso_utc_ms(req.requested_at),
        "attempt": attempt,
    }


def record_initial(
    session: AsyncSession, req: DeletionRequest, *, sent_at: datetime, event_id: str, schedule: Sequence[int]
) -> None:
    """Первичная рассылка (запрос пользователя): attempt 1, расписание первого повтора."""
    req.attempts = 1
    req.last_sent_at = sent_at
    req.next_retry_at = saga.next_retry_at(req.requested_at, sent_at, schedule)
    session.add(DeletionAttempt(request_id=req.request_id, attempt=1, sent_at=sent_at, sent_by=saga.BY_USER,
                                event_id=_event_uuid(event_id)))


async def send_retry(
    session: AsyncSession, req: DeletionRequest, *, now: datetime, by: str, schedule: Sequence[int]
) -> Envelope:
    """Повтор запроса (строка запроса заблокирована вызывающим). Рассылается всем доменам — учитываются ACK тех, кто
    ещё не ответил; повторный ACK уже ответивших identity отбрасывает."""
    if not saga.can_retry(req.status):
        raise ValueError(f"retry of {req.status} deletion request")
    attempt = req.attempts + 1
    envelope = await emit(session, EV_DELETION_REQUESTED, requested_payload(req, attempt), producer=PRODUCER)
    req.attempts = attempt
    req.last_sent_at = now
    req.next_retry_at = saga.next_retry_at(req.requested_at, now, schedule)
    req.last_retry_by = by[:64]
    session.add(DeletionAttempt(request_id=req.request_id, attempt=attempt, sent_at=now, sent_by=by[:64],
                                event_id=_event_uuid(envelope.event_id)))
    await session.flush()
    log.info("deletion request resent", extra={"request_id": str(req.request_id), "attempt": attempt,
                                               "pending": len(saga.pending_domains(req.expected_domains,
                                                                                  req.acked_domains))})
    return envelope


async def mark_stuck(session: AsyncSession, req: DeletionRequest, *, now: datetime) -> Envelope:
    """REQUESTED → STUCK + user.deletion.stuck.v1 (один раз; повторы продолжаются)."""
    pending = saga.pending_domains(req.expected_domains, req.acked_domains)
    req.status = saga.STUCK
    req.stuck_at = now
    envelope = await emit(session, EV_DELETION_STUCK, {
        "request_id": str(req.request_id),
        "user_id": str(req.user_id),
        "requested_at": iso_utc_ms(req.requested_at),
        "stuck_at": iso_utc_ms(now),
        "pending_domains": pending,
        "attempts": req.attempts,
    }, producer=PRODUCER)
    log.warning("deletion request stuck", extra={"request_id": str(req.request_id), "attempts": req.attempts,
                                                 "pending_domains": pending})
    return envelope


async def record_ack(
    session: AsyncSession, req: DeletionRequest, *, domain: str, mode: object, event_id: str, at: datetime
) -> bool:
    """ACK домена со временем. → True, если это первый ACK домена по запросу (повторный ACK ничего не меняет)."""
    inserted = (await session.execute(
        pg_insert(DeletionDomainAck)
        .values(request_id=req.request_id, domain=domain, acked_at=at,
                mode=mode if mode in ACK_MODES else None, event_id=_event_uuid(event_id))
        .on_conflict_do_nothing(index_elements=[DeletionDomainAck.request_id, DeletionDomainAck.domain])
        .returning(DeletionDomainAck.domain)
    )).first()
    if domain not in req.acked_domains:
        req.acked_domains = [*req.acked_domains, domain]
    return inserted is not None


def mark_completed(req: DeletionRequest, *, now: datetime) -> None:
    req.status = saga.COMPLETED
    req.completed_at = now
    req.next_retry_at = None


async def due_requests(
    session: AsyncSession, *, now: datetime, stuck_before: datetime, limit: int
) -> list[DeletionRequest]:
    """Открытые запросы, которым пора повторить или стать STUCK. SKIP LOCKED: строку, которую сейчас держит ACK
    домена, таймер обработает следующим тиком."""
    stmt = (
        select(DeletionRequest)
        .where(
            DeletionRequest.status.in_(saga.OPEN_STATUSES),
            or_(
                DeletionRequest.next_retry_at <= now,
                DeletionRequest.next_retry_at.is_(None),
                and_(DeletionRequest.status == saga.REQUESTED, DeletionRequest.requested_at <= stuck_before),
            ),
        )
        .order_by(DeletionRequest.next_retry_at.asc().nulls_first(), DeletionRequest.request_id)
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    return list((await session.execute(stmt)).scalars().all())
