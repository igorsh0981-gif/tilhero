"""Операции саги удаления над БД (одна сессия = одна транзакция вызывающего): рассылка запроса и повтор, «зависло»,
ACK домена, завершение; чтение для админки и ops-monitor.

События — только через outbox (`emit`) в транзакции изменения. Повтор `user.deletion.requested.v1` — новый `event_id`,
тот же `request_id`, `attempt = n`. Payload без PII: `user_id` — псевдоним.
"""

from __future__ import annotations

import base64
import json
import logging
import uuid
from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import and_, or_, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import unprocessable
from tilhero_common.messaging import Envelope, emit
from tilhero_identity.deletion import saga
from tilhero_identity.deletion.models import DeletionAttempt, DeletionDomainAck, DeletionRequest
from tilhero_identity.deletion.schemas import (
    DeletionDetail,
    DeletionDomain,
    DeletionHistoryItem,
    DeletionPage,
    DeletionRow,
    DeletionStats,
    StuckItem,
)
from tilhero_identity.domain.evidence import iso_utc_ms

log = logging.getLogger("tilhero.identity.deletion")

PRODUCER = "identity-consent"
EV_DELETION_REQUESTED = "user.deletion.requested.v1"
EV_DELETION_STUCK = "user.deletion.stuck.v1"
ACK_MODES = ("deleted", "anonymized")
STUCK_ITEMS_LIMIT = 50


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


# ---------------------------------------------------------------- изменения

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
                                               "by": "staff" if by != saga.BY_SYSTEM else saga.BY_SYSTEM,
                                               "pending": len(saga.pending_domains(req.expected_domains,
                                                                                  req.acked_domains))})
    return envelope


async def mark_stuck(session: AsyncSession, req: DeletionRequest, *, now: datetime) -> Envelope:
    """REQUESTED → STUCK + user.deletion.stuck.v1 (потребитель — user-admin; ops-monitor видит через stats)."""
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
    домена или ручной повтор, таймер обработает следующим тиком."""
    stmt = (
        select(DeletionRequest)
        .where(
            DeletionRequest.status.in_(saga.OPEN_STATUSES),
            or_(
                DeletionRequest.next_retry_at <= now,
                DeletionRequest.next_retry_at.is_(None),  # создан кодом спринта 8 (раскатка/откат): расписания нет
                and_(DeletionRequest.status == saga.REQUESTED, DeletionRequest.requested_at <= stuck_before),
            ),
        )
        .order_by(DeletionRequest.next_retry_at.asc().nulls_first(), DeletionRequest.request_id)
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    return list((await session.execute(stmt)).scalars().all())


# ---------------------------------------------------------------- чтение

def row_view(req: DeletionRequest) -> DeletionRow:
    pending = saga.pending_domains(req.expected_domains, req.acked_domains)
    expected = list(dict.fromkeys(req.expected_domains))
    return DeletionRow(
        request_id=req.request_id,
        user_id=req.user_id,
        status=req.status,  # type: ignore[arg-type]
        requested_at=req.requested_at,
        completed_at=req.completed_at,
        stuck_at=req.stuck_at,
        attempts=req.attempts,
        # завершённый кодом спринта 8 запрос сохраняет next_retry_at в строке — наружу его нет
        next_retry_at=None if req.status == saga.COMPLETED else req.next_retry_at,
        acked=len(expected) - len(pending),
        expected=len(expected),
        pending_domains=pending,
    )


async def detail_view(session: AsyncSession, req: DeletionRequest) -> DeletionDetail:
    acks = {
        a.domain: a
        for a in (await session.execute(
            select(DeletionDomainAck).where(DeletionDomainAck.request_id == req.request_id)
        )).scalars()
    }
    acked = set(req.acked_domains)
    domains = []
    for d in dict.fromkeys(req.expected_domains):
        ack = acks.get(d)
        domains.append(DeletionDomain(
            domain=d,
            acked_at=ack.acked_at if ack is not None else None,
            mode=ack.mode if ack is not None else None,  # type: ignore[arg-type]
            acked=d in acked or ack is not None,
        ))
    history = [
        DeletionHistoryItem(attempt=a.attempt, sent_at=a.sent_at, by=a.sent_by)
        for a in (await session.execute(
            select(DeletionAttempt).where(DeletionAttempt.request_id == req.request_id)
            .order_by(DeletionAttempt.attempt)
        )).scalars()
    ]
    return DeletionDetail(**row_view(req).model_dump(), domains=domains, history=history)


def _encode_cursor(requested_at: datetime, request_id: uuid.UUID) -> str:
    raw = json.dumps([requested_at.isoformat(), str(request_id)]).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        at, rid = json.loads(raw)
        parsed = datetime.fromisoformat(at)
        if parsed.tzinfo is None:
            raise ValueError("naive cursor")
        return parsed, uuid.UUID(rid)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise unprocessable("VALIDATION_ERROR", "Некорректный курсор", {"field": "cursor"}) from exc


async def list_requests(
    session: AsyncSession, *, status: str | None, cursor: str | None, limit: int
) -> DeletionPage:
    """Новые сверху; курсор — (requested_at, request_id) последней строки."""
    stmt = select(DeletionRequest)
    if status is not None:
        stmt = stmt.where(DeletionRequest.status.in_(saga.LIST_FILTERS[status]))
    if cursor:
        at, rid = _decode_cursor(cursor)
        stmt = stmt.where(or_(DeletionRequest.requested_at < at,
                              and_(DeletionRequest.requested_at == at, DeletionRequest.request_id < rid)))
    rows = list((await session.execute(
        stmt.order_by(DeletionRequest.requested_at.desc(), DeletionRequest.request_id.desc()).limit(limit + 1)
    )).scalars().all())
    more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = _encode_cursor(rows[-1].requested_at, rows[-1].request_id) if more and rows else None
    return DeletionPage(items=[row_view(r) for r in rows], next_cursor=next_cursor)


_PENDING_SQL = text(
    "SELECT d.domain, count(*) AS n FROM deletion_requests r "
    "CROSS JOIN LATERAL unnest(r.expected_domains) AS d(domain) "
    "WHERE r.status IN ('REQUESTED','STUCK') AND NOT (d.domain = ANY(r.acked_domains)) "
    "GROUP BY d.domain ORDER BY d.domain"
)
_COUNTS_SQL = text(
    "SELECT count(*) FILTER (WHERE status IN ('REQUESTED','STUCK')) AS open, "
    "count(*) FILTER (WHERE status = 'STUCK') AS stuck, "
    "min(requested_at) FILTER (WHERE status IN ('REQUESTED','STUCK')) AS oldest "
    "FROM deletion_requests WHERE status IN ('REQUESTED','STUCK')"
)


async def stats(session: AsyncSession) -> DeletionStats:
    counts = (await session.execute(_COUNTS_SQL)).one()
    pending = {str(r.domain): int(r.n) for r in (await session.execute(_PENDING_SQL)).all()}
    stuck_rows = (await session.execute(
        select(DeletionRequest).where(DeletionRequest.status == saga.STUCK)
        .order_by(DeletionRequest.requested_at, DeletionRequest.request_id).limit(STUCK_ITEMS_LIMIT)
    )).scalars().all()
    return DeletionStats(
        open=int(counts.open),
        stuck=int(counts.stuck),
        oldest_open_at=counts.oldest,
        pending_by_domain=pending,
        stuck_items=[
            StuckItem(request_id=r.request_id, requested_at=r.requested_at, stuck_at=r.stuck_at,  # type: ignore[arg-type]
                      attempts=r.attempts, pending_domains=saga.pending_domains(r.expected_domains, r.acked_domains))
            for r in stuck_rows
        ],
    )
