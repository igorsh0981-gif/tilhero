"""Операции с журналом уведомлений: приём (с дедупликацией), захват к отправке, конечные статусы + события."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import emit
from tilhero_notifications.models import DeletedUser, DigestItem, Notification

DELIVERED = "notification.delivered.v1"
DELIVERY_FAILED = "telegram.delivery.failed.v1"
DOMAIN_DELETED = "user.domain.deleted.v1"
PENDING = ("queued", "scheduled")
LOCK_CLASS = 7_340_104  # advisory-lock'и notifications: (класс, hashtext(user_id))


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


async def lock_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    """Сериализует приём уведомлений пользователя с обработкой его удаления (гонка «удаление ↔ новое
    уведомление», ревью P3): запись, ждущая блокировку, после неё увидит отметку deleted_users."""
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:c, hashtext(:u))"), {"c": LOCK_CLASS, "u": str(user_id)}
    )


async def is_deleted(session: AsyncSession, user_id: uuid.UUID) -> bool:
    return await session.get(DeletedUser, user_id) is not None


async def mark_deleted(session: AsyncSession, user_id: uuid.UUID, request_id: uuid.UUID, now: datetime) -> None:
    await session.execute(
        insert(DeletedUser)
        .values(user_id=user_id, request_id=request_id, deleted_at=now)
        .on_conflict_do_nothing(index_elements=[DeletedUser.user_id])
    )


@dataclass(frozen=True)
class Claimed:
    notification_id: uuid.UUID
    user_id: uuid.UUID
    kind: str
    template: str
    params: dict[str, Any] | None
    startapp: str | None
    attempts: int
    status: str


async def insert_notification(
    session: AsyncSession,
    *,
    notification_id: uuid.UUID,
    user_id: uuid.UUID,
    kind: str,
    template: str,
    params: dict[str, Any] | None,
    startapp: str | None,
    dedup_key: str,
    source_event_id: str | None,
    now: datetime,
    status: str = "queued",
    failure_reason: str | None = None,
) -> bool:
    """False — дубль (тот же dedup_key или notification_id): уведомление уже есть."""
    pending = status in PENDING
    stmt = (
        insert(Notification)
        .values(
            notification_id=notification_id,
            user_id=user_id,
            kind=kind,
            template=template,
            params=params if pending else None,
            startapp=startapp,
            dedup_key=dedup_key,
            status=status,
            attempts=0,
            next_attempt_at=now if pending else None,
            failure_reason=failure_reason,
            source_event_id=uuid.UUID(source_event_id) if source_event_id else None,
            created_at=now,
            updated_at=now,
        )
        .on_conflict_do_nothing()
        .returning(Notification.notification_id)
    )
    return (await session.execute(stmt)).first() is not None


async def claim_due(session: AsyncSession, *, now: datetime, batch: int, lease_seconds: int) -> list[Claimed]:
    """Захват пачки к отправке: next_attempt_at сдвигается на время «аренды» (SKIP LOCKED — безопасно
    для реплик). Если процесс упадёт посреди отправки, строка снова станет доступна после аренды;
    повтор не задвоит сообщение — bot-gateway идемпотентен по notification_id."""
    due = (
        select(Notification.notification_id)
        .where(Notification.status.in_(PENDING), Notification.next_attempt_at <= now)
        .order_by(Notification.next_attempt_at)
        .limit(batch)
        .with_for_update(skip_locked=True)
        .scalar_subquery()
    )
    rows = (
        await session.execute(
            update(Notification)
            .where(Notification.notification_id.in_(due))
            .values(next_attempt_at=now + timedelta(seconds=lease_seconds), updated_at=now)
            .returning(
                Notification.notification_id,
                Notification.user_id,
                Notification.kind,
                Notification.template,
                Notification.params,
                Notification.startapp,
                Notification.attempts,
                Notification.status,
            )
            .execution_options(synchronize_session=False)
        )
    ).all()
    return [Claimed(*row) for row in rows]


async def claim_one(
    session: AsyncSession, notification_id: uuid.UUID, *, now: datetime, lease_seconds: int
) -> Claimed | None:
    """Захват конкретного уведомления к немедленной отправке (транзакционные). None — уже взято
    планировщиком (аренда) или в конечном статусе."""
    row = (
        await session.execute(
            update(Notification)
            .where(
                Notification.notification_id == notification_id,
                Notification.status.in_(PENDING),
                Notification.next_attempt_at <= now,
            )
            .values(next_attempt_at=now + timedelta(seconds=lease_seconds), updated_at=now)
            .returning(
                Notification.notification_id,
                Notification.user_id,
                Notification.kind,
                Notification.template,
                Notification.params,
                Notification.startapp,
                Notification.attempts,
                Notification.status,
            )
            .execution_options(synchronize_session=False)
        )
    ).first()
    return Claimed(*row) if row is not None else None


async def find(
    session: AsyncSession, *, notification_id: uuid.UUID, dedup_key: str
) -> tuple[uuid.UUID, uuid.UUID, str, str | None] | None:
    """(notification_id, user_id, status, failure_reason) по id или ключу дедупликации."""
    row = (
        await session.execute(
            select(
                Notification.notification_id, Notification.user_id, Notification.status, Notification.failure_reason
            ).where((Notification.notification_id == notification_id) | (Notification.dedup_key == dedup_key))
        )
    ).first()
    return (row[0], row[1], row[2], row[3]) if row is not None else None


async def _finish(session: AsyncSession, notification_id: uuid.UUID, values: dict[str, Any]) -> bool:
    result = await session.execute(
        update(Notification)
        .where(Notification.notification_id == notification_id, Notification.status.in_(PENDING))
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    return bool(result.rowcount)  # type: ignore[attr-defined]


async def mark_sent(
    session: AsyncSession, c: Claimed, *, message_id: int, now: datetime, producer: str
) -> None:
    if await _finish(
        session,
        c.notification_id,
        {
            "status": "sent",
            "sent_at": now,
            "telegram_message_id": message_id,
            "params": None,
            "next_attempt_at": None,
            "attempts": c.attempts + 1,
            "failure_reason": None,
            "updated_at": now,
        },
    ):
        await emit(
            session,
            DELIVERED,
            {
                "notification_id": str(c.notification_id),
                "user_id": str(c.user_id),
                "channel": "telegram",
                "delivered_at": iso(now),
            },
            producer=producer,
        )


async def mark_failed(
    session: AsyncSession,
    c: Claimed,
    *,
    reason: str,
    event_reason: str,
    now: datetime,
    producer: str,
    attempted: bool = True,
) -> None:
    if await _finish(
        session,
        c.notification_id,
        {
            "status": "failed",
            "params": None,
            "next_attempt_at": None,
            "failure_reason": reason,
            "attempts": c.attempts + (1 if attempted else 0),
            "updated_at": now,
        },
    ):
        await emit(
            session,
            DELIVERY_FAILED,
            {"notification_id": str(c.notification_id), "user_id": str(c.user_id), "reason": event_reason},
            producer=producer,
        )


async def mark_skipped(session: AsyncSession, c: Claimed, *, reason: str, now: datetime) -> None:
    await _finish(
        session,
        c.notification_id,
        {
            "status": "skipped",
            "params": None,
            "next_attempt_at": None,
            "failure_reason": reason,
            "updated_at": now,
        },
    )


async def mark_deferred(session: AsyncSession, c: Claimed, *, at: datetime, now: datetime) -> None:
    await _finish(
        session,
        c.notification_id,
        {
            "status": "scheduled",
            "scheduled_for": at,
            "next_attempt_at": at,
            "updated_at": now,
        },
    )


async def mark_retry(session: AsyncSession, c: Claimed, *, at: datetime, reason: str, now: datetime) -> None:
    await _finish(
        session,
        c.notification_id,
        {
            "status": "queued",
            "next_attempt_at": at,
            "attempts": c.attempts + 1,
            "failure_reason": reason,
            "updated_at": now,
        },
    )


async def delete_user(session: AsyncSession, user_id: uuid.UUID) -> int:
    await session.execute(delete(DigestItem).where(DigestItem.user_id == user_id))
    result = await session.execute(delete(Notification).where(Notification.user_id == user_id))
    return int(result.rowcount or 0)  # type: ignore[attr-defined]


# ---------------------------------------------------------------- digest_queue (спринт 6, §5)


@dataclass(frozen=True)
class PendingItem:
    item_id: uuid.UUID
    section: str
    template: str
    params: dict[str, Any] | None
    created_at: datetime


async def insert_digest_item(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    user_id: uuid.UUID,
    section: str,
    template: str,
    params: dict[str, Any] | None,
    dedup_key: str,
    source_event_id: str | None,
    now: datetime,
) -> bool:
    """False — дубль: тот же notification_id/dedup_key уже в очереди дайджеста или в журнале."""
    if await find(session, notification_id=item_id, dedup_key=dedup_key) is not None:
        return False
    stmt = (
        insert(DigestItem)
        .values(
            item_id=item_id,
            user_id=user_id,
            section=section,
            template=template,
            params=params,
            dedup_key=dedup_key,
            source_event_id=uuid.UUID(source_event_id) if source_event_id else None,
            created_at=now,
        )
        .on_conflict_do_nothing()
        .returning(DigestItem.item_id)
    )
    return (await session.execute(stmt)).first() is not None


async def digest_due_users(session: AsyncSession, *, now: datetime, batch: int) -> list[uuid.UUID]:
    """Пользователи с ждущими пунктами, которых пора проверить (not_before прошёл или ещё не задан)."""
    rows = (
        await session.execute(
            select(DigestItem.user_id)
            .where(
                DigestItem.digest_id.is_(None),
                (DigestItem.not_before.is_(None)) | (DigestItem.not_before <= now),
            )
            .group_by(DigestItem.user_id)
            .order_by(func.min(DigestItem.created_at))
            .limit(batch)
        )
    ).all()
    return [r[0] for r in rows]


async def pending_digest_items(session: AsyncSession, user_id: uuid.UUID) -> list[PendingItem]:
    rows = (
        await session.execute(
            select(
                DigestItem.item_id,
                DigestItem.section,
                DigestItem.template,
                DigestItem.params,
                DigestItem.created_at,
            )
            .where(DigestItem.user_id == user_id, DigestItem.digest_id.is_(None))
            .order_by(DigestItem.created_at, DigestItem.item_id)
            .with_for_update()
        )
    ).all()
    return [PendingItem(*r) for r in rows]


async def postpone_digest(session: AsyncSession, user_id: uuid.UUID, at: datetime) -> None:
    await session.execute(
        update(DigestItem)
        .where(DigestItem.user_id == user_id, DigestItem.digest_id.is_(None))
        .values(not_before=at)
        .execution_options(synchronize_session=False)
    )


async def consume_digest_items(
    session: AsyncSession, item_ids: list[uuid.UUID], *, digest_id: uuid.UUID, now: datetime
) -> None:
    await session.execute(
        update(DigestItem)
        .where(DigestItem.item_id.in_(item_ids), DigestItem.digest_id.is_(None))
        .values(digest_id=digest_id, params=None, consumed_at=now, not_before=None)
        .execution_options(synchronize_session=False)
    )


async def drop_pending_digest(session: AsyncSession, user_id: uuid.UUID) -> int:
    result = await session.execute(
        delete(DigestItem).where(DigestItem.user_id == user_id, DigestItem.digest_id.is_(None))
    )
    return int(result.rowcount or 0)  # type: ignore[attr-defined]


async def notification_exists(session: AsyncSession, notification_id: uuid.UUID) -> bool:
    return await session.get(Notification, notification_id) is not None


async def purge_consumed_digest(session: AsyncSession, *, before: datetime, limit: int = 5000) -> int:
    ids = (
        select(DigestItem.item_id)
        .where(DigestItem.digest_id.is_not(None), DigestItem.consumed_at < before)
        .limit(limit)
        .scalar_subquery()
    )
    result = await session.execute(delete(DigestItem).where(DigestItem.item_id.in_(ids)))
    return int(result.rowcount or 0)  # type: ignore[attr-defined]
